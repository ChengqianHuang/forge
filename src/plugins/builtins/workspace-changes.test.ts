import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureWorkspaceChanges, readWorkspaceFileDiff, workspaceChangesPlugin } from "./workspace-changes.ts";

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

    const trackedDiff = await readWorkspaceFileDiff(workspace, "tracked.txt");
    assert.equal(trackedDiff.kind, "text");
    assert.match(trackedDiff.patch, /\+changed during session/);
    const untrackedDiff = await readWorkspaceFileDiff(workspace, "new.txt");
    assert.equal(untrackedDiff.kind, "text");
    assert.match(untrackedDiff.patch, /\+new/);

    await symlink("/etc/passwd", join(workspace, "outside-link"));
    const linkDiff = await readWorkspaceFileDiff(workspace, "outside-link");
    assert.equal(linkDiff.kind, "binary");
    assert.equal(linkDiff.patch, "");

    await writeFile(join(workspace, "large.txt"), "added line\n".repeat(30_000));
    const largeDiff = await readWorkspaceFileDiff(workspace, "large.txt");
    assert.equal(largeDiff.kind, "text");
    assert.equal(largeDiff.truncated, true);
    assert.ok(largeDiff.bytes > Buffer.byteLength(largeDiff.patch));
    assert.ok(Buffer.byteLength(largeDiff.patch) <= 256 * 1024);
    await assert.rejects(() => readWorkspaceFileDiff(workspace, "/etc/passwd"), /outside the session workspace/);
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

test("fresh repositories without HEAD still report untracked files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "forge-workspace-changes-fresh-"));
  try {
    await git(workspace, ["init", "-q"]);
    await writeFile(join(workspace, "first.txt"), "first\n");
    const { snapshot } = await captureWorkspaceChanges(workspace);
    assert.equal(snapshot.supported, true);
    assert.equal(snapshot.files[0]?.path, "first.txt");
    assert.equal((await readWorkspaceFileDiff(workspace, "first.txt")).kind, "text");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reads paths relative to a session workspace nested inside a repository", async () => {
  const repo = await mkdtemp(join(tmpdir(), "forge-workspace-changes-nested-"));
  const workspace = join(repo, "packages", "app");
  try {
    await git(repo, ["init", "-q"]);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "nested.txt"), "before\n");
    await git(repo, ["add", "."]);
    await git(repo, ["-c", "user.name=Forge Test", "-c", "user.email=forge@test.invalid", "commit", "-qm", "fixture"]);
    await writeFile(join(workspace, "nested.txt"), "after\n");

    const { snapshot } = await captureWorkspaceChanges(workspace);
    assert.equal(snapshot.files[0]?.path, "packages/app/nested.txt");
    const diff = await readWorkspaceFileDiff(workspace, "packages/app/nested.txt");
    assert.equal(diff.kind, "text");
    assert.match(diff.patch, /\+after/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
