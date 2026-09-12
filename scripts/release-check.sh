#!/bin/bash
# Forge Release Verification (agent-loop architecture)
# Runs: typecheck → repo integrity → unit tests → skeleton smoke
# Exit 0 = all pass, exit 1 = any failure

set -euo pipefail
# Repo root derived from this script's location so the check runs anywhere
# (developer machine or CI), not just at one hard-coded path.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; FAIL=0; TOTAL=0

check() {
  local name="$1"; local cmd="$2"
  TOTAL=$((TOTAL+1))
  if eval "$cmd" > /tmp/forge-release-check.log 2>&1; then
    echo -e "  ${GREEN}✓${NC} $name"; PASS=$((PASS+1))
  else
    echo -e "  ${RED}✗${NC} $name"; cat /tmp/forge-release-check.log | tail -10; FAIL=$((FAIL+1))
  fi
}

echo "==== Forge Release Verification ===="
echo ""

echo "--- Typecheck ---"
check "main typecheck"        "cd $ROOT && npx tsc --noEmit"
check "desktop typecheck"     "cd $ROOT/desktop && npx tsc --noEmit"

echo ""
echo "--- Repo Integrity ---"
# The Pi runtime must stay git-tracked. It was once silently excluded by
# .gitignore while AGENTS.md/README claimed it was vendored — external
# reviewers saw a repo without Pi. This gate makes that impossible again.
check "vendored pi integrity" "cd $ROOT && git ls-files --error-unmatch pi/packages/agent/package.json >/dev/null && git ls-files --error-unmatch pi/packages/ai/package.json >/dev/null && git ls-files --error-unmatch pi/packages/coding-agent/package.json >/dev/null"
# Pi's dist/ must stay git-tracked: node_modules/@earendil-works/* symlink into
# pi/packages/*, so a fresh clone (CI!) has no runtime without it. This gate
# exists because pi/.gitignore once silently excluded dist/ and CI failed 14/26
# while every local run was green — the same failure shape as the pi/ exclusion.
check "pi dist integrity"     "cd $ROOT && git ls-files --error-unmatch pi/packages/agent/dist/index.js >/dev/null && git ls-files --error-unmatch pi/packages/ai/dist/index.js >/dev/null && git ls-files --error-unmatch pi/packages/coding-agent/dist/index.js >/dev/null"

echo ""
echo "--- Unit Tests ---"
check "schema tests"          "cd $ROOT && node --import tsx --test src/core/persistence/schema.test.ts"
check "event-log order tests" "cd $ROOT && node --import tsx --test src/core/persistence/event-log-order.test.ts"
check "event-log compat tests" "cd $ROOT && node --import tsx --test src/core/persistence/event-log-compat.test.ts"
check "event-log fanout test" "cd $ROOT && node --import tsx --test src/core/persistence/event-log-fanout.test.ts"
check "replay tests"          "cd $ROOT && node --import tsx --test src/core/persistence/replay.test.ts"
check "guard policy tests"    "cd $ROOT && node --import tsx --test src/guard/policy.test.ts"
check "guard wiring tests"    "cd $ROOT && node --import tsx --test src/guardrails/before-tool-call.test.ts"
check "stop gate tests"       "cd $ROOT && node --import tsx --test src/guardrails/should-stop-after-turn.test.ts"
check "approval-hub tests"    "cd $ROOT && node --import tsx --test src/server/approval-hub.test.ts"
check "config-store tests"   "cd $ROOT && node --import tsx --test src/server/config-store.test.ts"
check "model discovery tests" "cd $ROOT && node --import tsx --test src/server/model-discovery.test.ts"
check "stuck-detector tests" "cd $ROOT && node --import tsx --test src/guardrails/stuck-detector.test.ts"
check "usage tracker tests"     "cd $ROOT && node --import tsx --test src/guardrails/usage-tracker.test.ts"
check "protocol consistency"   "cd $ROOT && node --import tsx --test tests/protocol-consistency.test.ts"
check "compaction tests"     "cd $ROOT && node --import tsx --test src/guardrails/compaction.test.ts"

echo ""
echo "--- Integration ---"
check "skeleton smoke"        "cd $ROOT && npx tsx src/cli/smoke.ts"
check "guardrails smoke"      "cd $ROOT && npx tsx src/cli/smoke-guardrails.ts"
check "server smoke"          "cd $ROOT && npx tsx src/cli/smoke-server.ts"
check "recovery smoke"        "cd $ROOT && npx tsx src/cli/smoke-recovery.ts"
check "compaction smoke"      "cd $ROOT && npx tsx src/cli/smoke-compaction.ts"
check "benchmark goldens"     "cd $ROOT && npx tsx src/cli/benchmark.ts"

echo ""
echo "==== Summary: $PASS/$TOTAL passed, $FAIL failed ===="

if [ $FAIL -gt 0 ]; then exit 1; fi
