# Forge Agent Development Rules

## 1. Purpose

This document defines the non-negotiable development rules for agents
working on Forge. Read `docs/README.md` for the current design and
`docs/ENGINEERING-STANDARDS.md` for the change checklist. Code and tests decide
implementation details; update documentation when those details change.

---

## 2. Project Identity

Forge is not:

- a chatbot
- a coding assistant wrapper
- a Pi fork

Forge is:

A local Web Server engineering-agent platform that uses the LLM as its brain
and deterministic guardrails as its safety net. The browser workbench is the
user-facing surface; the server runs on the same machine as the projects.

The core value of Forge is:

- guardrails (permission + approval modes, write journal, stuck detection)
- usage/context tracking (token counters + compaction watermark)
- recovery (event log, crash resume, audit trail)

---

## 3. Architecture Principle

Two layers, one codebase.

## Agent Layer (Forge)

Responsible for:

- assembling Pi AgentLoopConfig with guardrail hooks
- guardrails: permission, approval, stuck detection
- event log + SSE streaming
- crash recovery
- HTTP API + browser workbench

## Runtime Layer (Pi)

Responsible for:

- LLM communication (multi-provider streaming)
- agent loop (query → tool calls → results → repeat)
- tool execution (read/write/edit/bash/grep)
- context compaction
- extension system

The seam:

```
Forge (guardrails) → AgentLoopConfig hooks → Pi (agent loop)
```

Forge injects guardrails as callbacks. Pi owns the loop. One loop, not two.

### Pi is vendored — part of this monolith

Pi is committed into this repo (`pi/`), directly modifiable, upstream optional. Forge's package.json declares the Pi packages as **npm workspaces** — `node_modules/@earendil-works/pi-*` are symlinks into `pi/packages/*`, so **editting `pi/` source changes what Forge runs** (rebuild the package's `dist` after editing; the build artifacts are git-tracked).

The Forge/Pi seam above is a convenience, not a wall.

- When Pi's internals are the cheaper path, modify Pi directly instead of building adapters in Forge.
- Keep `pi/` edits concentrated and recorded in docs, so optional upstream sync stays affordable. This is economics, not ideology.
- Keep Pi's own test suites green — their internal coherence protects the vendored runtime.

## Monolith Principle

Forge is a big monolith. In-process module boundaries are NOT protocol boundaries.

- The compiler is the contract. No versioning, no migration, no deprecation windows for in-process types.
- The only two real boundaries: browser ↔ local server (HTTP/SSE) and code ↔ disk (JSONL / session files — forward-only compatibility discipline applies here, and only here).
- In-process event distribution uses the observer pattern (EventBus), justified by "publishers must not import subscriber modules" — not by "protocol independence".

---

## 4. Integration Rules

Pi is imported in-process as npm packages.

- `@earendil-works/pi-agent-core` — agent loop + types
- `@earendil-works/pi-ai` — multi-provider LLM API
- `@earendil-works/pi-coding-agent` — tools + extensions

### Rule 4.1

Forge guardrails are Pi AgentLoopConfig callbacks, not an outer loop.

Bad: Forge runs its own `while not done` loop around Pi.

Good: Forge assembles `AgentLoopConfig` with the five kernel guardrail hooks — `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` / `getSteeringMessages` (steering drain) / `prepareNextTurn` (compaction + mid-session switch drain) — and calls `agentLoop()`. (`transformContext` is deliberately not among them — see "Context is bounded" below.)

### Rule 4.2

Forge does not duplicate Pi capabilities.

Pi already has: agent loop, tools, compaction, multi-provider, streaming, extensions.

Forge adds: guardrails, event log, recovery, UI.

If Pi has it, use it. Don't rebuild.

### Rule 4.3

Prefer the published package API. Crossing into Pi internals is allowed when it is the cheaper path — the seam is a convenience, not a wall.

Preferred:

```
import { agentLoop } from "@earendil-works/pi-agent-core"
import type { AgentLoopConfig, AgentContext } from "@earendil-works/pi-agent-core"
```

Also allowed: modifying `pi/` source directly, or importing Pi internals, when the alternative is building an adapter layer in Forge. Precedent: the `<think>` leak fix was made inside `pi/`.

Discipline for crossing (economics, not purity):

- Keep `pi/` edits concentrated and recorded in a docs note.
- Keep Pi's own tests green after edits.
- Track one vendored copy — do not fork Pi's architecture.

---

## 5. Guardrail Rules

### Rule 5.1

The model's "done" is done. Do not add a client-side completion judge,
success-criteria evaluator or steer-back-on-failure loop. The run is bounded
by approval, stuck detection, error recovery and the user's Stop.

### Rule 5.2

Every tool call is checked before execution.

