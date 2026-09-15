import type { ConversationView, PluginCapabilitySnapshot, PluginLifecycleView } from "../types.ts";

type PluginDescriptor = PluginCapabilitySnapshot["plugins"][number];
type PluginState = ConversationView["pluginStates"][string];

const STATUS_LABEL = {
  active: "运行中",
  disabled: "已暂停",
  failed: "已隔离",
  disposed: "已释放",
} as const;

const EVENT_LABEL: Record<PluginLifecycleView["event"], string> = {
  loaded: "已加载",
  enabled: "已启用",
  disabled: "已暂停",
  failed: "失败隔离",
};

export function CapabilityHealthDialog({
  plugins,
  states,
  lifecycle,
  running,
  busyPluginId,
  error,
  onToggle,
  onClose,
}: {
  plugins: PluginDescriptor[];
  states: ConversationView["pluginStates"];
  lifecycle: PluginLifecycleView[];
  running: boolean;
  busyPluginId: string | null;
  error: string | null;
  onToggle: (pluginId: string, enabled: boolean) => void;
  onClose: () => void;
}) {
  const effective = (plugin: PluginDescriptor): PluginState => {
    const projected = states[plugin.id];
    // PLUGIN_LOADED is the last durable fact for a healthy terminal session;
    // the live-host snapshot is what truthfully knows resources are disposed.
    if (!running && plugin.status === "disposed" && projected?.status === "active") return plugin;
    return projected ?? plugin;
  };
  const requiredFailures = plugins.filter((plugin) => plugin.required && effective(plugin).status === "failed").length;
  const optionalFailures = plugins.filter((plugin) => !plugin.required && effective(plugin).status === "failed").length;

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal modal-lg capability-health-modal">
        <div className="modal-head">
          <div>
            <h3 className="modal-title">Capability Health</h3>
            <div className="modal-sub">状态和历史来自会话事件；失败只隔离对应能力，不重新执行或自动重试。</div>
          </div>
          <button className="btn btn-ghost btn-small" onClick={onClose}>关闭</button>
        </div>
        <div className="capability-health-summary" data-degraded={requiredFailures > 0 || undefined}>
          <strong>{requiredFailures > 0 ? "核心机制已降级" : "核心机制正常"}</strong>
          <span>
            {plugins.length} 个能力 · {requiredFailures} 个必需能力失败 · {optionalFailures} 个可选能力隔离
          </span>
        </div>
        {error && <div className="capability-health-error">{error}</div>}
        <div className="modal-scroll capability-health-body">
          <section className="capability-health-list">
            {plugins.map((plugin) => {
              const state = effective(plugin);
              const canToggle = running && !plugin.required && state.status !== "failed" && state.status !== "disposed";
              return (
                <article className="capability-health-row" data-status={state.status} key={plugin.id}>
                  <div className="capability-health-row-main">
                    <div>
                      <strong>{plugin.name}</strong>
                      <code>{plugin.id}</code>
                    </div>
                    <div className="capability-health-badges">
                      <span>{plugin.required ? "必需" : "可选"}</span>
                      <span data-status={state.status}>{STATUS_LABEL[state.status]}</span>
                    </div>
                  </div>
                  <div className="capability-health-meta">
                    {plugin.capabilities.length > 0 ? plugin.capabilities.join(" · ") : "无运行时贡献"}
                  </div>
                  {state.failureReason && (
                    <div className="capability-health-failure">
                      {plugin.required ? "机制降级" : "故障已隔离"} · {state.failurePhase ?? "unknown"}: {state.failureReason}
                    </div>
                  )}
                  {!plugin.required && (
                    <label className="capability-health-toggle">
                      <input
                        type="checkbox"
                        checked={state.status === "active"}
                        disabled={!canToggle || busyPluginId === plugin.id}
                        onChange={(event) => onToggle(plugin.id, event.target.checked)}
                      />
                      {busyPluginId === plugin.id
                        ? "正在更新…"
                        : state.status === "failed"
                          ? "本次运行不可重启"
                          : state.status === "disposed"
                            ? "会话已结束"
                          : state.status === "active"
                            ? "已启用"
                            : "已暂停"}
                    </label>
                  )}
                </article>
              );
            })}
          </section>
          <section className="capability-lifecycle">
            <h4>生命周期</h4>
            {lifecycle.length === 0 ? (
              <div className="audit-empty">此会话还没有 capability 生命周期事件。</div>
            ) : (
              [...lifecycle].reverse().slice(0, 80).map((item) => (
                <div className="capability-lifecycle-row" data-event={item.event} key={item.id}>
                  <time>{new Date(item.at).toLocaleTimeString()}</time>
                  <code>{item.pluginId}</code>
                  <strong>{EVENT_LABEL[item.event]}</strong>
                  {item.phase && <span>{item.phase}</span>}
                  {item.reason && <span title={item.reason}>{item.reason}</span>}
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
