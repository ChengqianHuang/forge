import { useEffect, useRef, useState } from "react";
import { store } from "../lib/store.ts";
import { useModelCatalog } from "../lib/catalog.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type { ApprovalMode, ThinkingLevel } from "../types.ts";


export function Composer({ projectId }: { projectId?: string | null }) {
  const createSession = store((s) => s.createSession);
  const loading = store((s) => s.loading);
  const error = store((s) => s.error);
  const [goal, setGoal] = useState("");
  const [thinking, setThinking] = useState<ThinkingLevel>("medium");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("default");
  // Turn budget: after the cost budget was retired this is the only "runaway"
  // bound, and it used to have no UI entry at all (AGENTS.md Rule 9.2: a
  // capability without a UI entry point does not exist for the user).
  const { providers, defaultProviderId, capabilities } = useModelCatalog();
  const [providerId, setProviderId] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Default the picker to the configured default subscription once the
  // catalog arrives (and keep a manual choice if the user already made one).
  useEffect(() => {
    if (providerId !== null || providers.length === 0) return;
    setProviderId(defaultProviderId || providers[0]?.id || null);
  }, [providers, defaultProviderId, providerId]);

  // Until the server tells us otherwise, assume no reasoning support — the
  // picker then says so instead of offering levels that would do nothing.
  const thinkingLevels = (providerId ? capabilities[providerId] : undefined) ?? ["off"];

  // Grow with the content instead of reserving three fixed rows.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [goal]);

  const submit = () => {
    if (!goal.trim() || loading) return;
    void createSession({
      goal: goal.trim(),
      ...(projectId ? { projectId } : {}),
      ...(providerId ? { providerId } : {}),
      thinkingLevel: thinking,
      approvalMode,
    });
    setGoal("");
  };

  return (
    <div className="landing-wrap">
      <div className="landing">
        <h1 className="landing-title">What should Forge do?</h1>
        <div className="composer-box">
          <textarea
            ref={taRef}
            className="composer-ta"
            placeholder="Describe the engineering task…"
            value={goal}
            rows={1}
            autoFocus
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-actions">
            <div className="composer-meta">
              <ModelPicker
                providers={providers}
                activeProviderId={providerId}
                onSelectModel={setProviderId}
                thinkingLevel={thinking}
                thinkingLevels={thinkingLevels}
                onSelectThinking={setThinking}
                approvalMode={approvalMode}
                onSelectApprovalMode={setApprovalMode}
                placement="above"
              />
            </div>
            <button className="btn btn-primary btn-small" onClick={submit} disabled={!goal.trim() || loading}>
              {loading ? "Starting…" : "Start"}
              <span className="key-hint">↵</span>
            </button>
          </div>
        </div>

        {error && <div className="landing-error">{error}</div>}

      </div>
    </div>
  );
}
