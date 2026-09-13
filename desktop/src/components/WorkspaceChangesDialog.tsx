import type { WorkspaceChangeView, WorkspaceChangesView } from "../types.ts";

function statusLabel(status: string): string {
  if (status === "??") return "新增";
  if (status.includes("R")) return "重命名";
  if (status.includes("D")) return "删除";
  if (status.includes("A")) return "新增";
  if (status.includes("M")) return "修改";
  return status.trim() || "变化";
}

function ChangeRow({ file }: { file: WorkspaceChangeView }) {
  return (
    <div className="change-row">
      <span className="change-status" data-status={file.status.trim() || file.status}>{statusLabel(file.status)}</span>
      <div className="change-path-wrap">
        <code className="change-path">{file.path}</code>
        {file.previousPath && <span className="change-previous">原路径 {file.previousPath}</span>}
      </div>
      <div className="change-badges">
        {file.preexisting && <span className="change-preexisting">会话前已修改</span>}
        {!file.changedDuringSession && <span className="change-unchanged">本次未继续改动</span>}
        {(file.additions !== null || file.deletions !== null) && (
          <span className="change-lines">
            {file.additions !== null && <b>+{file.additions}</b>}
            {file.deletions !== null && <i>-{file.deletions}</i>}
          </span>
        )}
      </div>
    </div>
  );
}

export function WorkspaceChangesDialog({ changes, onClose }: { changes: WorkspaceChangesView; onClose: () => void }) {
  const changedNow = changes.files.filter((file) => file.changedDuringSession).length;
  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal modal-lg changes-modal">
        <div className="modal-head">
          <div>
            <h3 className="modal-title">工作区变更</h3>
            <div className="modal-sub">
              当前 Git 净变化；会话前已有的修改会单独标记，不归因给 Agent。
            </div>
          </div>
          <button className="btn btn-ghost btn-small" onClick={onClose}>关闭</button>
        </div>
        {!changes.supported ? (
          <div className="changes-empty">
            {changes.reason === "not-git" ? "当前工作区不是 Git 仓库。" : "暂时无法读取 Git 工作区状态。"}
          </div>
        ) : changes.phase === "baseline" ? (
          <div className="changes-empty">Agent 尚未结束；会话基线已经记录，结束后会显示净变化。</div>
        ) : changes.files.length === 0 ? (
          <div className="changes-empty">工作区没有未提交变化。</div>
        ) : (
          <>
            <div className="changes-summary">
              <strong>{changes.files.length}</strong> 个文件有净变化
              <span>·</span>
              <strong>{changedNow}</strong> 个在本次会话中发生变化
            </div>
            <div className="modal-scroll change-list">
              {changes.files.map((file) => <ChangeRow key={file.path} file={file} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
