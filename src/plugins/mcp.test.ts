import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpPlugin, McpStdioClient, mcpChildEnvironment, type McpClient } from "./mcp.ts";

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

test("MCP close escalates and remains bounded when SIGTERM is ignored", async () => {
  const oldTerminate = process.env.FORGE_MCP_TERMINATE_GRACE_MS;
  const oldKill = process.env.FORGE_MCP_KILL_GRACE_MS;
  process.env.FORGE_MCP_TERMINATE_GRACE_MS = "10";
  process.env.FORGE_MCP_KILL_GRACE_MS = "100";
  const script = [
    "process.on('SIGTERM',()=>{});",
    "process.stdin.setEncoding('utf8');",
    "let b='';",
    "process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l)continue;const m=JSON.parse(l);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'?{tools:[]}:{}})+'\\n')}});",
  ].join("");
  const client = new McpStdioClient(process.execPath, ["-e", script]);
  try {
    await client.connect();
    const started = Date.now();
    await client.close();
    assert.ok(Date.now() - started < 500, "MCP close exceeded its configured bound");
  } finally {
    await client.close();
    if (oldTerminate === undefined) delete process.env.FORGE_MCP_TERMINATE_GRACE_MS;
    else process.env.FORGE_MCP_TERMINATE_GRACE_MS = oldTerminate;
    if (oldKill === undefined) delete process.env.FORGE_MCP_KILL_GRACE_MS;
    else process.env.FORGE_MCP_KILL_GRACE_MS = oldKill;
  }
});
