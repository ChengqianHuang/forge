import { useRef, useState } from "react";
import type { WorkspaceChangeView, WorkspaceChangesView, WorkspaceFileDiff } from "../types.ts";

function statusLabel(status: string): string {
  if (status === "??") return "新增";
  if (status.includes("R")) return "重命名";
  if (status.includes("D")) return "删除";
  if (status.includes("A")) return "新增";
  if (status.includes("M")) return "修改";
  return status.trim() || "变化";
}

function ChangeRow({ file, selected, onSelect }: { file: WorkspaceChangeView; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="change-row" data-selected={selected || undefined} onClick={onSelect}>
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
    </button>
  );
}

/** Workspace changes + per-file diff, rendered inside the right dock. */
export function WorkspaceChangesContent({
  changes,
  readDiff,
}: {
  changes: WorkspaceChangesView;
  readDiff?: (path: string) => Promise<WorkspaceFileDiff>;
}) {
  const changedNow = changes.files.filter((file) => file.changedDuringSession).length;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const select = async (path: string) => {
    const request = ++requestSequence.current;
    setSelectedPath(path);
    setDiff(null);
    setError(null);
    if (!readDiff) return;
    setLoading(true);
    try {
      const next = await readDiff(path);
      if (request === requestSequence.current) setDiff(next);
    } catch (err) {
      if (request === requestSequence.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (request === requestSequence.current) setLoading(false);
    }
  };
  if (!changes.supported) {
    return (
      <div className="dock-empty">
        {changes.reason === "not-git" ? "当前工作区不是 Git 仓库。" : "暂时无法读取 Git 工作区状态。"}
      </div>
    );
  }
  if (changes.phase === "baseline") {
    return <div className="dock-empty">Agent 尚未结束；会话基线已经记录，结束后会显示净变化。</div>;
  }
  if (changes.files.length === 0) {
    return <div className="dock-empty">工作区没有未提交变化。</div>;
  }
  return (
    <div className="dock-changes">
      <div className="changes-summary">
        <strong>{changes.files.length}</strong> 个文件有净变化
        <span>·</span>
        <strong>{changedNow}</strong> 个在本次会话中发生变化
      </div>
      <div className="dock-scroll changes-body">
        <div className="change-list">
          {changes.files.map((file) => (
            <ChangeRow
              key={file.path}
              file={file}
              selected={selectedPath === file.path}
              onSelect={() => void select(file.path)}
            />
          ))}
        </div>
        <div className="diff-view">
          {!selectedPath && <div className="diff-placeholder">选择文件查看当前 Git diff</div>}
          {selectedPath && loading && <div className="diff-placeholder">正在读取 {selectedPath}…</div>}
          {error && <div className="diff-error">{error}</div>}
          {diff?.kind === "binary" && <div className="diff-placeholder">二进制文件不显示文本 diff。</div>}
          {diff?.kind === "empty" && <div className="diff-placeholder">该路径当前没有可显示的文本 diff。</div>}
          {diff?.kind === "text" && (
            <>
              <div className="diff-head">
                <code>{diff.path}</code>
                <span>{Math.ceil(diff.bytes / 1024)} KB{diff.truncated ? " · 已截断" : ""}</span>
              </div>
              <pre className="diff-patch">{diff.patch}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
