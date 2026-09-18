import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentContext,
  PrepareNextTurnContext,
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  makePrepareNextTurn,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_KEEP_RECENT_MESSAGES,
} from "./compaction.ts";
import { UsageTracker } from "./usage-tracker.ts";

function userMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as AgentMessage;
}

function makeCtx(messages: AgentMessage[], lastUsageTokens = 200_000): PrepareNextTurnContext {
  const ctx: AgentContext = { systemPrompt: "sys", messages };
  // Pi hands the hook the completed turn: the assistant message that just
  // finished (with usage) plus the turn's tool results. calculateContextTokens
  // prefers totalTokens, so this drives the hook's threshold decision.
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "working" }],
    stopReason: "stop",
    usage: { input: lastUsageTokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: lastUsageTokens, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    timestamp: 0,
  };
  // Construct the context the way Pi's agent-loop would. We only use a
  // minimal subset of fields.
  return { context: ctx, message } as unknown as PrepareNextTurnContext;
}

function capturedEvents(): Array<{ type: string; payload: Record<string, unknown> }> {
  const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return captured;
}

describe("makePrepareNextTurn (truncate-mode compaction)", () => {
  test("returns undefined when lastInputTokens is null (no usage yet)", async () => {
    const usage = new UsageTracker();
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "x",
      usage,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    // Zero-token usage falls back to the tracker (null) — nothing seen yet.
    const ctx = makeCtx([userMsg("a"), userMsg("b")], 0);
    const out = await prepare(ctx);
    assert.equal(out, undefined);
    assert.equal(events.length, 0);
  });

  test("returns undefined when lastInputTokens <= threshold", async () => {
    const usage = new UsageTracker();
    usage.hydrate({ lastContextTokens: 100_000 });
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "x",
      usage,
      thresholdTokens: 120_000,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    const ctx = makeCtx(Array.from({ length: 30 }, (_, i) => userMsg(`m${i}`)), 100_000);
    const out = await prepare(ctx);
    assert.equal(out, undefined);
    assert.equal(events.length, 0);
  });

  test("returns undefined when message count <= keepRecent (don't drop goal)", async () => {
    const usage = new UsageTracker();
    usage.hydrate({ lastContextTokens: 200_000 }); // above threshold
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "x",
      usage,
      thresholdTokens: 120_000,
      keepRecentMessages: 5,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    // Only 3 messages — would risk dropping the goal prompt if truncated.
    const ctx = makeCtx([userMsg("a"), userMsg("b"), userMsg("c")]);
    const out = await prepare(ctx);
    assert.equal(out, undefined);
    assert.equal(events.length, 0);
  });

  test("truncates to keepRecentMessages and emits COMPACTION event", async () => {
    const usage = new UsageTracker();
    usage.hydrate({ lastContextTokens: 200_000 }); // above threshold
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "s1",
      usage,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    });
    const original = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`));
    const ctx = makeCtx(original);
    const out = await prepare(ctx);

    assert.ok(out);
    assert.ok(out!.context);
    const newMessages = out!.context!.messages!;
    assert.equal(newMessages.length, 3);
    const texts = newMessages.map(
      (m) => ((m as unknown as { content: Array<{ text: string }> }).content[0]!.text),
    );
    assert.equal(texts.join(","), "m7,m8,m9");

    // systemPrompt preserved, tools preserved when defined.
    assert.equal(out!.context!.systemPrompt, "sys");

    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.type, "COMPACTION");
    assert.equal(ev.payload.mode, "truncate");
    assert.equal(ev.payload.beforeCount, 10);
    assert.equal(ev.payload.afterCount, 3);
    assert.equal(ev.payload.droppedCount, 7);
    assert.equal(ev.payload.beforeTokens, 200_000);
    assert.equal(ev.payload.threshold, 120_000);
  });

  test("/compact one-shot request bypasses the token threshold", async () => {
    const usage = new UsageTracker();
    let requested = true;
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "s1",
      usage,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      takeCompactionRequest: () => {
        const value = requested;
        requested = false;
        return value;
      },
      emitEvent: (type, payload) => { events.push({ type, payload }); return Promise.resolve(); },
    });
    const ctx = makeCtx(Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`)), 100);
    const out = await prepare(ctx);
    assert.equal(out?.context?.messages.length, 3);
    assert.equal(events[0]?.payload.forced, true);
    assert.equal(await prepare(ctx), undefined);
  });

  test("does not break the loop when emitEvent throws", async () => {
    const usage = new UsageTracker();
    usage.hydrate({ lastContextTokens: 200_000 });
    const prepare = makePrepareNextTurn({
      sessionId: "s1",
      usage,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      emitEvent: () => Promise.reject(new Error("disk full")),
    });
    const ctx = makeCtx(Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`)));
    // Must not throw — the .catch(() => {}) inside the hook swallows it.
    const out = await prepare(ctx);
    assert.ok(out);
    assert.equal(out!.context!.messages!.length, 3);
  });

  test("uses defaults when threshold/keepRecent not provided", () => {
    // Sanity: the named defaults are what we documented (120K, 20).
    assert.equal(DEFAULT_COMPACTION_THRESHOLD, 120_000);
    assert.equal(DEFAULT_KEEP_RECENT_MESSAGES, 20);
  });
});

describe("makePrepareNextTurn (llm-summary compaction)", () => {
  const BIG = "x".repeat(12_000); // ~3k estimated tokens per message

  function scriptedSummaryMessage(text: string): unknown {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "scripted",
      model: "scripted",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  test("llm-summary replaces history with summary + retained tail", async () => {
    const usage = new UsageTracker();
    usage.hydrate({ lastContextTokens: 200_000 }); // above threshold
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "s1",
      usage,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
      compact: {
        model: { id: "scripted" },
        completeSimple: async () => scriptedSummaryMessage("STRUCTURED SUMMARY CONTENT"),
      },
    });
    const original = Array.from({ length: 12 }, (_, i) => userMsg(`${BIG} m${i}`));
    const ctx = makeCtx(original);
    const out = await prepare(ctx);

    assert.ok(out);
    const newMessages = out!.context!.messages as unknown as Array<{
      role: string;
      content: Array<{ text: string }>;
    }>;
    // First message is the summary (user-role so defaultConvertToLlm keeps it).
    assert.equal(newMessages[0]!.role, "user");
    const summaryText = newMessages[0]!.content[0]!.text;
    assert.ok(summaryText.includes("STRUCTURED SUMMARY CONTENT"));
    assert.ok(summaryText.includes("<summary>"));
    // Retained tail carries real original messages.
    assert.ok(newMessages.length > 1 && newMessages.length < 12);
    assert.ok((events[0]!.payload.retainedTail as number) > 0);

    const ev = events[0]!;
    assert.equal(ev.type, "COMPACTION");
    assert.equal(ev.payload.mode, "llm-summary");
    assert.equal(ev.payload.beforeCount, 12);
    assert.ok((ev.payload.summaryChars as number) > 0);
    assert.equal(ev.payload.beforeTokens, 200_000);
  });

  test("falls back to truncate when the summary call fails", async () => {
    const usage = new UsageTracker();
    usage.hydrate({ lastContextTokens: 200_000 });
    const events = capturedEvents();
    const prepare = makePrepareNextTurn({
      sessionId: "s1",
      usage,
      thresholdTokens: 120_000,
      keepRecentMessages: 3,
      emitEvent: (type, payload) => {
        events.push({ type, payload });
        return Promise.resolve();
      },
      compact: {
        model: { id: "scripted" },
        completeSimple: async () => {
          throw new Error("provider down");
        },
      },
    });
    const ctx = makeCtx(Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`)));
    const out = await prepare(ctx);

    // Truncate fallback result.
    assert.ok(out);
    assert.equal(out!.context!.messages!.length, 3);
    const modes = events.map((e) => ({ type: e.type, mode: e.payload.mode }));
    assert.deepEqual(modes, [
      { type: "COMPACTION_FAILED", mode: "llm-summary" },
      { type: "COMPACTION", mode: "truncate" },
    ]);
  });
});

