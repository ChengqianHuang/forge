import type { ForgePlugin } from "../types.ts";

/** Required UI projection for durable core guard decisions. The safety hook
 * remains kernel-owned; this capability owns only their inspection surface. */
export const guardAuditPlugin: ForgePlugin = {
  manifest: {
    id: "forge.guard-audit",
    name: "Guard Audit",
    version: "1.0.0",
    required: true,
    capabilities: ["ui"],
    ui: [{
      id: "guard-audit",
      label: "审计",
      surface: "session-header",
      renderer: "guard-audit",
    }],
  },
  activate: () => ({}),
};
