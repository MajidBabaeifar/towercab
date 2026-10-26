// Towercab's clone of a repo and the missions' checkouts (LOOP-8), and the shared cache (LOOP-34).
// The clone is only fetched into and pushed from. A checkout `work/<id>-<attempt>` has no remote:
// base is fetched into it by path, and Towercab pushes from its clone.

import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config, RepoConfig } from "./config.ts";
import { GIT_TIMEOUT_MS, type Tools } from "./tools.ts";

/** No hook or fsmonitor of the repo's runs ever runs in Towercab's git (LOOP-8). */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export interface GitAuth {
  args: string[];
  env: Record<string, string>;
}

/** The environment of Towercab's own git calls. */
export function gitEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["HOME", "PATH", "LANG", "SSH_AUTH_SOCK", "TMPDIR", "GIT_CONFIG_GLOBAL"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(resolve(dir)),
    ...extra,
  };
}

/** `git <args>` in `dir` → stdout; failure → `<dir>: <stderr>`. */
export async function git(tools: Tools, dir: string, args: string[], auth?: GitAuth): Promise<string> {
  const r = await tools.run("git", [...NO_HOOKS, ...(auth?.args ?? []), ...args], {
    cwd: dir,
    env: gitEnv(dir, auth?.env),
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.code === 0) return r.stdout;
  const err = r.stderr.trim() || `git ${args[0]} failed`;
  throw new Error(`${dir}: ${err}`);
}

/**
 * Whether a repo-local config key is one Towercab's clones and checkouts are made with. Anything
 * else (`filter.<x>.clean`, `core.sshCommand`, `include.path` …) could run code as Towercab.
 */
export function allowedKey(key: string): boolean {
  const exact = [
    "core.repositoryformatversion",
    "core.filemode",
    "core.bare",
    "core.logallrefupdates",
    "core.ignorecase",
    "core.precomposeunicode",
    "core.symlinks",
    "extensions.objectformat",
    "extensions.refstorage",
  ];
  if (exact.includes(key)) return true;
  const last = key.slice(key.lastIndexOf(".") + 1);
  if (key.startsWith("remote.")) return last === "url" || last === "fetch";
  if (key.startsWith("branch.")) return last === "remote" || last === "merge";
  return false;
}

/** The checkout's `.git` is a plain directory whose config Towercab wrote, else refused (LOOP-8). */
export async function sane(tools: Tools, dir: string): Promise<void> {
  const gitdir = join(dir, ".git");
  const refused = (why: string) => new Error(`${gitdir}: ${why}: refused`);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(gitdir);
  } catch (e) {
    throw refused(String((e as Error).message));
  }
  if (!st.isDirectory()) throw refused("not a directory");
  if (existsSync(join(gitdir, "commondir"))) throw refused("has a commondir");
  const keys = await git(tools, dir, [
    "config",
    "--file",
    join(gitdir, "config"),
    "--no-includes",
    "--list",
    "--name-only",
  ]);
  const bad = keys
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k && !allowedKey(k));
  if (bad.length > 0) throw refused(`config has ${bad.join(", ")}, not written by Towercab`);
}

/** `sane`, then `git`: Towercab's own git in a checkout after a run was there. */
export async function gitSane(tools: Tools, dir: string, args: string[], auth?: GitAuth): Promise<string> {
  await sane(tools, dir);
  return git(tools, dir, args, auth);
}

/** Towercab's clone of `repo` (cloned from GitHub when missing), then fetched. */
export async function ensureClone(
  tools: Tools,
  clone: string,
  repo: RepoConfig,
  auth?: GitAuth,
): Promise<void> {
  if (!existsSync(join(clone, ".git"))) {
    mkdirSync(dirname(clone), { recursive: true });
    rmSync(clone, { recursive: true, force: true });
    await git(tools, dirname(clone), ["clone", "--quiet", "--", originUrl(repo), clone], auth);
  }
  await git(tools, clone, ["fetch", "--quiet", "--prune", "origin"], auth);
}

export function originUrl(repo: RepoConfig): string {
  return `https://github.com/${repo.github}.git`;
}

/** Bring the clone's `origin/<base>` into the checkout, by path. */
export async function refreshBase(
  tools: Tools,
  clone: string,
  checkout: string,
  base: string,
): Promise<void> {
  await git(tools, checkout, [
    "fetch",
    "--quiet",
    clone,
    `+refs/remotes/origin/${base}:refs/remotes/origin/${base}`,
  ]);
}

/**
 * A new checkout of `clone` on `branch` from `origin/<base>`, without a remote: made in
 * `<checkout>.tmp` and renamed into place, so a crash never leaves a half-made one.
 */
export async function createCheckout(
  tools: Tools,
  clone: string,
  checkout: string,
  base: string,
  branch: string,
): Promise<void> {
  mkdirSync(dirname(checkout), { recursive: true });
  const tmp = `${checkout}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  await git(tools, dirname(checkout), ["clone", "--quiet", "--no-checkout", "--", clone, tmp]);
  await git(tools, tmp, ["remote", "remove", "origin"]);
  await refreshBase(tools, clone, tmp, base);
  await git(tools, tmp, ["checkout", "--quiet", "-B", branch, `refs/remotes/origin/${base}`]);
  renameSync(tmp, checkout);
}

/** A checkout with a valid HEAD. */
export async function validCheckout(tools: Tools, checkout: string): Promise<boolean> {
  if (!existsSync(join(checkout, ".git"))) return false;
  try {
    await git(tools, checkout, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Keep a valid checkout, else make it again. Returns true when it was made. */
export async function ensureCheckout(
  tools: Tools,
  clone: string,
  checkout: string,
  base: string,
  branch: string,
): Promise<boolean> {
  if (await validCheckout(tools, checkout)) return false;
  rmSync(checkout, { recursive: true, force: true });
  await createCheckout(tools, clone, checkout, base, branch);
  return true;
}

export function removeCheckout(checkout: string): void {
  rmSync(checkout, { recursive: true, force: true });
  rmSync(`${checkout}.tmp`, { recursive: true, force: true });
}

/** The shared build cache's environment for one repo (LOOP-34). */
export function cacheEnv(config: Config, repo: RepoConfig, cacheDir: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: join(cacheDir, "xdg"),
    npm_config_cache: join(cacheDir, "npm"),
    CARGO_HOME: join(cacheDir, "cargo"),
    CARGO_TARGET_DIR: join(cacheDir, "target"),
    GOCACHE: join(cacheDir, "go"),
    PIP_CACHE_DIR: join(cacheDir, "pip"),
    ...config.agent.env,
    ...repo.env,
  };
}
