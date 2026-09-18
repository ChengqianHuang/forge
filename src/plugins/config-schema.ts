import type { PluginConfigField } from "./types.ts";

/**
 * Plugin config schemas are declarative metadata the plugin manager UI
 * renders straight from — so a malformed schema must be rejected at
 * registration, and stored user values must be sanitized before they reach a
 * plugin. Both halves live here so the registry and the HTTP layer cannot
 * drift apart.
 */

export function validateConfigSchema(schema: PluginConfigField[] | undefined, pluginId: string): void {
  if (!schema) return;
  const keys = new Set<string>();
  for (const field of schema) {
    if (!/^[a-z][a-z0-9_]*$/i.test(field.key) || keys.has(field.key)) {
      throw new Error(`invalid or duplicate config key ${field.key} in plugin ${pluginId}`);
    }
    keys.add(field.key);
    if (field.type === "enum") {
      if (!field.options || field.options.length === 0) {
        throw new Error(`enum config ${field.key} in plugin ${pluginId} has no options`);
      }
      if (field.options.includes(String(field.default)) === false) {
        throw new Error(`default of enum config ${field.key} in plugin ${pluginId} is not one of its options`);
      }
    }
  }
}

/** Schema defaults merged with stored values; unknown keys and values of the
 * wrong shape are dropped, never surfaced to the plugin. */
export function resolvePluginConfig(
  schema: PluginConfigField[] | undefined,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const field of schema ?? []) {
    const value = stored?.[field.key];
    resolved[field.key] = isShapedValue(field, value) ? value : field.default;
  }
  return resolved;
}

/** Validate a user-submitted config against the schema. Unknown keys are
 * dropped; every present value must match its field's shape. */
export function validateConfigInput(
  schema: PluginConfigField[] | undefined,
  input: unknown,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, config: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "config must be an object" };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  const known = new Map((schema ?? []).map((field) => [field.key, field]));
  for (const [key, value] of entries) {
    const field = known.get(key);
    if (!field) return { ok: false, error: `unknown config key: ${key}` };
    if (!isShapedValue(field, value)) {
      return { ok: false, error: `config ${key} expects ${field.type === "enum" ? `one of: ${field.options?.join(", ")}` : field.type}` };
    }
  }
  return { ok: true, config: Object.fromEntries(entries) };
}

function isShapedValue(field: PluginConfigField, value: unknown): value is string | number | boolean {
  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && field.options?.includes(value) === true;
  }
}
