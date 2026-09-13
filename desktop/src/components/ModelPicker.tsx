import { useEffect, useRef, useState } from "react";
import type { ProviderConfig, ThinkingLevel } from "../types.ts";
import { thinkingLabel, thinkingMeta } from "../lib/thinking.ts";
import { APPROVAL_MODES, approvalLabel } from "../lib/approval.ts";
import type { ApprovalMode } from "../types.ts";

/** Small inline check — drawn rather than typed so it sits on the text
 * baseline instead of reading as a glyph. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M4 6.5l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Endpoint host — tells two subscriptions apart without leaking the
 * protocol, which is an implementation detail the user never picked. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/**
 * Model subscription + reasoning-effort picker, in one popover.
 *
 * Both answer "how should this session run" and apply from the next turn
 * boundary.
 */
export function ModelPicker({
  providers,
  activeProviderId,
  activeModelLabel,
  onSelectModel,
  thinkingLevel,
  thinkingLevels,
  onSelectThinking,
  approvalMode,
  onSelectApprovalMode,
  placement = "above",
  disabled = false,
  defaultOpen = false,
}: {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  /** Model the session is actually running on. Used when its subscription is
   * gone from the config (deleted or renamed) so the trigger still reports the
   * truth instead of falling back to "未选择模型". */
  activeModelLabel?: string | undefined;
  onSelectModel: (providerId: string) => void;
  thinkingLevel: ThinkingLevel;
  /** Levels the current model actually supports, from the server's per-model
   * `modelCapabilities`. A model with no reasoning support yields ["off"]. */
  thinkingLevels: ThinkingLevel[];
  onSelectThinking: (level: ThinkingLevel) => void;
  approvalMode: ApprovalMode;
  onSelectApprovalMode: (mode: ApprovalMode) => void;
  /** Which way the panel opens. Composers sit at the bottom → "above". */
  placement?: "above" | "below";
  disabled?: boolean;
  /** Render with the panel already open — the dev preview harness uses this. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const active = providers.find((p) => p.id === activeProviderId) ?? null;
  const modelLabel = active?.modelId ?? activeModelLabel ?? "未选择模型";
  // "off" alone means the model has no reasoning support — then the group is
  // an explanatory line, not a choice, and the trigger stays quiet about it.
  const reasoningSupported = thinkingLevels.some((l) => l !== "off");

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="运行方式：模型订阅 / 思考强度 / 审批"
      >
        <span className="picker-model">{modelLabel}</span>
        {reasoningSupported && (
          <>
            <span className="picker-dot" aria-hidden="true" />
            <span className="picker-thinking">{thinkingLabel(thinkingLevel)}</span>
          </>
        )}
        <span className="picker-dot" aria-hidden="true" />
        <span className="picker-approval">{approvalLabel(approvalMode)}</span>
        <span className={`picker-caret${open ? " is-open" : ""}`}>
          <CaretIcon />
        </span>
      </button>

      {open && (
        <div className={`picker-panel picker-panel-${placement}`} role="listbox">
          <div className="picker-group">
            <div className="picker-group-label">模型订阅</div>
            {providers.length === 0 && <div className="picker-empty">尚未配置模型订阅</div>}
            {providers.map((p) => {
              const on = p.id === activeProviderId;
              const host = hostOf(p.baseUrl);
              return (
                <button
                  key={p.id}
                  type="button"
                  className="picker-option"
                  data-active={on || undefined}
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    if (!on) onSelectModel(p.id);
                    setOpen(false);
                  }}
                >
                  <span className="picker-mark">{on && <CheckIcon />}</span>
                  <span className="picker-option-body">
                    <span className="picker-option-label">{p.modelId}</span>
                    {host && <span className="picker-option-hint">{host}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="picker-rule" />

          <div className="picker-group">
            <div className="picker-group-label">思考强度</div>
            {!reasoningSupported ? (
              <div className="picker-empty">当前模型不支持推理，不会发送推理参数</div>
            ) : (
              thinkingLevels.map((level) => {
                const meta = thinkingMeta(level);
                const on = level === thinkingLevel;
                return (
                  <button
                    key={level}
                    type="button"
                    className="picker-option"
                    data-active={on || undefined}
                    role="option"
                    aria-selected={on}
                    onClick={() => {
                      if (!on) onSelectThinking(level);
                      setOpen(false);
                    }}
                  >
                    <span className="picker-mark">{on && <CheckIcon />}</span>
                    <span className="picker-option-body">
                      <span className="picker-option-label">{meta.label}</span>
                      {meta.hint && <span className="picker-option-hint">{meta.hint}</span>}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="picker-rule" />

          <div className="picker-group">
            <div className="picker-group-label">审批</div>
            {APPROVAL_MODES.map((mode) => {
              const on = mode.value === approvalMode;
              return (
                <button
                  key={mode.value}
                  type="button"
                  className="picker-option"
                  data-active={on || undefined}
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    if (!on) onSelectApprovalMode(mode.value);
                    setOpen(false);
                  }}
                >
                  <span className="picker-mark">{on && <CheckIcon />}</span>
                  <span className="picker-option-body">
                    <span className="picker-option-label">{mode.label}</span>
                    <span className="picker-option-hint">{mode.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
