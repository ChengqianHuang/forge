import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function isLocalWebRequest(req: IncomingMessage, expectedHost: string): boolean {
  if (req.headers.host !== expectedHost) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${expectedHost}`) return false;
  const fetchSite = req.headers["sec-fetch-site"];
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

export async function serveWebAsset(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
  token: string,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/" && pathname !== "/index.html" && !pathname.startsWith("/assets/")) return false;

  const root = resolve(webRoot);
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  const filePath = resolve(root, decoded);
  if (!filePath.startsWith(root + sep)) {
    res.writeHead(404).end();
    return true;
  }

  try {
    let contents: Buffer | string = await readFile(filePath);
    const isHtml = decoded === "index.html";
    if (isHtml) {
      const html = contents.toString("utf8");
      if (!html.includes("</head>")) throw new Error("web index is missing </head>");
      // The token is random base64url, but JSON encoding keeps this safe if
      // its representation changes. Only same-origin HTML receives it.
      const config = JSON.stringify({ baseUrl: "", token }).replaceAll("<", "\\u003c");
      contents = html.replace("</head>", `<script>window.__FORGE_CONFIG__=${config}</script></head>`);
    }
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": isHtml ? "no-store" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": "frame-ancestors 'none'",
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  } catch (err) {
    const status = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    res.writeHead(status).end();
  }
  return true;
}
