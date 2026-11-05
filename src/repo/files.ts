// The repo files (REPO-1, 2, 4, 5, 10): `CLAUDE.md`'s verifying section, `REVIEW.md` and
// `TOWERCAB.md`, always read from the base branch of Towercab's own clone.

import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { isBranch } from "../config.ts";
import { type Live, parseLive } from "../ship/live.ts";
import type { Tools } from "../tools.ts";
import { bullets, fences, items, lines, sections, text } from "./markdown.ts";
import { glob } from "./protected.ts";
import { ITEMS, isItem, isKind, KINDS, type Kind, type Mode, type Waiver } from "./readiness.ts";

/** The three files, in the order they are parsed. */
export const FILES = ["CLAUDE.md", "REVIEW.md", "TOWERCAB.md"] as const;

export const VERIFYING_SECTION = "Verifying your work";

/** How to verify work in the repo (REPO-2, REPO-10). */
export interface Verifying {
  /** ` ```setup `: with network, after each clone and before checks. */
  setup: string[];
  /** ` ```checks `: the full suite, in order, without network. Never empty. */
  checks: string[];
  /** ` ```fast `: run before publish when the repo has CI (REPO-9); an empty block is `[]`. */
  fast: string[] | null;
  /** ` ```screenshots `: one command, run after green checks. */
  screenshots: string | null;
}

export interface Pass {
  name: string;
  what: string;
}

/** `REVIEW.md` (REPO-4). */
export interface Review {
  /** The whole file, given to the review; empty without one. */
  text: string;
  passes: Pass[];
  /** `## What Important means here`, trimmed. */
  important: string | null;
  /** `## Cap the nits`: its first number. */
  nitCap: number;
  doNotReport: string[];
  /** `## Red lines` bullets. */
  redLines: string[];
}

/** `TOWERCAB.md` front matter (REPO-1). */
export interface TowercabFile {
  maxAutonomy: number;
  /** Globs the worker can't write unless granted (REPO-8), as written. */
  protected: string[];
  /** Test file globs (PIP-30), as written. */
  tests: string[];
  /** The ship stage's block (SHIP-1), or null: merged means done. */
  live: Live | null;
  /** SHIP-31: `manual` when the owner merges the repo's release PRs by hand; absent means `auto`. */
  releases?: "manual";
  /** The confirmed kind (REPO-20); absent: unconfirmed. */
  kind?: Kind;
  /** `check` keeps the repo check-only when Towercab applies settings (REPO-31); absent: applied. */
  settings?: "check";
  /** `warn` (absent) or `block` (LOOP-70). */
  readiness?: Mode;
  /** Items the owner waived, with the reason (REPO-20); absent: none. */
  waive?: Waiver[];
  /** How an infra repo's changes go live (REPO-22). */
  goLive?: string;
  /** REPO-14: missions from build through merge at once; absent when the file doesn't say. */
  workers?: number;
  /** REPO-14: intents ahead of build; absent when the file doesn't say. */
  ahead?: number;
}

export interface RepoFiles {
  /** `CLAUDE.md` as written (every run's system file, PIP-24). */
  claudeMd: string;
  verifying: Verifying;
  review: Review;
  towercab: TowercabFile;
}

/** Why the repo files can't be used: no verifying block (REPO-5), an invalid file, or git failed. */
export class RepoError extends Error {
  readonly kind: "noVerifying" | "invalid" | "git";
  constructor(kind: "noVerifying" | "invalid" | "git", message: string) {
    super(message);
    this.kind = kind;
  }
  /** `waiting: add CLAUDE.md verifying block`. */
  static noVerifying(): RepoError {
    return new RepoError("noVerifying", "add CLAUDE.md verifying block");
  }
  /** `<file>: <where>: <what>` → `waiting: fix repo files`. */
  static invalid(message: string): RepoError {
    return new RepoError("invalid", message);
  }
  /** `<clone>: <stderr>`: retried. */
  static git(message: string): RepoError {
    return new RepoError("git", message);
  }
}

/** PIP-30's test globs, when `tests` is absent or empty. */
export const DEFAULT_TESTS = [
  "tests/**",
  "test/**",
  "**/__tests__/**",
  "**/*_test.*",
  "**/test_*.*",
  "**/*.test.*",
  "**/*.spec.*",
];

