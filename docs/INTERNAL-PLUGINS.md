# Internal capability registry

## Scope

Forge uses “plugin” to mean a Forge-owned, compiled-in capability module. It is
an architectural discipline for keeping the kernel small, not a public plugin
ecosystem.

Forge currently does not provide third-party package discovery, a marketplace,
remote installation or a compatibility target for another harness. Adding any
of those requires a separate product decision.

## Why the registry exists

New removable behavior should attach through a common mechanism instead of
adding another branch to `agent-runner.ts` or `SessionManager`. The registry
supports:

- slash commands;
- Pi tools;
- contributions to all six Pi hooks;
- agent-event subscribers;
- session-scoped services;
- small capability descriptors consumed by the desktop.

Registration is explicit in `src/plugins/builtins/index.ts`. TypeScript is the
contract; internal modules do not need compatibility or deprecation machinery.

Every manifest is either required or optional. Required means “not user
disableable”, not “incapable of failure”: Forge still reports and isolates a
failed required capability instead of concealing it. The usage meter is
required because context tracking and compaction depend on it. Session commands
and MCP adapters are optional product behavior.

## Lifecycle

```
compile-time registration
        ↓
session activation
        ↓
enabled ↔ disabled
        ↓
session disposal
```

Duplicate ids, slash commands and plugin tool names are rejected. Built-in Pi
tool names are reserved. Async activation, hook and event-subscriber failures
are caught, recorded and isolated to that capability in that session.

Each live host exposes `active`, `disabled`, `failed` or `disposed` for every
capability. `GET /sessions/:id/capabilities` returns that session-owned
snapshot; the desktop also folds `PLUGIN_*` events so reconnects and failures
do not leave a stale checkbox behind.

Activation is transactional at the capability boundary: if contribution
validation fails after resources were acquired, the partial instance is
disposed. Runtime failure disables and disposes the instance, and it cannot be
re-enabled within that session. A user-requested disable is a reversible pause:
already-composed tools and hooks consult the live state, while resources remain
owned until re-enable or session disposal. Final disposal runs once in reverse
activation order.

Only an explicit user disable is restored on resume. A runtime failure is not a
permanent preference: the next run creates a fresh instance and may recover.
Required capabilities ignore historical disable choices written before the
required boundary existed.

This is cooperative in-process isolation, not a security sandbox. Forge-owned
plugins are trusted code. A CPU-blocking module can still block the monolith;
the registry must not claim process isolation it does not provide.

## Current built-in capabilities

### Session commands

- `/compact`: requests compaction at the next turn boundary.
- `/status`: reports persisted session status, model and message count.
- `/context`: reports the context watermark and cumulative token counters.

The desktop discovers command descriptors from the server and renders slash
suggestions. Command output is persisted and appears in the session timeline;
the command text is not sent to the model as a user prompt.

### Usage

The usage subscriber consumes assistant `message_end` events, updates its
session tracker and emits `USAGE_UPDATE` for the desktop token meter. It exposes
the tracker as a session service used by compaction. If it is unavailable, the
runner substitutes an inert tracker and continues.

### MCP tools

MCP is an integration transport, not an external Forge-plugin ecosystem.
Enabled stdio servers are configured in Desktop Settings and registered as
Forge-owned adapters at server startup. Session activation performs
`initialize` and `tools/list`; discovered tools join Pi's normal tool list and
therefore pass through the same `beforeToolCall` guard.

Stop cancels outstanding JSON-RPC work and session disposal terminates the
child process. A crashed server reconnects before a later, fresh invocation;
Forge never automatically retries an uncertain in-flight mutating call. Tool
result details retain MCP server and tool provenance.

MCP child processes inherit ordinary launch variables but not ambient values
whose names indicate credentials, tokens, passwords, secrets or keys. A server
may still receive a credential explicitly configured for that server. Disposal
sends a graceful termination signal, waits for exit and escalates if needed.
Both waits are bounded; after the final deadline Forge detaches the stdio
handles so a broken child lifecycle cannot pin server shutdown.

Settings changes to MCP server definitions currently take effect after Forge
restarts. Hot replacement is not implemented.

## Events

The registry writes `PLUGIN_LOADED`, `PLUGIN_ENABLED`, `PLUGIN_DISABLED`,
`PLUGIN_FAILED`, `SLASH_COMMAND_INVOKED` and `PLUGIN_OUTPUT` into the same event
log as the agent. `PLUGIN_DISABLED` means a user pause; failure isolation has
its own unambiguous `PLUGIN_FAILED` fact. The desktop never consumes a separate
plugin event channel.
