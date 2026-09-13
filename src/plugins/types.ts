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
  | "ui";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Required capabilities are session substrate and cannot be paused. */
  required?: boolean;
  capabilities: PluginCapability[];
  slashCommands?: Array<{ name: string; description: string }>;
  ui?: PluginUiContribution[];
}

/** Compiled-in desktop contribution. The server declares placement and a
 * stable renderer key; the desktop owns the matching React implementation. */
export interface PluginUiContribution {
  id: string;
  label: string;
  surface: "session-header";
  renderer: string;
}

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
  activate: (context: PluginSessionContext) => Promise<PluginInstance> | PluginInstance;
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
