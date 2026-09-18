import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { ProjectsRegistry } from "./projects.ts";
import { saveForgeConfig } from "./config-store.ts";
import { loadSession, saveSession } from "../core/persistence/session-store.ts";
import { readEvents } from "../core/persistence/event-log.ts";
import type { runAgent } from "../agent-runner.ts";
import type { Session } from "../types.ts";
import { extractReliabilityMetrics } from "../reliability/metrics.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

let forgeHome = "";
let previousSessionsDir: string | undefined;
let previousEventsDir: string | undefined;
let previousCancelGrace: string | undefined;
let previousShutdownGrace: string | undefined;
// Tests leave deliberately unresolved runner promises (a Stop test must
// prove a pending await dies with the loop). If the event loop briefly
// drains between tests, node exits mid-file and cancels the rest — hold it
// open for the whole file instead.
let keepAlive: ReturnType<typeof setInterval> | undefined;

before(async () => {
  keepAlive = setInterval(() => {}, 1000);
  forgeHome = await mkdtemp(join(tmpdir(), "forge-lifecycle-test-"));
  previousSessionsDir = process.env.FORGE_SESSIONS_DIR;
  previousEventsDir = process.env.FORGE_EVENTS_DIR;
  previousCancelGrace = process.env.FORGE_CANCEL_GRACE_MS;
  previousShutdownGrace = process.env.FORGE_SHUTDOWN_GRACE_MS;
  process.env.FORGE_SESSIONS_DIR = join(forgeHome, "sessions");
  process.env.FORGE_EVENTS_DIR = join(forgeHome, "events");
  process.env.FORGE_CANCEL_GRACE_MS = "10";
  process.env.FORGE_SHUTDOWN_GRACE_MS = "10";
  await saveForgeConfig(forgeHome, {
    version: 2,
    providers: [{
      id: "fake",
      api: "openai-responses",
      apiKey: "test",
      modelId: "fake-model",
      baseUrl: "http://127.0.0.1:9/v1",
    }],
    defaultProviderId: "fake",
    mcpServers: [],
  });
});

after(async () => {
  if (keepAlive) clearInterval(keepAlive);
  if (previousSessionsDir === undefined) delete process.env.FORGE_SESSIONS_DIR;
  else process.env.FORGE_SESSIONS_DIR = previousSessionsDir;
  if (previousEventsDir === undefined) delete process.env.FORGE_EVENTS_DIR;
  else process.env.FORGE_EVENTS_DIR = previousEventsDir;
  if (previousCancelGrace === undefined) delete process.env.FORGE_CANCEL_GRACE_MS;
  else process.env.FORGE_CANCEL_GRACE_MS = previousCancelGrace;
  if (previousShutdownGrace === undefined) delete process.env.FORGE_SHUTDOWN_GRACE_MS;
  else process.env.FORGE_SHUTDOWN_GRACE_MS = previousShutdownGrace;
  await rm(forgeHome, { recursive: true, force: true });
});

test("Stop wins, force-settles an uncooperative runner, and ignores a late result", async () => {
  let resolveRun!: (session: Session) => void;
  let emitLate!: NonNullable<Parameters<typeof runAgent>[0]["emitEvent"]>;
  const agentRunner: typeof runAgent = async (opts) => {
    emitLate = opts.emitEvent!;
    return new Promise<Session>((resolve) => { resolveRun = resolve; });
  };
  const approvals = new ApprovalHub();
  const manager = new SessionManager({
    forgeHome,
    projects: new ProjectsRegistry(forgeHome),
    approvalHub: approvals,
    agentRunner,
  });

  const { sessionId } = await manager.create({ goal: "never return" });
  assert.equal((await manager.abort(sessionId)).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const cancelled = await loadSession(sessionId);
  assert.equal(cancelled?.status, "cancelled");
  let terminals = (await readEvents(sessionId)).filter((event) =>
    ["SESSION_ENDED", "SESSION_FAILED", "SESSION_CANCELLED"].includes(event.type),
  );
  assert.deepEqual(terminals.map((event) => event.type), ["SESSION_CANCELLED"]);
  const reliability = extractReliabilityMetrics({
    events: await readEvents(sessionId),
    sessionStatus: "cancelled",
  });
  assert.equal(reliability.integrity.healthy, true);
  assert.equal(reliability.cancellation.requested, 1);
  assert.equal(reliability.cancellation.settled, 1);
  assert.ok((reliability.cancellation.p95LatencyMs ?? Infinity) < 100);

  // A provider that ignores AbortSignal may still return. It must not reopen
  // the event gate, overwrite cancellation, or write a second terminal.
  await emitLate("TEXT_DELTA", { delta: "too late" });
  resolveRun(cancelled!);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await loadSession(sessionId))?.status, "cancelled");
  terminals = (await readEvents(sessionId)).filter((event) =>
    ["SESSION_ENDED", "SESSION_FAILED", "SESSION_CANCELLED"].includes(event.type),
  );
  assert.equal(terminals.length, 1);
  assert.equal((await readEvents(sessionId)).some((event) => event.payload.delta === "too late"), false);
});

