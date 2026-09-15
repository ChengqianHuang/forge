import { useState, type ComponentType } from "react";
import { readCapability, setSessionPluginEnabled } from "../lib/api.ts";
import { store } from "../lib/store.ts";
import type { ConversationView, PluginCapabilitySnapshot, ReliabilityMetrics, WorkspaceFileDiff } from "../types.ts";
import { CapabilityHealthDialog } from "./CapabilityHealthDialog.tsx";
import { GuardAuditDialog } from "./GuardAuditDialog.tsx";
import { ReliabilityDialog } from "./ReliabilityDialog.tsx";
import { WorkspaceChangesDialog } from "./WorkspaceChangesDialog.tsx";

type ActionProps = {
  sessionId: string;
  pluginId: string;
  label: string;
  readAction?: string;
  conversation: ConversationView;
  capabilities: PluginCapabilitySnapshot;
  running: boolean;
};

function CapabilityHealthAction({ label, conversation, capabilities, running, sessionId }: ActionProps) {
  const [open, setOpen] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = capabilities.plugins.filter((plugin) =>
    (conversation.pluginStates[plugin.id]?.status ?? plugin.status) === "failed"
  ).length;

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
    <>
      <button className="btn btn-ghost btn-small" onClick={() => setOpen(true)} title="Inspect capability health and lifecycle">
        {label} {failed > 0 ? `!${failed}` : capabilities.plugins.length}
      </button>
      {open && (
        <CapabilityHealthDialog
          plugins={capabilities.plugins}
          states={conversation.pluginStates}
          lifecycle={conversation.pluginLifecycle}
          running={running}
          busyPluginId={busyPluginId}
          error={error}
          onToggle={(pluginId, enabled) => void toggle(pluginId, enabled)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function WorkspaceChangesAction({ sessionId, pluginId, label, readAction, conversation }: ActionProps) {
  const [open, setOpen] = useState(false);
  const changes = conversation.workspaceChanges;
  if (!changes) return null;
  return (
    <>
      <button className="btn btn-ghost btn-small" onClick={() => setOpen(true)} title="Inspect current Git workspace changes">
        {label} {changes.supported ? changes.files.length : "—"}
      </button>
      {open && (
        <WorkspaceChangesDialog
          changes={changes}
          onClose={() => setOpen(false)}
          readDiff={readAction
            ? (path) => readCapability<WorkspaceFileDiff>(sessionId, pluginId, readAction, { path })
            : undefined}
        />
      )}
    </>
  );
}

function GuardAuditAction({ label, conversation }: ActionProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-ghost btn-small" onClick={() => setOpen(true)} title="Inspect durable guard decisions">
        {label} {conversation.guardDecisions.length}
      </button>
      {open && <GuardAuditDialog decisions={conversation.guardDecisions} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReliabilityAction({ sessionId, pluginId, label, readAction }: ActionProps) {
  const [open, setOpen] = useState(false);
  const [metrics, setMetrics] = useState<ReliabilityMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inspect = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      if (!readAction) throw new Error("Reliability capability has no read action");
      setMetrics(await readCapability<ReliabilityMetrics>(sessionId, pluginId, readAction, {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button className="btn btn-ghost btn-small" onClick={() => void inspect()} title="Inspect event-derived harness reliability">
        {label}
      </button>
      {open && (
        <ReliabilityDialog
          metrics={metrics}
          loading={loading}
          error={error}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const RENDERERS: Record<string, ComponentType<ActionProps>> = {
  "capability-health": CapabilityHealthAction,
  "guard-audit": GuardAuditAction,
  reliability: ReliabilityAction,
  "workspace-changes": WorkspaceChangesAction,
};

/** One stable desktop attachment point for compiled-in session actions. */
export function SessionCapabilityActions({
  capabilities,
  conversation,
  sessionId,
  running,
}: {
  capabilities: PluginCapabilitySnapshot | null;
  conversation: ConversationView;
  sessionId: string;
  running: boolean;
}) {
  if (!capabilities) return [];
  return (capabilities.uiContributions ?? []).flatMap((contribution) => {
    if (contribution.surface !== "session-header") return [];
    const plugin = capabilities?.plugins.find((candidate) => candidate.id === contribution.pluginId);
    const projected = conversation.pluginStates[contribution.pluginId]?.status ?? plugin?.status;
    if (projected === "disabled" || projected === "failed") return [];
    const Renderer = RENDERERS[contribution.renderer];
    if (!Renderer) return [];
    return [
      <Renderer
        key={`${contribution.pluginId}:${contribution.id}`}
        sessionId={sessionId}
        pluginId={contribution.pluginId}
        label={contribution.label}
        readAction={contribution.readAction}
        conversation={conversation}
        capabilities={capabilities}
        running={running}
      />,
    ];
  });
}
