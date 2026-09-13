# Forge

> [English](README.md) | 简体中文

Forge 是一个开源、桌面优先的工程 Agent 平台。LLM 是大脑；Forge 在 Pi 的进程内
agent loop 周围提供确定性护栏、持久记录与崩溃恢复。

> **状态：Alpha。** 会话、护栏、恢复、上下文压缩与插件平台的主链路已经可用；
> 真实任务质量仍取决于所选模型。

## 架构

两层、一个代码库、一个 agent loop：

```
桌面端（React / Tauri）
        │ HTTP + 有序 SSE
Forge Agent 层
  护栏 · 事件日志 · 恢复 · 插件注册器
        │ AgentLoopConfig hooks + tools
内置 Pi Runtime
  模型流式通信 · agentLoop · 工具 · 压缩 · extensions
```

Pi 位于 `pi/`，通过 npm workspaces 直接链接。Forge 不在外面再套一层循环，也不对
模型的完成判断做二次猜测；但每次工具调用都必须经过权限策略、审批姿态和写入日志。
卡死检测、透明错误恢复与用户的 Stop 共同约束运行边界。

事件日志是 SSE 重放、审计和崩溃恢复的事实来源。Usage 只测量 token 与上下文水位，
不做客户端费用预算。

## 插件平台

凡是删除后不损伤机制完整性的能力，都应做成插件，而不是长进内核。当前会话级注册器
支持：

- 斜杠命令（`/compact`、`/status`、`/context`）；
- Pi 工具，包括在 Settings 配置的 MCP stdio server；
- 六个 `AgentLoopConfig` 护栏 hooks；
- agent 事件订阅与会话共享服务；
- UI 能力描述和时间线输出。

插件故障只会隔离当前会话里的该插件。核心安全 hooks 永远先执行，插件不能覆盖内置
工具名，MCP 工具也走同一条审批路径。详见[内部能力注册器](docs/INTERNAL-PLUGINS.md)。

## 安全与恢复

- 只读操作可自动执行；变更操作遵循会话审批级别，破坏性拒绝底线永不放宽。
- 文件写入前像备份保留在 Forge home 下，作为内部保险。用户级恢复依赖 git 与命令审批；
  Forge 不再宣称一个不完整的通用 Undo。
- 每个会话的 JSONL 日志严格 FIFO 写入，驱动重放、SSE 和恢复。
- 重复动作/错误、连续独白与挂起的 provider 调用会被如实终止，不会无限循环。

## 快速开始

要求：Node 22+；桌面壳还需要 Rust。

```bash
npm install
cd desktop && npm install && npm run tauri dev

# 只运行服务端
npm start
```

模型订阅、思考强度、审批姿态、项目与 MCP server 都从桌面 UI 配置。

## 开发

```bash
npm run typecheck
npm --prefix desktop run typecheck
bash scripts/release-check.sh
```

仓库规则见 [AGENTS.md](AGENTS.md)。产品边界先读[产品方向](docs/PRODUCT.md)，当前架构与
实现决策见 `docs/`。

## 目录

```
src/           Forge Agent 层、服务端、护栏与插件注册器
desktop/       Tauri v2 + React 桌面应用
pi/            内置 Pi runtime workspaces
scripts/       发布与开发检查
docs/          当前架构与开发文档
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
