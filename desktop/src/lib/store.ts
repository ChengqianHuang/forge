import { create } from "zustand";
import { getCfg } from "./api.ts";
import { notifyTaskOutcome, outcomeFromTerminal } from "./notify.ts";
import { thinkingLabel } from "./thinking.ts";
import type {
  ApprovalRecordView,
  ConversationView,
  EventEnvelope,
  ProjectRecord,
  Session,
  ThinkingLevel,
  ApprovalMode,
  GuardDecisionView,
} from "../types.ts";

export interface DesktopState {
  sessions: Session[];
  activeSessionId: string | null;
  conversation: ConversationView;
  pendingApproval: ApprovalRecordView | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  theme: "dark" | "light";
  settingsOpen: boolean;
  /**
   * Registered projects + the active one. Lifted out of Sidebar-local state so
   * a new session is created against the project the user actually picked
   * (rather than whichever project the currently-open session belongs to).
   */
  projects: ProjectRecord[];
  activeProjectId: string | null;

  refreshSessions: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  select: (id: string | null) => void;
  createSession: (input: {
    goal: string;
    projectId?: string;
    providerId?: string;
    thinkingLevel?: ThinkingLevel;
    approvalMode?: ApprovalMode;
  }) => Promise<void>;
  steer: (message: string) => Promise<void>;
  command: (commandLine: string) => Promise<void>;
  abort: () => Promise<void>;
  resume: (message?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  approve: (requestId: string) => Promise<void>;
  deny: (requestId: string) => Promise<void>;
  toggleTheme: () => void;
  setSettingsOpen: (open: boolean) => void;
  resetConversation: () => void;
}

const emptyConversation = (): ConversationView => ({
  timeline: [],
  guardDecisions: [],
  usage: { tokensIn: 0, tokensOut: 0, contextTokens: null },
  providerId: null,
  approvalMode: null,
  modelId: null,
  thinkingLevel: null,
  pluginStates: {},
  pluginLifecycle: [],
  workspaceChanges: null,
});

let source: EventSource | null = null;
let approvalTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Highest `seq` folded for the selected session. The server replays the whole
 * log on every connect (no Last-Event-ID support), so an EventSource
 * auto-reconnect would otherwise re-append the entire transcript.
 */
let lastSeq = 0;
/** Fallback ids for entries the stream gives us no stable key for. */
let synthSeq = 0;

/** Extract renderable text (and whether reasoning started) from a Pi message. */
function readMessage(message: unknown): {
  role: "user" | "assistant" | null;
  text: string;
  hasThinking: boolean;
  /** Stable per-message key — Pi stamps every message, so replays dedupe. */
  stamp: string;
} {
  const m = message as { role?: string; content?: unknown; timestamp?: unknown } | undefined;
  if (!m || (m.role !== "user" && m.role !== "assistant")) {
    return { role: null, text: "", hasThinking: false, stamp: "" };
  }
  let text = "";
  let hasThinking = false;
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: unknown };
      if (b.type === "text") text += String(b.text ?? "");
      else if (b.type === "thinking") hasThinking = true;
    }
  }
  const stamp = typeof m.timestamp === "number" ? String(m.timestamp) : "";
  return { role: m.role, text, hasThinking, stamp: stamp || `s${++synthSeq}` };
}

type Timeline = ConversationView["timeline"];

/** Append, or update in place when an entry with the same id already exists. */
function upsert<T extends { id: string }>(items: T[], entry: T): T[] {
  const at = items.findIndex((item) => item.id === entry.id);
  if (at < 0) return [...items, entry];
  const out = [...items];
  out[at] = entry;
  return out;
}

/** Index of the trailing assistant entry that deltas should append to. */
function openAssistantIndex(timeline: Timeline): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]!;
    if (e.kind === "assistant") return e.streaming ? i : -1;
    if (e.kind === "user") return -1;
  }
  return -1;
}

/** Pure fold: event envelope → next view state. Exported so the stream reducer
 *  can be replayed against captured event logs (see preview.tsx). */
