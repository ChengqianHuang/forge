import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Inactivity watchdog: a run whose agent produces no persisted event for
 * this long is considered hung (a provider call that never returns pins the
 * session in "running" forever otherwise — observed in real-bench). Any
 * activity (delta, tool call, message end) refreshes the clock, so long
 * legitimate turns are never killed.
 */
/** Read lazily so tests/smokes can inject a short timeout via env. */
function idleTimeoutMs(): number {
  return Number(process.env.FORGE_IDLE_TIMEOUT_MS ?? 5 * 60_000);
}
function watchdogIntervalMs(): number {
  return Math.min(30_000, Math.max(250, Math.floor(idleTimeoutMs() / 4)));
}
function cancelGraceMs(): number {
  return Number(process.env.FORGE_CANCEL_GRACE_MS ?? 3_000);
}
/**
 * Grace between the watchdog's abort and the forced settlement of a runner
 * that does not honour the signal. Stop is bounded by `cancelGraceMs`; the
 * watchdog needs its own bound or a hung runner has no settlement path at all
 * (the watchdog — its only observer — clears itself right after aborting).
 */
function timeoutGraceMs(): number {
  return Number(process.env.FORGE_TIMEOUT_GRACE_MS ?? 5_000);
}
function shutdownGraceMs(): number {
  return Number(process.env.FORGE_SHUTDOWN_GRACE_MS ?? 5_000);
}
function teardownGraceMs(): number {
  return Number(process.env.FORGE_TEARDOWN_GRACE_MS ?? 6_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgent } from "../agent-runner.ts";
import { appendEvent, readEvents } from "../core/persistence/event-log.ts";
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
import { UsageTracker } from "../guardrails/usage-tracker.ts";
import type { GuardrailConfig } from "../guardrails/types.ts";
import type { PluginHost, PluginRegistry } from "../plugins/registry.ts";
import type { PluginCapabilitySnapshot, PluginCatalogEntry, PluginInteractionFrame } from "../plugins/types.ts";
import { projectPluginCapabilities, userDisabledPluginIds } from "../plugins/state.ts";
import { resolvePluginConfig, validateConfigInput } from "../plugins/config-schema.ts";
import { loadPluginPreferences, savePluginPreferences } from "./plugin-preferences.ts";
import { createBuiltinPluginRegistry } from "../plugins/builtins/index.ts";
import {
  externalPluginsDir,
  PluginInstallCoordinator,
  installPluginFiles,
  cleanupStaging,
  type PluginInspection,
  type PluginSourceInfo,
} from "./plugin-install.ts";
import { readdir, unlink } from "node:fs/promises";

/**
 * Everything that exists only while one run of a session is live. Keeping it
 * on one object lets a runtime be registered and dropped as a unit.
 */
type SessionRuntime = {
  runPromise: Promise<Session>;
  controller: AbortController;
  /** The one live mutable Session object; terminal persistence uses this object. */
  session: Session;
  /** Watchdog: last agent activity (any persisted event), refreshed by runAgent. */
  lastActivityAt: number;
  /** Fired when the inactivity watchdog trips; cleared on settle. */
  watchdog?: ReturnType<typeof setInterval> | undefined;
  /** True when the watchdog (not the user) aborted the run. */
  timedOut?: boolean;
  steeringQueue: AgentMessage[];
  usage: UsageTracker;
  plugins: PluginHost;
  /**
   * The guardrails object handed to `runAgent` — kept live on the runtime so
   * `switchApprovalMode()` can mutate `guardrails.approvalMode` and the very
   * next tool call sees the new posture (no turn boundary, no relaunch).
   */
  guardrails: GuardrailConfig;
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
  /** Closed synchronously when finalization begins; all late loop/plugin
   * output is discarded after this point. */
  acceptEvents: boolean;
  closeEventGate: () => void;
  /** The one terminal commit for this run. All completion paths share it. */
  finalizePromise: Promise<void> | null;
  cancelTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Bounded fallback after the watchdog abort, for a runner that ignores it. */
  timeoutTimer?: ReturnType<typeof setTimeout> | undefined;
};

type RunOutcome =
  | { kind: "result"; final: Session }
  | { kind: "error"; error: unknown }
  | { kind: "cancelled" }
  /**
   * The inactivity watchdog fired and the runner still had not settled after
   * `timeoutGraceMs()`. Distinct from "cancelled" on purpose: the user did not
   * stop this run, and `stopped` must stay false so the terminal status is
   * `failed` with the idle-timeout reason rather than a user cancellation.
   */
  | { kind: "timeout" };

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
  private readonly plugins: PluginRegistry;
  private readonly pluginInstaller = new PluginInstallCoordinator();
  private readonly externalPluginIds: Set<string>;
  /** pluginId → file name inside <forgeHome>/plugins, for uninstall. */
  private readonly externalFiles = new Map<string, string>();
  private readonly pluginLoadErrors: ReadonlyArray<{ source: string; reason: string }>;

  constructor(
    private readonly opts: {
      forgeHome: string;
      projects: ProjectsRegistry;
      approvalHub: ApprovalHub;
      plugins?: PluginRegistry;
      /** Ids registered from `<forgeHome>/plugins` — marked "external" in the manager catalog. */
      externalPluginIds?: ReadonlySet<string>;
      /** pluginId → file name inside <forgeHome>/plugins, so uninstall can remove the file. */
      externalFiles?: ReadonlyArray<{ id: string; fileName: string }>;
      /** Per-file failures from the external plugin directory, surfaced verbatim. */
      pluginLoadErrors?: ReadonlyArray<{ source: string; reason: string }>;
      /** Test seam for lifecycle behavior; production uses the real Pi loop. */
      agentRunner?: typeof runAgent;
    },
  ) {
    this.plugins = opts.plugins ?? createBuiltinPluginRegistry();
    this.externalPluginIds = new Set(opts.externalPluginIds ?? []);
    for (const { id, fileName } of opts.externalFiles ?? []) this.externalFiles.set(id, fileName);
    this.pluginLoadErrors = opts.pluginLoadErrors ?? [];
  }

  /** Repair sessions left in `running` by a previous process. The failed
   * state intentionally reuses the existing Resume path and UI. */
  async reconcileInterruptedSessions(): Promise<number> {
    let repaired = 0;
    for (const session of await listSessions()) {
      if (session.status !== "running" || this.runtimes.has(session.id)) continue;
      await this.markInterrupted(session);
      repaired += 1;
    }
    return repaired;
  }

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

    // 4. Guardrails + plugins + launch (launchAgent registers the runtime).
    await this.launchAgent(session, subscription, session.approvalMode);

    return { sessionId };
  }

  /**
   * Resume a failed or cancelled session from its event log. Replays the
   * last coherent AgentMessage[] (drops any unterminated message_started
   * pair), restores the UsageTracker's spent counter from persisted
   * `session.usage`, and re-launches the agent loop on the recovered session.
   *
   * If `opts.message` is provided, it has exactly one owner: completed-session
   * follow-ups become the new run prompt; failed/cancelled-session guidance
   * starts in the steering queue before the loop begins. It is never also
   * inserted into recovered history, because `agentLoop` persists new prompts
   * and steering messages in its result.
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

    // 2. A live runtime always wins over persisted state. A persisted
    // `running` record without one is an orphan from a previous process and
    // is repaired into the ordinary failed/resumable path.
    if (this.runtimes.has(sessionId)) {
      throw new Error(`session ${sessionId} is already running — cannot resume concurrently`);
    }
    if (session.status === "running") await this.markInterrupted(session);

    // 3. Status whitelist. Remember the prior state: a `completed` resume is
    // a chat-style follow-up (prompt = the new message); `failed`/`cancelled`
    // is a retry (prompt = the goal).
    const priorStatus = session.status;
    if (!RESUMABLE_STATUSES.has(session.status)) {
      throw new Error(
        `session ${sessionId} cannot be resumed (status=${session.status}; only failed/cancelled/completed are resumable)`,
      );
    }

    // 4. Replay messages from event log.
    const { messages } = await replaySession(sessionId);
    session.messages = messages;

    // 5. Prepare optional retry guidance without mutating recovered history.
    //    Pi owns admission of new input and returns each admitted message once.
    const retryGuidance: AgentMessage | undefined = opts?.message
      ? {
          role: "user",
          content: [{ type: "text", text: opts.message }],
          timestamp: Date.now(),
        } as AgentMessage
      : undefined;

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

    // 8. Resolve the subscription. Usage hydration is owned by the Usage plugin.
    const cfg = await loadForgeConfig(this.opts.forgeHome);
    const subscription: ProviderConfig | null = resolveProvider(cfg, session.model.provider);
    if (!subscription) {
      throw new Error(
        `no model subscription for provider "${session.model.provider}" — re-add it in Settings`,
      );
    }

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
      session.approvalMode,
      wasCompleted ? opts?.message : undefined,
      wasCompleted ? undefined : retryGuidance,
    );

    return { sessionId };
  }

  /**
   * Mid-session model switch. Running sessions: the new model takes effect
   * at the next turn boundary (the prepareNextTurn hook consumes it from
   * pendingModel and returns it as AgentLoopTurnUpdate.model). Idle
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
      runtime.session.model = { provider: subscription.id, modelId: subscription.modelId };
      runtime.session.updatedAt = Date.now();
      await saveSession(runtime.session);
    } else {
      const session = await loadSession(sessionId);
      if (!session) throw new Error(`session ${sessionId} not found`);
      session.model = { provider: subscription.id, modelId: subscription.modelId };
      session.updatedAt = Date.now();
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
    const runtime = this.runtimes.get(sessionId);
    const session = runtime?.session ?? await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    session.thinkingLevel = thinkingLevel;
    session.updatedAt = Date.now();
    await saveSession(session);

    // The pending slot changes Pi at the next turn boundary; mutating the
    // runtime-owned Session ensures terminal persistence cannot restore the
    // previous level over the user's choice.
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
    const runtime = this.runtimes.get(sessionId);
    const session = runtime?.session ?? await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    session.approvalMode = approvalMode;
    session.updatedAt = Date.now();
    await saveSession(session);

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
    approvalMode: ApprovalMode,
    promptOverride?: string | undefined,
    initialSteering?: AgentMessage | undefined,
  ): Promise<SessionRuntime> {
    const sessionId = session.id;
    // steeringQueue and guardrails are created BEFORE the runtime: the
    // guardrails object is stored ON the runtime, so switchApprovalMode can
    // mutate `runtime.guardrails.approvalMode` and the next tool call sees
    // the new posture without a relaunch.
    // Seed retry guidance before runAgent starts. Pushing it after launch
    // races Pi's initial getSteeringMessages() drain and can delay the
    // correction until after an unwanted model turn.
    const steeringQueue: AgentMessage[] = initialSteering ? [initialSteering] : [];
    const controller = new AbortController();
    let compactionRequested = false;
    let acceptEvents = true;
    const emitEvent = (type: Parameters<typeof appendEvent>[1], payload: Record<string, unknown>) =>
      acceptEvents
        ? appendEvent(sessionId, type, payload)
        : Promise.resolve(undefined);
    const disabledPluginIds = userDisabledPluginIds(await readEvents(sessionId));
    const prefs = await loadPluginPreferences(this.opts.forgeHome);
    for (const id of prefs.disabled) disabledPluginIds.add(id);
    const plugins = await this.plugins.activate({
      session,
      signal: controller.signal,
      emitEvent: (type, payload) => emitEvent(type as Parameters<typeof appendEvent>[1], payload),
      enqueueSteering: (message) => steeringQueue.push(message),
      requestCompaction: () => { compactionRequested = true; },
    }, { disabledPluginIds, config: prefs.config });
    // A missing/failed Usage plugin degrades to an inert tracker. The loop,
    // compaction's per-turn signal and all safety hooks continue to work.
    const usage = plugins.service<UsageTracker>("usage") ?? new UsageTracker();
    const guardrails: GuardrailConfig = {
      sessionId,
      workspace: session.workspace,
      undoRoot: join(this.opts.forgeHome, "undo", sessionId),
      session,
      approvalMode,
      approval: this.opts.approvalHub,
      steeringQueue,
      usage,
      emitEvent,
    };
    const runtime: SessionRuntime = {
      runPromise: Promise.resolve(session),
      controller,
      session,
      lastActivityAt: Date.now(),
      steeringQueue,
      guardrails,
      usage,
      plugins,
      pendingModel: null,
      pendingThinking: null,
      stopRequested: false,
      acceptEvents: true,
      closeEventGate: () => { acceptEvents = false; },
      finalizePromise: null,
    };
    // Register before the loop starts so steer/abort/switch* calls that race
    // with the first turn find the runtime. settle()/the catch handler remove
    // it — exactly one removal per registration, no leak.
    this.runtimes.set(sessionId, runtime);

    // Inactivity watchdog: a hung provider call produces no events, so the
    // clock runs out and we abort the run; the loop's own catch handler then
    // records it as a timeout failure (with a resume hint), not a user
    // cancellation.
    runtime.watchdog = setInterval(() => {
      if (!runtime.stopRequested && !runtime.finalizePromise && Date.now() - runtime.lastActivityAt > idleTimeoutMs()) {
        runtime.timedOut = true;
        runtime.controller.abort();
        this.clearWatchdog(runtime);
        // Aborting is a request, not a guarantee. Stop is bounded by
        // cancelGraceMs for exactly this reason; without the same bound here a
        // runner that ignores the abort leaves the session `running` forever —
        // the watchdog was its only observer and has just cleared itself. The
        // forced settlement deliberately does NOT route through requestStop:
        // that would set stopRequested and record "cancelled", misattributing
        // a run the user never stopped.
        runtime.timeoutTimer = setTimeout(() => {
          void this.finalizeRun(sessionId, runtime, { kind: "timeout" }).catch(() => {});
        }, timeoutGraceMs());
        runtime.timeoutTimer.unref?.();
      }
    }, watchdogIntervalMs());
    // Never keep the process alive for the watchdog alone.
    runtime.watchdog.unref();

    const runner = this.opts.agentRunner ?? runAgent;
    const runPromise = runner({
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
      takeCompactionRequest: () => {
        const requested = compactionRequested;
        compactionRequested = false;
        return requested;
      },
      plugins,
      emitEvent,
      onActivity: () => {
        runtime.lastActivityAt = Date.now();
      },
    })
      .then(async (final) => {
        await this.finalizeRun(sessionId, runtime, { kind: "result", final });
        return final;
      })
      .catch(async (err) => {
        await this.finalizeRun(sessionId, runtime, { kind: "error", error: err });
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

  /** Execute a registered slash command without sending it to the model. */
  async command(sessionId: string, commandLine: string): Promise<{ ok: boolean; message: string }> {
    const live = this.runtimes.get(sessionId);
    if (live) {
      const result = await live.plugins.execute(commandLine);
      return { ok: true, message: result.message };
    }
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    const controller = new AbortController();
    const disabledPluginIds = userDisabledPluginIds(await readEvents(sessionId));
    const prefs = await loadPluginPreferences(this.opts.forgeHome);
    for (const id of prefs.disabled) disabledPluginIds.add(id);
    const host = await this.plugins.activate(
      {
        session,
        signal: controller.signal,
        emitEvent: (type, payload) => appendEvent(
          sessionId,
          type as Parameters<typeof appendEvent>[1],
          payload,
        ),
        enqueueSteering: () => {},
        requestCompaction: () => { throw new Error("/compact requires a running session"); },
      },
      { capabilities: new Set(["slash-command"]), disabledPluginIds, config: prefs.config },
    );
    try {
      const result = await host.execute(commandLine);
      return { ok: true, message: result.message };
    } finally {
      await host.dispose();
    }
  }

  async setPluginEnabled(sessionId: string, pluginId: string, enabled: boolean): Promise<{ ok: boolean }> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error("session is not running");
    await runtime.plugins.setEnabled(pluginId, enabled);
    return { ok: true };
  }

  /** Registration-time catalog for the global plugin manager page, plus the
   * per-file failures of the external plugin directory. */
  async pluginCatalog(): Promise<{
    plugins: PluginCatalogEntry[];
    errors: Array<{ source: string; reason: string }>;
  }> {
    const prefs = await loadPluginPreferences(this.opts.forgeHome);
    const plugins = this.plugins.capabilities().plugins.map((plugin) => {
      const { status: _status, failurePhase: _phase, failureReason: _reason, ...manifest } = plugin;
      return {
        ...manifest,
        source: this.externalPluginIds.has(plugin.id) ? ("external" as const) : ("builtin" as const),
        userDisabled: prefs.disabled.includes(plugin.id),
        config: resolvePluginConfig(plugin.configSchema, prefs.config[plugin.id]),
      };
    });
    return { plugins, errors: [...this.pluginLoadErrors] };
  }

  /** Global enablement preference, applied when a session next activates
   * its plugins. Required plugins are session substrate and cannot be paused. */
  async setGlobalPluginEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean }> {
    const plugin = this.plugins.capabilities().plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
    if (!enabled && plugin.required) {
      throw new Error(`plugin ${pluginId} is required and cannot be disabled`);
    }
    const prefs = await loadPluginPreferences(this.opts.forgeHome);
    const disabled = new Set(prefs.disabled);
    if (enabled) disabled.delete(pluginId);
    else disabled.add(pluginId);
    await savePluginPreferences(this.opts.forgeHome, { ...prefs, disabled: [...disabled] });
    return { ok: true };
  }

  /** Persist user config for a plugin after schema validation; returns the
   * resolved values (defaults merged) so the UI can show what will apply. */
  async setGlobalPluginConfig(
    pluginId: string,
    input: unknown,
  ): Promise<{ config: Record<string, unknown> }> {
    const plugin = this.plugins.capabilities().plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
    const validated = validateConfigInput(plugin.configSchema, input);
    if (!validated.ok) throw new Error(validated.error);
    const prefs = await loadPluginPreferences(this.opts.forgeHome);
    await savePluginPreferences(this.opts.forgeHome, {
      ...prefs,
      config: { ...prefs.config, [pluginId]: validated.config },
    });
    return { config: resolvePluginConfig(plugin.configSchema, validated.config) };
  }

  /** Execute and validate a trusted source, retaining its exact staged bytes
   * behind a short-lived one-shot ticket. */
  async inspectExternalPlugin(source: string): Promise<PluginInspection> {
    if (!source || typeof source !== "string") throw new Error("source is required");
    return this.pluginInstaller.inspect(source);
  }

  /** Consume an inspection ticket, copy those exact bytes into forge home and
   * register them live. The source is never fetched or read a second time. */
  async installExternalPlugin(inspectionId: string): Promise<{
    plugins: PluginSourceInfo[];
    errors: Array<{ source: string; reason: string }>;
  }> {
    if (!inspectionId || typeof inspectionId !== "string") throw new Error("inspectionId is required");
    // Reject file-name collisions up front: an install must never overwrite a
    // plugin file the user (or another install) already put in place.
    const existing = new Set(await readdir(externalPluginsDir(this.opts.forgeHome)).catch(() => []));
    const inspected = this.pluginInstaller.take(inspectionId);
    try {
      for (const plugin of inspected.plugins) {
        if (existing.has(plugin.fileName)) {
          throw new Error(`a file named ${plugin.fileName} already exists in ${externalPluginsDir(this.opts.forgeHome)}`);
        }
      }
      await installPluginFiles(this.opts.forgeHome, inspected.stagingDir, inspected.plugins);
    } finally {
      await cleanupStaging(inspected.stagingDir);
    }
    for (const info of inspected.plugins) {
      // Re-import from its installed home: the registry holds the object whose
      // provenance matches the file on disk, and register() re-checks ids.
      try {
        const mod = await import(pathToFileURL(join(externalPluginsDir(this.opts.forgeHome), info.fileName)).href);
        const plugin = mod.default ?? mod.plugin;
        this.plugins.register(plugin);
        this.externalPluginIds.add(info.id);
        this.externalFiles.set(info.id, info.fileName);
      } catch (err) {
        inspected.errors.push({
          source: info.fileName,
          reason: `installed, but live registration failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return { plugins: inspected.plugins, errors: inspected.errors };
  }

  /** Remove an external plugin: delete its file and drop it from the live
   * registry. Running sessions keep their activated instance until disposal. */
  async uninstallPlugin(pluginId: string): Promise<{ ok: boolean }> {
    const fileName = this.externalFiles.get(pluginId);
    if (!fileName) throw new Error(`plugin is not external (or not installed): ${pluginId}`);
    await unlink(join(externalPluginsDir(this.opts.forgeHome), fileName));
    try {
      await this.plugins.unregister(pluginId);
    } finally {
      this.externalPluginIds.delete(pluginId);
      this.externalFiles.delete(pluginId);
    }
    return { ok: true };
  }

  async pluginCapabilities(sessionId: string): Promise<PluginCapabilitySnapshot> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) return runtime.plugins.capabilities();
    const session = await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    return projectPluginCapabilities(this.plugins.capabilities(), await readEvents(sessionId));
  }

  /** Dispatch a stateless, user-initiated read through the owning capability.
   * Disposed is allowed: read actions intentionally outlive run resources. */
  async readCapability(
    sessionId: string,
    pluginId: string,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    return this.plugins.read(pluginId, actionId, input, await this.capabilityContext(sessionId, pluginId, controller.signal));
  }

  /** Dispatch a stateful user request without teaching SessionManager the
   * product capability's semantics. */
  async interactCapability(
    sessionId: string,
    pluginId: string,
    actionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.plugins.interact(
      pluginId,
      actionId,
      input,
      await this.capabilityContext(sessionId, pluginId, signal),
    );
  }

  /** Subscribe to a stateful capability stream. The caller owns the returned
   * unsubscriber and abort signal; the plugin owns the underlying resource. */
  async subscribeCapability(
    sessionId: string,
    pluginId: string,
    actionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    emit: (frame: PluginInteractionFrame) => void,
  ): Promise<() => void> {
    return this.plugins.subscribe(
      pluginId,
      actionId,
      input,
      await this.capabilityContext(sessionId, pluginId, signal),
      emit,
    );
  }

  private async capabilityContext(sessionId: string, pluginId: string, signal: AbortSignal) {
    const session = this.runtimes.get(sessionId)?.session ?? await loadSession(sessionId);
    if (!session) throw new Error(`session ${sessionId} not found`);
    const snapshot = await this.pluginCapabilities(sessionId);
    const plugin = snapshot.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
    if (plugin.status === "disabled" || plugin.status === "failed") {
      throw new Error(`plugin ${pluginId} is ${plugin.status} for this session`);
    }
    const prefs = await loadPluginPreferences(this.opts.forgeHome);
    return {
      session,
      signal,
      config: resolvePluginConfig(plugin.configSchema, prefs.config[pluginId]),
    };
  }

  async abort(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return { ok: false, message: "session is not running" };
    this.requestStop(sessionId, runtime, "user");
    return { ok: true, message: "aborting" };
  }

  /** Stop live runs and dispose session-scoped plugins during server shutdown. */
  async shutdown(): Promise<void> {
    await this.pluginInstaller.dispose();
    const runtimes = [...this.runtimes.values()];
    for (const runtime of runtimes) {
      this.requestStop(runtime.session.id, runtime, "server-shutdown");
    }
    await Promise.race([
      Promise.allSettled(runtimes.map((runtime) => runtime.runPromise)).then(() => {}),
      delay(shutdownGraceMs()),
    ]);
    await Promise.allSettled(runtimes.map((runtime) =>
      this.finalizeRun(runtime.session.id, runtime, { kind: "cancelled" }),
    ));
    await this.plugins.dispose();
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
    await this.plugins.disposeSession(sessionId);
    await removeSession(sessionId);
    // Event log and undo journal are retained deliberately: audit trail.
    return { ok: true, message: "deleted" };
  }

  listApprovals(sessionId: string) {
    return this.opts.approvalHub.listPending(sessionId);
  }

  async approve(sessionId: string, requestId: string): Promise<{ ok: boolean }> {
    return { ok: this.opts.approvalHub.markForSession(sessionId, requestId, "approved") };
  }

  async deny(sessionId: string, requestId: string): Promise<{ ok: boolean }> {
    return { ok: this.opts.approvalHub.markForSession(sessionId, requestId, "denied") };
  }

  private clearWatchdog(runtime: SessionRuntime): void {
    if (runtime.watchdog) {
      clearInterval(runtime.watchdog);
      runtime.watchdog = undefined;
    }
  }

  private requestStop(
    sessionId: string,
    runtime: SessionRuntime,
    reason: "user" | "server-shutdown",
  ): void {
    if (runtime.stopRequested || runtime.finalizePromise) return;
    runtime.stopRequested = true;
    void appendEvent(sessionId, "SESSION_STOP_REQUESTED", { reason }).catch(() => {});
    runtime.controller.abort();
    this.opts.approvalHub.cancelSession(sessionId);
    runtime.cancelTimer = setTimeout(() => {
      void this.finalizeRun(sessionId, runtime, { kind: "cancelled" }).catch(() => {});
    }, cancelGraceMs());
    runtime.cancelTimer.unref?.();
  }

  private finalizeRun(
    sessionId: string,
    runtime: SessionRuntime,
    outcome: RunOutcome,
  ): Promise<void> {
    if (runtime.finalizePromise) return runtime.finalizePromise;
    runtime.acceptEvents = false;
    runtime.closeEventGate();
    this.clearWatchdog(runtime);
    if (runtime.cancelTimer) {
      clearTimeout(runtime.cancelTimer);
      runtime.cancelTimer = undefined;
    }
    if (runtime.timeoutTimer) {
      clearTimeout(runtime.timeoutTimer);
      runtime.timeoutTimer = undefined;
    }
    if (this.runtimes.get(sessionId) === runtime) this.runtimes.delete(sessionId);
    this.opts.approvalHub.cancelSession(sessionId);

    runtime.finalizePromise = (async () => {
      // Plugin disposal is best-effort and bounded as a whole. Individual
      // plugins already have their own timeout, but N sequential timeouts
      // must not hold server shutdown open for N×timeout.
      await Promise.race([
        runtime.plugins.dispose().catch(() => {}),
        delay(teardownGraceMs()),
      ]);

      const final = outcome.kind === "result" ? outcome.final : runtime.session;
      if (final !== runtime.session) {
        runtime.session.messages = final.messages;
        runtime.session.failureReason = final.failureReason;
      }
      const target = runtime.session;
      const stopped = runtime.stopRequested || outcome.kind === "cancelled";
      const errorReason = outcome.kind === "error"
        ? outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        : null;
      const timeoutReason = runtime.timedOut
        ? `idle timeout after ${Math.round(idleTimeoutMs() / 60_000 * 10) / 10}min with no agent activity — the provider call likely hung; resume to retry`
        : null;
      const status: SessionStatus = stopped
        ? "cancelled"
        : timeoutReason || errorReason || target.failureReason ? "failed" : "completed";
      target.status = status;
      target.failureReason = status === "cancelled"
        ? null
        : timeoutReason ?? errorReason ?? target.failureReason;
      target.usage = runtime.usage.snapshot();
      target.updatedAt = Date.now();
      await saveSession(target);
      const terminalType = status === "failed"
        ? "SESSION_FAILED"
        : status === "cancelled" ? "SESSION_CANCELLED" : "SESSION_ENDED";
      await appendEvent(sessionId, terminalType, {
        status,
        ...(status === "failed" ? { reason: target.failureReason } : {}),
        ...(status === "cancelled" ? { reason: "stopped by user" } : {}),
      });
    })();
    return runtime.finalizePromise;
  }

  private async markInterrupted(session: Session): Promise<void> {
    const reason = "Forge restarted before this run reached a terminal state — resume to continue";
    session.status = "failed";
    session.failureReason = reason;
    session.updatedAt = Date.now();
    await saveSession(session);
    await appendEvent(session.id, "SESSION_INTERRUPTED", { reason });
    await appendEvent(session.id, "SESSION_FAILED", {
      status: "failed",
      reason,
      interrupted: true,
    });
  }
}
