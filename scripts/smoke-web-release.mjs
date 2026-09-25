import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = mkdtempSync(join(tmpdir(), "forge-web-release-smoke-"));
let child;

try {
  execFileSync("bash", ["scripts/build-web-release.sh", temp], { cwd: root, stdio: "inherit" });
  execFileSync("tar", ["-xzf", join(temp, `forge-web-${version}.tar.gz`), "-C", temp]);
  const unpacked = join(temp, `forge-web-${version}`);
  execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: unpacked,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });

  child = spawn(process.execPath, ["--import", "tsx/esm", "src/cli/serve.ts", "--port", "0", "--no-open"], {
    cwd: unpacked,
    env: { ...process.env, FORGE_HOME: join(temp, "home"), FORGE_RUNTIME: "fake" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (part) => { output += part.toString(); });
  child.stderr.on("data", (part) => { output += part.toString(); });
  const deadline = Date.now() + 20_000;
  let url;
  while (Date.now() < deadline) {
    url = output.match(/\[forge\] open (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) break;
    if (child.exitCode !== null) throw new Error(`web server exited early:\n${output}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!url) throw new Error(`web server did not start:\n${output}`);

  const page = await fetch(url);
  const html = await page.text();
  const token = html.match(/"token":"([^"]+)"/)?.[1];
  const assetPath = html.match(/src="(\/assets\/[^"]+)"/)?.[1];
  if (page.status !== 200 || !token || !assetPath) {
    throw new Error(`invalid web entry: status=${page.status}, token=${Boolean(token)}, asset=${assetPath}`);
  }
  const asset = await fetch(new URL(assetPath, url));
  const config = await fetch(new URL("/config", url), {
    headers: { authorization: `Bearer ${token}` },
  });
  const sessions = await fetch(new URL("/sessions", url), {
    headers: { authorization: `Bearer ${token}` },
  });
  const sessionBody = await sessions.json();
  if (asset.status !== 200 || config.status !== 200 || sessions.status !== 200 || sessionBody.sessions?.length !== 0) {
    throw new Error(`web assets/API failed: asset=${asset.status}, config=${config.status}, sessions=${JSON.stringify(sessionBody).slice(0, 200)}`);
  }
  console.log(`WEB RELEASE SMOKE: PASS (${url}, clean production install)`);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => child.once("exit", done)),
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(temp, { recursive: true, force: true });
}
