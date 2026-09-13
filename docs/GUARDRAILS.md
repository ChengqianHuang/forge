# Guardrails

Forge trusts model judgment about what to do and when it is done. It constrains
actions before they affect the user's machine and terminates mechanically bad
runtime behavior.

## Six Pi hook slots

Forge composes these `AgentLoopConfig` callbacks:

| Hook | Forge responsibility |
|---|---|
| `beforeToolCall` | Policy decision, write journal and approval relay |
| `afterToolCall` | Record action/observation history and detect repetition |
| `shouldStopAfterTurn` | Stuck termination and bounded transparent recovery |
| `getSteeringMessages` | Drain user guidance at a turn boundary |
| `transformContext` | Coarse emergency context bound |
| `prepareNextTurn` | Model/thinking switches and Pi compaction |

Core safety hooks run before internal plugin hooks. A core denial or termination
cannot be relaxed by a plugin contribution.

## Tool policy

Every tool call is classified and produces decision evidence. Built-in reads
are allowed. Writes and edits are journalled before execution. Bash, git,
network and unknown tools follow policy rules and the session approval posture.

Approval modes:

- `ask`: ask for every policy-classified mutation.
- `default`: allow the conservative read-only shell whitelist; ask for the rest.
- `always`: skip asks, while preserving explicit denies.

The destructive deny floor applies in every mode. Unknown tools—including MCP
tools without a specific allow rule—default to asking.

## Stuck detection

Forge stops honestly with a failure reason when it sees:

- the same action/observation four times;
- the same action/error four times;
- an A/B alternating action pattern six times;
- four consecutive model-only turns without a tool call.

This bounds loops; it does not judge whether the model's finished work is good.

## Error recovery

Output truncation, empty responses and provider errors receive bounded steering
retries. Successful recovery remains invisible noise; exhausted recovery is
surfaced to the user. The session watchdog separately aborts a provider call
that produces no activity for the configured interval.

## Usage

Usage is telemetry, not a budget. The built-in usage capability records
cumulative input/output/cache tokens and the latest context watermark. Provider
spend limits remain the provider's responsibility.
