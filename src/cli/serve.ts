import { startForgeServer } from "../server/http-server.ts";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const forgeHome = resolve(process.env.FORGE_HOME ?? join(process.env.HOME ?? "/tmp", ".forge"));
process.env.FORGE_SESSIONS_DIR ??= join(forgeHome, "sessions");
process.env.FORGE_EVENTS_DIR ??= join(forgeHome, "events");
const port = Number(arg("--port") ?? 5300);
const host = arg("--host") ?? "127.0.0.1";
const webRoot = resolve(fileURLToPath(new URL("../../desktop/dist/", import.meta.url)));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid port");
if (host !== "127.0.0.1") throw new Error("web mode only supports 127.0.0.1");
if (!(await stat(join(webRoot, "index.html")).catch(() => null))?.isFile()) {
  throw new Error("web assets missing; run npm --prefix desktop run build");
}

const handle = await startForgeServer({ port, host, forgeHome, webRoot });
console.log(`[forge] open ${handle.url} (forge home: ${forgeHome})`);
if (!args.includes("--no-open")) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const openArgs = process.platform === "win32" ? ["/c", "start", "", handle.url] : [handle.url];
  const opener = spawn(command, openArgs, { stdio: "ignore" });
  opener.on("error", () => {
    console.warn(`[forge] browser did not open automatically; visit ${handle.url}`);
  });
  opener.unref();
}

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
