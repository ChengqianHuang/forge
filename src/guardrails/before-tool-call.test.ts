/**
 * Regression tests for the beforeToolCall hook's two wiring bugs found in the
 * guardrail wiring review — both were silent no-ops:
 *
 *   1. Undo journaling read `process.env.FORGE_UNDO_DIR`, which nothing in
 *      production ever set, so `journalFile` returned null immediately. The
 *      fix threads an explicit per-session `undoRoot` through GuardrailConfig.
 *   2. The capability policy called `loadPolicy()` with no path, which always
 *      returned the built-in default and ignored the user's `guard.json`. The
 *      fix passes `defaultPolicyPath()`.
 *
 * These are integration-level (hook + journal + policy file) because the
 * failure mode was "each unit passes, the wire between them is missing".
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBeforeToolCall } from "./before-tool-call.ts";
import { UsageTracker } from "./usage-tracker.ts";
import { ApprovalHub } from "../server/approval-hub.ts";
import { readEvents } from "../core/persistence/event-log.ts";
import type { GuardrailConfig } from "./types.ts";
import type { Session } from "../types.ts";

const TMP = "/tmp/forge-guard-wiring-tests";
const WS = join(TMP, "ws");

function stubSession(workspace: string): Session {
  return {
    id: "session-guard-test",
    goal: "test",
    workspace,
    projectId: null,
    model: { provider: "stub", modelId: "stub" },
    messages: [],
    status: "running",
    failureReason: null,
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
    approvalMode: "default",
    thinkingLevel: "off",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function config(undoRoot: string): GuardrailConfig {
  return {
    sessionId: "session-guard-test",
    workspace: WS,
    undoRoot,
    session: stubSession(WS),
    approval: { request: async () => true },
    steeringQueue: [],
    usage: new UsageTracker(),
  };
}

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.FORGE_GUARD_POLICY;
  delete process.env.FORGE_EVENTS_DIR;
});

/** Parse the journal JSONL written by the hook (journal.ts no longer exports a reader). */
function readJournalLines(undoRoot: string): Array<{ path: string; backup: string | null; action: string }> {
  const raw = readFileSync(join(undoRoot, "journal.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("beforeToolCall → undo journal wiring", () => {
  test("a write tool call journals the target under config.undoRoot", async () => {
    const undoRoot = join(TMP, "undo-write");
    const target = join(WS, "guard-target.txt");
    writeFileSync(target, "before\n", "utf8");

    const hook = makeBeforeToolCall(config(undoRoot));
    const result = await hook({
      toolCall: { name: "write", id: "call-1" },
      args: { path: "guard-target.txt", content: "after\n" },
    } as never);

    assert.equal(result, undefined, "write is allowed by default policy");
    const entries = readJournalLines(undoRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.action, "modified");
    assert.equal(entries[0]!.path, target);
    assert.ok(entries[0]!.backup && existsSync(entries[0]!.backup!));
  });

  test("a created file journals with a null backup", async () => {
    const undoRoot = join(TMP, "undo-create");
    const hook = makeBeforeToolCall(config(undoRoot));
    const result = await hook({
      toolCall: { name: "edit", id: "call-2" },
      args: { path: "brand-new.txt" },
    } as never);

    assert.equal(result, undefined);
    const entries = readJournalLines(undoRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.action, "created");
    assert.equal(entries[0]!.backup, null);
  });
});

describe("beforeToolCall → approval mode", () => {
  function recordingRelay() {
    const asks: string[] = [];
    return {
      asks,
      relay: {
        request: async (input: { toolName: string }) => {
          asks.push(input.toolName);
          return true;
        },
      },
    };
  }

  test('"always" releases every ask (destructive floor still holds)', async () => {
    const { asks, relay } = recordingRelay();
    const base = config(join(TMP, "mode-always"));
    const cfg: GuardrailConfig = {
      ...base,
      approvalMode: "always",
      approval: relay,
    };
    const hook = makeBeforeToolCall(cfg);

    assert.equal(await hook({ toolCall: { name: "bash", id: "a1" }, args: { command: "curl https://x" } } as never), undefined);
    assert.equal(await hook({ toolCall: { name: "bash", id: "a2" }, args: { command: "git push origin main" } } as never), undefined);
    assert.equal(asks.length, 0, "nothing asked");

    // The destructive floor is NOT relaxed by the mode.
    const result = await hook({ toolCall: { name: "bash", id: "a3" }, args: { command: "sudo rm -rf /" } } as never);
    assert.ok(result && result.block === true, "sudo is still denied");
  });

  test('"default" whitelists safe commands, still asks the rest', async () => {
    const { asks, relay } = recordingRelay();
    const base = config(join(TMP, "mode-default"));
    const cfg: GuardrailConfig = { ...base, approval: relay };
    const hook = makeBeforeToolCall(cfg);

    assert.equal(await hook({ toolCall: { name: "bash", id: "d1" }, args: { command: "ls -la /tmp/x" } } as never), undefined);
    assert.equal(asks.length, 0, "ls is whitelisted");

    assert.equal(await hook({ toolCall: { name: "bash", id: "d2" }, args: { command: "npm test" } } as never), undefined);
    assert.equal(asks.length, 0, "npm test is whitelisted");

    assert.equal(await hook({ toolCall: { name: "bash", id: "d3" }, args: { command: "curl https://x" } } as never), undefined);
    assert.equal(asks.length, 1, "curl still asks");
  });

  test('"ask" asks even for safe commands', async () => {
    const { asks, relay } = recordingRelay();
    const base = config(join(TMP, "mode-ask"));
    const cfg: GuardrailConfig = {
      ...base,
      approvalMode: "ask",
      approval: relay,
    };
    const hook = makeBeforeToolCall(cfg);

    assert.equal(await hook({ toolCall: { name: "bash", id: "k1" }, args: { command: "ls -la /tmp/x" } } as never), undefined);
    assert.equal(asks.length, 1, "even ls asks");
  });
});

describe("beforeToolCall → approval key alignment", () => {
  test("an ask is discoverable by sessionId (the dialog's only lookup key)", async () => {
    // Regression for the real-world freeze: the hook called approval.request()
    // without a sessionId, so the hub filed the request under `undefined`
    // while the desktop asked for it by session id — no dialog ever appeared
    // and the hook sat out the full 5-minute timeout (twice, as the model
    // retried) before reporting the command as blocked.
    const hub = new ApprovalHub();
    const cfg: GuardrailConfig = {
      ...config(join(TMP, "undo-approval-key")),
      sessionId: "session_key_1",
      approval: hub,
    };
    const hook = makeBeforeToolCall(cfg);

    // curl: NOT whitelisted in the default mode (ls would auto-allow now —
    // that whitelist is the whole point of the mode).
    const pendingCall = hook({
      toolCall: { name: "bash", id: "call-key-1" },
      args: { command: "curl https://example.com" },
    } as never);
    await new Promise((r) => setTimeout(r, 30));

    const pending = hub.listPending("session_key_1");
    assert.equal(pending.length, 1, "the desktop can find the request by session id");
    assert.equal(pending[0]!.title, "Allow bash?");

    // Approving through the same request id releases the hook.
    hub.mark("call-key-1", "approved");
    assert.equal(await pendingCall, undefined, "approved → the tool runs");
  });

  test("a denied ask blocks the tool", async () => {
    const hub = new ApprovalHub();
    const cfg: GuardrailConfig = {
      ...config(join(TMP, "undo-approval-deny")),
      sessionId: "session_key_2",
      approval: hub,
    };
    const hook = makeBeforeToolCall(cfg);
    const pendingCall = hook({
      toolCall: { name: "bash", id: "call-key-2" },
      args: { command: "rm -rf /tmp/x" },
    } as never);
    await new Promise((r) => setTimeout(r, 30));
    hub.mark("call-key-2", "denied");
    const result = await pendingCall;
    assert.ok(result && result.block === true, "denied → blocked");
  });
});

describe("beforeToolCall → durable decision evidence", () => {
  test("records final outcomes for automatic allow, policy deny and user rejection", async () => {
    const base = config(join(TMP, "undo-evidence"));
    const allowHook = makeBeforeToolCall(base);
    await allowHook({
      toolCall: { name: "bash", id: "evidence-allow" },
      args: { command: "git status" },
    } as never);

    await allowHook({
      toolCall: { name: "bash", id: "evidence-deny" },
      args: { command: "sudo whoami" },
    } as never);

    const rejectHook = makeBeforeToolCall({
      ...base,
      approval: { request: async () => false },
    });
    await rejectHook({
      toolCall: { name: "bash", id: "evidence-reject" },
      args: { command: "curl https://example.com" },
    } as never);

    const decisions = (await readEvents(base.sessionId))
      .filter((event) => event.type === "GUARD_DECISION")
      .filter((event) => String(event.payload.toolCallId).startsWith("evidence-"));
    assert.deepEqual(
      decisions.map((event) => ({
        id: event.payload.toolCallId,
        outcome: event.payload.outcome,
        capability: event.payload.capability,
        ruleId: event.payload.ruleId,
        basis: event.payload.basis,
      })),
      [
        { id: "evidence-allow", outcome: "allowed", capability: "git", ruleId: "git-ask", basis: "safe-command" },
        { id: "evidence-deny", outcome: "denied", capability: "destructive", ruleId: "destructive-deny", basis: "policy" },
        { id: "evidence-reject", outcome: "rejected", capability: "network", ruleId: "network-ask", basis: "user" },
      ],
    );
  });
});

describe("beforeToolCall → abort wiring", () => {
  test("Stop wins over a pending approval wait (the 卡死 bug)", async () => {
    // bash is "ask" by default. The approval relay never answers — the old
    // implementation blocked here for the full 5-minute timeout and ignored
    // the abort signal, so a Stop press did nothing while the model's retry
    // re-armed the wait forever.
    const never: GuardrailConfig = {
      ...config(join(TMP, "undo-abort")),
      approval: { request: () => new Promise<boolean>(() => {}) },
    };
    const hook = makeBeforeToolCall(never);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    // curl is not whitelisted in the default mode, so the hook really blocks
    // on the approval wait (the state that made Stop appear dead).
    const result = await Promise.race([
      hook(
        { toolCall: { name: "bash", id: "call-5" }, args: { command: "curl https://example.com" } } as never,
        controller.signal,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hook still blocked 500ms after abort")), 500),
      ),
    ]);
    assert.ok(result && result.block === true, "aborted call is blocked");
    assert.equal(result.terminate, true, "aborted call terminates the session");
  });
});

describe("beforeToolCall → user policy wiring", () => {
  test("a user rule in guard.json is honored (deny overrides the default allow)", async () => {
    const policyPath = join(TMP, "guard-deny-write.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        default: "ask",
        rules: [{ id: "deny-write", capability: "write", decision: "deny" }],
      }),
      "utf8",
    );

    const prev = process.env.FORGE_GUARD_POLICY;
    process.env.FORGE_GUARD_POLICY = policyPath;
    try {
      const hook = makeBeforeToolCall(config(join(TMP, "undo-policy")));
      const result = await hook({
        toolCall: { name: "write", id: "call-3" },
        args: { path: "anything.txt" },
      } as never);
      assert.ok(result && result.block === true, "user deny rule blocks the call");
    } finally {
      if (prev === undefined) delete process.env.FORGE_GUARD_POLICY;
      else process.env.FORGE_GUARD_POLICY = prev;
    }
  });

  test("with no user file the built-in default allows write", async () => {
    const prev = process.env.FORGE_GUARD_POLICY;
    process.env.FORGE_GUARD_POLICY = join(TMP, "does-not-exist.json");
    try {
      const hook = makeBeforeToolCall(config(join(TMP, "undo-default")));
      const result = await hook({
        toolCall: { name: "write", id: "call-4" },
        args: { path: "anything.txt" },
      } as never);
      assert.equal(result, undefined);
    } finally {
      if (prev === undefined) delete process.env.FORGE_GUARD_POLICY;
      else process.env.FORGE_GUARD_POLICY = prev;
    }
  });
});
