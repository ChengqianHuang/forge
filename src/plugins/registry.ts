import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { multiplexHooks } from "./hook-multiplexer.ts";
import type {
  ForgePlugin,
  PluginCapabilitySnapshot,
  PluginHooks,
  PluginInstance,
  PluginManifest,
  PluginReadContext,
  PluginRuntimeDescriptor,
  PluginRuntimeStatus,
  PluginSessionContext,
  SlashCommandResult,
} from "./types.ts";

const DEFAULT_PLUGIN_TIMEOUT_MS = 5_000;

type PluginState = {
  manifest: PluginManifest;
  status: PluginRuntimeStatus;
  failurePhase?: string;
  failureReason?: string;
};

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

  constructor(private readonly timeoutMs = DEFAULT_PLUGIN_TIMEOUT_MS) {}

  register(plugin: ForgePlugin): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(plugin.manifest.id)) {
      throw new Error(`invalid plugin id: ${plugin.manifest.id}`);
    }
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`plugin already registered: ${plugin.manifest.id}`);
    }
    const actionIds = new Set<string>();
    for (const action of plugin.manifest.readActions ?? []) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(action.id) || actionIds.has(action.id)) {
        throw new Error(`invalid or duplicate read action: ${plugin.manifest.id}/${action.id}`);
      }
      actionIds.add(action.id);
    }
    if (actionIds.size > 0 && !plugin.read) {
      throw new Error(`plugin ${plugin.manifest.id} declares read actions without a read handler`);
    }
    for (const contribution of plugin.manifest.ui ?? []) {
      if (contribution.readAction && !actionIds.has(contribution.readAction)) {
        throw new Error(`UI contribution ${plugin.manifest.id}/${contribution.id} references unknown read action ${contribution.readAction}`);
      }
    }
    // `capabilities` is the key a host filters on when activating, while
    // `slashCommands` and `ui` are projected to consumers straight from the
    // manifest. Drift therefore has a user-visible consequence: a UI panel
    // projected for a plugin that never declared "ui" renders with no backing
    // capability, and a plugin claiming "ui" with no contribution claims a
    // surface that does not exist. Both directions are rejected here —
    // declaration and implementation must agree, because the manifest is what
    // the capability panel shows.
    //
    // What cannot be checked statically: "tool", "guardrail" and
    // "event-subscriber" contributions exist only after `activate()`, and
    // "slash-command" is legitimately declared by plugins that contribute
    // their commands at activation (the manifest array is optional). So this
    // guard covers the UI surface in both directions plus one side of
    // slash-command — not every capability word.
    const declared = new Set(plugin.manifest.capabilities);
    const hasUi = (plugin.manifest.ui?.length ?? 0) > 0;
    if (declared.has("ui") && !hasUi) {
      throw new Error(`plugin ${plugin.manifest.id} declares capability "ui" without a UI contribution`);
    }
    if (!declared.has("ui") && hasUi) {
      throw new Error(`plugin ${plugin.manifest.id} contributes UI without declaring the "ui" capability`);
    }
    if ((plugin.manifest.slashCommands?.length ?? 0) > 0 && !declared.has("slash-command")) {
      throw new Error(`plugin ${plugin.manifest.id} declares slash commands without the "slash-command" capability`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  async read(
    pluginId: string,
    actionId: string,
    input: Record<string, unknown>,
    context: PluginReadContext,
  ): Promise<unknown> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
    if (!plugin.manifest.readActions?.some((action) => action.id === actionId) || !plugin.read) {
      throw new Error(`unknown read action: ${pluginId}/${actionId}`);
    }
    const timeoutController = new AbortController();
    const signal = AbortSignal.any([context.signal, timeoutController.signal]);
    return within(
      Promise.resolve(plugin.read(actionId, input, { ...context, signal })),
      this.timeoutMs,
      `${pluginId}.read:${actionId}`,
      () => timeoutController.abort(new Error(`${pluginId}.read:${actionId} timed out`)),
    );
  }

  capabilities(status: PluginRuntimeStatus = "disposed"): PluginCapabilitySnapshot {
    const plugins = [...this.plugins.values()].map((plugin) => ({
      ...plugin.manifest,
      required: plugin.manifest.required === true,
      status,
    }));
    const slashCommands = plugins.flatMap((plugin) =>
      (plugin.slashCommands ?? []).map((command) => ({ ...command, pluginId: plugin.id })),
    );
    const uiContributions = plugins.flatMap((plugin) =>
      (plugin.ui ?? []).map((contribution) => ({ ...contribution, pluginId: plugin.id })),
    );
    return { plugins, slashCommands, uiContributions };
  }

  async activate(
    context: PluginSessionContext,
    options?: {
      capabilities?: ReadonlySet<string>;
      disabledPluginIds?: ReadonlySet<string>;
    },
  ): Promise<PluginHost> {
    const instances = new Map<string, PluginInstance>();
    const states = new Map<string, PluginState>();
    const commandOwners = new Map<string, string>();
    const toolOwners = new Map<string, string>();

    for (const plugin of this.plugins.values()) {
      if (
        options?.capabilities &&
        !plugin.manifest.capabilities.some((capability) => options.capabilities!.has(capability))
      ) continue;
      const initiallyDisabled =
        plugin.manifest.required !== true &&
        options?.disabledPluginIds?.has(plugin.manifest.id) === true;
      states.set(plugin.manifest.id, {
        manifest: plugin.manifest,
        status: initiallyDisabled ? "disabled" : "active",
      });
      let instance: PluginInstance | undefined;
      let activationTimedOut = false;
      let activation: Promise<PluginInstance> | undefined;
      try {
        const timeoutController = new AbortController();
        const pluginContext = {
          ...context,
          signal: AbortSignal.any([context.signal, timeoutController.signal]),
        };
        activation = Promise.resolve(plugin.activate(pluginContext));
        instance = await within(
          activation,
          this.timeoutMs,
          `${plugin.manifest.id}.activate`,
          () => {
            activationTimedOut = true;
            timeoutController.abort(new Error(`${plugin.manifest.id}.activate timed out`));
          },
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
        await context.emitEvent("PLUGIN_LOADED", {
          pluginId: plugin.manifest.id,
          version: plugin.manifest.version,
          status: initiallyDisabled ? "disabled" : "active",
          required: plugin.manifest.required === true,
        });
      } catch (error) {
        const state = states.get(plugin.manifest.id)!;
        state.status = "failed";
        state.failurePhase = "activate";
        state.failureReason = error instanceof Error ? error.message : String(error);
        // Activation is transactional at the plugin boundary. A plugin may
        // acquire resources before its contributions are validated (for
        // example, an MCP child process before a tool-name conflict is
        // discovered), so roll the partial instance back before continuing.
        if (instance?.dispose) {
          try {
            await within(
              Promise.resolve(instance.dispose()),
              this.timeoutMs,
              `${plugin.manifest.id}.activation-rollback`,
            );
          } catch (disposeError) {
            await context.emitEvent("PLUGIN_FAILED", {
              pluginId: plugin.manifest.id,
              required: plugin.manifest.required === true,
              phase: "activation-rollback",
              reason: disposeError instanceof Error ? disposeError.message : String(disposeError),
            }).catch(() => {});
          }
        }
        instances.delete(plugin.manifest.id);
        for (const [name, owner] of commandOwners) {
          if (owner === plugin.manifest.id) commandOwners.delete(name);
        }
        for (const [name, owner] of toolOwners) {
          if (owner === plugin.manifest.id) toolOwners.delete(name);
        }
        // Promise.race cannot cancel trusted in-process code. If activation
        // ignores the abort and resolves after the timeout, immediately
        // reclaim that late instance instead of leaking its resources.
        if (activationTimedOut && activation) {
          void activation.then(async (lateInstance) => {
            try {
              await within(
                Promise.resolve(lateInstance.dispose?.()),
                this.timeoutMs,
                `${plugin.manifest.id}.late-activation-dispose`,
              );
            } catch (lateError) {
              await context.emitEvent("PLUGIN_FAILED", {
                pluginId: plugin.manifest.id,
                required: plugin.manifest.required === true,
                phase: "late-activation-dispose",
                reason: lateError instanceof Error ? lateError.message : String(lateError),
              }).catch(() => {});
            }
          }).catch(() => {});
        }
        await context.emitEvent("PLUGIN_FAILED", {
          pluginId: plugin.manifest.id,
          required: plugin.manifest.required === true,
          phase: "activate",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return new PluginHost(context, instances, states, this.timeoutMs);
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
    private readonly states: Map<string, PluginState>,
    private readonly timeoutMs = DEFAULT_PLUGIN_TIMEOUT_MS,
  ) {
    for (const [id, state] of states) {
      if (state.status === "disabled") this.disabled.add(id);
      if (state.status === "failed") {
        this.disabled.add(id);
        this.failed.add(id);
      }
    }
  }

  capabilities(): PluginCapabilitySnapshot {
    const plugins: PluginRuntimeDescriptor[] = [...this.states.values()].map((state) => ({
      ...state.manifest,
      required: state.manifest.required === true,
      status: state.status,
      ...(state.failurePhase ? { failurePhase: state.failurePhase } : {}),
      ...(state.failureReason ? { failureReason: state.failureReason } : {}),
    }));
    const slashCommands = plugins.flatMap((plugin) =>
      (plugin.slashCommands ?? []).map((command) => ({ ...command, pluginId: plugin.id })),
    );
    const uiContributions = plugins.flatMap((plugin) =>
      (plugin.ui ?? []).map((contribution) => ({ ...contribution, pluginId: plugin.id })),
    );
    return { plugins, slashCommands, uiContributions };
  }

  tools(reservedNames: Iterable<string> = []): AgentTool<any>[] {
    const reserved = new Set(reservedNames);
    return [...this.instances.entries()].flatMap(([id, instance]) =>
      (instance.tools ?? [])
        .filter((tool) => !reserved.has(tool.name))
        .map((tool) => ({
          ...tool,
          execute: async (...args: Parameters<typeof tool.execute>) => {
            if (this.disposed || this.disabled.has(id)) throw new Error(`plugin ${id} is disabled for this session`);
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
      .filter(([, instance]) => instance.hooks)
      .map(([id, instance]) => ({ id, hooks: instance.hooks! }));
    return multiplexHooks(
      core,
      owners,
      (id, hook, error) => this.disable(id, String(hook), error),
      (id) => !this.disposed && !this.disabled.has(id),
      async (id, context, decision) => {
        await this.context.emitEvent("GUARD_DECISION", {
          decisionId: `${context.toolCall.id}:${id}`,
          guardId: id,
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          capability: "plugin",
          policyAction: "deny",
          effectiveAction: "deny",
          outcome: "denied",
          basis: "plugin",
          approvalMode: this.context.session.approvalMode,
          ruleId: id,
          reason: decision.reason ?? `blocked by ${id}`,
          inputSummary: "",
        }).catch(() => {});
      },
    );
  }

  async onAgentEvent(event: AgentEvent): Promise<void> {
    if (this.disposed) return;
    for (const [id, instance] of this.instances) {
      if (this.disabled.has(id) || !instance.onAgentEvent) continue;
      try {
        await within(Promise.resolve(instance.onAgentEvent(event)), this.timeoutMs, `${id}.onAgentEvent`);
      } catch (error) {
        await this.disable(id, "onAgentEvent", error);
      }
    }
  }

  async execute(commandLine: string): Promise<SlashCommandResult> {
    if (this.disposed) throw new Error("plugin host is disposed");
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
          this.timeoutMs,
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
      const state = this.states.get(id);
      if (state && state.status !== "failed") state.status = "disposed";
    }
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (this.disposed) throw new Error("plugin host is disposed");
    if (!this.instances.has(pluginId)) throw new Error(`plugin is not active in this session: ${pluginId}`);
    const state = this.states.get(pluginId)!;
    if (!enabled && state.manifest.required === true) {
      throw new Error(`plugin ${pluginId} is required and cannot be disabled`);
    }
    if (enabled) {
      if (this.failed.has(pluginId)) {
        throw new Error(`plugin ${pluginId} failed and cannot be re-enabled in this session`);
      }
      if (!this.disabled.has(pluginId)) return;
      this.disabled.delete(pluginId);
      state.status = "active";
      await this.context.emitEvent("PLUGIN_ENABLED", {
        pluginId,
        required: state.manifest.required === true,
        reason: "enabled by user",
      });
    } else if (!this.disabled.has(pluginId)) {
      this.disabled.add(pluginId);
      state.status = "disabled";
      await this.context.emitEvent("PLUGIN_DISABLED", {
        pluginId,
        required: state.manifest.required === true,
        reason: "disabled by user",
      });
    }
  }

  private async disable(pluginId: string, phase: string, error: unknown): Promise<void> {
    if (this.disabled.has(pluginId)) return;
    this.disabled.add(pluginId);
    this.failed.add(pluginId);
    const state = this.states.get(pluginId);
    if (state) {
      state.status = "failed";
      state.failurePhase = phase;
      state.failureReason = error instanceof Error ? error.message : String(error);
    }
    await this.context.emitEvent("PLUGIN_FAILED", {
      pluginId,
      required: state?.manifest.required === true,
      phase,
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
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
      await within(
        Promise.resolve(instance.dispose?.()),
        this.timeoutMs,
        `${pluginId}.${phase}`,
      );
    } catch (error) {
      const state = this.states.get(pluginId);
      if (state) {
        state.status = "failed";
        state.failurePhase = phase;
        state.failureReason = error instanceof Error ? error.message : String(error);
      }
      await this.context.emitEvent("PLUGIN_FAILED", {
        pluginId,
        required: state?.manifest.required === true,
        phase,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
  }
}
