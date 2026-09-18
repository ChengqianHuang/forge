import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Durable user preferences for the plugin platform: which optional plugins
 * the user turned off globally, and the per-plugin config values they saved
 * in the manager page. Session-level enablement stays in the session event
 * log (see plugins/state.ts); this file only holds the global layer that a
 * NEW session's activation merges in.
 */
export type PluginPreferences = {
  disabled: string[];
  config: Record<string, Record<string, unknown>>;
};

const EMPTY: PluginPreferences = { disabled: [], config: {} };

export function pluginPreferencesPath(forgeHome: string): string {
  return resolve(join(forgeHome, "plugin-prefs.json"));
}

export async function loadPluginPreferences(forgeHome: string): Promise<PluginPreferences> {
  try {
    const raw = await readFile(pluginPreferencesPath(forgeHome), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const disabled = Array.isArray(parsed.disabled)
      ? parsed.disabled.filter((id): id is string => typeof id === "string")
      : [];
    const config: Record<string, Record<string, unknown>> = {};
    if (parsed.config && typeof parsed.config === "object" && !Array.isArray(parsed.config)) {
      for (const [pluginId, values] of Object.entries(parsed.config)) {
        if (values && typeof values === "object" && !Array.isArray(values)) {
          config[pluginId] = values as Record<string, unknown>;
        }
      }
    }
    return { disabled: [...new Set(disabled)], config };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}

export async function savePluginPreferences(forgeHome: string, prefs: PluginPreferences): Promise<void> {
  const p = pluginPreferencesPath(forgeHome);
  await mkdir(dirname(p), { recursive: true });
  // Same discipline as forge-config.json: temp file + rename, with a UUID so
  // two writers in the same millisecond cannot clobber each other's temp.
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(prefs, null, 2) + "\n", "utf8");
  await rename(tmp, p);
}
