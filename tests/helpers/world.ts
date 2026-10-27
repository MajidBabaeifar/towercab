// Test worlds: a temp home, a config, local bare git repos standing in for GitHub.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { type Config, parseConfig } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import type { Clock } from "../../src/handlers.ts";
import { Home } from "../../src/home.ts";

const made: string[] = [];

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A fresh temp directory, removed after the test. */
export function tempDir(prefix = "tc-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** A clock the test moves by hand. */
export class TestClock implements Clock {
  t: number;
  m: number;
  constructor(t = 1_793_000_000, m = 1_000_000) {
    this.t = t;
    this.m = m;
  }
  now(): number {
    return this.t;
  }
  mono(): number {
    return this.m;
  }
  advance(seconds: number): void {
    this.t += seconds;
    this.m += seconds * 1000;
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@localhost",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

/** A bare repo seeded with `files` on `branch`; returns its path (usable as a remote URL). */
export function bareRepo(files: Record<string, string>, branch = "main"): string {
  const root = tempDir("tc-remote-");
  const bare = join(root, "origin.git");
  const work = join(root, "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", branch, bare]);
  mkdirSync(work);
  git(work, "init", "-q", "-b", branch);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "--allow-empty", "-m", "seed");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", branch);
  return bare;
}

/** Commit `files` to `branch` of a bare repo (as the owner would push). */
export function pushFiles(
  bare: string,
  files: Record<string, string | null>,
  msg = "edit",
  branch = "main",
): void {
  const work = join(tempDir("tc-push-"), "w");
  git(dirname(work), "clone", "-q", "-b", branch, bare, work);
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(work, path), { force: true, recursive: true });
    else {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", msg);
  git(work, "push", "-q", "origin", branch);
}

/** A config from a partial TOML-shaped object (defaults for everything else). */
export function testConfig(
  raw: Record<string, unknown> = {},
  file = "/tmp/towercab-test/config.toml",
): Config {
  const base: Record<string, unknown> = {
    intents: { remote: "/nonexistent/intents.git" },
    github: { app_id: 1, me: "owner" },
    repos: { web: { github: "owner/web" } },
    ...raw,
  };
  return parseConfig(base, file);
}

export function testHome(): Home {
  return new Home(tempDir("tc-home-"));
}

export function testDb(): Db {
  return Db.memory();
}
