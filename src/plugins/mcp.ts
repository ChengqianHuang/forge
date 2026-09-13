import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ForgePlugin } from "./types.ts";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClient {
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<McpToolDefinition[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

const SECRET_ENV_NAME = /(key|secret|token|password|credential)/i;

/**
 * MCP processes inherit ordinary launch context but not ambient credentials.
 * A value explicitly supplied in the server's own config is intentional and
 * therefore wins after the scrub.
 */
export function mcpChildEnvironment(
  ambient: NodeJS.ProcessEnv,
  configured?: Record<string, string>,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value !== undefined && !SECRET_ENV_NAME.test(name)) clean[name] = value;
  }
  return { ...clean, ...configured };
}

/** A minimal MCP stdio JSON-RPC transport with cancellation and reconnectable ownership. */
export class McpStdioClient implements McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private childDone: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly cwd?: string,
    private readonly env?: Record<string, string>,
  ) {}

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.child && !this.child.killed) return;
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.cwd ? { cwd: this.cwd } : {}),
      env: mcpChildEnvironment(process.env, this.env),
    };
    const child = spawn(this.command, this.args, spawnOpts) as ChildProcessWithoutNullStreams;
    this.child = child;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    this.childDone = done;
    child.stderr.resume();
    createInterface({ input: child.stdout }).on("line", (line) => this.accept(line));
    child.once("error", (error) => {
      this.rejectAll(error);
      resolveDone();
    });
    child.once("exit", (code, sig) => {
      this.rejectAll(new Error(`MCP process exited (${code ?? sig ?? "unknown"})`));
      if (this.child === child) {
        this.child = null;
        this.childDone = null;
      }
      resolveDone();
    });
    if (signal?.aborted) throw signal.reason;
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "forge", version: "0.3.0" },
    }, signal);
    void initialized;
    this.notify("notifications/initialized", {});
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    const result = await this.request("tools/list", {}, signal) as { tools?: McpToolDefinition[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    // Reconnect only before a fresh invocation. We deliberately do not retry
    // an in-flight call after a crash because a mutating tool may already
    // have committed its side effect before the transport disappeared.
    if (!this.child) await this.connect(signal);
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    const child = this.child;
    const done = this.childDone;
    this.child = null;
    this.childDone = null;
    if (!child) return;
    this.rejectAll(new Error("MCP client closed"));
    child.kill("SIGTERM");
    if (!done) return;
    const exited = await Promise.race([
      done.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000);
        timer.unref?.();
      }),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await done;
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("MCP client is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
        reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private accept(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "MCP request failed"));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createMcpPlugin(options: {
  id: string;
  name?: string;
  client?: McpClient;
  createClient?: () => McpClient;
}): ForgePlugin {
  return {
    manifest: {
      id: `mcp.${options.id}`,
      name: options.name ?? options.id,
      version: "1.0.0",
      capabilities: ["tool"],
    },
    async activate(context) {
      const client = options.createClient?.() ?? options.client;
      if (!client) throw new Error(`MCP plugin ${options.id} has no client factory`);
      let definitions: McpToolDefinition[];
      try {
        await client.connect(context.signal);
        definitions = await client.listTools(context.signal);
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
      const tools: AgentTool<any>[] = definitions.map((definition) => ({
        name: definition.name,
        label: definition.name,
        description: definition.description ?? `MCP tool from ${options.id}`,
        parameters: definition.inputSchema as TSchema,
        async execute(_toolCallId, params, signal) {
          const result = await client.callTool(definition.name, params, signal);
          return {
            content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }],
            details: { server: options.id, tool: definition.name, result },
          };
        },
      }));
      return { tools, dispose: () => client.close() };
    },
  };
}
