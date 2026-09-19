import { PluginRegistry } from "../registry.ts";
import { capabilityHealthPlugin } from "./capability-health.ts";
import { guardAuditPlugin } from "./guard-audit.ts";
import { reliabilityPlugin } from "./reliability.ts";
import { sessionCommandsPlugin } from "./session-commands.ts";
import { usagePlugin } from "./usage.ts";
import { workspaceChangesPlugin } from "./workspace-changes.ts";
import { workspaceFilesPlugin } from "./workspace-files.ts";

export function createBuiltinPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(sessionCommandsPlugin);
  registry.register(usagePlugin);
  registry.register(capabilityHealthPlugin);
  registry.register(guardAuditPlugin);
  registry.register(reliabilityPlugin);
  registry.register(workspaceChangesPlugin);
  registry.register(workspaceFilesPlugin);
  return registry;
}