export function reduceEnvelope(state: DesktopState, env: EventEnvelope): Partial<DesktopState> {
  const conversation = { ...state.conversation };
  const payload = env.payload ?? {};
  // SSE frames carry seq/timestamp; a raw JSONL replay only has `at`.
  const stamp = env.seq ?? env.timestamp ?? env.at ?? Date.now();

  switch (env.type) {
    case "AGENT_RUN_STARTED":
      return {};

    case "MESSAGE_STARTED": {
      const { role, text, stamp: key } = readMessage(payload.message);
      if (role === "user") {
        // A steered message being consumed: drop the pending echo so the
        // real message (with its own stable id) takes over — no double bubble.
        conversation.timeline = conversation.timeline.filter(
          (e) => !(e.kind === "user" && e.pending && e.text === text),
        );
        // The prompt is already complete here; MESSAGE_ENDED only re-states it.
        conversation.timeline = upsert(conversation.timeline, {
          kind: "user",
          id: `m${key}`,
          text,
        });
      } else if (role === "assistant") {
        conversation.timeline = upsert(conversation.timeline, {
          kind: "assistant",
          id: `m${key}`,
          text: "",
          streaming: true,
          thinking: false,
        });
      }
      return { conversation };
    }

    case "TEXT_DELTA": {
      const delta = String(payload.delta ?? "");
      if (!delta) return {};
      const timeline = [...conversation.timeline];
      const at = openAssistantIndex(timeline);
      if (at < 0) {
        timeline.push({
          kind: "assistant",
          id: `t${++synthSeq}`,
          text: delta,
          streaming: true,
          thinking: false,
        });
      } else {
        const prev = timeline[at] as Extract<Timeline[number], { kind: "assistant" }>;
        timeline[at] = { ...prev, text: prev.text + delta, thinking: false };
      }
      conversation.timeline = timeline;
      return { conversation };
    }

    case "MESSAGE_ENDED": {
      const { role, text, stamp: key } = readMessage(payload.message);
      if (!role) return {};
      const id = `m${key}`;
      const existing = conversation.timeline.findIndex((e) => e.id === id);
      if (role === "assistant") {
        // Authoritative terminal text supersedes the streamed deltas.
        if (existing >= 0) {
          const timeline = [...conversation.timeline];
          timeline[existing] = {
            kind: "assistant",
            id,
            text,
            streaming: false,
            thinking: false,
          };
          conversation.timeline = timeline;
        } else {
          conversation.timeline = upsert(conversation.timeline, {
            kind: "assistant",
            id,
            text,
            streaming: false,
            thinking: false,
          });
        }
      } else {
        conversation.timeline = upsert(conversation.timeline, { kind: "user", id, text });
      }
      return { conversation };
    }

    case "SESSION_HISTORY_IMPORTED": {
      const messages = Array.isArray(payload.contextMessages) ? payload.contextMessages : [];
      for (const message of messages) {
        const { role, text, stamp: key } = readMessage(message);
        if (role === "user") {
          conversation.timeline = upsert(conversation.timeline, {
            kind: "user",
            id: `m${key}`,
            text,
          });
        } else if (role === "assistant") {
          conversation.timeline = upsert(conversation.timeline, {
            kind: "assistant",
            id: `m${key}`,
            text,
            streaming: false,
            thinking: false,
          });
        }
      }
      return { conversation };
    }

    // Reasoning-only update: surface that the model is working before any
    // text arrives, instead of leaving an empty bubble on screen.
    case "MESSAGE_UPDATED": {
      const { role, hasThinking } = readMessage(payload.message);
      if (role !== "assistant" || !hasThinking) return {};
      const at = openAssistantIndex(conversation.timeline);
      if (at < 0) return {};
      const prev = conversation.timeline[at] as Extract<Timeline[number], { kind: "assistant" }>;
      if (prev.thinking || prev.text) return {};
      const timeline = [...conversation.timeline];
      timeline[at] = { ...prev, thinking: true };
      conversation.timeline = timeline;
      return { conversation };
    }

    case "TOOL_CALL": {
      const toolCallId = String(payload.toolCallId ?? "");
      if (!toolCallId) return {};
      conversation.timeline = upsert(conversation.timeline, {
        kind: "tool",
        id: `tool-${toolCallId}`,
        toolCallId,
        toolName: String(payload.toolName ?? ""),
        args: payload.args,
        running: true,
      });
      return { conversation };
    }

    case "TOOL_RESULT": {
      const toolCallId = String(payload.toolCallId ?? "");
      if (!toolCallId) return {};
      const id = `tool-${toolCallId}`;
      const at = conversation.timeline.findIndex((e) => e.id === id);
      if (at < 0) {
        // Result without a matching call (partial replay) — still show it.
        conversation.timeline = upsert(conversation.timeline, {
          kind: "tool",
          id,
          toolCallId,
          toolName: String(payload.toolName ?? "tool"),
          args: payload.args,
          result: payload.result,
          isError: payload.isError === true,
          running: false,
        });
        return { conversation };
      }
      const timeline = [...conversation.timeline];
      timeline[at] = {
        kind: "tool",
        id,
        toolCallId,
        toolName: String((timeline[at] as Extract<Timeline[number], { kind: "tool" }>).toolName),
        args: (timeline[at] as Extract<Timeline[number], { kind: "tool" }>).args,
        result: payload.result,
        isError: payload.isError === true,
        running: false,
      };
      conversation.timeline = timeline;
      return { conversation };
    }

    case "COST_UPDATE":
      // Historical logs only — the dollar layer was removed 2026-09-11.
      return {};
    case "USAGE_UPDATE": {
      conversation.usage = {
        tokensIn: typeof payload.tokensIn === "number" ? payload.tokensIn : conversation.usage.tokensIn,
        tokensOut: typeof payload.tokensOut === "number" ? payload.tokensOut : conversation.usage.tokensOut,
        contextTokens:
          typeof payload.contextTokens === "number" ? payload.contextTokens : conversation.usage.contextTokens,
      };
      return { conversation };
    }

    case "STUCK_WARNING": {
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `stuck-${stamp}`,
        tone: "warn",
        icon: "⚠",
        text: `Stuck: ${String(payload.pattern ?? "unknown")} ×${Number(payload.repetitions ?? 0)} — the session was stopped to protect your budget.`,
      });
      return { conversation };
    }

    case "COMPACTION": {
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `compaction-${stamp}`,
        tone: "info",
        icon: "✦",
        text: `Context compacted (${String(payload.mode ?? "unknown")}) — older history was summarized into a checkpoint, so the model's view of this conversation changed.`,
      });
      return { conversation };
    }

    case "PLUGIN_OUTPUT": {
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `plugin-output-${stamp}`,
        tone: payload.tone === "ok" || payload.tone === "warn" ? payload.tone : "info",
        icon: "/",
        text: String(payload.message ?? ""),
      });
      return { conversation };
    }

    case "WORKSPACE_CHANGES": {
      const files = Array.isArray(payload.files)
        ? payload.files.flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const file = value as Record<string, unknown>;
            if (typeof file.path !== "string" || typeof file.status !== "string") return [];
            return [{
              path: file.path,
              ...(typeof file.previousPath === "string" ? { previousPath: file.previousPath } : {}),
              status: file.status,
              additions: typeof file.additions === "number" ? file.additions : null,
              deletions: typeof file.deletions === "number" ? file.deletions : null,
              preexisting: file.preexisting === true,
              changedDuringSession: file.changedDuringSession === true,
            }];
          })
        : [];
      conversation.workspaceChanges = {
        supported: payload.supported === true,
        repoRoot: typeof payload.repoRoot === "string" ? payload.repoRoot : null,
        phase: payload.phase === "current" ? "current" : "baseline",
        ...(payload.reason === "not-git" || payload.reason === "git-error" ? { reason: payload.reason } : {}),
        files,
      };
      return { conversation };
    }

    case "PLUGIN_LOADED":
    case "PLUGIN_ENABLED":
    case "PLUGIN_DISABLED": {
      const pluginId = String(payload.pluginId ?? "");
      if (!pluginId) return {};
      if (
        env.type === "PLUGIN_DISABLED" &&
        payload.reason !== "disabled by user" &&
        conversation.pluginStates[pluginId]?.status === "failed"
      ) return {};
      const status = env.type === "PLUGIN_DISABLED" || payload.status === "disabled"
        ? "disabled"
        : "active";
      conversation.pluginStates = {
        ...conversation.pluginStates,
        [pluginId]: { status },
      };
      const event = env.type === "PLUGIN_LOADED"
        ? "loaded"
        : env.type === "PLUGIN_ENABLED"
          ? "enabled"
          : "disabled";
      conversation.pluginLifecycle = upsert(conversation.pluginLifecycle, {
        id: `plugin-${env.type}-${pluginId}-${stamp}`,
        pluginId,
        event,
        status,
        required: typeof payload.required === "boolean" ? payload.required : null,
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        at: Number(env.timestamp ?? env.at ?? Date.now()),
      });
      return { conversation };
    }

    case "PLUGIN_FAILED": {
      const pluginId = String(payload.pluginId ?? "unknown");
      conversation.pluginStates = {
        ...conversation.pluginStates,
        [pluginId]: {
          status: "failed",
          failurePhase: String(payload.phase ?? "unknown"),
          failureReason: String(payload.reason ?? "unknown error"),
        },
      };
      const required = typeof payload.required === "boolean" ? payload.required : null;
      conversation.pluginLifecycle = upsert(conversation.pluginLifecycle, {
        id: `plugin-${env.type}-${pluginId}-${stamp}`,
        pluginId,
        event: "failed",
        status: "failed",
        required,
        phase: String(payload.phase ?? "unknown"),
        reason: String(payload.reason ?? "unknown error"),
        at: Number(env.timestamp ?? env.at ?? Date.now()),
      });
      const failureText = required === true
        ? `必需能力 ${pluginId} 失败，Forge 机制已降级：${String(payload.reason ?? "unknown error")}`
        : required === false
          ? `可选能力 ${pluginId} 已隔离，Agent 继续运行：${String(payload.reason ?? "unknown error")}`
          : `插件 ${pluginId} 已隔离：${String(payload.reason ?? "unknown error")}`;
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `plugin-failed-${stamp}`,
        tone: "warn",
        icon: "⚠",
        text: failureText,
      });
      return { conversation };
    }

    case "MODEL_CHANGED": {
      conversation.modelId = String(payload.modelId ?? "");
      if (typeof payload.providerId === "string") conversation.providerId = payload.providerId;
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `model-${stamp}`,
        tone: "info",
        icon: "⇄",
        text: `模型已切换为 ${String(payload.modelId ?? "unknown")} — 将在此会话后续的模型请求中使用；若当前任务在下一轮前结束，本次切换不会被使用。`,
      });
      return { conversation };
    }

    case "APPROVAL_MODE_CHANGED": {
      const mode = String(payload.approvalMode ?? "");
      if (mode === "ask" || mode === "default" || mode === "always") {
        conversation.approvalMode = mode;
        conversation.timeline = upsert(conversation.timeline, {
          kind: "notice",
          id: `approval-${stamp}`,
          tone: "info",
          icon: "✓",
          text:
            mode === "always"
              ? "审批改为「始终允许」—— 命令不再弹窗（破坏性命令仍被拒绝）。"
              : mode === "ask"
                ? "审批改为「每次询问」。"
                : "审批改为「默认」—— 白名单内的安全命令直接放行。",
        });
      }
      return { conversation };
    }

    case "THINKING_CHANGED": {
      const level = String(payload.thinkingLevel ?? "");
      conversation.thinkingLevel = level as ConversationView["thinkingLevel"];
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `thinking-${stamp}`,
        tone: "info",
        icon: "◐",
        text: `思考强度改为「${thinkingLabel(level)}」—— 从下一轮开始生效。`,
      });
      return { conversation };
    }

    case "SESSION_RESUMED": {
      const n = Number(payload.messagesRecovered ?? 0);
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `resumed-${stamp}`,
        tone: "ok",
        icon: "↻",
        text: `Resumed — recovered ${n} message${n === 1 ? "" : "s"} from the event log.`,
      });
      return { conversation };
    }

    case "SESSION_INTERRUPTED": {
      conversation.timeline = upsert(conversation.timeline, {
        kind: "notice",
        id: `interrupted-${stamp}`,
        tone: "warn",
        icon: "!",
        text: "Forge restarted before this run finished. The session is recoverable — press Resume to continue.",
      });
      return { conversation };
    }

    case "STEERING_QUEUED": {
      // A user steering message: echo it into the timeline immediately.
      // Before this, a steered message existed only in a server-side queue —
      // while the loop was busy (e.g. a long tool call) the text simply
      // vanished from the user's view, reading as "lost".
      const text = String(payload.message ?? "");
      if (!text) return {};
      conversation.timeline = upsert(conversation.timeline, {
        kind: "user",
        id: `steer-${stamp}`,
        text,
        pending: true,
      });
      return { conversation };
    }

    // The server's own approval-request event (session-manager emits this type;
    // it never packs the request into STEERING_QUEUED — that branch was dead).
    // Pulling here means the dialog shows as soon as the guard asks, instead
    // of waiting for the next 2.5s poll tick.
    case "GUARD_APPROVAL_REQUEST": {
      void pollApprovals();
      return {};
    }

    case "GUARD_DECISION": {
      const toolCallId = String(payload.toolCallId ?? "");
      const outcome = String(payload.outcome ?? "");
      if (!toolCallId || !["allowed", "approved", "rejected", "denied", "aborted"].includes(outcome)) {
        return {};
      }
      const decision: GuardDecisionView = {
        decisionId: String(payload.decisionId ?? `${toolCallId}:${payload.guardId ?? "forge.core"}`),
        guardId: String(payload.guardId ?? "forge.core"),
        toolCallId,
        toolName: String(payload.toolName ?? "unknown"),
        capability: String(payload.capability ?? "unknown"),
        policyAction: (payload.policyAction === "allow" || payload.policyAction === "deny" ? payload.policyAction : "ask"),
        effectiveAction: (payload.effectiveAction === "allow" || payload.effectiveAction === "deny" ? payload.effectiveAction : "ask"),
        outcome: outcome as GuardDecisionView["outcome"],
        basis: (["policy", "approval-mode", "safe-readonly", "user", "plugin"].includes(String(payload.basis))
          ? payload.basis
          : "policy") as GuardDecisionView["basis"],
        approvalMode: (payload.approvalMode === "ask" || payload.approvalMode === "always" ? payload.approvalMode : "default"),
        ruleId: typeof payload.ruleId === "string" ? payload.ruleId : null,
        reason: String(payload.reason ?? ""),
        inputSummary: String(payload.inputSummary ?? ""),
        at: Number(env.at ?? env.timestamp ?? Date.now()),
      };
      const existing = conversation.guardDecisions.findIndex((item) => item.decisionId === decision.decisionId);
      conversation.guardDecisions = existing < 0
        ? [...conversation.guardDecisions, decision]
        : conversation.guardDecisions.map((item, index) => index === existing ? decision : item);
      return { conversation };
    }

    // Terminal session events all refresh persisted state and approvals.
    case "SESSION_ENDED":
    case "SESSION_FAILED":
    case "SESSION_CANCELLED": {
      void store.getState().refreshSessions();
      void pollApprovals();
      return {};
    }

    default:
      return {};
  }
}

