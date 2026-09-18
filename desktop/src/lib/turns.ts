import type { TimelineEntry } from "../types.ts";

/**
 * Turn-process folding (DSH form): within a settled turn, tool rows and
 * informational notices collapse into one summary bar; the user's prompt, the
 * model's own words, and warning notices (stuck detection, failures) are never
 * folded. The live segment of a running session stays fully expanded — folding
 * only applies to history you are not watching being produced.
 */

export type UserEntry = Extract<TimelineEntry, { kind: "user" }>;
export type ToolEntry = Extract<TimelineEntry, { kind: "tool" }>;
export type NoticeEntry = Extract<TimelineEntry, { kind: "notice" }>;
export type AssistantEntry = Extract<TimelineEntry, { kind: "assistant" }>;

export type FoldableEntry = ToolEntry | NoticeEntry;

export interface TurnSegment {
  /** Stable key for expansion memory: the first entry's id. */
  id: string;
  head: UserEntry | null;
  /** Entries in original order; foldable runs are collapsed when settled. */
  entries: TimelineEntry[];
  /** A settled segment folds its tool/notice runs; a live one never does. */
  settled: boolean;
}

export function isFoldable(entry: TimelineEntry): entry is FoldableEntry {
  return entry.kind === "tool" || (entry.kind === "notice" && entry.tone !== "warn");
}

export function groupTurns(timeline: readonly TimelineEntry[], running: boolean): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let current: TurnSegment | null = null;
  for (const entry of timeline) {
    if (entry.kind === "user") {
      current = { id: entry.id, head: entry, entries: [entry], settled: true };
      segments.push(current);
      continue;
    }
    if (!current) {
      current = { id: entry.id, head: null, entries: [], settled: true };
      segments.push(current);
    }
    current.entries.push(entry);
  }
  // The last segment is the live one only while the session is running.
  if (segments.length > 0 && running) segments[segments.length - 1]!.settled = false;
  return segments;
}

/** Counts for the collapsed summary bar of one foldable run. */
export function summarizeFold(entries: readonly FoldableEntry[]): { tools: number; notices: number; errors: number } {
  const counts = { tools: 0, notices: 0, errors: 0 };
  for (const entry of entries) {
    if (entry.kind === "tool") {
      counts.tools += 1;
      if (entry.isError) counts.errors += 1;
    } else {
      counts.notices += 1;
    }
  }
  return counts;
}
