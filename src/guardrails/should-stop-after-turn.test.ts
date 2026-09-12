/**
 * Unit tests for the shouldStopAfterTurn gate's transparent-recovery paths
 * that the constitution (AGENTS.md Rule 5.5) promises:
 *
 *   - empty stop → "try again" steering, max 3, then an honest failure
 *   - model stop → done, no client-side verification (模型是最强大脑,
 *     PM 2026-09-12 — trust levels / criteria / evaluator retired)
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeShouldStopAfterTurn } from "./should-stop-after-turn.ts";
import { UsageTracker } from "./usage-tracker.ts";
import type { GuardrailConfig } from "./types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Session } from "../types.ts";

const TMP = mkdtempSync(join(tmpdir(), "forge-stop-gate-tests-"));

function makeSession(): Session {
  return {
    id: "session-stop-gate-test",
    goal: "test",
    workspace: TMP,
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

function makeConfig(session: Session): {
  config: GuardrailConfig;
  steered: string[];
} {
  const steered: string[] = [];
  const config: GuardrailConfig = {
    sessionId: session.id,
    workspace: session.workspace,
    undoRoot: join(TMP, "undo"),
    session,
    approval: { request: async () => true },
    steeringQueue: {
      push: (m: AgentMessage) => {
        const c = (m as { content?: unknown }).content as Array<{ type: string; text?: string }>;
        steered.push((c ?? []).map((b) => (b.type === "text" ? b.text ?? "" : "")).join(""));
      },
    } as unknown as GuardrailConfig["steeringQueue"],
    usage: new UsageTracker(),
  };
  return { config, steered };
}

function stopTurn(text: string): { message: unknown } {
  return {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

before(() => {
  process.env.FORGE_EVENTS_DIR = join(TMP, "events");
});

after(() => {
  delete process.env.FORGE_EVENTS_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

describe("empty stop recovery (Rule 5.5)", () => {
  test("steers up to 3 times, then surfaces an honest failure", async () => {
    const session = makeSession();
    const { config, steered } = makeConfig(session);
    const gate = makeShouldStopAfterTurn(config);
    const emptyTurn = { message: { role: "assistant", stopReason: "stop", content: [] } };

    assert.equal(await gate(emptyTurn as never), false);
    assert.equal(await gate(emptyTurn as never), false);
    assert.equal(await gate(emptyTurn as never), false);
    assert.equal(steered.length, 3, "three recovery attempts steered");

    assert.equal(await gate(emptyTurn as never), true, "4th empty stop ends the run");
    assert.equal(session.failureReason, "empty response after retries");
  });
});

describe("model stop → done (no client-side verification)", () => {
  test("a normal stop ends the run without steering", async () => {
    const session = makeSession();
    const { config, steered } = makeConfig(session);
    const gate = makeShouldStopAfterTurn(config);
    assert.equal(await gate(stopTurn("done") as never), true);
    assert.equal(steered.length, 0, "no steering on an honest completion");
  });

  test("a toolUse turn keeps the loop going", async () => {
    const session = makeSession();
    const { config } = makeConfig(session);
    const gate = makeShouldStopAfterTurn(config);
    const toolTurn = {
      message: { role: "assistant", stopReason: "toolUse", content: [] },
    };
    assert.equal(await gate(toolTurn as never), false);
  });
});

describe("provider error recovery", () => {
  test("steers up to 3 times, then surfaces the error", async () => {
    const session = makeSession();
    const { config, steered } = makeConfig(session);
    const gate = makeShouldStopAfterTurn(config);
    const errorTurn = {
      message: { role: "assistant", stopReason: "error", errorMessage: "502 bad gateway" },
    };

    assert.equal(await gate(errorTurn as never), false);
    assert.equal(await gate(errorTurn as never), false);
    assert.equal(await gate(errorTurn as never), false);
    assert.equal(steered.length, 3, "three recovery attempts steered");

    assert.equal(await gate(errorTurn as never), true, "4th error ends the run");
    assert.equal(session.failureReason, "502 bad gateway");
  });
});
