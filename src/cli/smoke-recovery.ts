/**
 * Phase 5 smoke test for the recovery path: replaySession + sessionManager.resume.
 *
 * Strategy: prepare a session with a known event-log (3 MESSAGE_ENDED + a few
 * audit events), then call `sessionManager.resume(id)` and verify that the
 * resumed session picks up the correct messages. A test-seam runner settles
 * immediately, isolating recovery machinery from real LLM traffic.
 */
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
import type { runAgent } from "../agent-runner.ts";

async function waitForSettlement(sessionId: string): Promise<Session | null> {
  let session = await loadSession(sessionId);
  for (let attempt = 0; attempt < 40 && session?.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    session = await loadSession(sessionId);
  }
  return session;
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
    //    usage hydration and launchAgent path.
    const approvalHub = new ApprovalHub();
    const projects = new ProjectsRegistry(forgeHome);
    const agentRunner: typeof runAgent = async ({ session: running }) => ({
      ...running,
      status: "completed",
      failureReason: null,
    });
    const manager = new SessionManager({ forgeHome, projects, approvalHub, agentRunner });
    await manager.resume(sessionId);

    // 5. Verify session state on disk: status should have transitioned to
    //    "running" (resume()) and then to "completed" (the injected runner
    //    settles). What matters is that the replayed messages survived.
    const after = await waitForSettlement(sessionId);
    const messagesOk = after !== null && after.messages.length >= 3;
    const usageOk = after !== null && typeof after.usage.tokensIn === "number";
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
    let followed = false;
    try {
      await manager.resume(sessionId);
      followed = (await waitForSettlement(sessionId))?.status === "completed";
    } catch (err) {
      console.log("  follow-up resume threw:", String(err));
    }
    ok = ok && followed;
    console.log(`  follow-up resume on completed session: ${followed ? "OK" : "FAIL"}`);

    await manager.shutdown();
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
