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
