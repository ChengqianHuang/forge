import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCapabilities,
  isSafeBash,
  evaluateToolCall,
  defaultPolicy,
  loadPolicy,
  summarizeInput,
  appendRule,
  ruleFromApproval,
  DEFAULT_POLICY,
} from "./policy.ts";

describe("classifyCapabilities", () => {
  test("read tools map to read", () => {
    for (const t of ["read", "grep", "ls", "find"]) {
      assert.deepEqual(classifyCapabilities(t, {}), ["read"]);
    }
  });

  test("write / edit map directly", () => {
    assert.deepEqual(classifyCapabilities("write", {}), ["write"]);
    assert.deepEqual(classifyCapabilities("edit", {}), ["edit"]);
  });

  test("plain bash maps to bash", () => {
    assert.deepEqual(classifyCapabilities("bash", { command: "npm test" }), ["bash"]);
  });

  test("rm -rf /tmp/... is NOT destructive (project-level cleanup stays ask-able)", () => {
    assert.deepEqual(classifyCapabilities("bash", { command: "rm -rf /tmp/forge-cache node_modules" }), ["bash"]);
  });

  test("rm -rf / (root) IS destructive", () => {
    const caps = classifyCapabilities("bash", { command: "rm -rf /" });
    assert.equal(caps[0], "destructive");
  });

  test("sudo is destructive", () => {
    const caps = classifyCapabilities("bash", { command: "sudo apt install -y node" });
    assert.equal(caps[0], "destructive");
  });

  test("curl / ssh are network", () => {
    assert.equal(classifyCapabilities("bash", { command: "curl https://example.com" })[0], "network");
    assert.equal(classifyCapabilities("bash", { command: "scp x user@host:/tmp" })[0], "network");
  });

  test("git is git (and not destructive unless forced)", () => {
    assert.equal(classifyCapabilities("bash", { command: "git status" })[0], "git");
    const forced = classifyCapabilities("bash", { command: "git push --force origin main" });
    assert.equal(forced[0], "destructive");
  });

  test("unknown tool maps to unknown", () => {
    assert.deepEqual(classifyCapabilities("some_mystery_tool", { a: 1 }), ["unknown"]);
  });
});

describe("evaluateToolCall with defaults", () => {
  const p = defaultPolicy();

  test("read → allow", () => {
    assert.equal(evaluateToolCall(p, "read", { path: "src/a.ts" }).action, "allow");
  });

  test("write → allow (journal-backed; 9.6.x noise reduction)", () => {
    assert.equal(evaluateToolCall(p, "write", { path: "src/a.ts", content: "x" }).action, "allow");
  });

  test("edit → allow", () => {
    assert.equal(evaluateToolCall(p, "edit", { file: "a.ts" }).action, "allow");
  });

  test("plain bash → ask", () => {
    assert.equal(evaluateToolCall(p, "bash", { command: "npm test" }).action, "ask");
  });

  test("rm -rf / → deny with terminate", () => {
    const d = evaluateToolCall(p, "bash", { command: "rm -rf /" });
    assert.equal(d.action, "deny");
    assert.equal(d.terminate, true);
    assert.match(d.reason, /destructive-deny/);
  });

  test("sudo → deny", () => {
    assert.equal(evaluateToolCall(p, "bash", { command: "sudo whoami" }).action, "deny");
  });

  test("curl → ask (network)", () => {
    assert.equal(evaluateToolCall(p, "bash", { command: "curl -s https://api.example.com" }).action, "ask");
  });

  test("git status/diff/log → allow; git commit → ask", () => {
    assert.equal(evaluateToolCall(p, "bash", { command: "git status" }).action, "allow");
    assert.equal(evaluateToolCall(p, "bash", { command: "git diff HEAD" }).action, "allow");
    assert.equal(evaluateToolCall(p, "bash", { command: "git commit -m wip" }).action, "ask");
  });

  test("unknown tool → default ask", () => {
    assert.equal(evaluateToolCall(p, "weird_tool", {}).action, "ask");
  });

  test("custom default deny applies to unmatched", () => {
    const q = { ...p, default: "deny" as const };
    assert.equal(evaluateToolCall(q, "weird_tool", {}).action, "deny");
  });
});

