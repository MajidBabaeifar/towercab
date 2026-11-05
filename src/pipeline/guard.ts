// The worker's guard (PIP-29, PIP-31): before a worker run Towercab writes `<runs>/guard.json`
// (`{version, checkout, protected, granted, locked, existing}`; another `version` is skew, LOOP-106);
// Claude Code's `PreToolUse` hook runs
// `towercab hook guard <runs>/guard.json` on every Edit, Write and NotebookEdit, which exits 2 with a
// reason to block. It fails closed. Publish refuses what got past it (`publishRefusals`).

import { appendFileSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative as relPath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHead } from "../head.ts";
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
export const ASK_TEST =
  "if you need it, carry on with everything that doesn't need it, note every guarded test you need and why, then return one status access listing them all";

/** PIP-137: why a held helper edit is put to the owner. */
export const HELPER_WHY = "changes existing helper code, not only additions";

/**
 * The shape of `guard.json` (LOOP-106). Raise it when a key is added or changes meaning: a hook that
 * reads another version refuses the file as skew, and the loop restarts and writes it again.
 */
export const GUARD_VERSION = 2;

/** What the hook says when the rules file is from another version. */
export const SKEW_REASON =
  "guard rules are from another version of Towercab; the loop is restarting, try again";

/** The rules file is from another version of Towercab than this hook (LOOP-106). */
export class GuardSkew extends Error {}

/** The checkout this code runs from: the hook's own. */
const HOOK_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A refusal for version skew, as the hook logs it to `guard-skew.jsonl`. */
export interface SkewLine {
  at: string;
  /** The version the rules file named, or null. */
  rulesVersion: number | null;
  hookVersion: number;
  hookCommit: string | null;
  hookCheckout: string;
}

/** The skew refusals logged next to the rules in `dir`, oldest first. */
export function readSkew(dir: string): SkewLine[] {
  let text: string;
  try {
    text = readFileSync(join(dir, "guard-skew.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: SkewLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SkewLine);
    } catch {
      // A torn line still counts that the hook refused: the next round starts clean anyway.
      out.push({
        at: "",
        rulesVersion: null,
        hookVersion: GUARD_VERSION,
        hookCommit: null,
        hookCheckout: "",
      });
    }
  }
  return out;
}

/** The hook's own refusals logged in `dir` (`guard-blocks.jsonl`): their reasons, oldest first. */
export function readGuardReasons(dir: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(dir, "guard-blocks.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    try {
      const r = (JSON.parse(line) as { reason?: unknown }).reason;
      if (typeof r === "string") out.push(r);
    } catch {
      // Not a log line.
    }
  }
  return out;
}

/** Forget the hook's logs before a worker run, so the next read says only what that run met. */
export function clearGuardLogs(dir: string): void {
  rmSync(join(dir, "guard-skew.jsonl"), { force: true });
  rmSync(join(dir, "guard-blocks.jsonl"), { force: true });
}

/** Write `<runsDir>/guard.json`; returns its path. `protected` gets CONTROL in front when missing. */
export function writeGuardRules(runsDir: string, rules: GuardRules): string {
  const file = join(runsDir, "guard.json");
  const prot = [...CONTROL.filter((c) => !rules.protected.includes(c)), ...rules.protected];
  writeFileSync(
    file,
    JSON.stringify({
      version: GUARD_VERSION,
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
  // The version comes first: a file from another version is skew, whatever else it lacks (LOOP-106).
  if (o.version !== GUARD_VERSION) {
    throw new GuardSkew(
      `${path}: rules version ${typeof o.version === "number" ? o.version : "none"}, this hook reads ${GUARD_VERSION}`,
    );
  }
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
  const log = (line: object): void => {
    try {
      appendFileSync(join(dirname(rulesPath), "guard-blocks.jsonl"), `${JSON.stringify(line)}\n`);
    } catch {
      // The block stands without its log line.
    }
  };
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
    const path = (toolInput as Record<string, unknown> | null)?.file_path ?? null;
    log({ at: new Date().toISOString(), path, reason });
  } catch (e) {
    if (e instanceof GuardSkew) {
      reason = SKEW_REASON;
      const rulesVersion = /rules version (\d+)/.exec(e.message)?.[1];
      appendSkew(rulesPath, {
        at: new Date().toISOString(),
        rulesVersion: rulesVersion === undefined ? null : Number(rulesVersion),
        hookVersion: GUARD_VERSION,
        hookCommit: readHead(HOOK_CHECKOUT),
        hookCheckout: HOOK_CHECKOUT,
      });
    } else {
      reason = `guard: ${(e as Error).message}: blocked`;
      log({ at: new Date().toISOString(), path: null, reason });
    }
  }
  return { code: 2, stderr: `${reason}\n` };
}

function appendSkew(rulesPath: string, line: SkewLine): void {
  try {
    appendFileSync(join(dirname(rulesPath), "guard-skew.jsonl"), `${JSON.stringify(line)}\n`);
  } catch {
    // The refusal stands without its log line.
  }
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
  heldHelpers: string[] = [],
): string[] {
  const bad = changed.filter((p) => protectedPaths.blocks(p)).map((p) => `${p} (protected)`);
  for (const { status, path } of sinceHead) {
    if (/^[MDT]/.test(status) && locked.includes(path)) bad.push(`${path} (a test already pushed)`);
  }
  for (const p of existingChanged) {
    if (!bad.some((b) => b.startsWith(`${p} `))) bad.push(`${p} (an existing test)`);
  }
  for (const p of heldHelpers) {
    if (!bad.some((b) => b.startsWith(`${p} `))) bad.push(`${p} (an existing helper)`);
  }
  return bad;
}

/** PIP-137: helpers are code files; a snapshot or fixture is never one, whatever it contains. */
const HELPER_CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** What marks a test case in a file (ERE, for `git grep -E`): `it(`, `test(`, `describe(` and other runners' forms. */
const TEST_CASE =
  "(^|[^[:alnum:]_.$])(it|test|describe)(\\.[[:alnum:]_]+)*[[:space:]]*[(`]|def test_|#\\[test\\]|func Test|@Test([^[:alnum:]_]|$)|fn test_";

/**
 * PIP-137: among `existing` (REPO-13), the helpers: code files at `origin/<base>` that hold no test
 * case, such as `tests/helpers/**`. A file with any test case is never one, so the guard stays
 * as it is for tests.
 */
export async function helperTests(
  tools: Tools,
  checkout: string,
  base: string,
  existing: string[],
): Promise<string[]> {
  const code = existing.filter((p) => HELPER_CODE.test(p));
  if (!code.length) return [];
  const ref = `refs/remotes/origin/${base}`;
  const r = await tools.run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "grep",
      "-l",
      "-z",
      "-I",
      "-E",
      "-e",
      TEST_CASE,
      ref,
    ],
    { cwd: checkout, timeoutMs: 300_000 },
  );
  // Exit 1 = no file has a test case.
  if (r.code !== 0 && r.code !== 1)
    throw new Error(`git grep ${ref}: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`);
  const withCases = new Set(
    r.stdout
      .split("\0")
      .filter(Boolean)
      .map((p) => p.slice(ref.length + 1)),
  );
  return code.filter((p) => !withCases.has(p));
}