describe("makePrepareNextTurn (window-derived trigger)", () => {
  const recorder = () => {
    const events = capturedEvents();
    return { events, emitEvent: (type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return Promise.resolve();
    } };
  };
  const many = (n = 10) => Array.from({ length: n }, (_, i) => userMsg(`m${i}`));

  test("a narrow-window model compacts at window − reserve, far below the 120K cap", async () => {
    // The bug: the cap was applied blindly, so a 32K-window model (threshold
    // 16K) never compacted before its provider refused the request.
    const { events, emitEvent } = recorder();
    const prepare = makePrepareNextTurn({
      sessionId: "narrow",
      usage: new UsageTracker(),
      contextWindow: 32_000,
      keepRecentMessages: 3,
      emitEvent,
    });
    assert.equal(await prepare(makeCtx(many(), 12_000)), undefined, "below 32K − 16K");
    assert.equal(events.length, 0);
    assert.ok(await prepare(makeCtx(many(), 20_000)), "above 32K − 16K → compact");
    assert.equal(events.filter((e) => e.type === "COMPACTION").length, 1);
  });

  test("a wide-window model keeps the conservative cap (summarizer headroom)", async () => {
    // 200K − 16K = 183.6K, so the 120K cap still binds: behavior unchanged for
    // the models Forge was tuned on.
    const { events, emitEvent } = recorder();
    const prepare = makePrepareNextTurn({
      sessionId: "wide",
      usage: new UsageTracker(),
      contextWindow: 200_000,
      keepRecentMessages: 3,
      emitEvent,
    });
    assert.equal(await prepare(makeCtx(many(), 110_000)), undefined);
    assert.ok(await prepare(makeCtx(many(), 130_000)));
    assert.equal(events.filter((e) => e.type === "COMPACTION").length, 1);
  });

  test("the window clamps an explicitly configured cap", async () => {
    const { emitEvent } = recorder();
    const prepare = makePrepareNextTurn({
      sessionId: "clamped",
      usage: new UsageTracker(),
      thresholdTokens: 500_000,
      contextWindow: 32_000,
      keepRecentMessages: 3,
      emitEvent,
    });
    assert.ok(await prepare(makeCtx(many(), 20_000)), "a cap wider than the window cannot win");
  });

  test("a configured cap below the window-derived limit still wins", async () => {
    const { emitEvent } = recorder();
    const prepare = makePrepareNextTurn({
      sessionId: "eager",
      usage: new UsageTracker(),
      thresholdTokens: 10_000,
      contextWindow: 200_000,
      keepRecentMessages: 3,
      emitEvent,
    });
    assert.ok(await prepare(makeCtx(many(), 12_000)), "the smaller of the two applies");
  });

  test("an 8K window does not let the reserve swallow the trigger", async () => {
    // 8K − 16K would be negative; the 25% floor puts the limit at 2K instead.
    const { emitEvent } = recorder();
    const prepare = makePrepareNextTurn({
      sessionId: "tiny",
      usage: new UsageTracker(),
      contextWindow: 8_000,
      keepRecentMessages: 3,
      emitEvent,
    });
    assert.equal(await prepare(makeCtx(many(), 1_500)), undefined);
    assert.ok(await prepare(makeCtx(many(), 2_500)));
  });

  test("an unknown window falls back to the cap", async () => {
    const { emitEvent } = recorder();
    const prepare = makePrepareNextTurn({
      sessionId: "unknown",
      usage: new UsageTracker(),
      keepRecentMessages: 3,
      emitEvent,
    });
    assert.equal(await prepare(makeCtx(many(), 110_000)), undefined);
    assert.ok(await prepare(makeCtx(many(), 130_000)));
  });
});
