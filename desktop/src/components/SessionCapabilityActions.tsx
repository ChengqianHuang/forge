import { useState, type ComponentType } from "react";
import { readCapability } from "../lib/api.ts";
import type { ConversationView, PluginCapabilitySnapshot, WorkspaceFileDiff } from "../types.ts";
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

const RENDERERS: Record<string, ComponentType<ActionProps>> = {
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
