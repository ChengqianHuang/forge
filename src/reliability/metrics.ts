import type { PersistedEvent } from "../core/persistence/event-log.ts";
import type { SessionStatus } from "../types.ts";

const TERMINAL_TYPES = new Set(["SESSION_ENDED", "SESSION_FAILED", "SESSION_CANCELLED"]);
const RESOLVED_APPROVAL_OUTCOMES = new Set(["approved", "rejected", "aborted"]);

export type ReliabilityMetrics = {
  eventCount: number;
  wallMs: number;
  runs: { started: number; endedByPi: number; terminal: number };
  tools: {
    calls: number;
    results: number;
    errors: number;
    guarded: number;
    guardCoverage: number;
    unfinished: number;
    orphanResults: number;
  };
  approvals: {
    requested: number;
    resolved: number;
    pending: number;
    p95LatencyMs: number | null;
  };
  cancellation: {
    requested: number;
    settled: number;
    p95LatencyMs: number | null;
  };
  recovery: { interrupted: number; resumed: number; messagesRecovered: number };
  plugins: { failures: number };
  integrity: { healthy: boolean; violations: string[] };
};

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

/**
 * Project harness reliability from durable facts only. This deliberately
 * never inspects generated text or decides whether the model's answer was
 * good. It measures whether Forge kept its own lifecycle and safety promises.
 */
