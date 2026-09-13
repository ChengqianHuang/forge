import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import {
  evaluateToolCall,
  classifyCapabilities,
  isSafeBash,
  loadPolicy,
  defaultPolicyPath,
  summarizeInput,
} from "../guard/policy.ts";
import { journalFile } from "../guard/journal.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import type { GuardrailConfig } from "./types.ts";

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/** Resolved (instead of the awaited promise) when the abort signal fires. */
const ABORTED: unique symbol = Symbol("aborted");

/**
 * Race a promise against the abort signal, resolving with ABORTED on stop.
 * The hook owns Stop-responsiveness — it must not trust the approval relay
 * to observe the signal itself.
 */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(ABORTED);
      },
    );
  });
}

/**
 * Guard pipeline for every tool call, injected as Pi's beforeToolCall hook:
 * 1. capability policy (allow / ask / deny — same rules as the agent's bash)
 * 2. undo journal backup before any file mutation
 * 3. destructive deny terminates the session
 * 4. `ask` relays to the desktop approval dialog and blocks until decided
 */
export function makeBeforeToolCall(config: GuardrailConfig) {
  return async (
    ctx: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> => {
    const toolName = ctx.toolCall.name;
    const input = (ctx.args ?? (ctx.toolCall as { arguments?: unknown }).arguments ?? {}) as Record<
      string,
      unknown
    >;
    // Abort first: a Stop press must win over everything below, including a
    // pending approval wait (the "bash 卡死 + Stop 无效" bug — the hook used
    // to block for the full 5-minute approval timeout with no observer on
    // the signal, and the model's retry re-armed it forever).
    if (signal?.aborted) {
      await appendEvent(config.sessionId, "GUARD_DECISION", {
        decisionId: `${ctx.toolCall.id}:forge.core`,
        guardId: "forge.core",
        toolCallId: ctx.toolCall.id,
        toolName,
        capability: classifyCapabilities(toolName, input)[0] ?? "unknown",
        policyAction: "deny",
        effectiveAction: "deny",
        outcome: "aborted",
        basis: "user",
        approvalMode: config.approvalMode ?? "default",
        ruleId: null,
        reason: "aborted before policy evaluation",
        inputSummary: summarizeInput(toolName, input),
      }).catch(() => {});
      return { block: true, reason: "aborted by user", terminate: true };
    }

    // 1. Capability policy. Loaded fresh each call from the user's
    //    `guard.json` (falls back to the built-in default) so "Always allow"
    //    rules added mid-session take effect immediately. Calling loadPolicy()
    //    with no argument would silently use the built-in default and ignore
    //    the user's file.
    const decision = evaluateToolCall(loadPolicy(defaultPolicyPath()), toolName, input);
    const approvalMode = config.approvalMode ?? "default";
    const evidence = {
      decisionId: `${ctx.toolCall.id}:forge.core`,
      guardId: "forge.core",
      toolCallId: ctx.toolCall.id,
      toolName,
      capability: decision.capability,
      policyAction: decision.action,
      approvalMode,
      ruleId: decision.ruleId ?? null,
      reason: decision.reason,
      inputSummary: summarizeInput(toolName, input),
    };

    if (decision.action === "deny") {
      await appendEvent(config.sessionId, "GUARD_DECISION", {
        ...evidence,
        effectiveAction: "deny",
        outcome: "denied",
        basis: "policy",
      }).catch(() => {});
      await appendEvent(config.sessionId, "GUARD_BLOCKED", {
        toolCallId: ctx.toolCall.id,
        toolName,
        reason: decision.reason ?? "denied by policy",
      }).catch(() => {});
      return {
        block: true,
        reason: decision.reason ?? "denied by Forge guard policy",
        terminate: decision.terminate === true,
      };
    }

    // 1.5 Approval posture (session-level, live — see CompletionConfig).
    // "always" releases every ask; "default" whitelists safe read-only bash.
    // Deny decisions are NEVER relaxed: the destructive floor holds in every
    // mode, and explicit user allow-rules in guard.json still win (mode only
    // affects the built-in ask decisions).
    let action = decision.action;
    let basis = "policy";
    if (action === "ask" && approvalMode === "always") {
      action = "allow";
      basis = "approval-mode";
    } else if (
      action === "ask" &&
      approvalMode === "default" &&
      toolName === "bash" &&
      isSafeBash(input.command)
    ) {
      action = "allow";
      basis = "safe-readonly";
    }

    // 2. Undo journal backup before file mutation.
    if (
      (toolName === "write" || toolName === "edit") &&
      typeof input.path === "string" &&
      input.path.length > 0
    ) {
      await journalFile(config.undoRoot, config.workspace, input.path).catch(() => {});
    }

    // 3. `ask` → approval dialog, blocking with a hard timeout.
    if (action === "ask") {
      const requestId = ctx.toolCall.id;
      await appendEvent(config.sessionId, "GUARD_APPROVAL_REQUEST", {
        requestId,
        toolName,
      }).catch(() => {});
      const approved = await raceWithAbort(
        config.approval.request({
          requestId,
          sessionId: config.sessionId,
          toolName,
          input,
          timeoutMs: APPROVAL_TIMEOUT_MS,
        }),
        signal,
      );
      if (approved === ABORTED || signal?.aborted) {
        await appendEvent(config.sessionId, "GUARD_DECISION", {
          ...evidence,
          effectiveAction: "ask",
          outcome: "aborted",
          basis: "user",
        }).catch(() => {});
        return { block: true, reason: "aborted by user", terminate: true };
      }
      if (!approved) {
        await appendEvent(config.sessionId, "GUARD_DECISION", {
          ...evidence,
          effectiveAction: "ask",
          outcome: "rejected",
          basis: "user",
        }).catch(() => {});
        return { block: true, reason: "rejected by user" };
      }
      await appendEvent(config.sessionId, "GUARD_DECISION", {
        ...evidence,
        effectiveAction: "ask",
        outcome: "approved",
        basis: "user",
      }).catch(() => {});
      return undefined;
    }

    await appendEvent(config.sessionId, "GUARD_DECISION", {
      ...evidence,
      effectiveAction: action,
      outcome: "allowed",
      basis,
    }).catch(() => {});
    return undefined; // allow
  };
}
