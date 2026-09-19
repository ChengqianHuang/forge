import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ForgePlugin } from "../plugins/types.ts";
import { EXTERNAL_PLUGIN_PATTERN, externalPluginsDir as pluginsDir, validateCandidate } from "./external-plugins.ts";

export { externalPluginsDir } from "./external-plugins.ts";

const execFileAsync = promisify(execFile);

/**
 * The install flow behind the manager page's 添加插件 wizard uses an
 * inspect → install → enable-now sequence under Forge's copy-in contract.
 * A source is either a local `*.plugin.{ts,js,mjs}` file, a local
 * directory holding such files, or a git URL (shallow-cloned to a temp dir).
 * Inspect validates the candidate modules without touching forge home;
 * install copies the files in and returns the validated plugins so the host
 * can register them into the live registry.
 */

const GIT_TIMEOUT_MS = 30_000;

export type PluginSourceInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** File name the plugin will get inside `<forgeHome>/plugins`. */
  fileName: string;
};

export type InspectResult = {
  plugins: PluginSourceInfo[];
  errors: Array<{ source: string; reason: string }>;
  /** Scratch dir holding the fetched files; install() copies from here. null for local sources. */
  stagingDir: string | null;
};

async function importPluginFile(path: string): Promise<ForgePlugin> {
  const mod = await import(pathToFileURL(path).href);
  return validateCandidate(mod.default ?? mod.plugin);
}

async function pluginFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => EXTERNAL_PLUGIN_PATTERN.test(name)).sort();
}

/** A remote source is any scheme URL (https/file/ssh/git) or the GitHub
 * owner/repo shorthand; everything else must exist on the local disk. */
function isRemoteSource(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//.test(source) || /^[^/\\]+\/[^/\\]+$/.test(source);
}

function gitUrlFor(source: string): string {
  return /^[^/\\]+\/[^/\\]+$/.test(source) ? `https://github.com/${source}.git` : source;
}

/** Shallow-clone a git source into a fresh temp dir. */
async function stageGitSource(source: string): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), "forge-plugin-install-"));
  try {
    await execFileAsync("git", ["clone", "--depth", "1", source, staging], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return staging;
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new Error(`git clone failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Validate the plugins a source offers, without writing anything to forge home. */
export async function inspectPluginSource(source: string): Promise<InspectResult> {
  let dir: string;
  let stagingDir: string | null = null;
  if (isRemoteSource(source)) {
    dir = await stageGitSource(gitUrlFor(source));
    stagingDir = dir;
  } else {
    dir = resolve(source);
  }
  const errors: Array<{ source: string; reason: string }> = [];
  try {
    let files: string[];
    try {
      files = await pluginFilesIn(dir);
    } catch {
      throw new Error(`not a directory with plugin files: ${dir}`);
    }
    if (files.length === 0) {
      throw new Error("no *.plugin.{ts,js,mjs} files found in the source");
    }
    const plugins: PluginSourceInfo[] = [];
    for (const fileName of files) {
      try {
        const plugin = await importPluginFile(join(dir, fileName));
        plugins.push({
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
          fileName,
        });
      } catch (err) {
        errors.push({ source: fileName, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { plugins, errors, stagingDir };
  } catch (err) {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Copy the staged (or local) plugin files into `<forgeHome>/plugins`. */
export async function installPluginFiles(
  forgeHome: string,
  source: string,
  stagingDir: string | null,
  files: Array<{ fileName: string }>,
): Promise<void> {
  const targetDir = pluginsDir(forgeHome);
  await mkdir(targetDir, { recursive: true });
  const originDir = stagingDir ?? resolve(source);
  for (const { fileName } of files) {
    await copyFile(join(originDir, fileName), join(targetDir, basename(fileName)));
  }
}

export async function cleanupStaging(stagingDir: string | null): Promise<void> {
  if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
}
