/**
 * Read-only harness reliability report over durable session logs.
 *
 *   npm run reliability                 # all persisted sessions
 *   npm run reliability -- session_123  # selected sessions
 *   npm run reliability -- --json       # machine-readable trend input
 */
import { readEvents } from "../core/persistence/event-log.ts";
import { listSessions, loadSession } from "../core/persistence/session-store.ts";
import { extractReliabilityMetrics, formatReliabilityLine } from "../reliability/metrics.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const ids = args.filter((arg) => !arg.startsWith("--"));
  const sessions = ids.length > 0
    ? (await Promise.all(ids.map((id) => loadSession(id)))).filter((session) => session !== null)
    : await listSessions();
  const reports = await Promise.all(sessions.map(async (session) => ({
    sessionId: session.id,
    status: session.status,
    goal: session.goal,
    metrics: extractReliabilityMetrics({
      events: await readEvents(session.id),
      sessionStatus: session.status,
    }),
  })));

  if (json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
  } else if (reports.length === 0) {
    console.log("No persisted sessions found.");
  } else {
    console.log("==== Forge Harness Reliability ====");
    for (const report of reports) {
      console.log(`${report.sessionId} [${report.status}] ${formatReliabilityLine(report.metrics)}`);
      for (const violation of report.metrics.integrity.violations) {
        console.log(`  ✗ ${violation}`);
      }
    }
    const healthy = reports.filter((report) => report.metrics.integrity.healthy).length;
    console.log(`\n==== Integrity: ${healthy}/${reports.length} healthy ====`);
  }

  if (reports.some((report) => !report.metrics.integrity.healthy)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