export function extractReliabilityMetrics(input: {
  events: readonly PersistedEvent[];
  sessionStatus?: SessionStatus | undefined;
}): ReliabilityMetrics {
  const { events, sessionStatus } = input;
  const violations: string[] = [];
  const ids = new Set<string>();
  const calls = new Map<string, PersistedEvent>();
  const duplicateCallIds = new Set<string>();
  const completedCalls = new Set<string>();
  const guardedCalls = new Set<string>();
  const approvalRequests = new Map<string, number>();
  const resolvedApprovals = new Set<string>();
  const approvalLatencies: number[] = [];
  const pendingStops: number[] = [];
  const cancellationLatencies: number[] = [];
  let orphanResults = 0;
  let toolErrors = 0;
  let messagesRecovered = 0;
  let previousAt = -Infinity;

  for (const event of events) {
    if (ids.has(event.id)) violations.push(`duplicate event id: ${event.id}`);
    ids.add(event.id);
    if (event.at < previousAt) violations.push(`timestamp regression at event ${event.id}`);
    previousAt = event.at;

    const toolCallId = typeof event.payload.toolCallId === "string"
      ? event.payload.toolCallId
      : "";
    if (event.type === "TOOL_CALL" && toolCallId) {
      if (calls.has(toolCallId)) duplicateCallIds.add(toolCallId);
      calls.set(toolCallId, event);
    }
    if (event.type === "TOOL_RESULT" && toolCallId) {
      if (!calls.has(toolCallId)) orphanResults += 1;
      completedCalls.add(toolCallId);
      if (event.payload.isError === true) toolErrors += 1;
    }
    if (event.type === "GUARD_DECISION" && toolCallId && event.payload.guardId === "forge.core") {
      guardedCalls.add(toolCallId);
    }
    if (event.type === "GUARD_APPROVAL_REQUEST") {
      const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
      if (requestId) approvalRequests.set(requestId, event.at);
    }
    if (event.type === "GUARD_DECISION" && toolCallId && RESOLVED_APPROVAL_OUTCOMES.has(String(event.payload.outcome))) {
      const requestedAt = approvalRequests.get(toolCallId);
      if (requestedAt !== undefined && !resolvedApprovals.has(toolCallId)) {
        resolvedApprovals.add(toolCallId);
        approvalLatencies.push(Math.max(0, event.at - requestedAt));
      }
    }
    if (event.type === "SESSION_STOP_REQUESTED") pendingStops.push(event.at);
    if (event.type === "SESSION_CANCELLED" && pendingStops.length > 0) {
      const requestedAt = pendingStops.shift()!;
      cancellationLatencies.push(Math.max(0, event.at - requestedAt));
    }
    if (event.type === "SESSION_RESUMED") {
      messagesRecovered += Number(event.payload.messagesRecovered ?? 0);
    }
  }

  const unfinished = [...calls.keys()].filter((id) => !completedCalls.has(id)).length;
  const unguarded = [...calls.keys()].filter((id) => !guardedCalls.has(id)).length;
  const guarded = [...calls.keys()].filter((id) => guardedCalls.has(id)).length;
  const matchedResults = [...calls.keys()].filter((id) => completedCalls.has(id)).length;
  const terminals = events.filter((event) => TERMINAL_TYPES.has(event.type)).length;
  const runsStarted = events.filter((event) => event.type === "AGENT_RUN_STARTED").length;
  if (orphanResults > 0) violations.push(`${orphanResults} tool result(s) have no matching call`);
  if (duplicateCallIds.size > 0) violations.push(`${duplicateCallIds.size} duplicate tool call id(s)`);
  if (unguarded > 0) violations.push(`${unguarded} tool call(s) have no forge.core guard decision`);
  if (sessionStatus === "completed" && unfinished > 0) {
    violations.push(`${unfinished} tool call(s) remain unfinished in a completed session`);
  }
  if (sessionStatus !== "running" && runsStarted > 0 && terminals !== runsStarted) {
    violations.push(`terminal count ${terminals} does not match started run count ${runsStarted}`);
  }
  const pendingApprovals = approvalRequests.size - resolvedApprovals.size;
  if (sessionStatus !== "running" && pendingApprovals > 0) {
    violations.push(`${pendingApprovals} approval request(s) remain unresolved`);
  }
  if (sessionStatus !== "running" && pendingStops.length > 0) {
    violations.push(`${pendingStops.length} stop request(s) never reached cancellation`);
  }

  return {
    eventCount: events.length,
    wallMs: events.length > 1 ? Math.max(0, events.at(-1)!.at - events[0]!.at) : 0,
    runs: {
      started: runsStarted,
      endedByPi: events.filter((event) => event.type === "AGENT_RUN_ENDED").length,
      terminal: terminals,
    },
    tools: {
      calls: calls.size,
      results: matchedResults,
      errors: toolErrors,
      guarded,
      guardCoverage: calls.size === 0 ? 1 : guarded / calls.size,
      unfinished,
      orphanResults,
    },
    approvals: {
      requested: approvalRequests.size,
      resolved: resolvedApprovals.size,
      pending: pendingApprovals,
      p95LatencyMs: percentile95(approvalLatencies),
    },
    cancellation: {
      requested: cancellationLatencies.length + pendingStops.length,
      settled: cancellationLatencies.length,
      p95LatencyMs: percentile95(cancellationLatencies),
    },
    recovery: {
      interrupted: events.filter((event) => event.type === "SESSION_INTERRUPTED").length,
      resumed: events.filter((event) => event.type === "SESSION_RESUMED").length,
      messagesRecovered,
    },
    plugins: {
      failures: events.filter((event) => event.type === "PLUGIN_FAILED").length,
    },
    integrity: { healthy: violations.length === 0, violations },
  };
}

export function formatReliabilityLine(metrics: ReliabilityMetrics): string {
  const cancel = metrics.cancellation.p95LatencyMs === null
    ? "-"
    : `${metrics.cancellation.p95LatencyMs}ms`;
  const approval = metrics.approvals.p95LatencyMs === null
    ? "-"
    : `${metrics.approvals.p95LatencyMs}ms`;
  return [
    metrics.integrity.healthy ? "healthy" : "violated",
    `runs=${metrics.runs.terminal}/${metrics.runs.started}`,
    `guards=${Math.round(metrics.tools.guardCoverage * 100)}%`,
    `tools=${metrics.tools.results}/${metrics.tools.calls}`,
    `approval-p95=${approval}`,
    `cancel-p95=${cancel}`,
    `plugin-failures=${metrics.plugins.failures}`,
  ].join(" ");
}
