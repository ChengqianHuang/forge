import { startForgeServer } from "../server/http-server.ts";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const forgeHome = resolve(process.env.FORGE_HOME ?? join(process.env.HOME ?? "/tmp", ".forge"));
const port = Number(arg("--port") ?? 5300);
const host = arg("--host") ?? "127.0.0.1";

const handle = await startForgeServer({ port, host, forgeHome });
console.log(`[forge] serving on ${handle.url} (forge home: ${forgeHome})`);

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
