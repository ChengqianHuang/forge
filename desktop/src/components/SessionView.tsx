import { useEffect, useRef, useState } from "react";
import { store } from "../lib/store.ts";
import { useModelCatalog } from "../lib/catalog.ts";
import {
  fetchPluginCapabilities,
  switchApprovalMode,
  switchModel,
  switchThinking,
} from "../lib/api.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SessionCapabilityActions } from "./SessionCapabilityActions.tsx";
import { ApprovalPanel } from "./ApprovalPanel.tsx";
import { groupTurns, isFoldable, summarizeFold } from "../lib/turns.ts";
import type { FoldableEntry } from "../lib/turns.ts";
import type {
  ApprovalMode,
  PluginCapabilitySnapshot,
  ThinkingLevel,
  TimelineEntry,
} from "../types.ts";

/** One-line argument summary for a tool row (the full JSON lives behind expand). */
function summarizeArgs(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
    const v = a[key];
    if (typeof v === "string" && v) return v;
  }
  const json = JSON.stringify(args ?? {});
  return json === "{}" ? "" : json;
}

function ToolRow({ entry }: { entry: Extract<TimelineEntry, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const state = entry.running ? "running" : entry.isError ? "error" : "ok";
  return (
    <div className={`tool tool-${state}`}>
      <button
        type="button"
        className="tool-line"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Collapse" : "Expand full arguments and result"}
      >
        <span className="tool-mark" aria-hidden="true">
          {entry.running ? "" : entry.isError ? "✕" : "✓"}
        </span>
        <span className="tool-name">{entry.toolName}</span>
        <span className="tool-arg">{summarizeArgs(entry.args)}</span>
        <span className="tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="tool-detail">
          {JSON.stringify({ args: entry.args, result: entry.result }, null, 2).slice(0, 4000)}
        </pre>
      )}
    </div>
  );
}

function Notice({ entry }: { entry: Extract<TimelineEntry, { kind: "notice" }> }) {
  return (
    <div className={`notice notice-${entry.tone}`}>
      <span className="notice-icon" aria-hidden="true">{entry.icon}</span>
      <span>{entry.text}</span>
    </div>
  );
}

/** Collapsed tool/notice run of one settled turn (DSH turn-process folding).
 * The user's prompt, the model's prose and warn notices render in place; this
 * bar stands where the run began and expands back to the original rows. */
