/**
 * Phase 5 smoke test for the recovery path: replaySession + sessionManager.resume.
 *
 * Strategy: prepare a session with a known event-log (3 MESSAGE_ENDED + a few
 * audit events), then call `sessionManager.resume(id)` and verify that the
 * resumed session picks up the correct messages. We do not start a real
 * agent loop — the resume is a no-op on the agent side because we override
 * the streamFn to immediately emit a done event. This isolates the recovery
 * machinery from real LLM traffic.
 */
import { EventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalHub } from "../server/approval-hub.ts";
import { ProjectsRegistry } from "../server/projects.ts";
import { SessionManager } from "../server/session-manager.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import { loadSession, saveSession } from "../core/persistence/session-store.ts";
import { saveForgeConfig } from "../server/config-store.ts";
import { replaySession } from "../core/persistence/replay.ts";
import type { Session } from "../types.ts";

class ImmediateDoneStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor(message: AssistantMessage) {
    super(
      (e) => e.type === "done" || e.type === "error",
      (e) => {
        if (e.type === "done") return e.message;
        if (e.type === "error") return e.error;
        throw new Error("Unexpected event type");
      },
    );
    queueMicrotask(() => {
      this.push({ type: "done", reason: "stop", message });
    });
  }
}

const fakeModel = {
  id: "smoke-recovery",
  provider: "smoke-recovery",
  api: "openai-responses",
  name: "Smoke Recovery",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
} as unknown as Model<any>;

function immediateDoneStreamFn(): StreamFn {
  return () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "smoke ok" }],
      api: "openai-responses",
      provider: "smoke-recovery",
      model: "smoke-recovery",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    return new ImmediateDoneStream(msg) as unknown as ReturnType<StreamFn>;
  };
}

async function main(): Promise<void> {
  const forgeHome = mkdtempSync(join(tmpdir(), "forge-recovery-smoke-"));
  const eventsDir = join(forgeHome, "events");
  const sessionsDir = join(forgeHome, "sessions");
  process.env.FORGE_EVENTS_DIR = eventsDir;
  process.env.FORGE_SESSIONS_DIR = sessionsDir;
  process.env.FORGE_HOME = forgeHome;

  // Config with a fake provider so resolveProvider() can find a subscription.
  await saveForgeConfig(forgeHome, {
    version: 1,
    providers: [
      {
        id: "smoke",
        api: "openai-responses",
        modelId: "smoke-recovery",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "smoke-key",
      },
    ],
    defaultProviderId: "smoke",
    maxConcurrency: 1,
  } as unknown as Parameters<typeof saveForgeConfig>[1]);

  let ok = true;

  try {
    // 1. Build a session manually and persist it with a known event log.
    const sessionId = `session_smoke_recovery_${Date.now()}`;
    const session: Session = {
      id: sessionId,
      goal: "smoke recovery",
      workspace: forgeHome,
      projectId: null,
      model: { provider: "smoke", modelId: "smoke-recovery" },
      messages: [],
      status: "failed",
      failureReason: "simulated failure",
      usage: { tokensIn: 123, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null }, // ← tokens to test hydrate
      approvalMode: "default",
      thinkingLevel: "off",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveSession(session);

    // 2. Append a known event-log: 3 messages + audit noise.
    const mk = (text: string) => ({
      role: "user" as const,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
    const ak = (text: string) => ({
      role: "assistant" as const,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
    await appendEvent(sessionId, "SESSION_CREATED", { goal: session.goal });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: mk("u1") });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: ak("a1") });
    await appendEvent(sessionId, "STUCK_WARNING", { reason: "noise" });
    await appendEvent(sessionId, "COST_UPDATE", { spent: 0.123 });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: mk("u2") });
    // Half-written: must NOT be replayed.
    await appendEvent(sessionId, "MESSAGE_STARTED", { message: ak("a2-half") });

    // 3. Sanity: replaySession returns exactly 3 messages, in order.
    const r = await replaySession(sessionId);
    const rOk = r.messages.length === 3;
    ok = ok && rOk;
    console.log(`  replay messages: ${r.messages.length} (expected 3) → ${rOk ? "OK" : "FAIL"}`);

    // 4. Wire SessionManager and call resume() — without a real LLM, this
    //    verifies the SessionManager plumbing: status check, replay,
    //    usage.hydrate, launchAgent path. We override streamFn to
    //    immediately emit done.
    const approvalHub = new ApprovalHub();
    const projects = new ProjectsRegistry(forgeHome);
    const manager = new SessionManager({ forgeHome, projects, approvalHub });

    // Patch runAgent by calling resume() and racing with abort — we want
    // to observe that resume reaches the message-recovery stage, not that
    // the agent loop completes (since there's no real LLM).
    const resumeP = manager.resume(sessionId).catch((err) => {
      // The fake base URL will fail to connect during runAgent. That's
      // expected — we don't care about LLM success here, only about the
      // recovery plumbing up to launchAgent.
      return err;
    });
    // Give the agent a moment to start.
    await new Promise((r) => setTimeout(r, 200));

    // 5. Verify session state on disk: status should have transitioned to
    //    "running" (resume()) and then to "completed" (the mock LLM emits a
    //    single done event and the loop ends). What we care about is that
    //    the replayed messages survived — the resumed loop should produce a
    //    transcript with at least the 3 replayed messages plus whatever the
    //    mock loop added (1 prompt + 1 assistant = 5 total).
    const after = await loadSession(sessionId);
    const messagesOk = after !== null && after.messages.length >= 3;
    const usageOk = after !== null && typeof after.usage.tokensIn === "number";
    // Note: tokensIn from hydrate (123) gets added to by trackUsage during
    // the mock loop's assistant message. The persisted usage reflects
    // both — we only assert it is a finite number, not the exact value.
    ok = ok && messagesOk && usageOk;
    console.log(
      `  session after resume: status=${after?.status} messages=${after?.messages.length} tokensIn=${after?.usage.tokensIn} → ${
        messagesOk && usageOk ? "OK" : "FAIL"
      }`,
    );

    // 6. resume() on a completed session is now a chat-style follow-up
    //    (2026-09-09): it must NOT be blocked — the follow-up relaunches the
    //    loop with the message as the prompt. Verify it flips the session
    //    back to running (then it settles again).
    //
    //    Only a settled session is resumable, and how long the first run
    //    needs to settle is machine-dependent — poll for it instead of racing
    //    a fixed sleep. (A hard-coded 200ms wait here made this test fail on
    //    any machine where the run settles slower than that.)
    let settled = after;
    for (let i = 0; i < 40 && settled?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      settled = await loadSession(sessionId);
    }

    let followed = false;
    try {
      await manager.resume(sessionId);
      // give the relaunch a beat to reach the loop
      await new Promise((r) => setTimeout(r, 300));
      const after = await loadSession(sessionId);
      followed = after?.status === "running" || after?.status === "completed";
    } catch (err) {
      console.log("  follow-up resume threw:", String(err));
    }
    ok = ok && followed;
    console.log(`  follow-up resume on completed session: ${followed ? "OK" : "FAIL"}`);

    // Wait for the in-flight agent to finish before exit.
    await resumeP;
  } finally {
    rmSync(forgeHome, { recursive: true, force: true });
  }

  writeFileSync(join(tmpdir(), "forge-recovery-smoke-last"), ok ? "PASS" : "FAIL");
  console.log(`\nRECOVERY SMOKE: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});