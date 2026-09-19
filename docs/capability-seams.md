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

## 机器可查的声明

- 上表`内核钩子`列的每个钩子都经内核 `multiplexHooks` 逐插件隔离聚合——**没有任何插件替换或包裹 agent loop**；插件钩子运行失败时被故障隔离，循环本身不受影响。
- 内核自有护栏（guard policy、write journal、审批、卡死检测、watchdog、compaction）不在本表：它们是 AgentLoopConfig 内核钩子的实现，不是插件。
- `transformContext` 内核不安装（Rule 5.6）；插件若声明它也会出现在钩子列，属合法扩展面。
- read actions 经 `GET /sessions/:id/capabilities/:pluginId/read/:actionId` 提供有界、stateless 的检视；UI 列的 `dock` surface 直接成为会话右栏 tab。

<!-- /generated: capability-seams -->
