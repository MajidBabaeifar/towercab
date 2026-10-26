// Claude runs (PIP-24, PIP-13, PIP-39, pipeline.md **Claude runs**): the files, argv, settings and
// environment of every `claude -p` Towercab starts, and what its result says.
//
// No user, project or local settings load (`--setting-sources ""`): a hook in the repo's
// `.claude/settings.json` would run outside the sandbox. The base branch's `CLAUDE.md` and the
// writing guide go into the system prompt file; the sandbox and the guard come from Towercab's own
// `--settings` file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appKeyPath, type Config } from "./config.ts";
import { classifyFailure } from "./faults.ts";
import { type Limit, limitOf } from "./limits.ts";
import { oneLine } from "./machine.ts";
import { type GuardRules, writeGuardRules } from "./pipeline/guard.ts";
import type { JsonSchema } from "./pipeline/schemas.ts";
import { Protected } from "./repo/protected.ts";
import type { ChildSpec } from "./tools.ts";

/** The prompt of a run resumed after a cut-off (a crash, a kill, a limit wait). */
export const CONTINUE = "Continue where you stopped.";

/** What `claude --resume` says when the session is gone. */
export const SESSION_GONE = "No conversation found with session ID";

/** Secret paths under HOME no run may read (PIP-24). */
export const SECRET_PATHS = [
  ".ssh",
  ".config/gh",
  ".aws",
  ".gnupg",
  ".config/towercab",
  ".claude/.credentials.json",
  ".netrc",
  ".git-credentials",
];

/** Which of SECRET_PATHS are files (the rest are directories). */
const SECRET_FILES = new Set([".claude/.credentials.json", ".netrc", ".git-credentials"]);

/** Sockets that reach the host's power, hidden when Unix sockets are allowed. */
export const HOST_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/run/dbus", "/run/user"];

/** Environment variables never passed to a run (LOOP-19). */
const TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** The writing guide (PIP-39), appended to every run's system file. */
export const WRITING_GUIDE = fileURLToPath(new URL("../prompts/writing.md", import.meta.url));

export type RunKind = "design" | "plan" | "worker" | "review";

export const RUN_KINDS: RunKind[] = ["design", "plan", "worker", "review"];

/** One `claude -p` run. */
export interface ClaudeRun {
  kind: RunKind;
  model: string;
  /** The mission checkout. */
  cwd: string;
  /** `<home>/runs/<intent>/`: the run's files. */
  runsDir: string;
  /** Its number among this kind's runs: `<kind>-<n>.*`. */
  n: number;
  /** On stdin. */
  prompt: string;
  /** `--json-schema`. */
  schema?: JsonSchema | null;
  /** `--session-id` (new), `--resume`, or neither. */
  session: { mode: "new" | "resume" | "none"; id: string };
  /** `--max-budget-usd`. */
  budgetUsd?: number | null;
  /** The base branch's `CLAUDE.md` (REPO-1); empty without one. */
  claudeMd: string;
  /** What the run may reach (AUT-14, `grantsFor`). */
  grants: { domains: string[]; paths: string[]; open: boolean };
  /** The worker's guard (PIP-29): written to `<runs>/guard.json`, its hook and denyWrite added. */
  guardRules?: GuardRules | null;
  /** `cacheEnv` (LOOP-34): the cache's variables, `[agent].env`, `[repos.<r>].env`. */
  cacheEnv: Record<string, string>;
  /** The repo cache directory: writable in the sandbox. */
  cache?: string | null;
  config: Config;
}

/** The fixed parts of a kind (the **Claude runs** table). */
export const KINDS: Record<RunKind, { tools: string; allowed: string[] }> = {
  design: { tools: "Read,Glob,Grep,Edit,Write", allowed: ["Read", "Glob", "Grep", "Edit(specs/**)"] },
  plan: {
    tools: "Read,Glob,Grep,Bash",
    allowed: [
      "Read",
      "Glob",
      "Grep",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git show:*)",
      "Bash(ls:*)",
    ],
  },
  worker: {
    tools: "Read,Edit,Write,Glob,Grep,Bash,WebFetch",
    allowed: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
  },
  review: {
    tools: "Read,Glob,Grep,Bash",
    allowed: ["Read", "Glob", "Grep", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"],
  },
};

