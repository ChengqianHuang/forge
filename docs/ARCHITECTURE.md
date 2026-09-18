# Architecture

## System identity

Forge has two layers in one monolithic repository:

```
Desktop UI (React inside Tauri)
        │ HTTP commands + ordered SSE events
Forge agent layer
  session manager · guardrails · event log · recovery · internal registry
        │ AgentLoopConfig hooks + tools
Pi runtime (vendored npm workspaces)
  provider streaming · agentLoop · tool execution · compaction · extensions
```

There is one agent loop. Pi owns it. Forge constructs its context and
`AgentLoopConfig`, injects guardrail callbacks and consumes the resulting event
stream. Forge must never wrap Pi in a second orchestration loop.

Pi lives in `pi/`. Workspace links make its source part of the running product.
Pi can be edited when that is cheaper and clearer than a Forge adapter, but Pi
tests and tracked build output must remain coherent.

## Real boundaries

Only two boundaries require compatibility discipline:

- Desktop ↔ server: HTTP and SSE, caused by Tauri's process model.
- Code ↔ disk: session JSON and per-session JSONL event logs.

Ordinary TypeScript modules are not services. The compiler is their contract;
they do not need protocol versions or migration layers.

## Session flow

1. The desktop creates a session with a goal, project, model subscription,
   reasoning effort and approval posture.
2. `SessionManager` persists the session and creates one live runtime object.
3. Forge activates its compiled-in capabilities for that session.
4. `runAgent` builds Pi coding tools, adds internal tool contributions, composes
   the six hooks and calls `agentLoop`.
5. Pi streams agent events. Forge writes mapped events to JSONL in FIFO order.
6. SSE replays and tails that log; the desktop folds it into one ordered
   conversation timeline.
7. On completion, failure, Stop or timeout, Forge persists terminal state and
   disposes the session runtime.

The model's decision to stop is accepted as completion. Forge does not run a
second deterministic completion judge.

## State ownership

- `SessionManager`: live run ownership, model/thinking switches, steering,
  watchdog, Stop and settlement.
- Pi context: in-memory transcript and active tool/model state during a run.
- Session JSON: recoverable metadata and counters only. It never stores the
  model transcript.
- Event JSONL: authoritative ordered model history for recovery, plus SSE and
  audit evidence. `Session.messages` is only its live Pi-facing projection.
- EventBus: low-volume control-event fan-out after persistence; never an
  alternative source of truth.
- Desktop store: a projection of server records and SSE events, not authority.

Compiled-in UI capabilities cross the desktop/server boundary as small
descriptors (`surface` + `renderer`), returned with the session capability
snapshot. The desktop resolves renderer keys through one registry. This keeps
feature-specific buttons out of `SessionView` while preserving a reviewed,
first-party component set rather than allowing arbitrary remote UI code.

Descriptors may also name a manifest-declared read action. A generic HTTP
route dispatches bounded, stateless inspection through the registry, including
after a session runtime has been disposed. The plugin owns the data semantics
and validation; the kernel knows only plugin id, action id, session context and
timeout. Large or transient views such as a per-file Git patch therefore stay
out of the durable event log without adding feature-specific server routes.

Capability lifecycle is projected by `forge.capability-health`. The desktop
folds ordered `PLUGIN_*` events into current state plus an inspection history;
the server capability snapshot supplies manifest metadata and truthful live or
disposed status. Required failures are shown as mechanism degradation, while
optional failures are shown as isolated and do not stop the agent loop. No
automatic retry or parallel health store is introduced.

Guard decisions follow the same rule. The core hook writes an attributed
`GUARD_DECISION`, and any contributed guard that subsequently blocks writes a
second decision under its own guard id. The desktop audit panel folds those
events by stable decision id. Its button and panel belong to the required
`forge.guard-audit` UI capability; guard execution and durable evidence remain
kernel-owned. Reconnect replay is idempotent and never invokes the policy
evaluator again.

The JSONL append path checks an existing crash tail before the first write in
each process. A complete final record missing only its newline is preserved;
an incomplete final record is truncated to the previous committed line.
Readers may ignore only that unterminated tail — corruption in the middle of a
log remains a hard error. The SSE follower advances its byte offset only past
complete lines, so observing an in-progress append cannot drop an event.

Schema v9 moves legacy snapshot messages into JSONL on first load. The import
is serialized per session and commits the whole transcript in one
`SESSION_HISTORY_IMPORTED` replacement event before a later save removes the
old JSON field. The event is data-plane because its payload may be large.
Concurrent list/get calls cannot import the same history twice, and a crash
cannot leave a partially imported transcript that looks complete.

## Context management

Pi compaction in `prepareNextTurn` is the only mechanism that changes what the
model sees. It compacts above `min(120K, modelWindow − 16K)` when **either**
provider-reported per-turn usage crosses that line **or** the transcript's own
script-aware estimate does. Two signals on purpose: usage describes the outgoing
request, which an extension's view transform may legitimately shrink, and is
absent on endpoints that never report it — neither can be allowed to leave a run
uncompacted until it dies at the window. The window always clamps, so a narrow
model compacts early instead of dying at its own limit. The kernel installs no
`transformContext` (removed 2026-09-18): a per-request transform truncated the
outgoing prompt without leaving a record, which diverged from the transcript
*and* — because the provider then reported the truncated size — held this
trigger below its own threshold.

A successful `COMPACTION` event carries the complete post-compaction model
context. Recovery folds that event as a replacement boundary, then appends
later completed messages. Without this durable replacement, a resumed run
would silently restore the pre-compaction context.

Model and reasoning-effort switches are drained before the compaction threshold
check so they work at every turn boundary. `/compact` sets a one-shot explicit
request for the next boundary.

## Recovery

The event log reconstructs coherent messages after a crash, ignoring a message
that never reached its terminal event. Session metadata supplies the selected
model, reasoning effort, approval posture, workspace, status and usage counters;
the reconstructed projection is then relaunched through the same runner and
guardrails. Running configuration changes mutate that single live Session
object, so terminal settlement cannot overwrite a user's change with an older
snapshot. File before-images under the Forge home directory are internal
insurance; they are not represented as a complete user-facing Undo feature.

At server startup, a persisted `running` session with no live runtime is
reclassified as a resumable failure and records `SESSION_INTERRUPTED` plus one
terminal `SESSION_FAILED`. During a live run, success, error, watchdog timeout,
user Stop and shutdown converge on one idempotent finalizer. Stop has precedence
over later errors, the runtime event gate closes before teardown, pending
approvals are expired, and plugin/process cleanup is bounded. Stop and the
watchdog are each bounded by their own grace timer (`cancelGraceMs` /
`timeoutGraceMs`), so a runner that ignores the abort signal is still settled —
as `failed` with the idle-timeout reason, never as `cancelled`, which would
blame the user for a run they did not stop. A late provider result therefore
cannot reopen or double-settle a settled session.

## Reliability projection

The required `forge.reliability` capability computes harness measurements from
the event log rather than storing a parallel telemetry database. Its generic
read action checks event identity/order, run-to-terminal cardinality, tool
call/result pairing, core-guard coverage, approval settlement, cancellation
convergence, recovery markers and plugin failures. The kernel has no dedicated
reliability method or HTTP route. These are Forge mechanism invariants;
generated text and model task quality are deliberately outside the projection.
