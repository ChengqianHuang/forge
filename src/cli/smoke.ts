/**
 * Phase 1 smoke test for the new architecture skeleton.
 *
 * Runs Pi's agentLoop in-process against a scripted (mock) LLM stream:
 * turn 1 returns a `write` tool call, turn 2 returns a final answer. This
 * exercises the full skeleton — loop, real tools, event consumption, FIFO
 * event log, session persistence — with the only mock being the LLM itself.
 *
 * A real-model run needs configured credentials (Phase 2 wires model
 * resolution into the session manager).
 */
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import {
  agentLoop,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../core/persistence/event-log.ts";
import { saveSession } from "../core/persistence/session-store.ts";
import { mapAgentEventToPersisted } from "../events/mapper.ts";
import type { Session } from "../types.ts";

// --- scripted LLM mock -------------------------------------------------

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
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

function makeScriptedStreamFn(workspace: string): StreamFn {
  let callIndex = 0;
  return () => {
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      if (callIndex === 0) {
        // Turn 1: ask the real write tool to create the file.
        const message = scriptedAssistantMessage(
          [
            {
              type: "toolCall",
              id: "call-1",
              name: "write",
              arguments: { path: join(workspace, "hello.txt"), content: "hello world\n" },
            },
          ],
          "toolUse",
        );
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        const message = scriptedAssistantMessage([
          { type: "text", text: "hello.txt created." },
        ]);
        stream.push({ type: "done", reason: "stop", message });
      }
      callIndex++;
    });
    return stream;
  };
}

// --- smoke -------------------------------------------------------------

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "forge-smoke-"));
  const sessionId = `session_smoke_${Date.now()}`;

  process.env.FORGE_EVENTS_DIR = join(workspace, ".forge-events");
  process.env.FORGE_SESSIONS_DIR = join(workspace, ".forge-sessions");

  const session: Session = {
    id: sessionId,
    goal: "create hello.txt with content 'hello world'",
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
  await saveSession(session);

  const streamFn = makeScriptedStreamFn(workspace);
  const prompts: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: session.goal }], timestamp: Date.now() },
  ];

  const context = {
    systemPrompt: `You are Forge's engineering agent. Working directory: ${workspace}`,
    messages: [],
    tools: createCodingTools(workspace),
  };
  const config = {
    model: fakeModel,
    convertToLlm: (messages: AgentMessage[]) => messages,
  };

  let events = 0;
  const stream = agentLoop(prompts, context as never, config as never, undefined, streamFn);
  for await (const event of stream as unknown as AsyncIterable<AgentEvent>) {
    events++;
    const mapped = mapAgentEventToPersisted(event);
    if (mapped) await appendEvent(sessionId, mapped.type, mapped.payload);
    if (event.type === "message_end") {
      const text = (event.message as { content?: unknown }).content;
      console.log(`  [event] message_end: ${JSON.stringify(text).slice(0, 120)}`);
    } else if (event.type === "tool_execution_end") {
      console.log(`  [event] tool_execution_end: isError=${event.isError}`);
    }
  }
  const finalMessages = await (stream as unknown as { result: () => Promise<AgentMessage[]> }).result();

  // Verify: file really created by the real write tool.
  const helloPath = join(workspace, "hello.txt");
  const created = existsSync(helloPath);
  const content = created ? readFileSync(helloPath, "utf8").trim() : "";
  console.log(`  file: ${helloPath} exists=${created} content="${content}"`);
  console.log(`  events persisted: ${events}`);
  console.log(`  final messages: ${finalMessages.length}`);

  session.messages = finalMessages;
  session.status = "completed";
  session.updatedAt = Date.now();
  await saveSession(session);

  const ok = created && content === "hello world" && events > 0;
  console.log(`\nSMOKE: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
