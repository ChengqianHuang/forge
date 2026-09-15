import type { GuardDecisionView } from "../types.ts";

const OUTCOME_LABEL: Record<GuardDecisionView["outcome"], string> = {
  allowed: "自动放行",
  approved: "已批准",
  rejected: "已拒绝",
  denied: "策略阻止",
  aborted: "已中止",
};

function GuardAudit({ decisions }: { decisions: GuardDecisionView[] }) {
  if (decisions.length === 0) {
    return <div className="audit-empty">此会话还没有可审计的工具决策。</div>;
  }
  return (
    <div className="audit-list">
      {[...decisions].reverse().map((decision) => (
        <article className="audit-row" key={decision.decisionId}>
          <div className="audit-row-head">
            <span className="audit-outcome" data-outcome={decision.outcome}>
              {OUTCOME_LABEL[decision.outcome]}
            </span>
            <strong>{decision.toolName}</strong>
            <span className="audit-capability">{decision.capability}</span>
            <time>{new Date(decision.at).toLocaleTimeString()}</time>
          </div>
          {decision.inputSummary && <code className="audit-input">{decision.inputSummary}</code>}
          <div className="audit-meta">
            <span>Guard {decision.guardId}</span>
            <span>规则 {decision.ruleId ?? "policy default"}</span>
            <span>依据 {decision.basis}</span>
            <span>审批级别 {decision.approvalMode}</span>
          </div>
          <div className="audit-reason">{decision.reason}</div>
        </article>
      ))}
    </div>
  );
}

export function GuardAuditDialog({
  decisions,
  onClose,
}: {
  decisions: GuardDecisionView[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal modal-lg audit-modal">
        <div className="modal-head">
          <div>
            <h3 className="modal-title">Guard 审计</h3>
            <div className="modal-sub">来自事件日志的最终决策，不重新执行或推测历史策略。</div>
          </div>
          <button className="btn btn-ghost btn-small" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-scroll">
          <GuardAudit decisions={decisions} />
        </div>
      </div>
    </div>
  );
}
