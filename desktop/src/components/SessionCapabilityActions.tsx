import { useState, type ComponentType } from "react";
import { readCapability } from "../lib/api.ts";
import type { ConversationView, PluginCapabilitySnapshot, ReliabilityMetrics, WorkspaceFileDiff } from "../types.ts";
import { GuardAuditDialog } from "./GuardAuditDialog.tsx";
import { ReliabilityDialog } from "./ReliabilityDialog.tsx";
import { WorkspaceChangesDialog } from "./WorkspaceChangesDialog.tsx";

type ActionProps = {
  sessionId: string;
  pluginId: string;
  label: string;
  readAction?: string;
  conversation: ConversationView;
};

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
  "guard-audit": GuardAuditAction,
  reliability: ReliabilityAction,
  "workspace-changes": WorkspaceChangesAction,
};

/** One stable desktop attachment point for compiled-in session actions. */
export function SessionCapabilityActions({
  capabilities,
  conversation,
  sessionId,
}: {
  capabilities: PluginCapabilitySnapshot | null;
  conversation: ConversationView;
  sessionId: string;
}) {
  return (capabilities?.uiContributions ?? []).flatMap((contribution) => {
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
      />,
    ];
  });
}
