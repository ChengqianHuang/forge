import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpPlugin, mcpChildEnvironment, type McpClient } from "./mcp.ts";

test("MCP child environment drops ambient secrets but keeps explicit server config", () => {
  assert.deepEqual(
    mcpChildEnvironment(
      { PATH: "/bin", HOME: "/tmp/user", OPENAI_API_KEY: "ambient", SESSION_TOKEN: "ambient" },
      { SERVER_API_KEY: "explicit", MODE: "safe" },
    ),
    { PATH: "/bin", HOME: "/tmp/user", SERVER_API_KEY: "explicit", MODE: "safe" },
  );
});

test("MCP plugin discovers tools, preserves provenance and closes with the session", async () => {
  let closed = false;
  const client: McpClient = {
    connect: async () => {},
    listTools: async () => [{ name: "lookup", description: "look up", inputSchema: { type: "object", properties: {} } }],
    callTool: async (name, args) => ({ name, args }),
    close: async () => { closed = true; },
  };
  const plugin = createMcpPlugin({ id: "demo", client });
  const instance = await plugin.activate({ signal: new AbortController().signal } as never);
  const result = await instance.tools![0]!.execute("call-1", {}, new AbortController().signal);
  assert.deepEqual(result.details, { server: "demo", tool: "lookup", result: { name: "lookup", args: {} } });
  await instance.dispose?.();
  assert.equal(closed, true);
});
