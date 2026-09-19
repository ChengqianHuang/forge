/** HTTP client for the session-centric Forge server. cfg comes from the
 * Tauri handshake (window.__FORGE_CONFIG__) or dev-mode localStorage. */

import type {
  ApprovalRecordView,
  ForgeConfigData,
  ProjectRecord,
  ProviderApi,
  Session,
  ThinkingLevel,
  PluginCapabilitySnapshot,
  PluginCatalogEntryView,
  PluginSourceInfoView,
} from "../types.ts";

export type DesktopConfig = { baseUrl: string; token: string };

let cfg: DesktopConfig | null = null;
export function initClient(c: DesktopConfig): void {
  cfg = c;
}
export function getCfg(): DesktopConfig {
  if (!cfg) {
    cfg = (window.__FORGE_CONFIG__ ?? {
      baseUrl: "http://127.0.0.1:5300",
      token: localStorage.getItem("forge-token") ?? "",
    }) as DesktopConfig;
  }
  return cfg;
}
function headers(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${getCfg().token}`, ...extra };
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${getCfg().baseUrl}${path}`, { headers: headers() });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(`${getCfg().baseUrl}${path}`, {
    method,
    headers: body !== undefined ? headers({ "content-type": "application/json" }) : headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json() as Promise<T>;
}

// --- sessions ---

export async function createSession(input: {
  goal: string;
  projectId?: string;
  providerId?: string;
  thinkingLevel?: ThinkingLevel;
}): Promise<{ sessionId: string }> {
  return send("/sessions", "POST", input);
}

export async function switchApprovalMode(
  sessionId: string,
  approvalMode: "ask" | "default" | "always",
): Promise<{ approvalMode: "ask" | "default" | "always" }> {
  return send(`/sessions/${sessionId}/approval`, "POST", { approvalMode });
}

export async function fetchSessions(): Promise<Session[]> {
  return (await getJson<{ sessions: Session[] }>("/sessions")).sessions;
}

export async function steerSession(id: string, message: string): Promise<void> {
  await send(`/sessions/${id}/steer`, "POST", { message });
}

export async function executeSlashCommand(id: string, command: string): Promise<void> {
  await send(`/sessions/${id}/commands`, "POST", { command });
}

export async function fetchPluginCapabilities(id: string): Promise<PluginCapabilitySnapshot> {
  return getJson(`/sessions/${id}/capabilities`);
}

export async function readCapability<T>(
  sessionId: string,
  pluginId: string,
  actionId: string,
  input: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams(input);
  return getJson(
    `/sessions/${sessionId}/capabilities/${encodeURIComponent(pluginId)}/read/${encodeURIComponent(actionId)}?${query}`,
  );
}

export async function setSessionPluginEnabled(id: string, pluginId: string, enabled: boolean): Promise<void> {
  await send(`/sessions/${id}/plugins/${encodeURIComponent(pluginId)}`, "POST", { enabled });
}

// --- user terminals (dock 终端 tab) ---

export async function createTerminal(sessionId: string, cols: number, rows: number): Promise<{ id: string }> {
  return send(`/sessions/${sessionId}/terminal`, "POST", { cols, rows });
}

export async function terminalInput(sessionId: string, termId: string, data: string): Promise<void> {
  await send(`/sessions/${sessionId}/terminal/${termId}/input`, "POST", { data });
}

export async function terminalResize(sessionId: string, termId: string, cols: number, rows: number): Promise<void> {
  await send(`/sessions/${sessionId}/terminal/${termId}/resize`, "POST", { cols, rows });
}

export async function terminalExit(sessionId: string, termId: string): Promise<void> {
  await send(`/sessions/${sessionId}/terminal/${termId}/exit`, "POST");
}

/** Follow a terminal's output as SSE. Returns a cancel function; the server
 * keeps the pty alive across reconnects — the termId is the handle. */
export function streamTerminal(
  sessionId: string,
  termId: string,
  onFrame: (frame: { type: "data" | "exit"; payload: string }) => void,
  onEnded: () => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const r = await fetch(`${getCfg().baseUrl}/sessions/${sessionId}/terminal/${encodeURIComponent(termId)}/stream`, {
        headers: headers(),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) throw new Error(`terminal stream → ${r.status}`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            onFrame(JSON.parse(line.slice(6)));
          } catch {
            // A malformed frame is dropped, never fatal to the stream.
          }
        }
      }
    } catch {
      // Aborted (component unmounted) or network failure — both end the loop.
    } finally {
      onEnded();
    }
  })();
  return () => controller.abort();
}

