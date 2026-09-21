import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBuiltinPluginRegistry } from "../src/plugins/builtins/index.ts";
import { multiplexHooks } from "../src/plugins/hook-multiplexer.ts";
import type {
  ForgePlugin,
  PluginCapability,
  PluginHooks,
  PluginInstance,
  PluginManifest,
  PluginSessionContext,
  PluginUiContribution,
} from "../src/plugins/types.ts";

/**
 * Generated architecture guard: the contribution table and the seam routing
 * map are extracted from the LIVE builtin registry — each plugin is activated
 * against a scratch workspace and its runtime contributions recorded as facts.
 * `--check` regenerates and fails if docs/capability-seams.md is stale, so
 * "no feature modifies the loop" stays a machine-checked claim: every plugin
 * hook attachment appears in the hooks column, aggregated by the kernel's
 * hook multiplexer — none of them replaces or wraps the loop.
 *
 * The routing table is not hand-maintained prose. Slot inventories are
 * compiler-checked against the plugin contract types (the tsconfig covers
 * scripts/), referenced seam tokens are resolved at generation time, and the
 * hook inventory is verified at runtime against what multiplexHooks actually
 * composes — bidirectionally, so a multiplexer change cannot silently strand
 * the catalog.
 */

const MARKER_START = "<!-- generated: capability-seams -->";
const MARKER_END = "<!-- /generated: capability-seams -->";

// ── 挂载插槽清单 ───────────────────────────────────────────────────────
// Each inventory must cover exactly the keys of its source-of-truth type —
// `satisfies Record<K, true>` fails to compile on a missing OR an excess
// literal. Any edit to the plugin contract forces this catalog (and through
// it the generated doc) to be refreshed.

const HOOK_INVENTORY = {
  beforeToolCall: true,
  afterToolCall: true,
  shouldStopAfterTurn: true,
  getSteeringMessages: true,
  transformContext: true,
  prepareNextTurn: true,
} satisfies Record<keyof PluginHooks, true>;

const INSTANCE_INVENTORY = {
  tools: true,
  hooks: true,
  slashCommands: true,
  onAgentEvent: true,
  services: true,
  dispose: true,
} satisfies Record<keyof PluginInstance, true>;

const CONTEXT_INVENTORY = {
  session: true,
  signal: true,
  emitEvent: true,
  enqueueSteering: true,
  requestCompaction: true,
} satisfies Record<keyof PluginSessionContext, true>;

const MANIFEST_INVENTORY = {
  id: true,
  name: true,
  version: true,
  description: true,
  required: true,
  capabilities: true,
  slashCommands: true,
  ui: true,
  readActions: true,
  configSchema: true,
} satisfies Record<keyof PluginManifest, true>;

const PLUGIN_INVENTORY = {
  manifest: true,
  activate: true,
  read: true,
} satisfies Record<keyof ForgePlugin, true>;

const CAPABILITY_INVENTORY = {
  "slash-command": true,
  tool: true,
  guardrail: true,
  "event-subscriber": true,
  ui: true,
  "read-action": true,
} satisfies Record<PluginCapability, true>;

const SURFACE_INVENTORY = {
  "session-header": true,
  dock: true,
} satisfies Record<PluginUiContribution["surface"], true>;

// ── 新增行为去处（路由表） ─────────────────────────────────────────────
// Seam tokens (`hooks.x` `instance.x` `context.x` `manifest.x` `plugin.x`
// `surface:x` `cap:x`) are resolved against the inventories below by
// validateSeamTokens(); anything else is treated as prose.

interface RoutingRow {
  goal: string;
  mount: string;
  boundary: string;
  seams: string[];
}

