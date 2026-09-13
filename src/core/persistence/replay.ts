import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readEvents, type PersistedEvent } from "./event-log.ts";

/**
 * Result of replaying a session from its event log.
 *
 * `messages` is the authoritative reconstruction: each entry comes from a
 * `MESSAGE_ENDED` payload (terminal state, not streaming snapshots). Audit
 * events like `STUCK_WARNING`, `COST_UPDATE`, `GUARD_BLOCKED`,
 * `STEERING_QUEUED`, `SESSION_*` are deliberately
 * NOT replayed — they describe guardrail activity, not conversation state.
 * Recovering guardrail state would mean re-running policy decisions on
 * historical events, which we don't want; instead, the session's persisted
 * usage counters are loaded separately and fed into a fresh UsageTracker.
 *
 * Note on pairing: Pi's `AgentMessage` (UserMessage / AssistantMessage /
 * ToolResultMessage) has no `id` field — id is a `SessionEntry` concept
 * (the on-disk format), not an in-memory one. So replay does not pair
 * MESSAGE_STARTED with MESSAGE_ENDED; it just walks the events in append
 * order (FIFO guarantees chronological order — see event-log.ts) and
 * collects every `MESSAGE_ENDED.message`. A user/assistant/toolResult
 * message that was mid-stream when the process crashed simply never
 * produced a MESSAGE_ENDED event and is therefore absent from the
 * recovered transcript — that's the correct behaviour (we drop the
 * half-baked message rather than feeding it to the next LLM call).
 */
export type ReplayResult = {
  messages: AgentMessage[];
  /** Whether the log already owns message history, including a crash-open message. */
  hasMessageEvents: boolean;
};

export async function replaySession(sessionId: string): Promise<ReplayResult> {
  const events: readonly PersistedEvent[] = await readEvents(sessionId);

  let messages: AgentMessage[] = [];
  let hasMessageEvents = false;
  for (const ev of events) {
    if (ev.type === "MESSAGE_STARTED" || ev.type === "MESSAGE_ENDED") {
      hasMessageEvents = true;
    }
    if (ev.type === "MESSAGE_ENDED") {
      const message = ev.payload.message as AgentMessage | undefined;
      if (message) messages.push(message);
      continue;
    }
    if (ev.type === "COMPACTION" && Array.isArray(ev.payload.contextMessages)) {
      // New compaction events carry the complete post-compaction model
      // context. Replacement, not another append, is the durable semantic.
      messages = [...ev.payload.contextMessages] as AgentMessage[];
    }
  }

  return { messages, hasMessageEvents };
}
