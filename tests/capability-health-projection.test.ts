import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "../desktop/src/types.ts";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
});

test("desktop keeps ordered capability lifecycle and distinguishes failure severity", async () => {
  const { reduceEnvelope, store } = await import("../desktop/src/lib/store.ts");
  let state = store.getState();
  const fold = (event: EventEnvelope) => {
    state = { ...state, ...reduceEnvelope(state, event) };
  };

  fold({ type: "PLUGIN_LOADED", at: 10, payload: { pluginId: "optional.one", status: "active", required: false } });
  const optionalFailure: EventEnvelope = {
    type: "PLUGIN_FAILED",
    at: 11,
    payload: { pluginId: "optional.one", phase: "onAgentEvent", reason: "boom", required: false },
  };
  fold(optionalFailure);
  fold(optionalFailure);
  fold({
    type: "PLUGIN_FAILED",
    at: 12,
    payload: { pluginId: "required.one", phase: "activate", reason: "broken", required: true },
  });

  assert.equal(state.conversation.pluginLifecycle.length, 3, "replay must not duplicate lifecycle facts");
  assert.equal(state.conversation.pluginStates["optional.one"]?.status, "failed");
  assert.match(state.conversation.timeline.find((entry) => entry.id === "plugin-failed-11")?.text ?? "", /可选能力.*Agent 继续运行/);
  assert.match(state.conversation.timeline.find((entry) => entry.id === "plugin-failed-12")?.text ?? "", /必需能力.*机制已降级/);
});
