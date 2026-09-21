import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { ForgePlugin, PluginInteractionFrame } from "../types.ts";

const MAX_TERMINALS_PER_SESSION = 2;
const MAX_TOTAL_TERMINALS = 16;
const OUTPUT_COALESCE_MS = 16;

type TerminalFrame = { type: "data" | "exit"; payload: string };
type TerminalEntry = {
  pty: IPty;
  sessionId: string;
  listeners: Set<(frame: TerminalFrame) => void>;
  exited: boolean;
};

class TerminalResources {
  private readonly terminals = new Map<string, TerminalEntry>();

  create(sessionId: string, workspace: string, cols: number, rows: number): { id: string } {
    const owned = [...this.terminals.values()].filter((entry) => entry.sessionId === sessionId).length;
    if (owned >= MAX_TERMINALS_PER_SESSION) {
      throw new Error(`session already has ${MAX_TERMINALS_PER_SESSION} terminals`);
    }
    if (this.terminals.size >= MAX_TOTAL_TERMINALS) {
      throw new Error("terminal limit reached; exit one and retry");
    }
    const id = randomUUID();
    const shell = [process.env.SHELL, "/bin/zsh", "/bin/bash"].find(
      (candidate) => candidate && existsSync(candidate),
    ) ?? "/bin/bash";
    const entry: TerminalEntry = {
      pty: ptySpawn(shell, ["-l"], {
        name: "xterm-256color",
        cols: clamp(cols, 80, 2, 500),
        rows: clamp(rows, 24, 2, 300),
        cwd: workspace,
        env: { ...process.env } as Record<string, string>,
      }),
      sessionId,
      listeners: new Set(),
      exited: false,
    };
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const chunk = buffer;
      buffer = "";
      for (const listener of entry.listeners) listener({ type: "data", payload: chunk });
    };
    entry.pty.onData((data) => {
      buffer += data;
      if (!timer) timer = setTimeout(flush, OUTPUT_COALESCE_MS);
    });
    entry.pty.onExit(({ exitCode }) => {
      if (timer) clearTimeout(timer);
      if (buffer) flush();
      entry.exited = true;
      for (const listener of entry.listeners) listener({ type: "exit", payload: String(exitCode) });
      entry.listeners.clear();
      this.terminals.delete(id);
    });
    this.terminals.set(id, entry);
    return { id };
  }

  subscribe(sessionId: string, id: string, listener: (frame: TerminalFrame) => void): () => void {
    const entry = this.entry(sessionId, id);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  write(sessionId: string, id: string, data: string): void {
    const entry = this.entry(sessionId, id);
    if (!entry.exited) entry.pty.write(data);
  }

  resize(sessionId: string, id: string, cols: number, rows: number): void {
    const entry = this.entry(sessionId, id);
    if (!entry.exited) entry.pty.resize(clamp(cols, 80, 2, 500), clamp(rows, 24, 2, 300));
  }

  exit(sessionId: string, id: string): void {
    const entry = this.entry(sessionId, id);
    if (!entry.exited) entry.pty.kill();
    this.terminals.delete(id);
  }

  killSession(sessionId: string): void {
    for (const [id, entry] of this.terminals) {
      if (entry.sessionId !== sessionId) continue;
      if (!entry.exited) entry.pty.kill();
      this.terminals.delete(id);
    }
  }

  killAll(): void {
    for (const entry of this.terminals.values()) {
      if (!entry.exited) entry.pty.kill();
    }
    this.terminals.clear();
  }

  private entry(sessionId: string, id: string): TerminalEntry {
    const entry = this.terminals.get(id);
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error(`no such terminal in this session: ${id}`);
    }
    return entry;
  }
}

function clamp(value: number, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value) || fallback, min), max);
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function numberInput(input: Record<string, unknown>, key: string, fallback: number): number {
  return typeof input[key] === "number" ? input[key] : fallback;
}

/** User-owned PTYs are deliberately outside agent guardrails: the approval
 * pipeline governs model tool calls, not what a user types into their shell. */
export function createTerminalPlugin(): ForgePlugin {
  const resources = new TerminalResources();
  return {
    manifest: {
      id: "forge.terminal",
      name: "Session terminal",
      version: "1.0.0",
      description: "User-controlled terminal in the session dock.",
      capabilities: ["interaction", "ui"],
      interactions: [
        { id: "create", description: "Create a terminal", kind: "request" },
        { id: "input", description: "Write terminal input", kind: "request" },
        { id: "resize", description: "Resize a terminal", kind: "request" },
        { id: "exit", description: "Exit a terminal", kind: "request" },
        { id: "output", description: "Stream terminal output", kind: "stream" },
      ],
      ui: [{ id: "terminal", label: "终端", surface: "dock", renderer: "terminal" }],
    },
    activate: () => ({}),
    interact: (actionId, input, context) => {
      if (actionId === "create") {
        return resources.create(
          context.session.id,
          context.session.workspace,
          numberInput(input, "cols", 80),
          numberInput(input, "rows", 24),
        );
      }
      const terminalId = stringInput(input, "terminalId");
      if (actionId === "input") {
        const data = input.data;
        if (typeof data !== "string") throw new Error("data must be a string");
        resources.write(context.session.id, terminalId, data);
      } else if (actionId === "resize") {
        resources.resize(
          context.session.id,
          terminalId,
          numberInput(input, "cols", 80),
          numberInput(input, "rows", 24),
        );
      } else if (actionId === "exit") {
        resources.exit(context.session.id, terminalId);
      } else {
        throw new Error(`unknown terminal interaction: ${actionId}`);
      }
      return { ok: true };
    },
    subscribe: (actionId, input, context, emit) => {
      if (actionId !== "output") throw new Error(`unknown terminal stream: ${actionId}`);
      const terminalId = stringInput(input, "terminalId");
      const unsubscribe = resources.subscribe(context.session.id, terminalId, (frame) => emit(frame as PluginInteractionFrame));
      const abort = () => unsubscribe();
      context.signal.addEventListener("abort", abort, { once: true });
      return () => {
        context.signal.removeEventListener("abort", abort);
        unsubscribe();
      };
    },
    disposeSession: (sessionId) => resources.killSession(sessionId),
    dispose: () => resources.killAll(),
  };
}