/** The passes when `## Passes` is missing or has no bullets. */
export const DEFAULT_PASSES: Pass[] = [
  {
    name: "Bugs",
    what: "wrong behaviour, unhandled errors, edge cases, tests that don't check the behaviour",
  },
  { name: "Security", what: "secrets in code or logs, injection, unsafe input handling, access checks" },
  {
    name: "Compliance",
    what: "the spec rows and the plan: every changed row is built and its tests check it; nothing outside the plan",
  },
];

export const DEFAULT_NIT_CAP = 5;

/** What the review leaves out when `REVIEW.md` doesn't say (REPO-12). */
export const DEFAULT_DO_NOT_REPORT = [
  "Files `.gitattributes` marks `linguist-generated`.",
  "Lockfiles (`package-lock.json`, `Cargo.lock`, `uv.lock` and the like).",
  "Formatting or lint issues a formatter or linter in the repo's checks would catch.",
];

export function defaultReview(): Review {
  return {
    text: "",
    passes: DEFAULT_PASSES.map((p) => ({ ...p })),
    important: null,
    nitCap: DEFAULT_NIT_CAP,
    doNotReport: [...DEFAULT_DO_NOT_REPORT],
    redLines: [],
  };
}

export function defaultTowercab(): TowercabFile {
  return {
    maxAutonomy: 5,
    protected: [],
    tests: [...DEFAULT_TESTS],
    live: null,
  };
}

/**
 * The files' texts (null = absent) → their contents; pure. `CLAUDE.md`, `REVIEW.md`, `TOWERCAB.md`
 * in that order, the first error wins.
 */
export function parseRepoFiles(
  claude: string | null,
  review: string | null,
  towercab: string | null,
): RepoFiles {
  if (claude === null) throw RepoError.noVerifying();
  return {
    claudeMd: claude,
    verifying: parseVerifying(claude),
    review: review === null ? defaultReview() : inFile("REVIEW.md", () => parseReview(review)),
    towercab: towercab === null ? defaultTowercab() : inFile("TOWERCAB.md", () => parseTowercab(towercab)),
  };
}

function inFile<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RepoError) throw e;
    throw RepoError.invalid(`${file}: ${(e as Error).message}`);
  }
}

/** `CLAUDE.md` → its verifying section. No section or no non-empty ` ```checks ` → `noVerifying`. */
export function parseVerifying(claude: string): Verifying {
  return inFile("CLAUDE.md", () => {
    const its = items(lines(claude));
    const [section] = sections(its, [VERIFYING_SECTION]);
    if (!section) throw RepoError.noVerifying();
    const [setup, checks, fast, screenshots] = fences(section, ["setup", "checks", "fast", "screenshots"]);
    if (!checks) throw RepoError.noVerifying();
    let shot: string | null = null;
    if (screenshots) {
      if (screenshots.body.length !== 1) {
        throw new Error(`screenshots: one command, got ${screenshots.body.length}`);
      }
      shot = screenshots.body[0]!;
    }
    // An empty ```fast block is a block (no local checks); `fences` skips empty ones.
    const emptyFast = section.some((i) => i.kind === "fence" && i.name === "fast");
    return {
      setup: setup ? [...setup.body] : [],
      checks: [...checks.body],
      fast: fast ? [...fast.body] : emptyFast ? [] : null,
      screenshots: shot,
    };
  });
}

const REVIEW_SECTIONS = ["Passes", "What Important means here", "Cap the nits", "Do not report", "Red lines"];

/** `REVIEW.md` → the review policy. */
export function parseReview(file: string): Review {
  const its = items(lines(file));
  const [passes, important, cap, doNot, red] = sections(its, REVIEW_SECTIONS);
  const b = passes ? bullets(passes) : [];
  let nitCap = DEFAULT_NIT_CAP;
  if (cap) {
    const digits = /[0-9]+/.exec(text(cap))?.[0];
    if (digits !== undefined) {
      nitCap = Number(digits);
      if (!Number.isSafeInteger(nitCap) || nitCap > 4_294_967_295) {
        throw new Error(`## Cap the nits: ${digits} is too large`);
      }
    }
  }
  const imp = important ? text(important).trim() : "";
  const skip = doNot ? bullets(doNot) : [];
  return {
    text: file,
    passes: b.length ? parsePasses(b) : DEFAULT_PASSES.map((p) => ({ ...p })),
    important: imp || null,
    nitCap,
    doNotReport: skip.length ? skip : [...DEFAULT_DO_NOT_REPORT],
    redLines: red ? bullets(red) : [],
  };
}

