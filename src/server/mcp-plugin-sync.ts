import { createMcpPlugin, McpStdioClient } from "../plugins/mcp.ts";
import type { ForgePlugin } from "../plugins/types.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { McpServerConfig } from "./config-store.ts";

type McpPluginFactory = (config: McpServerConfig) => ForgePlugin;

function defaultFactory(config: McpServerConfig): ForgePlugin {
  return createMcpPlugin({
    id: config.id,
    ...(config.name ? { name: config.name } : {}),
    createClient: () => new McpStdioClient(config.command, config.args, config.cwd, config.env),
  });
}

function fingerprint(config: McpServerConfig): string {
  return JSON.stringify({
    id: config.id,
    name: config.name ?? null,
    command: config.command,
    args: config.args,
    cwd: config.cwd ?? null,
    env: Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
}

/** Keeps the registration catalog aligned with persisted MCP settings.
 * Reconciliation never activates a plugin: live session hosts retain their
 * already-created client, while later activations see the new registration. */
export class McpPluginSync {
  private applied = new Map<string, McpServerConfig>();

  constructor(
    private readonly registry: PluginRegistry,
    private readonly factory: McpPluginFactory = defaultFactory,
  ) {}

  snapshot(): McpServerConfig[] {
    return [...this.applied.values()].map((config) => ({
      ...config,
      args: [...config.args],
      ...(config.env ? { env: { ...config.env } } : {}),
    }));
  }

  async reconcile(configs: readonly McpServerConfig[]): Promise<void> {
    this.validate(configs);
    const desired = new Map(
      configs.filter((config) => config.enabled).map((config) => [config.id, config]),
    );

    const previous = this.snapshot();
    try {
      await this.apply(desired);
    } catch (error) {
      await this.restore(previous).catch(() => {});
      throw error;
    }
  }

  validate(configs: readonly McpServerConfig[]): void {
    const enabled = configs.filter((config) => config.enabled);
    const ids = new Set(enabled.map((config) => config.id));
    if (ids.size !== enabled.length) throw new Error("duplicate enabled MCP server id");
    for (const id of ids) {
      const registered = this.registry.plugin(`mcp.${id}`);
      if (registered && !this.applied.has(id)) {
        throw new Error(`MCP plugin id conflicts with an existing capability: mcp.${id}`);
      }
    }
  }

  private async apply(desired: Map<string, McpServerConfig>): Promise<void> {
    const changed = new Set<string>();
    for (const [id, current] of this.applied) {
      const next = desired.get(id);
      if (!next || fingerprint(current) !== fingerprint(next)) changed.add(id);
    }

    for (const id of changed) {
      await this.registry.unregister(`mcp.${id}`);
      this.applied.delete(id);
    }

    for (const [id, config] of desired) {
      if (this.applied.has(id)) continue;
      this.registry.register(this.factory(config));
      this.applied.set(id, config);
    }
  }

  private async restore(configs: readonly McpServerConfig[]): Promise<void> {
    for (const id of [...this.applied.keys()]) {
      await this.registry.unregister(`mcp.${id}`).catch(() => {});
    }
    this.applied.clear();
    for (const config of configs) {
      this.registry.register(this.factory(config));
      this.applied.set(config.id, config);
    }
  }
}
