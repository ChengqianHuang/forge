/**
 * UI preview harness — dev-only, not part of the app bundle.
 *
 * Renders the real components (Sidebar / SessionView / Composer / SettingsPage)
 * against a seeded zustand store, so layout and typography can be inspected in a
 * plain browser without the Tauri sidecar.
 * Open /preview.html?scene=<name>&theme=<dark|light>
 *
 * Scenes: session | thinking | landing | empty | settings | replay | notify | picker | health | audit | reliability | changes
 *
 * `replay` folds captured real session frames through the real reducer;
 * `notify` additionally patches document.hidden and window.Notification and
 * runs a REAL SSE stream, to check the task-outcome notification path —
 * ?scene=notify&token=<token>&session=<id>
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { store, reduceEnvelope } from "./lib/store.ts";
import { initClient } from "./lib/api.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { Composer } from "./components/Composer.tsx";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { CapabilityHealthDialog } from "./components/CapabilityHealthDialog.tsx";
import { GuardAuditDialog } from "./components/GuardAuditDialog.tsx";
import { ReliabilityDialog } from "./components/ReliabilityDialog.tsx";
import { WorkspaceChangesDialog } from "./components/WorkspaceChangesDialog.tsx";
import { REPLAY } from "./__replay.ts";
import type { EventEnvelope, TimelineEntry } from "./types.ts";
import "./styles.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "session";
const theme = (params.get("theme") as "dark" | "light") ?? "dark";
document.documentElement.dataset.theme = theme;

// Optional: point the preview at a live sidecar so scenes that call the API
// (Settings, Composer's subscription list) render against real data.
const token = params.get("token");
if (token) initClient({ baseUrl: params.get("base") ?? "http://127.0.0.1:5300", token });

// Dev-only: reveal hover-only affordances so a headless screenshot can show
// them (a screenshot cannot hover a row).
if (params.get("hover") === "1") document.body.classList.add("preview-hover");

const now = Date.now();
const MIN = 60_000;

const sessions = [
  {
    id: "s1",
    goal: "Add a --json flag to the CLI and cover it with tests",
    workspace: "/Users/hcq/demo",
    projectId: "p1",
    model: { provider: "prov-1", modelId: "MiniMax-M2.7" },
    status: "running" as const,
    failureReason: null,
    usage: { tokensIn: 3360, tokensOut: 840, cacheRead: 0, cacheWrite: 0, lastContextTokens: 3560 },
    approvalMode: "default" as const,
    thinkingLevel: "medium" as const,
    createdAt: now - 40 * MIN,
    updatedAt: now - 30_000,
  },
  {
    id: "s2",
    goal: "Refactor the event log to a FIFO per-session queue",
    workspace: "/Users/hcq/demo",
    projectId: "p1",
    model: { provider: "prov-1", modelId: "MiniMax-M2.7" },
    status: "completed" as const,
    failureReason: null,
    usage: { tokensIn: 9040, tokensOut: 2260, cacheRead: 0, cacheWrite: 0, lastContextTokens: 9240 },
    approvalMode: "default" as const,
    thinkingLevel: "high" as const,
    createdAt: now - 26 * 60 * MIN,
    updatedAt: now - 3 * 60 * MIN,
  },
  {
    id: "s3",
    goal: "What does the guardrail pipeline actually enforce?",
    workspace: "/Users/hcq/demo",
    projectId: "p1",
    model: { provider: "prov-2", modelId: "claude-sonnet-4-5" },
    status: "completed" as const,
    failureReason: null,
    usage: { tokensIn: 640, tokensOut: 160, cacheRead: 0, cacheWrite: 0, lastContextTokens: 840 },
    approvalMode: "default" as const,
    thinkingLevel: "off" as const,
    createdAt: now - 50 * 60 * MIN,
    updatedAt: now - 40 * 60 * MIN,
  },
  {
    id: "s4",
    goal: "Fix the flaky sidecar handshake on port reuse",
    workspace: "/Users/hcq/demo",
    projectId: "p1",
    model: { provider: "prov-1", modelId: "MiniMax-M2.7" },
    status: "failed" as const,
    failureReason: "stuck detected: monologue (4 consecutive turns without tool calls)",
    usage: { tokensIn: 6160, tokensOut: 1540, cacheRead: 0, cacheWrite: 0, lastContextTokens: 6360 },
    approvalMode: "default" as const,
    thinkingLevel: "medium" as const,
    createdAt: now - 5 * 24 * 60 * MIN,
    updatedAt: now - 5 * 24 * 60 * MIN,
  },
  {
    id: "s5",
    goal: "Vendor pi via npm workspaces",
    workspace: "/Users/hcq/demo",
    projectId: "p1",
    model: { provider: "prov-1", modelId: "MiniMax-M2.7" },
    status: "completed" as const,
    failureReason: null,
    usage: { tokensIn: 4400, tokensOut: 1100, cacheRead: 0, cacheWrite: 0, lastContextTokens: 4600 },
    approvalMode: "default" as const,
    thinkingLevel: "medium" as const,
    createdAt: now - 8 * 24 * 60 * MIN,
    updatedAt: now - 8 * 24 * 60 * MIN,
  },
];

const CODE = [
  "export function printResult(result: RunResult, opts: { json?: boolean }) {",
  '  if (opts.json) {',
  '    process.stdout.write(JSON.stringify(result, null, 2) + "\\n");',
  "    return;",
  "  }",
  "  renderTable(result);",
  "}",
].join("\n");

const timeline: TimelineEntry[] = [
  { kind: "user", id: "u1", text: "Add a --json flag to the CLI and cover it with tests" },
  {
    kind: "assistant",
    id: "a1",
    text: "I'll wire the flag through the argument parser first, then branch the output path and add tests.",
    streaming: false,
    thinking: false,
  },
  { kind: "tool", id: "tool-t1", toolCallId: "t1", toolName: "read", args: { path: "src/cli/args.ts" }, result: "ok", running: false },
  {
    kind: "tool",
    id: "tool-t2",
    toolCallId: "t2",
    toolName: "edit",
    args: { path: "src/cli/args.ts", oldText: "const flags = [", newText: 'const flags = ["--json",' },
    result: "applied 1 hunk",
    running: false,
  },
  {
    kind: "assistant",
    id: "a2",
    text: "The flag parses now. The formatter still always renders the human table, so that needs a branch.",
    streaming: false,
    thinking: false,
  },
  { kind: "user", id: "u2", text: "keep the table output unchanged for existing callers" },
  {
    kind: "assistant",
    id: "a3",
    text: `Understood — the JSON path is additive and the table stays the default.\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\nRunning the checks now.`,
    streaming: false,
    thinking: false,
  },
  { kind: "tool", id: "tool-t3", toolCallId: "t3", toolName: "bash", args: { command: "npm test -- --grep json" }, result: "3 passing", running: false },
  {
    kind: "tool",
    id: "tool-t4",
    toolCallId: "t4",
    toolName: "bash",
    args: { command: "npm run typecheck" },
    result: "1 error: TS2345 in src/cli/print.ts:41",
    isError: true,
    running: false,
  },
  {
    kind: "notice",
    id: "n1",
    tone: "info",
    icon: "✦",
    text: "Context compacted (llm-summary) — older history was summarized into a checkpoint, so the model's view of this conversation changed.",
  },
  {
    kind: "tool",
    id: "tool-t5",
    toolCallId: "t5",
    toolName: "edit",
    args: { path: "src/cli/print.ts", oldText: "printResult(result)", newText: "printResult(result, { json })" },
    running: true,
  },
  {
    kind: "assistant",
    id: "a4",
    text: "Fixing the type error the typecheck surfaced — the call site was not updated",
    streaming: true,
    thinking: false,
  },
];


/** scene=replay: fold the captured frames of a real session through the real
 *  stream reducer, so ordering bugs show up here instead of in a live run. */
