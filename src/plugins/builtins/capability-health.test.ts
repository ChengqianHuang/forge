import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityHealthPlugin } from "./capability-health.ts";

test("declares capability health as required registered UI", () => {
  assert.equal(capabilityHealthPlugin.manifest.required, true);
  assert.deepEqual(capabilityHealthPlugin.manifest.ui, [{
    id: "capability-health",
    label: "能力",
    surface: "session-header",
    renderer: "capability-health",
  }]);
});
