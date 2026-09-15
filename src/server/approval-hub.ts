/**
 * ApprovalHub — in-memory registry of guard approvals.
 *
 * The guard pipeline (beforeToolCall hook) hits an `ask` decision for bash /
 * network / git calls. The hook blocks on `request()`; the Desktop resolves
 * it via the HTTP approve/deny endpoints which call `mark()`. A hard timeout
 * converts an unanswered dialog into a denial — an agent must never hang
 * forever on an unattended dialog.
 */

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalRecord = {
  requestId: string;
  sessionId: string;
  method: string;
  title: string;
  message: string;
  at: number;
  status: ApprovalStatus;
};

type Waiter = (approved: boolean) => void;

export class ApprovalHub {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, Waiter>();

  record(input: { requestId: string; sessionId: string; method: string; title: string; message: string; at: number }): void {
    this.records.set(input.requestId, { ...input, status: "pending" });
    const set = this.bySession.get(input.sessionId) ?? new Set<string>();
    set.add(input.requestId);
    this.bySession.set(input.sessionId, set);
  }

  /** Pending approvals for a task (oldest first). */
  listPending(sessionId: string): readonly ApprovalRecord[] {
    const ids = this.bySession.get(sessionId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.records.get(id))
      .filter((r): r is ApprovalRecord => !!r && r.status === "pending")
      .sort((a, b) => a.at - b.at);
  }

  get(requestId: string): ApprovalRecord | null {
    return this.records.get(requestId) ?? null;
  }

  mark(requestId: string, status: ApprovalStatus): boolean {
    const rec = this.records.get(requestId);
    if (!rec) return false;
    this.records.set(requestId, { ...rec, status });
    const waiter = this.waiters.get(requestId);
    if (waiter) {
      this.waiters.delete(requestId);
      waiter(status === "approved");
    }
    return true;
  }

  /** Resolve only when the request belongs to the session named by the URL. */
  markForSession(sessionId: string, requestId: string, status: ApprovalStatus): boolean {
    const record = this.records.get(requestId);
    if (!record || record.sessionId !== sessionId) return false;
    return this.mark(requestId, status);
  }

  /** Expire every unresolved approval owned by a session. Cancellation and
   * shutdown call this so no waiter or dialog survives the run it guarded. */
  cancelSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId);
    if (!ids) return;
    for (const id of ids) {
      const record = this.records.get(id);
      if (record?.status === "pending") this.mark(id, "expired");
    }
    this.bySession.delete(sessionId);
  }

  /**
   * Blocking approval request used by the guardrail hook. Registers a pending
   * record and resolves when mark() lands (approved/denied), on timeout
   * (counts as denied — never hang on an unattended dialog), or when `signal`
   * aborts (the user pressed Stop — an unanswered dialog must not keep the
   * session alive; this was the "bash 卡死 + Stop 无效" bug).
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
  ): Promise<boolean> {
    const timeoutMs = input.timeoutMs ?? 5 * 60_000;
    this.record({
      requestId: input.requestId,
      sessionId: input.sessionId,
      method: "tool_call",
      title: `Allow ${input.toolName}?`,
      message: JSON.stringify(input.input).slice(0, 500),
      at: Date.now(),
    });

    return new Promise<boolean>((resolveP) => {
      let settled = false;
      const settle = (approved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolveP(approved);
      };
      const waiter: Waiter = settle;
      this.waiters.set(input.requestId, waiter);
      const onAbort = () => {
        if (this.waiters.get(input.requestId) === waiter) {
          this.waiters.delete(input.requestId);
          this.mark(input.requestId, "expired");
        }
        settle(false);
      };
      const timer = setTimeout(() => {
        if (this.waiters.get(input.requestId) === waiter) {
          this.waiters.delete(input.requestId);
          this.mark(input.requestId, "expired");
          settle(false);
        }
      }, timeoutMs);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