async function pollApprovals(): Promise<void> {
  const state = store.getState();
  if (!state.activeSessionId) return;
  try {
    const { fetchApprovals } = await import("./api.ts");
    const approvals = await fetchApprovals(state.activeSessionId);
    store.setState({ pendingApproval: approvals.length > 0 ? approvals[0]! : null });
  } catch {
    /* transient */
  }
}

/**
 * System-notify a session that just reached a terminal state — but only while
 * the window is hidden. With the window visible the outcome is already on
 * screen (timeline notice and sidebar status), so a
 * notification would be pure noise.
 */
function maybeNotifyOutcome(env: EventEnvelope): void {
  if (env.type !== "SESSION_ENDED" && env.type !== "SESSION_FAILED" && env.type !== "SESSION_CANCELLED") return;
  if (typeof document === "undefined" || !document.hidden) return;
  const state = store.getState();
  // The stream is opened per session, so the active id is the fallback when a
  // frame carries no session id (e.g. a raw log replay). `taskId` is the
  // pre-rename name found in older log lines.
  const id = String(env.sessionId ?? env.taskId ?? state.activeSessionId ?? "");
  const goal = state.sessions.find((s) => s.id === id)?.goal ?? "";
  if (!goal.trim()) return;
  notifyTaskOutcome(goal, outcomeFromTerminal(env.type, env.payload?.status));
}