function parsePasses(bs: string[]): Pass[] {
  const trim = (s: string) => s.replace(/^[\s*_]+|[\s*_]+$/g, "");
  const out: Pass[] = [];
  for (const b of bs) {
    const at = b.indexOf(":");
    const name = at < 0 ? "" : trim(b.slice(0, at));
    const what = at < 0 ? "" : trim(b.slice(at + 1));
    if (!name || !what) throw new Error(`## Passes: want "<name>: <what>", got "${b}"`);
    if (out.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`## Passes: pass ${name} twice`);
    }
    out.push({ name, what });
  }
  return out;
}

const KEYS = [
  "workers",
  "ahead",
  "max_autonomy",
  "protected",
  "tests",
  "live",
  "releases",
  "kind",
  "readiness",
  "waive",
  "go_live",
  "settings",
];
const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]|$)/;

/** `TOWERCAB.md` → its front matter; anything after it is prose. */
export function parseTowercab(file: string): TowercabFile {
  const ls = lines(file);
  const t = defaultTowercab();
  let rest = 0;
  const open = ls.findIndex((l) => l.trim() !== "");
  if (open >= 0 && ls[open]!.trim() === "---") {
    const body = open + 1;
    const close = ls.slice(body).findIndex((l) => l.trim() === "---");
    if (close < 0) throw new Error("front matter: no closing ---");
    try {
      frontMatter(ls.slice(body, body + close), t);
    } catch (e) {
      throw new Error(`front matter: ${(e as Error).message}`);
    }
    rest = body + close + 1;
  }
  // A misplaced front matter is an error, never the defaults.
  for (const it of items(ls.slice(rest), rest + 1)) {
    if (it.kind !== "line") continue;
    const key = KEYS.find(
      (k) => it.text.startsWith(k) && it.text.slice(k.length).trimStart().startsWith(":"),
    );
    if (key) throw new Error(`line ${it.n}: ${key} outside front matter`);
  }
  return t;
}

function frontMatter(ls: string[], t: TowercabFile): void {
  const seen = new Set<string>();
  for (const l of ls) {
    const k = KEY.exec(l)?.[1];
    if (k === undefined) continue;
    if (seen.has(k)) throw new Error(`${k} twice`);
    seen.add(k);
  }
  const doc = YAML.parseDocument(ls.join("\n"), { uniqueKeys: false });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message.split("\n")[0]);
  const v: unknown = doc.toJS({ mapAsMap: true });
  if (v === null || v === undefined) return;
  if (!(v instanceof Map)) throw new Error("not a mapping");
  for (const [k, val] of v) {
    if (typeof k !== "string" || !KEYS.includes(k)) throw new Error(`unknown key ${String(k)}`);
    if (k === "max_autonomy") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > 5) {
        throw new Error("max_autonomy must be an integer 1-5");
      }
      t.maxAutonomy = val;
    } else if (k === "live") {
      t.live = parseLive(val);
    } else if (k === "workers" || k === "ahead") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > 16) {
        throw new Error(`${k}: ${String(val)} isn't a whole number from 1 to 16`);
      }
      t[k] = val;
    } else if (k === "releases") {
      if (val !== "auto" && val !== "manual") throw new Error("releases must be auto or manual");
      if (val === "manual") t.releases = "manual";
    } else if (k === "kind") {
      if (!isKind(val)) throw new Error(`kind: ${String(val)} isn't one of ${KINDS.join(", ")}`);
      t.kind = val;
    } else if (k === "settings") {
      if (val !== "check") throw new Error(`settings: ${String(val)} isn't check`);
      t.settings = "check";
    } else if (k === "readiness") {
      if (val !== "warn" && val !== "block") throw new Error(`readiness: ${String(val)} isn't warn or block`);
      t.readiness = val;
    } else if (k === "go_live") {
      if (typeof val !== "string" || !val.trim()) throw new Error("go_live: must be one non-empty line");
      t.goLive = val.trim();
    } else if (k === "waive") {
      t.waive = waivers(val);
    } else {
      const gs = globList(k, val);
      if (k === "protected") t.protected = gs;
      else if (gs.length) t.tests = gs;
    }
  }
}

