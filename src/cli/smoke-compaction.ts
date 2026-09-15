/**
 * Phase 5 smoke test for the compaction path: prepareNextTurn hook.
 *
 * Strategy: exercise makePrepareNextTurn directly to verify
 * 1) trigger logic — when lastInputTokens >= threshold, truncate context;
 * 2) COMPACTION event emitted with the agreed shape;
 * 3) COMPACTION event persisted in the JSONL log.
 *
 * We bypass the full agent loop because the unit test already covers the
 * trigger logic; this is the end-to-end integration that also verifies
 * event persistence.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents } from "../core/persistence/event-log.ts";
import { makePrepareNextTurn } from "../guardrails/compaction.ts";
import { UsageTracker } from "../guardrails/usage-tracker.ts";
import type { UserMessage } from "@earendil-works/pi-ai";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "forge-compaction-smoke-"));
  process.env.FORGE_EVENTS_DIR = join(dir, "events");

  let ok = true;

  try {
    const sessionId = `s_compaction_${Date.now()}`;
    const usage = new UsageTracker();
    // Simulate having received a usage report with input > threshold.
    usage.hydrate({ lastContextTokens: 200_000 });

    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const prepare = makePrepareNextTurn({
      sessionId,
      usage,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      emitEvent: (type, payload) => {
        captured.push({ type, payload });
        return appendEvent(sessionId, type as Parameters<typeof appendEvent>[1], payload);
      },
    });

    // Construct a context with 10 user messages.
    const messages: UserMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `m${i}` }],
      timestamp: 0,
    }));
    const ctx = { context: { systemPrompt: "sys", messages } } as Parameters<typeof prepare>[0];

    const out = await prepare(ctx);

    // 1. Returns a context update with truncated messages.
    if (!out || !out.context) {
      console.log("  FAIL: prepareNextTurn returned undefined / no context");
      ok = false;
    } else {
      const kept = out.context.messages!;
      if (kept.length !== 3) {
        console.log(`  FAIL: expected 3 kept messages, got ${kept.length}`);
        ok = false;
      } else {
        console.log(`  truncated messages: 10 → ${kept.length} → OK`);
      }
    }

    // 2. Emitted exactly one COMPACTION event with the expected shape.
    const compactions = captured.filter((e) => e.type === "COMPACTION");
    if (compactions.length !== 1) {
      console.log(`  FAIL: expected 1 COMPACTION event, got ${compactions.length}`);
      ok = false;
    } else {
      const ev = compactions[0]!;
      const okShape =
        ev.payload.mode === "truncate" &&
        ev.payload.beforeCount === 10 &&
        ev.payload.afterCount === 3 &&
        ev.payload.droppedCount === 7 &&
        ev.payload.beforeTokens === 200_000 &&
        ev.payload.threshold === 120_000;
      console.log(`  COMPACTION event shape: ${okShape ? "OK" : "FAIL"}`);
      ok = ok && okShape;
    }

    // 3. Event is persisted in the JSONL log.
    const persisted = await readEvents(sessionId);
    const persistedCompaction = persisted.find((e) => e.type === "COMPACTION");
    if (!persistedCompaction) {
      console.log("  FAIL: COMPACTION event not persisted");
      ok = false;
    } else {
      console.log("  COMPACTION event persisted → OK");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nCOMPACTION SMOKE: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
