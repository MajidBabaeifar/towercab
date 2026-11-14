// LOOP-138, LOOP-139: stale git locks are removed at start, and the intents repo is synced before the
// first pass.

import { existsSync, lstatSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type GitProc, removeStaleLocks } from "../src/locks.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { git, pushFiles, tempDir } from "./helpers/world.ts";

const NOW = 1_800_000_000;

/** A git repo with one commit. */
function repo(): string {
  const dir = tempDir("tc-lock-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "seed");
  return dir;
}

/** A file `ageS` seconds old at NOW. */
function aged(path: string, ageS: number): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  utimesSync(path, NOW - ageS, NOW - ageS);
  return path;
}

function run(roots: string[], procs: GitProc[] = []): string[] {
  const logs: string[] = [];
  removeStaleLocks({ roots, now: NOW, log: (l) => logs.push(l), procs: () => procs });
  return logs;
}

test("start: a stale index.lock in a clone is removed and logged", () => {
  const clone = repo();
  const lock = aged(join(clone, ".git", "index.lock"), 600);
  // A git process somewhere else does not hold it.
  const logs = run([clone], [{ pid: 7, cwd: tempDir("tc-else-") }]);
  expect(existsSync(lock)).toBe(false);
  expect(logs).toEqual([`start: removed stale lock ${lock}`]);
});

test("start: stale locks in a checkout and its worktree entry are removed", () => {
  const clone = repo();
  const wt = join(tempDir("tc-wt-"), "wt");
  git(clone, "worktree", "add", "-q", "-b", "other", wt);
  const entry = join(clone, ".git", "worktrees", "wt", "index.lock");
  const ref = join(clone, ".git", "refs", "heads", "other.lock");
  const checkout = repo();
  const inCheckout = join(checkout, ".git", "refs", "heads", "x.lock");
  for (const p of [entry, ref, inCheckout]) aged(p, 600);
  const logs = run([clone, checkout]);
  expect([entry, ref, inCheckout].map(existsSync)).toEqual([false, false, false]);
  expect(logs).toHaveLength(3);
});

test("start: a lock younger than 2 minutes is kept", () => {
  const clone = repo();
  const lock = aged(join(clone, ".git", "index.lock"), 30);
  const logs = run([clone]);
  expect(existsSync(lock)).toBe(true);
  expect(logs).toEqual([`start: kept lock ${lock} (younger than 2 minutes)`]);
});

test("start: a lock is kept while a git process runs in a subfolder of its checkout", () => {
  const clone = repo();
  const lock = aged(join(clone, ".git", "index.lock"), 600);
  const sub = join(clone, "src", "deep");
  mkdirSync(sub, { recursive: true });
  const logs = run([clone], [{ pid: 7, cwd: sub }]);
  expect(existsSync(lock)).toBe(true);
  expect(logs).toEqual([`start: kept lock ${lock} (git process 7 running in ${sub})`]);
});

test("start: a lock is kept while a git process runs in another worktree of the same clone", () => {
  const clone = repo();
  const wt = join(tempDir("tc-wt-"), "wt");
  git(clone, "worktree", "add", "-q", "-b", "other", wt);
  const lock = aged(join(clone, ".git", "index.lock"), 600);
  const sub = join(wt, "sub");
  mkdirSync(sub);
  run([clone], [{ pid: 8, cwd: sub }]);
  expect(existsSync(lock)).toBe(true);
});

test("start: a lock is kept when a process directory cannot be read", () => {
  const clone = repo();
  const lock = aged(join(clone, ".git", "index.lock"), 600);
  const logs = run([clone], [{ pid: 9, cwd: null }]);
  expect(existsSync(lock)).toBe(true);
  expect(logs[0]).toContain("git process 9 running in a directory that can't be read");
});

test("start: files outside git directories are never removed", () => {
  const clone = repo();
  const notes = aged(join(clone, "notes.lock"), 600);
  const home = aged(join(clone, "towercab.lock"), 600);
  const logs = run([clone]);
  expect([notes, home].map(existsSync)).toEqual([true, true]);
  expect(logs).toEqual([]);
});

test("start: a symbolic link named like a lock is kept", () => {
  const clone = repo();
  const target = aged(join(tempDir("tc-target-"), "precious"), 600);
  const link = join(clone, ".git", "index.lock");
  symlinkSync(target, link);
  run([clone]);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(existsSync(target)).toBe(true);
});

const files = (id: string) => ({
  [`intents/${id}-t1/intent.md`]: intent({ title: "T1", repo: "web", u: 4, i: 4, extra: "" }),
});

test("start: the intents repo is synced before the first pass", async () => {
  const p = new Pipe(TARGET, files("261026-1000"));
  await p.start();
  // A killed stop left a stale lock; the owner pushed a new intent meanwhile.
  const lock = join(p.home.intents, ".git", "index.lock");
  aged(lock, 600);
  utimesSync(lock, p.clock.now() - 600, p.clock.now() - 600);
  pushFiles(p.bares.intents!, files("261026-1001"));
  expect(p.loop.intentOf("261026-1001")).toBeNull();
  // No real git process may hold the lock: the loop reads the process list through its deps.
  (p.loop as unknown as { d: { gitProcs?: () => GitProc[] } }).d.gitProcs = () => [];
  await p.loop.open();
  expect(existsSync(lock)).toBe(false);
  expect(p.logs).toContain(`start: removed stale lock ${lock}`);
  // Listed by `open` itself: no pass has run.
  expect(p.loop.intentOf("261026-1001")).not.toBeNull();
});

test("start: a failed intents sync does not stop the start", async () => {
  const p = new Pipe(TARGET, files("261026-1000"));
  await p.start(
    {},
    {
      wrapStore: (s) => {
        const w = Object.create(s);
        w.list = async () => {
          throw new Error("pull failed: unreachable");
        };
        return w;
      },
    },
  );
  expect(p.logs).toContain("intents: pull failed: unreachable");
  expect(p.db.meta("running")).not.toBeNull();
});
