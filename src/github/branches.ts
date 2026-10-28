// Branches Towercab made for its PRs (PIP-86..89): who has PRs on one, and deleting it once its PR is
// closed. Merged branches are the repo setting's job (`delete_branch_on_merge`), not ours.

import type { GitHub } from "../handlers.ts";
import { check } from "../tools.ts";
import { isBot } from "./events.ts";

export interface BranchPr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** The login as `gh` prints it (`app/x`, `x`, `x[bot]`). */
  author: string;
}

/** The PRs, in any state, whose head is `branch` (`gh pr list --head`). */
export async function prsOnBranch(gh: GitHub, repo: string, branch: string): Promise<BranchPr[]> {
  const out = check(
    await gh.gh(repo, [
      "pr",
      "list",
      "-R",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,author",
    ]),
    "gh pr list",
  );
  const rows = JSON.parse(out) as { number: number; state: string; author?: { login?: string } }[];
  return rows.map((r) => ({
    number: r.number,
    state: r.state === "MERGED" ? "MERGED" : r.state === "CLOSED" ? "CLOSED" : "OPEN",
    author: r.author?.login ?? "",
  }));
}

/**
 * Whether Towercab may delete `branch` at all (PIP-89): its own `towercab/` namespace, and `plan/` in
 * the intents repo, where the plan PRs live.
 */
export function ownBranch(branch: string, inIntentsRepo: boolean): boolean {
  if (branch.includes("..") || branch.endsWith("/")) return false;
  return branch.startsWith("towercab/") || (inIntentsRepo && branch.startsWith("plan/"));
}

/**
 * Delete `branch` of `repo` as the App; a branch that is already gone counts as deleted. Refuses a
 * branch that isn't Towercab's (`ownBranch`), whoever asks.
 */
export async function deleteBranch(
  gh: GitHub,
  repo: string,
  branch: string,
  intentsRepo: string | null,
): Promise<void> {
  if (!ownBranch(branch, repo === intentsRepo)) {
    throw new Error(`refusing to delete ${branch} of ${repo}: not a Towercab branch`);
  }
  const r = await gh.gh(repo, ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
  if (
    r.code !== 0 &&
    /Reference does not exist|Not Found|HTTP 404|HTTP 422/i.test(`${r.stderr}${r.stdout}`)
  ) {
    return;
  }
  check(r, "gh api delete branch");
}

/**
 * After PR `n` of `repo` was closed without merge, delete its branch (PIP-87, PIP-88). Only if the App
 * opened the PR, the branch is Towercab's (`ownBranch`), and no other PR still uses it as its head (a
 * newer attempt may reuse the name). A PR that is open or merged is left; so is one from a fork.
 */
export async function retireBranch(
  gh: GitHub,
  repo: string,
  n: number,
  intentsRepo: string | null,
): Promise<string | null> {
  const view = JSON.parse(
    check(
      await gh.gh(repo, [
        "pr",
        "view",
        String(n),
        "-R",
        repo,
        "--json",
        "state,author,headRefName,isCrossRepository",
      ]),
      "gh pr view",
    ),
  ) as {
    state: string;
    author?: { login?: string };
    headRefName: string;
    isCrossRepository?: boolean;
  };
  if (view.state !== "CLOSED" || view.isCrossRepository) return null;
  if (!ownBranch(view.headRefName, repo === intentsRepo)) return null;
  if (!isBot(view.author?.login ?? "", (await gh.bot()).login)) return null;
  const others = await prsOnBranch(gh, repo, view.headRefName);
  if (others.some((p) => p.number !== n && p.state === "OPEN")) return null;
  await deleteBranch(gh, repo, view.headRefName, intentsRepo);
  return view.headRefName;
}
