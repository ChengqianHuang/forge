import { PluginRegistry } from "../registry.ts";
import { sessionCommandsPlugin } from "./session-commands.ts";
import { usagePlugin } from "./usage.ts";

export function createBuiltinPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(sessionCommandsPlugin);
  registry.register(usagePlugin);
  return registry;
}
