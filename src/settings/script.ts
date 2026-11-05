// `ci`'s settings script from the pinned release (REPO-25, REPO-30): the latest `v*` tag whose commit is on
// ci's base branch, exported to a scratch directory, never the clone's working tree or head.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Config, clonePath, type RepoConfig } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { Home } from "../home.ts";
import { repoGit } from "../repo/files.ts";
import type { RunResult, Tools } from "../tools.ts";

export interface SettingsDeps {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  github: GitHub;
  log(line: string): void;
  /** Holds the loop's clone lock around a fetch. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** The settings could not be checked or applied for a reason that is not the repo's gap. */
export class SettingsUnknown extends Error {}

export const CI_REPO = "ci";
export const SCRIPT_TIMEOUT_MS = 120_000;

export type Mode = "check" | "plan" | "apply" | "skip-ruleset";

export interface Script {
  tag: string;
  run(mode: Mode): Promise<RunResult>;
}

/** The highest `v*` tag reachable from `origin/<base>` of the ci clone, or null. */
export async function ciRelease(tools: Tools, clone: string, base: string): Promise<string | null> {
  const out = await repoGit(tools, clone, [
    "tag",
    "--list",
    "v*",
    "--merged",
    `refs/remotes/origin/${base}`,
    "--sort=-v:refname",
  ]);
  return (
    out
      .split("\n")
      .map((t) => t.trim())
      .find(Boolean) ?? null
  );
}

const ARGS: Record<Mode, (github: string) => string[]> = {
  check: (g) => ["--check", g],
  plan: (g) => ["--plan", g],
  apply: (g) => [g],
  "skip-ruleset": (g) => ["--skip-ruleset", g],
};

/**
 * Run `fn` with the pinned script of `repo`'s checks. It runs as the App with its token for the repo and
 * nothing else of the loop's environment, is given only that repo, and each run is logged with its tag.
 */
export async function withScript<T>(
  d: SettingsDeps,
  repo: RepoConfig,
  fn: (s: Script) => Promise<T>,
): Promise<T> {
  const ci = d.config.repos.get(CI_REPO);
  if (!ci) throw new SettingsUnknown("add the ci repo to Towercab");
  const dir = clonePath(ci, d.home.root);
  if (!existsSync(join(dir, ".git"))) throw new SettingsUnknown("the ci repo has no clone yet");
  let tag: string | null;
  try {
    tag = await ciRelease(d.tools, dir, ci.base);
  } catch (e) {
    throw new SettingsUnknown((e as Error).message);
  }
  if (!tag)
    throw new SettingsUnknown(
      "No ci release to run the standard settings from: tag a v* release on ci's main",
    );
  const tmp = join(d.home.root, "tmp");
  const tree = join(tmp, `ci-apply-${tag.replace(/[^\w.-]/g, "_")}`);
  const index = `${tree}.index`;
  mkdirSync(tmp, { recursive: true });
  rmSync(tree, { recursive: true, force: true });
  rmSync(index, { force: true });
  try {
    const gitEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) gitEnv[k] = v;
    gitEnv.GIT_INDEX_FILE = index;
    gitEnv.GIT_CEILING_DIRECTORIES = dirname(resolve(dir));
    for (const args of [
      ["read-tree", `refs/tags/${tag}`],
      ["checkout-index", "-a", "--prefix", `${tree}/`],
    ]) {
      const r = await d.tools.run("git", args, { cwd: dir, env: gitEnv, timeoutMs: SCRIPT_TIMEOUT_MS });
      if (r.code !== 0)
        throw new SettingsUnknown(`ci ${tag} could not be read: ${r.stderr.trim().split("\n")[0]}`);
    }
    const script = join(tree, "bin", "apply-settings");
    if (!existsSync(script)) throw new SettingsUnknown(`ci ${tag} has no bin/apply-settings`);
    const auth = await d.github.gitAuth(repo.github);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      ...auth.env,
    };
    return await fn({
      tag,
      run: (mode) => {
        d.log(
          `apply-settings ${tag} ${mode === "skip-ruleset" ? "apply --skip-ruleset" : mode} ${repo.github}`,
        );
        return d.tools.run(script, ARGS[mode](repo.github), { cwd: tree, env, timeoutMs: SCRIPT_TIMEOUT_MS });
      },
    });
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(index, { force: true });
  }
}

/** GitHub said no because the App can't change settings (not a network failure). */
export const forbidden = (r: RunResult): boolean =>
  /\b403\b|Resource not accessible|Must have admin rights/i.test(`${r.stderr}\n${r.stdout}`);

export const firstLine = (r: RunResult): string =>
  (r.stdout.trim().split("\n")[0] || r.stderr.trim().split("\n")[0] || `exit ${r.code}`).trim();
