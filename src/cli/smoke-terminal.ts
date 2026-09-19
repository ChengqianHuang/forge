import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startForgeServer } from "../server/http-server.ts";
import { saveForgeConfig } from "../server/config-store.ts";

/**
 * User-terminal smoke (the dock 终端 tab): create a pty shell in a session
 * workspace, write into it, and read the echo off the SSE stream. Exercises
 * node-pty's native build plus the terminal HTTP surface end to end — this
 * is what catches a broken native compile on a fresh platform.
 */

const forgeHome = mkdtempSync(join(tmpdir(), "forge-terminal-smoke-"));
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_SESSIONS_DIR = join(forgeHome, "sessions");
process.env.FORGE_EVENTS_DIR = join(forgeHome, "events");
await saveForgeConfig(forgeHome, {
  version: 2,
  providers: [{ id: "fake", api: "openai-responses", apiKey: "test", modelId: "fake-model", baseUrl: "http://127.0.0.1:9/v1" }],
  defaultProviderId: "fake",
  mcpServers: [],
});

const handle = await startForgeServer({ port: 0, forgeHome });
const auth = { authorization: `Bearer ${handle.token}` };
const post = async (path: string, body?: unknown) => {
  const r = await fetch(`${handle.url}${path}`, {
    method: "POST",
    headers: body !== undefined ? { ...auth, "content-type": "application/json" } : auth,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
};

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${name}${detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 240) : ""}`);
  }
};

const created = await post("/sessions", { goal: "terminal smoke" });
check("session created", created.status === 202 && typeof created.body?.sessionId === "string", created);
const sessionId = created.body!.sessionId as string;

const term = await post(`/sessions/${sessionId}/terminal`, { cols: 80, rows: 24 });
check("terminal created", term.status === 200 && typeof term.body?.id === "string", term);
const termId = term.body!.id as string;

const chunks: string[] = [];
const controller = new AbortController();
const streamDone = (async () => {
  const r = await fetch(`${handle.url}/sessions/${sessionId}/terminal/${termId}/stream`, {
    headers: auth, signal: controller.signal,
  });
  check("stream is SSE", r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/event-stream"));
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
})();
await new Promise((resolve) => setTimeout(resolve, 500));
await post(`/sessions/${sessionId}/terminal/${termId}/input`, { data: "echo FORGE_SMOKE_$((7*6))\r" });
await new Promise((resolve) => setTimeout(resolve, 1500));
controller.abort();
await streamDone.catch(() => {});
check("echo observed on the stream", chunks.join("").includes("FORGE_SMOKE_42"), chunks.join("").slice(-200));

const exited = await post(`/sessions/${sessionId}/terminal/${termId}/exit`);
check("terminal exited", exited.status === 200, exited);

await handle.close();
if (failed > 0) {
  console.error(`terminal smoke: ${failed} failures`);
  process.exit(1);
}
console.log("terminal smoke: ok");
