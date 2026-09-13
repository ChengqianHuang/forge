import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "../desktop/src/types.ts";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  },
});

test("desktop folds durable guard decisions idempotently by decision id", async () => {
  const { reduceEnvelope, store } = await import("../desktop/src/lib/store.ts");
  const initial = store.getState();
  const allowed: EventEnvelope = {
    type: "GUARD_DECISION",
    at: 10,
    payload: {
      decisionId: "call-1:forge.core",
      guardId: "forge.core",
      toolCallId: "call-1",
      toolName: "bash",
      capability: "git",
      policyAction: "allow",
      effectiveAction: "allow",
      outcome: "allowed",
      basis: "policy",
      approvalMode: "default",
      ruleId: "git-read-status",
      reason: "allowed by rule",
      inputSummary: '{"command":"git status"}',
    },
  };
  const first = { ...initial, ...reduceEnvelope(initial, allowed) };
  assert.equal(first.conversation.guardDecisions.length, 1);
  assert.equal(first.conversation.guardDecisions[0]?.ruleId, "git-read-status");

  const corrected: EventEnvelope = {
    ...allowed,
    at: 11,
    payload: { ...allowed.payload, outcome: "rejected", basis: "user" },
  };
  const second = { ...first, ...reduceEnvelope(first, corrected) };
  assert.equal(second.conversation.guardDecisions.length, 1);
  assert.equal(second.conversation.guardDecisions[0]?.outcome, "rejected");
});
