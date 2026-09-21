import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ForgePlugin } from "../plugins/types.ts";

/**
 * External plugin contract for Forge's in-process monolith: a plugin is one
 * ESM module in
 * `<forgeHome>/plugins/*.plugin.{ts,js,mjs}` whose **default export** is a
 * `ForgePlugin` — the same shape compiled-in plugins use, so the manifest
 * (id/name/version/capabilities/configSchema), activation, read/interaction
 * handlers, lifecycle cleanup and global preferences all work identically.
 *
 * Loading is fail-isolated per file: a broken module, a malformed manifest or
 * an id collision can never take the server down; the failure is reported to
 * the plugin manager page and the rest of the platform keeps working. Changes
 * to the directory apply on the next server start.
 */

export type ExternalPluginError = {
  /** File name (not full path) the failure came from. */
  source: string;
  reason: string;
};

export type ExternalPluginLoad = {
  plugins: Array<{ plugin: ForgePlugin; fileName: string }>;
  errors: ExternalPluginError[];
};

export const EXTERNAL_PLUGIN_PATTERN = /\.plugin\.(ts|js|mjs)$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function externalPluginsDir(forgeHome: string): string {
  return resolve(join(forgeHome, "plugins"));
}

export function validateCandidate(value: unknown): ForgePlugin {
  const plugin = value as ForgePlugin | undefined;
  if (!plugin || typeof plugin !== "object") {
    throw new Error("module default export is not a plugin object");
  }
  const manifest = plugin.manifest;
  if (!manifest || typeof manifest !== "object") {
    throw new Error("plugin has no manifest");
  }
  if (typeof manifest.id !== "string" || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    throw new Error(`invalid manifest id: ${String(manifest.id)}`);
  }
  if (typeof manifest.name !== "string" || !manifest.name) {
    throw new Error("manifest name is required");
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("manifest version is required");
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new Error("manifest capabilities must be a non-empty array");
  }
  if (typeof plugin.activate !== "function") {
    throw new Error("plugin has no activate function");
  }
  return plugin;
}

export async function loadExternalPlugins(forgeHome: string): Promise<ExternalPluginLoad> {
  const dir = externalPluginsDir(forgeHome);
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => EXTERNAL_PLUGIN_PATTERN.test(name)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { plugins: [], errors: [] };
    return { plugins: [], errors: [{ source: "plugins/", reason: err instanceof Error ? err.message : String(err) }] };
  }
  const plugins: Array<{ plugin: ForgePlugin; fileName: string }> = [];
  const errors: ExternalPluginError[] = [];
  const seen = new Set<string>();
  for (const name of entries) {
    try {
      const mod = await import(pathToFileURL(join(dir, name)).href);
      const plugin = validateCandidate(mod.default ?? mod.plugin);
      if (seen.has(plugin.manifest.id)) {
        throw new Error(`duplicate plugin id: ${plugin.manifest.id}`);
      }
      seen.add(plugin.manifest.id);
      plugins.push({ plugin, fileName: name });
    } catch (err) {
      errors.push({
        source: name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { plugins, errors };
}