`beforeToolCall` hook:
1. Guard policy (capability classification + rule evaluation)
2. Write journal (backup file before write/edit; internal insurance, NOT a
   user-facing Undo. Backups under `<forgeHome>/undo/<sessionId>/` are manually
   recoverable.)
3. Approval relay (ask → workbench approval UI), gated by the session's approval
   mode — `ask` (every mutation asks), `default` (safe read-only bash
   whitelisted through, the rest asks; new-session default), `always` (nothing
   asks). The mode never relaxes a `deny`:
   the destructive floor (sudo, rm -rf /, ...) holds in every mode. Live
   switchable per session (`POST /sessions/:id/approval`), takes effect at
   the next tool call.

A denied tool call is blocked. A destructive tool call terminates the session.

### Rule 5.3

Stuck detection prevents infinite loops.

`afterToolCall` (via `StuckDetector`, over the tool-call history) detects:
- repeated action-observation pairs (4 times)
- repeated action-error pairs (4 times)
- alternating pattern A→B→A→B (6 times)

`shouldStopAfterTurn` detects:
- agent monologue without tool calls (4 consecutive turns, every session)

All four terminate the session with an honest `failureReason`
(`stuck detected: ...`), never a silent "completed".

### Rule 5.4

Usage and context are measured, not budgeted.

`UsageTracker` accumulates per-session token counters and keeps the context
watermark (`lastContextTokens`); `prepareNextTurn` reads the watermark — and the
transcript's own estimate — to trigger compaction. Spend limits belong to the
provider. There is no client-side cost or turn budget.

### Rule 5.5

Errors are recovered transparently.

`shouldStopAfterTurn` attempts recovery before surfacing errors:
- Output truncated → inject "continue" steering → retry (max 3)
- Empty response → inject "try again" steering → retry (max 3)
- API error → inject error info → retry (max 3)
- Recovery exhausted → error surfaced to user

This is the error withholding pattern: recovery succeeds = user never sees the error.

### Rule 5.6

Context is bounded, not cache-engineered.

Context is bounded by exactly one mechanism: Pi's compaction via
`prepareNextTurn`, triggered on **either** provider-reported per-turn usage
**or** the transcript's own script-aware estimate, against
`min(120K, modelWindow − 16K)`. Two signals, because usage describes the
*outgoing request* — which a plugin's `transformContext` may legitimately shrink,
and extensions are free to do that — and is simply absent on endpoints that
never report it. The estimate is the floor the kernel's promise stands on.
The kernel installs no `transformContext`: a per-request transform can rewrite the outgoing prompt
without touching the transcript, so the live context and the recorded one could
disagree — and because the provider then reported the *truncated* size, it also
held the compaction trigger below its own threshold. Multi-tier context
handling is normal (Claude Code, Cline); a tier that leaves no record is not.
A plugin may still contribute `transformContext`; the kernel does not.
Mid-session model/thinking switches drain in `prepareNextTurn` BEFORE the
compaction threshold early-return, so switching works regardless of context size.

Prompt-cache stability (tool-array sorting, system-prompt cache segments,
sticky latches, provider-specific cache strategies) is future work and lives
in Pi's protocol adapters when it happens — not in Forge hooks.

---

## 6. Command Safety Rules

### Rule 6.1

The model's completion is accepted. Forge constrains behavior before tools
execute; it does not run a second completion judge.

### Rule 6.2

Read-only bash commands are restricted.

Only these run automatically:
- project runners: npm/pnpm/yarn/bun test|lint|typecheck|build
- type checker: npx tsc --noEmit
- test runner: node --test
- read-only: cat, ls, head, tail, wc, stat, file, grep, diff, du, test

Anything else requires an explicit Guard allow rule.

### Rule 6.3

Every guard decision produces evidence.

```
What tool was requested?
Which policy decided it?
What was the result?
```

---

## 7. Event Rules

### Rule 7.1

All agent events are logged.

Pi's event stream is consumed and written to a per-session JSONL event log.

The log is the source of truth for:
- SSE streaming (replay + tail follow)
- crash recovery
- audit trail

### Rule 7.2

Event log writes are FIFO-ordered.

Concurrent `appendFile` calls race in the libuv threadpool. Per-session Promise chain ensures call-order persistence.

### Rule 7.3

The EventBus is a fan-out of the event log, not a second source of truth.

`appendEvent` writes to the JSONL log, then fans out control-plane events (`isControlEvent`) to the in-process `defaultBus`. Data-plane events (TURN / MESSAGE / TEXT_DELTA / TOOL families) stay in the log only — in-process listeners must not be flooded by per-turn data volume.

SSE and the browser workbench read the log, never the bus. Subscriber count today is zero: when a feature needs the bus, subscribe in the module that needs it — no new machinery, no protocol layers.

---

## 8. Recovery Rules

### Rule 8.1

Sessions are recoverable.

