/**
 * Session inactivity watchdog smoke (manual — wall-clock, ~10s).
 *
 * Creates a session whose provider is a local HTTP server that accepts the
 * request and NEVER responds — the exact real-world shape of a hung provider
 * call (real-bench's create-with-test finding). The watchdog must fail the
 * session with an idle-timeout reason instead of pinning it "running".
 *
 *   npx tsx src/cli/smoke-watchdog.ts
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalHub } from "../server/approval-hub.ts";
import { ProjectsRegistry } from "../server/projects.ts";
import { SessionManager } from "../server/session-manager.ts";
import { saveForgeConfig } from "../server/config-store.ts";
import { loadSession } from "../core/persistence/session-store.ts";

async function main(): Promise<void> {
  process.env.FORGE_IDLE_TIMEOUT_MS = "3000";

  const forgeHome = mkdtempSync(join(tmpdir(), "forge-watchdog-smoke-"));
  const workspace = mkdtempSync(join(tmpdir(), "forge-watchdog-ws-"));
  let ok = true;
  // The black-hole provider: accepts connections, never answers.
  const blackhole: Server = createServer(() => {});
  await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
  const addr = blackhole.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const port = addr.port;

  try {
    saveForgeConfig(forgeHome, {
      version: 2,
      providers: [
        {
          id: "blackhole",
          name: "Black Hole",
          api: "anthropic-messages",
          apiKey: "smoke-key",
          baseUrl: `http://127.0.0.1:${port}`,
          modelId: "blackhole-1",
        },
      ],
      defaultProviderId: "blackhole",
    } as never);

    const projects = new ProjectsRegistry(forgeHome);
    const manager = new SessionManager({ forgeHome, projects, approvalHub: new ApprovalHub() });
    const project = await projects.register({ path: workspace, name: "watchdog-smoke" });
    await projects.select(project.id);

    const { sessionId } = await manager.create({ goal: "this will hang forever", projectId: project.id });
    console.log(`  session: ${sessionId} → black-hole provider on :${port}`);

    const t0 = Date.now();
    let session = await loadSession(sessionId);
    while (session?.status === "running" && Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 500));
      session = await loadSession(sessionId);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const idleFailed = session?.status === "failed" && /idle timeout/.test(session.failureReason ?? "");
    console.log(`  status: ${session?.status} (${elapsed}s)`);
    console.log(`  reason: ${session?.failureReason}`);
    const { readEvents } = await import("../core/persistence/event-log.ts");
    const events = await readEvents(sessionId);
    console.log(`  events: ${events.map((e) => e.type).join(",")}`);
    for (const e of events) {
      if (e.type === "MESSAGE_ENDED") {
        const msg = (e.payload as { message?: { stopReason?: string; errorMessage?: string } }).message;
        console.log(`    stopReason=${msg?.stopReason} err=${msg?.errorMessage?.slice(0, 80)}`);
      }
    }
    ok = ok && idleFailed;
    console.log(`\nWATCHDOG SMOKE: ${ok ? "PASS" : "FAIL"}`);
  } finally {
    blackhole.close();
    rmSync(forgeHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
