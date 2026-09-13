import { open, stat } from "node:fs/promises";
import { join } from "node:path";

export const EVENT_PROTOCOL_VERSION = 1;

export type EventEnvelope = {
  seq: number;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
};

type LineSink = (env: EventEnvelope) => void;

/**
 * Event Protocol v1 stream for one task.
 *
 * Source of truth is the append-only JSONL log written by the agent runner.
 * seq is the 1-based line number in that file — stable across reconnects and
 * process restarts, so clients can dedupe replay/live overlap by seq.
 *
 * Replay: full history is emitted first, then the tail follows appends.
 */
export class TaskEventStream {
  private offset = 0;
  private nextSeq = 1;
  private closed = false;

  constructor(
    private readonly eventsDir: string,
    private readonly sessionId: string,
  ) {}

  private filePath(): string {
    return join(this.eventsDir, `${this.sessionId}.events.jsonl`);
  }

  stop(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Emit all existing events, then keep following appends until stop(). */
  async follow(sink: LineSink): Promise<void> {
    await this.drainFile(sink);
    while (!this.closed) {
      await sleep(250);
      if (this.closed) return;
      await this.drainFile(sink);
    }
  }

  private async drainFile(sink: LineSink): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.filePath())).size;
    } catch {
      return;
    }
    if (size === this.offset) return;
    if (size < this.offset) {
      this.offset = 0;
      this.nextSeq = 1;
    }

    const fh = await open(this.filePath(), "r");
    try {
      const length = size - this.offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, this.offset);

      let text = buf.toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      // Do not consume an unterminated JSONL record. The writer may still be
      // appending it; advancing to `size` here would permanently discard the
      // prefix and make the next drain start in the middle of JSON.
      if (lastNewline === -1) return;
      text = text.slice(0, lastNewline + 1);
      this.offset += Buffer.byteLength(text, "utf8");

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let parsed: { at?: unknown; type?: unknown; payload?: unknown };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        sink({
          seq: this.nextSeq++,
          timestamp: typeof parsed.at === "number" ? parsed.at : Date.now(),
          type: typeof parsed.type === "string" ? parsed.type : "UNKNOWN",
          payload: (parsed.payload ?? {}) as Record<string, unknown>,
        });
      }
    } finally {
      await fh.close();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}
