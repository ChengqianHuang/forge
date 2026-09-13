export const SESSION_SCHEMA_VERSION = 9;

type Migration = {
  from: number;
  to: number;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * v3 → v4: TaskSession → Session.
 *
 * The legacy task model (state machine + plan + observations) collapses into
 * the single Session model: `status` replaces `state`, `messages` replaces
 * plan/observations as the carrier of truth. Unfinished legacy tasks map to
 * "cancelled" — the new loop has no mechanism to resume a state-machine
 * mid-point, and pretending otherwise would corrupt the audit trail.
 */
function mapTaskStateToSessionStatus(state: unknown): SessionStatusLike {
  switch (state) {
    case "COMPLETE":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      // READY / UNDERSTAND / PLAN / EXECUTE / OBSERVE / FIX / EVALUATE /
      // REVIEW_REQUIRED — no resumable counterpart in the new architecture.
      return "cancelled";
  }
}

type SessionStatusLike = "running" | "completed" | "failed" | "cancelled";

/**
 * v4 → v5: persist `maxTurns`. (The field was retired 2026-09-12 — it had no
 * UI entry, so it never fired for a user. This step stays: the chain must
 * still carry v4 files to the current shape.)
 *
 * The turn budget was previously only carried in the in-memory
 * CompletionConfig — a resumed session lost it and ran unbounded by turns.
 * v5 persists it on the session (null = unbounded). Old v4 sessions get
 * null: their original budget was never recorded, so there is nothing to
 * restore honestly.
 */
function addMaxTurns(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, maxTurns: null };
}

/**
 * v5 → v6: persist `thinkingLevel`.
 *
 * The reasoning effort was never recorded on a session: `config.reasoning`
 * was left undefined, which every adapter reads as "send no reasoning
 * parameter" — i.e. off. v6 records the choice explicitly so it can be shown
 * and switched mid-session. Old sessions migrate to "off" (what they actually
 * ran with), not to the new-session default: a migration must not silently
 * change how a stored session behaves.
 */
function addThinkingLevel(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, thinkingLevel: "off" };
}

/**
 * v7 → v8: persist `approvalMode` (ask | default | always).
 *
 * The approval posture is a session-level run-config axis (PM, 2026-09-12:
 * "没有审批级别，每次 bash 都要我批"). Old sessions migrate to "default" —
 * safe read-only commands stop asking, which is the behavior the user asked
 * for going forward.
 */
function addApprovalMode(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, approvalMode: "default" };
}

/**
 * v8 → v9: message history moves out of the metadata snapshot and into the
 * event log. The operational import happens in session-store while the raw
 * v8 `messages` value is still available; new saves omit the field.
 */
function moveMessagesToEventLog(raw: Record<string, unknown>): Record<string, unknown> {
  return raw;
}

/**
 * v6 → v7: `cost` (dollars, never enforced) → `usage` (token counters).
 *
 * The dollar layer was removed (2026-09-11); per-session usage is now the
 * persisted record, hydrating UsageTracker on resume. Old sessions carry
 * `cost`, which cannot be converted into tokens — the honest migration is
 * zeroed counters (their real token history was never recorded) plus the
 * cost key dropped. Without this, resume() passed `undefined` into
 * UsageTracker.hydrate and every pre-existing session failed with
 * "Cannot read properties of undefined (reading 'tokensIn')".
 */
function costToUsage(raw: Record<string, unknown>): Record<string, unknown> {
  const { cost: _droppedCost, ...rest } = raw;
  return { ...rest, usage: { ...DEFAULT_USAGE } };
}

const APPROVAL_MODES: readonly string[] = ["ask", "default", "always"];

const DEFAULT_USAGE = {
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  lastContextTokens: null,
} as const;

const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
  {
    from: 1,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
  {
    from: 2,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
  {
    from: 3,
    to: 4,
    migrate: (raw) => migrateLegacyTaskToSession(raw),
  },
  {
    from: 4,
    to: 5,
    migrate: (raw) => addMaxTurns(raw),
  },
  {
    from: 5,
    to: 6,
    migrate: (raw) => addThinkingLevel(raw),
  },
  {
    from: 6,
    to: 7,
    migrate: (raw) => costToUsage(raw),
  },
  {
    from: 7,
    to: 8,
    migrate: (raw) => addApprovalMode(raw),
  },
  {
    from: 8,
    to: 9,
    migrate: (raw) => moveMessagesToEventLog(raw),
  },
];

function migrateLegacyTaskToSession(raw: Record<string, unknown>): Record<string, unknown> {
  const status = mapTaskStateToSessionStatus(raw.state);
  const legacyFailure =
    typeof raw.failureReason === "string" ? raw.failureReason : null;
  return {
    // carried over
    id: typeof raw.id === "string" ? raw.id.replace(/^task_/, "session_") : raw.id,
    goal: typeof raw.goal === "string" ? raw.goal : "",
    workspace:
      typeof raw.workspacePath === "string" && raw.workspacePath
        ? raw.workspacePath
        : typeof raw.directory === "string"
          ? raw.directory
          : "",
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    model:
      raw.model && typeof raw.model === "object"
        ? raw.model
        : { provider: "unknown", modelId: "unknown" },
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    status,
    failureReason: legacyFailure ?? (status === "cancelled" ? "migrated from legacy task state" : null),
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
    approvalMode: "default",
    thinkingLevel: "off",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    // legacy fields deliberately dropped:
    // state, plan, observations, fixCount, currentStepId, runtime, piSessionId
  };
}

/** Stamp schemaVersion on a session before persisting. */
export function stampSchemaVersion(session: Record<string, unknown>): Record<string, unknown> {
  return { ...session, schemaVersion: SESSION_SCHEMA_VERSION };
}

/**
 * Read a persisted session and apply migrations to reach the current schema
 * version. Handles legacy TaskSession files (v0-v3, `tasks/` era) and
 * current v4 sessions.
 */
export function migrateSession(raw: Record<string, unknown>): Record<string, unknown> {
  const version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;

  let data = { ...raw };
  let current = version;
  for (const migration of MIGRATIONS) {
    if (current < migration.to && current >= migration.from) {
      data = migration.migrate(data);
      current = migration.to;
    }
  }

  // Field completeness is NOT the same as the version stamp. This used to
  // short-circuit when `version === SESSION_SCHEMA_VERSION` and return the
  // raw object — so a file at the current version but missing a field (a
  // write from an older build that had already bumped the stamp, a hand-edited
  // file) sailed through and crashed its consumer. Always ensure the fields
  // the current schema promises exist.
  return { ...ensureCurrentFields(data), schemaVersion: SESSION_SCHEMA_VERSION };
}

/** Fill in fields a current-version session must have, without a migration. */
function ensureCurrentFields(data: Record<string, unknown>): Record<string, unknown> {
  const usage =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : {};
  return {
    ...data,
    usage: { ...DEFAULT_USAGE, ...usage },
    approvalMode:
      typeof data.approvalMode === "string" && APPROVAL_MODES.includes(data.approvalMode)
        ? data.approvalMode
        : "default",
  };
}
