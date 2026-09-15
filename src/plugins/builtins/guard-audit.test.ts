import { test } from "node:test";
import assert from "node:assert/strict";
import { guardAuditPlugin } from "./guard-audit.ts";

test("declares guard audit as a required event-projected UI capability", () => {
  assert.equal(guardAuditPlugin.manifest.required, true);
  assert.deepEqual(guardAuditPlugin.manifest.ui, [{
    id: "guard-audit",
    label: "审计",
    surface: "session-header",
    renderer: "guard-audit",
  }]);
  assert.equal(guardAuditPlugin.read, undefined);
});