function replayConversation() {
  let state = store.getState();
  for (const env of REPLAY) {
    state = { ...state, ...reduceEnvelope(state, env as EventEnvelope) };
  }
  return state.conversation;
}

store.setState({
  sessions,
  activeSessionId: scene === "landing" ? null : "s1",
  connected: true,
  theme,
  conversation:
    scene === "session" || scene === "health" || scene === "audit" || scene === "changes"
      ? {
          timeline,
          guardDecisions: [
            {
              decisionId: "audit-1:forge.core", guardId: "forge.core",
              toolCallId: "audit-1", toolName: "read", capability: "read",
              policyAction: "allow", effectiveAction: "allow", outcome: "allowed",
              basis: "policy", approvalMode: "default", ruleId: "read-allow",
              reason: "forge-guard: allow by rule read-allow (read)",
              inputSummary: '{"path":"src/cli/args.ts"}', at: Date.now() - 18_000,
            },
            {
              decisionId: "audit-2:forge.core", guardId: "forge.core",
              toolCallId: "audit-2", toolName: "bash", capability: "network",
              policyAction: "ask", effectiveAction: "ask", outcome: "approved",
              basis: "user", approvalMode: "default", ruleId: "network-ask",
              reason: "forge-guard: ask by rule network-ask (bash)",
              inputSummary: '{"command":"curl https://example.com"}', at: Date.now() - 9_000,
            },
            {
              decisionId: "audit-3:forge.core", guardId: "forge.core",
              toolCallId: "audit-3", toolName: "bash", capability: "destructive",
              policyAction: "deny", effectiveAction: "deny", outcome: "denied",
              basis: "policy", approvalMode: "always", ruleId: "destructive-deny",
              reason: "forge-guard: deny by rule destructive-deny (bash)",
              inputSummary: '{"command":"sudo whoami"}', at: Date.now() - 3_000,
            },
          ],
          usage: { tokensIn: 4200, tokensOut: 900, contextTokens: 45000 },
          providerId: "prov_primary",
          approvalMode: "default",
          modelId: null,
          thinkingLevel: null,
          pluginStates: scene === "health"
            ? { "forge.workspace-changes": { status: "failed", failurePhase: "onAgentEvent", failureReason: "git status timed out after 4000ms" } }
            : {},
          pluginLifecycle: scene === "health"
            ? [
                { id: "p1", pluginId: "forge.usage", event: "loaded", status: "active", required: true, at: now - 21_000 },
                { id: "p2", pluginId: "forge.workspace-changes", event: "loaded", status: "active", required: false, at: now - 20_000 },
                { id: "p3", pluginId: "forge.workspace-changes", event: "failed", status: "failed", required: false, phase: "onAgentEvent", reason: "git status timed out after 4000ms", at: now - 4_000 },
              ]
            : [],
          workspaceChanges: {
            supported: true,
            repoRoot: "/Users/hcq/demo",
            phase: "current",
            files: [
              { path: "src/cli/args.ts", status: " M", additions: 5, deletions: 1, preexisting: false, changedDuringSession: true },
              { path: "src/cli/print.ts", status: " M", additions: 3, deletions: 2, preexisting: true, changedDuringSession: true },
              { path: "test/json.test.ts", status: "??", additions: null, deletions: null, preexisting: false, changedDuringSession: true },
            ],
          },
        }
      : scene === "replay"
        ? replayConversation()
        : scene === "thinking"
          ? {
              timeline: [
                { kind: "user", id: "u1", text: "Add a --json flag to the CLI and cover it with tests" },
                { kind: "assistant", id: "a1", text: "", streaming: true, thinking: true },
              ] as TimelineEntry[],
              guardDecisions: [],
              usage: { tokensIn: 300, tokensOut: 60, contextTokens: 12000 },
              providerId: "prov_primary",
          approvalMode: "default",
              modelId: null,
              thinkingLevel: null,
              pluginStates: {},
              pluginLifecycle: [],
              workspaceChanges: null,
            }
          : {
              timeline: [],
              guardDecisions: [],
              usage: { tokensIn: 0, tokensOut: 0, contextTokens: null },
              providerId: null,
              approvalMode: null,
              modelId: null,
              thinkingLevel: null,
              pluginStates: {},
              pluginLifecycle: [],
              workspaceChanges: null,
            },
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-root">
      <Sidebar onNewSession={() => {}} />
      <main className="app-main" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {children}
      </main>
      {scene === "settings" && <SettingsPage onClose={() => {}} />}
    </div>
  );
}

