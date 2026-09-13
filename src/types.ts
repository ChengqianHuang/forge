import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

export type SessionStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Approval posture for mutating tool calls (bash / git / network).
 * - "ask": every one asks (the pre-v0.3e behavior).
 * - "default": safe read-only commands are whitelisted through (ls, cat,
 *   git status, ...); everything else asks.
 * - "always": nothing asks. The destructive floor (sudo, rm -rf /, ...) is
 *   NOT relaxed — deny rules still terminate the session.
 */
export type ApprovalMode = "ask" | "default" | "always";

/**
 * Reasoning effort, re-exported from Pi so the string set cannot drift.
 * `"off"` means no reasoning parameter is sent at all — see agent-loop.ts,
 * which maps it to `reasoning: undefined` on the outgoing request.
 */
export type { ThinkingLevel };

/**
 * The single data model of the new architecture. The conversation IS the
 * task: messages carry the full history (including tool calls and results),
 * so there is no Plan, no PlanStep, no Observation.
 */
export interface Session {
  id: string;
  goal: string;
  workspace: string;
  projectId: string | null;
  model: { provider: string; modelId: string };
  /** Runtime projection of JSONL message history; never persisted in session JSON. */
  messages: AgentMessage[];
  status: SessionStatus;
  failureReason: string | null;
  /** Cumulative token usage + context watermark (persisted; hydrates UsageTracker on resume). */
  usage: SessionUsage;
  approvalMode: ApprovalMode;
  /**
   * Reasoning effort sent with every provider request. Persisted since
   * schema v6 and switchable mid-session (POST /sessions/:id/thinking).
   */
  thinkingLevel: ThinkingLevel;
  createdAt: number;
  updatedAt: number;
}

/** Cumulative token usage for a session (fed from assistant-message usage). */
export interface SessionUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Latest assistant turn's context size — the compaction watermark. */
  lastContextTokens: number | null;
}
