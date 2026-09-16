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
