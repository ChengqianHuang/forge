import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPluginPreferences, pluginPreferencesPath, savePluginPreferences } from "./plugin-preferences.ts";

test("round-trips preferences through an atomic write", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-prefs-"));
  try {
    assert.deepEqual(await loadPluginPreferences(home), { disabled: [], config: {} });

    await savePluginPreferences(home, {
      disabled: ["mcp.demo"],
      config: { "forge.workspace-changes": { gitTimeoutMs: 8000 } },
    });
    assert.deepEqual(await loadPluginPreferences(home), {
      disabled: ["mcp.demo"],
      config: { "forge.workspace-changes": { gitTimeoutMs: 8000 } },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tolerates malformed content instead of poisoning the platform", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-prefs-"));
  try {
    await writeFile(pluginPreferencesPath(home), "{not json", "utf8");
    await assert.rejects(() => loadPluginPreferences(home));

    await writeFile(
      pluginPreferencesPath(home),
      JSON.stringify({ disabled: ["a", 42, "a"], config: { p: "not-an-object", q: { x: 1 } } }),
      "utf8",
    );
    assert.deepEqual(await loadPluginPreferences(home), {
      disabled: ["a"],
      config: { q: { x: 1 } },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("save does not clobber a same-millisecond concurrent temp file", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-prefs-"));
  try {
    // Two writers in the same tick must both land: the temp name carries a
    // UUID, so neither rename can target the other's temp file.
    await Promise.all([
      savePluginPreferences(home, { disabled: ["one"], config: {} }),
      savePluginPreferences(home, { disabled: ["two"], config: {} }),
    ]);
    const raw = JSON.parse(await readFile(pluginPreferencesPath(home), "utf8"));
    assert.ok(raw.disabled.length === 1 && (raw.disabled[0] === "one" || raw.disabled[0] === "two"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
