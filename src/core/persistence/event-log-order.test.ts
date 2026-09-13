import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents } from "./event-log.ts";

describe("event log append ordering", () => {
  test("concurrent fire-and-forget appends persist in call order", async () => {
    // Regression: the streaming path issues one `void appendEvent` per agent
    // delta. Unchained, those concurrent appendFile calls raced in the libuv
    // threadpool and scrambled the JSONL line order, which the SSE stream and
    // the desktop consume as ordered truth (CJK delta reordering bug).
    const dir = await mkdtemp(join(tmpdir(), "forge-events-"));
    process.env.FORGE_EVENTS_DIR = dir;
    const sessionId = "order-test";

    const payloads = Array.from({ length: 120 }, (_, i) => ({
      piEvent: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: `δ${i}-中文片段-` + "x".repeat(i % 17) },
      },
    }));

    // Fire-and-forget, exactly like task-manager's onPiEvent.
    for (const [i, payload] of payloads.entries()) {
      void appendEvent(sessionId, "TEXT_DELTA", payload);
      if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
    }

    // Wait for the queue to drain.
    await appendEvent(sessionId, "SESSION_ENDED", {});

    const events = await readEvents(sessionId);
    const deltas = events.filter((e) => e.type === "TEXT_DELTA");
    assert.equal(deltas.length, 120);

    for (const [i, e] of deltas.entries()) {
      const expected = `δ${i}-中文片段-`;
      const actual = String((e.payload as any).piEvent.assistantMessageEvent.delta);
      assert.ok(actual.startsWith(expected), `position ${i}: expected "${expected}…", got "${actual.slice(0, 12)}…"`);
    }

    // Completed marker lands last.
    assert.equal(events[events.length - 1]?.type, "SESSION_ENDED");
  });

  test("awaited append resolves after its own line is durable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-events-"));
    process.env.FORGE_EVENTS_DIR = dir;
    const sessionId = "await-test";

    const event = await appendEvent(sessionId, "SESSION_CREATED", { goal: "g" });
    const events = await readEvents(sessionId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.id, event.id);
    assert.equal(events[0]?.type, "SESSION_CREATED");
  });

  test("drops an interrupted final record on read and repairs it before append", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-events-tail-"));
    process.env.FORGE_EVENTS_DIR = dir;
    const sessionId = `tail-test-${Date.now()}`;
    const path = join(dir, `${sessionId}.events.jsonl`);
    const first = JSON.stringify({
      id: "one", type: "SESSION_CREATED", sessionId, at: 1, payload: {},
    });
    await writeFile(path, `${first}\n{\"id\":\"interrupted`, "utf8");

    assert.deepEqual((await readEvents(sessionId)).map((event) => event.id), ["one"]);
    await appendEvent(sessionId, "SESSION_ENDED", {});

    const repaired = await readFile(path, "utf8");
    assert.equal(repaired.trimEnd().split("\n").length, 2);
    assert.deepEqual((await readEvents(sessionId)).map((event) => event.type), [
      "SESSION_CREATED",
      "SESSION_ENDED",
    ]);
  });

  test("preserves a complete final record that only lacks its newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-events-tail-"));
    process.env.FORGE_EVENTS_DIR = dir;
    const sessionId = `newline-test-${Date.now()}`;
    const path = join(dir, `${sessionId}.events.jsonl`);
    await writeFile(path, JSON.stringify({
      id: "one", type: "SESSION_CREATED", sessionId, at: 1, payload: {},
    }), "utf8");

    await appendEvent(sessionId, "SESSION_ENDED", {});
    assert.deepEqual((await readEvents(sessionId)).map((event) => event.type), [
      "SESSION_CREATED",
      "SESSION_ENDED",
    ]);
  });
});
