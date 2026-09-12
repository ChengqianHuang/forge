import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { runAgent } from "../agent-runner.ts";
import { appendEvent } from "../core/persistence/event-log.ts";
import { replaySession } from "../core/persistence/replay.ts";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession as removeSession,
} from "../core/persistence/session-store.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { ProjectsRegistry } from "./projects.ts";
import { buildModel, makeStreamFnWithKey, providerEnv } from "./model-resolver.ts";
import { loadForgeConfig, resolveProvider } from "./config-store.ts";
import type { ProviderConfig } from "./config-store.ts";
import type {
  Session,
  SessionStatus,
  ApprovalMode,
  ThinkingLevel,
} from "../types.ts";

/**
 * Everything that exists only while one run of a session is live. The
 * SessionManager used to keep five parallel per-session maps (active / idle /
 * pendingModels / pendingThinking / completions); they are now fields on this
 * one object so a runtime can be registered and dropped as a unit — no map to
 * forget, no entry to leak.
 */
type SessionRuntime = {
  runPromise: Promise<Session>;
  controller: AbortController;
  steeringQueue: AgentMessage[];
  usage: import("../guardrails/usage-tracker.ts").UsageTracker;
  /**
   * The guardrails object handed to `runAgent` — kept live on the runtime so
   * `switchApprovalMode()` can mutate `guardrails.approvalMode` and the very
   * next tool call sees the new posture (no turn boundary, no relaunch).
   */
  guardrails: import("../guardrails/types.ts").GuardrailConfig;
  /**
   * Mid-session model switch: `switchModel()` parks a pre-built Model here;
   * the prepareNextTurn hook picks it up at the next turn boundary and hands
   * it to Pi's loop (AgentLoopTurnUpdate.model). Consumed at most once.
   */
  pendingModel: Model<any> | null;
  /**
   * Mid-session thinking-level switch: mirrors `pendingModel` — parked by
   * `switchThinking()`, returned by the prepareNextTurn hook as
   * `AgentLoopTurnUpdate.thinkingLevel` at the next turn boundary. Consumed
   * at most once.
   */
  pendingThinking: ThinkingLevel | null;
  /** Set by the user's Stop action; never reinterpret it as an agent failure. */
  stopRequested: boolean;
};

/**
 * Sessions in these terminal states can be resumed. `running` is forbidden
 * (would double-write the event log).
 *
 * `completed` follow-ups (2026-09-09, PM via real-use acceptance): a
 * finished session must accept a follow-up message and continue the loop —
 * chat-style continuation. `failed`/`cancelled` retry the goal.
 */
const RESUMABLE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "failed",
  "cancelled",
  "completed",
]);

export class SessionManager {
  /**
   * Live runtimes, keyed by sessionId. Exactly one entry per *running* run:
   * registered by `launchAgent`, removed on settle/failure. An idle session
   * has no runtime — its state is the persisted Session record. (The old
   * design also parked settled entries in an `idle` map that nothing ever
   * read — a leak; it is gone with this shape.)
   */
  private runtimes = new Map<string, SessionRuntime>();

  constructor(
    private readonly opts: {
      forgeHome: string;
      projects: ProjectsRegistry;
      approvalHub: ApprovalHub;
    },
  ) {}

  async create(input: {
    goal: string;
    projectId?: string | undefined;
    providerId?: string | undefined;
    thinkingLevel?: ThinkingLevel | undefined;
    approvalMode?: ApprovalMode | undefined;
  }): Promise<{ sessionId: string }> {
    // 1. Resolve the subscription (explicit providerId or the default one).
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription: ProviderConfig | null = resolveProvider(cfg, input.providerId);
    if (!subscription) {
      throw new Error(
        "no model subscription configured — add one in Settings or ~/.forge/forge-config.json",
      );
    }

    // 2. Resolve workspace from the project registry.
    const registry = await this.opts.projects.list();
    const project = input.projectId
      ? registry.projects.find((p) => p.id === input.projectId)
      : registry.projects.find((p) => p.id === registry.activeProjectId);
    const workspace = project?.path ?? this.opts.forgeHome;

    // 3. Session record.
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Pi's own default (coding-agent/core/defaults.ts). Only sent when the
    // model actually supports reasoning — see runAgent's gate.
    const thinkingLevel: ThinkingLevel = input.thinkingLevel ?? "medium";
    const session: Session = {
      id: sessionId,
      goal: input.goal,
      workspace,
      projectId: project?.id ?? null,
      model: { provider: subscription.id, modelId: subscription.modelId },
      messages: [],
      status: "running",
      failureReason: null,
      usage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, lastContextTokens: null },
      approvalMode: input.approvalMode ?? "default",
      thinkingLevel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveSession(session);
    await appendEvent(sessionId, "SESSION_CREATED", { goal: session.goal, workspace });

    // 4. Guardrails + launch (launchAgent registers the runtime).
    const usage = new (await import("../guardrails/usage-tracker.ts")).UsageTracker();
    await this.launchAgent(
      session,
      subscription,
      usage,
      session.approvalMode,
    );

    return { sessionId };
  }

