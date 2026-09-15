import type {
  AgentLoopTurnUpdate,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { PluginHooks } from "./types.ts";

type HookOwner = { id: string; hooks: PluginHooks };

/**
 * Fold Forge's mandatory hooks and optional plugin hooks into Pi's single
 * AgentLoopConfig callback slots. The core hook is always first: plugins can
 * add policy, never bypass the destructive floor or the write journal.
 */
export function multiplexHooks(
  core: PluginHooks,
  plugins: HookOwner[],
  onPluginError: (pluginId: string, hook: keyof PluginHooks, error: unknown) => Promise<void>,
  isPluginEnabled: (pluginId: string) => boolean = () => true,
  onPluginBlock?: (
    pluginId: string,
    context: BeforeToolCallContext,
    decision: BeforeToolCallResult,
  ) => Promise<void>,
): PluginHooks {
  const active = new Set(plugins.map((plugin) => plugin.id));
  const available = (name: keyof PluginHooks) =>
    plugins.filter(
      (plugin) => active.has(plugin.id)
        && isPluginEnabled(plugin.id)
        && typeof plugin.hooks[name] === "function",
    );
  const failed = async (owner: HookOwner, hook: keyof PluginHooks, error: unknown) => {
    active.delete(owner.id);
    await onPluginError(owner.id, hook, error);
  };

  const result: PluginHooks = {};

  if (core.beforeToolCall || available("beforeToolCall").length) {
    result.beforeToolCall = async (context, signal) => {
      const coreDecision = await core.beforeToolCall?.(context, signal);
      if (coreDecision?.block) return coreDecision;
      for (const owner of available("beforeToolCall")) {
        try {
          const decision = await owner.hooks.beforeToolCall!(context, signal);
          if (decision?.block) {
            await onPluginBlock?.(owner.id, context, decision);
            return decision;
          }
        } catch (error) {
          await failed(owner, "beforeToolCall", error);
        }
      }
      return coreDecision;
    };
  }

  if (core.afterToolCall || available("afterToolCall").length) {
    result.afterToolCall = async (context, signal) => {
      let merged = await core.afterToolCall?.(context, signal);
      for (const owner of available("afterToolCall")) {
        try {
          const patch = await owner.hooks.afterToolCall!(context, signal);
          if (patch) {
            const terminate = merged?.terminate === true || patch.terminate === true;
            merged = { ...merged, ...patch, ...(terminate ? { terminate: true } : {}) };
          }
        } catch (error) {
          await failed(owner, "afterToolCall", error);
        }
      }
      return merged;
    };
  }

  if (core.shouldStopAfterTurn || available("shouldStopAfterTurn").length) {
    result.shouldStopAfterTurn = async (context) => {
      if (await core.shouldStopAfterTurn?.(context)) return true;
      for (const owner of available("shouldStopAfterTurn")) {
        try {
          if (await owner.hooks.shouldStopAfterTurn!(context)) return true;
        } catch (error) {
          await failed(owner, "shouldStopAfterTurn", error);
        }
      }
      return false;
    };
  }

  if (core.getSteeringMessages || available("getSteeringMessages").length) {
    result.getSteeringMessages = async () => {
      const messages = [...(await core.getSteeringMessages?.() ?? [])];
      for (const owner of available("getSteeringMessages")) {
        try {
          messages.push(...(await owner.hooks.getSteeringMessages!()));
        } catch (error) {
          await failed(owner, "getSteeringMessages", error);
        }
      }
      return messages;
    };
  }

  if (core.transformContext || available("transformContext").length) {
    result.transformContext = async (messages, signal) => {
      let transformed = core.transformContext ? await core.transformContext(messages, signal) : messages;
      for (const owner of available("transformContext")) {
        try {
          transformed = await owner.hooks.transformContext!(transformed, signal);
        } catch (error) {
          await failed(owner, "transformContext", error);
        }
      }
      return transformed;
    };
  }

  if (core.prepareNextTurn || available("prepareNextTurn").length) {
    result.prepareNextTurn = async (context) => {
      let update: AgentLoopTurnUpdate | undefined = await core.prepareNextTurn?.(context);
      for (const owner of available("prepareNextTurn")) {
        try {
          const patch = await owner.hooks.prepareNextTurn!(context);
          if (patch) update = { ...update, ...patch };
        } catch (error) {
          await failed(owner, "prepareNextTurn", error);
        }
      }
      return update;
    };
  }

  return result;
}
