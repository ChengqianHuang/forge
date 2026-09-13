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
- Session JSON: recoverable session metadata and the last persisted counters.
- Event JSONL: authoritative ordered history for replay, SSE and audit.
- EventBus: low-volume control-event fan-out after persistence; never an
  alternative source of truth.
- Desktop store: a projection of server records and SSE events, not authority.

The JSONL append path checks an existing crash tail before the first write in
each process. A complete final record missing only its newline is preserved;
an incomplete final record is truncated to the previous committed line.
Readers may ignore only that unterminated tail — corruption in the middle of a
log remains a hard error. The SSE follower advances its byte offset only past
complete lines, so observing an in-progress append cannot drop an event.

## Context management

Pi compaction in `prepareNextTurn` is the primary mechanism. Provider-reported
per-turn usage decides when to compact. `transformContext` is a coarse
last-resort bound based on estimated size.

Model and reasoning-effort switches are drained before the compaction threshold
check so they work at every turn boundary. `/compact` sets a one-shot explicit
request for the next boundary.

## Recovery

The event log reconstructs coherent messages after a crash. Session state is
then relaunched through the same runner and guardrails. File before-images under
the Forge home directory are internal insurance; they are not represented as a
complete user-facing Undo feature.
