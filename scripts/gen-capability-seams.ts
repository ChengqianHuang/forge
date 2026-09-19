import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBuiltinPluginRegistry } from "../src/plugins/builtins/index.ts";
import type { PluginSessionContext } from "../src/plugins/types.ts";

/**
 * Generated architecture guard (the DSH capability-seams idea): the table is
 * extracted from the LIVE builtin registry — each plugin is activated against
 * a scratch workspace and its runtime contributions recorded as facts.
 * `--check` regenerates and fails if docs/capability-seams.md is stale, so
 * "no feature modifies the loop" stays a machine-checked claim: every plugin
 * hook attachment appears in the hooks column, aggregated by the kernel's
 * hook multiplexer — none of them replaces or wraps the loop.
 */

const MARKER_START = "<!-- generated: capability-seams -->";
const MARKER_END = "<!-- /generated: capability-seams -->";

async function observe(): Promise<string> {
  const registry = createBuiltinPluginRegistry();
  const workspace = await mkdtemp(join(tmpdir(), "forge-seams-"));
  try {
    const context = {
      session: {
        id: "seams-probe",
        workspace,
        status: "running",
        model: { provider: "probe", modelId: "probe-model" },
        messages: [],
        usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
      },
      signal: new AbortController().signal,
      emitEvent: async () => undefined,
      enqueueSteering: () => {},
      requestCompaction: () => {},
    } as unknown as PluginSessionContext;
    const host = await registry.activate(context);
    try {
      const facts = new Map(host.inspectContributions().map((fact) => [fact.id, fact]));
      const snapshot = host.capabilities();
      const rows = snapshot.plugins.map((plugin) => {
        const fact = facts.get(plugin.id);
        const hooks = fact?.hooks ?? [];
        const tools = fact?.tools ?? [];
        const services = fact?.services ?? [];
        const commands = (plugin.slashCommands ?? []).map((command) => `/${command.name}`);
        const readActions = (plugin.readActions ?? []).map((action) => action.id);
        const ui = (plugin.ui ?? []).map((contribution) => `${contribution.surface}:\`${contribution.renderer}\``);
        const configKeys = (plugin.configSchema ?? []).map((field) => field.key);
        const cell = (values: string[], mono = true) =>
          values.length > 0 ? values.map((v) => (mono ? `\`${v}\`` : v)).join(" ") : "—";
        return [
          `\`${plugin.id}\``,
          plugin.required ? "✓" : "",
          cell(hooks),
          cell(tools),
          cell(commands),
          cell(services),
          fact?.subscribesEvents ? "✓" : "—",
          cell(readActions),
          ui.length > 0 ? ui.join(" ") : "—",
          cell(configKeys),
        ].map((cellValue, index) => (index === 0 ? cellValue : ` ${cellValue}`)).join("|").replace(/^/, "|").concat(" |");
      });
      return [
        MARKER_START,
        "",
        "# Capability seams（机器生成）",
        "",
        "> 由 `scripts/gen-capability-seams.ts` 从**活的内置注册表**提取：每个插件被真实激活，",
        "> 其运行时贡献作为事实记录在下表。改动插件面后运行 `npm run gen:seams` 重新生成；",
        "> 门禁的 `capability seams fresh` 项校验本文件未过期。",
        "",
        "## 能力 → 运行时贡献",
        "",
        "| 插件 | 必需 | 内核钩子（经复用器） | 工具 | 斜杠命令 | 会话服务 | 事件订阅 | read actions | UI | 配置键 |",
        "|---|---|---|---|---|---|---|---|---|---|",
        ...rows,
        "",
        "## 机器可查的声明",
        "",
        "- 上表`内核钩子`列的每个钩子都经内核 `multiplexHooks` 逐插件隔离聚合——**没有任何插件替换或包裹 agent loop**；插件钩子运行失败时被故障隔离，循环本身不受影响。",
        "- 内核自有护栏（guard policy、write journal、审批、卡死检测、watchdog、compaction）不在本表：它们是 AgentLoopConfig 内核钩子的实现，不是插件。",
        "- `transformContext` 内核不安装（Rule 5.6）；插件若声明它也会出现在钩子列，属合法扩展面。",
        "- read actions 经 `GET /sessions/:id/capabilities/:pluginId/read/:actionId` 提供有界、stateless 的检视；UI 列的 `dock` surface 直接成为会话右栏 tab。",
        "",
        MARKER_END,
      ].join("\n");
    } finally {
      await host.dispose();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const docPath = join(import.meta.dirname ?? ".", "..", "docs", "capability-seams.md");

async function main() {
  const check = process.argv.includes("--check");
  const rendered = await observe();
  if (check) {
    const current = await readFile(docPath, "utf8").catch(() => "");
    if (current.trim() !== rendered.trim()) {
      console.error("capability-seams.md is stale — run `npm run gen:seams` and commit the result.");
      process.exit(1);
    }
    console.log("capability-seams.md is fresh.");
    return;
  }
  await writeFile(docPath, rendered + "\n", "utf8");
  console.log(`wrote ${docPath}`);
}

await main();
