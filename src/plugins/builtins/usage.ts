import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ForgePlugin } from "../types.ts";
import { UsageTracker } from "../../guardrails/usage-tracker.ts";

/** Token accounting is a required session capability, not loop policy. */
export const usagePlugin: ForgePlugin = {
  manifest: {
    id: "forge.usage",
    name: "Usage meter",
    version: "1.0.0",
    required: true,
    // Only "event-subscriber" is true: activate() contributes a session
    // service and an agent-event subscriber, and nothing else. It used to
    // claim "guardrail" (no hooks) and "ui" (no UI contribution, no read
    // action) — the token meter the user sees is a kernel component, not this
    // plugin's surface. The session service has no word in PluginCapability,
    // so it is not declared at all.
    capabilities: ["event-subscriber"],
  },
  activate(context) {
    const tracker = new UsageTracker();
    tracker.hydrate(context.session.usage);
    return {
      services: { usage: tracker },
      async onAgentEvent(event: AgentEvent) {
        if (event.type !== "message_end") return;
        const message = event.message as { role?: string; usage?: Parameters<UsageTracker["trackUsage"]>[0] };
        if (message.role !== "assistant" || !message.usage) return;
        tracker.trackUsage(message.usage);
        const snapshot = tracker.snapshot();
        context.session.usage = snapshot;
        await context.emitEvent("USAGE_UPDATE", {
          tokensIn: snapshot.tokensIn,
          tokensOut: snapshot.tokensOut,
          cacheRead: snapshot.cacheRead,
          cacheWrite: snapshot.cacheWrite,
          contextTokens: snapshot.lastContextTokens,
        });
      },
    };
  },
};
