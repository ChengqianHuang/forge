import type {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Session } from "../types.ts";

export type PluginCapability =
  | "slash-command"
  | "tool"
  | "guardrail"
  | "event-subscriber"
  | "ui"
  /** Stateful, user-initiated request/stream surfaces that may outlive a run. */
  | "interaction"
  /**
   * Stateless inspection surface: declared `readActions` plus a `read` handler.
   * Without a word for it, a plugin whose only contribution is read actions had
   * nothing to declare (its manifest read as "contributes nothing"), and a host
   * could neither ask for nor filter to that surface.
   */
  | "read-action";

/** One parameter of a plugin's manifest-driven config schema, deliberately
 * reduced to four wire-safe field types. */
export interface PluginConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  default: string | number | boolean;
  /** enum only; must be non-empty and contain the default. */
  options?: string[];
  description?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** One-line user-visible purpose, shown by the plugin manager page. */
  description?: string;
  /** Required capabilities are session substrate and cannot be paused. */
  required?: boolean;
  capabilities: PluginCapability[];
  slashCommands?: Array<{ name: string; description: string }>;
  ui?: PluginUiContribution[];
  readActions?: PluginReadActionDescriptor[];
  interactions?: PluginInteractionDescriptor[];
  /** Declared parameters; the manager UI renders forms straight from this. */
  configSchema?: PluginConfigField[];
}

export interface PluginReadActionDescriptor {
  id: string;
  description: string;
}

export interface PluginInteractionDescriptor {
  id: string;
  description: string;
  kind: "request" | "stream";
}

/** Compiled-in desktop contribution. The server declares placement and a
 * stable renderer key; the desktop owns the matching React implementation.
 * `session-header` contributes a header action that opens its dock tab;
 * `dock` contributes the dock tab itself. */
export interface PluginUiContribution {
  id: string;
  label: string;
  surface: "session-header" | "dock";
  renderer: string;
  readAction?: string;
}

export interface PluginReadContext {
  session: Session;
  signal: AbortSignal;
  /** Resolved per-plugin config (schema defaults ← user preferences). */
  config: Record<string, unknown>;
}

export type PluginInteractionContext = PluginReadContext;
export type PluginInteractionFrame = Record<string, unknown>;

export interface PluginSessionContext {
  session: Session;
  signal: AbortSignal;
  emitEvent: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  enqueueSteering: (message: AgentMessage) => void;
  requestCompaction: () => void;
}

export interface SlashCommandResult {
  message: string;
  tone?: "info" | "ok" | "warn";
}

export interface SlashCommand {
  name: string;
  description: string;
  execute: (args: string, context: PluginSessionContext) => Promise<SlashCommandResult> | SlashCommandResult;
}

export type PluginHooks = Partial<
  Pick<
    AgentLoopConfig,
    | "beforeToolCall"
    | "afterToolCall"
    | "shouldStopAfterTurn"
    | "getSteeringMessages"
    | "transformContext"
    | "prepareNextTurn"
  >
>;

export interface PluginInstance {
  tools?: AgentTool<any>[];
  hooks?: PluginHooks;
  slashCommands?: SlashCommand[];
  onAgentEvent?: (event: AgentEvent) => Promise<void> | void;
  services?: Record<string, unknown>;
  dispose?: () => Promise<void> | void;
}

export interface ForgePlugin {
  manifest: PluginManifest;
  /** `config` is the plugin's resolved configuration: schema defaults merged
   * with the user's persisted preferences, validated by the registry. */
  activate: (context: PluginSessionContext, config: Record<string, unknown>) => Promise<PluginInstance> | PluginInstance;
  /** Stateless, user-initiated inspection available after runtime disposal. */
  read?: (
    actionId: string,
    input: Record<string, unknown>,
    context: PluginReadContext,
  ) => Promise<unknown> | unknown;
  /** Stateful user action, dispatched through the generic capability route. */
  interact?: (
    actionId: string,
    input: Record<string, unknown>,
    context: PluginInteractionContext,
  ) => Promise<unknown> | unknown;
  /** Long-lived user stream. The returned function releases the subscription,
   * not necessarily the underlying resource. */
  subscribe?: (
    actionId: string,
    input: Record<string, unknown>,
    context: PluginInteractionContext,
    emit: (frame: PluginInteractionFrame) => void,
  ) => Promise<() => void> | (() => void);
  /** Release plugin-owned resources tied to a deleted session. */
  disposeSession?: (sessionId: string) => Promise<void> | void;
  /** Release plugin-owned platform resources during server shutdown. */
  dispose?: () => Promise<void> | void;
}

export type PluginRuntimeStatus = "active" | "disabled" | "failed" | "disposed";

export interface PluginRuntimeDescriptor extends PluginManifest {
  required: boolean;
  status: PluginRuntimeStatus;
  failurePhase?: string;
  failureReason?: string;
}

export interface PluginCapabilitySnapshot {
  plugins: PluginRuntimeDescriptor[];
  slashCommands: Array<{ name: string; description: string; pluginId: string }>;
  uiContributions?: Array<PluginUiContribution & { pluginId: string }>;
}

/**
 * Registration-time view for the global plugin manager page. Unlike
 * PluginRuntimeDescriptor it carries no session runtime semantics — only the
 * manifest, the user's global enablement preference, and the resolved config.
 */
export type PluginCatalogEntry = Omit<
  PluginRuntimeDescriptor,
  "status" | "failurePhase" | "failureReason"
> & {
  /** Where the plugin came from: compiled-in or `<forgeHome>/plugins`. */
  source: "builtin" | "external";
  userDisabled: boolean;
  config: Record<string, unknown>;
};
