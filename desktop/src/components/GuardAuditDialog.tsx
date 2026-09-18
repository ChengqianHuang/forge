import type { GuardDecisionView } from "../types.ts";

const OUTCOME_LABEL: Record<GuardDecisionView["outcome"], string> = {
  allowed: "自动放行",
  approved: "已批准",
  rejected: "已拒绝",
  denied: "策略阻止",
  aborted: "已中止",
};

/** Durable guard decisions, rendered inside the right dock. */
export function GuardAuditContent({ decisions }: { decisions: GuardDecisionView[] }) {
  if (decisions.length === 0) {
    return <div className="dock-empty">此会话还没有可审计的工具决策。</div>;
  }
  return (
    <div className="dock-scroll audit-list">
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
