# Forge Agent Development Rules

## 1. Purpose

This document defines the development rules for AI coding agents working on Forge.

The purpose is to prevent architectural drift during development.

Every implementation decision must respect these rules.

---

## 2. Project Identity

Forge is not:

- a chatbot
- a coding assistant wrapper
- a Pi fork

Forge is:

A desktop engineering agent that uses LLM as brain and deterministic guardrails as safety net.

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
- HTTP API + desktop UI

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

- When Pi's internals are the cheaper path, modify Pi directly instead of building adapters in Forge (precedent: the `<think>` leak fix in Pi's openai-completions protocol).
- Keep `pi/` edits concentrated and recorded in docs, so optional upstream sync stays affordable. This is economics, not ideology.
- Keep Pi's own test suites green — Pi's internal coherence protects the 300k+ lines we depend on.

## Monolith Principle

Forge is a big monolith. In-process module boundaries are NOT protocol boundaries.

- The compiler is the contract. No versioning, no migration, no deprecation windows for in-process types.
- The only two real boundaries: desktop ↔ server (HTTP/SSE — a Tauri process-model detail, not a service boundary) and code ↔ disk (JSONL / session files — forward-only compatibility discipline applies here, and only here).
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

Good: Forge assembles `AgentLoopConfig` with the six guardrail hooks — `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` / `getSteeringMessages` (steering drain) / `transformContext` (context guard) / `prepareNextTurn` (compaction + mid-session switch drain) — and calls `agentLoop()`.

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

The model is the strongest brain — its "done" IS done.
(2026-09-12: the entire client-side completion-verification apparatus —
trust levels, success criteria, the deterministic evaluator, the
steer-back-on-fail loop and the verification panel — is retired. It
second-guessed the model with brittle scripted checks and manufactured
approval noise. What bounds a run is Rule 5.3 stuck detection, Rule 5.5
error recovery, the approval gate on dangerous commands, and the user's
Stop.)

### Rule 5.2

Every tool call is checked before execution.

`beforeToolCall` hook:
1. Guard policy (capability classification + rule evaluation)
2. Write journal (backup file before write/edit — internal insurance that
   justifies auto-allowing file writes; NOT a user-facing undo. The Diff/Undo
   product surface was removed 2026-09-11: a partial undo that reads as
   complete is worse than none. User-facing recovery = git + command approvals.
   Backups remain on disk under `<forgeHome>/undo/<sessionId>/`, manually
   recoverable.)
3. Approval relay (ask → desktop dialog), gated by the session's approval
   mode — `ask` (every mutation asks, the old behavior), `default` (safe
   read-only bash whitelisted through, the rest asks; the new-session
   default), `always` (nothing asks). The mode never relaxes a `deny`:
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
- agent monologue without tool calls (4 consecutive turns) — task sessions
  every session — there is no conversation kind to exempt (PM, 2026-09-12:
  不做分流，所有输入都进执行型 agent; the old conversation exemption is retired)

All four terminate the session with an honest `failureReason`
(`stuck detected: ...`), never a silent "completed".

### Rule 5.4

Usage and context are measured, not budgeted (2026-09-11: the client-side
cost budget was removed — price estimation was blind for custom endpoints
and no UI path ever set a budget, so the breaker never fired).

`UsageTracker` accumulates per-session token counters and keeps the context
watermark (`lastContextTokens`); `prepareNextTurn` reads the watermark to
trigger compaction. Spend limits belong to the provider. There is no
client-side budget of any kind (the turn budget was retired 2026-09-12 — like
the cost budget, it had no UI entry and therefore never fired): what bounds a
run is the stuck guard, the model's own completion, and the user's Stop.

### Rule 5.5

Errors are recovered transparently (参考 Claude Code).

`shouldStopAfterTurn` attempts recovery before surfacing errors:
- Output truncated → inject "continue" steering → retry (max 3)
- Empty response → inject "try again" steering → retry (max 3)
- API error → inject error info → retry (max 3)
- Recovery exhausted → error surfaced to user

This is the error withholding pattern: recovery succeeds = user never sees the error.

### Rule 5.6

Context is bounded, not cache-engineered (2026-09-11: honest scope statement —
the Claude-Code-style prompt-cache strategy below was aspirational and is NOT
implemented; do not re-add it to this document until it ships).

`transformContext` is a coarse last-resort guard: character-derived token
estimate with a blunt LastN truncation past the soft window. Primary context
management is Pi's compaction via `prepareNextTurn` (real per-turn usage data).
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

SSE and the desktop read the log, never the bus. Subscriber count today is zero: when a feature needs the bus, subscribe in the module that needs it — no new machinery, no protocol layers.

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

Users never touch CLI, API, or event log. Everything flows through the desktop UI.

UI determines what Forge can do. A guardrail capability without a UI entry point does not exist for the user.

### Rule 9.2

Every guardrail must have a UI entry point.

| Guardrail | UI component |
|---|---|
| Guard ask (approval) | ApprovalDialog (real-time popup) + 审批 level in the run picker (每次询问 / 默认 / 始终允许) |
| Usage & context | header token meter (↑in ↓out · ctx watermark) |
| Stuck detection | In-place notice in the transcript |
| Steering | Mid-run input box |
| Streaming | SessionView (real-time conversation) |
| Context compaction | In-place notice on COMPACTION |
| Session management | SessionList + StatusBar |
| Project/workspace | Sidebar + project selector |
| Model config | SettingsPage |
| Run config (subscription + thinking) | ModelPicker popover — one trigger in Composer (new session) and in SessionView (mid-session); both switch live |
| Reasoning effort | Composer/ModelPicker level select (`thinkingLevel`, labelled 关/极低/低/中/高/极高/最大) — hidden when the model is not a reasoner |
| Abort/resume | Stop button + Resume button (completed = follow-up) |
| Capability lifecycle | Session capability panel (required/optional + active/disabled/failed/disposed) |
| Guard decision history | Session header audit panel, projected from `GUARD_DECISION` events |

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
# /preview.html?scene=<session|thinking|landing|empty|settings|replay|notify|picker>&theme=<dark|light>
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
The server emits exactly two terminal event types — `SESSION_FAILED`, and
`SESSION_ENDED` for everything else including cancellation, which is why
`payload.status` (not the event type) decides the outcome.

### Rule 9.3

Guardrails and UI are designed together.

Build order:
1. Agent runner (Pi loop + hooks)
2. Guardrails + event types + HTTP API (同期 — 护栏产出事件，API 传输事件，UI 消费事件)
3. Stuck detection
4. Desktop UI (consume event stream + collect user input)
5. Recovery + compaction + steering
6. Benchmark

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

`master` is always releasable (default branch since 2026-09-08; the old `main` is frozen).

Work on a short-lived branch (`feat/...`, `fix/...`) when the change crosses layers or touches the hook contract.

Small, obviously-green changes go directly to `master`.

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
ordered events → persistence → SSE → desktop projection
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
