import { createServer, type IncomingMessage, type Server } from "node:http";
import { EVENT_PROTOCOL_VERSION, TaskEventStream } from "./event-stream.ts";
import { eventsDir } from "../core/persistence/event-log.ts";
import { ApprovalHub } from "./approval-hub.ts";
import { ProjectsRegistry } from "./projects.ts";
import { SessionManager } from "./session-manager.ts";
import { isAuthorized, newToken, removeHandshake, writeHandshake } from "./auth.ts";
import { loadForgeConfig, saveForgeConfig, PROVIDER_APIS } from "./config-store.ts";
import type { ProviderApi } from "./config-store.ts";
import { discoverModels } from "./model-discovery.ts";
import { buildModel, modelThinkingLevels } from "./model-resolver.ts";
import type { ThinkingLevel } from "../types.ts";
import { createBuiltinPluginRegistry } from "../plugins/builtins/index.ts";
import { createMcpPlugin, McpStdioClient } from "../plugins/mcp.ts";
import { loadExternalPlugins } from "./external-plugins.ts";
import { inspectPluginSource } from "./plugin-install.ts";

/** Pi's full thinking-level set — see pi-ai's ThinkingLevel / ModelThinkingLevel. */
const THINKING_LEVEL_VALUES: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_VALUES.has(value);
}

export type ForgeServerOptions = {
  port: number;
  host?: string;
  forgeHome: string;
};

export type ForgeServerHandle = {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
};

