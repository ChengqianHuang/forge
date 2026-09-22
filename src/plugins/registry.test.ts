import { after, describe, test } from "node:test";

// Some tests leave deliberately unresolved plugin promises (the timeout race
// rejects them only via its own timer). When the event loop briefly drains
// between tests, node exits mid-file and the remaining tests are cancelled —
// keep the loop alive for the whole file and release it in `after`.
let keepAlive: ReturnType<typeof setInterval> | undefined;
after(() => {
  if (keepAlive) clearInterval(keepAlive);
});
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
  keepAlive = setInterval(() => {}, 1000);
  test("projects declared UI contributions without teaching the registry renderer semantics", () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: {
        id: "test.ui",
        name: "ui",
        version: "1",
        capabilities: ["ui"],
        ui: [{ id: "panel", label: "Panel", surface: "session-header", renderer: "test-panel" }],
      },
      activate: () => ({}),
    });
    assert.deepEqual(registry.capabilities().uiContributions, [{
      id: "panel",
      label: "Panel",
      surface: "session-header",
      renderer: "test-panel",
      pluginId: "test.ui",
    }]);
  });

  test("validates and dispatches stateless read actions", async () => {
    const registry = new PluginRegistry();
    let activated = false;
    registry.register({
      manifest: {
        id: "test.reader",
        name: "reader",
        version: "1",
        capabilities: ["read-action", "ui"],
        readActions: [{ id: "inspect", description: "inspect" }],
        ui: [{ id: "panel", label: "Panel", surface: "session-header", renderer: "test", readAction: "inspect" }],
      },
      activate: () => { activated = true; return {}; },
      read: async (action, input) => ({ action, input }),
    });
    const result = await registry.read("test.reader", "inspect", { path: "a" }, {
      session: context([]).session,
      signal: new AbortController().signal,
      config: {},
    });
    assert.deepEqual(result, { action: "inspect", input: { path: "a" } });
    assert.equal(activated, false);
    await assert.rejects(
      () => registry.read("test.reader", "missing", {}, { session: context([]).session, signal: new AbortController().signal, config: {} }),
      /unknown read action/,
    );
  });

  test("bounds read actions and aborts timed-out plugin work", async () => {
    const registry = new PluginRegistry(10);
    let aborted = false;
    registry.register({
      manifest: {
        id: "test.slow-reader",
        name: "slow reader",
        version: "1",
        // Read actions only — no UI, no tools, no hooks.
        capabilities: ["read-action"],
        readActions: [{ id: "inspect", description: "inspect" }],
      },
      activate: () => ({}),
      read: (_action, _input, readContext) => new Promise((_resolve, reject) => {
        readContext.signal.addEventListener("abort", () => {
          aborted = true;
          reject(readContext.signal.reason);
        }, { once: true });
      }),
    });
    await assert.rejects(
      () => registry.read("test.slow-reader", "inspect", {}, {
        session: context([]).session,
        signal: new AbortController().signal,
        config: {},
      }),
      /timed out/,
    );
    assert.equal(aborted, true);
  });

  test("validates and dispatches stateful request/stream interactions with lifecycle cleanup", async () => {
    const registry = new PluginRegistry();
    let disposedSession: string | undefined;
    let disposed = false;
    registry.register({
      manifest: {
        id: "test.interactive",
        name: "interactive",
        version: "1",
        capabilities: ["interaction"],
        interactions: [
          { id: "send", description: "send", kind: "request" },
          { id: "events", description: "events", kind: "stream" },
        ],
      },
      activate: () => ({}),
      interact: (actionId, input) => ({ actionId, input }),
      subscribe: (_actionId, _input, _context, emit) => {
        emit({ type: "ready" });
        return () => {};
      },
      disposeSession: (sessionId) => { disposedSession = sessionId; },
      dispose: () => { disposed = true; },
    });
    const interactionContext = {
      session: context([]).session,
      signal: new AbortController().signal,
      config: {},
    };
    assert.deepEqual(
      await registry.interact("test.interactive", "send", { value: 1 }, interactionContext),
      { actionId: "send", input: { value: 1 } },
    );
    const frames: Record<string, unknown>[] = [];
    const unsubscribe = await registry.subscribe("test.interactive", "events", {}, interactionContext, (frame) => frames.push(frame));
    assert.deepEqual(frames, [{ type: "ready" }]);
    unsubscribe();
    const host = await registry.activate(context([]));
    await host.setEnabled("test.interactive", false);
    assert.equal(disposedSession, "s1");
    await host.dispose();
    disposedSession = undefined;
    await registry.disposeSession("s1");
    await registry.dispose();
    assert.equal(disposedSession, "s1");
    assert.equal(disposed, true);
  });

  test("interaction declarations and handlers must agree", () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.register({
      manifest: {
        id: "test.missing-interact",
        name: "missing",
        version: "1",
        capabilities: ["interaction"],
        interactions: [{ id: "send", description: "send", kind: "request" }],
      },
      activate: () => ({}),
    }), /without an interact handler/);
    assert.throws(() => registry.register({
      manifest: {
        id: "test.undeclared-interact",
        name: "undeclared",
        version: "1",
        capabilities: [],
        interactions: [{ id: "events", description: "events", kind: "stream" }],
      },
      activate: () => ({}),
      subscribe: () => () => {},
    }), /without the "interaction" capability/);
  });

  test("rejects UI descriptors that reference undeclared read actions", () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.register({
      manifest: {
        id: "test.bad-ui",
        name: "bad",
        version: "1",
        capabilities: ["ui"],
        ui: [{ id: "panel", label: "Panel", surface: "session-header", renderer: "test", readAction: "missing" }],
      },
      activate: () => ({}),
    }), /references unknown read action/);
  });

  test("rejects declared read actions without a handler", () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.register({
      manifest: {
        id: "test.missing-reader",
        name: "missing reader",
        version: "1",
        capabilities: ["read-action"],
        readActions: [{ id: "inspect", description: "inspect" }],
      },
      activate: () => ({}),
    }), /without a read handler/);
  });

  test("rejects a declared capability with no matching manifest surface", () => {
    // `forge.usage` shipped exactly this: ["guardrail", "event-subscriber",
    // "ui"] with no UI contribution and no read action. The manifest is what
    // the capability panel shows, so an over-declaration is a lie on a
    // user-visible surface, not a cosmetic detail.
    const registry = new PluginRegistry();
    assert.throws(() => registry.register({
      manifest: {
        id: "test.over-declared",
        name: "over",
        version: "1",
        capabilities: ["ui", "event-subscriber"],
      },
      activate: () => ({}),
    }), /declares capability "ui" without a UI contribution/);
  });

  test("rejects a manifest surface whose capability was not declared", () => {
    // The reverse drift is worse: the panel is projected from the manifest
    // before activation, so a host filtering on the capability that was never
    // declared would activate nothing behind a button that already rendered.
    const registry = new PluginRegistry();
    assert.throws(() => registry.register({
      manifest: {
        id: "test.under-declared",
        name: "under",
        version: "1",
        capabilities: [],
        slashCommands: [{ name: "go", description: "" }],
      },
      activate: () => ({}),
    }), /slash commands without the "slash-command" capability/);

    assert.throws(() => registry.register({
      manifest: {
        id: "test.under-declared-ui",
        name: "under ui",
        version: "1",
        capabilities: ["tool"],
        ui: [{ id: "panel", label: "Panel", surface: "session-header", renderer: "x" }],
      },
      activate: () => ({}),
    }), /contributes UI without declaring the "ui" capability/);
  });

  test("read actions and the \"read-action\" capability must agree", () => {
    const registry = new PluginRegistry();
    assert.throws(() => registry.register({
      manifest: {
        id: "test.read-over-declared",
        name: "read over",
        version: "1",
        capabilities: ["read-action"],
      },
      activate: () => ({}),
    }), /declares capability "read-action" without any read action/);

    assert.throws(() => registry.register({
      manifest: {
        id: "test.read-under-declared",
        name: "read under",
        version: "1",
        capabilities: ["tool"],
        readActions: [{ id: "inspect", description: "inspect" }],
      },
      activate: () => ({}),
      read: async () => ({}),
    }), /declares read actions without the "read-action" capability/);
  });

  test("rejects duplicate plugin ids", () => {
    const registry = new PluginRegistry();
    const plugin: ForgePlugin = {
      manifest: { id: "test.one", name: "one", version: "1", capabilities: [] },
      activate: () => ({}),
    };
    registry.register(plugin);
    assert.throws(() => registry.register(plugin), /already registered/);
  });

  test("freezes catalog membership when session activation starts", async () => {
    const registry = new PluginRegistry();
    let release!: () => void;
    let started!: () => void;
    const activationStarted = new Promise<void>((resolve) => { started = resolve; });
    const activationRelease = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      manifest: { id: "test.slow-start", name: "slow", version: "1", capabilities: ["tool"] },
      activate: async () => {
        started();
        await activationRelease;
        return {};
      },
    });
    const activating = registry.activate(context([]));
    await activationStarted;
    registry.register({
      manifest: { id: "test.late", name: "late", version: "1", capabilities: ["tool"] },
      activate: () => ({}),
    });
    release();
    const host = await activating;
    assert.deepEqual(host.capabilities().plugins.map((plugin) => plugin.id), ["test.slow-start"]);
    await host.dispose();
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
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    registry.register({
      manifest: { id: "test.toggle", name: "toggle", version: "1", capabilities: ["tool"] },
      activate: () => ({ tools: [
        { name: "extra", label: "extra", description: "extra", parameters: {} as never, execute: async () => ({ content: [], details: { ok: true } }) },
      ] }),
    });
    const host = await registry.activate(context(events));
    const tool = host.tools()[0]!;
    await host.setEnabled("test.toggle", false);
    await assert.rejects(() => tool.execute("1", {}), /disabled/);
    await host.setEnabled("test.toggle", true);
    assert.deepEqual((await tool.execute("2", {})).details, { ok: true });
    assert.equal(events.find((event) => event.type === "PLUGIN_DISABLED")?.payload.required, false);
    assert.equal(events.find((event) => event.type === "PLUGIN_ENABLED")?.payload.required, false);
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
