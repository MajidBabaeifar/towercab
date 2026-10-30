// Protected paths (REPO-8, **Grammar** globs): the control files plus `TOWERCAB.md` `protected`,
// minus what the worker was granted (AUT-14). The guard asks `blocks` (PIP-29); the sandbox gets
// `denyWrite`.

import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import picomatch from "picomatch";

/** Files Towercab reads from the base branch, what runs on every push, and git's own directory. */
export const CONTROL = [
  "CLAUDE.md",
  "AGENTS.md",
  "REVIEW.md",
  "TOWERCAB.md",
  ".github/**",
  ".claude/**",
  ".git/**",
];

/** What makes a glob component not literal (`\` escapes the next character). */
const WILD = /[*?[{\\]/;
/** Characters a sandbox write entry can't contain. */
const SANDBOX_WILD = /[*?[]/;

/** A glob relative to the repo root: leading `./` and `/` and a trailing `/` dropped. */
function normalize(g: string): string {
  let s = g;
  for (;;) {
    if (s.startsWith("./")) s = s.slice(2);
    else if (s.startsWith("/")) s = s.slice(1);
    else break;
  }
  return s.replace(/\/+$/, "");
}

export type Matcher = (rel: string) => boolean;

/**
 * A protected, tests or granted glob: `*`, `?`, `[…]` stay inside one path component, `**` spans
 * them, `{a,b}` alternates, `\` escapes, dotfiles match, case-sensitive; `P/**` also matches `P`.
 * Empty, an empty, `.` or `..` component, or bad syntax → `bad glob "<g>"`.
 */
export function glob(g: string): Matcher {
  const bad = new Error(`bad glob "${g}"`);
  const norm = normalize(g);
  if (norm === "" || norm.split("/").some((c) => c === "" || c === "." || c === "..")) throw bad;
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(norm)) throw bad; // a dangling `\`
  const compile = (p: string): Matcher => {
    try {
      return picomatch(p, { dot: true, strictBrackets: true, nonegate: true });
    } catch {
      throw bad;
    }
  };
  const full = compile(norm);
  if (!norm.endsWith("/**")) return full;
  const parent = compile(norm.slice(0, -3));
  return (rel) => full(rel) || parent(rel);
}

/** Leading components of a normalized glob without wildcards. */
function literalPrefix(norm: string): string {
  const out: string[] = [];
  for (const c of norm.split("/")) {
    if (WILD.test(c)) break;
    out.push(c);
  }
  return out.join("/");
}

interface Rule {
  glob: string;
  match: Matcher;
  prefix: string;
}

function rule(key: string, g: string): Rule {
  let match: Matcher;
  try {
    match = glob(g);
  } catch (e) {
    throw new Error(`${key}: ${(e as Error).message}`);
  }
  const norm = normalize(g);
  return { glob: norm, match, prefix: literalPrefix(norm) };
}

/** The rule matches the path (components) or one of its parent directories. */
function covers(r: Rule, parts: string[]): boolean {
  for (let n = 1; n <= parts.length; n++) if (r.match(parts.slice(0, n).join("/"))) return true;
  return false;
}

/** The rule could match something inside directory `dir`. */
function mayReachInto(r: Rule, dir: string): boolean {
  const p = r.prefix;
  return p === "" || p === dir || p.startsWith(`${dir}/`) || dir.startsWith(`${p}/`);
}

/** `rel`'s components without empty and `.` ones; null for an absolute path or a `..`. */
function components(rel: string): string[] | null {
  if (rel.startsWith("/")) return null;
  const parts = rel.split("/").filter((c) => c !== "" && c !== ".");
  return parts.includes("..") ? null : parts;
}

/** Component-wise path order (so a directory sorts right before what is inside it). */
function byComponents(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function children(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The protected paths of one worker run. */
export class Protected {
  private protectedRules: Rule[];
  private grantedRules: Rule[];

  /** CONTROL + `protected` (TOWERCAB.md), minus `granted`. A bad glob → `<key>: bad glob "<g>"`. */
  constructor(protectedGlobs: string[], granted: string[]) {
    this.protectedRules = [...CONTROL, ...protectedGlobs].map((g) => rule("protected", g));
    this.grantedRules = granted.map((g) => rule("granted", g));
  }

  /**
   * The worker may not write repo-relative `rel`: a protected glob matches it or a parent directory
   * and no granted glob does. An absolute path, a `..` or `.git` → true.
   */
  blocks(rel: string): boolean {
    const parts = components(rel);
    if (!parts) return true;
    if (parts[0] === ".git") return true;
    return this.protectedRules.some((r) => covers(r, parts)) && !this.granted(parts);
  }

  private granted(parts: string[]): boolean {
    return this.grantedRules.some((r) => covers(r, parts));
  }

  /**
   * Absolute paths for the sandbox's `denyWrite`: per protected glob its literal path (`P` for
   * `P/**`), else what it matches under its literal prefix; existing paths only; granted entries
   * dropped and directories a granted glob may reach into split into their children (never
   * `.git`); sorted, none inside another, none containing `*`, `?` or `[` (left to the guard). A
   * checkout path containing one → an error: the run refuses rather than going unprotected.
   */
  denyWrite(checkout: string): string[] {
    const root = resolve(checkout);
    if (SANDBOX_WILD.test(root)) {
      throw new Error(`checkout ${root} contains *, ? or [: denyWrite can't name it`);
    }
    const found = new Set<string>();
    for (const r of this.protectedRules) {
      let literal: string | null = null;
      if (r.glob.endsWith("/**") && !WILD.test(r.glob.slice(0, -3))) literal = r.glob.slice(0, -3);
      else if (!WILD.test(r.glob)) literal = r.glob;
      if (literal !== null) {
        if (exists(join(root, literal))) found.add(literal);
      } else {
        walk(root, r.prefix, r.match, found);
      }
    }
    const out = new Set<string>();
    for (const rel of found) this.carve(root, rel, out);
    const kept: string[] = [];
    for (const rel of [...out].sort(byComponents)) {
      const last = kept[kept.length - 1];
      if (last !== undefined && (rel === last || rel.startsWith(`${last}/`))) continue;
      if (SANDBOX_WILD.test(rel)) continue;
      kept.push(rel);
    }
    return kept.map((rel) => join(root, rel));
  }

  /** `rel` unless granted; a directory a granted glob may reach into → its children, recursively. */
  private carve(root: string, rel: string, out: Set<string>): void {
    const parts = rel.split("/");
    if (parts[0] === ".git") {
      out.add(rel);
      return;
    }
    if (this.granted(parts)) return;
    if (isDir(join(root, rel)) && this.grantedRules.some((g) => mayReachInto(g, rel))) {
      for (const name of children(join(root, rel))) this.carve(root, `${rel}/${name}`, out);
    } else {
      out.add(rel);
    }
  }
}

/** Every entry under `prefix` that `m` matches; a matched directory isn't entered, no symlinks followed, `.git` skipped. */
function walk(root: string, prefix: string, m: Matcher, found: Set<string>): void {
  if (!isDir(join(root, prefix))) return;
  for (const name of children(join(root, prefix))) {
    if (name === ".git") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (m(rel)) found.add(rel);
    else if (isDir(join(root, rel))) walk(root, rel, m, found);
  }
}
