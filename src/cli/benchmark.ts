/**
 * Deterministic benchmark CLI: run all golden tasks and print a compact
 * report. Exit 1 if any task fails. No network access anywhere.
 */
import { runGoldenTask } from "../benchmark/harness.ts";
import { formatReportLine } from "../benchmark/metrics.ts";
import { GOLDEN_TASKS } from "../benchmark/tasks.ts";

async function main(): Promise<void> {
  console.log("==== Forge Golden Tasks ====");
  let failed = 0;

  for (const task of GOLDEN_TASKS) {
    const report = await runGoldenTask(task);
    console.log(`=== ${report.name} [${report.category}] ${report.goal}`);
    if (report.error) {
      console.log(`  run error: ${report.error}`);
    }
    console.log(formatReportLine(report.name, report.category, report.goal, report.metrics));
    for (const a of report.assertions) {
      console.log(`  ${a.pass ? "✓" : "✗"} ${a.name}${a.detail ? ` (${a.detail})` : ""}`);
    }
    if (!report.passed) failed++;
  }

  const total = GOLDEN_TASKS.length;
  console.log(`\n==== Golden: ${total - failed}/${total} passed ====`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
