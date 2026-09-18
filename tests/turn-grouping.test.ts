import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTurns, isFoldable, summarizeFold } from "../desktop/src/lib/turns.ts";
import type { TimelineEntry } from "../desktop/src/types.ts";

const user = (id: string, text = "prompt"): TimelineEntry => ({ kind: "user", id, text });
const assistant = (id: string, text = "answer"): TimelineEntry => ({ kind: "assistant", id, text, streaming: false, thinking: false });
const tool = (id: string, isError = false): TimelineEntry => ({
  kind: "tool", id, toolCallId: id, toolName: "bash", args: {}, running: false, isError,
});
const notice = (id: string, tone: "info" | "ok" | "warn" = "info"): TimelineEntry =>
  ({ kind: "notice", id, tone, icon: "◆", text: "note" });

test("segments split at user entries; leading orphans form their own segment", () => {
  const timeline = [notice("n0"), user("u1"), tool("t1"), assistant("a1"), user("u2"), assistant("a2")];
  const segments = groupTurns(timeline, false);
  assert.deepEqual(segments.map((s) => s.id), ["n0", "u1", "u2"]);
  assert.equal(segments[0]!.head, null);
  assert.equal(segments[1]!.head!.id, "u1");
  assert.deepEqual(segments[1]!.entries.map((e) => e.id), ["u1", "t1", "a1"]);
});

test("a running session leaves only the last segment unsettled", () => {
  const timeline = [user("u1"), tool("t1"), user("u2"), tool("t2")];
  const segments = groupTurns(timeline, true);
  assert.equal(segments[0]!.settled, true);
  assert.equal(segments[1]!.settled, false);
  assert.equal(groupTurns(timeline, false)[1]!.settled, true);
});

test("foldable = tool rows plus info/ok notices; warn notices and prose never fold", () => {
  assert.equal(isFoldable(tool("t")), true);
  assert.equal(isFoldable(notice("n", "info")), true);
  assert.equal(isFoldable(notice("n", "ok")), true);
  assert.equal(isFoldable(notice("n", "warn")), false);
  assert.equal(isFoldable(assistant("a")), false);
  assert.equal(isFoldable(user("u")), false);
});

test("summary counts tools, notices and errors", () => {
  assert.deepEqual(
    summarizeFold([tool("t1"), tool("t2", true), notice("n1"), notice("n2", "ok")]),
    { tools: 2, notices: 2, errors: 1 },
  );
});
