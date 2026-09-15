import type { Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";

/**
 * Per-session usage statistics:
 *  - cumulative token counters (fed from assistant-message usage), and
 *  - the context watermark: the most recent assistant message's
 *    calculateContextTokens — the same signal Pi's own shouldCompact uses —
 *    which the prepareNextTurn hook reads to trigger compaction. The current
 *    turn's number is what matters, not cumulative usage (cumulative
 *    double-counts prior turns).
 *
 * Note: some providers (MiniMax anthropic-compat, e.g.) bill the whole prompt
 * as cacheWrite and report input=0 — never use usage.input alone as the
 * watermark; calculateContextTokens (totalTokens, falling back to the
 * component sum) is the honest signal.
 */
export class UsageTracker {
  private tokensIn = 0;
  private tokensOut = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private lastContextTokens: number | null = null;

  trackUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.tokensIn += num(usage.input);
    this.tokensOut += num(usage.output);
    this.cacheRead += num(usage.cacheRead);
    this.cacheWrite += num(usage.cacheWrite);
    const contextTokens = calculateContextTokens(usage);
    if (Number.isFinite(contextTokens) && contextTokens > 0) {
      this.lastContextTokens = contextTokens;
    }
  }

  getLastContextTokens(): number | null {
    return this.lastContextTokens;
  }

  snapshot(): {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    lastContextTokens: number | null;
  } {
    return {
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      lastContextTokens: this.lastContextTokens,
    };
  }

  /**
   * Resume from persisted session state (session.usage). Tolerates an absent
   * record: schema migrations fill it in, but a crash-on-resume is never an
   * acceptable answer to a missing optional counter.
   */
  hydrate(state:
    | Partial<{
        tokensIn: number;
        tokensOut: number;
        cacheRead: number;
        cacheWrite: number;
        lastContextTokens: number | null;
      }>
    | undefined): void {
    if (!state) return;
    if (typeof state.tokensIn === "number") this.tokensIn = state.tokensIn;
    if (typeof state.tokensOut === "number") this.tokensOut = state.tokensOut;
    if (typeof state.cacheRead === "number") this.cacheRead = state.cacheRead;
    if (typeof state.cacheWrite === "number") this.cacheWrite = state.cacheWrite;
    this.lastContextTokens = typeof state.lastContextTokens === "number" ? state.lastContextTokens : null;
  }
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
