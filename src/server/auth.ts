import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

export type Handshake = {
  protocolVersion: 1;
  port: number;
  host: string;
  token: string;
  pid: number;
  startedAt: number;
};

export function handshakePath(forgeHome: string): string {
  return join(forgeHome, "server.json");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function writeHandshake(forgeHome: string, h: Handshake): Promise<void> {
  const p = handshakePath(forgeHome);
  await mkdir(forgeHome, { recursive: true, mode: 0o700 });
  await writeFile(p, JSON.stringify(h, null, 2) + "\n", { mode: 0o600 });
  await chmod(p, 0o600).catch(() => {});
}

export async function removeHandshake(forgeHome: string): Promise<void> {
  await rm(handshakePath(forgeHome), { force: true });
}

function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) return h.slice(7);
  return undefined;
}

function requestToken(req: IncomingMessage, url: URL): string | undefined {
  return bearerToken(req) ?? url.searchParams.get("token") ?? undefined;
}

export function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  const provided = requestToken(req, url);
  return provided !== undefined && provided.length > 0 && provided === token;
}
