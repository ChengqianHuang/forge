import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureWorkspaceChanges, workspaceChangesPlugin } from "./workspace-changes.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

test("captures net Git changes and distinguishes preexisting dirty files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "forge-workspace-changes-"));
  try {
    await git(workspace, ["init", "-q"]);
    await writeFile(join(workspace, "tracked.txt"), "clean\n");
    await git(workspace, ["add", "tracked.txt"]);
    await git(workspace, ["-c", "user.name=Forge Test", "-c", "user.email=forge@test.invalid", "commit", "-qm", "fixture"]);

    await writeFile(join(workspace, "tracked.txt"), "already dirty\n");
    const { raw: baseline } = await captureWorkspaceChanges(workspace);
    await writeFile(join(workspace, "tracked.txt"), "changed during session\n");
    await writeFile(join(workspace, "new.txt"), "new\n");

    const { snapshot } = await captureWorkspaceChanges(workspace, baseline);
    assert.equal(snapshot.supported, true);
    const tracked = snapshot.files.find((file) => file.path === "tracked.txt");
    const added = snapshot.files.find((file) => file.path === "new.txt");
    assert.equal(tracked?.preexisting, true);
    assert.equal(tracked?.changedDuringSession, true);
    assert.equal(tracked?.status.trim(), "M");
    assert.equal(added?.preexisting, false);
    assert.equal(added?.changedDuringSession, true);
    assert.equal(added?.status, "??");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("non-Git workspaces degrade without failing plugin activation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "forge-workspace-changes-nongit-"));
  try {
    const { snapshot } = await captureWorkspaceChanges(workspace);
    assert.equal(snapshot.supported, false);
    assert.equal(snapshot.reason, "not-git");

    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const instance = await workspaceChangesPlugin.activate({
      session: { workspace } as never,
      signal: new AbortController().signal,
      emitEvent: async (type, payload) => { emitted.push({ type, payload }); },
      enqueueSteering: () => {},
      requestCompaction: () => {},
    });
    await instance.onAgentEvent?.({ type: "agent_start" } as never);
    assert.equal(emitted[0]?.type, "WORKSPACE_CHANGES");
    assert.equal(emitted[0]?.payload.supported, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
