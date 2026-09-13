import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { multiplexHooks } from "./hook-multiplexer.ts";
import type {
  ForgePlugin,
  PluginCapabilitySnapshot,
  PluginHooks,
  PluginInstance,
  PluginSessionContext,
  SlashCommandResult,
} from "./types.ts";

const DEFAULT_PLUGIN_TIMEOUT_MS = 5_000;

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PluginRegistry {
  private readonly plugins = new Map<string, ForgePlugin>();

  register(plugin: ForgePlugin): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(plugin.manifest.id)) {
      throw new Error(`invalid plugin id: ${plugin.manifest.id}`);
    }
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`plugin already registered: ${plugin.manifest.id}`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  capabilities(): PluginCapabilitySnapshot {
    const plugins = [...this.plugins.values()].map((plugin) => ({ ...plugin.manifest, enabled: true }));
    const slashCommands = plugins.flatMap((plugin) =>
      (plugin.slashCommands ?? []).map((command) => ({ ...command, pluginId: plugin.id })),
    );
    return { plugins, slashCommands };
  }

  async activate(
    context: PluginSessionContext,
    options?: { capabilities?: ReadonlySet<string> },
  ): Promise<PluginHost> {
    const instances = new Map<string, PluginInstance>();
    const commandOwners = new Map<string, string>();
    const toolOwners = new Map<string, string>();

    for (const plugin of this.plugins.values()) {
      if (
        options?.capabilities &&
        !plugin.manifest.capabilities.some((capability) => options.capabilities!.has(capability))
      ) continue;
      let instance: PluginInstance | undefined;
      try {
        const timeoutController = new AbortController();
        const pluginContext = {
          ...context,
          signal: AbortSignal.any([context.signal, timeoutController.signal]),
        };
        instance = await within(
          Promise.resolve(plugin.activate(pluginContext)),
          DEFAULT_PLUGIN_TIMEOUT_MS,
          `${plugin.manifest.id}.activate`,
          () => timeoutController.abort(new Error(`${plugin.manifest.id}.activate timed out`)),
        );
        for (const command of instance.slashCommands ?? []) {
          if (commandOwners.has(command.name)) {
            throw new Error(`slash command /${command.name} conflicts with ${commandOwners.get(command.name)}`);
          }
        }
        for (const tool of instance.tools ?? []) {
          if (toolOwners.has(tool.name)) {
            throw new Error(`tool ${tool.name} conflicts with ${toolOwners.get(tool.name)}`);
          }
        }
        for (const command of instance.slashCommands ?? []) {
          commandOwners.set(command.name, plugin.manifest.id);
        }
        for (const tool of instance.tools ?? []) {
          toolOwners.set(tool.name, plugin.manifest.id);
        }
        instances.set(plugin.manifest.id, instance);
        await context.emitEvent("PLUGIN_LOADED", { pluginId: plugin.manifest.id, version: plugin.manifest.version });
      } catch (error) {
        // Activation is transactional at the plugin boundary. A plugin may
        // acquire resources before its contributions are validated (for
        // example, an MCP child process before a tool-name conflict is
        // discovered), so roll the partial instance back before continuing.
        if (instance?.dispose) {
          try {
            await instance.dispose();
          } catch (disposeError) {
            await context.emitEvent("PLUGIN_FAILED", {
              pluginId: plugin.manifest.id,
              phase: "activation-rollback",
              reason: disposeError instanceof Error ? disposeError.message : String(disposeError),
            }).catch(() => {});
          }
        }
        await context.emitEvent("PLUGIN_FAILED", {
          pluginId: plugin.manifest.id,
          phase: "activate",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return new PluginHost(context, instances);
  }
}

export class PluginHost {
  private readonly disabled = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly disposedInstances = new WeakSet<PluginInstance>();
  private disposed = false;

  constructor(
    private readonly context: PluginSessionContext,
    private readonly instances: Map<string, PluginInstance>,
  ) {}

  tools(reservedNames: Iterable<string> = []): AgentTool<any>[] {
    const reserved = new Set(reservedNames);
    return [...this.instances.entries()].flatMap(([id, instance]) =>
      this.disabled.has(id) ? [] : (instance.tools ?? [])
        .filter((tool) => !reserved.has(tool.name))
        .map((tool) => ({
          ...tool,
          execute: async (...args: Parameters<typeof tool.execute>) => {
            if (this.disabled.has(id)) throw new Error(`plugin ${id} is disabled for this session`);
            return tool.execute(...args);
          },
        })),
    );
  }

  service<T>(name: string): T | undefined {
    for (const [id, instance] of this.instances) {
      if (!this.disabled.has(id) && instance.services && name in instance.services) {
        return instance.services[name] as T;
      }
    }
    return undefined;
  }

  hooks(core: PluginHooks): PluginHooks {
    const owners = [...this.instances.entries()]
      .filter(([id, instance]) => !this.disabled.has(id) && instance.hooks)
      .map(([id, instance]) => ({ id, hooks: instance.hooks! }));
    return multiplexHooks(
      core,
      owners,
      (id, hook, error) => this.disable(id, String(hook), error),
      (id) => !this.disposed && !this.disabled.has(id),
    );
  }

  async onAgentEvent(event: AgentEvent): Promise<void> {
    for (const [id, instance] of this.instances) {
      if (this.disabled.has(id) || !instance.onAgentEvent) continue;
      try {
        await within(Promise.resolve(instance.onAgentEvent(event)), DEFAULT_PLUGIN_TIMEOUT_MS, `${id}.onAgentEvent`);
      } catch (error) {
        await this.disable(id, "onAgentEvent", error);
      }
    }
  }

  async execute(commandLine: string): Promise<SlashCommandResult> {
    const match = /^\/([a-z0-9_-]+)(?:\s+(.*))?$/i.exec(commandLine.trim());
    if (!match) throw new Error("command must start with /");
    const name = match[1]!.toLowerCase();
    const args = match[2] ?? "";
    for (const [id, instance] of this.instances) {
      if (this.disabled.has(id)) continue;
      const command = instance.slashCommands?.find((candidate) => candidate.name === name);
      if (!command) continue;
      try {
        const result = await within(
          Promise.resolve(command.execute(args, this.context)),
          DEFAULT_PLUGIN_TIMEOUT_MS,
          `${id}/${name}`,
        );
        await this.context.emitEvent("SLASH_COMMAND_INVOKED", { pluginId: id, command: name, args });
        await this.context.emitEvent("PLUGIN_OUTPUT", {
          pluginId: id,
          command: name,
          message: result.message,
          tone: result.tone ?? "info",
        });
        return result;
      } catch (error) {
        await this.disable(id, `/${name}`, error);
        throw error;
      }
    }
    throw new Error(`unknown slash command: /${name}`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Contributions are acquired in registration order, so release them in
    // reverse order. Each instance is disposed at most once even if it was
    // already torn down after a runtime failure.
    for (const [id, instance] of [...this.instances.entries()].reverse()) {
      await this.disposeInstance(id, instance, "dispose");
    }
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (this.disposed) throw new Error("plugin host is disposed");
    if (!this.instances.has(pluginId)) throw new Error(`plugin is not active in this session: ${pluginId}`);
    if (enabled) {
      if (this.failed.has(pluginId)) {
        throw new Error(`plugin ${pluginId} failed and cannot be re-enabled in this session`);
      }
      this.disabled.delete(pluginId);
      await this.context.emitEvent("PLUGIN_LOADED", { pluginId, reason: "enabled by user" });
    } else if (!this.disabled.has(pluginId)) {
      this.disabled.add(pluginId);
      await this.context.emitEvent("PLUGIN_DISABLED", { pluginId, reason: "disabled by user" });
    }
  }

  private async disable(pluginId: string, phase: string, error: unknown): Promise<void> {
    if (this.disabled.has(pluginId)) return;
    this.disabled.add(pluginId);
    this.failed.add(pluginId);
    await this.context.emitEvent("PLUGIN_FAILED", {
      pluginId,
      phase,
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    await this.context.emitEvent("PLUGIN_DISABLED", { pluginId, reason: `failure in ${phase}` }).catch(() => {});
    const instance = this.instances.get(pluginId);
    if (instance) await this.disposeInstance(pluginId, instance, "failure-cleanup");
  }

  private async disposeInstance(
    pluginId: string,
    instance: PluginInstance,
    phase: string,
  ): Promise<void> {
    if (this.disposedInstances.has(instance)) return;
    this.disposedInstances.add(instance);
    try {
      await instance.dispose?.();
    } catch (error) {
      await this.context.emitEvent("PLUGIN_FAILED", {
        pluginId,
        phase,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
  }
}
