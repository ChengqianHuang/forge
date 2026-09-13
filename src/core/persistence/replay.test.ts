import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "./event-log.ts";
import { replaySession } from "./replay.ts";

const TS = Date.now();

// AgentMessage is a TS union without guaranteed `id` field (id lives on
// SessionEntry, the on-disk format, not on in-memory AgentMessage). Cast
// through unknown so the tests can compare without fighting union narrowing.
type AnyMsg = { id?: string; role: string; content: unknown; timestamp: number };

function userMsg(text: string): AnyMsg {
  return { role: "user", content: [{ type: "text", text }], timestamp: TS };
}

function assistantMsg(text: string): AnyMsg {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: TS };
}

function textOf(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const first = content[0] as { text?: string } | undefined;
    return first?.text ?? "";
  }
  return "";
}

describe("replaySession", () => {
  let dir: string;
  let sessionId: string;

  async function freshSession(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "forge-replay-"));
    process.env.FORGE_EVENTS_DIR = dir;
    sessionId = `s_${Math.random().toString(36).slice(2, 8)}`;
    return sessionId;
  }

  test("returns empty messages for an empty log", async () => {
    await freshSession();
    const r = await replaySession(sessionId);
    assert.deepEqual(r.messages, []);
    assert.equal(r.hasMessageEvents, false);
  });

  test("replays MESSAGE_ENDED messages, drops MESSAGE_STARTED and audit events", async () => {
    await freshSession();
    const m1 = userMsg("hi");
    const m2 = assistantMsg("hello");
    const m3 = userMsg("do thing");

    // Lifecycle / guardrail events — must be IGNORED.
    await appendEvent(sessionId, "SESSION_CREATED", { goal: "x" });
    await appendEvent(sessionId, "STUCK_WARNING", { reason: "test" });
    await appendEvent(sessionId, "COST_UPDATE", { spent: 0.01 });

    // MESSAGE_STARTED alone (no MESSAGE_ENDED) must be IGNORED.
    await appendEvent(sessionId, "MESSAGE_STARTED", { message: m1 });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: m1 });
    await appendEvent(sessionId, "MESSAGE_STARTED", { message: m2 });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: m2 });
    await appendEvent(sessionId, "MESSAGE_STARTED", { message: m3 });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: m3 });

    // More audit events.
    await appendEvent(sessionId, "STEERING_QUEUED", { message: "steer" });
    await appendEvent(sessionId, "STUCK_WARNING", { ok: true });

    const r = await replaySession(sessionId);
    assert.equal(r.messages.length, 3);
    assert.deepEqual(r.messages.map(textOf), ["hi", "hello", "do thing"]);
  });

  test("preserves chronological order across many turns", async () => {
    await freshSession();
    for (let i = 0; i < 6; i++) {
      const user = userMsg(`turn-${i}-q`);
      const asst = assistantMsg(`turn-${i}-a`);
      await appendEvent(sessionId, "TURN_STARTED", {});
      await appendEvent(sessionId, "MESSAGE_STARTED", { message: user });
      if (i === 2) await appendEvent(sessionId, "STUCK_WARNING", { turn: 2 });
      await appendEvent(sessionId, "MESSAGE_ENDED", { message: user });
      await appendEvent(sessionId, "MESSAGE_STARTED", { message: asst });
      await appendEvent(sessionId, "MESSAGE_UPDATED", { message: asst });
      await appendEvent(sessionId, "MESSAGE_ENDED", { message: asst });
      await appendEvent(sessionId, "TURN_ENDED", {});
    }
    const r = await replaySession(sessionId);
    assert.equal(r.messages.length, 12);
    assert.deepEqual(
      r.messages.map(textOf),
      [
        "turn-0-q",
        "turn-0-a",
        "turn-1-q",
        "turn-1-a",
        "turn-2-q",
        "turn-2-a",
        "turn-3-q",
        "turn-3-a",
        "turn-4-q",
        "turn-4-a",
        "turn-5-q",
        "turn-5-a",
      ],
    );
  });

  test("drops MESSAGE_STARTED with no matching MESSAGE_ENDED (process crashed mid-stream)", async () => {
    await freshSession();
    const complete = userMsg("complete");
    const incomplete = assistantMsg("incomplete — aborted mid-stream");
    const trailing = userMsg("after");

    await appendEvent(sessionId, "MESSAGE_STARTED", { message: complete });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: complete });

    // Aborted mid-stream — STARTED but no ENDED. Must be absent from replay.
    await appendEvent(sessionId, "MESSAGE_STARTED", { message: incomplete });
    await appendEvent(sessionId, "MESSAGE_UPDATED", { message: incomplete });

    // New turn after the abort.
    await appendEvent(sessionId, "MESSAGE_STARTED", { message: trailing });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: trailing });

    const r = await replaySession(sessionId);
    assert.deepEqual(r.messages.map(textOf), ["complete", "after"]);
  });

  test("uses MESSAGE_ENDED's message as the authoritative terminal state", async () => {
    await freshSession();
    // Start with a truncated version, end with the full version. Replay must
    // use the end (full), not the start (partial).
    const partial = assistantMsg("halfway ");
    const full = assistantMsg("halfway done");

    await appendEvent(sessionId, "MESSAGE_STARTED", { message: partial });
    await appendEvent(sessionId, "MESSAGE_UPDATED", { message: partial });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: full });

    const r = await replaySession(sessionId);
    assert.equal(r.messages.length, 1);
    assert.equal(textOf(r.messages[0]), "halfway done");
  });

  test("replaces model history at a durable compaction boundary", async () => {
    await freshSession();
    for (const text of ["old-1", "old-2", "retained"]) {
      await appendEvent(sessionId, "MESSAGE_ENDED", { message: userMsg(text) });
    }
    await appendEvent(sessionId, "COMPACTION", {
      mode: "llm-summary",
      contextMessages: [userMsg("summary"), userMsg("retained")],
    });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: assistantMsg("after") });

    const r = await replaySession(sessionId);
    assert.deepEqual(r.messages.map(textOf), ["summary", "retained", "after"]);
    assert.equal(r.hasMessageEvents, true);
  });

  test("ignores MESSAGE_ENDED with no message payload", async () => {
    await freshSession();
    await appendEvent(sessionId, "MESSAGE_ENDED", {});
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: null });
    await appendEvent(sessionId, "MESSAGE_ENDED", { message: userMsg("real") });
    const r = await replaySession(sessionId);
    assert.equal(r.messages.length, 1);
    assert.equal(textOf(r.messages[0]), "real");
  });

  // Cleanup shared tmp dirs.
  test("cleanup", async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    assert.ok(true);
  });
});
