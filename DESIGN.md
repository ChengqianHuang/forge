# Forge Design

Forge is a desktop engineering agent. Pi owns the agent loop and model
interaction; Forge makes that loop safe, observable, and recoverable.

## Runtime shape

```text
Desktop (React / Tauri)
        │ HTTP + SSE
SessionManager
        │
runAgent → Pi agentLoop
        ↑
Forge AgentLoopConfig hooks
```

`runAgent` assembles Pi's `AgentLoopConfig` and calls `agentLoop()` once. Forge
does not run a second planner, executor, or completion state machine.

## Guardrails

- `beforeToolCall`: Guard policy, approval posture, write journal, and the
  destructive-command floor.
- `afterToolCall`: repeated action/result and alternating-loop detection.
- `shouldStopAfterTurn`: transparent retries for transient provider failures,
  empty output, and truncation. The model stopping normally ends the run.
- `getSteeringMessages`: drains operator steering between turns.
- `transformContext` and `prepareNextTurn`: context protection, token tracking,
  compaction, and live model/reasoning switches.

The model is the strongest brain: its normal completion is accepted. Forge
constrains behavior and records evidence rather than second-guessing result
quality with a separate deterministic evaluator.

## Session model

`Session` is the durable unit: goal, workspace, model, transcript, status,
approval mode, reasoning level, and token/context usage. Session states are
`running`, `completed`, `failed`, and `cancelled`.

The JSONL event log is the source of truth for transcript replay, SSE, crash
recovery, and audit. Per-session FIFO appends preserve the exact Pi event order.

## User controls

- model subscription and reasoning effort;
- approval posture: ask, default, or always (never bypassing destructive deny);
- steering while a run is active;
- Stop and resume/follow-up;
- token and context-watermark visibility.

## Recovery

On resume, Forge reconstructs complete messages from `MESSAGE_ENDED` events,
hydrates usage counters, and launches a fresh Pi loop. Half-written streamed
messages are deliberately excluded from the recovered transcript.
