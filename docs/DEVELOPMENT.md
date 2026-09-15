# Development

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

`master` must stay releasable. Cross-layer work and hook-contract changes use a
short-lived `feat/...` or `fix/...` branch. Small, obviously green changes may
land directly.

## Required verification

Run the release gate from the repository root:

```bash
bash scripts/release-check.sh
```

It covers server and desktop type checking, Rust sidecar compilation and
formatting, vendored Pi integrity, persistence, event ordering, guardrails,
recovery, compaction, the internal registry, HTTP smokes, harness reliability
invariants and benchmark goldens.

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

For desktop changes also build the production bundle:

```bash
npm --prefix desktop run build
```

Use the dev preview for visual review without launching Tauri:

```bash
cd desktop
npm run dev
# open /preview.html?scene=session&theme=dark
```

Available scenes are defined by `desktop/src/preview.tsx`; `hover=1` reveals
hover-only controls. `scene=health` opens the capability lifecycle panel,
`scene=audit` opens the Guard decision projection,
`scene=reliability` opens the event-derived diagnostics modal and
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