test("shutdown is bounded even when the runner ignores abort", async () => {
  const agentRunner: typeof runAgent = async () => new Promise<Session>(() => {});
  const manager = new SessionManager({
    forgeHome,
    projects: new ProjectsRegistry(forgeHome),
    approvalHub: new ApprovalHub(),
    agentRunner,
  });
  const { sessionId } = await manager.create({ goal: "ignore shutdown" });
  const started = Date.now();
  await manager.shutdown();
  assert.ok(Date.now() - started < 500, "shutdown exceeded its configured bound");
  assert.equal((await loadSession(sessionId))?.status, "cancelled");
});

test("startup repair turns an orphaned running record into a resumable failure exactly once", async () => {
  const id = `session_orphan_${Date.now()}`;
  const now = Date.now();
  await saveSession({
    id,
    goal: "recover me",
    workspace: forgeHome,
    projectId: null,
    model: { provider: "fake", modelId: "fake-model" },
    messages: [],
    status: "running",
    failureReason: null,
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
    approvalMode: "default",
    thinkingLevel: "off",
    createdAt: now,
    updatedAt: now,
  });
  const manager = new SessionManager({
    forgeHome,
    projects: new ProjectsRegistry(forgeHome),
    approvalHub: new ApprovalHub(),
  });

  assert.equal(await manager.reconcileInterruptedSessions(), 1);
  assert.equal(await manager.reconcileInterruptedSessions(), 0);
  const repaired = await loadSession(id);
  assert.equal(repaired?.status, "failed");
  assert.match(repaired?.failureReason ?? "", /resume to continue/i);
  const events = await readEvents(id);
  assert.equal(events.filter((event) => event.type === "SESSION_INTERRUPTED").length, 1);
  assert.equal(events.filter((event) => event.type === "SESSION_FAILED").length, 1);
});

test("an optional plugin failure is isolated while the agent run completes", async () => {
  const plugins = new PluginRegistry();
  let healthyEvents = 0;
  plugins.register({
    manifest: { id: "test.crashing-optional", name: "crashing", version: "1", capabilities: ["event-subscriber"] },
    activate: () => ({ onAgentEvent: () => { throw new Error("subscriber boom"); } }),
  });
  plugins.register({
    manifest: { id: "test.healthy", name: "healthy", version: "1", capabilities: ["event-subscriber"] },
    activate: () => ({ onAgentEvent: () => { healthyEvents += 1; } }),
  });
  const agentRunner: typeof runAgent = async (opts) => {
    await opts.plugins?.onAgentEvent({ type: "agent_start" } as AgentEvent);
    return { ...opts.session, status: "completed", failureReason: null };
  };
  const manager = new SessionManager({
    forgeHome,
    projects: new ProjectsRegistry(forgeHome),
    approvalHub: new ApprovalHub(),
    plugins,
    agentRunner,
  });

  const { sessionId } = await manager.create({ goal: "continue after optional plugin failure" });
  for (let attempt = 0; attempt < 20 && (await loadSession(sessionId))?.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await loadSession(sessionId))?.status, "completed");
  assert.equal(healthyEvents, 1);
  const failure = (await readEvents(sessionId)).find((event) =>
    event.type === "PLUGIN_FAILED" && event.payload.pluginId === "test.crashing-optional"
  );
  assert.equal(failure?.payload.required, false);
  assert.equal(failure?.payload.phase, "onAgentEvent");
});

