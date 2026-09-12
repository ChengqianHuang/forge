/**
 * Real-LLM end-to-end regression (manual, NOT in release-check).
 *
 * Runs one real task through the full stack — SessionManager.create →
 * real MiniMax M2.7 (anthropic-messages) → real tools on a temp workspace
 * → FIFO event log — and asserts the outcome. Requires network + a
 * subscription in ~/.forge/forge-config.json (default provider used).
 *
 *   npx tsx src/cli/real-smoke.ts [goal-override]
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalHub } from "../server/approval-hub.ts";
import { ProjectsRegistry } from "../server/projects.ts";
import { SessionManager } from "../server/session-manager.ts";
import { readEvents } from "../core/persistence/event-log.ts";
import { loadSession } from "../core/persistence/session-store.ts";

const HOME_CONFIG = process.env.HOME + "/.forge/forge-config.json";
const GOAL =
  process.argv[2] ??
  'Create hello.txt in the workspace root with the exact single line: hello from minimax';

async function main(): Promise<void> {
  if (!existsSync(HOME_CONFIG)) {
    console.error("no ~/.forge/forge-config.json — nothing to test against");
    process.exit(1);
  }

  const forgeHome = mkdtempSync(join(tmpdir(), "forge-real-smoke-"));
  const workspace = mkdtempSync(join(tmpdir(), "forge-real-ws-"));
  // Real subscription config, isolated session/event storage.
  cpSync(HOME_CONFIG, join(forgeHome, "forge-config.json"));
  process.env.FORGE_EVENTS_DIR = join(forgeHome, "events");
  process.env.FORGE_SESSIONS_DIR = join(forgeHome, "sessions");

  let ok = true;
  try {
    const projects = new ProjectsRegistry(forgeHome);
    const manager = new SessionManager({
      forgeHome,
      projects,
      approvalHub: new ApprovalHub(),
    });

    // Register the temp workspace as the active project so manager.create
    // resolves Session.workspace to it (registry drives workspace, not input).
    const project = await projects.register({ path: workspace, name: "real-smoke" });
    await projects.select(project.id);

    const { sessionId } = await manager.create({
      goal: GOAL,
      projectId: project.id,
    });
    console.log(`  session: ${sessionId} workspace: ${workspace}`);

    // Settle wait with a hard ceiling — real models can think for a while.
    const entry = await (async () => {
      for (let i = 0; i < 120; i++) {
        const e = (manager as unknown as { active: Map<string, { runPromise: Promise<unknown> }> }).active.get(sessionId);
        if (!e) break; // settled
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    })();
    void entry;

    const session = await loadSession(sessionId);
    const helloPath = join(workspace, "hello.txt");
    const content = existsSync(helloPath) ? readFileSync(helloPath, "utf8") : "";
    const events = await readEvents(sessionId);

    // Event log sanity: seq must be implicit append order; types printable.
    const types = events.map((e) => e.type);
    console.log(`  events (${events.length}): ${types.join(" → ")}`);

    const textJoined = events
      .filter((e) => e.type === "MESSAGE_ENDED")
      .map((e) => JSON.stringify((e.payload as { message?: { content?: unknown } }).message?.content ?? ""))
      .join(" ");
    const thinkLeak = textJoined.includes("<think>");

    console.log(`  state: ${session?.status} (reason: ${session?.failureReason})`);
    console.log(`  usage: ${JSON.stringify(session?.usage)}`);
    console.log(`  hello.txt: ${JSON.stringify(content.slice(0, 80))}`);
    console.log(`  <think> leak: ${thinkLeak ? "YES (BUG)" : "no"}`);

    ok =
      ok &&
      session?.status === "completed" &&
      content.includes("hello from minimax") &&
      !thinkLeak &&
      events.some((e) => e.type === "TOOL_CALL") &&
      events.every((e) => e.type !== "GUARD_BLOCKED");
  } finally {
    rmSync(forgeHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
