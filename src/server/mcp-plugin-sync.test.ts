import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginRegistry } from "../plugins/registry.ts";
import type { ForgePlugin, PluginSessionContext } from "../plugins/types.ts";
import type { McpServerConfig } from "./config-store.ts";
import { McpPluginSync } from "./mcp-plugin-sync.ts";

function context(id: string): PluginSessionContext {
  return {
    session: {
      id,
      goal: "test",
      workspace: "/tmp",
      projectId: null,
      model: { provider: "test", modelId: "test" },
      messages: [],
      status: "running",
      failureReason: null,
      usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
      approvalMode: "default",
      thinkingLevel: "off",
      createdAt: 1,
      updatedAt: 1,
    },
    signal: new AbortController().signal,
    emitEvent: async () => {},
    enqueueSteering: () => {},
    requestCompaction: () => {},
  };
}

function config(id: string, command: string, enabled = true): McpServerConfig {
  return { id, command, args: [], enabled };
}

test("MCP reconciliation changes only later session activations", async () => {
  const registry = new PluginRegistry();
  let activations = 0;
  const factory = (server: McpServerConfig): ForgePlugin => ({
    manifest: { id: `mcp.${server.id}`, name: server.id, version: "1", capabilities: ["tool"] },
    activate: () => {
      activations += 1;
      return {
        tools: [{
          name: `tool_${server.id}`,
          label: server.id,
          description: server.command,
          parameters: {} as never,
          execute: async () => ({ content: [], details: { command: server.command } }),
        }],
      };
    },
  });
  const sync = new McpPluginSync(registry, factory);

  await sync.reconcile([config("demo", "old")]);
  assert.equal(activations, 0, "catalog reconciliation must not start an MCP client");
  const oldHost = await registry.activate(context("old"));
  assert.equal(activations, 1);

  await sync.reconcile([config("demo", "new")]);
  assert.deepEqual((await oldHost.tools()[0]!.execute("old-call", {})).details, { command: "old" });
  const newHost = await registry.activate(context("new"));
  assert.deepEqual((await newHost.tools()[0]!.execute("new-call", {})).details, { command: "new" });

  await sync.reconcile([]);
  assert.equal(registry.capabilities().plugins.some((plugin) => plugin.id === "mcp.demo"), false);
  assert.deepEqual((await oldHost.tools()[0]!.execute("still-old", {})).details, { command: "old" });
  assert.deepEqual((await newHost.tools()[0]!.execute("still-new", {})).details, { command: "new" });
  await oldHost.dispose();
  await newHost.dispose();
});

test("MCP reconciliation rejects capability collisions before mutation", async () => {
  const registry = new PluginRegistry();
  registry.register({
    manifest: { id: "mcp.clash", name: "existing", version: "1", capabilities: ["tool"] },
    activate: () => ({}),
  });
  const sync = new McpPluginSync(registry, () => {
    throw new Error("factory should not run");
  });
  await assert.rejects(() => sync.reconcile([config("clash", "x")]), /conflicts with an existing capability/);
  assert.equal(sync.snapshot().length, 0);
  assert.equal(registry.plugin("mcp.clash")?.manifest.name, "existing");
});

test("MCP reconciliation restores the previous catalog if replacement fails", async () => {
  const registry = new PluginRegistry();
  const factory = (server: McpServerConfig): ForgePlugin => {
    if (server.command === "bad") throw new Error("bad replacement");
    return {
      manifest: { id: `mcp.${server.id}`, name: server.command, version: "1", capabilities: ["tool"] },
      activate: () => ({}),
    };
  };
  const sync = new McpPluginSync(registry, factory);
  await sync.reconcile([config("demo", "old")]);
  await assert.rejects(() => sync.reconcile([config("demo", "bad")]), /bad replacement/);
  assert.equal(registry.plugin("mcp.demo")?.manifest.name, "old");
  assert.equal(sync.snapshot()[0]?.command, "old");
});
