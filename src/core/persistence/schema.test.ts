import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SESSION_SCHEMA_VERSION, migrateSession, stampSchemaVersion } from "./schema.ts";

describe("session schema migration", () => {
  test("legacy v3 TaskSession migrates to Session v4", () => {
    const legacyTask = {
      schemaVersion: 3,
      id: "task_20260908_a1",
      goal: "create hello.txt",
      state: "COMPLETE",
      directory: "/tmp/old",
      workspacePath: "/tmp/project",
      projectId: "p1",
      model: { provider: "custom", modelId: "gpt-x" },
      fixCount: 2,
      plan: { steps: [] },
      observations: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const out = migrateSession(legacyTask);
    assert.equal(out.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.equal(out.status, "completed");
    assert.equal(out.goal, "create hello.txt");
    assert.equal(out.workspace, "/tmp/project");
    assert.equal("plan" in out, false);
    assert.equal("fixCount" in out, false);
    assert.ok(String(out.id).startsWith("session_"));
  });

  test("unfinished legacy states map to cancelled", () => {
    for (const state of ["READY", "UNDERSTAND", "PLAN", "EXECUTE", "OBSERVE", "FIX"]) {
      const out = migrateSession({ schemaVersion: 3, id: "t", goal: "g", state });
      assert.equal(out.status, "cancelled");
      assert.equal(out.failureReason, "migrated from legacy task state");
    }
  });

  test("a v6 session (cost, no usage) migrates to token counters", () => {
    // The real-world failure: existing sessions carried `cost` and no `usage`,
    // so resume() handed `undefined` to UsageTracker.hydrate and every
    // pre-existing session died with "reading 'tokensIn'".
    const v6 = {
      schemaVersion: 6,
      id: "session_old",
      goal: "g",
      cost: { total: 0.42, budget: 5 },
      thinkingLevel: "off",
    };
    const out = migrateSession(v6);
    assert.equal(out.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.equal("cost" in out, false, "the dollar record is dropped, not carried");
    assert.deepEqual(out.usage, {
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      lastContextTokens: null,
    });
  });

  test("a current-version session missing `usage` is still normalized", () => {
    // Version stamp === current is NOT proof the fields are there (a write
    // from an older build already carrying the stamp used to short-circuit
    // the whole migration pass).
    const out = migrateSession({ schemaVersion: SESSION_SCHEMA_VERSION, id: "s1", goal: "g" });
    assert.ok(out.usage, "usage is filled in even without a migration step");
    assert.equal((out.usage as { tokensIn: number }).tokensIn, 0);
  });

  test("stamping writes the current version", () => {
    const stamped = stampSchemaVersion({ id: "s1" });
    assert.equal(stamped.schemaVersion, SESSION_SCHEMA_VERSION);
  });
});
