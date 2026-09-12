/**
 * Phase 6 benchmark: golden task harness.
 *
 * Runs one golden task end-to-end against the REAL agent loop: Pi agentLoop,
 * real coding tools on a temp workspace, the full guardrail hook set, the
 * FIFO event log — only the LLM is a deterministic script. Each task
 * declares its own script, session config, and assertions; the harness
 * owns the plumbing (temp FORGE_HOME, runAgent invocation, metrics).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../agent-runner.ts";
import { readEvents, type PersistedEvent } from "../core/persistence/event-log.ts";
import { saveSession } from "../core/persistence/session-store.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import { UsageTracker } from "../guardrails/usage-tracker.ts";
import type { GuardrailConfig } from "../guardrails/types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Session } from "../types.ts";
import { fakeModel, makeScriptedRuntime, type Script, type ScriptedRuntime } from "./scripted-runtime.ts";
import { extractMetrics, type RunMetrics } from "./metrics.ts";

export interface GoldenTask {
  name: string;
  category: "new-feature" | "recovery" | "guardrail";
  goal: string;
  /** Script factory — tools need the real (temp) workspace for absolute paths. */
  script: (workspace: string) => Script;
  /** Assertions run against the finished run. Throw-free: return pass/fail list. */
  assert: (ctx: TaskRunContext) => Assertion[];
}

export interface Assertion {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface TaskRunContext {
  session: Session;
  metrics: RunMetrics;
  events: readonly PersistedEvent[];
  runtime: ScriptedRuntime;
  workspace: string;
}

export interface TaskReport {
  name: string;
  category: string;
  goal: string;
  metrics: RunMetrics;
  assertions: Assertion[];
  passed: boolean;
  error?: string;
}

export async function runGoldenTask(task: GoldenTask): Promise<TaskReport> {
  const workspace = mkdtempSync(join(tmpdir(), `forge-golden-${task.name}-`));
  const forgeHome = mkdtempSync(join(tmpdir(), `forge-golden-home-${task.name}-`));
  const prevEventsDir = process.env.FORGE_EVENTS_DIR;
  const prevSessionsDir = process.env.FORGE_SESSIONS_DIR;
  process.env.FORGE_EVENTS_DIR = join(forgeHome, "events");
  process.env.FORGE_SESSIONS_DIR = join(forgeHome, "sessions");

  try {
    const sessionId = `session_${task.name}_${Date.now()}`;
    const session: Session = {
      id: sessionId,
      goal: task.goal,
      workspace,
      projectId: null,
      model: { provider: "scripted", modelId: "scripted" },
      messages: [],
      status: "running",
      failureReason: null,
      usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
      approvalMode: "default",
      thinkingLevel: "off",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveSession(session);
    await appendEvent(sessionId, "SESSION_CREATED", { goal: task.goal, workspace });

    const runtime = makeScriptedRuntime(task.script(workspace));
    const steeringQueue: AgentMessage[] = [];
    const guardrails: GuardrailConfig = {
      sessionId,
      workspace,
      undoRoot: join(forgeHome, "undo", sessionId),
      session,
      approval: { request: async () => true },
      steeringQueue,
      usage: new UsageTracker(),
    };

    const started = Date.now();
    let runError: string | undefined;
    try {
      await runAgent({
        session,
        model: fakeModel,
        guardrails,
        streamFn: runtime.streamFn,
      });
    } catch (err) {
      // Stuck-detection termination surfaces as a loop error — that is a
      // legitimate golden outcome (guardrail did its job), not a harness bug.
      runError = err instanceof Error ? err.message : String(err);
      session.status = "failed";
      session.failureReason = runError;
    }
    const wallMs = Date.now() - started;

    const events = await readEvents(sessionId);
    const metrics = extractMetrics({
      session,
      events,
      wallMs,
      scriptedErrorTurns: 0, // golden scripts contain no error turns by design
    });

    const ctx: TaskRunContext = { session, metrics, events, runtime, workspace };
    const assertions = task.assert(ctx);
    const passed = assertions.every((a) => a.pass);

    const report: TaskReport = {
      name: task.name,
      category: task.category,
      goal: task.goal,
      metrics,
      assertions,
      passed,
    };
    if (runError !== undefined) report.error = runError;
    return report;
  } finally {
    process.env.FORGE_EVENTS_DIR = prevEventsDir;
    process.env.FORGE_SESSIONS_DIR = prevSessionsDir;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(forgeHome, { recursive: true, force: true });
  }
}
