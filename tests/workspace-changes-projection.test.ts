import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "../desktop/src/types.ts";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
});

test("desktop folds the latest workspace change snapshot from the event log", async () => {
  const { reduceEnvelope, store } = await import("../desktop/src/lib/store.ts");
  const initial = store.getState();
  const envelope: EventEnvelope = {
    type: "WORKSPACE_CHANGES",
    at: 10,
    payload: {
      supported: true,
      repoRoot: "/repo",
      phase: "current",
      files: [
        { path: "src/a.ts", status: " M", additions: 3, deletions: 1, preexisting: true, changedDuringSession: true },
      ],
    },
  };
  const next = { ...initial, ...reduceEnvelope(initial, envelope) };
  assert.equal(next.conversation.workspaceChanges?.repoRoot, "/repo");
  assert.equal(next.conversation.workspaceChanges?.files[0]?.path, "src/a.ts");
  assert.equal(next.conversation.workspaceChanges?.files[0]?.preexisting, true);
});