function TurnFoldBar({ run, expanded, onToggle }: {
  run: FoldableEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { tools, notices, errors } = summarizeFold(run);
  const parts: string[] = [];
  if (tools > 0) parts.push(`${tools} 个工具调用${errors > 0 ? ` · ${errors} 个失败` : ""}`);
  if (notices > 0) parts.push(`${notices} 条通知`);
  return (
    <button type="button" className="turn-fold" onClick={onToggle} aria-expanded={expanded}>
      <span className="turn-fold-mark" aria-hidden="true">{errors > 0 ? "✕" : "✓"}</span>
      <span>{parts.join(" · ") || "过程"}</span>
      <span className="tool-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
    </button>
  );
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** Token usage meter — cumulative in/out plus the context watermark. */
function TokenMeter({
  usage,
  contextWindow,
}: {
  usage: { tokensIn: number; tokensOut: number; contextTokens: number | null };
  contextWindow: number | null;
}) {
  if (usage.tokensIn === 0 && usage.tokensOut === 0) return null;
  const ratio =
    contextWindow !== null && contextWindow > 0 && usage.contextTokens
      ? Math.min(usage.contextTokens / contextWindow, 1)
      : null;
  return (
    <span
      className="tok"
      data-tight={ratio !== null && ratio > 0.75 ? "true" : undefined}
      title={
        contextWindow !== null && usage.contextTokens !== null
          ? `Context ${usage.contextTokens} / ${contextWindow} tokens`
          : "Cumulative token usage"
      }
    >
      ↑{fmtK(usage.tokensIn)} ↓{fmtK(usage.tokensOut)}
      {usage.contextTokens !== null && (
        <span className="tok-ctx">
          {" "}· ctx {fmtK(usage.contextTokens)}
          {contextWindow !== null ? ` / ${fmtK(contextWindow)}` : ""}
        </span>
      )}
    </span>
  );
}

/** Empty transcript — the session exists but nothing has been produced yet. */
function EmptyConversation({ running }: { running: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-mark">◌</div>
      {running ? "Waiting for the agent's first output…" : "No messages yet for this session."}
    </div>
  );
}

export function SessionView({
  sessionId,
  goal,
  status,
  failureReason,
  modelId,
  providerId,
  approvalMode,
  thinkingLevel,
}: {
  sessionId: string;
  goal: string;
  status: string;
  failureReason: string | null;
  modelId: string;
  /** Session.model.provider — the picker's key (authoritative namespace). */
  providerId: string;
  approvalMode: ApprovalMode;
  thinkingLevel: ThinkingLevel;
}) {
  const conversation = store((s) => s.conversation);
  const connected = store((s) => s.connected);
  const error = store((s) => s.error);
  const steer = store((s) => s.steer);
  const command = store((s) => s.command);
  const abort = store((s) => s.abort);
  const resume = store((s) => s.resume);
  const pendingApproval = store((s) => s.pendingApproval);
  const [steerInput, setSteerInput] = useState("");
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeMessage, setResumeMessage] = useState("");
  const [pluginCapabilities, setPluginCapabilities] = useState<PluginCapabilitySnapshot | null>(null);
  const { providers, capabilities, contextWindows } = useModelCatalog();
  const running = status === "running";
  const resumable = status === "failed" || status === "cancelled";
  const canFollowUp = status === "completed";
  // MODEL_CHANGED events override the session's original model in the UI.
  const effectiveModelId = conversation.modelId ?? modelId;
  // The picker is keyed by PROVIDER id, and Session.model.provider is the
  // server's authority for it. Looking the provider up by modelId (the old
  // code) silently picked the first subscription whenever two share a model,
  // highlighting the wrong row and reading the wrong model's capabilities.
  const effectiveProviderId = conversation.providerId ?? providerId;
  // THINKING_CHANGED events do the same for the reasoning effort.
  const effectiveThinking: ThinkingLevel = conversation.thinkingLevel ?? thinkingLevel;
  // APPROVAL_MODE_CHANGED events do the same for the approval posture.
  const effectiveApprovalMode: ApprovalMode = conversation.approvalMode ?? approvalMode;
  // Levels the running model actually supports (server-derived).
  const thinkingLevels =
    (effectiveProviderId ? capabilities[effectiveProviderId] : undefined) ?? ["off"];
  // Context window of the running model, for the token meter.
  const contextWindow =
    effectiveProviderId !== null ? (contextWindows[effectiveProviderId] ?? null) : null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const pinnedRef = useRef(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Expansion memory for folded turns; keyed by the segment's first entry id.
  // SessionView is keyed by session id, so this resets on session switch.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  const toggleTurn = (id: string) =>
    setExpandedTurns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    let alive = true;
    void fetchPluginCapabilities(sessionId).then((value) => {
      if (alive) setPluginCapabilities(value);
    }).catch(() => {});
    return () => { alive = false; };
  }, [sessionId]);

  // Grow the composer with the content instead of reserving fixed rows.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [steerInput]);

  // Auto-follow the stream, but never yank the viewport if the user scrolled up.
  const tick = conversation.timeline.reduce(
    (n, e) => n + (e.kind === "user" || e.kind === "assistant" ? e.text.length : 1),
    conversation.timeline.length,
  );
  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [tick]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  };

  const onModelSwitch = async (nextProviderId: string) => {
    if (!nextProviderId || nextProviderId === effectiveProviderId) return;
    try {
      await switchModel(sessionId, nextProviderId);
    } catch (err) {
      console.error("model switch failed:", err);
    }
  };

  // Reasoning-effort switch: applied at the next turn boundary and echoed
  // back as THINKING_CHANGED.
  const onThinkingSwitch = async (level: ThinkingLevel) => {
    if (level === effectiveThinking) return;
    try {
      await switchThinking(sessionId, level);
    } catch (err) {
      console.error("thinking switch failed:", err);
    }
  };

  // Approval-posture switch: takes effect at the NEXT TOOL CALL (live), not
  // at a turn boundary — switching to 始终允许 should stop the popups now.
  const onApprovalSwitch = async (mode: ApprovalMode) => {
    if (mode === effectiveApprovalMode) return;
    try {
      await switchApprovalMode(sessionId, mode);
    } catch (err) {
      console.error("approval switch failed:", err);
    }
  };

  // One send path for all states: running steers the live loop, a completed
  // session continues as a follow-up (prompt = the message), and
  // failed/cancelled retries (message optional — empty retries the goal).
  const send = async () => {
    const text = steerInput.trim();
    try {
      if (text.startsWith("/")) {
        await command(text);
        setSteerInput("");
        return;
      }
      if (running || canFollowUp) {
        if (!text) return;
        await (running ? steer(text) : resume(text));
        setSteerInput("");
        return;
      }
      await resume(text || undefined);
      setSteerInput("");
    } catch {
      // store.error carries the message and the composer renders it; keep the
      // text in the box so a failed send is never a silent no-op.
    }
  };
  const canSend = running || canFollowUp ? !!steerInput.trim() : true;
  const placeholder = running
    ? "Steer the agent at the next turn boundary…"
    : canFollowUp
      ? "Reply to continue this conversation…"
      : "Describe what to change, or send an empty message to retry the task…";
  const sendLabel = running || canFollowUp ? "Send" : "Retry";
  const slashQuery = steerInput.startsWith("/") ? steerInput.slice(1).toLowerCase() : null;
  const slashSuggestions = slashQuery === null
    ? []
    : (pluginCapabilities?.slashCommands ?? []).filter((command) => {
      const plugin = pluginCapabilities?.plugins.find((item) => item.id === command.pluginId);
      const status = conversation.pluginStates[command.pluginId]?.status ?? plugin?.status;
      return status === "active" && command.name.startsWith(slashQuery);
    });

  return (
    <div className="session">
      <header className="session-head">
        <div className="session-head-inner">
          <h1 className="session-goal" title={goal}>{goal}</h1>
          <TokenMeter usage={conversation.usage} contextWindow={contextWindow} />
          <div className="head-actions">
            <SessionCapabilityActions
              sessionId={sessionId}
              capabilities={pluginCapabilities}
              conversation={conversation}
              running={running}
            />
            {resumable && (
              <button
                className="btn btn-primary btn-small"
                onClick={() => {
                  setResumeMessage("");
                  setResumeOpen(true);
                }}
                title="Resume this session from its event log"
              >
                Resume
              </button>
            )}
          </div>
        </div>
      </header>

      {resumeOpen && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setResumeOpen(false);
          }}
        >
          <div className="modal">
            <h3 className="modal-title">Resume session</h3>
            <p className="modal-text">
              The agent will continue from its event log. Optionally add a steering
              instruction (e.g. "also fix the failing tests").
            </p>
            <textarea
              className="composer-textarea"
              placeholder="Optional: e.g. also fix the failing tests"
              value={resumeMessage}
              onChange={(e) => setResumeMessage(e.target.value)}
              rows={3}
              style={{ width: "100%", marginBottom: 12 }}
            />
            <div className="modal-actions">
              <button className="btn btn-ghost btn-small" onClick={() => setResumeOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-small"
                onClick={async () => {
                  try {
                    await resume(resumeMessage.trim() || undefined);
                    setResumeOpen(false);
                  } catch {
                    // store.error renders in the composer; keep the modal open.
                  }
                }}
              >
                Resume
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="conversation-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="conversation-canvas">
          {conversation.timeline.length === 0 && <EmptyConversation running={running} />}

          {groupTurns(conversation.timeline, running).map((segment) => {
            const expanded = expandedTurns.has(segment.id);
            const collapse = segment.settled && !expanded;
            let barEmitted = false;
            return segment.entries.map((entry) => {
              // A collapsed settled turn replaces its whole tool/notice run
              // with one summary bar at the run's original position; expanding
              // (or the live turn of a running session) renders every row.
              if (collapse && isFoldable(entry)) {
                if (barEmitted) return null;
                barEmitted = true;
                return (
                  <TurnFoldBar
                    key={`${segment.id}:fold`}
                    run={segment.entries.filter(isFoldable)}
                    expanded={false}
                    onToggle={() => toggleTurn(segment.id)}
                  />
                );
              }
              if (entry.kind === "user") {
                return (
                  <article key={entry.id} className="entry entry-user">
                    <div className="bubble-user">{entry.text}</div>
                    {entry.pending && <span className="bubble-pending">已入队 · 下一轮送达</span>}
                  </article>
                );
              }
              if (entry.kind === "notice") return <Notice key={entry.id} entry={entry} />;
              if (entry.kind === "tool") {
                return (
                  <article key={entry.id} className="entry entry-tool">
                    <ToolRow entry={entry} />
                  </article>
                );
              }
              return (
                <article key={entry.id} className={`entry entry-agent${entry.streaming ? " is-streaming" : ""}`}>
                  {entry.thinking && !entry.text ? (
                    <div className="thinking">
                      <span className="thinking-dots" aria-hidden="true">
                        <i /><i /><i />
                      </span>
                      Thinking…
                    </div>
                  ) : (
                    <div className="md">
                      <Markdown text={entry.text} />
                    </div>
                  )}
                </article>
              );
            });
          })}

          {failureReason && (
            <div className="notice notice-warn">
              <span className="notice-icon" aria-hidden="true">✕</span>
              <span>Session failed: {failureReason}</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <footer className="composer-wrap">
        <div className="conversation-composer">
          {pendingApproval ? (
            <ApprovalPanel request={pendingApproval} />
          ) : (
          <div className="composer-box">
            {slashSuggestions.length > 0 && (
              <div className="slash-menu" role="listbox" aria-label="Slash commands">
                {slashSuggestions.map((command) => (
                  <button
                    type="button"
                    key={`${command.pluginId}:${command.name}`}
                    className="slash-item"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSteerInput(`/${command.name}`)}
                  >
                    <b>/{command.name}</b><span>{command.description}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              className="composer-ta"
              rows={1}
              placeholder={placeholder}
              disabled={!running && !resumable && !canFollowUp}
              value={steerInput}
              onChange={(e) => setSteerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) void send();
                }
              }}
            />
            <div className="composer-actions">
              <div className="composer-meta">
                <ModelPicker
                  providers={providers}
                  activeProviderId={effectiveProviderId ?? null}
                  activeModelLabel={effectiveModelId || undefined}
                  onSelectModel={(id) => void onModelSwitch(id)}
                  thinkingLevel={effectiveThinking}
                  thinkingLevels={thinkingLevels}
                  onSelectThinking={(level) => void onThinkingSwitch(level)}
                  approvalMode={effectiveApprovalMode}
                  onSelectApprovalMode={(mode) => void onApprovalSwitch(mode)}
                  placement="above"
                />
                {!connected && (
                  <span className="meta-item meta-warn" title="Live event stream is reconnecting…">
                    <span className="status-dot" data-tone="warn" />
                    连接中断，正在重连
                  </span>
                )}
                {error && (
                  <span className="meta-item meta-error" title={error}>
                    发送失败：{error}
                  </span>
                )}
              </div>
              {running ? (
                <button
                  className="btn btn-stop btn-small"
                  onClick={() => void abort()}
                  title="Stop the session"
                >
                  <span className="stop-square" aria-hidden="true" />
                  Stop
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-small"
                  onClick={() => void send()}
                  disabled={!canSend}
                  title="Enter to send · Shift+Enter for a new line"
                >
                  {sendLabel}
                  <span className="key-hint">↵</span>
                </button>
              )}
            </div>
          </div>
          )}
          <div className="composer-hint">
            <span><b>Enter</b> to send · <b>Shift+Enter</b> for a new line</span>
            {running && <span>Enter 发送引导 · <b>Stop</b> 按钮终止会话</span>}
            {!running && !canFollowUp && resumable && <span>Sending an empty message retries the goal</span>}
          </div>
        </div>
      </footer>
    </div>
  );
}
