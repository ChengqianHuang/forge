import {
  agentLoop,
  type AgentContext,
  type AgentLoopConfig,
  type AgentMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "./core/persistence/event-log.ts";
import { mapAgentEventToPersisted } from "./events/mapper.ts";
import { makeBeforeToolCall } from "./guardrails/before-tool-call.ts";
import { makeAfterToolCall } from "./guardrails/after-tool-call.ts";
import { makeTransformContext } from "./guardrails/transform-context.ts";
import { makePrepareNextTurn } from "./guardrails/compaction.ts";
import { makeShouldStopAfterTurn } from "./guardrails/should-stop-after-turn.ts";
import type { GuardrailConfig } from "./guardrails/types.ts";
import type { Session } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (m) =>
      m.role === "user" || m.role === "assistant" || (m as { role?: string }).role === "toolResult",
  );
}

function buildSystemPrompt(session: Session): string {
  return [
    "You are Forge's engineering agent working in the user's project.",
    `Working directory: ${session.workspace}`,
    "",
    "Use tools to read, write, edit files and run commands.",
    "When the goal is fully met, stop calling tools.",
  ].join("\n");
}

/**
 * Run Pi's agentLoop in-process with Forge guardrails injected as hooks.
 * Every event is consumed: mapped into the FIFO event log (persistence +
 * SSE source of truth), and usage is fed into the cost guard. Control-plane
 * events fan out from the event log to the in-process EventBus automatically
 * — see appendEvent().
 */
export async function runAgent(opts: {
  session: Session;
  model: Model<any>;
  guardrails?: GuardrailConfig;
  signal?: AbortSignal;
  /** LLM streaming function: Pi's streamSimple wrapped with the subscription key,
   *  or a scripted mock in smoke tests. */
  streamFn: Parameters<typeof agentLoop>[4];
  /** First prompt of this run. Defaults to the session goal — override with
   *  the follow-up message when continuing a completed session. */
  promptOverride?: string | undefined;
  /** Mid-session model switch: called at each turn boundary; a non-null
   *  return replaces the loop's model from that turn on (consumed once). */
  takeModelSwitch?: (() => Model<any> | null) | undefined;
  /** Reasoning effort for this run (persisted on the session). `"off"` sends
   *  no reasoning parameter. Ignored when the model has no reasoning support
   *  — see the gate on `config.reasoning` below. */
  thinkingLevel?: ThinkingLevel | undefined;
  /** Mid-session thinking switch: called at each turn boundary; a non-null
   *  return replaces the loop's reasoning level from that turn on. */
  takeThinkingSwitch?: (() => ThinkingLevel | null) | undefined;
  /** Called on every persisted agent event — the inactivity watchdog's
   *  progress signal. Absent in tests that don't care. */
  onActivity?: (() => void) | undefined;
}): Promise<Session> {
  const {
    session,
    model,
    guardrails,
    signal,
    streamFn,
    promptOverride,
    takeModelSwitch,
    thinkingLevel,
    takeThinkingSwitch,
    onActivity,
  } = opts;

  const tools = createCodingTools(session.workspace) ?? [];
  const context: AgentContext = {
    systemPrompt: buildSystemPrompt(session),
    messages: session.messages,
    tools,
  };

  const config: AgentLoopConfig = {
    model,
    convertToLlm: defaultConvertToLlm as AgentLoopConfig["convertToLlm"],
    transformContext: makeTransformContext(),
  };

  // Gate the reasoning level on the model's own capability flag. The adapters
  // translate `reasoning` into a provider parameter (Anthropic `thinking`,
  // OpenAI `reasoning.effort`, …); sending one to a model that does not
  // support it is a 400 waiting to happen. `"off"` means "send nothing",
  // identical to leaving the field undefined.
  if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
    config.reasoning = thinkingLevel;
  }

  if (guardrails) {
    config.beforeToolCall = makeBeforeToolCall(guardrails);
    config.afterToolCall = makeAfterToolCall(guardrails);
    config.shouldStopAfterTurn = makeShouldStopAfterTurn(guardrails);
    config.getSteeringMessages = async () => guardrails.steeringQueue.splice(0);
    // prepareNextTurn uses the real per-turn inputTokens (provider-reported)
    // rather than the character estimate in transformContext. transformContext
    // remains as a coarse last-resort guard for sessions without cost data.
    // The summary runtime reuses the subscription streamFn, so the summary
    // call rides on the same key without keys landing in persisted data.
    config.prepareNextTurn = makePrepareNextTurn({
      sessionId: session.id,
      usage: guardrails.usage,
      emitEvent: (type, payload) => appendEvent(session.id, type as Parameters<typeof appendEvent>[1], payload),
      takeModelSwitch,
      takeThinkingSwitch,
      compact: {
        model,
        completeSimple: async (m: unknown, context: unknown, options: unknown) => {
          const stream = (streamFn as (m: unknown, c: unknown, o: unknown) => { result(): Promise<unknown> })(
            m,
            context,
            options,
          );
          return await stream.result();
        },
      },
    });
  }

  const prompts: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: promptOverride ?? session.goal }],
      timestamp: Date.now(),
    },
  ];

  const stream = agentLoop(prompts, context, config, signal, streamFn);

  for await (const event of stream) {
    const mapped = mapAgentEventToPersisted(event);
    if (mapped) {
      await appendEvent(session.id, mapped.type, mapped.payload);
      onActivity?.();
    }
    // Usage tracking from assistant usage (authoritative per-message totals).
    if (event.type === "message_end" && guardrails) {
      const message = event.message as { role?: string; usage?: unknown };
      if (message.role === "assistant" && message.usage) {
        guardrails.usage.trackUsage(
          message.usage as Parameters<typeof guardrails.usage.trackUsage>[0],
        );
        const s = guardrails.usage.snapshot();
        await appendEvent(session.id, "USAGE_UPDATE", {
          tokensIn: s.tokensIn,
          tokensOut: s.tokensOut,
          cacheRead: s.cacheRead,
          cacheWrite: s.cacheWrite,
          contextTokens: s.lastContextTokens,
        });
      }
    }
  }

  // Pi's `agentLoop` returns `result()` as the *delta* (newMessages) — only
  // the prompt(s) we passed in plus any assistant/tool messages it produced
  // during this run. The initial `context.messages` (which on resume is the
  // replayed transcript) is NOT included. We concatenate to preserve the
  // full conversation.
  const newMessages = await stream.result();
  session.messages = [...session.messages, ...newMessages];
  return session;
}
