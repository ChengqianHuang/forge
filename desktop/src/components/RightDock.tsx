import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
// xterm's structural CSS: without it the width-measure helper row renders
// inline as visible glyph garbage.
import "@xterm/xterm/css/xterm.css";
import { interactCapability, readCapability, setSessionPluginEnabled, streamCapability } from "../lib/api.ts";
import { store } from "../lib/store.ts";
import type {
  ConversationView,
  PluginCapabilitySnapshot,
  ReliabilityMetrics,
  WorkspaceFileDiff,
} from "../types.ts";
import { CapabilityHealthContent } from "./CapabilityHealthDialog.tsx";
import { GuardAuditContent } from "./GuardAuditDialog.tsx";
import { ReliabilityContent } from "./ReliabilityDialog.tsx";
import { WorkspaceChangesContent } from "./WorkspaceChangesDialog.tsx";

type WorkspaceDirEntryView = { name: string; type: "dir" | "file"; size: number | null };
type WorkspaceFileContentView = { path: string; kind: "text" | "binary"; content: string; bytes: number; truncated: boolean };

/**
 * Per-session right dock: a parked workspace column beside the
 * transcript. Tabs come from the session's active UI contributions — the same
 * plugin-driven set the session header exposes — and each renderer owns its
 * data. `push` presentation pushes the transcript narrower; layout (open,
 * tab, width) persists per session in localStorage.
 */

export const DOCK_MIN = 300;
export const DOCK_MAX_RATIO = 0.7;

export type DockState = { open: boolean; tab: string | null; width: number };

