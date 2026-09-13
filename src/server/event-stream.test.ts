import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEventStream, type EventEnvelope } from "./event-stream.ts";

describe("TaskEventStream", () => {
  test("does not lose a JSONL record observed before its newline arrives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-event-stream-"));
    const sessionId = "partial-line";
    const path = join(dir, `${sessionId}.events.jsonl`);
    const line = JSON.stringify({
      id: "one",
      type: "TEXT_DELTA",
      sessionId,
      at: 1,
      payload: { delta: "完整" },
    });
    const split = Math.floor(line.length / 2);
    await writeFile(path, line.slice(0, split), "utf8");

    const stream = new TaskEventStream(dir, sessionId);
    const received: EventEnvelope[] = [];
    const following = stream.follow((event) => {
      received.push(event);
      stream.stop();
    });
    setTimeout(() => {
      void appendFile(path, `${line.slice(split)}\n`, "utf8");
    }, 30);

    await following;
    assert.equal(received.length, 1);
    assert.equal(received[0]?.type, "TEXT_DELTA");
    assert.equal(received[0]?.payload.delta, "完整");
    assert.equal(received[0]?.seq, 1);
  });
});
