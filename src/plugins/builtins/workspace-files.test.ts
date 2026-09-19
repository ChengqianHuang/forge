import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { listWorkspaceDir, readWorkspaceFile } from "./workspace-files.ts";

async function makeWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "forge-wsfiles-"));
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "main.ts"), "export const hi = 1;\n");
  await writeFile(join(ws, "README.md"), "# demo\n");
  await writeFile(join(ws, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
  return ws;
}

test("list is lazy per directory and sorted", async () => {
  const ws = await makeWorkspace();
  try {
    const root = await listWorkspaceDir(ws, ".");
    assert.deepEqual(root.entries.map((e) => `${e.name}:${e.type}`), ["blob.bin:file", "README.md:file", "src:dir"]);
    const src = await listWorkspaceDir(ws, "src");
    assert.deepEqual(src.entries.map((e) => e.name), ["main.ts"]);
    assert.equal(src.entries[0]!.size, "export const hi = 1;\n".length);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("read returns bounded text; binary is detected and emptied", async () => {
  const ws = await makeWorkspace();
  try {
    const file = await readWorkspaceFile(ws, "src/main.ts");
    assert.equal(file.kind, "text");
    assert.equal(file.content, "export const hi = 1;\n");
    assert.equal(file.truncated, false);

    const bin = await readWorkspaceFile(ws, "blob.bin");
    assert.equal(bin.kind, "binary");
    assert.equal(bin.content, "");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("paths cannot escape the workspace, even through symlinks created inside", async () => {
  const ws = await makeWorkspace();
  const outside = await mkdtemp(join(tmpdir(), "forge-wsfiles-out-"));
  try {
    await writeFile(join(outside, "secret.txt"), "nope");
    await symlink(join(outside, "secret.txt"), join(ws, "leak.txt"));

    await assert.rejects(() => readWorkspaceFile(ws, "../" + outside.split("/").pop()! + "/secret.txt"), /outside the session workspace/);
    // A symlink inside the workspace pointing out is still readable only
    // through its target check: realpath of the file resolves outside.
    const leak = readWorkspaceFile(ws, "leak.txt");
    await assert.rejects(() => leak, /outside the session workspace/);
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