const HELPER_START =
  /^(?:import\s+(?:type\s+)?[\w*{]|export\s+(?:async\s+)?function\b|export\s+(?:const|type|interface)\b)/;
const HELPER_CLOSE = /^[})\]]/;
const HELPER_COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
const HELPER_RUNS =
  /\b(?:vi\.(?:mock|doMock|hoisted|stubGlobal|stubEnv)|beforeEach|afterEach|beforeAll|afterAll)\b/;

/**
 * PIP-137: whether a `git diff -U0` of a helper is *free*: no line removed or changed, and every added
 * block is whole top-level statements, each a new import or exported function, type, interface or
 * constant. Mocks, hooks, other top-level code and indented lines at the start of a block (an edit
 * inside what is already there) are not. No diff is free.
 */
export function isFreeHelperDiff(diff: string): boolean {
  // A deleted file or a changed mode has no hunk to read, and is not an addition.
  if (/^(?:deleted file mode|old mode|new mode|rename |copy )/m.test(diff)) return false;
  let hunks = 0;
  let starts = true;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      hunks++;
      starts = true;
      continue;
    }
    if (hunks === 0 || line === "") continue;
    if (line.startsWith("-") || line.startsWith("\\")) return false;
    if (!line.startsWith("+")) continue;
    const t = line.slice(1);
    if (HELPER_RUNS.test(t)) return false;
    if (t.trim() === "" || HELPER_COMMENT.test(t)) continue;
    // The block must begin with a statement of its own, not in the middle of one.
    if (starts) {
      if (!HELPER_START.test(t)) return false;
      starts = false;
    } else if (!/^\s/.test(t) && !HELPER_START.test(t) && !HELPER_CLOSE.test(t)) {
      return false;
    }
  }
  return true;
}

/**
 * PIP-137: the helpers among `helpers` whose change in the checkout (committed or not, since the merge
 * base with `origin/<base>`) is not free and so is held; a helper that reads as on the base branch is
 * not changed (a merge brought it in). A deleted helper is held.
 */
export async function heldHelpers(
  tools: Tools,
  checkout: string,
  base: string,
  helpers: string[],
): Promise<string[]> {
  if (!helpers.length) return [];
  const ref = `refs/remotes/origin/${base}`;
  const run = async (args: string[], ok: number[] = [0]) => {
    const r = await tools.run(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      { cwd: checkout, timeoutMs: 300_000 },
    );
    if (r.code === null || !ok.includes(r.code))
      throw new Error(`git ${args[0]}: ${r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`);
    return r;
  };
  const mb = (await run(["merge-base", ref, "HEAD"])).stdout.trim();
  const changed = new Set((await run(["diff", "--name-only", "-z", mb])).stdout.split("\0").filter(Boolean));
  const held: string[] = [];
  for (const p of helpers.filter((h) => changed.has(h))) {
    if ((await run(["diff", "--quiet", ref, "--", p], [0, 1])).code === 0) continue;
    const diff = (await run(["diff", "-U0", "--no-color", mb, "--", p])).stdout;
    if (!isFreeHelperDiff(diff)) held.push(p);
  }
  return held;
}
