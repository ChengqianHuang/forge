# Product direction

## Product statement

Forge is a desktop engineering-agent platform for completing real work in a
user's workspace.

The model supplies judgment. Pi supplies the agent loop and model runtime.
Forge supplies the environment in which that intelligence can act safely,
remain observable and recover from interruption.

“Platform” has a precise meaning here: multiple Forge-owned capabilities can
share a stable session runtime, guardrails, event history and desktop surface
without each feature modifying the agent loop. It does not mean a public
plugin marketplace or compatibility with another agent framework.

Forge is not a chatbot, a thin model wrapper, a general workflow engine or a
second agent loop around Pi.

## User promise

A user should be able to give Forge an engineering goal, watch it work, steer
it while it is running, approve consequential actions and resume after a
failure or restart.

Forge should always be honest about:

- what the agent is doing;
- which actions were allowed, denied or require approval;
- how much context the session is using;
- whether the session completed, was cancelled, failed or became stuck;
- what durable evidence exists for replay and recovery.

The product must not imply guarantees it cannot provide. A partial undo is not
presented as universal recovery. A heuristic is not presented as proof that a
task succeeded. Estimated usage is not presented as an enforceable budget.

## Product pillars

### Model-led execution

The LLM is the decision maker. Its completion judgment is accepted. Forge does
not translate open-ended engineering work into a deterministic state machine
and does not run a client-side judge that second-guesses completion.

### Constrained action

Every tool call crosses the same guard path before execution. Permission
policy, approval posture, the destructive deny floor and write journaling
constrain behavior without replacing model judgment.

### Durable sessions

A session is more than a live request. Its configuration, ordered events and
recovery data survive the process that is currently executing it. The event
log is the durable history; live streams and projections derive from it.

### Composable first-party capabilities

Slash commands, usage tracking, tool adapters and future product abilities
attach through one internal registry. Capabilities receive a scoped session
context, contribute through explicit extension points and release their
resources when the session ends.

### Complete desktop workbench

The desktop is the product surface, not an optional viewer. Configuration,
execution, approvals, steering, status, failures and recovery must be usable
without a CLI or knowledge of internal files.

## Kernel and capabilities

The kernel owns mechanisms that must remain true for every session:

- session identity, state and lifecycle;
- Pi integration and the single agent-loop entry point;
- the non-relaxable safety floor;
- ordered event persistence and crash recovery;
- capability registration and session-scoped composition;
- HTTP/SSE transport and the desktop application shell.

An internal capability owns removable product behavior, including commands,
optional tools, event-driven projections and focused UI contributions.

The deletion test is the default boundary: if a behavior can be removed
without damaging the integrity of session execution, safety, durable history
or recovery, it should be a capability rather than a kernel branch.

Composition does not make every mechanism replaceable. Core safety hooks run
before contributed hooks. The event log remains authoritative. Capability
code cannot shadow built-in tools or create a side channel around approvals.

Dependencies point inward: capabilities may use kernel services; the kernel
must not contain knowledge of an individual capability's product semantics.

## Runtime model

Forge uses one runtime vocabulary:

- A **session** owns the user goal, workspace, run configuration, status and
  capability scope.
- A **turn** is one model response and its tool activity inside Pi's agent
  loop.
- A **capability** is a Forge-owned module activated for a session.
- An **event** is a durable fact about session execution.
- A **projection** is UI or telemetry state derived from ordered events.

Capabilities should register effects and cleanup as a pair. Their mutable
state is scoped to a session unless ownership elsewhere is explicit. A failed
optional capability should be disabled and reported without taking down the
session; this is cooperative failure containment inside one process, not a
security sandbox.

The compiler is the in-process contract. Versioning and migration discipline
are reserved for real boundaries: desktop/server transport and persisted data.

## Capability extension points

The internal registry may compose only explicit kinds of contributions:

- Pi tools;
- the six `AgentLoopConfig` hooks;
- slash commands;
- agent-event subscribers;
- session-scoped services;
- UI capability descriptors and timeline output.

New extension-point categories require a demonstrated first-party need. The
registry must not become a speculative framework.

Registration is compiled in and reviewed with the rest of Forge. There is no
runtime package discovery, remote installation, public compatibility contract
or third-party trust boundary.

MCP remains a tool transport. An MCP server may supply tools, but it does not
become part of Forge's internal capability model and does not bypass Forge's
tool guardrails.

## Desktop principles

The transcript is one ordered timeline of model text, tool activity, command
output, guardrail decisions and session notices. Parallel histories that can
disagree with one another are not acceptable.

User-facing controls keep independent concepts independent: model selection,
reasoning effort and approval posture are separate axes. Running sessions can
be steered and stopped. Every guardrail that affects the user has a visible
entry point or outcome in the desktop.

The UI may project capability descriptors, but capabilities should not mount
arbitrary application shells. Forge keeps one coherent workbench and one
interaction language.

## Non-goals

Forge is not currently building:

- a public or third-party plugin ecosystem;
- a plugin marketplace or package installer;
- a compatibility clone of another harness;
- a general-purpose workflow or orchestration language;
- a second implementation of Pi features;
- deterministic completion verification;
- client-side cost or turn budgets;
- hidden automation with no desktop control or evidence.

These are product boundaries, not promises that the code can never change. A
boundary moves only when a real user need justifies the additional mechanism.

## Decision filter

Before adding a capability, answer:

1. Which user problem does it solve in the desktop product?
2. Is it a Forge mechanism, a removable Forge capability or an existing Pi
   responsibility?
3. What session scope and lifecycle does it require?
4. Which existing extension points carry it? If none do, why is a new category
   necessary?
5. What durable events and UI projection make its behavior observable?
6. How does it fail, cancel, dispose and recover?
7. Can it be removed without leaving branches or semantics in the kernel?
8. How is the behavior tested without judging the model's intelligence?

If those answers are unclear, the feature is not ready to enter the kernel.

## Near-term direction

The next phase should deepen the platform through real Forge capabilities,
not expand the abstraction surface in advance. Registry lifecycle and
session-scoped capability status and guard-decision inspection are now
established; the remaining direction is:

1. Strengthen cancellation, process cleanup and crash-resume behavior.
2. Add measurements and regression benchmarks for harness reliability, while
   leaving model-quality judgment to real task evaluation.

This section states direction, not shipped behavior. Current implementation
details belong in the architecture and internal-plugin documents.

## Success criteria

Forge is behaving as a platform when:

- a new first-party capability can be added through explicit registration
  without adding product branches to the agent loop;
- removing an optional capability leaves session execution and safety intact;
- every tool, command and terminal outcome remains ordered and explainable;
- capability failures are contained, visible and recoverable where possible;
- a crashed session retains enough durable state to resume honestly;
- every user-relevant mechanism is operable from the desktop;
- the release gate protects both Forge and the vendored Pi runtime.
