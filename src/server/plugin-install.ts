import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ForgePlugin } from "../plugins/types.ts";
import { EXTERNAL_PLUGIN_PATTERN, externalPluginsDir as pluginsDir, validateCandidate } from "./external-plugins.ts";

export { externalPluginsDir } from "./external-plugins.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_INSPECTION_TTL_MS = 10 * 60_000;

export type PluginSourceInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** File name the plugin will get inside `<forgeHome>/plugins`. */
  fileName: string;
  /** Digest of the exact bytes held by the one-shot installation ticket. */
  sha256: string;
};

export type InspectResult = {
  plugins: PluginSourceInfo[];
  errors: Array<{ source: string; reason: string }>;
  /** Private scratch directory containing the exact inspected bytes. */
  stagingDir: string;
};

export type PluginInspection = Omit<InspectResult, "stagingDir"> & {
  inspectionId: string;
  expiresAt: number;
  /** Honest trust-boundary signal for API and desktop copy. */
  executesCode: true;
};

type Ticket = InspectResult & {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

async function importPluginFile(path: string): Promise<ForgePlugin> {
  // Forge plugins are executable ESM modules. Importing is validation *and*
  // code execution; callers must surface that trust boundary before invoking
  // inspection rather than presenting this as passive manifest parsing.
  const mod = await import(pathToFileURL(path).href);
  return validateCandidate(mod.default ?? mod.plugin);
}

async function pluginFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => EXTERNAL_PLUGIN_PATTERN.test(name)).sort();
}

function expandHome(source: string): string {
  if (source === "~") return homedir();
  if (source.startsWith("~/") || source.startsWith("~\\")) return join(homedir(), source.slice(2));
  return source;
}

/** A scheme URL is remote. `owner/repo` is GitHub shorthand only when no
 * matching local path exists, so a relative local directory is not hijacked. */
async function resolveSource(source: string): Promise<{ kind: "local"; path: string } | { kind: "git"; url: string }> {
  const expanded = resolve(expandHome(source));
  try {
    await stat(expanded);
    return { kind: "local", path: expanded };
  } catch {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(source)) return { kind: "git", url: source };
    if (/^[^/\\]+\/[^/\\]+$/.test(source)) return { kind: "git", url: `https://github.com/${source}.git` };
    throw new Error(`plugin source not found: ${expanded}`);
  }
}

/** Stage every source into a fresh directory. Local inputs are copied too, so
 * installation consumes the same bytes that inspection executed. */
async function stagePluginSource(source: string): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), "forge-plugin-install-"));
  try {
    const resolvedSource = await resolveSource(source);
    if (resolvedSource.kind === "git") {
      await execFileAsync("git", ["clone", "--depth", "1", resolvedSource.url, staging], {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      });
      return staging;
    }

    const info = await stat(resolvedSource.path);
    if (info.isFile()) {
      const fileName = basename(resolvedSource.path);
      if (!EXTERNAL_PLUGIN_PATTERN.test(fileName)) {
        throw new Error("plugin file must match *.plugin.{ts,js,mjs}");
      }
      await copyFile(resolvedSource.path, join(staging, fileName));
      return staging;
    }
    if (!info.isDirectory()) throw new Error(`unsupported plugin source: ${resolvedSource.path}`);
    const files = await pluginFilesIn(resolvedSource.path);
    for (const fileName of files) {
      await copyFile(join(resolvedSource.path, fileName), join(staging, fileName));
    }
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Download/copy and execute candidate modules from an isolated staging path.
 * The caller owns cleanup of the returned staging directory. */
export async function inspectPluginSource(source: string): Promise<InspectResult> {
  const stagingDir = await stagePluginSource(source);
  const errors: Array<{ source: string; reason: string }> = [];
  try {
    const files = await pluginFilesIn(stagingDir);
    if (files.length === 0) throw new Error("no *.plugin.{ts,js,mjs} files found in the source");
    const plugins: PluginSourceInfo[] = [];
    for (const fileName of files) {
      try {
        const path = join(stagingDir, fileName);
        const [plugin, bytes] = await Promise.all([importPluginFile(path), readFile(path)]);
        plugins.push({
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
          fileName,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch (error) {
        errors.push({ source: fileName, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { plugins, errors, stagingDir };
  } catch (error) {
    await cleanupStaging(stagingDir);
    throw error;
  }
}

/** One-shot ticket store: inspect once, install those exact staged bytes. */
export class PluginInstallCoordinator {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly ttlMs = DEFAULT_INSPECTION_TTL_MS) {}

  async inspect(source: string): Promise<PluginInspection> {
    const inspected = await inspectPluginSource(source);
    const inspectionId = randomUUID();
    const expiresAt = Date.now() + this.ttlMs;
    const timer = setTimeout(() => void this.discard(inspectionId), this.ttlMs);
    timer.unref?.();
    this.tickets.set(inspectionId, { ...inspected, expiresAt, timer });
    return {
      inspectionId,
      expiresAt,
      executesCode: true,
      plugins: inspected.plugins,
      errors: inspected.errors,
    };
  }

  take(inspectionId: string): InspectResult {
    const ticket = this.tickets.get(inspectionId);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      if (ticket) void this.discard(inspectionId);
      throw new Error("plugin inspection expired or was already used; inspect the source again");
    }
    this.tickets.delete(inspectionId);
    clearTimeout(ticket.timer);
    return { plugins: ticket.plugins, errors: ticket.errors, stagingDir: ticket.stagingDir };
  }

  async discard(inspectionId: string): Promise<void> {
    const ticket = this.tickets.get(inspectionId);
    if (!ticket) return;
    this.tickets.delete(inspectionId);
    clearTimeout(ticket.timer);
    await cleanupStaging(ticket.stagingDir);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.tickets.keys()].map((id) => this.discard(id)));
  }
}

/** Copy the exact inspected files into `<forgeHome>/plugins`. */
export async function installPluginFiles(
  forgeHome: string,
  stagingDir: string,
  files: Array<{ fileName: string }>,
): Promise<void> {
  const targetDir = pluginsDir(forgeHome);
  await mkdir(targetDir, { recursive: true });
  for (const { fileName } of files) {
    await copyFile(join(stagingDir, fileName), join(targetDir, basename(fileName)));
  }
}

export async function cleanupStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
}
