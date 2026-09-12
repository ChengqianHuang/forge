import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ApprovalMode, Session } from "../types.ts";
import type { UsageTracker } from "./usage-tracker.ts";

/**
 * Minimal approval surface used by guardrail hooks. The concrete hub lives
 * in server/approval-hub.ts; keeping this structural avoids a types → server
 * dependency.
 */
export interface ApprovalRelay {
  /**
   * Resolves when the user approves (true) or denies/expires/aborts (false).
   *
   * `sessionId` is REQUIRED: the desktop finds pending requests with
   * listPending(sessionId), so a request filed without one is invisible —
   * no dialog, and the hook sits out the full timeout. This interface used
   * to omit the field while the hub required it; the hook (which types
   * against this interface) silently passed nothing, and the resulting
   * 5-minute waits read as "the agent froze on a bash command".
   */
  request(
    input: {
      requestId: string;
      sessionId: string;
      toolName: string;
      input: Record<string, unknown>;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface GuardrailConfig {
  sessionId: string;
  workspace: string;
  /**
   * Per-session undo journal root (`<forgeHome>/undo/<sessionId>`). Explicit,
   * not read from a process env var — the in-process loop hosts many sessions
   * in one process, so a global cannot carry a per-session value.
   */
  undoRoot: string;
  /** Live session reference: guardrails write an honest failureReason. */
  session: Session;
  /**
   * Approval posture (live). session-manager keeps a reference to this very
   * object on the runtime, so switchApprovalMode mutates it here and the
   * next tool call sees the new mode. Absent = "default".
   */
  approvalMode?: ApprovalMode;
  approval: ApprovalRelay;
  steeringQueue: AgentMessage[];
  usage: UsageTracker;
}
