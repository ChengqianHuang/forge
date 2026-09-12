/**
 * Manual verification: LLM-summary compaction against the real MiniMax M2.7.
 * Forces the compaction threshold to ~0 so the first turn boundary triggers
 * Pi's summarizer through the real subscription streamFn.
 */
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../core/persistence/event-log.ts";
import { loadSession } from "../core/persistence/session-store.ts";
import { ApprovalHub } from "../server/approval-hub.ts";
import { ProjectsRegistry } from "../server/projects.ts";
import { SessionManager } from "../server/session-manager.ts";

async function main(): Promise<void> {
  const forgeHome = mkdtempSync(join(tmpdir(), "forge-compact-real-"));
  const workspace = mkdtempSync(join(tmpdir(), "forge-compact-ws-"));
  cpSync(process.env.HOME + "/.forge/forge-config.json", join(forgeHome, "forge-config.json"));
  process.env.FORGE_EVENTS_DIR = join(forgeHome, "events");
  process.env.FORGE_SESSIONS_DIR = join(forgeHome, "sessions");

  // Threshold ~0 forces the trigger; a tiny retention window makes the
  // cut point land mid-history once the agent writes a large file.
  process.env.FORGE_COMPACTION_THRESHOLD = "1";
  process.env.FORGE_COMPACTION_KEEP_RECENT_TOKENS = "500";

  try {
    const projects = new ProjectsRegistry(forgeHome);
    const manager = new SessionManager({ forgeHome, projects, approvalHub: new ApprovalHub() });
    const project = await projects.register({ path: workspace, name: "compact-real" });
    await projects.select(project.id);

    const { sessionId } = await manager.create({
      goal:
        "Create big.txt in the workspace root. Its content must be the sentence " +
        "'The quick brown fox jumps over the lazy dog while counting numbers.' " +
        "repeated 60 times, one sentence per line. Then stop.",
      projectId: project.id,
    });

    // Wait for settle.
    for (let i = 0; i < 180; i++) {
      const active = (manager as unknown as { active: Map<string, unknown> }).active;
      if (!active.has(sessionId)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const session = await loadSession(sessionId);
    const events = await readEvents(sessionId);
    const compaction = events.filter((e) => e.type === "COMPACTION");
    const costUpdates = events.filter((e) => e.type === "COST_UPDATE").map((e) => e.payload);
    const notes = join(workspace, "big.txt");

    console.log(`  state: ${session?.status} (reason: ${session?.failureReason})`);
    console.log(`  usage: ${JSON.stringify(session?.usage)}`);
    console.log(`  COST_UPDATE payloads: ${JSON.stringify(costUpdates)}`);
    console.log(`  COMPACTION events: ${JSON.stringify(compaction.map((e) => e.payload))}`);
    console.log(`  notes.txt exists: ${existsSync(notes)} content: ${existsSync(notes) ? JSON.stringify(readFileSync(notes, "utf8").slice(0, 60)) : "-"}`);

    const ok =
      compaction.some((e) => (e.payload as { mode?: string }).mode === "llm-summary") &&
      session?.status === "completed";
    console.log(`\nREAL LLM-SUMMARY COMPACTION: ${ok ? "PASS" : "FAIL"}`);
    if (!ok) process.exitCode = 1;
  } finally {
    rmSync(forgeHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
