/** Mirror of the server-side Session model (src/types.ts) — keep in sync. */

export type SessionStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Reasoning effort, mirroring Pi's `ThinkingLevel` (pi-agent-core). `"off"`
 * sends no reasoning parameter at all. The levels a given model actually
 * supports are reported by the server per subscription — see
 * `ForgeConfigData.modelCapabilities`.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ApprovalMode = "ask" | "default" | "always";

export interface Session {
  id: string;
  goal: string;
  workspace: string;
  projectId: string | null;
  model: { provider: string; modelId: string };
  status: SessionStatus;
  failureReason: string | null;
  usage: SessionUsage;
  approvalMode: ApprovalMode;
  thinkingLevel: ThinkingLevel;
  createdAt: number;
  updatedAt: number;
}

/** Mirror of the server's SessionUsage (token counters + context watermark). */
export interface SessionUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  lastContextTokens: number | null;
}

import type { ProviderApi } from "./lib/protocols.ts";
export type { ProviderApi };

export interface ProviderConfig {
  id: string;
  api: ProviderApi;
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

export interface ForgeConfigData {
  version: number;
  providers: ProviderConfig[];
  defaultProviderId: string;
  /**
   * Derived by the server (never persisted): the thinking levels each
   * subscription's model actually supports, keyed by provider id. The picker
   * offers only these, so a level that would no-op is never shown. Optional
   * so a config from an older server still parses.
   */
  modelCapabilities?: Record<string, ThinkingLevel[]>;
  /** Derived by the server (never persisted): each model's context window, for the token meter. */
  modelContextWindows?: Record<string, number>;
  mcpServers?: Array<{
    id: string;
    name?: string;
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    enabled: boolean;
  }>;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastOpenedAt: number;
}

/** Persisted event envelope pushed over SSE (server event-stream protocol). */
export interface EventEnvelope {
  /** Monotonic per-session sequence number; absent in raw log files. */
  seq?: string;
  type: string;
  /** Session the event belongs to (present on persisted frames and log lines). */
  sessionId?: string;
  /** Legacy field name on log lines written before the 2026-09-12 rename. */
  taskId?: string;
  payload: {
    type?: string;
    id?: string;
    at?: number;
    [key: string]: unknown;
  };
  /** SSE frames stamp `timestamp`; the on-disk JSONL uses `at`. */
  at?: number;
  timestamp?: number;
}

/** Tool call as rendered in the conversation stream. */
export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  running: boolean;
}

export interface ApprovalRecordView {
  requestId: string;
  toolName: string;
  message: string;
  at: number;
}

export interface StuckWarningView {
  pattern: string;
  repetitions: number;
}

export interface GuardDecisionView {
  decisionId: string;
  guardId: string;
  toolCallId: string;
  toolName: string;
  capability: string;
  policyAction: "allow" | "ask" | "deny";
  effectiveAction: "allow" | "ask" | "deny";
  outcome: "allowed" | "approved" | "rejected" | "denied" | "aborted";
  basis: "policy" | "approval-mode" | "safe-readonly" | "user" | "plugin";
  approvalMode: ApprovalMode;
  ruleId: string | null;
  reason: string;
  inputSummary: string;
  at: number;
}

export interface PluginLifecycleView {
  id: string;
  pluginId: string;
  event: "loaded" | "enabled" | "disabled" | "failed";
  status: "active" | "disabled" | "failed";
  required: boolean | null;
  phase?: string;
  reason?: string;
  at: number;
}

/**
 * One entry in the session transcript.
 *
 * The server streams a strictly ordered event log (MESSAGE_STARTED →
 * TEXT_DELTA* → MESSAGE_ENDED, with TOOL_CALL interleaved), so the UI keeps a
 * single ordered timeline rather than parallel message/tool arrays — otherwise
 * tool calls lose their position and multi-turn prompts lose their order.
 */
export type TimelineEntry =
  | { kind: "user"; id: string; text: string; pending?: boolean }
  /** `thinking` is true while the model is emitting reasoning but no text yet. */
  | { kind: "assistant"; id: string; text: string; streaming: boolean; thinking: boolean }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      running: boolean;
    }
  /** Session-level marker rendered in place: compaction, resume, model switch. */
  | { kind: "notice"; id: string; tone: "info" | "ok" | "warn"; icon: string; text: string };

/** Reduced view state derived from the SSE event stream. */
export interface ConversationView {
  timeline: TimelineEntry[];
  /** Durable terminal decision for every guarded tool call. */
  guardDecisions: GuardDecisionView[];
  /** Cumulative token usage + context watermark (USAGE_UPDATE events). */
  usage: { tokensIn: number; tokensOut: number; contextTokens: number | null };
  /** Updated by MODEL_CHANGED events (mid-session model switch). */
  modelId: string | null;
  /** Provider id behind the effective model (authoritative picker key). */
  providerId: string | null;
  /** Updated by APPROVAL_MODE_CHANGED events (mid-session approval switch). */
  approvalMode: ApprovalMode | null;
  /** Updated by THINKING_CHANGED events (mid-session reasoning switch). */
  thinkingLevel: ThinkingLevel | null;
  /** Live plugin lifecycle state folded from PLUGIN_* events. */
  pluginStates: Record<string, {
    status: "active" | "disabled" | "failed" | "disposed";
    failurePhase?: string;
    failureReason?: string;
  }>;
  /** Ordered lifecycle facts folded from the same durable PLUGIN_* events. */
  pluginLifecycle: PluginLifecycleView[];
  /** Latest WORKSPACE_CHANGES projection from the optional built-in plugin. */
  workspaceChanges: WorkspaceChangesView | null;
}

export interface WorkspaceChangeView {
  path: string;
  previousPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  preexisting: boolean;
  changedDuringSession: boolean;
}

export interface WorkspaceChangesView {
  supported: boolean;
  repoRoot: string | null;
  phase: "baseline" | "current";
  reason?: "not-git" | "git-error";
  files: WorkspaceChangeView[];
}

export interface PluginCapabilitySnapshot {
  plugins: Array<{
    id: string;
    name: string;
    version: string;
    capabilities: string[];
    required: boolean;
    status: "active" | "disabled" | "failed" | "disposed";
    failurePhase?: string;
    failureReason?: string;
  }>;
  slashCommands: Array<{ name: string; description: string; pluginId: string }>;
  uiContributions?: Array<{
    id: string;
    label: string;
    surface: "session-header";
    renderer: string;
    readAction?: string;
    pluginId: string;
  }>;
}

export interface WorkspaceFileDiff {
  path: string;
  kind: "text" | "binary" | "empty";
  patch: string;
  truncated: boolean;
  bytes: number;
}

export interface ReliabilityMetrics {
  eventCount: number;
  wallMs: number;
  runs: { started: number; endedByPi: number; terminal: number };
  tools: {
    calls: number;
    results: number;
    errors: number;
    guarded: number;
    guardCoverage: number;
    unfinished: number;
    orphanResults: number;
  };
  approvals: { requested: number; resolved: number; pending: number; p95LatencyMs: number | null };
  cancellation: { requested: number; settled: number; p95LatencyMs: number | null };
  recovery: { interrupted: number; resumed: number; messagesRecovered: number };
  plugins: { failures: number };
  integrity: { healthy: boolean; violations: string[] };
}
