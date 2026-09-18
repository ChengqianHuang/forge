import { useEffect } from "react";
import { store } from "../lib/store.ts";
import { addProject } from "../lib/api.ts";
import type { SessionStatus } from "../types.ts";

const statusColor: Record<SessionStatus, string> = {
  running: "var(--accent)",
  completed: "var(--green)",
  failed: "var(--red)",
  cancelled: "var(--text-muted)",
};

const statusLabel: Record<SessionStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** Compact relative time for the session list ("now", "3m", "2h", "5d"). */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}时`;
  return `${Math.floor(diff / 86_400_000)}天`;
}

/** Hairline glyphs — drawn, not typed, so they sit on the optical centre
 * instead of inheriting whatever weight the UI font gives "✕" and "+". */
function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Sidebar({ onNewSession }: { onNewSession: () => void }) {
  const sessions = store((s) => s.sessions);
  const activeId = store((s) => s.activeSessionId);
  const select = store((s) => s.select);
  const remove = store((s) => s.remove);
  const theme = store((s) => s.theme);
  const toggleTheme = store((s) => s.toggleTheme);
  const openSettings = store((s) => s.setSettingsOpen);
  const pluginsOpen = store((s) => s.pluginsOpen);
  const setPluginsOpen = store((s) => s.setPluginsOpen);
  // Project state lives in the store, not here: a project switch must be
  // visible to the rest of the app (the Composer creates new sessions against
  // it) and must survive remounts.
  const projects = store((s) => s.projects);
  const activeProject = store((s) => s.activeProjectId);
  const refreshProjects = store((s) => s.refreshProjects);
  const switchProject = store((s) => s.selectProject);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  async function onSwitchProject(id: string) {
    await switchProject(id);
  }

  async function onAddProject() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "选择项目文件夹" });
      if (typeof picked !== "string" || !picked) return;
      const created = await addProject(picked);
      await switchProject(created.id);
    } catch (err) {
      console.error("add project failed:", err);
    }
  }

  return (
    <div className="sidebar">
      {/* macOS traffic lights overlay this strip — keep it clear of content. */}
      <div className="sidebar-drag" />
      <div className="sidebar-brand">Forge<span>.</span></div>

      <div className="side-header-row">
        <div className="side-section-label">项目</div>
        <button
          className="side-add-btn"
          onClick={() => void onAddProject()}
          title="添加项目文件夹"
          aria-label="添加项目文件夹"
        >
          <PlusIcon />
        </button>
      </div>
      <select
        className="side-trigger"
        value={activeProject ?? ""}
        onChange={(e) => void onSwitchProject(e.target.value)}
      >
        {projects.length === 0 && <option value="">未选择项目</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      <div className="side-header-row side-header-sessions">
        <div className="side-section-label">会话</div>
        <button
          className="side-add-btn"
          onClick={onNewSession}
          title="新建会话"
          aria-label="新建会话"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="side-list">
        {sessions.length === 0 && <div className="side-empty">暂无会话</div>}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "selected" : ""}`}
            onClick={() => select(s.id)}
          >
            <span
              className="state-dot"
              style={{ background: statusColor[s.status] }}
              title={statusLabel[s.status]}
            />
            <span className="title" title={s.goal}>{s.goal || "(未命名)"}</span>
            <span className="time">{timeAgo(s.updatedAt)}</span>
            {s.id === activeId && (
              <button
                className="side-icon-btn session-del"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s.id);
                }}
                title="删除会话"
                aria-label="删除会话"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="side-bottom">
        <button className="side-bottom-btn" onClick={() => openSettings(true)}>
          <span>设置</span>
        </button>
        <button
          className={`side-bottom-btn side-icon-btn ${pluginsOpen ? "side-bottom-active" : ""}`}
          onClick={() => setPluginsOpen(!pluginsOpen)}
          title="插件"
          aria-label="插件"
          aria-pressed={pluginsOpen}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M6.5 2.5a1.5 1.5 0 0 1 3 0V4H11a1 1 0 0 1 1 1v1.5h1.5a1.5 1.5 0 0 1 0 3H12V12a1 1 0 0 1-1 1H9.5v-1.5a1.5 1.5 0 0 0-3 0V13H5a1 1 0 0 1-1-1v-2.5H2.5a1.5 1.5 0 0 1 0-3H4V5a1 1 0 0 1 1-1h1.5V2.5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="side-bottom-btn side-icon-btn"
          onClick={toggleTheme}
          title="切换主题"
          aria-label="切换主题"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
    </div>
  );
}
