import { test } from "node:test";
import assert from "node:assert/strict";
import { multiplexHooks } from "./hook-multiplexer.ts";

test("core beforeToolCall denial cannot be relaxed by a plugin", async () => {
  let pluginCalled = false;
  const hooks = multiplexHooks(
    { beforeToolCall: async () => ({ block: true, reason: "core deny" }) },
    [{ id: "p", hooks: { beforeToolCall: async () => { pluginCalled = true; return { block: false }; } } }],
    async () => {},
  );
  const result = await hooks.beforeToolCall!({} as never);
  assert.equal(result?.block, true);
  assert.equal(result?.reason, "core deny");
  assert.equal(pluginCalled, false);
});

test("plugin hook failure is isolated and disabled", async () => {
  let failures = 0;
  const hooks = multiplexHooks(
    {},
    [{ id: "p", hooks: { shouldStopAfterTurn: async () => { throw new Error("bad"); } } }],
    async () => { failures += 1; },
  );
  assert.equal(await hooks.shouldStopAfterTurn!({} as never), false);
  assert.equal(await hooks.shouldStopAfterTurn!({} as never), false);
  assert.equal(failures, 1);
});

test("a plugin guard block produces attributed decision evidence", async () => {
  const blocks: Array<{ id: string; reason: string | undefined }> = [];
  const hooks = multiplexHooks(
    { beforeToolCall: async () => undefined },
    [{ id: "policy.extra", hooks: { beforeToolCall: async () => ({ block: true, reason: "workspace rule" }) } }],
    async () => {},
    () => true,
    async (id, _context, decision) => { blocks.push({ id, reason: decision.reason }); },
  );
  const result = await hooks.beforeToolCall!({
    toolCall: { id: "call-1", name: "bash" },
    args: { command: "echo hi" },
  } as never);
  assert.equal(result?.block, true);
  assert.deepEqual(blocks, [{ id: "policy.extra", reason: "workspace rule" }]);
});
