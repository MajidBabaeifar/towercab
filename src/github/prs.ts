// Reading one of the intent's PRs (PIP-21) with gh 2.46 (LOOP-20): `gh pr view --json` plus the
// review comments through `gh api --paginate` (no `--slurp`: its pages print back to back).

import type { GitHub } from "../handlers.ts";
import { check } from "../tools.ts";

export interface PrReview {
  author: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: string;
  body: string;
  /** RFC 3339. */
  at: string;
  /** The head it reviewed, when gh says. */
  commit: string | null;
}

export interface PrComment {
  author: string;
  body: string;
  /** RFC 3339. */
  at: string;
  id: string;
  /** Review comments: the file and line they are on. */
  path?: string;
  line?: number;
  /** Review comments: the review they belong to (PIP-145: an approval's comments are not feedback). */
  reviewId?: string;
}

export interface PrState {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  mergeCommit: string | null;
  head: string;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string;
  body: string;
  isDraft: boolean;
  /** PIP-142: the PR's author, the host's review decision and the base branch, when gh says. */
  author?: string;
  reviewDecision?: string;
  base?: string;
  reviews: PrReview[];
  /** Conversation comments, then review comments. */
  comments: PrComment[];
}

export const PR_FIELDS = "state,mergedAt,mergeCommit,headRefOid,mergeable,isDraft,reviews,comments,body";

/** PIP-142: what the teammate-review rules also need of a PR (read only where the setting is on). */
export async function readPrExtra(
  gh: GitHub,
  repo: string,
  n: number,
): Promise<Pick<PrState, "author" | "reviewDecision" | "base">> {
  const view = check(
    await gh.gh(repo, ["pr", "view", String(n), "-R", repo, "--json", "author,reviewDecision,baseRefName"]),
    "gh pr view",
  );
  const v = JSON.parse(view) as {
    author?: { login?: string };
    reviewDecision?: string;
    baseRefName?: string;
  };
  return {
    author: v.author?.login ?? "",
    reviewDecision: v.reviewDecision ?? "",
    ...(v.baseRefName ? { base: v.baseRefName } : {}),
  };
}

/** Read PR `n` of `repo` (`owner/name`) as the App. */
export async function readPr(gh: GitHub, repo: string, n: number): Promise<PrState> {
  const view = check(
    await gh.gh(repo, ["pr", "view", String(n), "-R", repo, "--json", PR_FIELDS]),
    "gh pr view",
  );
  const comments = check(
    await gh.gh(repo, ["api", "--paginate", `repos/${repo}/pulls/${n}/comments?per_page=100`]),
    "gh api comments",
  );
  return parsePr(view, comments);
}

/** `gh pr view`'s JSON and the review comments' pages → a `PrState`. */
export function parsePr(viewJson: string, commentsText: string): PrState {
  let v: unknown;
  try {
    v = JSON.parse(viewJson);
  } catch (e) {
    throw new Error(`gh pr view: ${(e as Error).message}`);
  }
  if (!isObj(v)) throw new Error("gh pr view: not an object");
  const state = str(v.state);
  const comments: PrComment[] = arr(v.comments).map((c) => ({
    author: login(c.author),
    body: str(c.body),
    at: str(c.createdAt),
    id: idOf(c.id),
  }));
  for (const page of jsonStream(commentsText, "gh api comments")) {
    if (!Array.isArray(page)) throw new Error("gh api comments: not a list");
    for (const c of page) {
      if (!isObj(c)) continue;
      const line = c.line ?? c.original_line;
      comments.push({
        author: login(c.user),
        body: str(c.body),
        at: str(c.created_at),
        id: idOf(c.id),
        ...(typeof c.path === "string" ? { path: c.path } : {}),
        ...(typeof line === "number" ? { line } : {}),
        ...(c.pull_request_review_id !== undefined && c.pull_request_review_id !== null
          ? { reviewId: idOf(c.pull_request_review_id) }
          : {}),
      });
    }
  }
  const mergedAt = str(v.mergedAt) || null;
  return {
    state: state === "MERGED" || mergedAt ? "MERGED" : state === "CLOSED" ? "CLOSED" : "OPEN",
    mergedAt,
    mergeCommit: (isObj(v.mergeCommit) && str(v.mergeCommit.oid)) || null,
    head: str(v.headRefOid),
    mergeable: str(v.mergeable) || "UNKNOWN",
    body: str(v.body),
    isDraft: v.isDraft === true,
    ...(v.author !== undefined ? { author: login(v.author) } : {}),
    ...(typeof v.reviewDecision === "string" ? { reviewDecision: v.reviewDecision } : {}),
    ...(typeof v.baseRefName === "string" ? { base: v.baseRefName } : {}),
    reviews: arr(v.reviews).map((r) => ({
      author: login(r.author),
      state: str(r.state),
      body: str(r.body),
      at: str(r.submittedAt),
      commit: (isObj(r.commit) && str(r.commit.oid)) || null,
    })),
    comments,
  };
}

/** JSON values printed back to back (`[…][…]`, whitespace between or not). */
export function jsonStream(text: string, what = "json"): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch (e) {
          throw new Error(`${what}: ${(e as Error).message}`);
        }
      }
      if (depth < 0) throw new Error(`${what}: unbalanced ${ch}`);
    } else if (depth === 0 && !/\s/.test(ch)) {
      throw new Error(`${what}: unexpected ${ch}`);
    }
  }
  if (depth !== 0 || inStr) throw new Error(`${what}: cut off`);
  return out;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function idOf(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
}

function login(v: unknown): string {
  return isObj(v) ? str(v.login) : "";
}

/** Close an open PR as the App with a comment saying why (PIP-53); a closed or merged one is left. */
export async function closeIfOpen(gh: GitHub, repo: string, n: number, why: string): Promise<void> {
  const view = check(
    await gh.gh(repo, ["pr", "view", String(n), "-R", repo, "--json", "state"]),
    "gh pr view",
  );
  if ((JSON.parse(view) as { state: string }).state !== "OPEN") return;
  check(await gh.gh(repo, ["pr", "close", String(n), "-R", repo, "--comment", why]), "gh pr close");
}
