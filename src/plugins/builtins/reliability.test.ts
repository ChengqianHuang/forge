import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { reliabilityPlugin } from "./reliability.ts";
import type { Session } from "../../types.ts";

test("projects reliability from the event log without activating runtime state", async () => {
  assert.equal(reliabilityPlugin.manifest.required, true);
  assert.equal(reliabilityPlugin.manifest.ui?.[0]?.readAction, "metrics");
  const session = {
    id: `reliability-test-${randomUUID()}`,
    status: "completed",
  } as Session;
  const result = await reliabilityPlugin.read?.("metrics", {}, {
    session,
    signal: new AbortController().signal,
  }) as { eventCount: number; integrity: { healthy: boolean } };
  assert.equal(result.eventCount, 0);
  assert.equal(result.integrity.healthy, true);
});