/**
 * scene=notify — end-to-end check of the task-outcome notification path.
 * Simulates "the window is hidden" (patched document.hidden), captures whatever
 * window.Notification would show, and drives it with a REAL SSE stream from the
 * sidecar — the same onmessage handler the app runs. Dev-only; not in the app
 * bundle.   ?scene=notify&token=<token>&session=<id>
 */
const notifyLog: Array<{ title: string; body: string }> = [];

if (scene === "notify") {
  Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
  class CapturingNotification {
    static permission = "granted";
    static requestPermission = () => Promise.resolve("granted");
    constructor(title: string, opts?: { body?: string }) {
      notifyLog.push({ title, body: opts?.body ?? "" });
    }
  }
  (window as unknown as { Notification: unknown }).Notification = CapturingNotification;

  const sid = params.get("session") ?? "";
  if (token && sid) {
    void (async () => {
      // Refresh first so the handler can resolve a goal for the session id.
      await store.getState().refreshSessions();
      store.getState().select(sid); // opens the real SSE stream
    })();
  }
}

function NotifyProbe() {
  const [snap, setSnap] = useState({ sessions: 0, entries: [] as typeof notifyLog });
  useEffect(() => {
    const t = setInterval(
      () => setSnap({ sessions: store.getState().sessions.length, entries: [...notifyLog] }),
      400,
    );
    return () => clearInterval(t);
  }, []);
  const style: React.CSSProperties = {
    position: "fixed",
    right: 14,
    bottom: 14,
    zIndex: 99,
    maxWidth: 460,
    padding: "10px 12px",
    borderRadius: 10,
    font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
    background: "#101418",
    color: "#d7e0ea",
    border: "1px solid #2b3644",
  };
  return (
    <div style={style}>
      <div style={{ color: "#7d8fa3" }}>
        notify probe · hidden={String(document.hidden)} · sessions={snap.sessions} · captured=
        {snap.entries.length}
      </div>
      {snap.entries.length === 0 ? (
        <div style={{ color: "#e0a03c" }}>no notification captured</div>
      ) : (
        snap.entries.map((e, i) => (
          <div key={i}>
            <b>{e.title}</b> — {e.body}
          </div>
        ))
      )}
    </div>
  );
}

