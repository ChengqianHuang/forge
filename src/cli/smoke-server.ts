/**
 * Phase 4 server smoke: boots the real session-centric server in-process and
 * exercises the HTTP surface end-to-end (config, projects, session create,
 * SSE stream, abort, delete) with a fake subscription — no network calls are
 * awaited (the background agent fails against the fake key and is aborted).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startForgeServer, type ForgeServerHandle } from "../server/http-server.ts";
import { saveForgeConfig } from "../server/config-store.ts";

async function main(): Promise<void> {
  const forgeHome = mkdtempSync(join(tmpdir(), "forge-server-smoke-"));
  process.env.FORGE_HOME = forgeHome;
  process.env.FORGE_EVENTS_DIR = join(forgeHome, "events");
  process.env.FORGE_SESSIONS_DIR = join(forgeHome, "sessions");
  const repoWorkspace = join(forgeHome, "workspace");
  const webRoot = join(forgeHome, "web");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<html><head></head><body>Forge web smoke</body></html>");
  writeFileSync(join(webRoot, "assets", "app.js"), "window.forgeLoaded=true;");
  mkdirSync(repoWorkspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoWorkspace });
  writeFileSync(join(repoWorkspace, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repoWorkspace });
  execFileSync("git", ["-c", "user.name=Forge Smoke", "-c", "user.email=forge@smoke.invalid", "commit", "-qm", "fixture"], { cwd: repoWorkspace });
  writeFileSync(join(repoWorkspace, "tracked.txt"), "after\n");

  // A fake subscription: the background agent will fail against it, which is
  // part of what we verify (failure path + abort + delete).
  await saveForgeConfig(forgeHome, {
    version: 1,
    providers: [
      {
        id: "prov_fake",
        api: "openai-completions",
        modelId: "fake-model",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "fake-key",
      },
    ],
    defaultProviderId: "prov_fake",
    maxConcurrency: 1,
  } as unknown as Parameters<typeof saveForgeConfig>[1]);

  const handle: ForgeServerHandle = await startForgeServer({
    port: 0,
    host: "127.0.0.1",
    forgeHome,
    webRoot,
  });
  const auth = { authorization: `Bearer ${handle.token}` };
  const base = handle.url;
  let ok = true;

  try {
    const page = await fetch(base);
    const html = await page.text();
    const script = await fetch(`${base}/assets/app.js`);
    const blockedOrigin = await fetch(`${base}/config`, {
      headers: { ...auth, origin: "https://example.invalid" },
    });
    const blockedHost = await new Promise<number>((resolve, reject) => {
      const req = request(base, { headers: { host: "example.invalid" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    ok = ok && page.status === 200 && html.includes("Forge web smoke")
      && html.includes(handle.token) && page.headers.get("cache-control") === "no-store"
      && script.status === 200 && (await script.text()).includes("forgeLoaded")
      && blockedOrigin.status === 403 && blockedHost === 403;
    console.log(`  web entry: page=${page.status}, asset=${script.status}, cross-origin=${blockedOrigin.status}, host-spoof=${blockedHost}`);

    // 1. Config round-trip.
    const cfg = (await (await fetch(`${base}/config`, { headers: auth })).json()) as {
      providers: unknown[];
      defaultProviderId: string | null;
      mcpServers: unknown[];
    };
    console.log(`  config providers: ${(cfg.providers as unknown[]).length}`);
    ok = ok && Array.isArray(cfg.providers) && cfg.providers.length === 1;

    // 1b. MCP settings reconcile the live capability catalog without a
    // server restart. Registration must not spawn the configured process.
    const hotConfig = {
      ...cfg,
      mcpServers: [{ id: "hot", command: process.execPath, args: ["-e", "process.exit(0)"], enabled: true }],
    };
    const hotSaved = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(hotConfig),
    });
    const hotCatalog = await (await fetch(`${base}/plugins`, { headers: auth })).json() as {
      plugins?: Array<{ id: string }>;
    };
    ok = ok && hotSaved.status === 200 && hotCatalog.plugins?.some((plugin) => plugin.id === "mcp.hot") === true;
    const removedSaved = await fetch(`${base}/config`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ ...cfg, mcpServers: [] }),
    });
    const removedCatalog = await (await fetch(`${base}/plugins`, { headers: auth })).json() as {
      plugins?: Array<{ id: string }>;
    };
    ok = ok && removedSaved.status === 200 && removedCatalog.plugins?.some((plugin) => plugin.id === "mcp.hot") === false;
    console.log(`  MCP hot catalog: add=${hotSaved.status}, remove=${removedSaved.status}`);

    // 2. Project registration.
    const proj = (await (
      await fetch(`${base}/projects`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ path: repoWorkspace }),
      })
    ).json()) as { id: string; path: string };
    console.log(`  project: ${proj.id} path=${proj.path}`);
    ok = ok && typeof proj.id === "string";

    // 2b. Project switch — POST /projects/select must really flip the active
    // project (the route used to not exist, the desktop swallowed the 404 and
    // the picker silently reverted.
    const proj2 = (await (
      await fetch(`${base}/projects`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ path: tmpdir(), name: "second" }),
      })
    ).json()) as { id: string };
    const sel = (await (
      await fetch(`${base}/projects/select`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ id: proj2.id }),
      })
    ).json()) as { id: string };
    const listed = (await (await fetch(`${base}/projects`, { headers: auth })).json()) as {
      activeProjectId: string | null;
    };
    console.log(`  project select: ${sel.id} → active=${listed.activeProjectId}`);
    ok = ok && sel.id === proj2.id && listed.activeProjectId === proj2.id;

    // 2c. Selecting an unknown project is a 404, not a 500.
    const badSel = await fetch(`${base}/projects/select`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "prj_nope" }),
    });
    ok = ok && badSel.status === 404;

    // 2d. Model discovery route exists: missing fields → 400 (route-presence
    // regression — a 404 here would mean the route silently fell off).
    const noFields = await fetch(`${base}/providers/models`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    ok = ok && noFields.status === 400;

    // 3. Create a session (202) — the agent fails fast against :9 and is aborted.
    const created = (await (
      await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ goal: "smoke session", projectId: proj.id }),
      })
    ).json()) as { sessionId: string };
    const sessionId = created.sessionId as string;
    console.log(`  session created: ${sessionId}`);
    ok = ok && typeof sessionId === "string";

    // 3a. Capability discovery is session-scoped and distinguishes required
    // substrate from optional product behavior.
    const pluginCaps = (await (
      await fetch(`${base}/sessions/${sessionId}/capabilities`, { headers: auth })
    ).json()) as {
      plugins: Array<{ id: string; required: boolean; status: string }>;
      slashCommands: Array<{ name: string }>;
    };
    const commandNames = pluginCaps.slashCommands.map((command) => command.name);
    const usage = pluginCaps.plugins.find((plugin) => plugin.id === "forge.usage");
    const capabilityHealth = pluginCaps.plugins.find((plugin) => plugin.id === "forge.capability-health");
    const guardAudit = pluginCaps.plugins.find((plugin) => plugin.id === "forge.guard-audit");
    const reliabilityPlugin = pluginCaps.plugins.find((plugin) => plugin.id === "forge.reliability");
    const workspaceChanges = pluginCaps.plugins.find((plugin) => plugin.id === "forge.workspace-changes");
    ok = ok && ["compact", "status", "context"].every((name) => commandNames.includes(name));
    ok = ok && usage?.required === true && ["active", "failed"].includes(usage.status);
    ok = ok && capabilityHealth?.required === true && ["active", "failed"].includes(capabilityHealth.status);
    ok = ok && guardAudit?.required === true && ["active", "failed"].includes(guardAudit.status);
    ok = ok && reliabilityPlugin?.required === true && ["active", "failed"].includes(reliabilityPlugin.status);
    ok = ok && workspaceChanges?.required === false;
    const capsWithUi = pluginCaps as typeof pluginCaps & {
      uiContributions?: Array<{ pluginId: string; renderer: string; readAction?: string }>;
    };
    ok = ok && capsWithUi.uiContributions?.some((item) =>
      item.pluginId === "forge.capability-health" && item.renderer === "capability-health"
    ) === true;
    ok = ok && capsWithUi.uiContributions?.some((item) =>
      item.pluginId === "forge.guard-audit" && item.renderer === "guard-audit" && item.readAction === undefined
    ) === true;
    ok = ok && capsWithUi.uiContributions?.some((item) =>
      item.pluginId === "forge.reliability" && item.renderer === "reliability" && item.readAction === "metrics"
    ) === true;
    ok = ok && capsWithUi.uiContributions?.some((item) =>
      item.pluginId === "forge.workspace-changes" && item.renderer === "workspace-changes"
    ) === true;

    // 3.5 Approval-posture endpoint: invalid mode → 400, valid → 200 and
    //     persisted (a UI switch the server silently drops would be a lie).
    const badApproval = await fetch(`${base}/sessions/${sessionId}/approval`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ approvalMode: "yolo" }),
    });
    ok = ok && badApproval.status === 400;
    const goodApproval = (await (
      await fetch(`${base}/sessions/${sessionId}/approval`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ approvalMode: "always" }),
      })
    ).json()) as { approvalMode: string };
    ok = ok && goodApproval.approvalMode === "always";
    console.log(`  approval mode: ${goodApproval.approvalMode}`);

    // 4. Session readable — including the usage record the token meter reads
    //    (a field the server drops would make that meter a lie in the UI).
    const session = (await (await fetch(`${base}/sessions/${sessionId}`, { headers: auth })).json()) as {
      status: string;
      goal: string;
      usage: unknown;
    };
    console.log(`  session status: ${session.status}, goal: ${session.goal}`);
    ok = ok && session.goal === "smoke session";
    ok = ok && typeof session.usage === "object";

    // 4b. Slash commands use their own route and return plugin output instead
    // of becoming a model prompt. /status also works after a fast failure.
    const commandResponse = await fetch(`${base}/sessions/${sessionId}/commands`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ command: "/status" }),
    });
    const commandBody = await commandResponse.json() as { message?: string };
    ok = ok && commandResponse.status === 200 && typeof commandBody.message === "string";

    // 5. SSE stream yields at least the created/started events.
    const controller = new AbortController();
    const sse = await fetch(`${base}/sessions/${sessionId}/stream?token=${encodeURIComponent(handle.token)}`, {
      signal: controller.signal,
      headers: auth,
    });
    const reader = sse.body?.getReader();
    let sseFrames = 0;
    if (reader) {
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        while (sseFrames < 2) {
          const { done, value } = await reader.read();
          if (done) break;
          sseFrames += Array.from(new TextDecoder().decode(value).matchAll(/data: /g)).length;
          if (sseFrames >= 2) break;
        }
      } catch {
        /* aborted */
      }
      clearTimeout(timer);
      controller.abort();
    }
    console.log(`  sse frames: ${sseFrames}`);
    ok = ok && sseFrames >= 2;

    // 6. Approvals endpoint (empty) + abort + capability reads + delete.
    const approvals = (await (await fetch(`${base}/sessions/${sessionId}/approvals`, { headers: auth })).json()) as { approvals: unknown[] };
    await fetch(`${base}/sessions/${sessionId}/abort`, { method: "POST", headers: auth });
    await new Promise((r) => setTimeout(r, 300));
    const reliabilityResponse = await fetch(
      `${base}/sessions/${sessionId}/capabilities/forge.reliability/read/metrics`,
      { headers: auth },
    );
    const reliability = await reliabilityResponse.json() as {
      tools?: { guardCoverage?: number };
      integrity?: { healthy?: boolean; violations?: unknown[] };
    };
    ok = ok && reliabilityResponse.status === 200;
    ok = ok && typeof reliability.tools?.guardCoverage === "number";
    ok = ok && typeof reliability.integrity?.healthy === "boolean";
    const terminalCaps = (await (
      await fetch(`${base}/sessions/${sessionId}/capabilities`, { headers: auth })
    ).json()) as { plugins?: Array<{ id: string; status: string }> };
    ok = ok && terminalCaps.plugins?.find((plugin) => plugin.id === "forge.reliability")?.status === "disposed";
    const retiredReliabilityRoute = await fetch(`${base}/sessions/${sessionId}/reliability`, { headers: auth });
    ok = ok && retiredReliabilityRoute.status === 404;
    const diffResponse = await fetch(
      `${base}/sessions/${sessionId}/capabilities/forge.workspace-changes/read/diff?path=${encodeURIComponent("tracked.txt")}`,
      { headers: auth },
    );
    const diff = await diffResponse.json() as { kind?: string; patch?: string };
    ok = ok && diffResponse.status === 200 && diff.kind === "text" && diff.patch?.includes("+after") === true;
    const deleted = await fetch(`${base}/sessions/${sessionId}`, { method: "DELETE", headers: auth });
    console.log(`  approvals: ${(approvals.approvals as unknown[]).length}, reliability capability: ${reliability.integrity?.healthy}, diff: ${diffResponse.status}, delete: ${deleted.status}`);
    ok = ok && deleted.status === 200;

  } finally {
    await handle.close();
    ok = ok && !existsSync(join(forgeHome, "server.json"));
    rmSync(forgeHome, { recursive: true, force: true });
  }

  writeFileSync(join(tmpdir(), "forge-server-smoke-last"), ok ? "PASS" : "FAIL");
  console.log(`\nSERVER SMOKE: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
