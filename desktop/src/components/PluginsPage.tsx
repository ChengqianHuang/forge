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

/** The global plugin manager page: one place to see every registered plugin,
 * toggle optional ones, and edit their declared config. Enablement and config
 * are global preferences — a running session applies them the next time its
 * plugins activate (and the copy says exactly that). */

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
    <div className="plugins-page">
      <div className="plugins-canvas">
        <div className="plugins-head">
          <span className="plugins-title">插件</span>
          <span className="plugins-count">{plugins ? `${plugins.length} 项` : ""}</span>
          <span className="plugins-head-spacer" />
          <button className="btn btn-ghost btn-small plugins-add" onClick={() => setWizardOpen(true)}>添加插件</button>
        </div>
        <p className="plugins-subtitle">
          扩展 Forge 的能力面：工具、命令、护栏检视与界面贡献都由插件提供。
          启用状态与配置全局生效；运行中的会话在插件下次激活时应用。
        </p>

        {plugins && (
          <input
            className="input plugins-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索插件…"
          />
        )}

        {loadError && (
          <div className="plugin-error-box" role="alert">
            <span>插件目录加载失败：{loadError}</span>
            <button className="plugin-retry" onClick={() => void load()}>重试</button>
          </div>
        )}
        {!plugins && !loadError && <div className="plugins-empty">正在加载插件…</div>}

        {actionError && <div className="plugin-error-box" role="alert">{actionError}</div>}

        {externalErrors.length > 0 && (
          <div className="plugin-error-box" role="alert">
            <div>
              <div className="plugin-error-head">外部插件加载失败（下次启动前可修正文件）</div>
              {externalErrors.map((e) => (
                <code key={e.source} className="plugin-error-line">{e.source}: {e.reason}</code>
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
          <div className="plugins-empty">没有匹配的插件。</div>
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
  const [trusted, setTrusted] = useState(false);
  const [inspectionId, setInspectionId] = useState<string | null>(null);
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
    setInspectionId(null);
    try {
      const result = await inspectPluginSource(source.trim());
      setInspectionId(result.inspectionId);
      setFound(result.plugins);
      setErrors(result.errors);
      setPhase("ready");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function install() {
    if (phase !== "ready" || found.length === 0 || !inspectionId) return;
    setPhase("installing");
    try {
      const result = await installPlugin(inspectionId);
      setErrors(result.errors);
      if (result.plugins.length > 0) {
        setPhase("done");
        onInstalled();
      } else {
        // Files landed but nothing registered live: keep the wizard open and
        // say so, instead of a success screen that would be a lie.
        setPhase("error");
        setMessage("文件已写入，但没有插件成功激活，详见上方错误。");
        onInstalled();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plugin-wizard">
        <h3 className="modal-title">添加插件</h3>
        <p className="modal-text">
          支持本地 .plugin.ts 文件或目录，以及 https git 仓库地址（owner/repo 亦可）。
          Forge 插件是受信任的进程内代码；“检查”会下载或复制模块，并以当前用户身份执行它来验证 manifest。
        </p>
        <label className="plugin-trust-row">
          <input
            type="checkbox"
            checked={trusted}
            onChange={(event) => setTrusted(event.target.checked)}
            disabled={phase === "checking" || phase === "installing"}
          />
          <span>我信任这个来源，并允许在检查阶段执行其中的插件代码。</span>
        </label>
        <div className="plugin-wizard-row">
          <input
            className="input plugin-wizard-input"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setInspectionId(null);
              setFound([]);
              setErrors([]);
              setMessage(null);
              setPhase("input");
            }}
            placeholder="~/my-plugins/greet.plugin.ts 或 https://github.com/you/forge-plugin.git"
            onKeyDown={(e) => e.key === "Enter" && void inspect()}
            disabled={phase === "checking" || phase === "installing"}
          />
          <button
            className="btn btn-ghost btn-small"
            onClick={() => void inspect()}
            disabled={phase === "checking" || !source.trim() || !trusted}
          >
            {phase === "checking" ? "检查中…" : "检查"}
          </button>
        </div>

        {found.length > 0 && (
          <div className="plugin-wizard-found">
            {found.map((plugin) => (
              <div key={plugin.id} className="plugin-wizard-card">
                <div className="plugin-name-row">
                  <b className="plugin-wizard-name">{plugin.name}</b>
                  <code className="plugin-version">{plugin.version}</code>
                  <code className="plugin-version">{plugin.fileName}</code>
                  <code className="plugin-version" title={plugin.sha256}>sha256:{plugin.sha256.slice(0, 12)}</code>
                </div>
                {plugin.description && <div className="plugin-desc">{plugin.description}</div>}
              </div>
            ))}
          </div>
        )}
        {errors.map((e) => (
          <div key={e.source} className="plugin-error-note">{e.source}: {e.reason}</div>
        ))}
        {message && <div className="plugin-error-note">{message}</div>}
        {phase === "done" && <div className="plugin-saved-note">已安装，新会话立即可用。</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost btn-small" onClick={onClose}>关闭</button>
          <button
            className="btn btn-primary btn-small"
            onClick={() => void install()}
            disabled={phase !== "ready" || found.length === 0 || !inspectionId}
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
    <div className="plugin-group">
      <div className="plugin-group-head">
        <span className="plugin-group-label">{label}</span>
        {note && <span className="plugin-group-note">{note}</span>}
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
    <article className="plugin-card" data-enabled={enabled || undefined}>
      <div className="plugin-card-row">
        <span
          className="state-dot plugin-dot"
          data-on={enabled || undefined}
          title={enabled ? "已启用" : "已停用（新会话不再激活）"}
        />
        <div className="plugin-card-main">
          <div className="plugin-name-row">
            <span className="plugin-name">{plugin.name}</span>
            <code className="plugin-version">{plugin.version}</code>
            {plugin.required && <span className="plugin-tag" data-tone="accent">内核</span>}
          </div>
          <code className="plugin-id">{plugin.id}</code>
          {plugin.description && <div className="plugin-desc">{plugin.description}</div>}
          <div className="plugin-chips">
            {plugin.source === "external" && <span className="plugin-tag" data-tone="neutral">外部</span>}
            {plugin.capabilities.map((capability) => (
              <span key={capability} className="plugin-chip">{CAPABILITY_LABELS[capability] ?? capability}</span>
            ))}
          </div>
          <ContributionLine plugin={plugin} />
        </div>
        {plugin.source === "external" && onUninstall && (
          <button
            className="plugin-uninstall"
            data-confirming={confirming || undefined}
            onClick={() => {
              if (confirming) {
                setConfirming(false);
                void onUninstall(plugin.id);
              } else {
                setConfirming(true);
                setTimeout(() => setConfirming(false), 4000);
              }
            }}
            title="删除插件文件并从目录移除；运行中的会话保留到释放"
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
        <div className="plugin-config-region">
          <button className="plugin-config-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? "收起配置 ▾" : "配置 ▸"}
          </button>
          {expanded && (
            <ConfigForm plugin={plugin} onSave={onSaveConfig} />
          )}
        </div>
      )}
    </article>
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
  return <div className="plugin-contribution">{parts.join(" · ")}</div>;
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
    <div className="plugin-config-form">
      {(plugin.configSchema ?? []).map((field) => (
        <ConfigFieldRow
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
        />
      ))}
      <div className="plugin-config-footer">
        <button className="btn btn-ghost btn-small" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "保存中…" : "保存"}
        </button>
        {saved && <span className="plugin-saved-note">已保存，会话下次激活插件时生效</span>}
        {error && <span className="plugin-error-note">{error}</span>}
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
    <label className="plugin-field-row">
      <span className="plugin-field-label" title={field.description}>
        {field.label}
        {field.description && <span className="plugin-field-hint"> — {field.description}</span>}
      </span>
      {field.type === "boolean" ? (
        <Switch
          checked={value === true}
          onChange={() => onChange(!(value === true))}
          title={field.label}
        />
      ) : field.type === "enum" ? (
        <select
          className="input plugin-field-input"
          value={String(value ?? field.default)}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          className="input plugin-field-input"
          type={field.type === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(field.type === "number" ? Number(e.target.value) : e.target.value)}
        />
      )}
    </label>
  );
}

/** A drawn switch, not a checkbox — the control for enablement. Required
 * plugins render a neutral locked state, never the saturated green of an
 * enabled optional plugin. */
function Switch({ checked, disabled, title, onChange }: {
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: () => void;
}) {
  return (
    <button
      role="switch"
      className="plugin-switch"
      aria-checked={checked}
      aria-label={title}
      title={title}
      disabled={disabled}
      data-state={disabled ? "locked" : checked ? "on" : "off"}
      onClick={onChange}
    >
      <span className="plugin-switch-knob" data-checked={checked || undefined} />
    </button>
  );
}
