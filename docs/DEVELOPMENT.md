# Development

## Local setup

Use Node.js 22.19 or newer. From the repository root:

```bash
npm ci
npm ci --prefix desktop
npm --prefix desktop run build
npm start
```

The Web Server serves the production workbench from `desktop/dist`; build it
after a fresh checkout or UI change. The release gate and archive builder also
perform that build. Use `npm start -- --no-open` when browser auto-open is
unwanted. See
[`WEB-RELEASE.md`](WEB-RELEASE.md) for the installed archive path. Keep model
credentials and session data in local Forge configuration, not in the repo.

## Before changing behavior

Answer these questions in the change or its review:

1. What user problem does this solve?
2. Is it Forge guardrail/recovery/UI behavior or an existing Pi capability?
3. Which Pi hook or internal contribution point owns it?
4. What state enters and leaves the module?
5. Which persisted events make the behavior observable?
6. What automated check proves the path?

Prefer small modules and pure guardrail functions. Do not create a second agent
loop, duplicate Pi features or turn in-process types into versioned protocols.

## Branches

`main` is the local Web Server release line and the GitHub default branch.
`master` remains the separate desktop line. Both branches began from the same
`v1.1.0` commit; shared kernel fixes must be deliberately ported between
them. Do not merge either branch wholesale into the other. Choose a base
branch before editing; cross-layer work uses a short-lived `feat/...` or
`fix/...` branch unless the user explicitly chooses another workflow. Verify
the affected line after porting a fix.

The source map is: `src/server/` (HTTP and sessions), `src/guardrails/` and
`src/guard/` (safety), `src/core/persistence/` (disk and replay),
`src/plugins/` (Forge capabilities), `pi/` (vendored loop and tools),
`desktop/src/` (React workbench), and `scripts/` (release checks). Use
[`ARCHITECTURE.md`](ARCHITECTURE.md) for state ownership and
[`ENGINEERING-STANDARDS.md`](ENGINEERING-STANDARDS.md) for change-specific
requirements.

## Required verification

Run the release gate from the repository root:

```bash
bash scripts/release-check.sh
```

It covers server and UI type checking, vendored Pi integrity, persistence,
event ordering, guardrails, recovery, compaction, the internal registry, HTTP smokes, harness reliability
invariants, MCP catalog hot-reload isolation, benchmark goldens and a clean
Web Server archive install and startup.

For the release archive and user installation steps, see
[`WEB-RELEASE.md`](WEB-RELEASE.md).

For a read-only report over persisted sessions:

```bash
npm run reliability
```

Real-provider acceptance is manual because it consumes a configured
subscription and evaluates model-dependent outcomes:

```bash
npm run real-bench                  # all fixture tasks
npm run real-bench -- 1 3           # one-based task numbers
npx tsx src/cli/real-compact-smoke.ts
```

Both commands isolate work in disposable directories. The benchmark records
results under `~/.forge/real-bench/`; the compaction smoke deletes its fixture.

For browser workbench changes, build the production bundle if not running the
full gate:

```bash
npm --prefix desktop run build
```

Use the dev preview for visual review without starting the Forge server:

```bash
cd desktop
npm run dev
# open /preview.html?scene=session&theme=dark
```

Available scenes are defined by `desktop/src/preview.tsx`; `hover=1` reveals
hover-only controls. `scene=health` opens the capability lifecycle panel,
`scene=audit` opens the Guard decision projection,
`scene=reliability` opens the event-derived diagnostics panel and
`scene=changes` opens the registered workspace-change contribution.

## Persistence changes

Session JSON is a real disk boundary. Schema changes require a forward-only
migration in `src/core/persistence/schema.ts`. Event JSONL readers must remain
tolerant of already-written records.

## Pi changes

Edits under `pi/` affect Forge through workspace symlinks. Rebuild the changed
Pi package so tracked `dist/` matches source, run that package's tests, then run
the Forge release gate. Keep changes concentrated so upstream comparison stays
affordable.

## Documentation discipline

Document shipped behavior in these files. Put explicit future work under a
clearly labelled limitation; never leave retired architecture beside current
architecture “for history.” Git already provides history.

Documentation-only changes need claim/link review and `git diff --check`.
For behavior changes, update the owning document and tests in the same change;
do not silently make `AGENTS.md` and the implementation disagree. A release
tag and GitHub artifact are separate tasks, not automatic consequences of a
merge or documentation update.
