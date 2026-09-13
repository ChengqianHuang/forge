import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PersistedEvent, PersistedEventType } from "../core/persistence/event-log.ts";
import { projectPluginCapabilities, userDisabledPluginIds } from "./state.ts";
import type { PluginCapabilitySnapshot } from "./types.ts";

function event(type: PersistedEventType, pluginId: string, payload: Record<string, unknown> = {}): PersistedEvent {
  return { id: `${type}-${pluginId}`, type, sessionId: "s1", at: 1, payload: { pluginId, ...payload } };
}

const catalog: PluginCapabilitySnapshot = {
  plugins: [
    { id: "required", name: "Required", version: "1", required: true, status: "disposed", capabilities: [] },
    { id: "optional", name: "Optional", version: "1", required: false, status: "disposed", capabilities: [] },
  ],
  slashCommands: [],
};

describe("plugin state projection", () => {
  test("persists only explicit user disable choices", () => {
    const events = [
      event("PLUGIN_DISABLED", "optional", { reason: "disabled by user" }),
      event("PLUGIN_FAILED", "required", { phase: "event", reason: "boom" }),
    ];
    assert.deepEqual([...userDisabledPluginIds(events)], ["optional"]);
    events.push(event("PLUGIN_ENABLED", "optional", { reason: "enabled by user" }));
    assert.deepEqual([...userDisabledPluginIds(events)], []);
  });

  test("reports disabled preferences, failures and disposed terminal resources", () => {
    const result = projectPluginCapabilities(catalog, [
      event("PLUGIN_LOADED", "required", { status: "active" }),
      event("PLUGIN_LOADED", "optional", { status: "active" }),
      event("PLUGIN_DISABLED", "optional", { reason: "disabled by user" }),
      event("PLUGIN_FAILED", "required", { phase: "onAgentEvent", reason: "boom" }),
      event("PLUGIN_DISABLED", "required", { reason: "failure in onAgentEvent" }),
    ]);
    assert.equal(result.plugins[0]?.status, "failed");
    assert.equal(result.plugins[0]?.failureReason, "boom");
    assert.equal(result.plugins[1]?.status, "disabled");
  });
});
