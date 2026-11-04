// The worker's guard (PIP-29, PIP-31): before a worker run Towercab writes `<runs>/guard.json`
// (`{checkout, protected, granted, locked}`); Claude Code's `PreToolUse` hook runs
// `towercab hook guard <runs>/guard.json` on every Edit, Write and NotebookEdit, which exits 2 with a
// reason to block. It fails closed. Publish refuses what got past it (`publishRefusals`).

import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative as relPath, resolve } from "node:path";
import { CONTROL, glob, Protected } from "../repo/protected.ts";
import { type Live, withoutE2e } from "../ship/live.ts";
import type { Tools } from "../tools.ts";

/** What the guard knows of one worker run. */
export interface GuardRules {
  /** The mission checkout, absolute. */
  checkout: string;
  /** CONTROL + `TOWERCAB.md` `protected`. */
  protected: string[];
  /** Protected globs the worker was granted (AUT-14). */
  granted: string[];
  /** Repo-relative test files locked in repair rounds (PIP-31). */
  locked: string[];
  /** Repo-relative test files on the base branch that no grant covers (REPO-13). */
  existing: string[];
}

export type GuardDecision = { block: false } | { block: true; reason: string };

/** What a protected path's reason ends with: how the worker asks for it (AUT-15). */
export const ASK = "if you need it, finish what you can and return status access with this path and why";

/** What an existing test's reason ends with: how the worker asks for it (PIP-116). */
export const ASK_TEST = "if you need it, finish what you can and return status access with this test and why";

/** Write `<runsDir>/guard.json`; returns its path. `protected` gets CONTROL in front when missing. */
export function writeGuardRules(runsDir: string, rules: GuardRules): string {
  const file = join(runsDir, "guard.json");
  const prot = [...CONTROL.filter((c) => !rules.protected.includes(c)), ...rules.protected];
  writeFileSync(
    file,
    JSON.stringify({
      checkout: resolve(rules.checkout),
      protected: prot,
      granted: rules.granted,
      locked: rules.locked,
      existing: rules.existing,
    }),
  );
  return file;
}

/** The rules file, checked; a missing or malformed one throws. */
export function readGuardRules(path: string): GuardRules {
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof v !== "object" || v === null) throw new Error(`${path}: not an object`);
  const o = v as Record<string, unknown>;
  const list = (k: string): string[] => {
    const x = o[k];
    if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) throw new Error(`${path}: ${k} missing`);
    return x as string[];
  };
  if (typeof o.checkout !== "string" || !isAbsolute(o.checkout)) {
    throw new Error(`${path}: checkout missing or not absolute`);
  }
  return {
    checkout: o.checkout,
    protected: list("protected"),
    granted: list("granted"),
    locked: list("locked"),
    existing: list("existing"),
  };
}

/**
 * The guard's decision on a tool's input (`{file_path}` or `{notebook_path}`): a path outside the
 * checkout, a protected path not granted, or a locked test → blocked with the reason. No path → blocked.
 */
export function guardDecision(rules: GuardRules, toolInput: unknown): GuardDecision {
  const input = (typeof toolInput === "object" && toolInput !== null ? toolInput : {}) as Record<
    string,
    unknown
  >;
  const path = input.file_path ?? input.notebook_path;
  if (typeof path !== "string" || path === "")
    return { block: true, reason: "guard: no file path in the hook input" };
  const rel = relative(rules.checkout, path);
  if ("outside" in rel) return { block: true, reason: rel.outside };
  const prot = new Protected(rules.protected, rules.granted);
  if (prot.blocks(rel.rel)) {
    if (rel.rel === ".git" || rel.rel.startsWith(".git/")) {
      return { block: true, reason: `${rel.rel} is git's own directory: Towercab commits for you` };
    }
    return { block: true, reason: `${rel.rel} is protected: ${ASK}` };
  }
  if (rules.existing.includes(rel.rel)) {
    return { block: true, reason: `${rel.rel} is an existing test: ${ASK_TEST}` };
  }
  if (rules.locked.includes(rel.rel)) {
    return {
      block: true,
      reason: `${rel.rel} is a test already pushed: it is locked in repair rounds; fix the code, or add a new test file`,
    };
  }
  return { block: false };
}

/**
 * The path as the worker named it → repo-relative: the deepest existing ancestor resolved
 * (symlinks followed), the rest as written. Outside the checkout or through a dangling symlink →
 * the reason.
 */
function relative(checkout: string, path: string): { rel: string } | { outside: string } {
  const outside = { outside: `${path} is outside the checkout: only files in the checkout can be changed` };
  let root: string;
  try {
    root = realpathSync(checkout);
  } catch {
    root = resolve(checkout);
  }
  const full = isAbsolute(path) ? path : join(checkout, path);
  const rest: string[] = [];
  let cur = full;
  let resolved: string;
  for (;;) {
    let exists = false;
    let link = false;
    try {
      link = lstatSync(cur).isSymbolicLink();
      exists = true;
    } catch {
      // Not there yet.
    }
    if (exists) {
      try {
        resolved = realpathSync(cur);
        break;
      } catch {
        if (link)
          return {
            outside: `${path} goes through a dangling symlink: only files in the checkout can be changed`,
          };
      }
    }
    const parent = dirname(cur);
    if (parent === cur) {
      resolved = cur;
      break;
    }
    rest.unshift(cur.slice(parent.length).replace(/^\/+/, ""));
    cur = parent;
  }
  // `..` in the unresolved part stays and blocks (Protected.blocks).
  const rel = relPath(root, join(resolved, ...rest.filter((p) => p !== "")));
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return outside;
  return { rel };
}

