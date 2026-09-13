/**
 * Deterministic golden tasks for the current runner and guardrails.
 *
 * Each task = a deterministic LLM script + session config + assertions.
 * Everything else (agentLoop, tools, guardrails, event log) runs for real.
 * Scripts are factories of the workspace path — tools resolve absolute
 * paths only, so the harness injects the temp workspace when building.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scriptedAssistantMessage, text, toolCall, type Script } from "./scripted-runtime.ts";
import type { Assertion, GoldenTask } from "./harness.ts";

const W = (id: string, path: string, content: string) =>
  scriptedAssistantMessage([toolCall(id, "write", { path, content })], "toolUse");

// ---------------------------------------------------------------------------
// golden_create_file — the "hello world" of the whole architecture.
// ---------------------------------------------------------------------------
const createFileScript = (ws: string): Script => [
  W("call-1", join(ws, "hello.txt"), "hello world\n"),
  scriptedAssistantMessage([text("Done — hello.txt created.")]),
];

export const goldenCreateFile: GoldenTask = {
  name: "golden_create_file",
  category: "new-feature",
  goal: "Create hello.txt saying hello",
  script: createFileScript,
  assert: ({ session, metrics, workspace, runtime }) => {
    const a: Assertion[] = [];
    a.push({
      name: "state=completed",
      pass: metrics.state === "completed",
      detail: `state=${metrics.state} reason=${session.failureReason}`,
    });
    a.push({ name: "script consumed exactly", pass: !runtime.overran() && runtime.consumed() === 2, detail: `consumed=${runtime.consumed()}` });
    const p = join(workspace, "hello.txt");
    const content = existsSync(p) ? readFileSync(p, "utf8") : "";
    a.push({ name: "file contains 'hello'", pass: content.includes("hello"), detail: JSON.stringify(content.slice(0, 40)) });
    return a;
  },
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// golden_stuck_loop — stuck detection terminates the burn before cost does.
// ---------------------------------------------------------------------------
function stuckScript(reps: number): Script {
  const s: Script = [];
  for (let i = 0; i < reps; i++) {
    // Identical args+content → identical observation → action_observation_loop.
    // Path is relative on purpose: identical args matter, and the write tool
    // rejecting/accepting makes no difference to the repetition signature.
    s.push(scriptedAssistantMessage([toolCall("call-stuck", "write", { path: "loop.txt", content: "same\n" })], "toolUse"));
  }
  return s;
}

export const goldenStuckLoop: GoldenTask = {
  name: "golden_stuck_loop",
  category: "recovery",
  goal: "Agent repeats an identical write forever (stuck)",
  script: () => stuckScript(10),
  assert: ({ metrics, runtime, session }) => {
    const a: Assertion[] = [];
    a.push({
      name: "STUCK_WARNING emitted",
      pass: metrics.stuckPatterns.includes("action_observation_loop"),
      detail: JSON.stringify(metrics.stuckPatterns),
    });
    a.push({
      name: "loop terminated early (before script end)",
      pass: runtime.consumed() < 10,
      detail: `consumed=${runtime.consumed()} of 10 scripted turns`,
    });
    a.push({
      name: "state=failed (guardrail kill recorded)",
      pass:
        metrics.state === "failed" &&
        metrics.failureReason !== null &&
        metrics.failureReason.startsWith("stuck detected"),
      detail: `state=${metrics.state} reason=${metrics.failureReason}`,
    });
    return a;
  },
};

// ---------------------------------------------------------------------------
// golden_multi_step — multiple dependent artifacts across turns.
// ---------------------------------------------------------------------------
const multiStepScript = (ws: string): Script => [
  W("call-1", join(ws, "util.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n"),
  W("call-2", join(ws, "main.ts"), "import { add } from './util.ts';\nconsole.log(add(1, 2));\n"),
  scriptedAssistantMessage([text("Both files written.")]),
];

export const goldenMultiStep: GoldenTask = {
  name: "golden_multi_step",
  category: "new-feature",
  goal: "Create util.ts and main.ts that imports it",
  script: multiStepScript,
  assert: ({ session, metrics, workspace, runtime }) => {
    const a: Assertion[] = [];
    a.push({
      name: "state=completed",
      pass: metrics.state === "completed",
      detail: `state=${metrics.state} reason=${session.failureReason}`,
    });
    a.push({ name: "script consumed exactly", pass: !runtime.overran() && runtime.consumed() === 3, detail: `consumed=${runtime.consumed()}` });
    const util = join(workspace, "util.ts");
    const main = join(workspace, "main.ts");
    a.push({
      name: "both artifacts correct",
      pass:
        existsSync(util) &&
        existsSync(main) &&
        readFileSync(util, "utf8").includes("export function add") &&
        readFileSync(main, "utf8").includes("add"),
    });
    return a;
  },
};

export const GOLDEN_TASKS = [goldenCreateFile, goldenStuckLoop, goldenMultiStep];
