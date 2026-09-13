/**
 * Forge Guard — capability policy model (Amendment A-2, 9.6.4).
 *
 * Capability model (8 categories per the product spec): read / write / edit /
 * bash / delete / network / git / destructive. Each tool call is classified
 * into an ordered list of capabilities; rules match on (capability, optional
 * tool name, optional substring of the serialized args). First match wins;
 * otherwise the policy default applies. See docs/GUARDRAILS.md.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Capability =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "delete"
  | "network"
  | "git"
  | "destructive"
  | "unknown";

export type Decision = "allow" | "ask" | "deny";

export type GuardRule = {
  id?: string;
  capability: Capability;
  /** Optional: restrict the rule to these exact tool names. */
  tools?: string[];
  /** Optional: substring matched against JSON.stringify(input). */
  contains?: string;
  decision: Decision;
  /** For "deny": hint that the agent should stop after this tool batch. */
  terminate?: boolean;
};

export type GuardPolicy = {
  version: 1;
  default: Decision;
  rules: readonly GuardRule[];
};

export type DecisionOutcome = {
  action: Decision;
  capability: Capability;
  reason: string;
  ruleId?: string;
  terminate?: boolean;
};

/** Capability priority: destructive > network > git > bash > write > edit > read. */
const CAPABILITY_PRIORITY: readonly Capability[] = [
  "destructive",
  "network",
  "git",
  "bash",
  "write",
  "edit",
  "read",
];

const READ_TOOLS = new Set(["read", "grep", "ls", "find"]);

/** System-destructive commands — denied by default. */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /(^|\s)sudo\s/,
  /(^|\s)mkfs\.?\S*/,
  /\bdd\s+of=\/dev\//,
  /(^|\s)(shutdown|reboot|poweroff)\b/,
  // "rm -rf /" (root) — but NOT "rm -rf /tmp/..." (the / must be followed by
  // a non-path character, i.e. it is the filesystem root).
  /\brm\s+(-rf|-fr)\s+\/(?![\w./-])/,
  /\brm\s+(-rf|-fr)\s+(\/\s*)?$/,
  // fork bomb: :(){ :|:& };:
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};?\s*:/,
  /\bgit\s+(push|reset|clean)\b.*(--force|-f\b)/,
];

/** Outbound-network commands — require approval by default. */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /(^|\s)(curl|wget|nc|ncat|telnet|ftp)\b/,
  /(^|\s)(ssh|scp|rsync)\b/,
];

const GIT_PATTERN = /(^|\s)git\b/;

/**
 * Defaults (9.6.5): the approval relay + Desktop UI are wired, so write/edit/
 * bash/network/git now ASK; read is allow; destructive is deny (+terminate).
 * User-overridable via ~/.forge/guard.json (FORGE_GUARD_POLICY).
 */
export const DEFAULT_POLICY: GuardPolicy = {
  version: 1,
  default: "ask",
  rules: [
    { id: "read-allow", capability: "read", decision: "allow" },
    { id: "destructive-deny", capability: "destructive", decision: "deny", terminate: true },
    { id: "git-read-status", capability: "git", contains: "status", decision: "allow" },
    { id: "git-read-diff", capability: "git", contains: "diff", decision: "allow" },
    { id: "git-read-log", capability: "git", contains: "log", decision: "allow" },
    { id: "git-read-show", capability: "git", contains: "show", decision: "allow" },
    { id: "git-read-branch", capability: "git", contains: "branch", decision: "allow" },
    // File writes are covered by the undo journal (restorable), so they do not
    // need interactive approval by default — this is the main noise reduction.
    { id: "write-allow", capability: "write", decision: "allow" },
    { id: "edit-allow", capability: "edit", decision: "allow" },
    { id: "git-ask", capability: "git", decision: "ask" },
    { id: "bash-ask", capability: "bash", decision: "ask" },
    { id: "network-ask", capability: "network", decision: "ask" },
  ],
};

/**
 * Read-only bash commands whitelisted through in the "default" approval mode
 * (PM, 2026-09-12: "默认（按白名单放行）").
 *
 * Conservative by construction: EVERY shell segment (split on &&, ||, ;, |,
 * newline) must start with a read-only binary; redirection, command
 * substitution and expansion disqualify the whole command; `find` may not
 * carry -delete/-exec; `git` only in read-only subcommands. Anything
 * uncertain asks — the whitelist must never be the reason something
 * destructive ran.
 */
const SAFE_BASH_BINARIES: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "pwd", "echo", "which", "where", "type",
  "find", "grep", "rg", "wc", "sort", "uniq", "diff", "stat", "file",
  "du", "df", "date", "whoami", "id", "env", "printenv", "cd",
  "true", "false",
]);

const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "branch", "remote", "rev-parse", "stash list",
]);

