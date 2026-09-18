import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupStaging, inspectPluginSource, installPluginFiles } from "./plugin-install.ts";

const PLUGIN_TS = `
  const plugin = {
    manifest: { id: "ext.t", name: "T", version: "1.0.0", capabilities: ["slash-command"] },
    activate: () => ({}),
  };
  export default plugin;
`;

test("inspect validates a local dir; install copies only into forge home", async () => {
  const source = await mkdtemp(join(tmpdir(), "forge-install-src-"));
  const forgeHome = await mkdtemp(join(tmpdir(), "forge-install-home-"));
  try {
    await writeFile(join(source, "t.plugin.ts"), PLUGIN_TS);
    await writeFile(join(source, "bad.plugin.ts"), "export default 1;");

    const inspected = await inspectPluginSource(source);
    assert.deepEqual(inspected.plugins.map((p) => p.id), ["ext.t"]);
    assert.equal(inspected.errors.length, 1);
    assert.equal(inspected.stagingDir, null);

    await installPluginFiles(forgeHome, source, inspected.stagingDir, inspected.plugins);
    assert.ok(existsSync(join(forgeHome, "plugins", "t.plugin.ts")));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(forgeHome, { recursive: true, force: true });
  }
});

test("a git remote (file:// clone) stages, inspects and cleans up", async () => {
  const remote = await mkdtemp(join(tmpdir(), "forge-install-remote-"));
  const forgeHome = await mkdtemp(join(tmpdir(), "forge-install-home2-"));
  const git = (args: string[], cwd: string) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
  try {
    await writeFile(join(remote, "remote.plugin.ts"), PLUGIN_TS);
    git(["init", "-q"], remote);
    git(["add", "."], remote);
    git(["commit", "-qm", "init"], remote);

    const inspected = await inspectPluginSource(`file://${remote}`);
    try {
      assert.deepEqual(inspected.plugins.map((p) => p.fileName), ["remote.plugin.ts"]);
      await installPluginFiles(forgeHome, `file://${remote}`, inspected.stagingDir, inspected.plugins);
      assert.ok(existsSync(join(forgeHome, "plugins", "remote.plugin.ts")));
    } finally {
      await cleanupStaging(inspected.stagingDir);
      if (inspected.stagingDir) {
        assert.equal(existsSync(inspected.stagingDir), false, "staging dir must be cleaned up");
      }
    }
  } finally {
    await rm(remote, { recursive: true, force: true });
    await rm(forgeHome, { recursive: true, force: true });
  }
});

test("install rejects a source without plugin files", async () => {
  const empty = await mkdtemp(join(tmpdir(), "forge-install-empty-"));
  try {
    await mkdir(join(empty, "sub"));
    await assert.rejects(() => inspectPluginSource(empty), /no \*\.plugin/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
