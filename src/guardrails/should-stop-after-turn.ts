import type {
  AgentMessage,
  ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import type { GuardrailConfig } from "./types.ts";

const MAX_RECOVERY = 3;

function steer(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

/**
 * The turn-boundary gatekeeper.
 *
 * PM, 2026-09-12: 模型是最强大脑 — the model's own "done" is the completion
 * signal. Client-side completion verification (trust levels, success
 * criteria, the deterministic evaluator, steer-back-on-fail) is retired
 * wholesale, and with it the monologue guard: its only trigger was the
 * steering that verification failures injected, so without verification it
 * could never fire.
 *
 * What remains is transparent error recovery (参考 Claude Code): truncated /
 * empty / API-error turns get steering retries (max 3 each) before anything
 * is surfaced — a transient provider hiccup must never kill a long-running
 * session. Everything else: the model stops → the run is done. The user's
 * Stop button and the stuck detection in afterToolCall remain the other
 * ways a run ends.
 */
export function makeShouldStopAfterTurn(config: GuardrailConfig) {
  const recoveryCounts = new Map<string, number>();

  return async (ctx: ShouldStopAfterTurnContext): Promise<boolean> => {
    const message = ctx.message;
    const stopReason = (message as { stopReason?: string }).stopReason ?? "";
    const content = (message as { content?: unknown }).content;

    // --- 1. Transparent error recovery (before anything else) ---
    if (stopReason === "error") {
      const count = (recoveryCounts.get("error") ?? 0) + 1;
      recoveryCounts.set("error", count);
      if (count <= MAX_RECOVERY) {
        const errText =
          (message as { errorMessage?: string }).errorMessage ?? "unknown API error";
        config.steeringQueue.push(
          steer(`A provider error occurred (${errText}). Assess the state and continue the task.`),
        );
        return false;
      }
      config.session.failureReason =
        (message as { errorMessage?: string }).errorMessage ?? "provider error after retries";
      return true; // recovery exhausted — surface to the user
    }

    if (stopReason === "length" || stopReason === "max_tokens") {
      const count = (recoveryCounts.get("truncated") ?? 0) + 1;
      recoveryCounts.set("truncated", count);
      if (count <= MAX_RECOVERY) {
        config.steeringQueue.push(
          steer("Your output was truncated. Continue exactly where you left off."),
        );
        return false;
      }
      // exhausted → let the stop happen, the model's partial state stands.
      return true;
    }

    const isEmpty =
      stopReason === "stop" &&
      (!Array.isArray(content) || content.length === 0 || (content as unknown[]).every((b) => !b));

    if (isEmpty) {
      // Rule 5.5: an empty stop is an error in disguise — recover it like one
      // instead of ending the run with a blank transcript.
      const count = (recoveryCounts.get("empty") ?? 0) + 1;
      recoveryCounts.set("empty", count);
      if (count <= MAX_RECOVERY) {
        config.steeringQueue.push(steer("Your response was empty. Try again."));
        return false;
      }
      config.session.failureReason = "empty response after retries";
      return true;
    }

    // --- 2. Model still working → keep going ---
    if (stopReason === "toolUse") {
      return false;
    }

    // --- 3. Model intends to stop → done (模型是最强大脑) ---
    return true;
  };
}