export function isSafeBash(command: unknown): boolean {
  if (typeof command !== "string" || command.trim().length === 0) return false;
  // Redirection writes files; substitution/expansion executes hidden code.
  if (/[><`$]/.test(command)) return false;
  const segments = command.split(/&&|\|\||;|\||\n/);
  for (const raw of segments) {
    const seg = raw.trim();
    if (seg.length === 0) continue;
    if (/\b(delete|exec)\b/.test(seg) && seg.startsWith("find")) return false;
    const tokens = seg.split(/\s+/);
    const bin = tokens[0] ?? "";
    if (bin === "git") {
      const sub = (tokens[1] ?? "") + (tokens[2] === "list" ? ` ${tokens[2]}` : "");
      if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    if (!SAFE_BASH_BINARIES.has(bin)) return false;
  }
  return true;
}

export function defaultPolicy(): GuardPolicy {
  return structuredClone(DEFAULT_POLICY);
}

/** Resolve the policy file path (env override or the user-level default). */
export function defaultPolicyPath(): string {
  const home = process.env.HOME ?? "/tmp";
  return process.env.FORGE_GUARD_POLICY ?? `${home}/.forge/guard.json`;
}

/** Load a policy file; falls back to defaults when missing/invalid. */
export function loadPolicy(path?: string): GuardPolicy {
  if (!path) return defaultPolicy();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return defaultPolicy();
  }
  if (!raw || typeof raw !== "object") return defaultPolicy();
  const obj = raw as Partial<GuardPolicy>;
  if (obj.version !== 1 || !Array.isArray(obj.rules)) return defaultPolicy();
  return {
    version: 1,
    default: obj.default === "allow" || obj.default === "deny" ? obj.default : "ask",
    rules: obj.rules.filter(
      (r): r is GuardRule =>
        !!r &&
        typeof r === "object" &&
        isCapability((r as GuardRule).capability) &&
        ((r as GuardRule).decision === "allow" ||
          (r as GuardRule).decision === "ask" ||
          (r as GuardRule).decision === "deny"),
    ),
  };
}

/**
 * Persist an "always allow" rule to the policy file. If the file does not
 * exist yet, it is seeded with the built-in defaults first so the protective
 * rules (destructive deny, read allow, ...) are never lost. Duplicate rules
 * (same capability + contains + decision) are skipped. Atomic write.
 */
export async function appendRule(opts: { path?: string; rule: GuardRule }): Promise<void> {
  const filePath = opts.path ?? defaultPolicyPath();
  const existing = loadPolicy(filePath);
  const dup = existing.rules.some(
    (r) =>
      r.capability === opts.rule.capability &&
      r.contains === opts.rule.contains &&
      r.decision === opts.rule.decision,
  );
  if (dup) return;
  const next: GuardPolicy = {
    version: 1,
    default: existing.default,
    rules: [...existing.rules, { ...opts.rule, id: opts.rule.id ?? `user-${Date.now().toString(36)}` }],
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, filePath);
}

function isCapability(c: unknown): c is Capability {
  return CAPABILITY_PRIORITY.includes(c as Capability) || (c as Capability) === "unknown";
}

/**
 * Build an "always allow" rule from an approval record's title/message.
 * The guard prompts with `Allow <toolName>?` and a JSON.stringify(input)
 * summary; parse those back into a contains-rule so the same operation is
 * allowed on subsequent calls. Falls back to a capability-wide allow when the
 * command cannot be extracted.
 */
export function ruleFromApproval(title: string | undefined, message: string | undefined): GuardRule | null {
  const toolMatch = /^Allow ([a-z_]+)\?/u.exec(title ?? "");
  const toolName = toolMatch?.[1];
  if (!toolName) return null;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(message ?? "{}") as Record<string, unknown>;
  } catch {
    input = {};
  }
  const caps = classifyCapabilities(toolName, input);
  const cap = caps[0];
  if (!cap || cap === "destructive" || cap === "unknown") return null; // never allow-always destructive ops
  const command = typeof input.command === "string" ? input.command.slice(0, 200) : undefined;
  const path = typeof input.path === "string" ? input.path.slice(0, 200) : undefined;
  const contains = command ?? path;
  const rule: GuardRule = { capability: cap, decision: "allow" };
  if (contains) rule.contains = contains;
  return rule;
}

/** Classify a tool call into ordered capabilities (highest priority first). */
export function classifyCapabilities(toolName: string, input: Record<string, unknown>): readonly Capability[] {
  if (READ_TOOLS.has(toolName)) return ["read"];
  if (toolName === "write") return ["write"];
  if (toolName === "edit") return ["edit"];
  if (toolName === "bash") {
    const cmd = typeof input.command === "string" ? input.command : JSON.stringify(input);
    const caps: Capability[] = [];
    if (DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd))) caps.push("destructive");
    if (NETWORK_PATTERNS.some((p) => p.test(cmd))) caps.push("network");
    if (GIT_PATTERN.test(cmd)) caps.push("git");
    caps.push("bash");
    return caps;
  }
  return ["unknown"];
}

/** Evaluate a tool call against the policy. */
export function evaluateToolCall(
  policy: GuardPolicy,
  toolName: string,
  input: Record<string, unknown>,
): DecisionOutcome {
  const caps = classifyCapabilities(toolName, input);
  const serialized = JSON.stringify(input);

  for (const cap of caps) {
    const scoped = policy.rules.filter(
      (r) =>
        r.capability === cap &&
        (!r.tools || r.tools.includes(toolName)),
    );
    // Specific rules (contains) always win over generic ones, so user-added
    // "always allow <command>" rules take precedence over a blanket ask/deny
    // for the same capability.
    const rule =
      scoped.find((r) => r.contains !== undefined && serialized.includes(r.contains)) ??
      scoped.find((r) => r.contains === undefined);
    if (rule) {
      const outcome: DecisionOutcome = {
        action: rule.decision,
        capability: cap,
        reason: describe(rule, toolName),
      };
      if (rule.id) outcome.ruleId = rule.id;
      if (rule.terminate) outcome.terminate = true;
      return outcome;
    }
  }

  return {
    action: policy.default,
    capability: caps[0] ?? "unknown",
    reason: `no rule matched (capability: ${caps[0] ?? "unknown"}); policy default`,
  };
}

function describe(rule: GuardRule, toolName: string): string {
  const where = rule.contains ? ` (${toolName} containing ${JSON.stringify(rule.contains)})` : ` (${toolName})`;
  return `forge-guard: ${rule.decision} by rule ${rule.id ?? `<${rule.capability}>`}${where}`;
}

/** Compact one-line summary of a tool call for approval UI. */
export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 300 ? `${s.slice(0, 297)}…` : s;
}
