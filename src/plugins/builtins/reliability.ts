import { readEvents } from "../../core/persistence/event-log.ts";
import { extractReliabilityMetrics } from "../../reliability/metrics.ts";
import type { ForgePlugin } from "../types.ts";

/** Event-derived harness diagnostics. This is a projection capability: it
 * owns no runtime state and never grades the model's result. */
export const reliabilityPlugin: ForgePlugin = {
  manifest: {
    id: "forge.reliability",
    name: "Harness Reliability",
    version: "1.0.0",
    required: true,
    capabilities: ["ui"],
    readActions: [{ id: "metrics", description: "Project harness reliability from the session event log" }],
    ui: [{
      id: "reliability",
      label: "诊断",
      surface: "session-header",
      renderer: "reliability",
      readAction: "metrics",
    }],
  },
  activate: () => ({}),
  async read(actionId, _input, context) {
    if (actionId !== "metrics") throw new Error(`unknown reliability action: ${actionId}`);
    if (context.signal.aborted) throw context.signal.reason;
    return extractReliabilityMetrics({
      events: await readEvents(context.session.id),
      sessionStatus: context.session.status,
    });
  },
};