export async function startForgeServer(opts: ForgeServerOptions): Promise<ForgeServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const projects = new ProjectsRegistry(opts.forgeHome);
  const approvalHub = new ApprovalHub();
  const plugins = createBuiltinPluginRegistry();
  // External plugins from <forgeHome>/plugins join the same registry; a file
  // that fails to load is reported to the manager page, never fatal.
  const external = await loadExternalPlugins(opts.forgeHome);
  const externalPluginIds = new Set<string>();
  const externalFiles: Array<{ id: string; fileName: string }> = [];
  for (const { plugin, fileName } of external.plugins) {
    try {
      plugins.register(plugin);
      externalPluginIds.add(plugin.manifest.id);
      externalFiles.push({ id: plugin.manifest.id, fileName });
    } catch (err) {
      external.errors.push({
        source: plugin.manifest.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const startupConfig = await loadForgeConfig(opts.forgeHome);
  for (const mcp of startupConfig.mcpServers ?? []) {
    if (!mcp.enabled) continue;
    plugins.register(createMcpPlugin({
      id: mcp.id,
      ...(mcp.name ? { name: mcp.name } : {}),
      createClient: () => new McpStdioClient(mcp.command, mcp.args, mcp.cwd, mcp.env),
    }));
  }
  const manager = new SessionManager({
    forgeHome: opts.forgeHome,
    projects,
    approvalHub,
    plugins,
    externalPluginIds,
    externalFiles,
    pluginLoadErrors: external.errors,
  });
  await manager.reconcileInterruptedSessions();
  const token = newToken();

  const server: Server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (!isAuthorized(req, url, token)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      // --- Sessions ---
      if (req.method === "POST" && url.pathname === "/sessions") {
        const body = await readBody(req);
        const result = await manager.create({
          goal: typeof body.goal === "string" ? body.goal : "",
          ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
          ...(typeof body.providerId === "string" ? { providerId: body.providerId } : {}),
          ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
          ...(body.approvalMode === "ask" || body.approvalMode === "default" || body.approvalMode === "always"
            ? { approvalMode: body.approvalMode }
            : {}),
        });
        json(res, 202, result);
        return;
      }

      if (req.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
        json(res, 200, { sessions: await manager.list() });
        return;
      }

      if (req.method === "GET" && parts[0] === "sessions" && parts.length === 2) {
        const session = await manager.get(parts[1]!);
        if (!session) {
          json(res, 404, { error: "not found" });
          return;
        }
        json(res, 200, session);
        return;
      }

      if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ protocol: EVENT_PROTOCOL_VERSION })}\n\n`);
        const tail = new TaskEventStream(eventsDir(), parts[1]!);
        req.on("close", () => tail.stop());
        await tail.follow((env) => {
          res.write(`data: ${JSON.stringify(env)}\n\n`);
        });
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "steer") {
        const body = await readBody(req);
        const result = await manager.steer(
          parts[1]!,
          typeof body.message === "string" ? body.message : "",
        );
        json(res, result.ok ? 200 : 409, result);
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "commands") {
        const body = await readBody(req);
        const command = typeof body.command === "string" ? body.command : "";
        if (!command.startsWith("/")) {
          json(res, 400, { error: "command must start with /" });
          return;
        }
        try {
          json(res, 200, await manager.command(parts[1]!, command));
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "capabilities" && parts.length === 3) {
        try {
          json(res, 200, await manager.pluginCapabilities(parts[1]!));
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (
        req.method === "GET" &&
        parts[0] === "sessions" &&
        parts[2] === "capabilities" &&
        parts[4] === "read" &&
        parts.length === 6
      ) {
        try {
          const input = Object.fromEntries(url.searchParams.entries());
          json(res, 200, await manager.readCapability(parts[1]!, parts[3]!, parts[5]!, input));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          json(res, /not found|unknown plugin|unknown read action/i.test(message) ? 404 : 409, { error: message });
        }
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "plugins" && parts.length === 4) {
        const body = await readBody(req);
        if (typeof body.enabled !== "boolean") {
          json(res, 400, { error: "enabled must be boolean" });
          return;
        }
        try {
          json(res, 200, await manager.setPluginEnabled(parts[1]!, parts[3]!, body.enabled));
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // --- Plugin manager (global) ---
      if (req.method === "GET" && parts[0] === "plugins" && parts.length === 1) {
        json(res, 200, await manager.pluginCatalog());
        return;
      }

      if (req.method === "POST" && parts[0] === "plugins" && parts[2] === "enabled" && parts.length === 3) {
        const body = await readBody(req);
        if (typeof body.enabled !== "boolean") {
          json(res, 400, { error: "enabled must be boolean" });
          return;
        }
        try {
          json(res, 200, await manager.setGlobalPluginEnabled(parts[1]!, body.enabled));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          json(res, /unknown plugin/i.test(message) ? 404 : 409, { error: message });
        }
        return;
      }

      if (req.method === "POST" && parts[0] === "plugins" && parts[1] === "inspect" && parts.length === 2) {
        const body = await readBody(req);
        if (typeof body.source !== "string" || !body.source) {
          json(res, 400, { error: "source is required" });
          return;
        }
        try {
          json(res, 200, await inspectPluginSource(body.source));
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && parts[0] === "plugins" && parts[1] === "install" && parts.length === 2) {
        const body = await readBody(req);
        if (typeof body.source !== "string" || !body.source) {
          json(res, 400, { error: "source is required" });
          return;
        }
        try {
          json(res, 200, await manager.installExternalPlugin(body.source));
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && parts[0] === "plugins" && parts[2] === "uninstall" && parts.length === 3) {
        try {
          json(res, 200, await manager.uninstallPlugin(parts[1]!));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          json(res, /not external/i.test(message) ? 404 : 409, { error: message });
        }
        return;
      }

      if (req.method === "PUT" && parts[0] === "plugins" && parts[2] === "config" && parts.length === 3) {
        const body = await readBody(req);
        try {
          json(res, 200, await manager.setGlobalPluginConfig(parts[1]!, body.config));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          json(res, /unknown plugin/i.test(message) ? 404 : 400, { error: message });
        }
        return;
      }

      // Mid-session model switch. Running: effective at the next turn
      // boundary; idle: persisted for the next resume.
      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "model") {
        const body = await readBody(req);
        if (typeof body.providerId !== "string" || !body.providerId) {
          json(res, 400, { error: "providerId is required" });
          return;
        }
        try {
          const result = await manager.switchModel(parts[1]!, body.providerId);
          json(res, 200, result);
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // Mid-session thinking-level switch (reasoning effort). Running: the
      // loop applies it at the next turn boundary; idle: persisted for the
      // next resume.
      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "thinking") {
        const body = await readBody(req);
        const level = body.thinkingLevel;
        if (!isThinkingLevel(level)) {
          json(res, 400, {
            error: `thinkingLevel must be one of ${[...THINKING_LEVEL_VALUES].join(", ")}`,
          });
          return;
        }
        try {
          const result = await manager.switchThinking(parts[1]!, level);
          json(res, 200, result);
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "approval") {
        const body = await readBody(req);
        const mode = body.approvalMode;
        if (mode !== "ask" && mode !== "default" && mode !== "always") {
          json(res, 400, { error: "approvalMode must be ask | default | always" });
          return;
        }
        try {
          const result = await manager.switchApprovalMode(parts[1]!, mode);
          json(res, 200, result);
        } catch (err) {
          json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "abort") {
        const result = await manager.abort(parts[1]!);
        json(res, result.ok ? 202 : 409, result);
        return;
      }

      // POST /sessions/:id/resume — recover a failed/cancelled session.
      // Optional body: { message?: string } → one new prompt for completed
      // sessions, or initial steering for failed/cancelled sessions. Errors:
      //   404 = session not found
      //   409 = session status not in {failed, cancelled} OR already active
      //   500 = replay or subscription lookup failed
      if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "resume") {
        const body = await readBody(req);
        try {
          const result = await manager.resume(
            parts[1]!,
            typeof body.message === "string" ? { message: body.message } : {},
          );
          json(res, 202, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/not found/i.test(msg)) json(res, 404, { error: msg });
          else if (/cannot be resumed|already running/i.test(msg)) json(res, 409, { error: msg });
          else json(res, 500, { error: msg });
        }
        return;
      }

      if (req.method === "DELETE" && parts[0] === "sessions" && parts.length === 2) {
        const result = await manager.delete(parts[1]!);
        json(res, result.ok ? 200 : 409, result);
        return;
      }

      // --- Approvals ---
      if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "approvals") {
        json(res, 200, { approvals: manager.listApprovals(parts[1]!) });
        return;
      }

      if (
        req.method === "POST" &&
        parts[0] === "sessions" &&
        parts[2] === "approvals" &&
        (parts[4] === "approve" || parts[4] === "deny")
      ) {
        const result =
          parts[4] === "approve"
            ? await manager.approve(parts[1]!, parts[3]!)
            : await manager.deny(parts[1]!, parts[3]!);
        json(res, result.ok ? 200 : 404, result);
        return;
      }

      // --- Config (model subscriptions; Desktop Settings) ---
      if (req.method === "GET" && url.pathname === "/config") {
        const cfg = await loadForgeConfig(opts.forgeHome);
        // Derived, never persisted: which thinking levels each subscription's
        // model actually supports. The picker offers only these, so a level
        // that would silently no-op is never shown.
        const modelCapabilities: Record<string, string[]> = {};
        // Derived as well: each model's context window, so the token meter
        // can render the context watermark against real capacity.
        const modelContextWindows: Record<string, number> = {};
        for (const provider of cfg.providers) {
          modelCapabilities[provider.id] = modelThinkingLevels(provider);
          modelContextWindows[provider.id] = buildModel(provider).contextWindow;
        }
        json(res, 200, { ...cfg, modelCapabilities, modelContextWindows });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/config") {
        const body = await readBody(req);
        await saveForgeConfig(opts.forgeHome, body as unknown as Parameters<typeof saveForgeConfig>[1]);
        json(res, 200, await loadForgeConfig(opts.forgeHome));
        return;
      }

      // --- Model discovery (Settings: ask the endpoint what it serves) ---
      if (req.method === "POST" && url.pathname === "/providers/models") {
        const body = await readBody(req);
        const api = body.api as ProviderApi | undefined;
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
        const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
        if (!api || !PROVIDER_APIS.includes(api) || !baseUrl || !apiKey) {
          json(res, 400, { error: "api, baseUrl and apiKey are required" });
          return;
        }
        try {
          json(res, 200, { models: await discoverModels({ api, baseUrl, apiKey }) });
        } catch (err) {
          // Upstream endpoint failure is not a Forge bug — 502 carries the
          // reason so the Settings page can show something actionable.
          json(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // --- Projects ---
      if (req.method === "POST" && url.pathname === "/projects") {
        const body = await readBody(req);
        const project = await projects.register({
          path: typeof body.path === "string" ? body.path : "",
          ...(typeof body.name === "string" ? { name: body.name } : {}),
        });
        json(res, 201, project);
        return;
      }

      if (req.method === "GET" && url.pathname === "/projects") {
        json(res, 200, await projects.list());
        return;
      }

      // Switch the active project. The desktop's project picker posts here;
      // without this route the request 404s and the picker silently reverts
      // (the UI used to swallow the error).
      if (req.method === "POST" && url.pathname === "/projects/select") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        try {
          json(res, 200, await projects.select(id));
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolveP) => server.listen(opts.port, host, resolveP));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const url = `http://${host}:${port}`;
  await writeHandshake(opts.forgeHome, {
    protocolVersion: 1,
    port,
    host,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  });

  return {
    url,
    port,
    token,
    close: async () => {
      await manager.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolveP) => server.close(() => resolveP()));
      await removeHandshake(opts.forgeHome);
    },
  };
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolveP) => {
    let buf = "";
    req.on("data", (c: Buffer) => (buf += c.toString("utf8")));
    req.on("end", () => {
      try {
        resolveP(JSON.parse(buf) as Record<string, any>);
      } catch {
        resolveP({});
      }
    });
    req.on("error", () => resolveP({}));
  });
}
