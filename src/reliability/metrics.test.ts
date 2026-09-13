import { test } from "node:test";
import assert from "node:assert/strict";
import type { PersistedEvent, PersistedEventType } from "../core/persistence/event-log.ts";
import { extractReliabilityMetrics, formatReliabilityLine } from "./metrics.ts";

function event(
  id: string,
  type: PersistedEventType,
  at: number,
  payload: Record<string, unknown> = {},
): PersistedEvent {
  return { id, type, at, payload, sessionId: "s1" };
}

test("projects a healthy guarded run with approval and cancellation latency", () => {
  const metrics = extractReliabilityMetrics({
    sessionStatus: "cancelled",
    events: [
      event("1", "AGENT_RUN_STARTED", 10),
      event("2", "GUARD_APPROVAL_REQUEST", 20, { requestId: "call-1" }),
      event("3", "GUARD_DECISION", 25, { toolCallId: "call-1", guardId: "forge.core", outcome: "approved" }),
      event("4", "TOOL_CALL", 26, { toolCallId: "call-1" }),
      event("5", "TOOL_RESULT", 30, { toolCallId: "call-1", isError: false }),
      event("6", "SESSION_STOP_REQUESTED", 40, { reason: "user" }),
      event("7", "SESSION_CANCELLED", 52, { status: "cancelled" }),
    ],
  });
  assert.equal(metrics.integrity.healthy, true);
  assert.equal(metrics.tools.guardCoverage, 1);
  assert.equal(metrics.approvals.p95LatencyMs, 5);
  assert.equal(metrics.cancellation.p95LatencyMs, 12);
  assert.match(formatReliabilityLine(metrics), /healthy.*guards=100%/);
});

test("reports lifecycle, guard and event-integrity violations without judging output", () => {
  const metrics = extractReliabilityMetrics({
    sessionStatus: "completed",
    events: [
      event("same", "AGENT_RUN_STARTED", 10),
      event("same", "TOOL_CALL", 9, { toolCallId: "unguarded" }),
      event("3", "GUARD_APPROVAL_REQUEST", 11, { requestId: "pending" }),
      event("4", "SESSION_ENDED", 12, { status: "completed" }),
      event("5", "SESSION_FAILED", 13, { status: "failed" }),
    ],
  });
  assert.equal(metrics.integrity.healthy, false);
  assert.ok(metrics.integrity.violations.some((v) => v.startsWith("duplicate event id")));
  assert.ok(metrics.integrity.violations.some((v) => v.startsWith("timestamp regression")));
  assert.ok(metrics.integrity.violations.some((v) => v.includes("no forge.core guard")));
  assert.ok(metrics.integrity.violations.some((v) => v.includes("remain unfinished")));
  assert.ok(metrics.integrity.violations.some((v) => v.startsWith("terminal count")));
  assert.ok(metrics.integrity.violations.some((v) => v.includes("approval request")));
});
