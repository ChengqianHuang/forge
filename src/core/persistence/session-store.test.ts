import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Session } from "../../types.ts";
import { appendEvent, readEvents } from "./event-log.ts";
import { loadSession, saveSession } from "./session-store.ts";

function message(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as AgentMessage;
}

function textOf(value: AgentMessage): string {
  const content = (value as { content?: Array<{ type?: string; text?: string }> }).content;
  const block = content?.[0] as { text?: string } | undefined;
  return block?.text ?? "";
}

function session(id: string, messages: AgentMessage[]): Session {
  return {
    id,
    goal: "goal",
    workspace: "/tmp",
    projectId: null,
    model: { provider: "test", modelId: "test" },
    messages,
    status: "completed",
    failureReason: null,
    usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
    approvalMode: "default",
    thinkingLevel: "off",
    createdAt: 1,
    updatedAt: 1,
  };
}

async function dirs(): Promise<{ sessions: string; events: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-session-store-"));
  const sessions = join(root, "sessions");
  const events = join(root, "events");
  process.env.FORGE_SESSIONS_DIR = sessions;
  process.env.FORGE_EVENTS_DIR = events;
  await mkdir(sessions, { recursive: true });
  return { sessions, events };
}

describe("session metadata and event-owned history", () => {
  test("omits runtime messages from session JSON and hydrates them from events", async () => {
    const paths = await dirs();
    const id = `event-owned-${Date.now()}`;
    await appendEvent(id, "MESSAGE_ENDED", { message: message("event history") });
    await saveSession(session(id, [message("stale snapshot")]));

    const raw = JSON.parse(await readFile(join(paths.sessions, `${id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal("messages" in raw, false);
    const loaded = await loadSession(id);
    assert.deepEqual(loaded?.messages.map(textOf), ["event history"]);
  });

  test("imports legacy snapshot history exactly once before dropping the field", async () => {
    const paths = await dirs();
    const id = `legacy-history-${Date.now()}`;
    const legacy = session(id, [message("legacy one"), message("legacy two")]);
    await writeFile(
      join(paths.sessions, `${id}.json`),
      JSON.stringify({ ...legacy, schemaVersion: 8 }),
      "utf8",
    );

    const [first, second] = await Promise.all([loadSession(id), loadSession(id)]);
    assert.deepEqual(first?.messages.map(textOf), ["legacy one", "legacy two"]);
    assert.deepEqual(second?.messages.map(textOf), ["legacy one", "legacy two"]);
    const events = await readEvents(id);
    assert.equal(events.filter((event) => event.type === "SESSION_HISTORY_IMPORTED").length, 1);
    assert.equal(events.filter((event) => event.type === "MESSAGE_ENDED").length, 0);
    assert.deepEqual(
      events.find((event) => event.type === "SESSION_HISTORY_IMPORTED")?.payload.contextMessages,
      legacy.messages,
    );

    await saveSession(first!);
    const raw = JSON.parse(await readFile(join(paths.sessions, `${id}.json`), "utf8")) as Record<string, unknown>;
    assert.equal("messages" in raw, false);
    assert.deepEqual((await loadSession(id))?.messages.map(textOf), ["legacy one", "legacy two"]);
  });
});
