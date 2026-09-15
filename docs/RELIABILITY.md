# Harness reliability

Forge measures the behavior it owns. It does not grade the model's answer or
replace the model's completion judgment with scripted verification.

The reliability projection reads the session JSONL log and reports:

- run starts and terminal outcomes;
- tool call/result pairing and core-guard coverage;
- unresolved approvals and approval latency;
- Stop-to-cancel convergence latency;
- interruption, resume and recovered-message counts;
- plugin failures;
- duplicate event identifiers and timestamp regressions.

These are derived projections, not a second source of truth. No reliability
state is persisted separately from the event log.

Run a read-only report across local sessions:

```bash
npm run reliability
npm run reliability -- session_123
npm run reliability -- --json
```

The same projection is available in the desktop session header under
**诊断**. The required `forge.reliability` capability declares the button and
its `metrics` read action. The desktop invokes that action through the generic
capability-read endpoint, which recomputes from the current log on every
request. Running and terminal sessions can therefore be inspected without
creating mutable telemetry state or a reliability-specific kernel route.

An unhealthy report means a Forge mechanism invariant was violated. It says
nothing about whether the model's engineering result was good. Real-task
quality remains a separate, manual benchmark because it depends on the chosen
model and task.

The release gate exercises the pure projection against healthy and corrupt
logs, then exercises cancellation timing and exactly-once settlement through
the real `SessionManager` lifecycle.
