# Internal capability registry

## Scope

Forge uses “plugin” for capabilities that attach through its registry. Built-in
plugins are Forge-owned and compiled in; explicitly user-installed plugins may
load from a local file or Git source through the same contract. This keeps the
kernel small while allowing the platform to remain open.

Forge does not provide a centralized marketplace, compatibility with another
agent framework, or a security sandbox for external code. Installation is an
explicit trust decision by the user.

## Why the registry exists

New removable behavior should attach through a common mechanism instead of
adding another branch to `agent-runner.ts` or `SessionManager`. The registry
supports:

- slash commands;
- Pi tools;
- contributions to all six Pi hooks;
- agent-event subscribers;
- session-scoped services;
- stateless, user-initiated read actions;
- stateful user interactions (bounded requests plus long-lived streams);
- small capability descriptors consumed by the workbench.

UI descriptors declare a stable contribution id, label, surface and renderer
key. The workbench maps renderer keys through one compiled-in registry; session
components do not contain branches for individual capability ids.

A UI descriptor may bind to a manifest-declared read action. The workbench calls
the generic `GET /sessions/:id/capabilities/:pluginId/read/:actionId` route;
the registry validates the capability and action while the plugin owns input
validation and result semantics. A manifest cannot declare read actions
without installing their handler. Read actions are stateless inspection, not a
second plugin runtime: they remain available for a terminal session after its
runtime instance is disposed, run under a timeout and receive an abort signal.

Stateful interactions are a separate, honest seam. A manifest declares
`request` and `stream` actions; generic capability HTTP routes dispatch them to
`interact` and `subscribe`. They may outlive an agent run. `disposeSession`
releases resources when the user deletes a session, and plugin-level `dispose`
releases all remaining resources during server shutdown. The registry owns
routing and bounded setup; the plugin owns payload validation and resource
semantics. Disabling an optional capability for a live session also invokes
its session cleanup before it can be enabled again.

Registration is explicit in `src/plugins/builtins/index.ts`. TypeScript is the
contract; internal modules do not need compatibility or deprecation machinery.

`capabilities` is the set a host filters on when activating a plugin, while the
manifest's `slashCommands`, `ui`, `readActions` and `interactions` arrays are projected to
consumers *before* activation. The two must agree, so the registry rejects a
manifest that declares `ui` with no UI contribution, contributes UI without
declaring `ui`, declares `read-action` with no read action, contributes read
actions without declaring `read-action`, declares interactions without their
request/stream handlers, or declares slash commands without the `slash-command`
capability. Contributions that only exist after `activate()`
(tools, hooks, event subscribers) cannot be checked statically — there, a
declaration is a claim the author has to keep true. Declarations are
user-visible, because the capability panel renders them: an over-declaration is
a defect, not untidiness.

The words are `tool`, `guardrail`, `event-subscriber`, `slash-command`,
`read-action`, `interaction` and `ui`. `read-action` covers the stateless inspection surface
(`readActions` + a `read` handler); without it, a plugin whose only contribution
is inspection had nothing to declare and no host could select that surface.
`interaction` covers manifest-declared stateful request/stream actions and is
kept distinct so an open stream is never misrepresented as a bounded read.

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
snapshot; the workbench also folds `PLUGIN_*` events so reconnects and failures
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

### Global preferences and config (the manager page)

The workbench plugin manager page (`GET /plugins`,
`POST /plugins/:id/enabled`, `PUT /plugins/:id/config`) operates on the
**global layer**, persisted in `<forgeHome>/plugin-prefs.json`:

- `disabled[]` — optional plugin ids the user turned off globally. Session
  activation unions this with the session event log's own `PLUGIN_DISABLED`
  fold (`plugins/state.ts`), so a session-scoped pause and a global preference
  compose without overwriting each other.
- `config{}` — per-plugin config values. A plugin declares its parameters in
  the manifest (`configSchema`: string/number/boolean/enum fields with
  defaults). The registry validates the schema at registration, resolves
  stored values against it before `activate(context, config)` and
  `read(action, input, ctx)` see them, and rejects unknown or wrong-shaped
  values at the HTTP boundary — a typo surfaces as an error, never as a
  silently ignored key.

