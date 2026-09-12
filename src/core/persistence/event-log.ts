import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../../events/event-bus.ts";
import { defaultBus } from "../../events/event-bus.ts";
import { CONTROL_EVENT_TYPES } from "../../events/event-types.ts";
import type { ControlEvent, ControlEventType } from "../../events/event-types.ts";

export function eventsDir(): string {
  return resolve(
    process.env.FORGE_EVENTS_DIR ?? join(process.env.HOME ?? "/tmp", ".forge", "events"),
  );
}

export type PersistedEventType =
  // lifecycle
  | "SESSION_CREATED"
  | "SESSION_STARTED"
  | "SESSION_RESUMED"
  | "SESSION_ENDED"
  | "SESSION_FAILED"
  | "SESSION_CANCELLED"
  // agent loop (data plane — high frequency, not fanned out to the bus)
  // AGENT_RUN_* is the Pi-run lifecycle (one runAgent call), distinct from
  // the SESSION_* lifecycle (the session as a whole, owned by SessionManager).
  // A resumed session legitimately logs SESSION_* once + AGENT_RUN_* per run.
  | "AGENT_RUN_STARTED"
  | "AGENT_RUN_ENDED"
  // mid-session model switch (POST /sessions/:id/model)
  | "MODEL_CHANGED"
  // mid-session thinking-level switch (POST /sessions/:id/thinking).
  // Same plane as MODEL_CHANGED: an operator action the UI reads from the log.
  | "THINKING_CHANGED"
  | "TURN_STARTED"
  | "TURN_ENDED"
  | "MESSAGE_STARTED"
  | "MESSAGE_UPDATED"
  | "MESSAGE_ENDED"
  | "TEXT_DELTA"
  | "TOOL_CALL"
  | "TOOL_UPDATE"
  | "TOOL_RESULT"
  // guardrails (Phase 3+; reserved so event types cover everything the UI renders)
  | "STEERING_QUEUED"
  // Mid-session approval-posture switch (POST /sessions/:id/approval)
  | "APPROVAL_MODE_CHANGED"
  // Per-session token usage (2026-09-11, replaces COST_UPDATE for new logs;
  // COST_UPDATE stays in the union because historical logs contain it).
  // Payload shape: { tokensIn, tokensOut, cacheRead, cacheWrite, contextTokens }
  | "USAGE_UPDATE"
  | "COST_UPDATE"
  | "STUCK_WARNING"
  // Phase 3: tool-policy boundaries (added with the EventBus collapse — see
  // docs/25 §6.2 phase 1). Payload shape:
  //   GUARD_BLOCKED            → { toolName: string, reason: string }
  //   GUARD_APPROVAL_REQUEST   → { requestId: string, toolName: string }
  | "GUARD_BLOCKED"
  | "GUARD_APPROVAL_REQUEST"
  // Phase 5: compaction
  | "COMPACTION"
  | "COMPACTION_FAILED";

export type PersistedEvent = {
  id: string;
  type: PersistedEventType;
  /**
   * Session this event belongs to. Renamed from `taskId` (2026-09-12) — the
   * domain model has been Session for a long time; the field name was the
   * last holdout. Logs written before the rename carry `taskId`; readEvents
   * normalizes them (see normalizeEvent) so consumers see one name.
   */
  sessionId: string;
  at: number;
  payload: Record<string, unknown>;
};

/**
 * Old log lines (pre-rename) use `taskId` for the same value. Normalize at
 * the read boundary so nothing downstream has to know about the legacy name.
 */
function normalizeEvent(raw: Record<string, unknown>): PersistedEvent {
  const sessionId =
    typeof raw.sessionId === "string"
      ? raw.sessionId
      : typeof raw.taskId === "string"
        ? raw.taskId
        : "";
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type: raw.type as PersistedEventType,
    sessionId,
    at: typeof raw.at === "number" ? raw.at : 0,
    payload: (raw.payload ?? {}) as Record<string, unknown>,
  };
}

/**
 * Control-plane subset of PersistedEventType. These are the events that
 * `appendEvent` fans out to the in-process EventBus after writing to disk.
 * Data-plane events (TURN, MESSAGE, TEXT_DELTA, TOOL families) stay in the
 * log only — high volume, not actionable as notifications.
 */
// Derived from the single source of truth in events/event-types.ts. The
// Set<PersistedEventType> annotation is the compile-time guard: a control
// event that is not a PersistedEventType fails to build here.
const CONTROL_EVENT_SET: ReadonlySet<PersistedEventType> = new Set<PersistedEventType>(
  CONTROL_EVENT_TYPES,
);

export function isControlEvent(type: PersistedEventType): type is ControlEventType {
  return CONTROL_EVENT_SET.has(type);
}

function eventFile(sessionId: string): string {
  return join(eventsDir(), `${sessionId}.events.jsonl`);
}

/**
 * Per-task FIFO chain for appends.
 *
 * The streaming path fires appends without awaiting them (`void appendEvent`
 * in task-manager's onPiEvent, one call per agent delta). Concurrent
 * appendFile calls race in the libuv threadpool and their writes land in
 * arbitrary order, scrambling the JSONL line order. The SSE stream and the
 * desktop treat this file as ordered truth, so scrambled appends corrupted
 * streamed text (observed as CJK delta reordering / swapped chunks in real
 * captures). Chaining per task restores call-order persistence; await
 * semantics are unchanged — a caller's append still completes before its
 * promise resolves.
 */
const appendQueues = new Map<string, Promise<unknown>>();

/**
 * Append a control- or data-plane event to the task's JSONL log, then
 * fan out to the control-plane bus if applicable. The bus is a pure
 * fan-out of the persisted event — same id, same type, same payload, same
 * timestamp. Subscribers receive the exact event that lives in the log.
 *
 * Fan-out failures are isolated: a throwing listener does not affect the
 * append result or the FIFO chain.
 */
export function appendEvent(
  sessionId: string,
  type: PersistedEventType,
  payload: Record<string, unknown>,
  opts?: { bus?: EventBus },
): Promise<PersistedEvent> {
  const bus = opts?.bus ?? defaultBus;
  const prev = appendQueues.get(sessionId) ?? Promise.resolve();
  const run = prev.then(() => appendEventNow(sessionId, type, payload, bus));
  // Keep the chain alive (and the map bounded) even if an append fails.
  const queued = run.catch(() => {});
  appendQueues.set(sessionId, queued);
  void queued.finally(() => {
    if (appendQueues.get(sessionId) === queued) appendQueues.delete(sessionId);
  });
  return run;
}

async function appendEventNow(
  sessionId: string,
  type: PersistedEventType,
  payload: Record<string, unknown>,
  bus: EventBus,
): Promise<PersistedEvent> {
  await mkdir(eventsDir(), { recursive: true });
  const event: PersistedEvent = {
    id: randomUUID(),
    type,
    sessionId,
    at: Date.now(),
    payload,
  };
  await appendFile(eventFile(sessionId), JSON.stringify(event) + "\n", "utf8");

  // Fan out to the control-plane bus (data-plane events stop at the log).
  // Bus publish errors are caught inside EventBus.publish — they cannot
  // break the append chain.
  if (isControlEvent(type)) {
    bus.publish(event as ControlEvent);
  }

  return event;
}

export async function readEvents(sessionId: string): Promise<readonly PersistedEvent[]> {
  try {
    const text = await readFile(eventFile(sessionId), "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((l) => normalizeEvent(JSON.parse(l) as Record<string, unknown>));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