A crashed session can be resumed because:
- session state is persisted (session.json)
- event log has the full history (events.jsonl)
- write journal has before-image backups (journal.jsonl — internal insurance,
  manually recoverable; not a user-facing undo)

### Rule 8.2

Schema migrations are forward-only.

When the data model changes, `schema.ts` adds a migration. Old sessions are migrated on load.

---

## 9. UI Rules

### Rule 9.1

UI is the only entry point.

Users start the local server and use the browser workbench for agent work. They
do not need to use the API or event log directly.

UI determines what Forge can do. A guardrail capability without a UI entry point does not exist for the user.

The Web Server release binds to `127.0.0.1` only. Browser traffic is
same-origin; the per-process token is injected into local workbench HTML and
stored in a local handshake file. Treat a process on the same machine and a
page with access to that HTML as trusted. Keep Host/Origin checks, the token
gate and archive-install smoke coverage. Remote access or a public proxy
requires a separate security design; do not silently broaden the bind address.

### Rule 9.2

Every guardrail must have a UI entry point.

| Guardrail | UI component |
|---|---|
| Guard ask (approval) | Inline `ApprovalPanel` in the session + approval level in the run picker (每次询问 / 默认 / 始终允许) |
| Usage & context | header token meter (↑in ↓out · ctx watermark) |
| Stuck detection | In-place notice in the transcript |
| Steering | Mid-run input box |
| Streaming | SessionView (real-time conversation) |
| Context compaction | In-place notice on COMPACTION |
| Session management | Sidebar session list + `SessionView` status and Stop/Resume controls |
| Harness reliability | Registered session-header contribution + event-derived diagnostics panel |
| Workspace changes | Registered session-header contribution + Git change/diff panel |
| Project/workspace | Sidebar + project selector |
| Model config | SettingsPage |
| Run config (subscription + thinking) | ModelPicker popover — one trigger in Composer (new session) and in SessionView (mid-session); both switch live |
| Reasoning effort | Composer/ModelPicker level select (`thinkingLevel`, labelled 关/极低/低/中/高/极高/最大) — hidden when the model is not a reasoner |
| Abort/resume | Stop button + Resume button (completed = follow-up) |
| Capability lifecycle | Registered Capability Health panel (required/optional + active/disabled/failed/disposed + lifecycle) |
| Guard decision history | Registered session-header contribution, projected from `GUARD_DECISION` events |
| Plugin management (global) | PluginsPage 全局页（侧栏入口）— 目录 / 启停 / 配置表单；全局偏好持久化于 `<forgeHome>/plugin-prefs.json`，会话激活时与事件日志折叠合入 |
| User terminal | Registered `forge.terminal` dock contribution + generic capability request/SSE interactions; PTY cleanup follows session deletion/server shutdown |

The run-config popover holds **two orthogonal axes**. Do not merge them into
one control or reuse one name for another:

- **Model subscription** — which provider/model answers (`POST /sessions/:id/model`).
- **Reasoning effort** — how hard the *model* thinks before answering (`POST /sessions/:id/thinking`).

`thinkingLevel` is the reasoning-effort axis (`Session.thinkingLevel`, default
`medium`; `"off"` means the model is not asked to reason). It rides Pi's own
`ThinkingLevel` type — Forge does not invent a parallel scale. Wiring, end to
end: the HTTP handler validates against `THINKING_LEVEL_VALUES` and calls
`SessionManager.switchThinking`, which persists the level and parks it in the
`pendingThinking` slot for a running session; `makePrepareNextTurn` drains that
slot at each turn boundary and returns it as `AgentLoopTurnUpdate.thinkingLevel`;
`agent-loop.ts` writes it into `config.reasoning`; the protocol adapter
translates the level into the wire parameter (`thinking.budget_tokens` for
anthropic-messages, `reasoning.effort` for openai-responses, `reasoning_effort`
for openai-completions). `runAgent` only sets `config.reasoning` when
`model.reasoning && level !== "off"` — a non-reasoner sent `high` must go out
without the field, not with a bogus one.
The two switch checks must sit **before** the compaction threshold early-return
in `makePrepareNextTurn`, or mid-session switching only works once the context
is over budget.
Which levels a subscription actually supports comes from Pi's
`getSupportedThinkingLevels` (re-exported by `modelThinkingLevels` in
`model-resolver.ts`) and is shipped to the UI as `modelCapabilities` on
`GET /config`; the picker renders only those. `buildModel` must spread the
catalog entry first (`{ ...catalog, ... }`) — rebuilding the object by hand
drops `thinkingLevelMap`/`compat`, and the adapter then cannot translate levels.