A plugin disabled at activation is **not mounted**: `activate()` does not run
and no resources are acquired. Toggling it on mid-session mounts it on demand
(contributions conflict-checked against everything already mounted). Disabled
means not present, not present-but-gated.

This is cooperative in-process isolation, not a security sandbox. Built-in and
user-installed plugins are trusted code once loaded. A CPU-blocking module can
still block the monolith; the registry must not claim process isolation it does
not provide.

## Current built-in capabilities

### Session commands

- `/compact`: requests compaction at the next turn boundary.
- `/status`: reports persisted session status, model and message count.
- `/context`: reports the context watermark and cumulative token counters.

The workbench discovers command descriptors from the server and renders slash
suggestions. Command output is persisted and appears in the session timeline;
the command text is not sent to the model as a user prompt.

### Usage

The usage subscriber consumes assistant `message_end` events, updates its
session tracker and emits `USAGE_UPDATE` for the workbench token meter. It exposes
the tracker as a session service used by compaction. If it is unavailable, the
runner substitutes an inert tracker and continues.

### Harness reliability

The required reliability capability contributes the workbench **诊断** action
and a stateless `metrics` read action. It derives lifecycle, guard coverage,
approval, cancellation, recovery and plugin-failure measurements directly from
the session event log. It owns no telemetry store and never evaluates generated
text or the model's completion decision.

Running and disposed sessions use the same generic capability-read route. The
former dedicated `SessionManager.reliability` method and HTTP endpoint were
removed when this capability was registered; the kernel now knows only that a
declared read action was requested.

### Capability health

The required capability-health module owns the workbench lifecycle panel and the
optional-capability enable/disable control. It renders the current registry
snapshot together with the ordered `PLUGIN_*` facts already folded from SSE;
there is no health database and no polling protocol.

New failure events carry the manifest's `required` flag. The timeline and panel
therefore distinguish a required mechanism failure (Forge is degraded) from an
optional capability failure (that capability is isolated and the agent keeps
running). Historical events without the flag remain neutral rather than being
guessed. The panel never retries a failed plugin in place; a later session run
creates a fresh instance through the normal lifecycle.

### Guard audit

The required guard-audit capability contributes a session-header action that
renders the `GUARD_DECISION` projection already folded from SSE. It needs no
read action, server route or private state. Core guard evaluation and durable
decision emission deliberately remain outside the capability: safety is
kernel substrate, while its removable inspection surface is registered UI.

### Workspace changes

The optional workspace-changes subscriber records a Git status baseline before
the agent acts and emits `WORKSPACE_CHANGES` when the run ends. The snapshot
lists current net changes, line counts and whether a dirty path existed before
the session; it never attributes a preexisting edit to the agent.

Its manifest registers a session-header UI contribution. The workbench renderer
shows the latest persisted snapshot and requests the current diff only when the
user selects a file. The diff read remains available after the plugin's runtime
resources are disposed. Non-Git workspaces emit an explicit unsupported state
instead of failing the session. Git is invoked without a shell and only with
read-only commands; full patches are not copied into the event log.

Diff reads are constrained to the session workspace after canonical path
resolution. Untracked symbolic links are never followed, binary content is
reported without embedding a patch, and returned text is capped at 256 KiB
with its original byte count and truncation marker. The result is a live
working-tree view, not historical evidence; the persisted
`WORKSPACE_CHANGES` snapshot remains the durable session projection.

### Session terminal

The optional `forge.terminal` capability is the first stateful interaction
client. Its manifest contributes the dock tab plus `create`, `input`, `resize`,
`exit` request actions and an `output` stream. The generic capability routes
carry all five; `SessionManager`, the HTTP router and `RightDock` contain no
terminal-specific route or synthetic tab.

The PTY is controlled directly by the user and therefore sits outside agent
tool approvals, like opening the operating system terminal. Its process may
survive an SSE reconnect, but is killed on explicit exit, session deletion or
server shutdown. Terminal bytes are intentionally transient and are not copied
into the agent event log.

### MCP tools

MCP is an integration transport, not an external Forge-plugin ecosystem.
Enabled stdio servers are configured in Desktop Settings and registered as
Forge-owned adapters at startup or the next settings save. Session activation performs
`initialize` and `tools/list`; discovered tools join Pi's normal tool list and
therefore pass through the same `beforeToolCall` guard.

