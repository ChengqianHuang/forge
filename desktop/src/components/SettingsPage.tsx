import { useEffect, useState } from "react";
import { discoverModels, fetchConfig, saveConfig } from "../lib/api.ts";
import { PROVIDER_PROTOCOLS } from "../lib/protocols.ts";
import type { ForgeConfigData, ProviderApi } from "../types.ts";

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<ForgeConfigData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Model discovery: fetched list per provider (unsaved edits work — the
  // endpoint triple is posted as-is), plus which fetch is in flight.
  const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<Record<string, string>>({});

  useEffect(() => {
    void fetchConfig().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  const update = (patch: Partial<ForgeConfigData>) => {
    if (!config) return;
    setConfig({ ...config, ...patch });
  };

  const updateProvider = (id: string, patch: Partial<ForgeConfigData["providers"][number]>) => {
    if (!config) return;
    setConfig({
      ...config,
      providers: config.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  const updateMcp = (id: string, patch: Partial<NonNullable<ForgeConfigData["mcpServers"]>[number]>) => {
    if (!config) return;
    setConfig({
      ...config,
      mcpServers: (config.mcpServers ?? []).map((server) => server.id === id ? { ...server, ...patch } : server),
    });
  };

  const discover = async (p: ForgeConfigData["providers"][number]) => {
    setDiscovering(p.id);
    setDiscoverError((m) => ({ ...m, [p.id]: "" }));
    try {
      const { models } = await discoverModels({ api: p.api, baseUrl: p.baseUrl, apiKey: p.apiKey });
      setFetchedModels((m) => ({ ...m, [p.id]: models }));
      if (models.length === 0) {
        setDiscoverError((m) => ({ ...m, [p.id]: "Endpoint answered with an empty model list." }));
      }
    } catch (e) {
      setDiscoverError((m) => ({ ...m, [p.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDiscovering(null);
    }
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveConfig(config);
      setConfig(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal modal-lg">
        <div className="modal-head">
          <div>
            <h3 className="modal-title">Model subscriptions</h3>
            <div className="modal-sub">
              Every subscription Forge can run. The selected one is the default for new sessions;
              an active session can switch at its next turn boundary.
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="modal-scroll">
          {!config && <div className="modal-sub">Loading…</div>}

          {config?.providers.length === 0 && (
            <div className="modal-sub">No subscriptions yet — add one to start running tasks.</div>
          )}

          {config?.providers.map((p) => (
            <div key={p.id} className="card">
              <div className="prov-head">
                <input
                  className="radio"
                  type="radio"
                  name="default-provider"
                  checked={config.defaultProviderId === p.id}
                  onChange={() => update({ defaultProviderId: p.id })}
                  title="Use as the default subscription"
                />
                <span className="prov-id">{p.id}</span>
                {config.defaultProviderId === p.id && <span className="prov-default">default</span>}
                <div style={{ flex: 1 }} />
                <button
                  className="btn btn-danger btn-small"
                  onClick={() =>
                    update({
                      providers: config.providers.filter((x) => x.id !== p.id),
                      defaultProviderId:
                        config.defaultProviderId === p.id
                          ? (config.providers.find((x) => x.id !== p.id)?.id ?? "")
                          : config.defaultProviderId,
                    })
                  }
                >
                  Remove
                </button>
              </div>

              <div className="field-grid">
                <span className="field-label">protocol</span>
                <select
                  className="input"
                  value={p.api}
                  onChange={(e) => updateProvider(p.id, { api: e.target.value as ProviderApi })}
                >
                  {PROVIDER_PROTOCOLS.map((api) => (
                    <option key={api} value={api}>
                      {api}
                    </option>
                  ))}
                </select>

                <span className="field-label">model</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 0 }}
                    value={p.modelId}
                    placeholder="e.g. MiniMax-M2.7"
                    onChange={(e) => updateProvider(p.id, { modelId: e.target.value })}
                  />
                  <button
                    className="btn btn-quiet btn-small"
                    onClick={() => void discover(p)}
                    disabled={discovering !== null || !p.baseUrl.trim() || !p.apiKey.trim()}
                    title="Ask this endpoint which models it serves"
                  >
                    {discovering === p.id ? "…" : "Fetch models"}
                  </button>
                </div>
                {discoverError[p.id] && (
                  <>
                    <span className="field-label" />
                    <span className="modal-error">{discoverError[p.id]}</span>
                  </>
                )}
                {(fetchedModels[p.id]?.length ?? 0) > 0 && (
                  <>
                    <span className="field-label">fetched</span>
                    <select
                      className="input"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) updateProvider(p.id, { modelId: e.target.value });
                      }}
                    >
                      <option value="">
                        {fetchedModels[p.id]!.length} models served — pick one
                      </option>
                      {fetchedModels[p.id]!.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </>
                )}

                <span className="field-label">baseUrl</span>
                <input
                  className="input"
                  value={p.baseUrl}
                  onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                />

                <span className="field-label">apiKey</span>
                <input
                  className="input"
                  type="password"
                  value={p.apiKey}
                  onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                />
              </div>
            </div>
          ))}

          <button
            className="btn btn-ghost btn-small"
            onClick={() =>
              config &&
              update({
                providers: [
                  ...config.providers,
                  {
                    id: `prov_${Math.random().toString(36).slice(2, 7)}`,
                    api: "openai-completions",
                    modelId: "",
                    baseUrl: "https://api.openai.com/v1",
                    apiKey: "",
                  },
                ],
              })
            }
          >
            + Add subscription
          </button>

          <div className="settings-section-head">
            <h3 className="modal-title">MCP tool servers</h3>
            <div className="modal-sub">Enabled servers are discovered at Forge startup; their tools join the same guardrail path as built-in tools.</div>
          </div>
          {(config?.mcpServers ?? []).map((server) => (
            <div key={server.id} className="card">
              <div className="prov-head">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(e) => updateMcp(server.id, { enabled: e.target.checked })}
                />
                <span className="prov-id">{server.id}</span>
                <div style={{ flex: 1 }} />
                <button className="btn btn-danger btn-small" onClick={() => update({ mcpServers: (config?.mcpServers ?? []).filter((item) => item.id !== server.id) })}>Remove</button>
              </div>
              <div className="field-grid">
                <span className="field-label">command</span>
                <input className="input" value={server.command} onChange={(e) => updateMcp(server.id, { command: e.target.value })} />
                <span className="field-label">arguments</span>
                <input className="input" value={server.args.join(" ")} onChange={(e) => updateMcp(server.id, { args: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="space-separated" />
                <span className="field-label">cwd</span>
                <input className="input" value={server.cwd ?? ""} onChange={(e) => updateMcp(server.id, { cwd: e.target.value || undefined })} />
              </div>
            </div>
          ))}
          <button
            className="btn btn-ghost btn-small"
            onClick={() => config && update({
              mcpServers: [...(config.mcpServers ?? []), {
                id: `server_${Math.random().toString(36).slice(2, 7)}`,
                command: "",
                args: [],
                enabled: true,
              }],
            })}
          >
            + Add MCP server
          </button>
        </div>

        <div className="modal-foot">
          <span className="modal-error">{error}</span>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !config}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
