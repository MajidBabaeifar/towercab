// LOOP-138: git lock files that a killed process left in Towercab's own clones and checkouts.

import { type Dirent, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** A lock younger than this may belong to a call that has only just started. */
export const LOCK_MIN_AGE_S = 120;

/** A running git process; `cwd` is null when it can't be read. */
export interface GitProc {
  pid: number;
  cwd: string | null;
}

/** The running `git` processes, read from `/proc` (throws where there is none). */
export function gitProcesses(): GitProc[] {
  const out: GitProc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let comm: string;
    try {
      comm = readFileSync(`/proc/${name}/comm`, "utf8").trim();
    } catch {
      continue;
    }
    if (comm !== "git" && !comm.startsWith("git-")) continue;
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(`/proc/${name}/cwd`);
    } catch {
      // Not ours to read: it counts as inside every checkout.
    }
    out.push({ pid: Number(name), cwd });
  }
  return out;
}

export interface LockDeps {
  /** The roots of Towercab's own clones, checkouts and the intents clone (each has a `.git` directory). */
  roots: string[];
  /** The loop's wall clock, in seconds. */
  now: number;
  log(line: string): void;
  procs?: () => GitProc[];
}

/** The roots under a home: `repos/*`, `work/*`, `intents`, and the clones the config places elsewhere. */
export function lockRoots(home: string, intents: string, extra: string[]): string[] {
  const roots = new Set<string>([intents, ...extra]);
  for (const dir of ["repos", "work"]) {
    try {
      for (const e of readdirSync(join(home, dir), { withFileTypes: true })) {
        if (e.isDirectory()) roots.add(join(home, dir, e.name));
      }
    } catch {
      // No such folder yet.
    }
  }
  return [...roots].map((r) => resolve(r));
}

const inside = (dir: string, root: string): boolean => {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The root and its worktrees (`.git/worktrees/<name>/gitdir` names each one's `.git`). */
function group(root: string): string[] {
  const dirs = [root];
  const wt = join(root, ".git", "worktrees");
  try {
    for (const e of readdirSync(wt, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const gitdir = readFileSync(join(wt, e.name, "gitdir"), "utf8").trim();
        if (gitdir) dirs.push(dirname(gitdir));
      } catch {
        // A worktree entry without a readable gitdir file.
      }
    }
  } catch {
    // No worktrees.
  }
  return dirs;
}

/** Every `*.lock` entry under `dir` (not following links), skipping the object store. */
function locksUnder(dir: string, found: { path: string; regular: boolean; mtimeS: number }[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "objects") locksUnder(p, found);
    } else if (e.name.endsWith(".lock")) {
      try {
        const st = lstatSync(p);
        found.push({ path: p, regular: st.isFile(), mtimeS: st.mtimeMs / 1000 });
      } catch {
        // Gone already.
      }
    }
  }
}

/**
 * Remove the lock files in the git directories of `roots` that are older than 2 minutes while no git
 * process runs anywhere in their clone, its worktrees or their subfolders. Each decision is logged.
 */
export function removeStaleLocks(d: LockDeps): void {
  const found: { root: string; path: string; regular: boolean; mtimeS: number }[] = [];
  for (const root of d.roots) {
    const here: { path: string; regular: boolean; mtimeS: number }[] = [];
    locksUnder(join(root, ".git"), here);
    for (const l of here) found.push({ root, ...l });
  }
  if (found.length === 0) return;
  let procs: GitProc[];
  try {
    procs = (d.procs ?? gitProcesses)();
  } catch (e) {
    d.log(
      `start: kept ${found.length} lock file(s): the running git processes can't be read (${(e as Error).message})`,
    );
    return;
  }
  for (const l of found) {
    if (!l.regular) continue;
    if (d.now - l.mtimeS <= LOCK_MIN_AGE_S) {
      d.log(`start: kept lock ${l.path} (younger than 2 minutes)`);
      continue;
    }
    const dirs = group(l.root);
    const holder = procs.find((p) => p.cwd === null || dirs.some((r) => inside(p.cwd!, r)));
    if (holder) {
      const where = holder.cwd === null ? "a directory that can't be read" : holder.cwd;
      d.log(`start: kept lock ${l.path} (git process ${holder.pid} running in ${where})`);
      continue;
    }
    try {
      rmSync(l.path);
      d.log(`start: removed stale lock ${l.path}`);
    } catch (e) {
      d.log(`start: couldn't remove lock ${l.path}: ${(e as Error).message}`);
    }
  }
}
