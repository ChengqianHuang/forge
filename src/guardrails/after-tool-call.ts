import type {
  AfterToolCallContext,
  AfterToolCallResult,
} from "@earendil-works/pi-agent-core";
import { appendEvent } from "../core/persistence/event-log.ts";
import { StuckDetector } from "./stuck-detector.ts";
import type { GuardrailConfig } from "./types.ts";

/**
 * After-tool guardrail: stuck detection over the tool-call history. A stuck
 * pattern terminates the session immediately — burning budget on a loop is
 * the worst failure mode (the stuck guard is the other stopper).
 */
export function makeAfterToolCall(config: GuardrailConfig) {
  const stuckDetector = new StuckDetector();
  const emit = config.emitEvent ?? ((type, payload) => appendEvent(config.sessionId, type, payload));

  return async (
    ctx: AfterToolCallContext,
    _signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined> => {
    stuckDetector.track({
      toolName: ctx.toolCall.name,
      args: ctx.args ?? (ctx.toolCall as { arguments?: unknown }).arguments,
      result: ctx.result?.details,
      isError: ctx.isError,
    });

    const stuck = stuckDetector.check();
    if (stuck.isStuck) {
      await emit("STUCK_WARNING", {
        pattern: stuck.pattern,
        repetitions: stuck.repetitions,
      }).catch(() => {});
      // Record WHY the session is being killed on the session itself. Pi's
      // loop ends gracefully on terminate (no exception), so without this
      // the SessionManager settle path would mark a guardrail-killed run
      // as "completed" — misleading the UI and the audit trail.
      config.session.failureReason = `stuck detected: ${stuck.pattern} (${stuck.repetitions} repetitions)`;
      return { terminate: true };
    }

    return undefined;
  };
}
