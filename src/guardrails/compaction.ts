import type {
  AgentContext,
  AgentLoopTurnUpdate,
  Entry,
  PrepareNextTurnContext,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  compact as piCompact,
  prepareCompaction,
  estimateContextTokens,
  calculateContextTokens,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { UsageTracker } from "./usage-tracker.ts";

/**
 * Default trigger cap. The actual trigger is `min(cap, window - reserveTokens)`,
 * so this number only binds on models wide enough for it to mean something:
 * 120K is 60% of a 200K window, which leaves the summarization pass room to
 * assemble the summary plus the retained tail. A narrower model gets an
 * earlier, window-derived threshold instead — until 2026-09-18 the number was
 * applied blindly, so a 32K-window model could never compact at all (120K is
 * wider than its window) and simply died at the provider's limit.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 120_000;
export const DEFAULT_KEEP_RECENT_MESSAGES = 20;

/**
 * Tokens held back for the summary request itself. Pi's
 * DEFAULT_COMPACTION_SETTINGS uses the same number for the same reason: the
 * summarizer is handed the old transcript, so the trigger must leave room for
 * that request to fit inside the window.
 */
const RESERVE_TOKENS = 16_384;

/**
 * Optional LLM-summary runtime. When provided, compaction calls Pi's
 * summarizer (prepareCompaction → compactWithRequest) to replace old
 * history with a structured summary + retained tail. When absent (or when
 * the summary call fails), the hook falls back to hard truncation.
 */
export interface SummaryRuntime {
  /** The subscription model that will generate the summary. */
  model: unknown;
  /**
   * Standalone completion boundary (model, aiContext, options) → full
   * assistant message. Wire this to the same streamFn the agent loop uses
   * so the summary rides on the subscription key without keys landing in
   * persisted data.
   */
  completeSimple: (
    model: unknown,
    context: unknown,
    options: unknown,
  ) => Promise<unknown>;
}

/** Wrap raw messages as virtual Pi session entries (a plain parent chain). */
function toVirtualEntries(messages: AgentMessage[]): Entry[] {
  return messages.map((message, index) => ({
    type: "message" as const,
    id: `virtual:${index}`,
    parentId: index === 0 ? null : `virtual:${index - 1}`,
    seq: index + 1,
    timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(),
    message,
  }));
}

/**
 * Script-aware token estimate for a whole transcript.
 *
 * This exists because the accurate signal (provider-reported usage) cannot be
 * the only one. Usage describes the *outgoing request*, which a plugin's
 * `transformContext` may legitimately shrink, and plenty of OpenAI-compatible
 * endpoints report no usage at all. In either case the kernel's own promise —
 * compact before the window fills — would silently depend on someone else's
 * behavior. Summing the loop's own messages cannot be depressed by either, so
 * it is the floor the promise stands on.
 *
 * CJK counts ~1 token per character, everything else ~4 chars per token. One
 * global chars/4 factor under-counts Chinese by roughly 4x, which would make
 * this floor useless for exactly the sessions that need it.
 */
export function estimateTranscriptTokens(messages: readonly AgentMessage[]): number {
  let cjk = 0;
  let other = 0;
  for (const message of messages) {
    for (const char of messageText(message)) {
      const code = char.codePointAt(0) ?? 0;
      if (isCjk(code)) cjk += 1;
      else other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/** Textual payload of a message: plain-string content or its text blocks. */
function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const value = (block as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0x2eff], // CJK radicals
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // kana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // fullwidth forms
];

function isCjk(code: number): boolean {
  for (const [from, to] of CJK_RANGES) {
    if (code >= from && code <= to) return true;
  }
  return false;
}

/**
 * Build the `prepareNextTurn` hook.
 *
 * Contract (per Pi's `AgentLoopConfig.prepareNextTurn`):
 *   - Must not throw. Return undefined when nothing is warranted.
 *   - When a runtime switch is pending (model / thinking level), return it as
 *     `model` / `thinkingLevel`. No context change is involved.
 *   - When compaction is warranted, return an `AgentLoopTurnUpdate` whose
 *     `context.messages` is the post-compaction transcript. The agent loop
 *     uses that for the next LLM request.
 *
 * Trigger policy:
 *   - Pending runtime switches are returned first, unconditionally — they are
 *     operator actions, not a consequence of context pressure.
 *   - Read the completed turn's own provider-reported usage
 *     (`calculateContextTokens`), falling back to the persisted watermark
 *     (`usage.getLastContextTokens()`). Both are the same provider-side signal.
 *   - Compact when it exceeds `min(cap, window - RESERVE_TOKENS)`, **or** when
 *     the transcript's own script-aware estimate exceeds it. Two signals
 *     because either one can be unavailable: usage is per-request (so a
 *     plugin's view transform can shrink it) and is simply absent on endpoints
 *     that do not report it. The estimate is the floor. The window always
 *     clamps, including an explicitly configured cap: a trigger above the
 *     model's real window would fire after the failure it exists to prevent.
 *     Unknown window → the cap alone applies.
 *
 * Compaction modes:
 *   - **LLM-summary** (when `opts.compact` is provided): Pi's cut-point
 *     logic picks what to summarize vs retain, the subscription model
 *     writes a structured checkpoint summary, and the next turn sees
 *     [summary, ...retainedTail]. Quality degrades gracefully instead of
 *     losing everything between the dropped head and the kept tail.
 *   - **Truncate** (fallback / no runtime): hard-drop the oldest messages,
 *     keep the recent tail. The `COMPACTION` event payload carries
 *     `mode` so the UI can tell the two apart.
 *
 * Post-condition: the persisted event log is the source of truth. The
 * agent loop's in-memory `messages` is the only thing we replace here;
 * the JSONL log is untouched, so `replaySession()` on the next resume
 * still reconstructs the full history. Future runs resume from the
 * compacted in-memory state, not from a stale log.
 */
export function makePrepareNextTurn(opts: {
  sessionId: string;
  usage: UsageTracker;
  /** Trigger cap in tokens. The model's window still clamps it downward. */
  thresholdTokens?: number;
  /** The running model's context window, from the subscription's catalog
   *  entry (`buildModel(subscription).contextWindow`). Omitted/0 → the cap is
   *  used as-is. */
  contextWindow?: number | undefined;
  keepRecentMessages?: number;
  emitEvent: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  compact?: SummaryRuntime;
  /** Mid-session model switch: a non-null return replaces the loop's model
   *  from this turn on (consumed once — SessionManager clears its slot). */
  takeModelSwitch?: (() => Model<any> | null) | undefined;
  /** Mid-session thinking-level switch: same consume-once contract. */
  takeThinkingSwitch?: (() => ThinkingLevel | null) | undefined;
  /** Explicit operator request from /compact. Consumed once. */
  takeCompactionRequest?: (() => boolean) | undefined;
}): (ctx: PrepareNextTurnContext, signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined> {
  const cap =
    opts.thresholdTokens ??
    (Number.isFinite(Number(process.env.FORGE_COMPACTION_THRESHOLD))
      ? Number(process.env.FORGE_COMPACTION_THRESHOLD)
      : DEFAULT_COMPACTION_THRESHOLD);
  const contextWindow = opts.contextWindow ?? 0;
  // The window clamps any cap, including an operator-set one (Codex clamps its
  // own user-set limit the same way, at 90% of the window). RESERVE_TOKENS must
  // not swallow the window on a small model, hence the 25% floor.
  const windowLimit = contextWindow > 0
    ? Math.max(contextWindow - RESERVE_TOKENS, Math.round(contextWindow * 0.25))
    : null;
  const threshold = windowLimit === null ? cap : Math.min(cap, windowLimit);
  const keepRecent = opts.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  const keepRecentTokens = Number.isFinite(
    Number(process.env.FORGE_COMPACTION_KEEP_RECENT_TOKENS),
  )
    ? Number(process.env.FORGE_COMPACTION_KEEP_RECENT_TOKENS)
    : 20_000;

  return async (
    ctx: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> => {
    const debug = process.env.FORGE_DEBUG_COMPACTION === "1";
    // Timing note: Pi's emit pushes events without awaiting the consumer, so
    // the hook can fire BEFORE the runner's for-await has processed this
    // turn's message_end (and thus before usage.trackUsage ran). Read
    // the completed turn's own usage from the hook argument instead — it is
    // always present and timing-safe; the persisted usage tracker is the fallback.
    const lastTurnUsage = (ctx.message as { usage?: Usage } | undefined)?.usage;
    const lastTurnContext = lastTurnUsage
      ? calculateContextTokens(lastTurnUsage)
      : Number.NaN;
    const lastInput =
      Number.isFinite(lastTurnContext) && lastTurnContext > 0
        ? lastTurnContext
        : opts.usage.getLastContextTokens();
    if (debug) {
      console.error(`[compaction] hook fired: lastInput=${lastInput} threshold=${threshold} messages=${ctx.context.messages.length}`);
    }

    // --- Runtime switches (model / thinking level) ---
    // These are operator actions, not a consequence of context pressure, so
    // they are checked *before* the threshold early-return below and apply on
    // the next turn regardless of how full the context is. They previously
    // sat behind that early-return, so a mid-session switch did nothing until
    // the transcript happened to overflow — which made switching look broken.
    //
    // When a switch is pending we return it alone and let compaction wait a
    // turn: swapping the model invalidates the prompt cache anyway, so a
    // compaction decision taken against the old model's usage is worth
    // re-taking on the new one.
    const nextModel = opts.takeModelSwitch?.() ?? null;
    const nextThinking = opts.takeThinkingSwitch?.() ?? null;
    if (nextModel || nextThinking) {
      if (debug) {
        console.error(
          `[compaction] runtime switch: model=${(nextModel as { id?: string } | null)?.id ?? "-"} thinking=${nextThinking ?? "-"}`,
        );
      }
      // No context change — Pi keeps the transcript and swaps runtime state.
      const update: AgentLoopTurnUpdate = {};
      if (nextModel) update.model = nextModel;
      if (nextThinking) update.thinkingLevel = nextThinking;
      return update;
    }

    const forced = opts.takeCompactionRequest?.() ?? false;
    // Two signals, either one is enough. Usage is the accurate provider-side
    // number; the transcript estimate is the floor that neither a view
    // transform (a plugin may legitimately shrink the request) nor a silent
    // endpoint (usage omitted) can depress. The kernel's promise — compact
    // before the window fills — must not depend on either going well.
    const messages = ctx.context.messages;
    const transcriptTokens = estimateTranscriptTokens(messages);
    const overByUsage = lastInput !== null && lastInput > threshold;
    const overByEstimate = transcriptTokens > threshold;
    if (!forced && !overByUsage && !overByEstimate) {
      return undefined; // Below threshold on both signals — no compaction.
    }
    const trigger: "usage" | "estimate" = overByUsage ? "usage" : "estimate";
    if (debug) {
      console.error(
        `[compaction] compacting: trigger=${trigger} lastInput=${lastInput} transcriptEstimate=${transcriptTokens} threshold=${threshold} messages=${messages.length}`,
      );
    }

    // --- LLM-summary path ---
    // Note: keepRecentMessages bounds TRUNCATION only. Summary mode is
    // bounded by Pi's cut-point logic (keepRecentTokens) — even a short
    // transcript can be worth summarizing, and the retained tail never
    // drops below what Pi decides to keep.
    if (opts.compact) {
      try {
        const preparation = prepareCompaction(toVirtualEntries(messages), {
          enabled: true,
          reserveTokens: RESERVE_TOKENS,
          keepRecentTokens,
        });
        if (
          preparation.ok &&
          preparation.value &&
          // A split turn has an empty history set but a non-empty prefix to
          // summarize — compact() handles both branches.
          (preparation.value.messagesToSummarize.length > 0 ||
            preparation.value.turnPrefixMessages.length > 0)
        ) {
          // estimateContextTokens speaks AgentMessage natively; the
          // virtual chain does not model storage-assigned context fields.
          const prepValue = {
            ...preparation.value,
            tokensBefore: estimateContextTokens(messages).tokens,
          };
          // pi-ai's Models interface is only consumed via completeSimple in
          // the summarizer path — a one-method shim keeps us decoupled from
          // the full Models surface while reusing the subscription key.
          const modelsShim = {
            completeSimple: (model: unknown, aiContext: unknown, options: unknown) =>
              opts.compact!.completeSimple(model, aiContext, options),
          };
          // Pi 0.85.1's Context here is the run-context object (abortSignal
          // + telemetry value lookup), not the AgentContext. A minimal shim
          // with a no-op telemetry parent is all the summarizer consumes.
          const runtimeContext = {
            abortSignal: signal,
            value: () => undefined,
          };
          const result = await piCompact(
            prepValue,
            modelsShim as never,
            opts.compact.model as never,
            undefined, // customInstructions
            undefined, // thinkingLevel
            undefined, // retry policy — Pi's internal default applies
            undefined, // retry callbacks
            runtimeContext as never,
          );
          if (result.ok) {
            const summaryMessage: AgentMessage = {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    COMPACTION_SUMMARY_PREFIX +
                    result.value.summary +
                    COMPACTION_SUMMARY_SUFFIX,
                },
              ],
              timestamp: Date.now(),
            };
            const newMessages: AgentMessage[] = [
              summaryMessage,
              ...result.value.retainedTail,
            ];

            await opts
              .emitEvent("COMPACTION", {
            mode: "llm-summary",
            forced,
            trigger,
            transcriptTokens,
                beforeCount: messages.length,
                afterCount: newMessages.length,
                droppedCount: messages.length - newMessages.length,
                beforeTokens: lastInput,
                threshold,
                summaryChars: result.value.summary.length,
                retainedTail: result.value.retainedTail.length,
                contextMessages: newMessages,
              })
              .catch(() => {});

            return withTools(ctx, newMessages);
          }
        }
      } catch (err) {
        // Summary generation failed (network, provider error, abort) —
        // surface it and fall back to truncation below. Never break the loop.
        if (debug) {
          console.error("[compaction] llm-summary failed:", err);
        }
      }
      await opts.emitEvent("COMPACTION_FAILED", { mode: "llm-summary" }).catch(() => {});
    }

    // --- Truncate fallback ---
    if (messages.length <= keepRecent) {
      // Already short enough that further truncation would risk losing
      // the goal prompt; nothing meaningful to compact.
      return undefined;
    }
    const keptMessages = messages.slice(-keepRecent);
    const droppedCount = messages.length - keepRecent;

    await opts
      .emitEvent("COMPACTION", {
      mode: "truncate",
      forced,
      trigger,
      transcriptTokens,
        beforeCount: messages.length,
        afterCount: keptMessages.length,
        droppedCount,
        beforeTokens: lastInput,
        threshold,
        contextMessages: keptMessages,
      })
      .catch(() => {});

    return withTools(ctx, keptMessages);
  };
}

function withTools(ctx: PrepareNextTurnContext, messages: AgentMessage[]): AgentLoopTurnUpdate {
  const newContext: AgentContext = {
    systemPrompt: ctx.context.systemPrompt,
    messages,
  };
  // Preserve tools if the original context had them. exactOptionalPropertyTypes
  // forbids `tools: undefined` so we copy only when defined.
  if (ctx.context.tools !== undefined) {
    newContext.tools = ctx.context.tools;
  }
  return { context: newContext };
}
