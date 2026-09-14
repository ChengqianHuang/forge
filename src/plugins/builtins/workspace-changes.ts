import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ForgePlugin } from "../types.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 4_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const DIFF_MAX_BUFFER = 2 * 1024 * 1024;
const DIFF_RETURN_BYTES = 256 * 1024;

export type WorkspaceChange = {
  path: string;
  previousPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  preexisting: boolean;
  changedDuringSession: boolean;
};

export type WorkspaceChangeSnapshot = {
  supported: boolean;
  repoRoot: string | null;
  files: WorkspaceChange[];
  reason?: "not-git" | "git-error";
};

export type WorkspaceFileDiff = {
  path: string;
  kind: "text" | "binary" | "empty";
  patch: string;
  truncated: boolean;
  bytes: number;
};

type RawChange = {
  path: string;
  previousPath?: string;
  status: string;
  hash: string | null;
  additions: number | null;
  deletions: number | null;
};

type RawSnapshot = {
  supported: boolean;
  repoRoot: string | null;
  files: Map<string, RawChange>;
  reason?: "not-git" | "git-error";
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

function parsePorcelain(output: string): Array<{ status: string; path: string; previousPath?: string }> {
  const records = output.split("\0");
  const changes: Array<{ status: string; path: string; previousPath?: string }> = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (/[RC]/.test(status)) {
      const previousPath = records[++i];
      changes.push({ status, path, ...(previousPath ? { previousPath } : {}) });
    } else {
      changes.push({ status, path });
    }
  }
  return changes;
}

function parseNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    stats.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
    });
  }
  return stats;
}

