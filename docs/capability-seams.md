<!-- generated: capability-seams -->

# Capability seams（机器生成）

> 由 `scripts/gen-capability-seams.ts` 从**活的内置注册表**提取：每个插件被真实激活，
> 其运行时贡献作为事实记录在下表。改动插件面后运行 `npm run gen:seams` 重新生成；
> 门禁的 `capability seams fresh` 项校验本文件未过期。

## 能力 → 运行时贡献

| 插件 | 必需 | 内核钩子（经复用器） | 工具 | 斜杠命令 | 会话服务 | 事件订阅 | read actions | UI | 配置键 |
|---|---|---|---|---|---|---|---|---|---|
|`forge.session-commands`| | —| —| `/compact` `/status` `/context`| —| —| —| —| — |
|`forge.usage`| ✓| —| —| —| `usage`| ✓| —| —| — |
|`forge.capability-health`| ✓| —| —| —| —| —| —| session-header:`capability-health`| — |
|`forge.guard-audit`| ✓| —| —| —| —| —| —| session-header:`guard-audit`| — |
|`forge.reliability`| ✓| —| —| —| —| —| `metrics`| session-header:`reliability`| — |
|`forge.workspace-changes`| | —| —| —| —| ✓| `diff`| session-header:`workspace-changes`| `gitTimeoutMs` `diffMaxBytes` |
|`forge.workspace-files`| | —| —| —| —| —| `list` `read`| dock:`workspace-files`| — |

## 挂载插槽清单

插件契约的全部挂载点。清单与类型双向锁死：少一个键或多一个键，`tsc` 即失败（tsconfig 覆盖 `scripts/`）。

- **内核钩子 `PluginHooks`**（6）：`beforeToolCall` `afterToolCall` `shouldStopAfterTurn` `getSteeringMessages` `transformContext` `prepareNextTurn`
- **运行时贡献 `PluginInstance`**（6）：`tools` `hooks` `slashCommands` `onAgentEvent` `services` `dispose`
- **激活上下文 `PluginSessionContext`**（5）：`session` `signal` `emitEvent` `enqueueSteering` `requestCompaction`
- **声明面 `PluginManifest`**（10）：`id` `name` `version` `description` `required` `capabilities` `slashCommands` `ui` `readActions` `configSchema`
- **插件对象 `ForgePlugin`**（3）：`manifest` `activate` `read`
- **能力词 `PluginCapability`**（6）：`slash-command` `tool` `guardrail` `event-subscriber` `ui` `read-action`
- **UI surface**（2）：`session-header` `dock`

## 新增行为去处（路由表）

| 目标 | 挂到哪 | 边界约束 |
|---|---|---|
| 给模型一项新能力 | 插件 `instance.tools` | 与 Pi 内置工具同过 `beforeToolCall` 守护通道；名称冲突注册期拒绝，Pi 内置工具名保留 |
| 检查或拦截一次工具调用 | `hooks.beforeToolCall` | 内核 guard 恒先执行；插件只能追加拒绝与证据，不能放宽 destructive 底线（Rule 5.2） |
| 修补工具结果或终结运行 | `hooks.afterToolCall` | 各插件补丁逐层合并，`terminate` 一经置位不可被后来的插件洗掉 |
| 在轮次边界停下 | `hooks.shouldStopAfterTurn` | 任一 true 即终止并如实写 failureReason；stuck 守护与错误恢复在内核（Rules 5.3/5.5） |
| 运行中注入引导消息 | `context.enqueueSteering` | steering 进 transcript、留下持久记录 —— 这正是内核不用 `transformContext` 的理由（Rule 5.6） |
| 请求压缩 | `context.requestCompaction` | 插件只请求；触发判定在内核 `prepareNextTurn`（usage 与 transcript 估计双信号水位） |
| 换下一轮的模型/思考档 | `hooks.prepareNextTurn` | 在压缩阈值 early-return 之前 drain（AGENTS.md Rule 9.2 接线段） |
| 按请求改写出站上下文 | `hooks.transformContext` | 对插件合法、对内核禁用：改写会让 live context 与 transcript 背离，且 usage 报低会压低压缩触发（Rule 5.6） |
| 写一条持久事实 | `context.emitEvent` | 落进每会话 JSONL —— 唯一真相源；SSE/回放/桌面只读日志，总线只扇出控制面事件（Rule 7.3） |
| 只读观察 agent 事件流 | `instance.onAgentEvent` | 超时 + 故障隔离到单插件；不得阻塞或改写循环 |
| 人机命令（不走模型轮次） | `instance.slashCommands` | 先声明 `manifest.slashCommands` 投影给消费端；输出进时间线，不作为 user prompt 发给模型 |
| 有界、无状态的会话检视 | `manifest.readActions` + `plugin.read` | 运行实例销毁后仍可用；generic route `GET /sessions/:id/capabilities/:pluginId/read/:actionId` |
| 桌面 UI | `manifest.ui` | 服务器只声明 placement（`surface:session-header` / `surface:dock`）与 renderer key，桌面编译期映射 —— 会话组件不按能力 id 分支（Rule 9.2） |
| 会话内共享服务 | `instance.services` | 进程内插槽，不是协议边界（单体原则） |
| 插件参数化 | `manifest.configSchema` | 默认值 ← 用户全局偏好合并后送达 `activate`；HTTP 边界拒未知键与错形状，「下次激活生效」如实提示 |
| 外部可卸载产品能力 | `<forgeHome>/plugins/*.plugin.{ts,js,mjs}` | default export 一个 ForgePlugin；与内置同契约同页面；disabled = 不挂载；逐文件加载隔离 |
| 不可关断的护栏 | `src/guardrails/` → `multiplexHooks(core, …)` 的 core 槽 | 不进插件路径：安全底线不接受用户可关断的挂载形态 |
| LLM provider / 循环 / 工具内核本身 | Pi（vendored `pi/`，可直接改源；改后重建 dist） | Rule 4.2：Pi 已有的能力不在 Forge 重建；接缝是便利不是墙 |

## 机器可查的声明

- 上表`内核钩子`列的每个钩子都经内核 `multiplexHooks` 逐插件隔离聚合——**没有任何插件替换或包裹 agent loop**；插件钩子运行失败时被故障隔离，循环本身不受影响。
- 内核自有护栏（guard policy、write journal、审批、卡死检测、watchdog、compaction）不在本表：它们是 AgentLoopConfig 内核钩子的实现，不是插件。
- `transformContext` 内核不安装（Rule 5.6）；插件若声明它也会出现在钩子列，属合法扩展面。
- read actions 经 `GET /sessions/:id/capabilities/:pluginId/read/:actionId` 提供有界、stateless 的检视；UI 列的 `dock` surface 直接成为会话右栏 tab。
- 路由表引用的每个 `hooks.*` / `instance.*` / `context.*` / `manifest.*` / `plugin.*` / `surface:*` / 能力词都在生成时被解析：指向不存在的插槽即门禁失败。
- 钩子清单经 `multiplexHooks` **运行时双向**核对：复用器组合的槽位集合必须恰等于清单集合——多一个（复用器私加槽位）或少一个（清单引用了复用器从不融合的钩子）都失败。
- 插件若挂上清单外的钩子键（typo 会被复用器静默丢弃、贡献恒零），贡献表校验直接失败。

<!-- /generated: capability-seams -->
