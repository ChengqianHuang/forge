import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadForgeConfig, saveForgeConfig, validateProvider, validateMcpServer, resolveProvider } from "./config-store.ts";

const TMP = "/tmp/forge-config-store-tests";
const HOME = join(TMP, "home");

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("validateProvider", () => {
  test("accepts the protocol-first shape and assigns an id", () => {
    const p = validateProvider({
      api: "anthropic-messages",
      apiKey: "sk",
      modelId: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    });
    assert.ok(p);
    assert.equal(p.api, "anthropic-messages");
    assert.ok(p.id && p.id.length > 0);
  });

  test("keeps a provided id", () => {
    const p = validateProvider({ id: "sub-1", api: "openai-completions", apiKey: "k", modelId: "m", baseUrl: "https://x" });
    assert.equal(p?.id, "sub-1");
  });

  test("rejects unknown protocol / empty fields", () => {
    assert.equal(validateProvider({ api: "google-generative-ai", apiKey: "k", modelId: "m", baseUrl: "https://x" }), null);
    assert.equal(validateProvider({ api: "openai-completions", apiKey: "", modelId: "m", baseUrl: "https://x" }), null);
    assert.equal(validateProvider({ api: "openai-completions", apiKey: "k", modelId: " ", baseUrl: "https://x" }), null);
  });
});

test("MCP server config is validated without executing it", () => {
  assert.deepEqual(validateMcpServer({ id: "fs", command: "npx", args: ["server"], enabled: true }), {
    id: "fs", command: "npx", args: ["server"], enabled: true,
  });
  assert.equal(validateMcpServer({ id: "bad id", command: "npx" }), null);
});

describe("resolveProvider", () => {
  const cfg = {
    version: 2 as const,
    providers: [
      { id: "a", api: "anthropic-messages" as const, apiKey: "k1", modelId: "m1", baseUrl: "https://a" },
      { id: "b", api: "openai-completions" as const, apiKey: "k2", modelId: "m2", baseUrl: "https://b" },
    ],
    defaultProviderId: "a",
  };

  test("explicit providerId wins", () => {
    assert.equal(resolveProvider(cfg, "b")?.modelId, "m2");
  });
  test("falls back to default", () => {
    assert.equal(resolveProvider(cfg)?.modelId, "m1");
  });
  test("falls back to first entry when default missing", () => {
    const c = { ...cfg, defaultProviderId: null };
    assert.equal(resolveProvider(c)?.modelId, "m1");
  });
  test("null when no providers", () => {
    assert.equal(resolveProvider({ ...cfg, providers: [], defaultProviderId: null }), null);
  });
});

describe("legacy config migration", () => {
  test("v1 kind=anthropic migrates to anthropic-messages", async () => {
    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "anthropic", apiKey: "sk", modelId: "claude-opus-4-8", baseUrl: "https://api.anthropic.com" },
      maxConcurrency: 2,
    }));
    const cfg = await loadForgeConfig(HOME);
    assert.equal(cfg.version, 2);
    assert.equal(cfg.providers.length, 1);
    assert.equal(cfg.providers[0]?.api, "anthropic-messages");
    assert.equal(cfg.defaultProviderId, cfg.providers[0]?.id);
  });

  test("v1 kind=minimax migrates to anthropic-messages", async () => {
    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "minimax", apiKey: "sk", modelId: "MiniMax-M3", baseUrl: "https://api.minimax.io/anthropic" },
      maxConcurrency: 2,
    }));
    const cfg = await loadForgeConfig(HOME);
    assert.equal(cfg.providers[0]?.api, "anthropic-messages");
  });

  test("v1 kind=openai-compatible keeps its api (defaults to openai-completions)", async () => {
    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "openai-compatible", apiKey: "sk", modelId: "gpt-4o", baseUrl: "https://gw/v1", api: "openai-responses" },
      maxConcurrency: 2,
    }));
    assert.equal((await loadForgeConfig(HOME)).providers[0]?.api, "openai-responses");

    writeFileSync(join(HOME, "forge-config.json"), JSON.stringify({
      version: 1,
      provider: { kind: "openai-compatible", apiKey: "sk", modelId: "gpt-4o", baseUrl: "https://gw/v1" },
      maxConcurrency: 2,
    }));
    assert.equal((await loadForgeConfig(HOME)).providers[0]?.api, "openai-completions");
  });

  test("v2 multi-subscription shape round-trips through save/load", async () => {
    const providers = [
      { id: "a", api: "anthropic-messages" as const, apiKey: "k1", modelId: "claude-sonnet-4-6", baseUrl: "https://api.anthropic.com" },
      { id: "b", api: "openai-completions" as const, apiKey: "k2", modelId: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com" },
    ];
    await saveForgeConfig(HOME, { version: 2, providers, defaultProviderId: "b" });
    const cfg = await loadForgeConfig(HOME);
    assert.equal(cfg.providers.length, 2);
    assert.equal(cfg.defaultProviderId, "b");
    assert.deepEqual(resolveProvider(cfg), providers[1]);
  });
});
