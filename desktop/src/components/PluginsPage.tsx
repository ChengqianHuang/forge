import { useEffect, useMemo, useState } from "react";
import {
  fetchPlugins,
  installPlugin,
  inspectPluginSource,
  savePluginConfig,
  setGlobalPluginEnabled,
  uninstallPlugin,
} from "../lib/api.ts";
import type { PluginCatalogEntryView, PluginConfigFieldView, PluginSourceInfoView } from "../types.ts";

/** The global plugin manager page (DSH-form): one place to see every
 * registered plugin, toggle optional ones, and edit their declared config.
 * Enablement and config are global preferences — a running session applies
 * them the next time its plugins activate. */

const CAPABILITY_LABELS: Record<string, string> = {
  "tool": "工具",
  "slash-command": "命令",
  "guardrail": "护栏",
  "event-subscriber": "事件",
  "ui": "界面",
  "read-action": "检查",
};

export function PluginsPage({ defaultWizardOpen = false }: { defaultWizardOpen?: boolean } = {}) {
  const [wizardOpen, setWizardOpen] = useState(defaultWizardOpen);
  const [plugins, setPlugins] = useState<PluginCatalogEntryView[] | null>(null);
  const [externalErrors, setExternalErrors] = useState<Array<{ source: string; reason: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setIdBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const catalog = await fetchPlugins();
      setPlugins(catalog.plugins);
      setExternalErrors(catalog.errors);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!plugins) return null;
    const visible = q
      ? plugins.filter((p) =>
          p.name.toLowerCase().includes(q)
          || p.id.toLowerCase().includes(q)
          || (p.description ?? "").toLowerCase().includes(q))
      : plugins;
    return {
      required: visible.filter((p) => p.required),
      optional: visible.filter((p) => !p.required && p.source !== "external"),
      external: visible.filter((p) => p.source === "external"),
    };
  }, [plugins, q]);

  async function toggle(plugin: PluginCatalogEntryView) {
    if (busyId) return;
    setIdBusy(plugin.id);
    setActionError(null);
    const enabled = plugin.userDisabled;
    // Optimistic flip; rollback on failure so the switch never lies.
    setPlugins((current) => current ? current.map((p) => p.id === plugin.id ? { ...p, userDisabled: !enabled } : p) : current);
    try {
      await setGlobalPluginEnabled(plugin.id, enabled);
    } catch (err) {
      setPlugins((current) => current ? current.map((p) => p.id === plugin.id ? { ...p, userDisabled: enabled } : p) : current);
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIdBusy(null);
    }
  }

  async function saveConfig(pluginId: string, values: Record<string, unknown>) {
    const resolved = await savePluginConfig(pluginId, values);
    setPlugins((current) => current ? current.map((p) => p.id === pluginId ? { ...p, config: resolved } : p) : current);
  }

  async function uninstall(pluginId: string) {
    setActionError(null);
    try {
      await uninstallPlugin(pluginId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 28px 40px" }}>
        <div style={headRow}>
          <span style={title}>插件</span>
          <span style={count}>{plugins ? `${plugins.length} 项` : ""}</span>
          <span style={{ flex: 1 }} />
          <button style={addBtn} onClick={() => setWizardOpen(true)}>添加插件</button>
        </div>
        <p style={subtitle}>
          扩展 Forge 的能力面：工具、命令、护栏检视与界面贡献都由插件提供。
          启用状态与配置全局生效；运行中的会话在插件下次激活时应用。
        </p>

        {plugins && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件…"
            style={search}
          />
        )}

        {loadError && (
          <div style={errorBox}>
            <span>插件目录加载失败：{loadError}</span>
            <button onClick={() => void load()} style={retryBtn}>重试</button>
          </div>
        )}
        {!plugins && !loadError && <div style={empty}>正在加载插件…</div>}

        {actionError && <div style={errorBox}>{actionError}</div>}

        {externalErrors.length > 0 && (
          <div style={errorBox}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>外部插件加载失败（下次启动前可修正文件）</div>
              {externalErrors.map((e) => (
                <div key={e.source} style={{ fontFamily: "monospace", fontSize: 11.5 }}>
                  {e.source}: {e.reason}
                </div>
              ))}
            </div>
          </div>
        )}

        {filtered && filtered.required.length > 0 && (
          <Group label="内核能力" note="会话基座，始终激活">
            {filtered.required.map((p) => (
              <PluginCard key={p.id} plugin={p} busy={busyId === p.id} onToggle={toggle} onSaveConfig={saveConfig} />
            ))}
          </Group>
        )}
        {filtered && filtered.optional.length > 0 && (
          <Group label="可选扩展">
            {filtered.optional.map((p) => (
              <PluginCard key={p.id} plugin={p} busy={busyId === p.id} onToggle={toggle} onSaveConfig={saveConfig} />
            ))}
          </Group>
        )}
        {filtered && filtered.external.length > 0 && (
          <Group label="外部插件" note="~/.forge/plugins，启动时加载">
            {filtered.external.map((p) => (
              <PluginCard
                key={p.id}
                plugin={p}
                busy={busyId === p.id}
                onToggle={toggle}
                onSaveConfig={saveConfig}
                onUninstall={uninstall}
              />
            ))}
          </Group>
        )}
        {filtered && filtered.required.length === 0 && filtered.optional.length === 0 && filtered.external.length === 0 && (
          <div style={empty}>没有匹配的插件。</div>
        )}
      </div>
      {wizardOpen && (
        <InstallWizard
          onClose={() => setWizardOpen(false)}
          onInstalled={() => {
            setWizardOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function InstallWizard({ onClose, onInstalled }: {
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [source, setSource] = useState("");
  const [phase, setPhase] = useState<"input" | "checking" | "ready" | "installing" | "done" | "error">("input");
  const [found, setFound] = useState<PluginSourceInfoView[]>([]);
  const [errors, setErrors] = useState<Array<{ source: string; reason: string }>>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function inspect() {
    if (!source.trim() || phase === "checking") return;
    setPhase("checking");
    setMessage(null);
    setFound([]);
    setErrors([]);
    try {
      const result = await inspectPluginSource(source.trim());
      setFound(result.plugins);
      setErrors(result.errors);
      setPhase("ready");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function install() {
    if (phase !== "ready" || found.length === 0) return;
    setPhase("installing");
    try {
      const result = await installPlugin(source.trim());
      setErrors(result.errors);
      setPhase("done");
      if (result.plugins.length > 0) onInstalled();
      if (result.plugins.length === 0) {
        // Nothing registered live; keep the wizard open with the errors shown.
        setPhase("error");
        setMessage("安装完成，但没有插件成功激活，详见下方错误。");
        onInstalled();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 520 }}>
        <h3 className="modal-title">添加插件</h3>
        <p className="modal-text">
          支持本地 .plugin.ts 文件或目录，以及 https git 仓库地址（owner/repo 亦可）。
          安装前会先检查模块的 manifest 合法性。
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...wizardInput, flex: 1 }}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="~/my-plugins/greet.plugin.ts 或 https://github.com/you/forge-plugin.git"
            onKeyDown={(e) => e.key === "Enter" && void inspect()}
            disabled={phase === "checking" || phase === "installing"}
          />
          <button className="btn btn-ghost btn-small" onClick={() => void inspect()} disabled={phase === "checking" || !source.trim()}>
            {phase === "checking" ? "检查中…" : "检查"}
          </button>
        </div>

        {found.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {found.map((plugin) => (
              <div key={plugin.id} style={foundCard}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <b style={{ fontSize: 13 }}>{plugin.name}</b>
                  <span style={version}>{plugin.version}</span>
                  <span style={version}>{plugin.fileName}</span>
                </div>
                {plugin.description && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{plugin.description}</div>}
              </div>
            ))}
          </div>
        )}
        {errors.map((e) => (
          <div key={e.source} style={{ ...errorNote, marginTop: 8 }}>
            {e.source}: {e.reason}
          </div>
        ))}
        {message && <div style={{ ...errorNote, marginTop: 8 }}>{message}</div>}
        {phase === "done" && <div style={{ ...savedNote, marginTop: 8 }}>已安装，新会话立即可用。</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost btn-small" onClick={onClose}>关闭</button>
          <button
            className="btn btn-primary btn-small"
            onClick={() => void install()}
            disabled={phase !== "ready" || found.length === 0}
          >
            {phase === "installing" ? "安装中…" : `安装${found.length > 0 ? `（${found.length} 个）` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ label, note, children }: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={groupLabelRow}>
        <span style={groupLabel}>{label}</span>
        {note && <span style={groupNote}>{note}</span>}
      </div>
      {children}
    </div>
  );
}

function PluginCard({ plugin, busy, onToggle, onSaveConfig, onUninstall }: {
  plugin: PluginCatalogEntryView;
  busy: boolean;
  onToggle: (plugin: PluginCatalogEntryView) => Promise<void>;
  onSaveConfig: (pluginId: string, values: Record<string, unknown>) => Promise<unknown>;
  onUninstall?: (pluginId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const hasSchema = (plugin.configSchema?.length ?? 0) > 0;
  const enabled = !plugin.userDisabled;

  return (
    <div style={card}>
      <div style={cardRow}>
        <span
          className="state-dot"
          style={{ background: enabled ? "var(--green)" : "var(--text-muted)", flexShrink: 0 }}
          title={enabled ? "已启用" : "已停用"}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={nameRow}>
            <span style={name}>{plugin.name}</span>
            <span style={version}>{plugin.version}</span>
            {plugin.required && <span style={coreTag}>内核</span>}
          </div>
          {plugin.description && <div style={description}>{plugin.description}</div>}
          <div style={chipRow}>
            {plugin.source === "external" && <span style={externalTag}>外部</span>}
            {plugin.capabilities.map((capability) => (
              <span key={capability} style={chip}>{CAPABILITY_LABELS[capability] ?? capability}</span>
            ))}
          </div>
          <ContributionLine plugin={plugin} />
        </div>
        {plugin.source === "external" && onUninstall && (
          <button
            style={uninstallBtn}
            onClick={() => {
              if (confirming) {
                setConfirming(false);
                void onUninstall(plugin.id);
              } else {
                setConfirming(true);
                setTimeout(() => setConfirming(false), 4000);
              }
            }}
            title="删除插件文件并从目录移除"
          >
            {confirming ? "确认卸载？" : "卸载"}
          </button>
        )}
        <Switch
          checked={enabled}
          disabled={plugin.required || busy}
          title={plugin.required ? "内核插件不可停用" : enabled ? "停用" : "启用"}
          onChange={() => void onToggle(plugin)}
        />
      </div>
      {hasSchema && (
        <div style={configRegion}>
          <button style={configToggle} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? "收起配置 ▾" : "配置 ▸"}
          </button>
          {expanded && (
            <ConfigForm
              plugin={plugin}
              onSave={onSaveConfig}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ContributionLine({ plugin }: { plugin: PluginCatalogEntryView }) {
  const parts: string[] = [];
  for (const command of plugin.slashCommands ?? []) parts.push(`/${command.name}`);
  for (const contribution of plugin.ui ?? []) parts.push(contribution.label);
  for (const action of plugin.readActions ?? []) {
    if (!(plugin.ui ?? []).some((contribution) => contribution.readAction === action.id)) {
      parts.push(action.description);
    }
  }
  if (parts.length === 0) return null;
  return <div style={contribution}>{parts.join(" · ")}</div>;
}

function ConfigForm({ plugin, onSave }: {
  plugin: PluginCatalogEntryView;
  onSave: (pluginId: string, values: Record<string, unknown>) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of plugin.configSchema ?? []) {
      initial[field.key] = plugin.config[field.key] ?? field.default;
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    for (const field of plugin.configSchema ?? []) {
      if (values[field.key] !== (plugin.config[field.key] ?? field.default)) return true;
    }
    return false;
  }, [values, plugin]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(plugin.id, values);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={form}>
      {(plugin.configSchema ?? []).map((field) => (
        <ConfigFieldRow
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
        />
      ))}
      <div style={formFooter}>
        <button style={saveBtn} onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "保存中…" : "保存"}
        </button>
        {saved && <span style={savedNote}>已保存，会话下次激活插件时生效</span>}
        {error && <span style={errorNote}>{error}</span>}
      </div>
    </div>
  );
}

function ConfigFieldRow({ field, value, onChange }: {
  field: PluginConfigFieldView;
  value: unknown;
  onChange: (value: string | number | boolean) => void;
}) {
  return (
    <label style={fieldRow}>
      <span style={fieldLabel} title={field.description}>
        {field.label}
        {field.description && <span style={fieldHint}> — {field.description}</span>}
      </span>
      {field.type === "boolean" ? (
        <Switch
          checked={value === true}
          onChange={() => onChange(!(value === true))}
          title={field.label}
        />
      ) : field.type === "enum" ? (
        <select
          style={fieldInput}
          value={String(value ?? field.default)}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          style={fieldInput}
          type={field.type === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(field.type === "number" ? Number(e.target.value) : e.target.value)}
        />
      )}
    </label>
  );
}

/** A drawn switch, not a checkbox — the DSH-form control for enablement. */
function Switch({ checked, disabled, title, onChange }: {
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onChange}
      style={switchStyleFor(checked, disabled)}
    >
      <span style={{
        ...knob,
        transform: checked ? "translateX(16px)" : "translateX(2px)",
      }} />
    </button>
  );
}

const headRow = { display: "flex", alignItems: "baseline", gap: 12 };
const title = { fontSize: 17, fontWeight: 700, color: "var(--text)" };
const count = { fontSize: 12, color: "var(--text-muted)" };
const subtitle = { fontSize: 12.5, color: "var(--text-muted)", margin: "10px 0 16px", lineHeight: 1.5 };
const addBtn = { padding: "5px 14px", borderRadius: 6, border: "1px solid var(--accent)", backgroundColor: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 };
const uninstallBtn = { padding: "3px 10px", borderRadius: 5, border: "1px solid var(--red)", backgroundColor: "transparent", color: "var(--red)", cursor: "pointer", fontSize: 11.5, flexShrink: 0 };
const wizardInput = { padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)", color: "var(--text)", fontSize: 12.5, outline: "none" };
const foundCard = { padding: "10px 12px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)" };
const search = { width: "100%", boxSizing: "border-box" as const, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)", color: "var(--text)", fontSize: 13, outline: "none" };
const empty = { color: "var(--text-muted)", fontSize: 13, marginTop: 32, textAlign: "center" as const };
const errorBox = { display: "flex", alignItems: "center", gap: 12, marginTop: 16, padding: "10px 14px", borderRadius: 8, border: "1px solid var(--red)", color: "var(--red)", fontSize: 13, backgroundColor: "var(--bg-secondary)" };
const retryBtn = { padding: "4px 12px", borderRadius: 5, border: "1px solid var(--red)", backgroundColor: "transparent", color: "var(--red)", cursor: "pointer", fontSize: 12 };
const groupLabelRow = { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 };
const groupLabel = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.5px", textTransform: "uppercase" as const };
const groupNote = { fontSize: 11, color: "var(--text-muted)", opacity: 0.75 };
const card = { padding: "12px 14px", borderRadius: 8, border: "1px solid var(--border)", backgroundColor: "var(--bg-secondary)", marginBottom: 8 };
const cardRow = { display: "flex", alignItems: "flex-start", gap: 12 };
const nameRow = { display: "flex", alignItems: "baseline", gap: 8 };
const name = { fontSize: 13.5, fontWeight: 600, color: "var(--text)" };
const version = { fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" };
const coreTag = { fontSize: 10, fontWeight: 600, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 5px", lineHeight: "16px" };
const externalTag = { fontSize: 10, fontWeight: 600, color: "var(--text-secondary)", border: "1px solid var(--border-strong)", borderRadius: 4, padding: "0 5px", lineHeight: "16px" };
const description = { fontSize: 12.5, color: "var(--text-secondary)", marginTop: 3, lineHeight: 1.5 };
const chipRow = { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" as const };
const chip = { fontSize: 10.5, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px" };
const contribution = { fontSize: 11.5, color: "var(--text-muted)", marginTop: 6, fontFamily: "monospace" };
const configRegion = { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" };
const configToggle = { background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, padding: 0 };
const form = { marginTop: 10, display: "flex", flexDirection: "column" as const, gap: 10 };
const fieldRow = { display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" };
const fieldLabel = { fontSize: 12.5, color: "var(--text)", minWidth: 0 };
const fieldHint = { color: "var(--text-muted)", fontSize: 11.5 };
const fieldInput = { width: 200, boxSizing: "border-box" as const, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: 12.5, outline: "none" };
const formFooter = { display: "flex", alignItems: "center", gap: 12 };
const saveBtn = { padding: "5px 14px", borderRadius: 6, border: "1px solid var(--border-strong)", backgroundColor: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 12.5 };
const savedNote = { fontSize: 12, color: "var(--green)" };
const errorNote = { fontSize: 12, color: "var(--red)" };
const switchBase = { position: "relative" as const, width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer", flexShrink: 0, padding: 0, transition: "background-color 120ms ease" };
const switchOn = { backgroundColor: "var(--green)" };
const switchOff = { backgroundColor: "var(--border-strong)" };
const switchLocked = { backgroundColor: "var(--text-muted)" };
const switchDisabled = { cursor: "not-allowed" as const };
/** Required plugins are substrate: their switch renders as a neutral locked
 * state, never the saturated green of an enabled optional plugin. */
function switchStyleFor(checked: boolean, disabled?: boolean) {
  if (disabled) return { ...switchBase, ...(checked ? switchLocked : switchOff), ...switchDisabled };
  return { ...switchBase, ...(checked ? switchOn : switchOff) };
}
const knob = { position: "absolute" as const, top: 2, left: 0, width: 18, height: 18, borderRadius: 9, backgroundColor: "var(--bg)", boxShadow: "0 1px 2px rgba(0,0,0,0.35)", transition: "transform 120ms ease" };
