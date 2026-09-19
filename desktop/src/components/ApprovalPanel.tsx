import { store } from "../lib/store.ts";
import type { ApprovalRecordView } from "../types.ts";

/** In-place approval: the card takes over the composer instead of
 * popping a modal over the transcript. Reject / Allow-once are the only
 * answers — a durable posture belongs to the approval-mode picker. */
export function ApprovalPanel({ request }: { request: ApprovalRecordView }) {
  const approve = store((s) => s.approve);
  const deny = store((s) => s.deny);
  return (
    <div className="approval-card" role="alertdialog" aria-label={`Allow ${request.toolName}?`}>
      <div className="approval-wait" aria-hidden="true" />
      <div className="approval-head">
        <span className="approval-tool">允许 {request.toolName}？</span>
        <span className="approval-since" title="Unanswered requests are denied after 5 minutes">
          等待中 · 5 分钟后自动拒绝
        </span>
      </div>
      <pre className="approval-detail">{request.message}</pre>
      <div className="approval-actions">
        <button className="btn btn-ghost btn-small" onClick={() => void deny(request.requestId)}>
          拒绝
        </button>
        <button className="btn btn-primary btn-small" onClick={() => void approve(request.requestId)}>
          允许一次
        </button>
      </div>
    </div>
  );
}
