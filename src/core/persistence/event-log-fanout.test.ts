/**
 * Unit tests for the appendEvent fan-out contract.
 *
 * Architecture (docs/ARCHITECTURE.md):
 * - Control-plane events fan out to the EventBus after writing to disk.
 * - Data-plane events stay in the log only.
 * - Fan-out failure must not break the append chain or FIFO ordering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, isControlEvent, type PersistedEventType } from "./event-log.ts";
import { EventBus } from "../../events/event-bus.ts";
import type { ControlEvent, ControlEventListener } from "../../events/event-types.ts";

function setup(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "forge-eventlog-fanout-"));
  process.env.FORGE_EVENTS_DIR = dir;
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Concrete EventBus that records published events and supports fault injection. */
function recordingBus(): EventBus & {
  events: ControlEvent[];
  setThrows(v: boolean): void;
} {
  const events: ControlEvent[] = [];
  let throws = false;
  const listener: ControlEventListener = (event) => {
    if (throws) throw new Error("listener boom");
    events.push(event);
  };
  const bus = new EventBus();
  bus.subscribe(listener);
  return Object.assign(bus, {
    events,
    setThrows(v: boolean) {
      throws = v;
    },
  });
}

test("isControlEvent recognizes control-plane types", () => {
  const controlTypes: PersistedEventType[] = [
    "SESSION_CREATED",
    "SESSION_STARTED",
    "SESSION_RESUMED",
    "SESSION_ENDED",
    "SESSION_FAILED",
    "SESSION_CANCELLED",
    "STEERING_QUEUED",
    "APPROVAL_MODE_CHANGED",
    "COST_UPDATE",
    "STUCK_WARNING",
    "GUARD_DECISION",
    "GUARD_BLOCKED",
    "GUARD_APPROVAL_REQUEST",
    "SESSION_STARTED",
    "COMPACTION",
    "COMPACTION_FAILED",
    "PLUGIN_ENABLED",
  ];
  const dataTypes: PersistedEventType[] = [
    "SESSION_HISTORY_IMPORTED",
    "TURN_STARTED",
    "TURN_ENDED",
    "MESSAGE_STARTED",
    "MESSAGE_UPDATED",
    "MESSAGE_ENDED",
    "TEXT_DELTA",
    "TOOL_CALL",
    "TOOL_UPDATE",
    "TOOL_RESULT",
  ];
  for (const t of controlTypes) assert.equal(isControlEvent(t), true, `control: ${t}`);
  for (const t of dataTypes) assert.equal(isControlEvent(t), false, `data: ${t}`);
});

test("control-plane events fan out to the injected bus", async () => {
  const { cleanup } = setup();
  try {
    const bus = recordingBus();
    const ev = await appendEvent("task1", "SESSION_CREATED", { goal: "x" }, { bus });
    assert.equal(bus.events.length, 1);
    const received = bus.events[0]!;
    assert.equal(received.type, "SESSION_CREATED");
    assert.equal(received.id, ev.id);
    assert.equal(received.sessionId, "task1");
    assert.deepEqual(received.payload, { goal: "x" });
  } finally {
    cleanup();
  }
});

test("data-plane events do NOT fan out", async () => {
  const { cleanup } = setup();
  try {
    const bus = recordingBus();
    await appendEvent("task1", "MESSAGE_ENDED", { message: "x" }, { bus });
    await appendEvent("task1", "TEXT_DELTA", { delta: "y" }, { bus });
    await appendEvent("task1", "TOOL_CALL", { name: "bash" }, { bus });
    assert.equal(bus.events.length, 0);
  } finally {
    cleanup();
  }
});

test("fan-out failure does not break the append chain", async () => {
  const { cleanup } = setup();
  try {
    const bus = recordingBus();
    bus.setThrows(true);
    // The append itself must succeed even though the bus listener throws.
    const ev = await appendEvent(
      "task1",
      "GUARD_BLOCKED",
      { toolName: "bash", reason: "policy" },
      { bus },
    );
    assert.equal(ev.type, "GUARD_BLOCKED");
    // Subsequent appends (even on the same task) must still succeed.
    const ev2 = await appendEvent("task1", "COST_UPDATE", { spent: 0.01 }, { bus });
    assert.equal(ev2.type, "COST_UPDATE");
  } finally {
    cleanup();
  }
});

test("FIFO order preserved across mixed control/data events", async () => {
  const { cleanup } = setup();
  try {
    const bus = recordingBus();
    const sequence: PersistedEventType[] = [
      "SESSION_CREATED",
      "MESSAGE_ENDED",
      "GUARD_BLOCKED",
      "TEXT_DELTA",
      "COST_UPDATE",
      "TOOL_CALL",
      "SESSION_ENDED",
    ];
    for (const t of sequence) {
      await appendEvent("task1", t, { seq: t }, { bus });
    }
    // Bus should have received exactly the 4 control-plane entries, in order.
    assert.deepEqual(
      bus.events.map((e) => e.type),
      ["SESSION_CREATED", "GUARD_BLOCKED", "COST_UPDATE", "SESSION_ENDED"],
    );
  } finally {
    cleanup();
  }
});
