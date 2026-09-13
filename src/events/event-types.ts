/**
 * Control-plane events: lifecycle + guardrail notifications.
 *
 * Architecture (see docs/ARCHITECTURE.md): these are the subset of `PersistedEventType`
 * that should fan out from the JSONL event log into the in-process
 * `EventBus`. Data-plane events (the TURN/MESSAGE/TEXT_DELTA/TOOL families)
 * stay in the log only — they are high-frequency and not actionable as
 * notifications.
 *
 * The bus is the fan-out target for in-process subscribers (analytics,
 * watchdog, cross-guardrail coordination). SSE and the desktop UI read the
 * event log directly and do NOT consume the bus.
 */

/**
 * The one and only control-plane list. `ControlEventType` is derived from it,
 * and `event-log.ts` builds its lookup set from the same array — a new event
 * type is added HERE, once. (Previously this list and the set in event-log.ts
 * were two hand-copied 15-item lists glued by a cast; adding a type to one
 * side silently drifted from the other.)
 */
export const CONTROL_EVENT_TYPES = [
  // lifecycle
  "SESSION_CREATED",
  "SESSION_STARTED",
  "SESSION_RESUMED",
  "SESSION_INTERRUPTED",
  "SESSION_STOP_REQUESTED",
  "SESSION_ENDED",
  "SESSION_FAILED",
  "SESSION_CANCELLED",
  // guardrails
  "STEERING_QUEUED",
  "APPROVAL_MODE_CHANGED",
  "USAGE_UPDATE",
  "COST_UPDATE",
  "STUCK_WARNING",
  "GUARD_DECISION",
  "GUARD_BLOCKED",
  "GUARD_APPROVAL_REQUEST",
  // compaction
  "COMPACTION",
  "COMPACTION_FAILED",
  // plugin platform
  "PLUGIN_LOADED",
  "PLUGIN_ENABLED",
  "PLUGIN_DISABLED",
  "PLUGIN_FAILED",
  "SLASH_COMMAND_INVOKED",
  "PLUGIN_OUTPUT",
] as const;

export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];

export type ControlEvent = {
  id: string;
  type: ControlEventType;
  sessionId: string;
  at: number;
  payload: Record<string, unknown>;
};

export type ControlEventListener = (event: ControlEvent) => void;