/**
 * `towercab hook guard <rules>`: the hook's stdin (`{tool_name, tool_input}`) against the rules →
 * exit 0, or exit 2 with the reason on stderr (Claude Code shows it to the worker). Fails closed: an
 * unreadable rules file, bad input or any error → 2. Each block appends to `guard-blocks.jsonl`.
 */
export function runGuardHook(rulesPath: string, stdin: string): { code: number; stderr: string } {
  let reason: string;
  try {
    const rules = readGuardRules(rulesPath);
    let input: unknown;
    try {
      input = JSON.parse(stdin);
    } catch (e) {
      throw new Error(`bad hook input: ${(e as Error).message}`);
    }
    const toolInput =
      typeof input === "object" && input !== null ? (input as Record<string, unknown>).tool_input : null;
    const d = guardDecision(rules, toolInput);
    if (!d.block) return { code: 0, stderr: "" };
    reason = d.reason;
    try {
      const path = (toolInput as Record<string, unknown> | null)?.file_path ?? null;
      appendFileSync(
        join(dirname(rulesPath), "guard-blocks.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), path, reason })}\n`,
      );
    } catch {
      // The block stands without its log line.
    }
  } catch (e) {
    reason = `guard: ${(e as Error).message}: blocked`;
  }
  return { code: 2, stderr: `${reason}\n` };
}

/** The CLI's `hook guard <rules>`: reads stdin, writes the reason to stderr, returns the exit code. */
export function guardMain(argv: string[], stdin?: string): number {
  let input = stdin;
  if (input === undefined) {
    try {
      input = readFileSync(0, "utf8");
    } catch {
      input = "";
    }
  }
  const rulesPath = argv[0];
  const r = rulesPath
    ? runGuardHook(rulesPath, input)
    : { code: 2, stderr: "guard: no rules file: blocked\n" };
  if (r.stderr) process.stderr.write(r.stderr);
  return r.code;
}

/**
 * Test files at `head` (PIP-31's lock baseline: the head of the last non-repair round) matching the
 * `tests` globs (`TOWERCAB.md`, PIP-30), via `git ls-tree` in the checkout. No head → none.
 */
export async function lockedTests(
  tools: Tools,
  checkout: string,
  head: string | null,
  tests: string[],
): Promise<string[]> {
  if (!head) return [];
  const matchers = tests.flatMap((g) => {
    try {
      return [glob(g)];
    } catch {
      return [];
    }
  });
  const r = await tools.run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      head,
    ],
    { cwd: checkout, timeoutMs: 300_000 },
  );
  if (r.code !== 0)
    throw new Error(`git ls-tree ${head}: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`);
  return r.stdout.split("\0").filter((p) => p !== "" && matchers.some((m) => m(p)));
}

/**
 * REPO-13: the test files on the base branch (`refs/remotes/origin/<base>`) matching the `tests`
 * globs, without the e2e suites of a `live` block (as PIP-30 leaves them out).
 */
export async function existingTests(
  tools: Tools,
  checkout: string,
  base: string,
  tests: string[],
  live: Live | null,
): Promise<string[]> {
  return withoutE2e(await lockedTests(tools, checkout, `refs/remotes/origin/${base}`, tests), live);
}

/**
 * PIP-117: the paths among `blocked` that the branch modifies, deletes or retypes since the base
 * branch, leaving out those that read exactly as on the base (a merge of the base brought the change in).
 */
export async function existingChanged(
  tools: Tools,
  checkout: string,
  base: string,
  blocked: string[],
): Promise<string[]> {
  if (!blocked.length) return [];
  const ref = `refs/remotes/origin/${base}`;
  const r = await tools.run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      `${ref}...HEAD`,
    ],
    { cwd: checkout, timeoutMs: 300_000 },
  );
  if (r.code !== 0)
    throw new Error(`git diff ${ref}...HEAD: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`);
  const parts = r.stdout.split("\0");
  const touched: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (/^[MDT]/.test(parts[i]!) && blocked.includes(parts[i + 1]!)) touched.push(parts[i + 1]!);
  }
  const same = await sameAsBase(tools, checkout, ref, touched);
  return touched.filter((p) => !same.includes(p));
}

/**
 * PIP-31: the paths among `paths` whose content at `HEAD` is the base branch's (`baseRef`): a change
 * that came in by merging the base (a conflict round), not one the worker made.
 */
export async function sameAsBase(
  tools: Tools,
  checkout: string,
  baseRef: string,
  paths: string[],
): Promise<string[]> {
  const same: string[] = [];
  for (const p of paths) {
    const r = await tools.run(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "diff",
        "--quiet",
        baseRef,
        "HEAD",
        "--",
        p,
      ],
      { cwd: checkout, timeoutMs: 300_000 },
    );
    if (r.code === 0) same.push(p);
  }
  return same;
}

/**
 * What publish refuses (PIP-29, PIP-31): a changed path (since the merge base) that `protected`
 * blocks, and a locked test modified or deleted since the pushed head. Empty = fine.
 */
export function publishRefusals(
  changed: string[],
  protectedPaths: Protected,
  sinceHead: { status: string; path: string }[],
  locked: string[],
  existingChanged: string[] = [],
): string[] {
  const bad = changed.filter((p) => protectedPaths.blocks(p)).map((p) => `${p} (protected)`);
  for (const { status, path } of sinceHead) {
    if (/^[MDT]/.test(status) && locked.includes(path)) bad.push(`${path} (a test already pushed)`);
  }
  for (const p of existingChanged) {
    if (!bad.some((b) => b.startsWith(`${p} `))) bad.push(`${p} (an existing test)`);
  }
  return bad;
}
