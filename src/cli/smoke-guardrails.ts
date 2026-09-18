/**
 * Phase 2 smoke test: guardrails in the loop.
 *
 * Scripted LLM asks to run `curl` (network → Guard `ask`). The approval
 * relay simulates a user denial, so the tool must NOT execute: the loop
 * emits an error tool result ("rejected by user") and proceeds to the final
 * answer. Exercises beforeToolCall hook + approval relay + error tool result
 * propagation, all deterministic.
 */
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import {
  agentLoop as agentLoopCore,
  type AgentEvent,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { mapAgentEventToPersisted } from "../events/mapper.ts";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../core/persistence/event-log.ts";
import { UsageTracker } from "../guardrails/usage-tracker.ts";
import { makeBeforeToolCall } from "../guardrails/before-tool-call.ts";
import { makeAfterToolCall } from "../guardrails/after-tool-call.ts";
import type { GuardrailConfig } from "../guardrails/types.ts";
import type { Session } from "../types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
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

const fakeModel = {
  id: "scripted",
  provider: "scripted",
  api: "openai-responses",
  name: "Scripted Mock",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 2048,
} as unknown as Model<any>;

function scriptedAssistantMessage(
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
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "forge-guard-smoke-"));
  const sessionId = `session_guard_${Date.now()}`;
  process.env.FORGE_EVENTS_DIR = join(workspace, ".forge-events");

  const session: Session = {
    id: sessionId,
    goal: "run a network request",
    workspace,
    projectId: null,
    model: { provider: "scripted", modelId: "scripted" },
    messages: [],
    status: "running",
    failureReason: null,
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
    approvalMode: "default",
    thinkingLevel: "off",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  let approvalsAsked = 0;
  const guardrails: GuardrailConfig = {
    sessionId,
    workspace,
    undoRoot: join(workspace, ".forge-undo"),
    session,
    // Simulated user: denies every approval.
    approval: {
      request: async () => {
        approvalsAsked++;
        return false;
      },
    },
    steeringQueue: [],
    usage: new UsageTracker(),
  };

  let callIndex = 0;
  const streamFn = () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      if (callIndex === 0) {
        const message = scriptedAssistantMessage(
          [
            {
              type: "toolCall",
              id: "call-1",
              name: "bash",
              arguments: { command: "curl https://example.com" },
            },
          ],
          "toolUse",
        );
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        const message = scriptedAssistantMessage([{ type: "text", text: "okay, stopped." }]);
        stream.push({ type: "done", reason: "stop", message });
      }
      callIndex++;
    });
    return stream;
  };

  const prompts: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: session.goal }], timestamp: Date.now() },
  ];
  const context = {
    systemPrompt: "test",
    messages: [],
    tools: createCodingTools(workspace),
  };
  const config = {
    model: fakeModel,
    convertToLlm: (messages: AgentMessage[]) => messages,
    beforeToolCall: makeBeforeToolCall(guardrails),
    afterToolCall: makeAfterToolCall(guardrails),
  };

  let sawErrorToolResult = false;
  let blockedReasonSeen = false;
  const stream = agentLoopCore(
    prompts,
    context as never,
    config as never,
    undefined,
    streamFn,
  );
  for await (const event of stream as unknown as AsyncIterable<AgentEvent>) {
    const mapped = mapAgentEventToPersisted(event);
    if (mapped) await appendEvent(sessionId, mapped.type, mapped.payload);
    if (event.type === "tool_execution_end") {
      console.log(
        `  [event] tool_execution_end isError=${event.isError} result=${JSON.stringify(event.result).slice(0, 140)}`,
      );
      if (event.isError) {
        sawErrorToolResult = true;
        if (JSON.stringify(event.result).includes("rejected by user")) blockedReasonSeen = true;
      }
    }
  }

  console.log(`  approvals asked: ${approvalsAsked} (expected 1 — user denied)`);
  const ok = approvalsAsked === 1 && sawErrorToolResult && blockedReasonSeen;
  console.log(`\nGUARD SMOKE: ${ok ? "PASS" : "FAIL"}`);
  rmSync(workspace, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
