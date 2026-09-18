import { test } from "node:test";
import assert from "node:assert/strict";
import { usagePlugin } from "./usage.ts";
import type { PluginSessionContext } from "../types.ts";

test("usage plugin owns token accounting and emits the UI projection", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const context = {
    session: { usage: { tokensIn: 5, tokensOut: 2, cacheRead: 0, cacheWrite: 0, lastContextTokens: 5 } },
    emitEvent: async (type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); },
  } as PluginSessionContext;
  const instance = await usagePlugin.activate(context, {});
  await instance.onAgentEvent?.({
    type: "message_end",
    message: {
      role: "assistant", content: [], timestamp: 1, api: "openai-completions", provider: "p", model: "m",
      stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 1, cacheWrite: 2, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  } as never);
  assert.equal(events[0]?.type, "USAGE_UPDATE");
  assert.equal(events[0]?.payload.tokensIn, 15);
  assert.equal(events[0]?.payload.contextTokens, 16);
});