const ROUTING: RoutingRow[] = [
  {
    goal: "给模型一项新能力",
    mount: "插件 `instance.tools`",
    boundary: "与 Pi 内置工具同过 `beforeToolCall` 守护通道；名称冲突注册期拒绝，Pi 内置工具名保留",
    seams: ["cap:tool", "instance.tools", "hooks.beforeToolCall"],
  },
  {
    goal: "检查或拦截一次工具调用",
    mount: "`hooks.beforeToolCall`",
    boundary: "内核 guard 恒先执行；插件只能追加拒绝与证据，不能放宽 destructive 底线（Rule 5.2）",
    seams: ["hooks.beforeToolCall"],
  },
  {
    goal: "修补工具结果或终结运行",
    mount: "`hooks.afterToolCall`",
    boundary: "各插件补丁逐层合并，`terminate` 一经置位不可被后来的插件洗掉",
    seams: ["hooks.afterToolCall"],
  },
  {
    goal: "在轮次边界停下",
    mount: "`hooks.shouldStopAfterTurn`",
    boundary: "任一 true 即终止并如实写 failureReason；stuck 守护与错误恢复在内核（Rules 5.3/5.5）",
    seams: ["hooks.shouldStopAfterTurn"],
  },
  {
    goal: "运行中注入引导消息",
    mount: "`context.enqueueSteering`",
    boundary: "steering 进 transcript、留下持久记录 —— 这正是内核不用 `transformContext` 的理由（Rule 5.6）",
    seams: ["context.enqueueSteering", "hooks.transformContext"],
  },
  {
    goal: "请求压缩",
    mount: "`context.requestCompaction`",
    boundary: "插件只请求；触发判定在内核 `prepareNextTurn`（usage 与 transcript 估计双信号水位）",
    seams: ["context.requestCompaction"],
  },
  {
    goal: "换下一轮的模型/思考档",
    mount: "`hooks.prepareNextTurn`",
    boundary: "在压缩阈值 early-return 之前 drain（AGENTS.md Rule 9.2 接线段）",
    seams: ["hooks.prepareNextTurn"],
  },
  {
    goal: "按请求改写出站上下文",
    mount: "`hooks.transformContext`",
    boundary: "对插件合法、对内核禁用：改写会让 live context 与 transcript 背离，且 usage 报低会压低压缩触发（Rule 5.6）",
    seams: ["hooks.transformContext"],
  },
  {
    goal: "写一条持久事实",
    mount: "`context.emitEvent`",
    boundary: "落进每会话 JSONL —— 唯一真相源；SSE/回放/桌面只读日志，总线只扇出控制面事件（Rule 7.3）",
    seams: ["context.emitEvent"],
  },
  {
    goal: "只读观察 agent 事件流",
    mount: "`instance.onAgentEvent`",
    boundary: "超时 + 故障隔离到单插件；不得阻塞或改写循环",
    seams: ["instance.onAgentEvent"],
  },
  {
    goal: "人机命令（不走模型轮次）",
    mount: "`instance.slashCommands`",
    boundary: "先声明 `manifest.slashCommands` 投影给消费端；输出进时间线，不作为 user prompt 发给模型",
    seams: ["cap:slash-command", "instance.slashCommands", "manifest.slashCommands"],
  },
  {
    goal: "有界、无状态的会话检视",
    mount: "`manifest.readActions` + `plugin.read`",
    boundary: "运行实例销毁后仍可用；generic route `GET /sessions/:id/capabilities/:pluginId/read/:actionId`",
    seams: ["cap:read-action", "manifest.readActions", "plugin.read"],
  },
  {
    goal: "桌面 UI",
    mount: "`manifest.ui`",
    boundary: "服务器只声明 placement（`surface:session-header` / `surface:dock`）与 renderer key，桌面编译期映射 —— 会话组件不按能力 id 分支（Rule 9.2）",
    seams: ["cap:ui", "manifest.ui", "surface:session-header", "surface:dock"],
  },
  {
    goal: "会话内共享服务",
    mount: "`instance.services`",
    boundary: "进程内插槽，不是协议边界（单体原则）",
    seams: ["instance.services"],
  },
  {
    goal: "插件参数化",
    mount: "`manifest.configSchema`",
    boundary: "默认值 ← 用户全局偏好合并后送达 `activate`；HTTP 边界拒未知键与错形状，「下次激活生效」如实提示",
    seams: ["manifest.configSchema"],
  },
  {
    goal: "外部可卸载产品能力",
    mount: "`<forgeHome>/plugins/*.plugin.{ts,js,mjs}`",
    boundary: "default export 一个 ForgePlugin；与内置同契约同页面；disabled = 不挂载；逐文件加载隔离",
    seams: [],
  },
  {
    goal: "不可关断的护栏",
    mount: "`src/guardrails/` → `multiplexHooks(core, …)` 的 core 槽",
    boundary: "不进插件路径：安全底线不接受用户可关断的挂载形态",
    seams: ["hooks.beforeToolCall", "hooks.afterToolCall", "hooks.shouldStopAfterTurn", "hooks.getSteeringMessages", "hooks.prepareNextTurn"],
  },
  {
    goal: "LLM provider / 循环 / 工具内核本身",
    mount: "Pi（vendored `pi/`，可直接改源；改后重建 dist）",
    boundary: "Rule 4.2：Pi 已有的能力不在 Forge 重建；接缝是便利不是墙",
    seams: [],
  },
];

function inventoryFor(prefix: string): Record<string, boolean> | null {
  switch (prefix) {
    case "hooks": return HOOK_INVENTORY;
    case "instance": return INSTANCE_INVENTORY;
    case "context": return CONTEXT_INVENTORY;
    case "manifest": return MANIFEST_INVENTORY;
    case "plugin": return PLUGIN_INVENTORY;
    case "cap": return CAPABILITY_INVENTORY;
    case "surface": return SURFACE_INVENTORY;
    default: return null;
  }
}

