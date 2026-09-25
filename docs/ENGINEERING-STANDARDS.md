# Engineering standards

This is the change contract for the `main` Web Server line. `AGENTS.md` holds
the architectural invariants; the other documents explain current behavior.
Do not copy implementation details into this file when a code link or focused
design document is clearer.

## Classify a change before coding

1. State the user problem and the observable outcome. Do not add a mechanism
   merely because another agent framework has one.
2. Choose ownership: Pi runtime, Forge kernel, session capability, browser
   workbench, or release tooling. A removable behavior belongs in a capability;
   the kernel retains only safety, session lifecycle, durable facts and the
   composition seam. Built-in and user-installed capabilities use the same
   Forge registry contract.
3. Name the affected boundaries. In-process TypeScript changes need types and
   focused tests, not compatibility versions. HTTP/SSE and persisted files need
   compatibility review.
4. Identify the evidence: a persisted event, a session field, or a testable UI
   projection. Do not create a second state store for facts already in JSONL.
5. Select the release line. `main` and `master` are independent; shared fixes
   are ported deliberately, not merged wholesale.

## Implementation rules

- Keep Pi's single `agentLoop`. Forge composes hooks; capabilities contribute
  through the registry. Do not add an outer loop or a second completion judge.
- Keep core deny decisions non-relaxable. Every tool call, including a
  contributed or MCP tool, reaches the core `beforeToolCall` gate. A plugin may
  restrict further but cannot turn a denial into an allow.
- Keep ownership explicit: the session manager owns live runs, capabilities
  own their resources, and shutdown/deletion releases both. Optional capability
  failure must not take down the session loop; required mechanism failure must
  be visible rather than silently treated as healthy.
- Prefer small modules and typed interfaces. Keep feature-specific routing and
  rendering out of the kernel when a generic capability action or UI
  contribution can carry them.
- Visual styling belongs in `desktop/src/styles.css` through semantic classes
  and `data-*` state. Use inline styles only for genuinely dynamic values.
  Render designed loading, empty and error states; do not imply guarantees the
  mechanism cannot provide.

## Boundary changes

| Change | Required discipline |
|---|---|
| HTTP request/response or SSE event | Update server and browser consumer together; cover invalid input, authorization, replay and ordering where relevant. |
| Session JSON | Add a forward-only migration in `src/core/persistence/schema.ts` and old-record tests. |
| Event JSONL | Preserve append order, stable identity and tolerant handling of an incomplete final line; test replay and recovery. |
| Capability manifest or lifecycle | Test activation, disable/re-enable, failure isolation and resource disposal at the applicable scope. Regenerate `docs/capability-seams.md`. |
| Guard policy or hook | Test allow/ask/deny, approval posture, decision evidence and non-relaxable floor. |
| Pi source | Rebuild the changed workspace's tracked `dist/`, run its tests and the Forge release gate. Record the edit in the relevant design document. |
| Web startup, auth or packaging | Preserve loopback-only binding, same-origin checks and token gate; run the clean archive smoke, not just a source checkout. |

The browser workbench is the user entry point after `npm start`; the startup
command is not an alternative agent CLI. The process can read projects and
execute tools with the user's local privileges. Loopback, same-origin and a
per-process token are a local trust boundary, not remote multi-user security.
Never document public exposure or remote access as supported by this line.

## Verification and handoff

- For a focused behavior change, run the closest unit/integration checks first.
  For a cross-layer or release-affecting change, run
  `bash scripts/release-check.sh` from the repository root. It includes a
  fresh packaged Web Server smoke and does not require model credentials.
- Review the actual browser state for UI work (including empty, loading,
  error and replay states), then build `desktop/dist` as part of the gate.
- Real-provider benchmarks are optional manual acceptance, not a substitute
  for deterministic tests. Do not claim model output quality from harness
  reliability metrics.
- For documentation-only changes, check links and claims against code and run
  `git diff --check`; no build is needed unless the documentation changes a
  generated artifact or release procedure.
- The handoff says which release line changed, what was verified, what remains
  unverified, and whether a release artifact was produced. Do not tag, publish
  or push another release line without an explicit release task.

## Documentation upkeep

`AGENTS.md` is normative; `PRODUCT.md` says what Forge is for;
`ARCHITECTURE.md` says who owns state and boundaries; `GUARDRAILS.md` defines
safety behavior; `INTERNAL-PLUGINS.md` defines capability attachment;
`DEVELOPMENT.md` explains everyday workflow; `WEB-RELEASE.md` explains local
distribution. Update the owning document in the same change as the behavior.
Describe shipped behavior in the present tense, mark future work explicitly,
and use Git history rather than retaining retired designs as active rules.