Stop cancels outstanding JSON-RPC work and session disposal terminates the
child process. A crashed server reconnects before a later, fresh invocation;
Forge never automatically retries an uncertain in-flight mutating call. Tool
result details retain MCP server and tool provenance.

Saving MCP settings reconciles the live capability catalog without restarting
Forge. Reconciliation only registers plugin factories; it does not spawn or
probe the configured process. New sessions activate the latest enabled
definition. A session that already activated an MCP plugin retains that exact
client and tool set until its normal disposal, even if the server is edited,
disabled or removed meanwhile. This avoids replacing an in-flight transport or
retrying an uncertain mutation. Invalid/duplicate ids and capability conflicts
are rejected at the config boundary instead of partially updating the catalog.

MCP child processes inherit ordinary launch variables but not ambient values
whose names indicate credentials, tokens, passwords, secrets or keys. A server
may still receive a credential explicitly configured for that server. Disposal
sends a graceful termination signal, waits for exit and escalates if needed.
Both waits are bounded; after the final deadline Forge detaches the stdio
handles so a broken child lifecycle cannot pin server shutdown.

The generated [`capability-seams.md`](capability-seams.md) is the machine-checked
map of every capability's runtime contributions (hooks through the kernel
multiplexer, tools, commands, services, read actions, interactions, UI surfaces, config
keys), the full seam inventory of the plugin contract, and the routing table
that answers "where does new behavior attach" with its boundary constraint.
Regenerate with `npm run gen:seams`; the release gate fails when it is stale.
The routing table is not free prose: every seam token it references resolves
against a compiler-checked inventory (the tsconfig covers `scripts/`), and the
hook list is verified at runtime — bidirectionally — against what
`multiplexHooks` actually composes, so a plugin's typo'd hook (silently
dropped, permanently worth zero) fails the gate too.

## Events

The registry writes `PLUGIN_LOADED`, `PLUGIN_ENABLED`, `PLUGIN_DISABLED`,
`PLUGIN_FAILED`, `SLASH_COMMAND_INVOKED` and `PLUGIN_OUTPUT` into the same event
log as the agent. Individual capabilities may add owned projection events such
as `WORKSPACE_CHANGES`; they still use that one log and SSE path.
`PLUGIN_DISABLED` means a user pause; failure isolation has its own unambiguous
`PLUGIN_FAILED` fact. The workbench never consumes a separate plugin event
channel.

## External plugins

A plugin does not have to be compiled in. `<forgeHome>/plugins/*.plugin.{ts,js,mjs}`
files whose **default export** is a `ForgePlugin` are loaded at server start
into the same registry as builtins — same manifest rules, same capability
validation, same global enablement/config preferences, same manager page
(grouped as 外部插件 with a source tag).

Loading is fail-isolated per file: a syntax error, a malformed manifest, or an
id collision is reported to the manager page's load-error banner and the
server (and every other plugin) keeps working. The directory is read once per
server start; changes apply on restart.

### Install flow (添加插件 wizard)

External plugins are trusted in-process code, not passive data. The workbench
requires an explicit trust acknowledgement before inspection and says plainly
that inspection executes module code as the current user. Forge does not claim
that manifest validation is a sandbox or a security review.

`POST /plugins/inspect {source}` copies or downloads a source into a private
scratch directory, executes each candidate to validate it, hashes the staged
bytes, and returns a short-lived `inspectionId`. It does not write forge home.
`POST /plugins/install {inspectionId}` consumes that ticket exactly once,
copies the already-inspected bytes into forge home and registers them into the
live registry — there is no second source read or network fetch between review
and installation. Tickets expire after ten minutes; expiry, successful use and
server shutdown all remove their staging directory.

A source is a local `*.plugin.{ts,js,mjs}` file, a local directory of them, any
git URL (including `file://`; shallow-cloned to a scratch dir), or the GitHub
`owner/repo` shorthand. A matching local path wins over shorthand resolution.
File-name collisions in the plugins directory are rejected — an install never
overwrites an existing plugin file. `POST /plugins/:id/uninstall` deletes the
file and drops the plugin from the live registry; sessions that already
activated it keep their instance until disposal.
