/**
 * Real-model benchmark: run N small engineering tasks through the FULL stack
 * (SessionManager → real provider → real tools on temp workspaces) and
 * report task outcomes and harness integrity separately, alongside turns,
 * wall time and token usage.
 *
 * Manual, NOT in release-check — requires network + a subscription in
 * ~/.forge/forge-config.json. This is the dashboard for "real-task success
 * rate", the number the constitution's Rule 5.1 rewrite made the only
 * meaningful harness metric.
 *
 *   npx tsx src/cli/real-bench.ts            # all tasks
 *   npx tsx src/cli/real-bench.ts 1 3        # by index
 *
 * Results land in <forgeHome>/real-bench/<timestamp>.json for trend tracking.
 */
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalHub } from "../server/approval-hub.ts";
import { ProjectsRegistry } from "../server/projects.ts";
import { SessionManager } from "../server/session-manager.ts";
import { readEvents } from "../core/persistence/event-log.ts";
import { loadSession } from "../core/persistence/session-store.ts";
import { extractReliabilityMetrics, formatReliabilityLine, type ReliabilityMetrics } from "../reliability/metrics.ts";

const HOME_CONFIG = process.env.HOME + "/.forge/forge-config.json";
const SETTLE_TIMEOUT_MS = 5 * 60_000;

type RealTask = {
  name: string;
  goal: string;
  /** Files that must exist (relative paths) for the task to count as done. */
  requires: string[];
  /** Optional content assertions: substring checks per file. */
  contains?: Array<{ path: string; pattern: string }>;
};

const TASKS: readonly RealTask[] = [
  {
    name: "create-file",
    goal: 'Create hello.txt in the workspace root with the exact single line: hello from forge',
    requires: ["hello.txt"],
    contains: [{ path: "hello.txt", pattern: "hello from forge" }],
  },
  {
    name: "fix-bug",
    goal:
      'The file src/calc.ts exports add(a, b) but it returns a - b. Fix add so it returns a + b. Do not change anything else.',
    requires: ["src/calc.ts"],
    contains: [{ path: "src/calc.ts", pattern: "return a + b" }],
  },
  {
    name: "create-with-test",
    goal:
      'Create src/slug.ts exporting slugify(name: string): string that lowercases and joins words with dashes (e.g. "Hello World" -> "hello-world"). Then create test/slug.test.ts using node:assert that checks slugify("Hello World") === "hello-world". Run the test with `npm test` style node --test if a package.json exists, otherwise just run the test file with node directly to confirm it passes.',
    requires: ["src/slug.ts", "test/slug.test.ts"],
    contains: [{ path: "src/slug.ts", pattern: "slugify" }],
  },
  {
    name: "read-then-edit",
    goal:
      'Read notes.md in the workspace root. It lists three items; append a fourth line that says "- fourth". Keep the existing lines unchanged.',
    requires: ["notes.md"],
    contains: [{ path: "notes.md", pattern: "- fourth" }],
  },
  {
    name: "refactor-rename",
    goal:
      'In src/legacy.ts the exported function oldName should be renamed to newName. Rename it and update every usage inside src/legacy.ts only.',
    requires: ["src/legacy.ts"],
    contains: [{ path: "src/legacy.ts", pattern: "newName" }],
  },
];

/** Fixtures seeded into each task workspace. */
const FIXTURES: Record<string, string> = {
  "src/calc.ts": 'export function add(a: number, b: number): number {\n  return a - b;\n}\n',
  "notes.md": "- first\n- second\n- third\n",
  "src/legacy.ts": 'export function oldName(x: number): number {\n  return x * 2;\n}\n\nexport const alias = oldName;\n',
};

type TaskResult = {
  name: string;
  passed: boolean;
  status: string;
  failureReason: string | null;
  wallMs: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  toolCalls: number;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  reliability: ReliabilityMetrics;
};

