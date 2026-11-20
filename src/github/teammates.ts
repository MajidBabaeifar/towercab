// What the teammate-review rules read of GitHub and git (PIP-142..147). The rules themselves are in
// `../teammates.ts`; anything that can't be read counts for fewer people, never for more.

import { git } from "../checkout.ts";
import type { RepoConfig } from "../config.ts";
import type { Forge, PrState } from "../forge.ts";
import type { GitHub } from "../handlers.ts";
import { CODEOWNERS_PATHS, FILES_LIMIT, type TeamInput } from "../teammates.ts";
import type { Tools } from "../tools.ts";
import { jsonStream } from "./prs.ts";

/** `CODEOWNERS` from the base branch (so a PR can't change its own owners); null when it can't be read. */
export async function readCodeowners(gh: GitHub, github: string, base: string): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const r = await gh.gh(github, [
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${github}/contents/${path}?ref=${encodeURIComponent(base)}`,
      ]);
      if (r.code === 0) return r.stdout;
    } catch {
      // A read that fails is no CODEOWNERS.
    }
  }
  return null;
}

/** The PR's changed paths (old names of renamed files too); null when unreadable or possibly cut off. */
export async function readFiles(gh: GitHub, github: string, n: number): Promise<string[] | null> {
  try {
    const r = await gh.gh(github, ["api", "--paginate", `repos/${github}/pulls/${n}/files?per_page=100`]);
    if (r.code !== 0) return null;
    const out: string[] = [];
    for (const page of jsonStream(r.stdout, "gh api files")) {
      if (!Array.isArray(page)) return null;
      for (const f of page as { filename?: unknown; previous_filename?: unknown }[]) {
        if (typeof f.filename === "string") out.push(f.filename);
        if (typeof f.previous_filename === "string") out.push(f.previous_filename);
      }
    }
    return out.length >= FILES_LIMIT ? null : out;
  } catch {
    return null;
  }
}

/** The ids of the PR's approving reviews (REST), which an inline review comment names (PIP-145). */
export async function readApprovedReviewIds(gh: GitHub, github: string, n: number): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const r = await gh.gh(github, ["api", "--paginate", `repos/${github}/pulls/${n}/reviews?per_page=100`]);
    if (r.code !== 0) return ids;
    for (const page of jsonStream(r.stdout, "gh api reviews")) {
      if (!Array.isArray(page)) continue;
      for (const v of page as { id?: unknown; state?: unknown }[]) {
        if (v.state === "APPROVED" && (typeof v.id === "number" || typeof v.id === "string")) {
          ids.add(String(v.id));
        }
      }
    }
  } catch {
    // Unreadable: the comments are then read as feedback, the stricter way for the worker is to hear them.
  }
  return ids;
}

/**
 * The approvals the host requires of the base branch (branch protection and rulesets); null when
 * neither can be read (no permission, 404), 0 when it can be read and asks for none (LOOP-84).
 */
export async function readRequired(gh: GitHub, github: string, base: string): Promise<number | null> {
  let required: number | null = null;
  const note = (n: number) => {
    required = Math.max(required ?? 0, n);
  };
  try {
    const p = await gh.gh(github, ["api", `repos/${github}/branches/${encodeURIComponent(base)}/protection`]);
    if (p.code === 0) {
      const v = JSON.parse(p.stdout) as {
        required_pull_request_reviews?: { required_approving_review_count?: number };
      };
      note(v.required_pull_request_reviews?.required_approving_review_count ?? 0);
    }
  } catch {
    // Unreadable.
  }
  try {
    const r = await gh.gh(github, ["api", `repos/${github}/rules/branches/${encodeURIComponent(base)}`]);
    if (r.code === 0) {
      const rules = JSON.parse(r.stdout) as {
        type?: string;
        parameters?: { required_approving_review_count?: number };
      }[];
      note(0);
      for (const x of rules) {
        if (x.type === "pull_request") note(x.parameters?.required_approving_review_count ?? 0);
      }
    }
  } catch {
    // Unreadable.
  }
  return required;
}

/** The rules' input for one PR: the setting, the PR and what the host says of its files and owners. */
export async function readTeamInput(
  forge: Forge,
  repo: RepoConfig,
  github: string,
  n: number,
  pr: PrState,
  bot: string,
): Promise<TeamInput> {
  const [codeowners, files] = await Promise.all([
    forge.codeowners(github, pr.base ?? repo.base),
    forge.changedPaths(github, n),
  ]);
  return {
    listed: repo.reviewers ?? [],
    me: forge.me,
    bot,
    author: pr.author ?? "",
    codeowners,
    files,
  };
}

/**
 * PIP-142: the older commits an approval was given on whose own changes equal the head's, i.e. the
 * same `git patch-id --stable` of the diff from the merge base. A commit that can't be read is left out
 * (its approval is stale): the approval is asked for again, never kept.
 */
export async function sameDiffCommits(o: {
  tools: Tools;
  github: Pick<GitHub, "gitAuth">;
  repo: string;
  clone: string;
  base: string;
  branch: string;
  head: string;
  commits: string[];
}): Promise<Set<string>> {
  const same = new Set<string>();
  const older = [...new Set(o.commits)].filter((c) => c !== o.head);
  if (older.length === 0) return same;
  const id = async (commit: string): Promise<string> => {
    const base = `refs/remotes/origin/${o.base}`;
    const mb = (await git(o.tools, o.clone, ["merge-base", base, commit])).trim();
    const diff = await git(o.tools, o.clone, ["diff", mb, commit]);
    if (!diff.trim()) return "";
    const r = await o.tools.run("git", ["patch-id", "--stable"], { cwd: o.clone, input: diff });
    return r.code === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? "") : "";
  };
  try {
    await git(o.tools, o.clone, ["fetch", "--quiet", "origin", o.branch], await o.github.gitAuth(o.repo));
    const want = await id(o.head);
    if (want === "") return same;
    for (const c of older) {
      try {
        if ((await id(c)) === want) same.add(c);
      } catch {
        // Not in the clone: stale.
      }
    }
  } catch {
    // The head can't be compared: every older approval is stale.
  }
  return same;
}

/** PIP-143: ask each login for a review, one call each so one refusal doesn't stop the others. */
export async function requestReviewers(
  gh: GitHub,
  github: string,
  n: number,
  logins: string[],
): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const login of logins) {
    try {
      const r = await gh.gh(github, [
        "api",
        "-X",
        "POST",
        `repos/${github}/pulls/${n}/requested_reviewers`,
        "-f",
        `reviewers[]=${login}`,
      ]);
      if (r.code !== 0) failed.push(login);
    } catch {
      failed.push(login);
    }
  }
  return { failed };
}

/** PIP-146: the owner answers for the PR. A refusal is no problem for the change; false says so. */
export async function assignOwner(gh: GitHub, github: string, n: number): Promise<boolean> {
  if (!gh.me) return false;
  try {
    const r = await gh.gh(github, ["pr", "edit", String(n), "-R", github, "--add-assignee", gh.me]);
    return r.code === 0;
  } catch {
    return false;
  }
}