function validateSeamTokens(): void {
  for (const row of ROUTING) {
    for (const token of row.seams) {
      const match = /^([a-z]+)[.:](.+)$/.exec(token);
      if (!match) throw new Error(`routing seam token missing prefix: ${token}`);
      const inventory = inventoryFor(match[1]!);
      if (!inventory) continue; // non-slot token: prose, not a reference
      if (!(match[2]! in inventory)) {
        throw new Error(`routing table references unknown seam "${token}" — the plugin contract moved; refresh inventories and docs`);
      }
    }
  }
}

/** multiplexHooks must compose exactly the inventoried hooks — bidirectionally,
 * against the real function, so the multiplexer can't strand the catalog. */
async function verifyHookMultiplexing(): Promise<void> {
  const noop = async () => undefined;
  const core = Object.fromEntries(
    Object.keys(HOOK_INVENTORY).map((name) => [name, async () => { await Promise.resolve(); return noop(); }]),
  ) as unknown as PluginHooks;
  const muxed = Object.keys(multiplexHooks(core, [], async () => {})).sort();
  const inventory = Object.keys(HOOK_INVENTORY).sort();
  if (JSON.stringify(muxed) !== JSON.stringify(inventory)) {
    throw new Error(
      `hook multiplexing drifted from the catalog: multiplexer composes [${muxed.join(", ")}], inventory lists [${inventory.join(", ")}]`,
    );
  }
}

function validateObservedHooks(facts: Map<string, { hooks: string[] }>): void {
  for (const [id, fact] of facts) {
    for (const hook of fact.hooks) {
      if (!(hook in HOOK_INVENTORY)) {
        throw new Error(
          `plugin ${id} attached hooks.${hook}, which the kernel multiplexer never composes — a typo'd or stranded hook slot contributes nothing; remove the import`,
        );
      }
    }
  }
}

async function observe(): Promise<string> {
  validateSeamTokens();
  await verifyHookMultiplexing();
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
      validateObservedHooks(facts);
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
      const inventoryLine = (label: string, keys: string[]) =>
        `- **${label}**（${keys.length}）：${keys.map((k) => `\`${k}\``).join(" ")}`;
      const routingRows = ROUTING.map((row) =>
        `| ${row.goal} | ${row.mount} | ${row.boundary} |`,
      );
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
        "## 挂载插槽清单",
        "",
        "插件契约的全部挂载点。清单与类型双向锁死：少一个键或多一个键，`tsc` 即失败（tsconfig 覆盖 `scripts/`）。",
        "",
        inventoryLine("内核钩子 `PluginHooks`", Object.keys(HOOK_INVENTORY)),
        inventoryLine("运行时贡献 `PluginInstance`", Object.keys(INSTANCE_INVENTORY)),
        inventoryLine("激活上下文 `PluginSessionContext`", Object.keys(CONTEXT_INVENTORY)),
        inventoryLine("声明面 `PluginManifest`", Object.keys(MANIFEST_INVENTORY)),
        inventoryLine("插件对象 `ForgePlugin`", Object.keys(PLUGIN_INVENTORY)),
        inventoryLine("能力词 `PluginCapability`", Object.keys(CAPABILITY_INVENTORY)),
        inventoryLine("UI surface", Object.keys(SURFACE_INVENTORY)),
        "",
        "## 新增行为去处（路由表）",
        "",
        "| 目标 | 挂到哪 | 边界约束 |",
        "|---|---|---|",
        ...routingRows,
        "",
        "## 机器可查的声明",
        "",
        "- 上表`内核钩子`列的每个钩子都经内核 `multiplexHooks` 逐插件隔离聚合——**没有任何插件替换或包裹 agent loop**；插件钩子运行失败时被故障隔离，循环本身不受影响。",
        "- 内核自有护栏（guard policy、write journal、审批、卡死检测、watchdog、compaction）不在本表：它们是 AgentLoopConfig 内核钩子的实现，不是插件。",
        "- `transformContext` 内核不安装（Rule 5.6）；插件若声明它也会出现在钩子列，属合法扩展面。",
        "- read actions 经 `GET /sessions/:id/capabilities/:pluginId/read/:actionId` 提供有界、stateless 的检视；UI 列的 `dock` surface 直接成为会话右栏 tab。",
        "- 路由表引用的每个 `hooks.*` / `instance.*` / `context.*` / `manifest.*` / `plugin.*` / `surface:*` / 能力词都在生成时被解析：指向不存在的插槽即门禁失败。",
        "- 钩子清单经 `multiplexHooks` **运行时双向**核对：复用器组合的槽位集合必须恰等于清单集合——多一个（复用器私加槽位）或少一个（清单引用了复用器从不融合的钩子）都失败。",
        "- 插件若挂上清单外的钩子键（typo 会被复用器静默丢弃、贡献恒零），贡献表校验直接失败。",
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
