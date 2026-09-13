import { useState, type ComponentType } from "react";
import type { ConversationView, PluginCapabilitySnapshot } from "../types.ts";
import { WorkspaceChangesDialog } from "./WorkspaceChangesDialog.tsx";

type ActionProps = {
  label: string;
  conversation: ConversationView;
};

function WorkspaceChangesAction({ label, conversation }: ActionProps) {
  const [open, setOpen] = useState(false);
  const changes = conversation.workspaceChanges;
  if (!changes) return null;
  return (
    <>
      <button className="btn btn-ghost btn-small" onClick={() => setOpen(true)} title="Inspect current Git workspace changes">
        {label} {changes.supported ? changes.files.length : "—"}
      </button>
      {open && <WorkspaceChangesDialog changes={changes} onClose={() => setOpen(false)} />}
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
}: {
  capabilities: PluginCapabilitySnapshot | null;
  conversation: ConversationView;
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
        label={contribution.label}
        conversation={conversation}
      />,
    ];
  });
}