  /**
   * Resume a failed or cancelled session from its event log. Replays the
   * last coherent AgentMessage[] (drops any unterminated message_started
   * pair), restores the UsageTracker's spent counter from persisted
   * `session.cost.total`, and re-launches the agent loop on the recovered
   * session.
   *
   * If `opts.message` is provided, it is appended to `session.messages` as a
   * user turn AND pushed onto the steering queue — Pi's agentLoop consumes
   * new messages from the messages array at the next turn boundary.
   *
   * Failure modes (caller maps to HTTP codes):
   *   - session not found        → throw "session {id} not found"
   *   - status not in whitelist  → throw "session {id} cannot be resumed (status=...)"
   *   - session already active   → throw "session {id} is already running"
   *   - subscription missing     → throw (same error as create())
   */
  async resume(
    sessionId: string,
    opts?: { message?: string | undefined },
  ): Promise<{ sessionId: string }> {
    // 1. Load session.
    const session = await loadSession(sessionId);
    if (!session) {
      throw new Error(`session ${sessionId} not found`);
    }

    // 2. Status whitelist. Remember the prior state: a `completed` resume is
    // a chat-style follow-up (prompt = the new message); `failed`/`cancelled`
    // is a retry (prompt = the goal).
    const priorStatus = session.status;
    if (!RESUMABLE_STATUSES.has(session.status)) {
      throw new Error(
        `session ${sessionId} cannot be resumed (status=${session.status}; only failed/cancelled/completed are resumable)`,
      );
    }

    // 3. Not already active.
    if (this.runtimes.has(sessionId)) {
      throw new Error(`session ${sessionId} is already running — cannot resume concurrently`);
    }

    // 4. Replay messages from event log.
    const { messages } = await replaySession(sessionId);
    session.messages = messages;

    // 5. Optional steering message: append as a user turn AND queue it for
    //    the next loop iteration. We do both so that:
    //    - if the loop reads from messages directly, the new turn is there;
    //    - if the loop drains the steering queue first, it's still there.
    //    Idempotency: appendEvent once, push steeringQueue once.
    if (opts?.message) {
      const userTurn: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: opts.message }],
        timestamp: Date.now(),
      } as AgentMessage;
      session.messages.push(userTurn);
      // steeringQueue is created fresh by launchAgent; we'll push after.
    }

    // 6. Update session state to running and persist.
    session.status = "running";
    session.failureReason = null;
    session.updatedAt = Date.now();
    await saveSession(session);

    // 7. Surface a resume marker so the UI can show "resumed from N messages,
    // optional steering". Per-message STARTED-without-ENDED entries are
    // dropped silently by `replaySession` — there's no repair event
    // because there's nothing for the UI to act on (the half-written
    // message is simply absent from the recovered transcript).
    await appendEvent(sessionId, "SESSION_RESUMED", {
      messagesRecovered: messages.length,
      hasSteeringMessage: !!opts?.message,
    }).catch(() => {});

    // 8. UsageTracker hydrates from persisted token counters.
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription: ProviderConfig | null = resolveProvider(cfg, session.model.provider);
    if (!subscription) {
      throw new Error(
        `no model subscription for provider "${session.model.provider}" — re-add it in Settings`,
      );
    }
    const usage = new (await import("../guardrails/usage-tracker.ts")).UsageTracker();
    usage.hydrate(session.usage);

    // 9. Launch (re-uses helper). Semantics by prior state:
    //   - failed/cancelled → retry: prompt = goal, message rides the
    //     steering queue as corrective guidance.
    //   - completed → follow-up: prompt = the message itself (the goal is
    //     already in the replayed history; re-sending it would re-run the
    //     finished task).
    const wasCompleted = priorStatus === "completed";
    await this.launchAgent(
      session,
      subscription,
      usage,
      session.approvalMode,
      wasCompleted ? opts?.message : undefined,
    );

    // 10. Push steering message now that the runtime exists (retry path
    // only — completed follow-ups ride as the prompt, see above).
    if (opts?.message && !wasCompleted) {
      this.runtimes.get(sessionId)?.steeringQueue.push({
        role: "user",
        content: [{ type: "text", text: opts.message }],
        timestamp: Date.now(),
      } as AgentMessage);
    }

    return { sessionId };
  }

  /**
   * Mid-session model switch. Running sessions: the new model takes effect
   * at the next turn boundary (the prepareNextTurn hook consumes it from
   * pendingModels and returns it as AgentLoopTurnUpdate.model). Idle
   * sessions: persisted on the Session, effective on the next resume.
   */
  async switchModel(
    sessionId: string,
    providerId: string,
  ): Promise<{ modelId: string }> {
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription = resolveProvider(cfg, providerId);
    if (!subscription) {
      throw new Error(`no model subscription for provider "${providerId}"`);
    }

    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.pendingModel = buildModel(subscription);
    } else {
      const session = await loadSession(sessionId);
      if (!session) throw new Error(`session ${sessionId} not found`);
      session.model = { provider: subscription.id, modelId: subscription.modelId };
      await saveSession(session);
    }

    await appendEvent(sessionId, "MODEL_CHANGED", {
      providerId: subscription.id,
      modelId: subscription.modelId,
    }).catch(() => {});
    return { modelId: subscription.modelId };
  }

    /**
   * Mid-session thinking-level switch — the reasoning effort sent with each
   * provider request (`"off"` sends none). Mirrors switchModel(): a running
   * session parks the level for the next turn boundary, where Pi's loop picks
   * it up as AgentLoopTurnUpdate.thinkingLevel; an idle one just persists it
   * for the next resume.
   *
   * The level is recorded even when the current model cannot reason — the
   * session may be switched to one that can. runAgent is what decides whether
   * to actually send it (a model with `reasoning: false` never does).
   */
  async switchThinking(
    sessionId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<{ thinkingLevel: ThinkingLevel }> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);

    session.thinkingLevel = thinkingLevel;
    session.updatedAt = Date.now();
    await saveSession(session);

    // The running loop holds its own session object — the persisted write
    // above does not reach it — so hand the level through the pending slot.
    const runtime = this.runtimes.get(sessionId);
    if (runtime) runtime.pendingThinking = thinkingLevel;

    await appendEvent(sessionId, "THINKING_CHANGED", { thinkingLevel }).catch(() => {});
    return { thinkingLevel };
  }

  /**
   * Mid-session approval-posture switch. Unlike thinking (which waits for a
   * turn boundary), the guardrails config shares the live `completion`
   * object with the loop — mutating it here takes effect at the very next
   * tool call. An already-pending dialog is NOT retroactively released; the
   * user still answers the one on screen.
   */
  async switchApprovalMode(
    sessionId: string,
    approvalMode: ApprovalMode,
  ): Promise<{ approvalMode: ApprovalMode }> {
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);

    session.approvalMode = approvalMode;
    session.updatedAt = Date.now();
    await saveSession(session);

    const runtime = this.runtimes.get(sessionId);
    if (runtime) runtime.guardrails.approvalMode = approvalMode;

    await appendEvent(sessionId, "APPROVAL_MODE_CHANGED", { approvalMode }).catch(() => {});
    return { approvalMode };
  }

  /**
   * Launch the agent loop on a (possibly recovered) session. Shared by
   * `create()` and `resume()`. Builds and registers the SessionRuntime —
   * callers no longer wire any maps themselves.
   *
   * `promptOverride`: when a completed session is continued with a
   * follow-up message, that message — not the original goal — is the new
   * turn's prompt (the goal already lives in the replayed history; re-sending
   * it would make the model re-run the finished task).
   */
  private async launchAgent(
    session: Session,
    subscription: ProviderConfig,
    usage: import("../guardrails/usage-tracker.ts").UsageTracker,
    approvalMode: ApprovalMode,
    promptOverride?: string | undefined,
  ): Promise<SessionRuntime> {
    const sessionId = session.id;
    // steeringQueue and guardrails are created BEFORE the runtime: the
    // guardrails object is stored ON the runtime, so switchApprovalMode can
    // mutate `runtime.guardrails.approvalMode` and the next tool call sees
    // the new posture without a relaunch.
    const steeringQueue: AgentMessage[] = [];
    const guardrails: import("../guardrails/types.ts").GuardrailConfig = {
      sessionId,
      workspace: session.workspace,
      undoRoot: join(this.opts.forgeHome, "undo", sessionId),
      session,
      approvalMode,
      approval: this.opts.approvalHub,
      steeringQueue,
      usage,
    };
    const runtime: SessionRuntime = {
      runPromise: Promise.resolve(session),
      controller: new AbortController(),
      steeringQueue,
      guardrails,
      usage,
      pendingModel: null,
      pendingThinking: null,
      stopRequested: false,
    };
    // Register before the loop starts so steer/abort/switch* calls that race
    // with the first turn find the runtime. settle()/the catch handler remove
    // it — exactly one removal per registration, no leak.
    this.runtimes.set(sessionId, runtime);

    const runPromise = runAgent({
      session,
      model: buildModel(subscription),
      streamFn: makeStreamFnWithKey(subscription.apiKey, providerEnv(subscription)),
      guardrails,
      signal: runtime.controller.signal,
      promptOverride,
      takeModelSwitch: () => {
        const pending = runtime.pendingModel;
        runtime.pendingModel = null;
        return pending;
      },
      // Starts from the session's persisted level; a mid-run switch arrives
      // through takeThinkingSwitch instead.
      thinkingLevel: session.thinkingLevel,
      takeThinkingSwitch: () => {
        const pending = runtime.pendingThinking;
        runtime.pendingThinking = null;
        return pending;
      },
    })
      .then(async (final) => {
        await this.settle(sessionId, final);
        return final;
      })
      .catch(async (err) => {
        const stopped = runtime.stopRequested;
        session.status = stopped ? "cancelled" : "failed";
        session.failureReason = stopped ? null : err instanceof Error ? err.message : String(err);
        session.updatedAt = Date.now();
        await saveSession(session);
        await appendEvent(sessionId, stopped ? "SESSION_CANCELLED" : "SESSION_FAILED", {
          ...(stopped ? { reason: "stopped by user" } : { reason: session.failureReason }),
        }).catch(() => {});
        this.runtimes.delete(sessionId);
        throw err;
      });

    runtime.runPromise = runPromise;
    void runPromise.catch(() => {});
    return runtime;
  }

  async steer(sessionId: string, message: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return { ok: false, message: "session is not running" };
    runtime.steeringQueue.push({
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    } as AgentMessage);
    await appendEvent(sessionId, "STEERING_QUEUED", { message }).catch(() => {});
    return { ok: true, message: "queued" };
  }

  async abort(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return { ok: false, message: "session is not running" };
    runtime.stopRequested = true;
    runtime.controller.abort();
    return { ok: true, message: "aborting" };
  }

  async get(sessionId: string): Promise<Session | null> {
    return loadSession(sessionId);
  }

  async list(): Promise<Session[]> {
    return listSessions();
  }

  async delete(sessionId: string): Promise<{ ok: boolean; message: string }> {
    if (this.runtimes.has(sessionId)) {
      return { ok: false, message: "session is running — abort it first" };
    }
    await removeSession(sessionId);
    // Event log and undo journal are retained deliberately: audit trail.
    return { ok: true, message: "deleted" };
  }

  listApprovals(sessionId: string) {
    return this.opts.approvalHub.listPending(sessionId);
  }

  async approve(sessionId: string, requestId: string): Promise<{ ok: boolean }> {
    return { ok: this.opts.approvalHub.mark(requestId, "approved") };
  }

  async deny(sessionId: string, requestId: string): Promise<{ ok: boolean }> {
    return { ok: this.opts.approvalHub.mark(requestId, "denied") };
  }

  private async settle(sessionId: string, final: Session): Promise<void> {
    // The runtime dies with the run: one removal drops the controller,
    // steering queue, cost guard, live completion config and any pending
    // switch that never got consumed at a turn boundary. (The old shape kept
    // settled entries in an `idle` map that nothing ever read — a leak; gone.)
    const runtime = this.runtimes.get(sessionId);
    this.runtimes.delete(sessionId);
    const status: SessionStatus = runtime?.stopRequested
      ? "cancelled"
      : final.failureReason ? "failed" : "completed";
    final.status = status;
    if (status === "cancelled") final.failureReason = null;
    if (runtime) final.usage = runtime.usage.snapshot();
    final.updatedAt = Date.now();
    await saveSession(final);
    await appendEvent(sessionId, status === "failed" ? "SESSION_FAILED" : status === "cancelled" ? "SESSION_CANCELLED" : "SESSION_ENDED", {
      status,
    });
  }
}
