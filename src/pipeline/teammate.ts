// The teammate-review wait (PIP-142..144, PIP-147), shared by the gate, the spec merge, the merge
// and the PR poll. Nothing about reviewers is stored: it is read again before every decision.

import type { RepoConfig } from "../config.ts";
import { type PrState, readPr, readPrExtra } from "../github/prs.ts";
import {
  readApprovedReviewIds,
  readRequired,
  readTeamInput,
  requestReviewers,
  sameDiffCommits,
} from "../github/teammates.ts";
import type { Ctx, GitHub, Progress } from "../handlers.ts";
import { wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import {
  approval,
  NOBODY_WHY,
  reviewersOf,
  reviewWarning,
  type TeamInput,
  type Teammate,
  waitWhy,
} from "../teammates.ts";
import type { Tools } from "../tools.ts";
import { cloneOf, data } from "./common.ts";

export type TeamKind = "code" | "spec";

/** The wait's `waiting:` text for the PR it is on. */
export const teammateWait = (kind: TeamKind) =>
  kind === "code" ? "teammate review" : "teammate review of spec";

/** What was found of one PR's teammate review. */
export interface Evaluation {
  pr: PrState;
  team: TeamInput;
  result: Teammate;
  /** A counted approval that the host's own review rule also accepts (PIP-142). */
  counted: boolean;
  /** The PR's reviewers, lowercase. */
  reviewers: string[];
  approvedReviewIds: Set<string>;
}

/** The host's required approvals are read at most this often per repo (seconds). */
const REQUIRED_TTL = 600;

export interface EvalDeps {
  github: GitHub;
  tools: Tools;
  clone: string;
}

/** Read the PR and everything the rules need, and decide (PIP-142). */
export async function evaluate(
  d: EvalDeps,
  repo: RepoConfig,
  o: { n: number; branch: string; bot: string; pr?: PrState },
): Promise<Evaluation> {
  const read = o.pr ?? (await readPr(d.github, repo.github, o.n));
  const pr: PrState = { ...read, ...(await readPrExtra(d.github, repo.github, o.n)) };
  const team = await readTeamInput(d.github, repo, repo.github, o.n, pr, o.bot);
  const commits = pr.reviews.filter((r) => r.state === "APPROVED" && r.commit).map((r) => r.commit!);
  const sameDiff = await sameDiffCommits({
    tools: d.tools,
    github: d.github,
    repo: repo.github,
    clone: d.clone,
    base: repo.base,
    branch: o.branch,
    head: pr.head,
    commits,
  });
  const result = approval(team, { head: pr.head, reviews: pr.reviews, sameDiff });
  const counted = result.kind === "approved" && pr.reviewDecision !== "REVIEW_REQUIRED";
  const approvedReviewIds = await readApprovedReviewIds(d.github, repo.github, o.n);
  return { pr, team, result, counted, reviewers: reviewersOf(team), approvedReviewIds };
}

/** The host's required approvals for the repo's base, cached in `meta` (null = unknown). */
export async function requiredApprovals(cx: Ctx, repo: RepoConfig): Promise<number | null> {
  const key = `required:${repo.name}`;
  const cached = cx.db.meta(key);
  if (cached) {
    const [at, n] = cached.split(" ");
    if (cx.clock.now() - Number(at) < REQUIRED_TTL) return n === "?" ? null : Number(n);
  }
  const n = await readRequired(cx.github, repo.github, repo.base);
  cx.db.setMeta(key, `${Math.floor(cx.clock.now())} ${n === null ? "?" : n}`);
  return n;
}

/**
 * PIP-144: in a repo that needs a teammate's review, the wait for it, or null when a teammate approved
 * (and the host's rule agrees). Asks the listed reviewers once per head, before it waits (PIP-143).
 */
export async function teammateStep(cx: Ctx, m: Mission, kind: TeamKind): Promise<Progress | null> {
  const repo = cx.repo(m);
  if (!repo.teammateReview) return null;
  const d = data(m);
  const n = kind === "code" ? m.pr : m.spec_pr;
  if (n === null) return null;
  const bot = (await cx.github.bot()).login;
  const e = await evaluate({ github: cx.github, tools: cx.tools, clone: cloneOf(cx, m) }, repo, {
    n,
    branch: kind === "code" ? m.branch : (d.specBranch ?? m.branch),
    bot,
  });
  if (kind === "code" && e.pr.isDraft) {
    // PIP-143: nobody is asked about a draft; it is marked ready first.
    const r = await cx.github.gh(repo.github, ["pr", "ready", String(n), "-R", repo.github]);
    if (r.code !== 0) cx.log(`${m.intent}: couldn't mark PR ${n} ready: ${r.stderr.trim()}`);
    return { poll: 10 };
  }
  const required = await requiredApprovals(cx, repo);
  const warning = reviewWarning({
    repoName: repo.name,
    required,
    reviewers: e.reviewers,
    approved: e.result.kind === "approved",
    decision: e.pr.reviewDecision ?? "",
  });
  if (e.result.kind === "nobody") {
    return { done: wait(teammateWait(kind), NOBODY_WHY, { data: { reviewWarning: warning ?? undefined } }) };
  }
  if (e.counted) {
    if (d.reviewWarning !== undefined) cx.record(m, m.step, {}, { reviewWarning: undefined });
    return null;
  }
  const listed = repo.reviewers ?? [];
  let why = waitWhy(listed);
  const t = d.teammate ?? {};
  if (t.requested !== e.pr.head) {
    // Record first, then ask (LOOP-6).
    cx.record(m, m.step, {}, { teammate: { ...t, requested: e.pr.head, passNeeded: false } });
    const failed =
      listed.length > 0 ? (await requestReviewers(cx.github, repo.github, n, listed)).failed : [];
    if (failed.length > 0) {
      why += ` Towercab couldn't ask ${failed.join(", ")}: check they can review this repo.`;
    }
  }
  return {
    done: wait(teammateWait(kind), why, {
      data: {
        teammate: { ...t, requested: e.pr.head, passNeeded: false },
        reviewWarning: warning ?? undefined,
      },
    }),
  };
}
