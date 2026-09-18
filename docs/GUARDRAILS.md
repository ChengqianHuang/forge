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

`GUARD_DECISION` is the durable audit fact for a guard's decision on a call. It
records a stable decision id and guard id, the tool-call id, classified
capability, matched rule, original policy action, effective action after the
approval posture, outcome, basis and a bounded input summary. Outcomes are
`allowed`, `approved`, `rejected`, `denied` or `aborted`. A contributed guard
that blocks after the core guard allowed writes its own attributed decision;
the audit UI must not misrepresent the earlier core decision as the whole
pipeline's conclusion.
`GUARD_APPROVAL_REQUEST` remains the real-time prompt signal and
`GUARD_BLOCKED` remains the explicit policy-block marker; neither substitutes
for the final decision record.

Approval modes:

- `ask`: ask for every policy-classified mutation.
- `default`: allow the conservative safe-command whitelist; ask for the rest.
- `always`: skip asks, while preserving explicit denies.

The default whitelist is deliberately finite: `cat`, `ls`, `head`, `tail`,
`wc`, `stat`, `file`, `grep`, `diff`, `du`, shell `test`; read-only Git
inspection; `npm`/`pnpm`/`yarn`/`bun` `test|lint|typecheck|build`;
`npx tsc --noEmit`; and `node --test`. Every segment of a compound command
must independently qualify. Redirection, substitution, mutation-capable Git
forms and write-capable output flags fall back to approval.

The destructive deny floor applies in every mode. Unknown tools—including MCP
tools without a specific allow rule—default to asking.

The desktop Guard audit panel is a projection of these persisted decisions. It
does not re-evaluate old tool calls against today's policy, because that would
rewrite history rather than inspect it.

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
that produces no activity for the configured interval, and force-settles the
session as `failed` after a bounded grace if the runner does not honour that
abort — a hung run is never left `running`, and it is never recorded as a user
cancellation.

## Usage

Usage is telemetry, not a budget. The built-in usage capability records
cumulative input/output/cache tokens and the latest context watermark. Provider
spend limits remain the provider's responsibility.

## Compaction durability

Compaction changes the context seen by the model, so it is a recovery fact, not
just a UI notice. Every successful `COMPACTION` event stores the complete
post-compaction message context. Event replay replaces prior history at that
boundary and continues with later completed messages.