/** `waive:` lines `<item>: <reason>` (YAML reads `- ci: why` as a one-entry mapping; both work). */
function waivers(v: unknown): Waiver[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("waive must be a list of `<item>: <reason>` lines");
  const out: Waiver[] = [];
  for (const entry of v) {
    let item: string;
    let reason: string;
    if (typeof entry === "string") {
      const at = entry.indexOf(":");
      item = at < 0 ? entry : entry.slice(0, at);
      reason = at < 0 ? "" : entry.slice(at + 1);
    } else if (entry instanceof Map && entry.size === 1) {
      const [k, r] = [...entry][0] as [unknown, unknown];
      item = String(k);
      reason = typeof r === "string" ? r : "";
    } else {
      throw new Error(`waive: ${JSON.stringify(entry)}: want "<item>: <reason>"`);
    }
    item = item.trim();
    reason = reason.trim();
    if (!isItem(item) || item === "kind") {
      throw new Error(`waive: ${item}: not an item (${ITEMS.filter((i) => i !== "kind").join(", ")})`);
    }
    if (!reason) throw new Error(`waive: ${item}: needs a reason`);
    out.push({ item, reason });
  }
  return out;
}

function globList(key: string, v: unknown): string[] {
  let list: string[];
  if (v === null || v === undefined) list = [];
  else if (typeof v === "string") list = [v];
  else if (Array.isArray(v) && v.every((x) => typeof x === "string")) list = v as string[];
  else throw new Error(`${key} must be a list of globs`);
  for (const g of list) {
    try {
      glob(g);
    } catch (e) {
      throw new Error(`${key}: ${(e as Error).message}`);
    }
  }
  return list;
}

/** `git` in Towercab's clone; discovery stops at the clone (a directory inside a repo is no clone). */
export async function repoGit(tools: Tools, clone: string, args: string[]): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(clone));
  const r = await tools.run("git", args, { cwd: clone, env, timeoutMs: 300_000 });
  if (r.code !== 0) {
    const err = r.stderr.trim();
    throw RepoError.git(`${clone}: ${err || `git ${args[0]} failed`}`);
  }
  return r.stdout;
}

export function checkBase(clone: string, base: string): void {
  if (!isBranch(base)) throw RepoError.git(`${clone}: bad base "${base}"`);
}

/**
 * The three files from `refs/remotes/origin/<base>` of Towercab's clone (never a working tree or a
 * PR; the caller fetches), then `parseRepoFiles`. Only regular files: a symlink, directory or
 * submodule in a file's place, or text that isn't UTF-8 → invalid.
 */
export async function loadRepoFiles(tools: Tools, clone: string, base: string): Promise<RepoFiles> {
  checkBase(clone, base);
  const listing = await repoGit(tools, clone, [
    "ls-tree",
    "-z",
    "--full-tree",
    `refs/remotes/origin/${base}`,
    "--",
    ...FILES,
  ]);
  const texts: (string | RepoError | null)[] = [null, null, null];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const name = entry.slice(tab + 1);
    const k = (FILES as readonly string[]).indexOf(name);
    if (k < 0) continue;
    const [mode, , oid] = entry.slice(0, tab).split(" ");
    const notFile = (what: string) => RepoError.invalid(`${name}: ${what}, not a file`);
    if (mode === "100644" || mode === "100755") {
      const body = await repoGit(tools, clone, ["cat-file", "blob", oid!]);
      // Output arrives decoded as UTF-8: invalid bytes show as U+FFFD.
      texts[k] = body.includes(REPLACEMENT) ? RepoError.invalid(`${name}: not UTF-8`) : body;
    } else if (mode === "120000") texts[k] = notFile("a symlink");
    else if (mode === "040000") texts[k] = notFile("a directory");
    else if (mode === "160000") texts[k] = notFile("a submodule");
    else texts[k] = notFile(`mode ${mode}`);
  }
  // In file order, the first error wins (a missing CLAUDE.md before a bad REVIEW.md).
  const [c, r, t] = texts;
  if (c instanceof RepoError) throw c;
  if (c === null || c === undefined) throw RepoError.noVerifying();
  const verifying = parseVerifying(c);
  for (const x of [r, t]) if (x instanceof RepoError) throw x;
  return { ...parseRepoFiles(c, (r as string | null) ?? null, (t as string | null) ?? null), verifying };
}

const REPLACEMENT = String.fromCharCode(0xfffd);
