import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePluginConfig,
  validateConfigInput,
  validateConfigSchema,
} from "./config-schema.ts";
import type { PluginConfigField } from "./types.ts";

const schema: PluginConfigField[] = [
  { key: "gitTimeoutMs", label: "timeout", type: "number", default: 4000 },
  { key: "verbose", label: "verbose", type: "boolean", default: false },
  { key: "mode", label: "mode", type: "enum", default: "fast", options: ["fast", "slow"] },
  { key: "note", label: "note", type: "string", default: "" },
];

test("resolvePluginConfig merges defaults with valid stored values", () => {
  assert.deepEqual(
    resolvePluginConfig(schema, { gitTimeoutMs: 9000, verbose: true, mode: "slow", note: "hi", junk: 1 }),
    { gitTimeoutMs: 9000, verbose: true, mode: "slow", note: "hi" },
  );
});

test("resolvePluginConfig drops wrong-shaped values, keeps defaults", () => {
  assert.deepEqual(
    resolvePluginConfig(schema, { gitTimeoutMs: "nope", verbose: "yes", mode: "bogus", note: 42 }),
    { gitTimeoutMs: 4000, verbose: false, mode: "fast", note: "" },
  );
});

test("resolvePluginConfig works with no schema and no stored values", () => {
  assert.deepEqual(resolvePluginConfig(undefined, undefined), {});
  assert.deepEqual(resolvePluginConfig(undefined, { a: 1 }), {});
});

test("validateConfigSchema rejects duplicate keys and broken enums", () => {
  assert.throws(
    () => validateConfigSchema([{ key: "a", label: "x", type: "string", default: "" }, { key: "a", label: "y", type: "string", default: "" }], "p"),
    /invalid or duplicate config key/,
  );
  assert.throws(
    () => validateConfigSchema([{ key: "m", label: "x", type: "enum", default: "a" }], "p"),
    /has no options/,
  );
  assert.throws(
    () => validateConfigSchema([{ key: "m", label: "x", type: "enum", default: "b", options: ["a"] }], "p"),
    /not one of its options/,
  );
  assert.doesNotThrow(() => validateConfigSchema(schema, "p"));
});

test("validateConfigInput accepts only known keys with well-shaped values", () => {
  assert.deepEqual(validateConfigInput(schema, { gitTimeoutMs: 1000 }), { ok: true, config: { gitTimeoutMs: 1000 } });
  assert.deepEqual(validateConfigInput(schema, undefined), { ok: true, config: {} });
  assert.equal(validateConfigInput(schema, [1, 2]).ok, false);
  assert.equal(validateConfigInput(schema, { unknown: 1 }).ok, false);
  const bad = validateConfigInput(schema, { mode: "nope" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /one of: fast, slow/);
});
