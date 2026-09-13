import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PluginRegistry } from "./registry.ts";
import type { ForgePlugin, PluginSessionContext } from "./types.ts";
import type { Session } from "../types.ts";

function context(events: Array<{ type: string; payload: Record<string, unknown> }>): PluginSessionContext {
  const session: Session = {
    id: "s1", goal: "test", workspace: "/tmp", projectId: null,
    model: { provider: "p", modelId: "m" }, messages: [], status: "running",
    failureReason: null, usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
    approvalMode: "default", thinkingLevel: "off", createdAt: 1, updatedAt: 1,
  };
  return {
    session,
    signal: new AbortController().signal,
    emitEvent: async (type, payload) => { events.push({ type, payload }); },
    enqueueSteering: () => {},
    requestCompaction: () => {},
  };
}

describe("PluginRegistry", () => {
  test("rejects duplicate plugin ids", () => {
    const registry = new PluginRegistry();
    const plugin: ForgePlugin = {
      manifest: { id: "test.one", name: "one", version: "1", capabilities: [] },
      activate: () => ({}),
    };
    registry.register(plugin);
    assert.throws(() => registry.register(plugin), /already registered/);
  });

  test("isolates a crashing subscriber and keeps other plugins alive", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let healthyCalls = 0;
    const registry = new PluginRegistry();
    registry.register({
      manifest: { id: "test.bad", name: "bad", version: "1", capabilities: ["event-subscriber"] },
      activate: () => ({ onAgentEvent: () => { throw new Error("boom"); } }),
    });
    registry.register({
      manifest: { id: "test.good", name: "good", version: "1", capabilities: ["event-subscriber"] },
      activate: () => ({ onAgentEvent: () => { healthyCalls += 1; } }),
    });
    const host = await registry.activate(context(events));
    await host.onAgentEvent({ type: "agent_start" });
    await host.onAgentEvent({ type: "agent_start" });
    assert.equal(healthyCalls, 2);
    assert.equal(events.filter((event) => event.type === "PLUGIN_FAILED").length, 1);
    assert.equal(host.capabilities().plugins.find((plugin) => plugin.id === "test.bad")?.status, "failed");
  });

  test("detects command conflicts and keeps the first owner", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const registry = new PluginRegistry();
    for (const id of ["test.first", "test.second"]) {
      registry.register({
        manifest: { id, name: id, version: "1", capabilities: ["slash-command"] },
        activate: () => ({ slashCommands: [{ name: "same", description: "", execute: () => ({ message: id }) }] }),
      });
    }
    const host = await registry.activate(context(events));
    assert.equal((await host.execute("/same")).message, "test.first");
    assert.equal(events.some((event) => event.type === "PLUGIN_FAILED" && event.payload.pluginId === "test.second"), true);
  });

  test("plugin tools cannot shadow reserved core tool names", async () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: { id: "test.tools", name: "tools", version: "1", capabilities: ["tool"] },
      activate: () => ({ tools: [
        { name: "bash", label: "fake", description: "fake", parameters: {} as never, execute: async () => ({ content: [], details: {} }) },
        { name: "extra", label: "extra", description: "extra", parameters: {} as never, execute: async () => ({ content: [], details: {} }) },
      ] }),
    });
    const host = await registry.activate(context([]));
    assert.deepEqual(host.tools(["bash"]).map((tool) => tool.name), ["extra"]);
  });

  test("session enable/disable takes effect on already-projected tools", async () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: { id: "test.toggle", name: "toggle", version: "1", capabilities: ["tool"] },
      activate: () => ({ tools: [
        { name: "extra", label: "extra", description: "extra", parameters: {} as never, execute: async () => ({ content: [], details: { ok: true } }) },
      ] }),
    });
    const host = await registry.activate(context([]));
    const tool = host.tools()[0]!;
    await host.setEnabled("test.toggle", false);
    await assert.rejects(() => tool.execute("1", {}), /disabled/);
    await host.setEnabled("test.toggle", true);
    assert.deepEqual((await tool.execute("2", {})).details, { ok: true });
  });

  test("session enable/disable takes effect on already-composed hooks", async () => {
    const registry = new PluginRegistry();
    let calls = 0;
    registry.register({
      manifest: { id: "test.hooks", name: "hooks", version: "1", capabilities: ["guardrail"] },
      activate: () => ({ hooks: { shouldStopAfterTurn: async () => { calls += 1; return false; } } }),
    });
    const host = await registry.activate(context([]));
    const hooks = host.hooks({});
    await hooks.shouldStopAfterTurn!({} as never);
    await host.setEnabled("test.hooks", false);
    await hooks.shouldStopAfterTurn!({} as never);
    await host.setEnabled("test.hooks", true);
    await hooks.shouldStopAfterTurn!({} as never);
    assert.equal(calls, 2);
  });

  test("required capabilities cannot be disabled", async () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: { id: "test.required", name: "required", version: "1", required: true, capabilities: [] },
      activate: () => ({}),
    });
    const host = await registry.activate(context([]));
    await assert.rejects(() => host.setEnabled("test.required", false), /required/);
    assert.equal(host.capabilities().plugins[0]?.status, "active");
  });

  test("restores an optional user-disabled capability without disabling required ones", async () => {
    const registry = new PluginRegistry();
    for (const [id, required] of [["optional", false], ["required", true]] as const) {
      registry.register({
        manifest: { id: `test.${id}`, name: id, version: "1", required, capabilities: ["slash-command"] },
        activate: () => ({ slashCommands: [{ name: id, description: "", execute: () => ({ message: id }) }] }),
      });
    }
    const host = await registry.activate(context([]), {
      disabledPluginIds: new Set(["test.optional", "test.required"]),
    });
    assert.deepEqual(host.capabilities().plugins.map((plugin) => plugin.status), ["disabled", "active"]);
    await assert.rejects(() => host.execute("/optional"), /unknown slash command/);
    await host.setEnabled("test.optional", true);
    assert.equal((await host.execute("/optional")).message, "optional");
  });

  test("a failed plugin is disposed once and cannot be re-enabled", async () => {
    const registry = new PluginRegistry();
    let disposals = 0;
    registry.register({
      manifest: { id: "test.failed", name: "failed", version: "1", capabilities: ["event-subscriber"] },
      activate: () => ({
        onAgentEvent: () => { throw new Error("boom"); },
        dispose: () => { disposals += 1; },
      }),
    });
    const host = await registry.activate(context([]));
    await host.onAgentEvent({ type: "agent_start" });
    await assert.rejects(() => host.setEnabled("test.failed", true), /cannot be re-enabled/);
    await host.dispose();
    await host.dispose();
    assert.equal(disposals, 1);
  });

  test("rolls back an activated instance rejected by contribution validation", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const registry = new PluginRegistry();
    let rollbackDisposals = 0;
    registry.register({
      manifest: { id: "test.first-command", name: "first", version: "1", capabilities: ["slash-command"] },
      activate: () => ({ slashCommands: [{ name: "same", description: "", execute: () => ({ message: "first" }) }] }),
    });
    registry.register({
      manifest: { id: "test.conflict", name: "conflict", version: "1", capabilities: ["slash-command"] },
      activate: () => ({
        slashCommands: [{ name: "same", description: "", execute: () => ({ message: "second" }) }],
        dispose: () => { rollbackDisposals += 1; },
      }),
    });
    const host = await registry.activate(context(events));
    assert.equal(rollbackDisposals, 1);
    assert.equal((await host.execute("/same")).message, "first");
  });

  test("reclaims an instance that resolves after activation timed out", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const registry = new PluginRegistry(5);
    let disposals = 0;
    registry.register({
      manifest: { id: "test.late", name: "late", version: "1", capabilities: [] },
      activate: () => new Promise((resolve) => {
        setTimeout(() => resolve({ dispose: () => { disposals += 1; } }), 15);
      }),
    });
    const host = await registry.activate(context(events));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(host.capabilities().plugins[0]?.status, "failed");
    assert.equal(disposals, 1);
  });

  test("disposes live plugin instances once in reverse activation order", async () => {
    const registry = new PluginRegistry();
    const order: string[] = [];
    for (const id of ["one", "two", "three"]) {
      registry.register({
        manifest: { id: `test.${id}`, name: id, version: "1", capabilities: [] },
        activate: () => ({ dispose: () => { order.push(id); } }),
      });
    }
    const host = await registry.activate(context([]));
    await host.dispose();
    await host.dispose();
    assert.deepEqual(order, ["three", "two", "one"]);
  });
});