/** A run's files under `runsDir`. */
export function runFiles(run: Pick<ClaudeRun, "kind" | "n" | "runsDir">): {
  prompt: string;
  stdout: string;
  stderr: string;
  settings: string;
  system: string;
} {
  const base = join(run.runsDir, `${run.kind}-${run.n}`);
  return {
    prompt: `${base}.prompt`,
    stdout: `${base}.json`,
    stderr: `${base}.err`,
    settings: join(run.runsDir, `settings-${run.kind}.json`),
    system: join(run.runsDir, `system-${run.kind}.md`),
  };
}

/** `--disallowedTools` of every run: no push, remote or config change, no gh, ssh, sudo, no secret read. */
export function disallowed(config: Config): string[] {
  const d = [
    "Bash(git push:*)",
    "Bash(git remote:*)",
    "Bash(git config:*)",
    "Bash(gh:*)",
    "Bash(ssh:*)",
    "Bash(sudo:*)",
  ];
  for (const p of SECRET_PATHS) d.push(SECRET_FILES.has(p) ? `Read(~/${p})` : `Read(~/${p}/**)`);
  // Towercab's own config and App key, wherever `--config` put them.
  for (const p of configSecrets(config)) d.push(`Read(/${p})`);
  return d;
}

/** The config file and `app.pem` next to it, absolute. */
export function configSecrets(config: Config): string[] {
  return [resolve(config.file), resolve(appKeyPath(config))];
}

/** The argv (PIP-24's order); the prompt goes on stdin. */
export function claudeArgv(run: ClaudeRun): string[] {
  const f = runFiles(run);
  const k = KINDS[run.kind];
  const a = [
    "claude",
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--append-system-prompt-file",
    f.system,
    "--settings",
    f.settings,
    "--model",
    run.model,
    "--tools",
    k.tools,
    "--allowedTools",
    ...k.allowed,
    "--disallowedTools",
    ...disallowed(run.config),
  ];
  if (run.session.mode === "new") a.push("--session-id", run.session.id);
  if (run.session.mode === "resume") a.push("--resume", run.session.id);
  if (run.budgetUsd) a.push("--max-budget-usd", String(run.budgetUsd));
  if (run.schema) a.push("--json-schema", JSON.stringify(run.schema));
  return a;
}

/**
 * The `--settings` file: the sandbox (secret paths unreadable; `<cwd>/.git`, blocked protected paths
 * and locked tests unwritable; the cache writable; the granted domains), WebFetch per granted domain
 * (any at a5), and the worker's guard hook.
 */
export function claudeSettings(
  run: ClaudeRun,
  o: { towercabExe: string; home: string },
): Record<string, unknown> {
  const denyRead = [...SECRET_PATHS.map((p) => join(o.home, p)), ...configSecrets(run.config)];
  if (run.config.agent.sandboxUnixSockets) denyRead.push(...HOST_SOCKETS);
  const denyWrite = [join(resolve(run.cwd), ".git")];
  if (run.guardRules) {
    const g = run.guardRules;
    for (const p of new Protected(g.protected, g.granted).denyWrite(g.checkout)) {
      if (!denyWrite.includes(p)) denyWrite.push(p);
    }
    for (const rel of g.locked) {
      const p = join(resolve(g.checkout), rel);
      if (!denyWrite.includes(p)) denyWrite.push(p);
    }
  }
  const filesystem: Record<string, unknown> = { denyRead, denyWrite };
  if (run.cache) filesystem.allowWrite = [resolve(run.cache)];
  const sandbox: Record<string, unknown> = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem,
  };
  const network: Record<string, unknown> = {};
  if (run.grants.domains.length) network.allowedDomains = [...run.grants.domains];
  if (run.config.agent.sandboxUnixSockets) network.allowAllUnixSockets = true;
  if (Object.keys(network).length) sandbox.network = network;
  const s: Record<string, unknown> = { sandbox };
  const allow = run.grants.domains.map((d) => `WebFetch(domain:${d})`);
  if (run.grants.open) allow.push("WebFetch(domain:*)");
  if (allow.length) s.permissions = { allow };
  if (run.guardRules) {
    const command = `${shellQuote(o.towercabExe)} hook guard ${shellQuote(join(run.runsDir, "guard.json"))}`;
    s.hooks = {
      PreToolUse: [{ matcher: "Edit|Write|NotebookEdit", hooks: [{ type: "command", command }] }],
    };
  }
  return s;
}

