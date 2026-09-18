import type { ComponentType } from "react";
import type { ConversationView, PluginCapabilitySnapshot } from "../types.ts";

type ActionProps = {
  label: string;
  conversation: ConversationView;
  capabilities: PluginCapabilitySnapshot;
  onOpen: () => void;
};

function CountAction({ label, conversation, capabilities, onOpen }: ActionProps) {
  const failed = capabilities.plugins.filter((plugin) =>
    (conversation.pluginStates[plugin.id]?.status ?? plugin.status) === "failed"
  ).length;
  return (
    <button className="btn btn-ghost btn-small" onClick={onOpen} title="Open in the session workspace">
      {label} {failed > 0 ? `!${failed}` : capabilities.plugins.length}
    </button>
  );
}

function CountOnlyAction({ label, conversation, onOpen }: ActionProps) {
  return (
    <button className="btn btn-ghost btn-small" onClick={onOpen} title="Open in the session workspace">
      {label} {conversation.guardDecisions.length}
    </button>
  );
}

function PlainAction({ label, onOpen }: ActionProps) {
  return (
    <button className="btn btn-ghost btn-small" onClick={onOpen} title="Open in the session workspace">
      {label}
    </button>
  );
}

function WorkspaceCountAction({ label, conversation, onOpen }: ActionProps) {
  const changes = conversation.workspaceChanges;
  if (!changes) return null;
  return (
    <button className="btn btn-ghost btn-small" onClick={onOpen} title="Open in the session workspace">
      {label} {changes.supported ? changes.files.length : "—"}
    </button>
  );
}

const RENDERERS: Record<string, ComponentType<ActionProps>> = {
  "capability-health": CountAction,
  "guard-audit": CountOnlyAction,
  reliability: PlainAction,
  "workspace-changes": WorkspaceCountAction,
};

/** Session-header openers for the right dock. The dock — not a modal — is the
 * single presentation surface for these contributions; each button focuses its
 * tab there. */
export function SessionCapabilityActions({
  capabilities,
  conversation,
  onOpenTab,
}: {
  capabilities: PluginCapabilitySnapshot | null;
  conversation: ConversationView;
  onOpenTab: (renderer: string) => void;
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
        label={contribution.label}
        conversation={conversation}
        capabilities={capabilities}
        onOpen={() => onOpenTab(contribution.renderer)}
      />,
    ];
  });
}