export function loadDockState(sessionId: string): DockState {
  try {
    const raw = localStorage.getItem(`forge.dock.v1.${sessionId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DockState>;
      if (typeof parsed.open === "boolean") {
        return {
          open: parsed.open,
          tab: typeof parsed.tab === "string" ? parsed.tab : null,
          width: typeof parsed.width === "number" && parsed.width >= DOCK_MIN ? parsed.width : 360,
        };
      }
    }
  } catch {
    // Corrupt layout state falls back to the default dock, never breaks the session view.
  }
  return { open: false, tab: null, width: 360 };
}

export function saveDockState(sessionId: string, state: DockState): void {
  try {
    localStorage.setItem(`forge.dock.v1.${sessionId}`, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (quota/private mode); dock still works in-memory.
  }
}

type DockRendererProps = {
  sessionId: string;
  pluginId: string;
  readAction?: string;
  conversation: ConversationView;
  capabilities: PluginCapabilitySnapshot;
  running: boolean;
  /** Transcript deep-link: the latest requested file path with an optional
   * #L24 / #L24-L30 line range (monotonic seq). */
  fileRequest?: { path: string; lineStart?: number; lineEnd?: number; seq: number } | null;
};

function WorkspaceChangesRenderer({ sessionId, pluginId, readAction, conversation }: DockRendererProps) {
  const changes = conversation.workspaceChanges;
  if (!changes) return <div className="dock-empty">还没有工作区变更投影。</div>;
  return (
    <WorkspaceChangesContent
      changes={changes}
      readDiff={readAction
        ? (path) => readCapability<WorkspaceFileDiff>(sessionId, pluginId, readAction, { path })
        : undefined}
    />
  );
}

function GuardAuditRenderer({ conversation }: DockRendererProps) {
  return <GuardAuditContent decisions={conversation.guardDecisions} />;
}

function ReliabilityRenderer({ sessionId, pluginId, readAction }: DockRendererProps) {
  const [metrics, setMetrics] = useState<ReliabilityMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    readCapability<ReliabilityMetrics>(sessionId, pluginId, readAction ?? "", {})
      .then((value) => {
        if (alive) setMetrics(value);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [sessionId, pluginId, readAction, reloadKey]);

  if (error) {
    return (
      <div className="dock-error-pane">
        <div className="reliability-error">{error}</div>
        <button className="btn btn-ghost btn-small" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
      </div>
    );
  }
  return <ReliabilityContent metrics={metrics} loading={loading} error={error} />;
}

function CapabilityHealthRenderer({ sessionId, capabilities, conversation, running }: DockRendererProps) {
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (pluginId: string, enabled: boolean) => {
    setBusyPluginId(pluginId);
    setError(null);
    try {
      await setSessionPluginEnabled(sessionId, pluginId, enabled);
      store.setState((current) => ({
        conversation: {
          ...current.conversation,
          pluginStates: {
            ...current.conversation.pluginStates,
            [pluginId]: { status: enabled ? "active" : "disabled" },
          },
        },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPluginId(null);
    }
  };

  return (
    <CapabilityHealthContent
      plugins={capabilities.plugins}
      states={conversation.pluginStates}
      lifecycle={conversation.pluginLifecycle}
      running={running}
      busyPluginId={busyPluginId}
      error={error}
      onToggle={(pluginId, enabled) => void toggle(pluginId, enabled)}
    />
  );
}

function dirnameOf(path: string): string {
  const normalized = path.replace(/^\.\//, "").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "." : normalized.slice(0, idx) || ".";
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Workspace file browser: lazy per-directory listing on the left, a bounded
 * preview below. Deep links from the transcript open the file's directory and
 * load its content. */
function WorkspaceFilesRenderer({ sessionId, pluginId, fileRequest }: DockRendererProps) {
  const [dir, setDir] = useState(".");
  const [entries, setEntries] = useState<WorkspaceDirEntryView[] | null>(null);
  const [file, setFile] = useState<WorkspaceFileContentView | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const lastSeq = useRef(-1);

  useEffect(() => {
    let alive = true;
    setListError(null);
    readCapability<{ path: string; entries: WorkspaceDirEntryView[] }>(sessionId, pluginId, "list", { path: dir })
      .then((result) => {
        if (alive) setEntries(result.entries);
      })
      .catch((err) => {
        if (alive) {
          setEntries(null);
          setListError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => { alive = false; };
  }, [sessionId, pluginId, dir]);

  const openFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    setFileError(null);
    setFile(null);
    try {
      setFile(await readCapability<WorkspaceFileContentView>(sessionId, pluginId, "read", { path }));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFile(false);
    }
  }, [sessionId, pluginId]);

  // Transcript deep links: navigate to the file's directory, load it, and
  // highlight + scroll to the requested line range if present.
  useEffect(() => {
    if (!fileRequest || fileRequest.seq === lastSeq.current) return;
    lastSeq.current = fileRequest.seq;
    const path = fileRequest.path.replace(/^\.\//, "");
    setDir(dirnameOf(path));
    setHighlight(
      fileRequest.lineStart !== undefined
        ? { start: fileRequest.lineStart, end: fileRequest.lineEnd ?? fileRequest.lineStart }
        : null,
    );
    void openFile(path);
  }, [fileRequest, openFile]);

  // After the highlighted file renders, bring the range into view.
  useEffect(() => {
    if (!file || !highlight) return;
    const el = previewRef.current?.querySelector(`[data-line="${highlight.start}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [file, highlight]);

  return (
    <div className="dock-files">
      <div className="dock-files-path">
        <code>{dir === "." ? "workspace" : dir}</code>
      </div>
      <div className="dock-files-list">
        {listError && <div className="dock-empty">{listError}</div>}
        {!entries && !listError && <div className="dock-empty">正在读取目录…</div>}
        {entries && dir !== "." && (
          <button className="dock-file-row" onClick={() => setDir(dirnameOf(dir))}>▸ ..</button>
        )}
        {entries?.map((entry) => (
          <button
            key={`${entry.type}:${entry.name}`}
            className="dock-file-row"
            data-type={entry.type}
            onClick={() => {
              if (entry.type === "dir") {
                setDir(dir === "." ? entry.name : `${dir}/${entry.name}`);
              } else {
                void openFile(dir === "." ? entry.name : `${dir}/${entry.name}`);
              }
            }}
          >
            <span className="dock-file-mark" aria-hidden="true">{entry.type === "dir" ? "▸" : ""}</span>
            <span className="dock-file-name">{entry.name}</span>
            <span className="dock-file-size">{formatSize(entry.size)}</span>
          </button>
        ))}
      </div>
      <div className="dock-files-preview">
        {loadingFile && <div className="dock-empty">正在读取文件…</div>}
        {fileError && <div className="plugin-error-note dock-files-error">{fileError}</div>}
        {file?.kind === "binary" && <div className="dock-empty">二进制文件不显示内容（{formatSize(file.bytes)}）。</div>}
        {file?.kind === "text" && highlight && (
          <>
            <div className="dock-file-head">
              <code>{file.path}</code>
              <span>{formatSize(file.bytes)}{file.truncated ? " · 已截断" : ""} · L{highlight.start}{highlight.end !== highlight.start ? `-L${highlight.end}` : ""}</span>
            </div>
            <div className="dock-file-content dock-file-numbered" ref={previewRef}>
              {file.content.split("\n").map((line, index) => (
                <div
                  key={index}
                  className="dock-file-line"
                  data-line={index + 1}
                  data-highlight={index + 1 >= highlight.start && index + 1 <= highlight.end || undefined}
                >
                  <span className="dock-file-line-no">{index + 1}</span>
                  <span className="dock-file-line-text">{line || " "}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {file?.kind === "text" && !highlight && (
          <>
            <div className="dock-file-head">
              <code>{file.path}</code>
              <span>{formatSize(file.bytes)}{file.truncated ? " · 已截断" : ""}</span>
            </div>
            <pre className="dock-file-content">{file.content}</pre>
          </>
        )}
      </div>
    </div>
  );
}

/** The dock's 终端 tab: a real pty (node-pty server-side) rendered with
 * xterm.js. The pty persists across UI reloads — the saved termId is the
 * reconnect handle; a dead one surfaces a restart affordance instead of a
 * silently dead pane. This is a USER surface, outside the guardrails by
 * design (same trust as the user's own terminal app). */
function TerminalRenderer({ sessionId, pluginId }: DockRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"boot" | "live" | "ended" | "error">("boot");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [restartSeq, setRestartSeq] = useState(0);

  useEffect(() => {
    let disposed = false;
    let cancelStream: (() => void) | null = null;
    let cleanupResize: (() => void) | null = null;
    let term: { dispose: () => void } | null = null;
    setStatus("boot");
    setErrorMessage(null);

    (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed || !containerRef.current) return;
        const xterm = new Terminal({
          fontSize: 11,
          // A concrete stack: xterm measures glyphs on canvas, where CSS var() is invalid.
          fontFamily: "ui-monospace, Menlo, Monaco, monospace",
          cursorBlink: true,
          theme: {
            background: "#111214",
            foreground: "#d6d6d6",
            cursor: "#6ea6ff",
          },
        });
        const fit = new FitAddon();
        xterm.loadAddon(fit);
        xterm.open(containerRef.current);
        term = xterm;
        try {
          fit.fit();
        } catch {
          // fit can throw on a zero-size container before layout settles;
          // the resize observer below fits again once real dimensions exist.
        }
        const cols = xterm.cols || 80;
        const rows = xterm.rows || 24;

        let termId = localStorage.getItem(`forge.terminal.v1.${sessionId}`) ?? "";
        if (!termId) {
          const created = await interactCapability<{ id: string }>(sessionId, pluginId, "create", { cols, rows });
          termId = created.id;
          localStorage.setItem(`forge.terminal.v1.${sessionId}`, termId);
        }

        xterm.onData((data) => void interactCapability(sessionId, pluginId, "input", { terminalId: termId, data }));

        const refit = () => {
          try {
            fit.fit();
            void interactCapability(sessionId, pluginId, "resize", { terminalId: termId, cols: xterm.cols, rows: xterm.rows });
          } catch {
            // Container not measurable yet; next resize event retries.
          }
        };
        const observer = new ResizeObserver(() => refit());
        observer.observe(containerRef.current);
        cleanupResize = () => observer.disconnect();

        cancelStream = streamCapability<{ type: "open" | "data" | "exit"; payload?: string }>(
          sessionId,
          pluginId,
          "output",
          { terminalId: termId },
          (frame) => {
            if (disposed) return;
            if (frame.type === "data") {
              setStatus("live");
              xterm.write(frame.payload ?? "");
            } else if (frame.type === "exit") {
              setStatus("ended");
            }
          },
          () => {
            // Stream ended (network or process gone). If nothing ever wrote,
            // the pty is dead — offer restart instead of a frozen pane.
            if (!disposed) setStatus((current) => (current === "live" ? "ended" : "ended"));
          },
        );
        setStatus("live");
      } catch (err) {
        if (!disposed) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      }
    })();

    return () => {
      disposed = true;
      cancelStream?.();
      cleanupResize?.();
      // Without this, React's double mount (StrictMode) stacks two renderers
      // in the same container and the pane shows glyph garbage.
      term?.dispose();
    };
  }, [sessionId, pluginId, restartSeq]);

  async function restart() {
    const saved = localStorage.getItem(`forge.terminal.v1.${sessionId}`);
    if (saved) {
      await interactCapability(sessionId, pluginId, "exit", { terminalId: saved }).catch(() => {});
      localStorage.removeItem(`forge.terminal.v1.${sessionId}`);
    }
    setRestartSeq((n) => n + 1);
  }

  return (
    <div className="dock-terminal">
      <div className="dock-terminal-bar">
        <span className="dock-terminal-title">会话终端</span>
        <span className="dock-tabs-spacer" />
        <button
          className={`dock-terminal-restart ${status === "ended" || status === "error" ? "is-attention" : ""}`}
          onClick={() => void restart()}
          title="结束当前 shell 并重新启动"
        >
          重启
        </button>
      </div>
      <div className="dock-terminal-body" ref={containerRef} data-status={status} />
      {status === "boot" && <div className="dock-terminal-overlay">正在连接终端…</div>}
      {status === "ended" && (
        <div className="dock-terminal-overlay">
          <span>终端已结束。</span>
          <button className="btn btn-ghost btn-small" onClick={() => void restart()}>重启</button>
        </div>
      )}
      {status === "error" && (
        <div className="dock-terminal-overlay">
          <span className="plugin-error-note">{errorMessage}</span>
          <button className="btn btn-ghost btn-small" onClick={() => void restart()}>重试</button>
        </div>
      )}
    </div>
  );
}

const DOCK_RENDERERS: Record<string, ComponentType<DockRendererProps>> = {
  "workspace-changes": WorkspaceChangesRenderer,
  "guard-audit": GuardAuditRenderer,
  reliability: ReliabilityRenderer,
  "capability-health": CapabilityHealthRenderer,
  "workspace-files": WorkspaceFilesRenderer,
  terminal: TerminalRenderer,
};

export function RightDock({
  sessionId,
  capabilities,
  conversation,
  running,
  tab,
  width,
  fileRequest,
  onTabChange,
  onWidthChange,
  onClose,
}: {
  sessionId: string;
  capabilities: PluginCapabilitySnapshot | null;
  conversation: ConversationView;
  running: boolean;
  tab: string | null;
  width: number;
  /** Latest transcript deep-link target, forwarded to the files renderer. */
  fileRequest?: { path: string; seq: number } | null;
  onTabChange: (tab: string) => void;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}) {
  // Tabs: every active plugin contribution that places itself in the dock —
  // `dock` surface tabs belong here natively, `session-header` tabs open here
  // from their header buttons.
  const tabs = (capabilities?.uiContributions ?? []).flatMap((contribution) => {
    if (contribution.surface !== "session-header" && contribution.surface !== "dock") return [];
    const plugin = capabilities?.plugins.find((candidate) => candidate.id === contribution.pluginId);
    const projected = conversation.pluginStates[contribution.pluginId]?.status ?? plugin?.status;
    if (projected === "disabled" || projected === "failed") return [];
    const Renderer = DOCK_RENDERERS[contribution.renderer];
    if (!Renderer) return [];
    return [{
      key: `${contribution.pluginId}:${contribution.id}`,
      renderer: contribution.renderer,
      label: contribution.label,
      Renderer,
      props: {
        sessionId,
        pluginId: contribution.pluginId,
        readAction: contribution.readAction,
        conversation,
        capabilities: capabilities!,
        running,
        fileRequest,
      },
    }];
  });
  const active = tabs.find((candidate) => candidate.renderer === tab) ?? tabs[0];

  // Width drag: pointer capture on the left edge handle, clamped.
  const draggingRef = useRef(false);
  const onDragStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }, []);
  const onDragMove = useCallback((event: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const max = Math.floor(window.innerWidth * DOCK_MAX_RATIO);
    const next = Math.min(Math.max(window.innerWidth - event.clientX, DOCK_MIN), Math.max(DOCK_MIN, max));
    onWidthChange(next);
  }, [onWidthChange]);
  const onDragEnd = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <aside className="right-dock" style={{ width }} data-open={true}>
      <div
        className="dock-drag-handle"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整工作区宽度"
      />
      <div className="dock-inner">
        <div className="dock-tabs" role="tablist" aria-label="会话工作区">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={active?.renderer === t.renderer}
              className="dock-tab"
              onClick={() => onTabChange(t.renderer)}
            >
              {t.label}
            </button>
          ))}
          <span className="dock-tabs-spacer" />
          <button className="dock-close" onClick={onClose} title="收起工作区" aria-label="收起工作区">✕</button>
        </div>
        {active ? (
          <div className="dock-body" role="tabpanel">
            <active.Renderer {...active.props} />
          </div>
        ) : (
          <div className="dock-empty">没有可用的检视面板。</div>
        )}
      </div>
    </aside>
  );
}