async function runTask(manager: SessionManager, projects: ProjectsRegistry, task: RealTask): Promise<TaskResult> {
  const workspace = mkdtempSync(join(tmpdir(), `forge-real-bench-${task.name}-`));
  const checks: TaskResult["checks"] = [];
  try {
    // Seed fixtures.
    for (const [rel, content] of Object.entries(FIXTURES)) {
      const p = join(workspace, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content, "utf8");
    }

    const project = await projects.register({ path: workspace, name: `bench-${task.name}` });
    await projects.select(project.id);
    const { sessionId } = await manager.create({ goal: task.goal, projectId: project.id });
    console.log(`\n=== ${task.name} → ${sessionId}`);

    const t0 = Date.now();
    // Settle wait via the persisted session status (public surface — no
    // reach into manager internals): running → completed/failed/cancelled.
    let session = await loadSession(sessionId);
    while (session?.status === "running" && Date.now() - t0 < SETTLE_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 2000));
      session = await loadSession(sessionId);
    }
    const wallMs = Date.now() - t0;
    session ??= await loadSession(sessionId);
    const events = await readEvents(sessionId);
    const toolCalls = events.filter((e) => e.type === "TOOL_CALL").length;
    const turns = events.filter((e) => e.type === "MESSAGE_ENDED").length;
    const reliability = extractReliabilityMetrics({
      events,
      ...(session ? { sessionStatus: session.status } : {}),
    });

    checks.push({
      name: "status=completed",
      pass: session?.status === "completed",
      detail: `status=${session?.status} reason=${session?.failureReason ?? "-"}`,
    });
    for (const rel of task.requires) {
      checks.push({ name: `exists ${rel}`, pass: existsSync(join(workspace, rel)), detail: rel });
    }
    for (const c of task.contains ?? []) {
      const p = join(workspace, c.path);
      const content = existsSync(p) ? readFileSync(p, "utf8") : "";
      checks.push({ name: `contains ${c.path} ⊃ "${c.pattern}"`, pass: content.includes(c.pattern), detail: content.slice(0, 60) });
    }
    // Reasonable effort bound: a trivial task burning >40 turns is a smell.
    checks.push({ name: "turns <= 40", pass: turns > 0 && turns <= 40, detail: `turns=${turns}` });

    const passed = checks.every((c) => c.pass);
    console.log(`  ${passed ? "PASS" : "FAIL"} (${(wallMs / 1000).toFixed(1)}s, ${turns} turns, ${toolCalls} tool calls, in=${session?.usage.tokensIn ?? 0} out=${session?.usage.tokensOut ?? 0})`);
    console.log(`  harness: ${formatReliabilityLine(reliability)}`);
    for (const c of checks) {
      if (!c.pass) console.log(`    ✗ ${c.name}: ${c.detail}`);
    }
    return {
      name: task.name,
      passed,
      status: session?.status ?? "unknown",
      failureReason: session?.failureReason ?? null,
      wallMs,
      tokensIn: session?.usage.tokensIn ?? 0,
      tokensOut: session?.usage.tokensOut ?? 0,
      turns,
      toolCalls,
      checks,
      reliability,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!existsSync(HOME_CONFIG)) {
    console.error("no ~/.forge/forge-config.json — real-bench needs a real subscription");
    process.exit(1);
  }
  const picks = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n));
  const selected = picks.length > 0 ? TASKS.filter((_, i) => picks.includes(i)) : [...TASKS];

  const forgeHome = mkdtempSync(join(tmpdir(), "forge-real-bench-home-"));
  cpSync(HOME_CONFIG, join(forgeHome, "forge-config.json"));
  process.env.FORGE_EVENTS_DIR = join(forgeHome, "events");
  process.env.FORGE_SESSIONS_DIR = join(forgeHome, "sessions");

  const results: TaskResult[] = [];
  try {
    const projects = new ProjectsRegistry(forgeHome);
    const manager = new SessionManager({ forgeHome, projects, approvalHub: new ApprovalHub() });
    for (const task of selected) {
      results.push(await runTask(manager, projects, task));
    }
  } finally {
    const passed = results.filter((r) => r.passed).length;
    const summary = {
      at: new Date().toISOString(),
      total: results.length,
      passed,
      successRate: results.length > 0 ? Math.round((passed / results.length) * 100) / 100 : 0,
      harnessHealthy: results.filter((result) => result.reliability.integrity.healthy).length,
      totalTokensIn: results.reduce((a, r) => a + r.tokensIn, 0),
      totalTokensOut: results.reduce((a, r) => a + r.tokensOut, 0),
      totalWallMs: results.reduce((a, r) => a + r.wallMs, 0),
      results,
    };
    console.log(`\n==== Real-bench summary ====`);
    console.log(`success rate: ${passed}/${results.length} (${summary.successRate})`);
    console.log(`harness integrity: ${summary.harnessHealthy}/${results.length}`);
    console.log(`tokens: in=${summary.totalTokensIn} out=${summary.totalTokensOut}`);
    console.log(`wall: ${(summary.totalWallMs / 1000).toFixed(1)}s total`);

    // Trend artifact — stored outside the temp home so it survives cleanup.
    const outDir = join(process.env.HOME + "/.forge", "real-bench");
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `${Date.now()}.json`);
    writeFileSync(outFile, JSON.stringify(summary, null, 2), "utf8");
    console.log(`saved: ${outFile}`);

    rmSync(forgeHome, { recursive: true, force: true });
    if (passed !== results.length) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
