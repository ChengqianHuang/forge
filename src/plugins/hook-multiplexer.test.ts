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
