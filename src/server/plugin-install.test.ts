import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanupStaging,
  inspectPluginSource,
  installPluginFiles,
  PluginInstallCoordinator,
} from "./plugin-install.ts";

const PLUGIN_TS = `
  const plugin = {
    manifest: { id: "ext.t", name: "T", version: "1.0.0", capabilities: ["slash-command"] },
    activate: () => ({}),
  };
  export default plugin;
`;

test("inspect stages a local directory; install copies only inspected bytes", async () => {
  const source = await mkdtemp(join(tmpdir(), "forge-install-src-"));
  const forgeHome = await mkdtemp(join(tmpdir(), "forge-install-home-"));
  let stagingDir: string | undefined;
  try {
    await writeFile(join(source, "t.plugin.ts"), PLUGIN_TS);
    await writeFile(join(source, "bad.plugin.ts"), "export default 1;");

    const inspected = await inspectPluginSource(source);
    stagingDir = inspected.stagingDir;
    assert.deepEqual(inspected.plugins.map((plugin) => plugin.id), ["ext.t"]);
    assert.equal(inspected.plugins[0]?.sha256.length, 64);
    assert.equal(inspected.errors.length, 1);
    assert.notEqual(inspected.stagingDir, source);

    await writeFile(join(source, "t.plugin.ts"), "throw new Error('changed after inspection');");
    await installPluginFiles(forgeHome, inspected.stagingDir, inspected.plugins);
    assert.equal(await readFile(join(forgeHome, "plugins", "t.plugin.ts"), "utf8"), PLUGIN_TS);
  } finally {
    if (stagingDir) await cleanupStaging(stagingDir);
    await rm(source, { recursive: true, force: true });
    await rm(forgeHome, { recursive: true, force: true });
  }
});

test("a single local plugin file can be inspected", async () => {
  const source = await mkdtemp(join(tmpdir(), "forge-install-file-"));
  let stagingDir: string | undefined;
  try {
    const file = join(source, "single.plugin.ts");
    await writeFile(file, PLUGIN_TS);
    const inspected = await inspectPluginSource(file);
    stagingDir = inspected.stagingDir;
    assert.deepEqual(inspected.plugins.map((plugin) => plugin.fileName), ["single.plugin.ts"]);
  } finally {
    if (stagingDir) await cleanupStaging(stagingDir);
    await rm(source, { recursive: true, force: true });
  }
});

test("a git remote stages, inspects, installs and cleans up", async () => {
  const remote = await mkdtemp(join(tmpdir(), "forge-install-remote-"));
  const forgeHome = await mkdtemp(join(tmpdir(), "forge-install-home2-"));
  const git = (args: string[], cwd: string) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
  let stagingDir: string | undefined;
  try {
    await writeFile(join(remote, "remote.plugin.ts"), PLUGIN_TS);
    git(["init", "-q"], remote);
    git(["add", "."], remote);
    git(["commit", "-qm", "init"], remote);

    const inspected = await inspectPluginSource(`file://${remote}`);
    stagingDir = inspected.stagingDir;
    assert.deepEqual(inspected.plugins.map((plugin) => plugin.fileName), ["remote.plugin.ts"]);
    await installPluginFiles(forgeHome, inspected.stagingDir, inspected.plugins);
    assert.ok(existsSync(join(forgeHome, "plugins", "remote.plugin.ts")));
  } finally {
    if (stagingDir) {
      await cleanupStaging(stagingDir);
      assert.equal(existsSync(stagingDir), false, "staging dir must be cleaned up");
    }
    await rm(remote, { recursive: true, force: true });
    await rm(forgeHome, { recursive: true, force: true });
  }
});

test("inspection tickets are one-shot and install the exact inspected bytes", async () => {
  const source = await mkdtemp(join(tmpdir(), "forge-install-ticket-src-"));
  const forgeHome = await mkdtemp(join(tmpdir(), "forge-install-ticket-home-"));
  const coordinator = new PluginInstallCoordinator();
  try {
    const file = join(source, "ticket.plugin.ts");
    await writeFile(file, PLUGIN_TS);
    const inspection = await coordinator.inspect(file);
    assert.equal(inspection.executesCode, true);
    await writeFile(file, "throw new Error('different bytes');");

    const ticket = coordinator.take(inspection.inspectionId);
    try {
      await installPluginFiles(forgeHome, ticket.stagingDir, ticket.plugins);
      assert.equal(await readFile(join(forgeHome, "plugins", "ticket.plugin.ts"), "utf8"), PLUGIN_TS);
    } finally {
      await cleanupStaging(ticket.stagingDir);
    }
    assert.throws(() => coordinator.take(inspection.inspectionId), /expired or was already used/);
  } finally {
    await coordinator.dispose();
    await rm(source, { recursive: true, force: true });
    await rm(forgeHome, { recursive: true, force: true });
  }
});

test("expired inspection tickets cannot be installed", async () => {
  const source = await mkdtemp(join(tmpdir(), "forge-install-expiry-"));
  const coordinator = new PluginInstallCoordinator(5);
  try {
    await writeFile(join(source, "expiry.plugin.ts"), PLUGIN_TS);
    const inspection = await coordinator.inspect(source);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.throws(() => coordinator.take(inspection.inspectionId), /expired or was already used/);
  } finally {
    await coordinator.dispose();
    await rm(source, { recursive: true, force: true });
  }
});

test("inspection rejects a source without plugin files", async () => {
  const empty = await mkdtemp(join(tmpdir(), "forge-install-empty-"));
  try {
    await mkdir(join(empty, "sub"));
    await assert.rejects(() => inspectPluginSource(empty), /no \*\.plugin/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