/** A run's whole environment: HOME, PATH = `[agent].path`, LANG, the cache env; never a GitHub token. */
export function claudeEnv(run: ClaudeRun, home: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    PATH: run.config.agent.path,
    LANG: process.env.LANG || "C.UTF-8",
    ...run.cacheEnv,
  };
  for (const t of TOKENS) delete env[t];
  return env;
}

/** The system prompt file: the base branch's `CLAUDE.md`, then the writing guide (PIP-39). */
export function systemText(claudeMd: string): string {
  const guide = readFileSync(WRITING_GUIDE, "utf8");
  const md = claudeMd.trimEnd();
  return md ? `${md}\n\n${guide}` : guide;
}

/**
 * Writes the run's files (`<kind>-<n>.prompt`, `system-<kind>.md`, `settings-<kind>.json`, and for
 * the worker `guard.json`), then returns its child: cwd the checkout, prompt on stdin, output to
 * `<kind>-<n>.json` and `.err`, its kind's timeout, a slot. `home` is the user's HOME.
 */
export function prepareRun(run: ClaudeRun, o: { towercabExe: string; home: string }): ChildSpec {
  const f = runFiles(run);
  mkdirSync(run.runsDir, { recursive: true });
  if (run.guardRules) writeGuardRules(run.runsDir, run.guardRules);
  writeFileSync(f.prompt, run.prompt);
  writeFileSync(f.system, systemText(run.claudeMd));
  writeFileSync(f.settings, JSON.stringify(claudeSettings(run, o), null, 2));
  const minutes =
    run.kind === "review" ? run.config.agent.reviewTimeoutMin : run.config.agent.buildTimeoutMin;
  return {
    kind: run.kind,
    argv: claudeArgv(run),
    cwd: run.cwd,
    env: claudeEnv(run, o.home),
    stdin: f.prompt,
    stdout: f.stdout,
    stderr: f.stderr,
    timeoutMs: minutes * 60_000,
    slot: true,
    model: run.model,
  };
}

/**
 * The prompt of a new session replacing a gone one (LOOP-7): where the work is.
 */
export function freshContext(
  branch: string,
  pr: string | null,
  intentMd: string,
  specIds: string[],
  planMd: string | null,
): string {
  return [
    "Your earlier session is gone; continue the work from the repo.",
    `Branch: ${branch}`,
    `PR: ${pr ?? "none yet"}`,
    `Intent: ${intentMd}`,
    `Spec IDs: ${specIds.length ? specIds.join(", ") : "none yet"}`,
    `Plan: ${planMd ?? "none yet"}`,
    "Read them, check what is done with git log and git diff, then go on.",
  ].join("\n");
}

/** Token counts and cost of one model in a run (`modelUsage`). */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/** The `-p` JSON result. */
export interface ClaudeResult {
  /** `success`, `error_max_budget_usd`, `error_during_execution`, …. */
  subtype: string;
  isError: boolean;
  result: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  structuredOutput: unknown;
  permissionDenials: unknown[];
  modelUsage: Record<string, ModelUsage>;
}

/** How a run ended; a failed one is, first match: session gone, limit, env, budget, denied, no result, failed. */
export type RunEnd =
  | { kind: "ok"; result: ClaudeResult }
  | { kind: "sessionGone" }
  | { kind: "limit"; limit: Limit }
  | { kind: "env"; fault: "network" | "auth"; text: string }
  | { kind: "budget"; result: ClaudeResult }
  | { kind: "denied"; result: ClaudeResult; what: string }
  | { kind: "noResult"; why: string }
  | { kind: "failed"; why: string; result: ClaudeResult | null };