describe("loadPolicy", () => {
  const TMP = "/tmp/forge-guard-policy-test";

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test("missing file → defaults", () => {
    const p = loadPolicy(join(TMP, "nope.json"));
    assert.deepEqual(p, DEFAULT_POLICY);
  });

  test("invalid json → defaults", () => {
    const f = join(TMP, "bad.json");
    writeFileSync(f, "not json", "utf8");
    assert.deepEqual(loadPolicy(f), DEFAULT_POLICY);
  });

  test("custom file: write → allow via rule override", () => {
    const f = join(TMP, "guard.json");
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        default: "ask",
        rules: [{ id: "write-allow", capability: "write", decision: "allow" }],
      }),
      "utf8",
    );
    const p = loadPolicy(f);
    assert.equal(p.rules.length, 1);
    assert.equal(evaluateToolCall(p, "write", { path: "x" }).action, "allow");
    assert.equal(evaluateToolCall(p, "bash", { command: "echo hi" }).action, "ask");
  });

  test("rule with tools + contains scope", () => {
    const f = join(TMP, "scoped.json");
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        default: "deny",
        rules: [
          { id: "r1", capability: "bash", tools: ["bash"], contains: "npm run build", decision: "allow" },
        ],
      }),
      "utf8",
    );
    const p = loadPolicy(f);
    assert.equal(evaluateToolCall(p, "bash", { command: "npm run build" }).action, "allow");
    assert.equal(evaluateToolCall(p, "bash", { command: "npm test" }).action, "deny");
  });
});

describe("summarizeInput", () => {
  test("truncates long input", () => {
    const s = summarizeInput({ command: "x".repeat(500) });
    assert.ok(s.length <= 303);
  });
});

describe("appendRule (always-allow persistence)", () => {
  const TMP2 = mkdtempSync(join(tmpdir(), "forge-guard-append-"));

  test("seeds with defaults + appends rule when file missing", async () => {
    const f = join(TMP2, "missing.json");
    await appendRule({ path: f, rule: { capability: "bash", contains: "pwd", decision: "allow" } });
    const p = loadPolicy(f);
    assert.ok(p.rules.some((r) => r.capability === "destructive" && r.decision === "deny"), "defaults preserved");
    assert.ok(p.rules.some((r) => r.capability === "bash" && r.contains === "pwd" && r.decision === "allow"), "rule appended");
  });

  test("appends to existing file, skips duplicates", async () => {
    const f = join(TMP2, "existing.json");
    const rule = { capability: "network" as const, contains: "example.com", decision: "allow" as const };
    await appendRule({ path: f, rule });
    const n1 = loadPolicy(f).rules.length;
    await appendRule({ path: f, rule });
    assert.equal(loadPolicy(f).rules.length, n1, "duplicate not re-added");
    assert.ok(loadPolicy(f).rules.some((r) => r.contains === "example.com"));
  });

  test("appended rule is honored by evaluation", async () => {
    const f = join(TMP2, "honored.json");
    await appendRule({ path: f, rule: { capability: "bash" as const, contains: "npm test", decision: "allow" as const } });
    const p = loadPolicy(f);
    assert.equal(evaluateToolCall(p, "bash", { command: "npm test" }).action, "allow");
  });
});

describe("ruleFromApproval", () => {
  test("parses bash command from approval title/message", () => {
    const r = ruleFromApproval("Allow bash?", JSON.stringify({ command: "pwd && ls -la" }));
    assert.ok(r);
    assert.equal(r.capability, "bash");
    assert.equal(r.contains, "pwd && ls -la");
    assert.equal(r.decision, "allow");
  });

  test("parses write path", () => {
    const r = ruleFromApproval("Allow write?", JSON.stringify({ path: "src/a.ts", content: "x" }));
    assert.ok(r);
    assert.equal(r.capability, "write");
    assert.equal(r.contains, "src/a.ts");
  });

  test("destructive ask never becomes always-allow", () => {
    const r = ruleFromApproval("Allow bash?", JSON.stringify({ command: "sudo rm -rf /tmp/x" }));
    // classifyCapabilities(bash, sudo) → destructive first; reject
    assert.ok(r === null || r.capability !== "destructive");
  });

  test("unparseable tool name → null", () => {
    assert.equal(ruleFromApproval("Random title", "{}"), null);
  });
});


describe("isSafeBash（default 审批级别的白名单）", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["plain ls", "ls -la /tmp/x", true],
    ["read-only chain", "cat a.txt && grep pattern b.txt", true],
    ["piped reads", "cat x | sort | uniq -c", true],
    ["git status", "git status", true],
    ["git diff", "git diff HEAD", true],
    ["git push", "git push origin main", false],
    ["network", "curl https://example.com", false],
    ["mutation", "rm -rf /tmp/x", false],
    ["mkdir", "mkdir -p a/b", false],
    ["redirect", "ls > /tmp/evil", false],
    ["substitution", "echo $(rm -rf /)", false],
    ["backtick", "cat `echo secret`", false],
    ["find -delete", "find . -name y -delete", false],
    ["find -exec", "find . -exec sh {} \\", false],
    ["npm test", "npm test", false],
    ["chained poison", "ls && curl https://evil", false],
    ["empty", "", false],
    ["non-string", 42, false],
  ];
  for (const [name, cmd, expected] of cases) {
    test(`${name} → ${expected ? "safe" : "asks"}`, () => {
      assert.equal(isSafeBash(cmd), expected);
    });
  }
});
