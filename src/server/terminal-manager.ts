import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn as ptySpawn, type IPty } from "node-pty";

/**
 * Per-session user terminals (the dock 终端 tab). These are USER surfaces,
 * deliberately outside the guardrails: the user typing in their own terminal
 * on their own machine is the same trust level as opening Terminal.app — the
 * approval pipeline governs what the AGENT runs, not what the user runs.
 *
 * Processes persist across UI reloads (the termId is the client's reconnect
 * handle) and die on explicit exit, session deletion, or server shutdown.
 */

const MAX_TERMINALS_PER_SESSION = 2;
const MAX_TOTAL_TERMINALS = 16;
const OUTPUT_COALESCE_MS = 16;

type TerminalEntry = {
  pty: IPty;
  sessionId: string;
  listeners: Set<(frame: { type: "data" | "exit"; payload: string }) => void>;
  exited: boolean;
  exitCode: number | null;
};

export class TerminalManager {
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
    // First candidate that exists: $SHELL on macOS/desktop machines, then
    // zsh, then bash (ubuntu CI and slim linux images have no zsh).
    const shell = [process.env.SHELL, "/bin/zsh", "/bin/bash"].find(
      (candidate) => candidate && existsSync(candidate),
    ) ?? "/bin/bash";
    const entry: TerminalEntry = {
      pty: ptySpawn(shell, ["-l"], {
        name: "xterm-256color",
        cols: clampCols(cols),
        rows: clampRows(rows),
        cwd: workspace,
        env: { ...process.env } as Record<string, string>,
      }),
      sessionId,
      listeners: new Set(),
      exited: false,
      exitCode: null,
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
      // Coalesce rapid pty chunks into one frame each ~16ms so a chatty
      // process cannot flood the SSE channel with per-byte events.
      if (!timer) timer = setTimeout(flush, OUTPUT_COALESCE_MS);
    });
    entry.pty.onExit(({ exitCode }) => {
      if (timer) clearTimeout(timer);
      entry.exited = true;
      entry.exitCode = exitCode;
      for (const listener of entry.listeners) listener({ type: "exit", payload: String(exitCode) });
      entry.listeners.clear();
      this.terminals.delete(id);
    });
    this.terminals.set(id, entry);
    return { id };
  }

  private entry(sessionId: string, id: string): TerminalEntry {
    const entry = this.terminals.get(id);
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error(`no such terminal in this session: ${id}`);
    }
    return entry;
  }

  exists(sessionId: string, id: string): boolean {
    const entry = this.terminals.get(id);
    return entry !== undefined && entry.sessionId === sessionId && !entry.exited;
  }

  subscribe(sessionId: string, id: string, listener: (frame: { type: "data" | "exit"; payload: string }) => void): () => void {
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
    if (!entry.exited) entry.pty.resize(clampCols(cols), clampRows(rows));
  }

  exit(sessionId: string, id: string): void {
    const entry = this.entry(sessionId, id);
    if (!entry.exited) entry.pty.kill();
    this.terminals.delete(id);
  }

  killSession(sessionId: string): void {
    for (const [id, entry] of this.terminals) {
      if (entry.sessionId === sessionId) {
        if (!entry.exited) entry.pty.kill();
        this.terminals.delete(id);
      }
    }
  }

  killAll(): void {
    for (const entry of this.terminals.values()) {
      if (!entry.exited) entry.pty.kill();
    }
    this.terminals.clear();
  }
}

function clampCols(cols: number): number {
  return Math.min(Math.max(Math.floor(cols) || 80, 2), 500);
}

function clampRows(rows: number): number {
  return Math.min(Math.max(Math.floor(rows) || 24, 2), 300);
}