// --- plugin manager (global) ---

export async function fetchPlugins(): Promise<{
  plugins: PluginCatalogEntryView[];
  errors: Array<{ source: string; reason: string }>;
}> {
  return getJson("/plugins");
}

export async function setGlobalPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await send(`/plugins/${encodeURIComponent(pluginId)}/enabled`, "POST", { enabled });
}

/** Inspect an install source (local path or git URL) without installing. */
export async function inspectPluginSource(source: string): Promise<{
  plugins: PluginSourceInfoView[];
  errors: Array<{ source: string; reason: string }>;
}> {
  return send("/plugins/inspect", "POST", { source });
}

/** Install: copies plugin files into forge home and registers them live. */
export async function installPlugin(source: string): Promise<{
  plugins: PluginSourceInfoView[];
  errors: Array<{ source: string; reason: string }>;
}> {
  return send("/plugins/install", "POST", { source });
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  await send(`/plugins/${encodeURIComponent(pluginId)}/uninstall`, "POST");
}

/** Returns the resolved config (defaults merged) so the UI shows what will apply. */
export async function savePluginConfig(
  pluginId: string,
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await send<{ config: Record<string, unknown> }>(
    `/plugins/${encodeURIComponent(pluginId)}/config`,
    "PUT",
    { config },
  );
  return result.config;
}

export async function abortSession(id: string): Promise<void> {
  await send(`/sessions/${id}/abort`, "POST");
}

export async function resumeSession(id: string, message?: string): Promise<void> {
  await send(`/sessions/${id}/resume`, "POST", message ? { message } : {});
}

export async function switchModel(id: string, providerId: string): Promise<{ modelId: string }> {
  return send(`/sessions/${id}/model`, "POST", { providerId });
}

/** Reasoning effort (Pi's thinking level). Running sessions pick it up at the
 * next turn boundary; idle ones persist it for the next resume. */
export async function switchThinking(
  id: string,
  thinkingLevel: ThinkingLevel,
): Promise<{ thinkingLevel: string }> {
  return send(`/sessions/${id}/thinking`, "POST", { thinkingLevel });
}

export async function deleteSession(id: string): Promise<void> {
  await send(`/sessions/${id}`, "DELETE");
}

// --- approvals ---

export async function fetchApprovals(sessionId: string): Promise<ApprovalRecordView[]> {
  const raw = await getJson<{
    approvals: Array<{ requestId: string; title: string; message: string; at: number }>;
  }>(`/sessions/${sessionId}/approvals`);
  return raw.approvals.map((a) => ({
    requestId: a.requestId,
    toolName: a.title.replace(/^Allow\s+|\?$/g, ""),
    message: a.message,
    at: a.at,
  }));
}

export async function resolveApproval(
  sessionId: string,
  requestId: string,
  decision: "approve" | "deny",
): Promise<void> {
  await send(`/sessions/${sessionId}/approvals/${requestId}/${decision}`, "POST");
}

// --- config (model subscriptions) ---

export async function fetchConfig(): Promise<ForgeConfigData> {
  return getJson("/config");
}

export async function saveConfig(config: ForgeConfigData): Promise<ForgeConfigData> {
  return send("/config", "PUT", config);
}

/**
 * Ask a subscription's endpoint which models it serves. The endpoint triple
 * is posted as-is (works for unsaved edits); the key is used server-side for
 * the upstream call only and never persisted or echoed back.
 */
export async function discoverModels(input: {
  api: ProviderApi;
  baseUrl: string;
  apiKey: string;
}): Promise<{ models: string[] }> {
  return send("/providers/models", "POST", input);
}

// --- projects ---

export async function fetchProjects(): Promise<{
  projects: ProjectRecord[];
  activeProjectId: string | null;
}> {
  return getJson("/projects");
}

export async function addProject(path: string, name?: string): Promise<ProjectRecord> {
  return send("/projects", "POST", { path, name });
}

export async function selectProject(id: string): Promise<ProjectRecord> {
  return send("/projects/select", "POST", { id });
}
