// LOOP-153..155: the merge method of a repo. The one place that turns a repo's setting into the method a
// merge uses, merges with it, and words the warnings of `repo add` and `doctor`.

import type { RepoConfig } from "./config.ts";
import { isGitlab } from "./forge/types.ts";
import { type Forge, MERGE_METHOD, type MergeMethod, type Result } from "./forge.ts";

/** What `merge_method` may be set to. */
export type MergeSetting = NonNullable<RepoConfig["mergeMethod"]>;

export const MERGE_SETTINGS: readonly MergeSetting[] = ["squash", "merge", "rebase", "auto"];

/** What `auto` takes: squash or merge when the host allows one, rebase only when nothing else is allowed. */
export function autoMethod(allowed: readonly MergeMethod[] | null): MergeMethod {
  if (!allowed) return MERGE_METHOD;
  if (allowed.includes("squash")) return "squash";
  if (allowed.includes("merge")) return "merge";
  if (allowed.includes("rebase")) return "rebase";
  return MERGE_METHOD;
}

/** The repo Towercab knows by its host name, or undefined (the intents repo, a repo not added). */
function known(repos: ReadonlyMap<string, RepoConfig>, github: string): RepoConfig | undefined {
  for (const r of repos.values()) if (r.github === github) return r;
  return undefined;
}

/** The method `github`'s merges use now: its setting, with `auto` resolved; squash for GitLab and unknown repos. */
export async function resolveMergeMethod(
  forge: Forge,
  repos: ReadonlyMap<string, RepoConfig>,
  github: string,
): Promise<MergeMethod> {
  if (isGitlab(github)) return MERGE_METHOD;
  const setting = known(repos, github)?.mergeMethod ?? "squash";
  if (setting !== "auto") return setting;
  return autoMethod(await forge.allowedMergeMethods(github).catch(() => null));
}

const REFUSED = /not allowed on this repository/i;

/** LOOP-154: merge PR `n` of `github` by the repo's method; a refused method names the setting to change. */
export async function mergeWithRepoMethod(
  forge: Forge,
  config: { repos: ReadonlyMap<string, RepoConfig> },
  github: string,
  n: number,
  o: { head?: string; subject?: string; body?: string } = {},
): Promise<Result> {
  const method = await resolveMergeMethod(forge, config.repos, github);
  const r = await forge.mergePr(github, n, {
    method,
    ...(o.head ? { head: o.head } : {}),
    ...(o.subject ? { subject: o.subject } : {}),
    ...(o.body ? { body: o.body } : {}),
  });
  if (r.ok || !REFUSED.test(r.reason)) return r;
  const name = known(config.repos, github)?.name ?? github;
  return {
    ok: false,
    reason: `${method} merges are not allowed on ${github}: run towercab repo set ${name} merge_method=auto`,
  };
}

const list = (m: readonly MergeMethod[]) => (m.length ? m.join(", ") : "none");

/**
 * LOOP-155: the warnings for one repo, or none (also when the host's settings can't be read).
 * `allowed` is `Forge.allowedMergeMethods` of the repo.
 */
export function mergeMethodWarnings(repo: RepoConfig, allowed: readonly MergeMethod[] | null): string[] {
  if (isGitlab(repo.github) || allowed === null) return [];
  const setting = repo.mergeMethod ?? "squash";
  const out: string[] = [];
  let inForce: MergeMethod;
  if (setting === "auto") {
    inForce = autoMethod(allowed);
    if (allowed.length === 0) {
      out.push(
        `warning: ${repo.github} allows no merge method: allow squash, merge or rebase merges in its settings`,
      );
    }
  } else {
    inForce = setting;
    if (!allowed.includes(setting)) {
      out.push(
        `warning: ${repo.github} does not allow ${setting} merges (allowed: ${list(allowed)}): run towercab repo set ${repo.name} merge_method=auto`,
      );
    }
  }
  if (inForce === "rebase") {
    out.push(
      `warning: ${repo.name} merges by rebase: release notes rely on the repo's own commits following Conventional Commits`,
    );
  }
  return out;
}

/** The warning lines for `repo`, reading what the host allows; none when it can't be read. */
export async function readMergeWarnings(forge: Forge, repo: RepoConfig): Promise<string[]> {
  if (isGitlab(repo.github)) return [];
  const allowed = await forge.allowedMergeMethods(repo.github).catch(() => null);
  return mergeMethodWarnings(repo, allowed);
}