const active = sessions[0]!;
const replay = scene === "replay";

/** scene=picker — the run-config popover, open, against sample subscriptions. */
const PREVIEW_PROVIDERS = [
  { id: "minimax-cn-anthropic", api: "anthropic-messages" as const, modelId: "MiniMax-M2.7", baseUrl: "https://api.minimaxi.com/anthropic", apiKey: "" },
  { id: "minimax-openai", api: "openai-completions" as const, modelId: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "" },
  { id: "anthropic", api: "anthropic-messages" as const, modelId: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com", apiKey: "" },
];

createRoot(document.getElementById("root")!).render(
  <>
    <Shell>
      {scene === "landing" || scene === "settings" ? (
        <Composer projectId="p1" />
      ) : (
        <SessionView
          sessionId={replay ? "session_1788997972145_z1cif" : active.id}
          goal={replay ? "你好" : active.goal}
          status={replay ? "completed" : active.status}
          failureReason={null}
          modelId={replay ? "MiniMax-M2.7" : active.model.modelId}
          providerId={replay ? "prov_primary" : active.model.provider}
          approvalMode={replay ? "default" : active.approvalMode}
          thinkingLevel={replay ? "off" : active.thinkingLevel}
        />
      )}
    </Shell>
    {scene === "notify" && <NotifyProbe />}
    {scene === "picker" && (
      // Anchored to the bottom like a real composer, and opening upward —
      // otherwise a three-group panel runs off the bottom of the viewport.
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "grid",
          placeItems: "end center",
          paddingBottom: 88,
          zIndex: 90,
        }}
      >
        <ModelPicker
          providers={PREVIEW_PROVIDERS}
          activeProviderId="minimax-cn-anthropic"
          onSelectModel={() => {}}
          approvalMode="default"
          onSelectApprovalMode={() => {}}
          thinkingLevel="medium"
          thinkingLevels={["off", "minimal", "low", "medium", "high"]}
          onSelectThinking={() => {}}
          placement="above"
          defaultOpen
        />
      </div>
    )}
    {scene === "reliability" && (
      <ReliabilityDialog
        loading={false}
        error={null}
        onClose={() => {}}
        metrics={{
          eventCount: 184,
          wallMs: 48_200,
          runs: { started: 2, endedByPi: 1, terminal: 2 },
          tools: { calls: 12, results: 12, errors: 1, guarded: 12, guardCoverage: 1, unfinished: 0, orphanResults: 0 },
          approvals: { requested: 2, resolved: 2, pending: 0, p95LatencyMs: 1840 },
          cancellation: { requested: 1, settled: 1, p95LatencyMs: 34 },
          recovery: { interrupted: 1, resumed: 1, messagesRecovered: 8 },
          plugins: { failures: 1 },
          integrity: { healthy: true, violations: [] },
        }}
      />
    )}
    {scene === "audit" && (
      <GuardAuditDialog
        decisions={store.getState().conversation.guardDecisions}
        onClose={() => {}}
      />
    )}
    {scene === "health" && (
      <CapabilityHealthDialog
        plugins={[
          { id: "forge.usage", name: "Usage meter", version: "1.0.0", capabilities: ["event-subscriber"], required: true, status: "active" },
          { id: "forge.capability-health", name: "Capability Health", version: "1.0.0", capabilities: ["ui"], required: true, status: "active" },
          { id: "forge.guard-audit", name: "Guard Audit", version: "1.0.0", capabilities: ["ui"], required: true, status: "active" },
          { id: "forge.reliability", name: "Harness Reliability", version: "1.0.0", capabilities: ["ui"], required: true, status: "active" },
          { id: "forge.workspace-changes", name: "Workspace Changes", version: "1.0.0", capabilities: ["event-subscriber", "ui"], required: false, status: "failed" },
        ]}
        states={store.getState().conversation.pluginStates}
        lifecycle={store.getState().conversation.pluginLifecycle}
        running
        busyPluginId={null}
        error={null}
        onToggle={() => {}}
        onClose={() => {}}
      />
    )}
    {scene === "changes" && store.getState().conversation.workspaceChanges && (
      <WorkspaceChangesDialog
        changes={store.getState().conversation.workspaceChanges!}
        onClose={() => {}}
        readDiff={async (path) => ({
          path,
          kind: "text",
          truncated: false,
          bytes: 286,
          patch: [
            `diff --git a/${path} b/${path}`,
            `--- a/${path}`,
            `+++ b/${path}`,
            "@@ -1,4 +1,8 @@",
            " export function parseArgs(argv: string[]) {",
            "+  const json = argv.includes(\"--json\");",
            "   return {",
            "-    verbose: argv.includes(\"--verbose\"),",
            "+    verbose: argv.includes(\"--verbose\"),",
            "+    json,",
            "   };",
            " }",
          ].join("\n"),
        })}
      />
    )}
  </>,
);