export const store = create<DesktopState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  conversation: emptyConversation(),
  pendingApproval: null,
  connected: false,
  loading: false,
  error: null,
  theme: (localStorage.getItem("forge-theme") as "dark" | "light") || "dark",
  settingsOpen: false,
  projects: [],
  activeProjectId: null,

  refreshSessions: async () => {
    const { fetchSessions } = await import("./api.ts");
    try {
      const sessions = await fetchSessions();
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  refreshProjects: async () => {
    const { fetchProjects } = await import("./api.ts");
    try {
      const r = await fetchProjects();
      set({ projects: r.projects, activeProjectId: r.activeProjectId });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  selectProject: async (id) => {
    // Optimistic: the picker should feel instant; the server is the truth and
    // a failed POST reverts via refreshProjects() below. Never swallow the
    // error silently — that was the original bug.
    set({ activeProjectId: id, error: null });
    const { selectProject: apiSelect } = await import("./api.ts");
    try {
      await apiSelect(id);
      await get().refreshProjects();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      await get().refreshProjects();
    }
  },

  select: (id) => {
    if (source) {
      source.close();
      source = null;
    }
    if (approvalTimer) {
      clearInterval(approvalTimer);
      approvalTimer = null;
    }
    lastSeq = 0;
    set({
      activeSessionId: id,
      conversation: emptyConversation(),
      pendingApproval: null,
      error: null,
    });
    if (!id) return;

    // SSE tail: replays persisted events, then follows live appends.
    const { baseUrl, token } = getCfg();
    source = new EventSource(`${baseUrl}/sessions/${id}/stream?token=${encodeURIComponent(token)}`);
    source.onopen = () => set({ connected: true });
    source.onerror = () => set({ connected: false });
    source.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data) as EventEnvelope;
        // First frame is the protocol hello ({protocol: 1}) — no type. Every
        // other frame carries a PersistedEventType in `type` (TEXT_DELTA,
        // MESSAGE_ENDED, COMPACTION, ...). Unknown types fall through the
        // reducer's default branch harmlessly.
        if (!env.type) return;
        // Drop frames already folded — a reconnect replays from the start.
        const seq = env.seq === undefined ? null : Number(env.seq);
        if (seq !== null && Number.isFinite(seq)) {
          if (seq <= lastSeq) return;
          lastSeq = seq;
        }
        const partial = reduceEnvelope(get(), env);
        if (Object.keys(partial).length > 0) set(partial);
        maybeNotifyOutcome(env);
      } catch {
        /* skip malformed frames */
      }
    };

    // Approval dialogs while the session runs.
    approvalTimer = setInterval(() => void pollApprovals(), 2500);
    void pollApprovals();
  },

  createSession: async (input) => {
    const { createSession: create } = await import("./api.ts");
    set({ loading: true, error: null });
    try {
      const { sessionId } = await create(input);
      await get().refreshSessions();
      get().select(sessionId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  // Both steer and resume surface the failure in store.error and rethrow, so
  // the composer can keep the user's text instead of clearing it into the void.
  steer: async (message) => {
    const id = get().activeSessionId;
    if (!id || !message.trim()) return;
    const { steerSession } = await import("./api.ts");
    set({ error: null });
    try {
      await steerSession(id, message.trim());
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  command: async (commandLine) => {
    const id = get().activeSessionId;
    if (!id || !commandLine.trim()) return;
    const { executeSlashCommand } = await import("./api.ts");
    set({ error: null });
    try {
      await executeSlashCommand(id, commandLine.trim());
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  abort: async () => {
    const id = get().activeSessionId;
    if (!id) return;
    const { abortSession } = await import("./api.ts");
    await abortSession(id);
  },

  resume: async (message) => {
    const id = get().activeSessionId;
    if (!id) return;
    const { resumeSession } = await import("./api.ts");
    set({ error: null });
    try {
      await resumeSession(id, message);
      // SSE session_started will drive the running state; just nudge the
      // sessions list so the row's status badge updates.
      await get().refreshSessions();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  remove: async (id) => {
    const { deleteSession } = await import("./api.ts");
    await deleteSession(id);
    if (get().activeSessionId === id) get().select(null);
    await get().refreshSessions();
  },

  approve: async (requestId) => {
    const id = get().activeSessionId;
    if (!id) return;
    const { resolveApproval } = await import("./api.ts");
    await resolveApproval(id, requestId, "approve");
    set({ pendingApproval: null });
    void pollApprovals();
  },

  deny: async (requestId) => {
    const id = get().activeSessionId;
    if (!id) return;
    const { resolveApproval } = await import("./api.ts");
    await resolveApproval(id, requestId, "deny");
    set({ pendingApproval: null });
    void pollApprovals();
  },

  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    localStorage.setItem("forge-theme", next);
    set({ theme: next });
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  resetConversation: () => set({ conversation: emptyConversation() }),
}));

// Alias matching the previous hook name for minimal import churn.
export const useDesktopStore = store;