/** One short line: why a run ended so. */
export function runEndLine(e: RunEnd): string {
  switch (e.kind) {
    case "ok":
      return "ok";
    case "sessionGone":
      return "session gone";
    case "limit":
      return `usage limit: ${e.limit.text}`;
    case "env":
      return `${e.fault === "auth" ? "login" : "network"}: ${e.text}`;
    case "budget":
      return "budget used up";
    case "denied":
      return `denied: ${e.what}`;
    case "noResult":
      return `no result: ${e.why}`;
    case "failed":
      return `failed: ${e.why}`;
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function isResult(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>).type === "result"
  );
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** The last stdout line that is a `type: "result"` object (or all of stdout, pretty-printed). */
export function resultOf(stdout: string): ClaudeResult | string {
  const lines = stdout.split("\n").reverse();
  let found: Record<string, unknown> | undefined;
  for (const l of lines) {
    const v = tryJson(l.trim());
    if (isResult(v)) {
      found = v;
      break;
    }
  }
  if (!found) {
    const v = tryJson(stdout.trim());
    if (isResult(v)) found = v;
  }
  if (!found) return stdout.trim() ? `no JSON result: ${oneLine(stdout, 300)}` : "no result";
  const usage: Record<string, ModelUsage> = {};
  const mu = found.modelUsage;
  if (typeof mu === "object" && mu !== null) {
    for (const [m, u] of Object.entries(mu as Record<string, Record<string, unknown>>)) {
      usage[m] = {
        inputTokens: num(u.inputTokens ?? u.input_tokens),
        outputTokens: num(u.outputTokens ?? u.output_tokens),
        cacheReadInputTokens: num(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
        cacheCreationInputTokens: num(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
        costUsd: num(u.costUSD ?? u.cost_usd),
      };
    }
  }
  return {
    subtype: str(found.subtype),
    isError: found.is_error === true,
    result: str(found.result),
    sessionId: str(found.session_id),
    costUsd: num(found.total_cost_usd),
    durationMs: num(found.duration_ms),
    structuredOutput: found.structured_output ?? null,
    permissionDenials: Array.isArray(found.permission_denials) ? found.permission_denials : [],
    modelUsage: usage,
  };
}

const GIT_PUSH = /(?:^|[\s;&|(`])git\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/;

function strings(v: unknown, out: string[]): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** A `permission_denials` entry that fails the step: a `git push`, or a secret path read. Null = not fatal. */
export function fatalDenial(d: unknown, home: string): string | null {
  const o = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
  const texts = strings(o.tool_input ?? d, []);
  if (o.tool_name === "Bash" && texts.some((t) => GIT_PUSH.test(t))) return "a git push";
  for (const p of SECRET_PATHS) {
    const abs = home ? join(home, p) : null;
    if (texts.some((t) => (abs !== null && t.includes(abs)) || t.includes(`~/${p}`)))
      return `a read of ~/${p}`;
  }
  return null;
}

/**
 * What a run's stdout, stderr and exit say (pipeline.md **Claude runs**), first match: session gone,
 * a usage limit (LOOP-9), network or auth (LOOP-10), budget used up, a denied push or secret read, no
 * valid result, another failure, else ok. `exit` null: killed or lost.
 */
export function parseRun(
  stdout: string,
  stderr: string,
  exit: number | null,
  o: { model?: string; now?: Date; zone?: string; home?: string } = {},
): RunEnd {
  if (stderr.includes(SESSION_GONE)) return { kind: "sessionGone" };
  const r = resultOf(stdout);
  const result = typeof r === "string" ? null : r;
  const failed = exit !== 0 || result?.isError === true;
  const said = result?.result ?? "";
  const limit = limitOf(o.model ?? "", failed, said, stderr, o.now ?? new Date(), o.zone);
  if (limit) return { kind: "limit", limit };
  if (failed) {
    for (const t of [said, stderr]) {
      const fault = classifyFailure(t);
      if (fault) return { kind: "env", fault, text: oneLine(t, 300) };
    }
  }
  if (!result) {
    const line = stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    return { kind: "noResult", why: line ? `${r}; stderr: ${oneLine(line, 300)}` : (r as string) };
  }
  if (result.subtype === "error_max_budget_usd") return { kind: "budget", result };
  const home = o.home ?? process.env.HOME ?? "";
  for (const d of result.permissionDenials) {
    const what = fatalDenial(d, home);
    if (what) return { kind: "denied", result, what };
  }
  if (failed) {
    const firstErr = stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    const why = result.result.trim()
      ? result.result
      : result.subtype && result.subtype !== "success"
        ? result.subtype
        : (firstErr ?? "claude failed");
    return { kind: "failed", why: oneLine(why, 300), result };
  }
  return { kind: "ok", result };
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
