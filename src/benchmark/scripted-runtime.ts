/**
 * Phase 6 benchmark: deterministic scripted runtime.
 *
 * A StreamFn factory that plays a fixed script of AssistantMessages — the
 * only non-deterministic part of the agent loop (the LLM) replaced by a
 * replayable script. Everything else runs for real: Pi's agentLoop, the
 * coding tools against a real (temp) workspace, and the full guardrail
 * hook set.
 *
 * Modeled on the scripted-stream pattern used by the agent-loop smoke tests.
 */
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

class ScriptedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      },
    );
  }
}

/** Deterministic fake model — zero cost, tiny window; never hits the network. */
export const fakeModel = {
  id: "scripted",
  provider: "scripted",
  api: "openai-responses",
  name: "Scripted Mock",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
} as unknown as Model<any>;

export function scriptedAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "scripted",
    model: "scripted",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { total: 0.0001, input: 0.00008, output: 0.00002, cacheRead: 0, cacheWrite: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall" as const, id, name, arguments: args };
}

export function text(t: string) {
  return { type: "text" as const, text: t };
}

export type Script = AssistantMessage[];

export interface ScriptedRuntime {
  streamFn: StreamFn;
  /** Number of script entries actually consumed (overrun detection). */
  consumed(): number;
  /** True when the loop asked for more turns than the script provided. */
  overran(): boolean;
}

/**
 * Plays `script` in order, one AssistantMessage per agentLoop turn. When the
 * script is exhausted the runtime keeps replaying a final bare "done" — and
 * flags `overran()` so assertions can catch scripts that are too short.
 */
export function makeScriptedRuntime(script: Script): ScriptedRuntime {
  let index = 0;
  const streamFn: StreamFn = () => {
    const stream = new ScriptedStream();
    queueMicrotask(() => {
      const message = script[index] ?? scriptedAssistantMessage([{ type: "text", text: "done" }]);
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse" | "length" | "deferred",
        message,
      });
      index++;
    });
    return stream;
  };
  return {
    streamFn,
    consumed: () => index,
    overran: () => index > script.length,
  };
}