test("the inactivity watchdog settles a runner that ignores abort — and does not call it a stop", async () => {
  // The watchdog is the only observer of a hung provider call, and it used to
  // clear itself immediately after abort() — so a runner that never settles
  // left the session `running` forever with nobody left to notice. Stop has
  // had a bounded fallback (cancelGraceMs) all along; the watchdog needs one
  // too, and it must not route through requestStop: the user did not stop this
  // run, so a "cancelled" record would misattribute the cause.
  const previousIdle = process.env.FORGE_IDLE_TIMEOUT_MS;
  const previousTimeoutGrace = process.env.FORGE_TIMEOUT_GRACE_MS;
  process.env.FORGE_IDLE_TIMEOUT_MS = "50";
  process.env.FORGE_TIMEOUT_GRACE_MS = "20";
  const terminalTypes = ["SESSION_ENDED", "SESSION_FAILED", "SESSION_CANCELLED"];
  try {
    let resolveRun!: (session: Session) => void;
    const agentRunner: typeof runAgent = async () =>
      new Promise<Session>((resolve) => { resolveRun = resolve; });
    const manager = new SessionManager({
      forgeHome,
      projects: new ProjectsRegistry(forgeHome),
      approvalHub: new ApprovalHub(),
      agentRunner,
    });

    const { sessionId } = await manager.create({ goal: "hang forever" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await loadSession(sessionId))?.status, "running", "not settled before the watchdog trips");

    // watchdogIntervalMs() floors at 250ms, so the trip plus the grace land
    // inside this window.
    await new Promise((resolve) => setTimeout(resolve, 450));

    const settled = await loadSession(sessionId);
    assert.equal(settled?.status, "failed", "a hung run must not stay running forever");
    assert.match(settled?.failureReason ?? "", /idle timeout/i);
    const terminals = (await readEvents(sessionId)).filter((event) =>
      terminalTypes.includes(event.type),
    );
    assert.deepEqual(terminals.map((event) => event.type), ["SESSION_FAILED"]);
    assert.equal(terminals[0]!.payload.status, "failed");

    // The runtime is gone from the live map...
    assert.equal((await manager.abort(sessionId)).ok, false);
    // ...and a runner that finally returns cannot reopen the settled session.
    resolveRun(settled!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await loadSession(sessionId))?.status, "failed");
    assert.equal(
      (await readEvents(sessionId)).filter((event) => terminalTypes.includes(event.type)).length,
      1,
    );
  } finally {
    if (previousIdle === undefined) delete process.env.FORGE_IDLE_TIMEOUT_MS;
    else process.env.FORGE_IDLE_TIMEOUT_MS = previousIdle;
    if (previousTimeoutGrace === undefined) delete process.env.FORGE_TIMEOUT_GRACE_MS;
    else process.env.FORGE_TIMEOUT_GRACE_MS = previousTimeoutGrace;
  }
});

test("global plugin preferences reach activation: config resolved, user-disabled plugins skipped", async () => {
  const activated: Array<{ id: string; config: Record<string, unknown> }> = [];
  const registry = new PluginRegistry();
  registry.register({
    manifest: {
      id: "test.prefs-probe",
      name: "Prefs Probe",
      version: "0.0.1",
      capabilities: ["event-subscriber"],
      configSchema: [{ key: "threshold", label: "threshold", type: "number", default: 1 }],
    },
    activate: (_context, config) => {
      activated.push({ id: "test.prefs-probe", config: { ...config } });
      return {};
    },
  });
  registry.register({
    manifest: {
      id: "test.prefs-off",
      name: "Prefs Off",
      version: "0.0.1",
      capabilities: ["event-subscriber"],
    },
    activate: () => {
      activated.push({ id: "test.prefs-off", config: {} });
      return {};
    },
  });
  const manager = new SessionManager({
    forgeHome,
    projects: new ProjectsRegistry(forgeHome),
    approvalHub: new ApprovalHub(),
    agentRunner: async () => new Promise<Session>(() => {}),
    plugins: registry,
  });
  await manager.setGlobalPluginEnabled("test.prefs-off", false);
  await manager.setGlobalPluginConfig("test.prefs-probe", { threshold: 7 });

  await manager.create({ goal: "prefs reach activation" });
  const probe = activated.find((entry) => entry.id === "test.prefs-probe");
  assert.ok(probe, "configured plugin must activate with its resolved config");
  assert.equal(probe.config.threshold, 7);
  assert.equal(
    activated.some((entry) => entry.id === "test.prefs-off"),
    false,
    "globally user-disabled plugin must not activate",
  );
  await manager.shutdown();
});
