import type { PersistedEvent } from "../core/persistence/event-log.ts";
import type { PluginCapabilitySnapshot, PluginRuntimeDescriptor } from "./types.ts";

/** User choices survive resume; runtime failures deliberately do not. */
export function userDisabledPluginIds(events: readonly PersistedEvent[]): Set<string> {
  const disabled = new Set<string>();
  for (const event of events) {
    const pluginId = typeof event.payload.pluginId === "string" ? event.payload.pluginId : null;
    if (!pluginId) continue;
    if (event.type === "PLUGIN_DISABLED" && event.payload.reason === "disabled by user") {
      disabled.add(pluginId);
    } else if (
      event.type === "PLUGIN_ENABLED" ||
      (event.type === "PLUGIN_LOADED" && event.payload.reason === "enabled by user")
    ) {
      // The PLUGIN_LOADED branch keeps pre-PLUGIN_ENABLED logs compatible.
      disabled.delete(pluginId);
    }
  }
  return disabled;
}

/** Fold durable lifecycle facts into a snapshot for a session with no live host. */
export function projectPluginCapabilities(
  catalog: PluginCapabilitySnapshot,
  events: readonly PersistedEvent[],
): PluginCapabilitySnapshot {
  const states = new Map<string, PluginRuntimeDescriptor>(
    catalog.plugins.map((plugin) => [plugin.id, { ...plugin }]),
  );

  for (const event of events) {
    const pluginId = typeof event.payload.pluginId === "string" ? event.payload.pluginId : null;
    const plugin = pluginId ? states.get(pluginId) : undefined;
    if (!plugin) continue;
    if (event.type === "PLUGIN_LOADED") {
      plugin.status = event.payload.status === "disabled" ? "disabled" : "active";
      delete plugin.failurePhase;
      delete plugin.failureReason;
    } else if (event.type === "PLUGIN_ENABLED") {
      plugin.status = "active";
      delete plugin.failurePhase;
      delete plugin.failureReason;
    } else if (event.type === "PLUGIN_DISABLED") {
      // Older logs emitted PLUGIN_DISABLED immediately after PLUGIN_FAILED.
      // That was failure containment, not a durable user preference.
      if (event.payload.reason === "disabled by user" || plugin.status !== "failed") {
        plugin.status = "disabled";
      }
    } else if (event.type === "PLUGIN_FAILED") {
      plugin.status = "failed";
      plugin.failurePhase = String(event.payload.phase ?? "unknown");
      plugin.failureReason = String(event.payload.reason ?? "unknown error");
    }
  }

  // No host owns resources now. Preserve disabled preferences and the last
  // failure for inspection; otherwise report the truthful terminal state.
  for (const plugin of states.values()) {
    if (plugin.required && plugin.status === "disabled") plugin.status = "disposed";
    else if (plugin.status === "active") plugin.status = "disposed";
  }
  return { ...catalog, plugins: [...states.values()] };
}
