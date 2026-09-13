import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApprovalHub } from "./approval-hub.ts";

describe("ApprovalHub", () => {
  test("records and lists pending approvals oldest-first", () => {
    const hub = new ApprovalHub();
    hub.record({ requestId: "r2", sessionId: "t1", method: "confirm", title: "A", message: "m2", at: 20 });
    hub.record({ requestId: "r1", sessionId: "t1", method: "confirm", title: "B", message: "m1", at: 10 });
    hub.record({ requestId: "rX", sessionId: "t2", method: "confirm", title: "C", message: "m3", at: 15 });

    const list = hub.listPending("t1");
    assert.equal(list.length, 2);
    assert.equal(list[0]?.requestId, "r1");
    assert.equal(list[1]?.requestId, "r2");
    assert.equal(list[0]?.status, "pending");
  });

  test("mark flips status; resolved requests leave the pending list", () => {
    const hub = new ApprovalHub();
    hub.record({ requestId: "r1", sessionId: "t1", method: "confirm", title: "A", message: "m", at: 1 });
    assert.equal(hub.mark("r1", "approved"), true);
    assert.equal(hub.mark("nope", "approved"), false);
    assert.equal(hub.listPending("t1").length, 0);
    assert.equal(hub.get("r1")?.status, "approved");
  });

  test("get returns null for unknown request", () => {
    const hub = new ApprovalHub();
    assert.equal(hub.get("ghost"), null);
  });

  test("cancelSession expires pending requests and releases their waiters", async () => {
    const hub = new ApprovalHub();
    const waiting = hub.request({
      requestId: "r1",
      sessionId: "t1",
      toolName: "bash",
      input: { command: "npm test" },
    });
    hub.cancelSession("t1");
    assert.equal(await waiting, false);
    assert.equal(hub.get("r1")?.status, "expired");
    assert.deepEqual(hub.listPending("t1"), []);
  });
});