**UI coding standard:** visual and theme styling lives in
`styles.css` as semantic classes — no inline `style={{}}` for colors, borders,
typography or state; state is expressed with `data-*` attributes
(`data-status`, `data-on`, `data-confirming`) and selected in CSS. Inline
styles are reserved for genuinely dynamic values (a dragged width, a dynamic
color mapping). Every surface renders designed empty/loading/error states —
a bare error string is not an error state. Microcopy states what the surface
does **not** claim, the same honesty the guardrails have ("不归因给
Agent", "配置下次激活时生效", "运行中的会话保留到释放").

The transcript is **one ordered timeline**, not parallel message/tool arrays.

The server streams a strictly ordered event log (`MESSAGE_STARTED` → `TEXT_DELTA`* →
`MESSAGE_ENDED`, with `TOOL_CALL` interleaved). `store.ts` folds it in order into
`ConversationView.timeline`; folding out of order loses both the position of tool
calls and the order of prompts across turns. Two invariants:

- Entry ids come from Pi's `message.timestamp` (stable), so replay is idempotent.
- A `seq` watermark drops frames already folded — the server has no
  `Last-Event-ID` support, so an SSE reconnect replays the log from the start.

To see the UI without launching the app, use the dev-only harness
(`desktop/preview.html`, not part of the vite build):

```
cd desktop && npm run dev
# /preview.html?scene=<session|thinking|landing|empty|settings|replay|notify|picker|health|audit|reliability|changes>&theme=<dark|light>
# add &hover=1 to reveal hover-only affordances (a screenshot cannot hover)
```

`scene=picker` renders the run-config popover open (`defaultOpen`), which is the
only way to see it without clicking.

`scene=replay` folds `desktop/src/__replay.ts` — captured frames from a real
session — through the real reducer, which is how ordering bugs are caught
without a live run.

`scene=notify&token=<token>&session=<id>` patches `document.hidden` and
`window.Notification`, then runs a REAL SSE stream, to check the task-outcome
notification path end to end. Notifications fire **only while the window is
hidden**: with the window visible the outcome is already on screen (timeline
notice and sidebar status), so a notification would be noise.
The server emits exactly one terminal event per run: `SESSION_ENDED`,
`SESSION_FAILED` or `SESSION_CANCELLED`. `payload.status` remains the
authoritative outcome for notification projection. A stale persisted
`running` record is repaired on startup with a non-terminal
`SESSION_INTERRUPTED` marker followed by one `SESSION_FAILED`, making the
existing Resume path available without inventing a second live runtime.

### Rule 9.3

Guardrails and UI are designed together. A new guardrail needs a policy or
hook, persisted evidence, HTTP/SSE transport, a truthful workbench projection
and tests across the affected boundary. See `docs/ENGINEERING-STANDARDS.md`.

---

## 10. Development Process

Before implementing any feature, answer:

1. What problem does this solve?
2. Is this a guardrail or a Pi capability?
3. Which AgentLoopConfig hook does it plug into?
4. What is the input?
5. What is the output?
6. What events are produced?
7. How is it tested?

Also identify the target release line before editing. On `main`, verify the
local Web Server path and installed archive when packaging or startup changes.
On `master`, use that branch's desktop-specific checks. Do not assume a fix on
one line automatically reaches the other.

---

## 11. Code Organization

Prefer:

- small modules
- clear ownership
- explicit interfaces
- guardrails as pure functions

Avoid:

- large services
- state in guardrails (state lives in Pi context + event log)
- cross-layer dependencies
- duplicating Pi functionality

---

## 12. Change Rules

Do not:

- rewrite unrelated modules
- introduce unnecessary frameworks
- change architecture without discussion

Prefer:

- minimal changes
- incremental commits
- preserving boundaries

## Branch discipline

`main` is the local Web Server release line and the GitHub default branch.
`master` is the separate desktop line. Both started from v1.1.0.
Shared kernel fixes must be deliberately ported between them.

Do not merge either release line wholesale into the other. Port shared fixes
as reviewed commits, then run the affected line's verification. Do not tag or
publish a release as a side effect of ordinary documentation work.

Work on a short-lived branch (`feat/...`, `fix/...`) when the change crosses layers or touches the hook contract.

Small, obviously-green changes may go directly to the affected release line.

---

## 13. Platform Development Goal

Prove that a new Forge-owned capability can join a real session without
duplicating Pi, adding product branches to the agent loop, weakening the
safety floor or creating a second source of truth.

Required flow:

```
User goal
    ↓
SessionManager activates session-scoped capabilities
    ↓
Forge assembles AgentLoopConfig guardrails + capability contributions
    ↓
Pi agentLoop queries the model and executes guarded tools
    ↓
ordered events → persistence → SSE → browser projection
    ↓
model done is accepted; session settles and resources are disposed
```

Do not add a completion verifier. Do not add a second loop. Do not put
removable product behavior in the kernel.

---

## 14. Final Principle

The intelligence comes from the LLM.

The trustworthiness comes from guardrails.

Do not build a state machine to replace LLM judgment.
Do not trust LLM judgment without guardrails.
