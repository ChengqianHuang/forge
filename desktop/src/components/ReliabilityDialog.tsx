import type { ReliabilityMetrics } from "../types.ts";

function latency(value: number | null): string {
  return value === null ? "—" : value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="reliability-metric">
      <div className="reliability-value">{value}</div>
      <div className="reliability-label">{label}</div>
      <div className="reliability-detail">{detail}</div>
    </div>
  );
}

/** Event-derived harness diagnostics, rendered inside the right dock. */
export function ReliabilityContent({
  metrics,
  loading,
  error,
}: {
  metrics: ReliabilityMetrics | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <div className="dock-empty">正在读取事件日志…</div>;
  if (error) return <div className="reliability-error">{error}</div>;
  if (!metrics) return null;
  return (
    <div className="dock-scroll">
      <div className={`reliability-state ${metrics.integrity.healthy ? "is-healthy" : "is-violated"}`}>
        <span className="reliability-state-mark">{metrics.integrity.healthy ? "✓" : "!"}</span>
        <div>
          <strong>{metrics.integrity.healthy ? "Harness 正常" : "发现机制异常"}</strong>
          <div>{metrics.eventCount} 条持久事件 · {(metrics.wallMs / 1_000).toFixed(1)} 秒日志跨度</div>
        </div>
      </div>
      <div className="reliability-grid">
        <Metric label="Guard 覆盖" value={`${Math.round(metrics.tools.guardCoverage * 100)}%`} detail={`${metrics.tools.guarded}/${metrics.tools.calls} 次工具调用`} />
        <Metric label="工具收敛" value={`${metrics.tools.results}/${metrics.tools.calls}`} detail={`${metrics.tools.unfinished} 个未完成 · ${metrics.tools.errors} 个错误`} />
        <Metric label="运行终态" value={`${metrics.runs.terminal}/${metrics.runs.started}`} detail={`${metrics.runs.endedByPi} 次由 Pi 正常结束`} />
        <Metric label="审批 P95" value={latency(metrics.approvals.p95LatencyMs)} detail={`${metrics.approvals.pending} 个仍待处理`} />
        <Metric label="取消 P95" value={latency(metrics.cancellation.p95LatencyMs)} detail={`${metrics.cancellation.settled}/${metrics.cancellation.requested} 次已收敛`} />
        <Metric label="恢复" value={String(metrics.recovery.resumed)} detail={`${metrics.recovery.interrupted} 次中断 · ${metrics.recovery.messagesRecovered} 条消息`} />
      </div>
      {metrics.integrity.violations.length > 0 && (
        <div className="reliability-violations">
          <h4>需要检查</h4>
          {metrics.integrity.violations.map((violation) => <div key={violation}>• {violation}</div>)}
        </div>
      )}
      {metrics.plugins.failures > 0 && (
        <div className="reliability-note">此会话记录了 {metrics.plugins.failures} 次插件失败；失败已隔离，不一定代表内核异常。</div>
      )}
    </div>
  );
}
