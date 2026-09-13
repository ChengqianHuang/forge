import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Session } from "../../types.ts";
import { readJsonFile, writeJsonFileAtomic } from "./json.ts";
import { stampSchemaVersion, migrateSession } from "./schema.ts";
import { appendEvent } from "./event-log.ts";
import { replaySession } from "./replay.ts";

/** Resolved per call, not at module load — test/smoke harnesses set
 * FORGE_SESSIONS_DIR *after* this module is imported, and an eager const
 * would silently freeze the real ~/.forge path (dumping fixtures into the
 * developer's home). Mirrors event-log.ts's eventsDir(). */
export function sessionsDir(): string {
  return resolve(
    process.env.FORGE_SESSIONS_DIR ??
      join(process.env.HOME ?? "/tmp", ".forge", "sessions"),
  );
}

export async function saveSession(session: Session): Promise<void> {
  // Message history belongs to events.jsonl. The in-memory field exists only
  // because Pi needs an AgentMessage[] while a run is active.
  const { messages: _runtimeMessages, ...metadata } = session;
  await writeJsonFileAtomic(
    join(sessionsDir(), `${session.id}.json`),
    stampSchemaVersion(metadata as unknown as Record<string, unknown>),
  );
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const raw = await readJsonFile<Record<string, unknown>>(
      join(sessionsDir(), `${id}.json`),
    );
    return materializeSession(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(): Promise<Session[]> {
  try {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir);
    const out: Session[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readJsonFile<Record<string, unknown>>(join(dir, entry));
        out.push(await materializeSession(raw));
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

const messageHydrations = new Map<string, Promise<AgentMessage[]>>();

/** Build the runtime Session from metadata plus the authoritative event fold. */
async function materializeSession(raw: Record<string, unknown>): Promise<Session> {
  const migrated = migrateSession(raw) as unknown as Session;
  migrated.messages = await hydrateMessages(
    migrated.id,
    Array.isArray(raw.messages) ? raw.messages as AgentMessage[] : [],
  );
  return migrated;
}

/**
 * Import pre-event-history Session snapshots once, then always project from
 * JSONL. The in-flight map prevents concurrent list/get calls from importing
 * the same legacy messages twice.
 */
function hydrateMessages(sessionId: string, legacy: AgentMessage[]): Promise<AgentMessage[]> {
  const existing = messageHydrations.get(sessionId);
  if (existing) return existing;
  const hydration = (async () => {
    const replayed = await replaySession(sessionId);
    if (replayed.hasMessageEvents || legacy.length === 0) return replayed.messages;

    // One complete JSONL record is the migration commit. Importing messages
    // one by one leaves a crash window where a partial prefix looks complete
    // on the next load and silently discards the rest of the legacy history.
    await appendEvent(sessionId, "SESSION_HISTORY_IMPORTED", {
      source: "legacy-session-json",
      messageCount: legacy.length,
      contextMessages: legacy,
    });
    return [...legacy];
  })();
  messageHydrations.set(sessionId, hydration);
  void hydration.finally(() => {
    if (messageHydrations.get(sessionId) === hydration) messageHydrations.delete(sessionId);
  }).catch(() => {});
  return hydration;
}

export async function deleteSession(id: string): Promise<void> {
  await rm(join(sessionsDir(), `${id}.json`), { force: true });
}
