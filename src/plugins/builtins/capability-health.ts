import type { ForgePlugin } from "../types.ts";

/** Required inspection surface for capability lifecycle and failure isolation. */
export const capabilityHealthPlugin: ForgePlugin = {
  manifest: {
    id: "forge.capability-health",
    name: "Capability Health",
    version: "1.0.0",
    description: "能力生命周期与故障隔离的检视面板。",
    required: true,
    capabilities: ["ui"],
    ui: [{
      id: "capability-health",
      label: "能力",
      surface: "session-header",
      renderer: "capability-health",
    }],
  },
  activate: () => ({}),
};
