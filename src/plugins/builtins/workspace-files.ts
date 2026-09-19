import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ForgePlugin } from "../types.ts";

/**
 * Workspace file inspection for the session dock: a lazy per-directory
 * listing plus a bounded text read. Stateless by design — the session's
 * files are on disk, and anything the user wants persisted (diffs, history)
 * belongs to forge.workspace-changes. Boundaries: every path is resolved and
 * must stay inside the session workspace; reads are capped so a huge file
 * cannot flood the dock or the event-free read channel.
 */

const LIST_MAX_ENTRIES = 500;
const READ_MAX_BYTES = 256 * 1024;

export type WorkspaceDirEntry = {
  name: string;
  type: "dir" | "file";
  size: number | null;
};

export type WorkspaceFileContent = {
  path: string;
  kind: "text" | "binary";
  content: string;
  bytes: number;
  truncated: boolean;
};

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

/** Resolve a user-supplied workspace-relative path against the workspace.
 * The target is realpathed before the boundary check, so a symlink planted
 * inside the workspace cannot carry a read outside it. */
async function safeResolve(workspace: string, requested: string): Promise<string> {
  if (!requested || requested.includes("\0")) throw new Error("path is required");
  const absoluteWorkspace = await realpath(workspace);
  const target = resolve(absoluteWorkspace, requested);
  const real = await realpath(target);
  if (!isWithin(absoluteWorkspace, real)) {
    throw new Error("path is outside the session workspace");
  }
  return real;
}

export async function listWorkspaceDir(
  workspace: string,
  requested: string,
): Promise<{ path: string; entries: WorkspaceDirEntry[]; truncated: boolean }> {
  const absoluteWorkspace = await realpath(workspace);
  const target = await safeResolve(workspace, requested || ".");
  const info = await lstat(target);
  if (!info.isDirectory()) throw new Error(`not a directory: ${requested}`);
  const names = (await readdir(target)).sort((a, b) => a.localeCompare(b)).slice(0, LIST_MAX_ENTRIES);
  const entries = await Promise.all(names.map(async (name): Promise<WorkspaceDirEntry> => {
    try {
      const stat = await lstat(join(target, name));
      return { name, type: stat.isDirectory() ? "dir" : "file", size: stat.isDirectory() ? null : stat.size };
    } catch {
      return { name, type: "file", size: null };
    }
  }));
  return {
    path: relative(absoluteWorkspace, target).split(sep).join("/") || ".",
    entries,
    truncated: names.length >= LIST_MAX_ENTRIES,
  };
}

export async function readWorkspaceFile(
  workspace: string,
  requested: string,
): Promise<WorkspaceFileContent> {
  const target = await safeResolve(workspace, requested);
  const info = await lstat(target);
  if (info.isDirectory()) throw new Error(`not a file: ${requested}`);
  const buf = await readFile(target);
  const truncated = buf.byteLength > READ_MAX_BYTES;
  const slice = buf.subarray(0, READ_MAX_BYTES);
  const binary = slice.includes(0);
  return {
    path: requested,
    kind: binary ? "binary" : "text",
    content: binary ? "" : slice.toString("utf8"),
    bytes: buf.byteLength,
    truncated,
  };
}

export const workspaceFilesPlugin: ForgePlugin = {
  manifest: {
    id: "forge.workspace-files",
    name: "Workspace Files",
    version: "1.0.0",
    description: "会话工作区的文件浏览与预览（dock 面板）。",
    capabilities: ["read-action", "ui"],
    readActions: [
      { id: "list", description: "List one directory of the session workspace" },
      { id: "read", description: "Read one bounded workspace file" },
    ],
    ui: [{
      id: "workspace-files",
      label: "文件",
      surface: "dock",
      renderer: "workspace-files",
    }],
  },
  activate: () => ({}),
  async read(actionId, input, context) {
    if (context.signal.aborted) throw context.signal.reason;
    if (actionId === "list") {
      if (typeof input.path !== "string") throw new Error("path is required");
      return listWorkspaceDir(context.session.workspace, input.path);
    }
    if (actionId === "read") {
      if (typeof input.path !== "string") throw new Error("path is required");
      return readWorkspaceFile(context.session.workspace, input.path);
    }
    throw new Error(`unknown workspace files action: ${actionId}`);
  },
};
