import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { readCapability, setSessionPluginEnabled } from "../lib/api.ts";
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

/**
 * Per-session right dock (DSH form): a parked workspace column beside the
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

const DOCK_RENDERERS: Record<string, ComponentType<DockRendererProps>> = {
  "workspace-changes": WorkspaceChangesRenderer,
  "guard-audit": GuardAuditRenderer,
  reliability: ReliabilityRenderer,
  "capability-health": CapabilityHealthRenderer,
};

export function RightDock({
  sessionId,
  capabilities,
  conversation,
  running,
  tab,
  width,
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
  onTabChange: (tab: string) => void;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}) {
  // Tabs mirror the session-header contributions of active plugins.
  const tabs = (capabilities?.uiContributions ?? []).flatMap((contribution) => {
    if (contribution.surface !== "session-header") return [];
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
      },
    }];
  });
  const active = tabs.find((t) => t.renderer === tab) ?? tabs[0];

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
