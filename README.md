# Forge

> [简体中文](README.zh-CN.md) | English

Forge is an open-source, desktop-first engineering-agent platform. The LLM is
the brain; Forge supplies deterministic guardrails, durable records and crash
recovery around Pi's in-process agent loop.

> **Status: Alpha.** The main session, guardrail, recovery, compaction and
> plugin-platform paths are operational. Real-task quality still depends on
> the selected model.

## Architecture

Two layers, one codebase, one agent loop:

```
Desktop (React / Tauri)
        │ HTTP + ordered SSE
Forge agent layer
  guardrails · event log · recovery · plugin registry
        │ AgentLoopConfig hooks + tools
Vendored Pi runtime
  model streaming · agentLoop · tools · compaction · extensions
```

Pi is committed under `pi/` and linked through npm workspaces. Forge does not
wrap it in a second loop or second-guess model completion. Every tool call does
pass through Forge's permission policy, approval posture and write journal;
stuck detection, error recovery and the user's Stop bound a run.

The event log is the source of truth for SSE replay, audit and crash recovery.
Usage is measured as token/context telemetry, not a client-side spending
budget.

## Plugin platform

New removable capabilities belong in plugins rather than the kernel. The
session-scoped registry currently supports:

- slash commands (`/compact`, `/status`, `/context`);
- Pi tools, including MCP stdio servers configured in Settings;
- all six `AgentLoopConfig` guardrail hooks;
- agent-event subscribers and shared session services;
- bounded stateless read actions for on-demand inspection;
- UI capability descriptors and timeline output.

The first registered desktop contribution is Workspace Changes: it captures a
Git baseline, distinguishes preexisting dirty files and shows the final net
change summary plus an on-demand, bounded per-file diff without modifying the
agent loop or persisting full patches in the event log.

Plugin failures are isolated to that plugin in that session. Core safety hooks
run first, built-in tool names cannot be shadowed, and MCP tools follow the same
approval path as built-ins. See [the internal registry](docs/INTERNAL-PLUGINS.md).

## Safety and recovery

- Read-only operations may run automatically; mutations follow the selected
  approval mode. The destructive deny floor is never relaxed.
- File writes retain before-image backups under the Forge home directory as
  internal insurance. User-facing recovery is git plus command approvals;
  Forge does not claim a partial universal Undo.
- Per-session JSONL logs are FIFO ordered and drive replay, SSE and recovery.
- Repeated action/error patterns, monologues and hung provider calls terminate
  honestly instead of looping forever.

## Getting started

Requirements: Node 22+ and Rust for the desktop shell.

```bash
npm install
cd desktop && npm install && npm run tauri dev

# server only
npm start
```

Model subscriptions, reasoning effort, approval posture, projects and MCP
servers are exposed through the desktop UI.

## Development

```bash
npm run typecheck
npm --prefix desktop run typecheck
npm run reliability
bash scripts/release-check.sh
```

The repository rules live in [AGENTS.md](AGENTS.md). Start with the
[product direction](docs/PRODUCT.md) for the product boundary, then use
`docs/` for current architecture and implementation decisions.

## Layout

```
src/           Forge agent layer, server, guardrails and plugin registry
desktop/       Tauri v2 + React desktop application
pi/            vendored Pi runtime workspaces
scripts/       release and development checks
docs/          current architecture and development documentation
```

## License

MIT — see [LICENSE](LICENSE).