async function fileHash(repoRoot: string, path: string): Promise<string | null> {
  return new Promise((resolveHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(resolve(repoRoot, path));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", () => resolveHash(null));
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
}

async function captureRaw(workspace: string): Promise<RawSnapshot> {
  let repoRoot: string;
  try {
    repoRoot = (await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      supported: false,
      repoRoot: null,
      files: new Map(),
      reason: /not a git repository/i.test(message) ? "not-git" : "git-error",
    };
  }

  try {
    const [porcelain, numstat] = await Promise.all([
      git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
      // A freshly initialized repository has no HEAD yet. Status is still
      // useful there; only the tracked line counts are unavailable.
      git(workspace, ["diff", "HEAD", "--numstat", "--", "."]).catch(() => ""),
    ]);
    const stats = parseNumstat(numstat);
    const entries = parsePorcelain(porcelain);
    const files = new Map<string, RawChange>();
    // Bound open descriptors on repositories with many dirty files.
    for (let offset = 0; offset < entries.length; offset += 16) {
      await Promise.all(entries.slice(offset, offset + 16).map(async (entry) => {
        const stat = stats.get(entry.path);
        files.set(entry.path, {
          ...entry,
          hash: await fileHash(repoRoot, entry.path),
          additions: stat?.additions ?? null,
          deletions: stat?.deletions ?? null,
        });
      }));
    }
    return { supported: true, repoRoot, files };
  } catch {
    return { supported: false, repoRoot, files: new Map(), reason: "git-error" };
  }
}

/** Capture current Git changes and compare them with the session baseline. */
export async function captureWorkspaceChanges(
  workspace: string,
  baseline?: RawSnapshot,
): Promise<{ snapshot: WorkspaceChangeSnapshot; raw: RawSnapshot }> {
  const raw = await captureRaw(workspace);
  if (!raw.supported) {
    return {
      raw,
      snapshot: {
        supported: false,
        repoRoot: raw.repoRoot,
        files: [],
        ...(raw.reason ? { reason: raw.reason } : {}),
      },
    };
  }
  const files = [...raw.files.values()]
    .map((file): WorkspaceChange => {
      const before = baseline?.files.get(file.path);
      return {
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        preexisting: before !== undefined,
        changedDuringSession: before === undefined || before.status !== file.status || before.hash !== file.hash,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return { raw, snapshot: { supported: true, repoRoot: raw.repoRoot, files } };
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function gitPatch(workspace: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workspace,
      encoding: "buffer",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BUFFER,
      windowsHide: true,
    });
    return stdout as Buffer;
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (Buffer.isBuffer(stdout)) return stdout;
    throw error;
  }
}

/** Current working-tree patch for one event-projected path. Nothing is
 * persisted; callers receive a bounded snapshot generated on demand. */
export async function readWorkspaceFileDiff(
  workspace: string,
  requestedPath: string,
): Promise<WorkspaceFileDiff> {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("path is required");
  const repoRoot = (await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
  // macOS temp paths commonly enter through /var while Git canonicalizes to
  // /private/var. Compare canonical roots or valid in-workspace paths look
  // like escapes.
  const absoluteWorkspace = await realpath(workspace);
  // Porcelain paths are repository-root relative even when cwd and `-- .`
  // constrain the status scan to a nested session workspace.
  const absolutePath = resolve(repoRoot, requestedPath);
  if (!isWithin(repoRoot, absolutePath) || !isWithin(absoluteWorkspace, absolutePath)) {
    throw new Error("path is outside the session workspace");
  }
  const repoPath = relative(repoRoot, absolutePath).split(sep).join("/");
  const status = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", repoPath]);
  if (!status.trim()) return { path: requestedPath, kind: "empty", patch: "", truncated: false, bytes: 0 };

  let output: Buffer;
  if (status.startsWith("??")) {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      return { path: requestedPath, kind: "binary", patch: "", truncated: false, bytes: 0 };
    }
    output = await gitPatch(repoRoot, ["diff", "--no-index", "--no-ext-diff", "--unified=3", "--", "/dev/null", absolutePath]);
  } else {
    output = await gitPatch(repoRoot, ["diff", "HEAD", "--no-ext-diff", "--unified=3", "--", repoPath])
      .catch(() => gitPatch(repoRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", repoPath]));
  }
  const bytes = output.byteLength;
  const truncated = bytes > DIFF_RETURN_BYTES;
  const patch = output.subarray(0, DIFF_RETURN_BYTES).toString("utf8");
  const kind = /Binary files .* differ|GIT binary patch/.test(patch) ? "binary" : patch ? "text" : "empty";
  return { path: requestedPath, kind, patch, truncated, bytes };
}

export const workspaceChangesPlugin: ForgePlugin = {
  manifest: {
    id: "forge.workspace-changes",
    name: "Workspace Changes",
    version: "1.0.0",
    capabilities: ["event-subscriber", "ui"],
    readActions: [{ id: "diff", description: "Read the current bounded Git diff for one workspace file" }],
    ui: [{
      id: "workspace-changes",
      label: "变更",
      surface: "session-header",
      renderer: "workspace-changes",
      readAction: "diff",
    }],
  },
  async activate(context) {
    const { raw: baseline } = await captureWorkspaceChanges(context.session.workspace);
    let emittedBaseline = false;
    return {
      async onAgentEvent(event) {
        if (event.type === "agent_start" && !emittedBaseline) {
          emittedBaseline = true;
          await context.emitEvent("WORKSPACE_CHANGES", {
            supported: baseline.supported,
            repoRoot: baseline.repoRoot,
            files: [],
            phase: "baseline",
            ...(baseline.reason ? { reason: baseline.reason } : {}),
          });
        }
        if (event.type === "agent_end") {
          const { snapshot } = await captureWorkspaceChanges(context.session.workspace, baseline);
          await context.emitEvent("WORKSPACE_CHANGES", { ...snapshot, phase: "current" });
        }
      },
    };
  },
  async read(actionId, input, context) {
    if (actionId !== "diff") throw new Error(`unknown workspace changes action: ${actionId}`);
    if (typeof input.path !== "string") throw new Error("path is required");
    if (context.signal.aborted) throw context.signal.reason;
    return readWorkspaceFileDiff(context.session.workspace, input.path);
  },
};
