// Events from the intent's PRs and the intents repo (LOOP-18, PIP-43..45). Pure and
// level-triggered: each read re-derives at most one event against `feedback_seen` and `head`.

import type { Intent } from "../intents/types.ts";
import { finished, next, type Outcome } from "../machine.ts";
import { dataOf, type Mission } from "../mission.ts";
import { recheck } from "../risk.ts";
import type { PrState } from "./prs.ts";

export type PrKind = "spec" | "plan" | "code";

/** The PR reads of one poll, by kind (spec and code in the target repo, plan in `intents`). */
export interface Prs {
  spec?: PrState;
  plan?: PrState;
  code?: PrState;
}

const KINDS: PrKind[] = ["spec", "plan", "code"];
const COLUMN = { spec: "spec_pr", plan: "plan_pr", code: "pr" } as const;
const MERGED = { spec: "spec_merged", plan: "plan_merged", code: "code_merged" } as const;
const WAITS_ON: Partial<Record<Mission["stage"], PrKind>> = {
  "approval:spec": "spec",
  "approval:plan": "plan",
  "approval:merge": "code",
};

/** The mission's PR of `kind`, or null. */
export function prNumber(m: Mission, kind: PrKind): number | null {
  return m[COLUMN[kind]];
}

/** The newest of the mission's PRs (code > plan > spec): read even when merged (PIP-21). */
export function currentPr(m: Mission): { kind: PrKind; number: number } | null {
  for (const kind of ["code", "plan", "spec"] as const) {
    const n = prNumber(m, kind);
    if (n !== null) return { kind, number: n };
  }
  return null;
}

/** PIP-81: conflict revisions per spec PR before the owner is asked. */
export const SPEC_CONFLICT_REVISIONS = 2;
export const SPEC_CONFLICT_TEXT =
  "The spec PR conflicts with the base branch: another spec change merged first. Resolve the conflict in the specs and keep the rows of both sides. If the base took requirement IDs this PR adds, renumber this PR's rows (and the references to them) to the next free reserved IDs.";

/** PIP-134: conflict rounds per code PR before the owner is asked. */
export const CODE_CONFLICT_ROUNDS = 2;

/**
 * PIP-134: what a code PR that conflicts with its base gets: a conflict round, or, once
 * `CODE_CONFLICT_ROUNDS` ran since the owner last spoke, a wait. The build counts the rounds.
 */
export function conflictOutcome(m: Mission): Outcome {
  if (conflictRoundsDone(m) >= CODE_CONFLICT_ROUNDS)
    return {
      event: "wait",
      waiting: "merge failed",
      why: `the PR still conflicts with its base after ${CODE_CONFLICT_ROUNDS} automatic merges`,
    };
  return {
    event: "conflict",
    why: "the PR conflicts with its base",
    data: { repair: { what: "The PR conflicts with its base branch.", details: "", kind: "conflict" } },
  };
}

/** Conflict rounds run since the owner's last comment (`feedback_seen` moves on every one). */
export function conflictRoundsDone(m: Mission): number {
  const c = dataOf<{ conflictRounds?: { n: number; seen: string | null } }>(m).conflictRounds;
  return c && c.seen === m.feedback_seen ? c.n : 0;
}

/** The comment that starts over (PIP-45). */
export const RETRY = "/retry";
/** Reserved for the parked ship stage (PIP-45). */
export const RELEASE = "/release";

/** RFC 3339 `at` after `seen` (no `seen`: everything is new). */
export function newer(at: string, seen: string | null): boolean {
  if (!seen) return true;
  const a = Date.parse(at);
  const b = Date.parse(seen);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : at > seen;
}

/** The owner's login (PIP-44): case-insensitive; an empty `me` or author never matches. */
export function isOwner(author: string, me: string): boolean {
  return me !== "" && author.toLowerCase() === me.toLowerCase();
}

/** A bot's login as GitHub's REST (`x[bot]`) or GraphQL (`x`, `app/x`) shows it. */
export function isBot(author: string, botLogin: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/^app\//, "")
      .replace(/\[bot\]$/, "");
  return botLogin !== "" && norm(author) === norm(botLogin);
}

interface Said {
  kind: PrKind;
  at: string;
  text: string;
}

/** The owner's comments and steering reviews on the read PRs, oldest first (commands included). */
function ownerSaid(prs: Prs, me: string, botLogin: string): Said[] {
  const out: Said[] = [];
  for (const kind of KINDS) {
    const pr = prs[kind];
    if (!pr) continue;
    for (const c of pr.comments) {
      if (!isOwner(c.author, me) || isBot(c.author, botLogin) || !c.body.trim()) continue;
      const where = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}: ` : "";
      out.push({ kind, at: c.at, text: `${where}${c.body.trim()}` });
    }
    for (const r of pr.reviews) {
      if (!isOwner(r.author, me)) continue;
      if (r.state === "CHANGES_REQUESTED") {
        out.push({ kind, at: r.at, text: r.body.trim() || "Changes requested." });
      } else if (r.state === "COMMENTED" && r.body.trim()) {
        out.push({ kind, at: r.at, text: r.body.trim() });
      }
    }
  }
  return out.sort((a, b) => (newer(a.at, b.at) ? 1 : newer(b.at, a.at) ? -1 : 0));
}

const latest = (xs: Said[]) => xs.reduce((a, b) => (newer(b.at, a.at) ? b : a)).at;

/**
 * At most one event from a PR read, in LOOP-18's order: merged (the current PR) > closed >
 * the owner's feedback (`answered` while blocked) > `/retry` > conflict > head moved (code PR).
 * Only the owner's comments newer than `feedback_seen` count; taking one moves it forward.
 */
export function prEvents(m: Mission, prs: Prs, me: string, botLogin: string): Outcome | null {
  if (finished(m.stage)) return null;
  const cur = currentPr(m);
  const curPr = cur ? prs[cur.kind] : undefined;
  if (cur && curPr?.state === "MERGED") {
    if (cur.kind !== "code") return { event: MERGED[cur.kind] };
    return {
      event: "code_merged",
      set: { merge_sha: curPr.mergeCommit, merged_by: m.merged_by ?? "owner" },
    };
  }
  for (const kind of KINDS) {
    if (prs[kind]?.state === "CLOSED" && prNumber(m, kind) !== null) return { event: "closed" };
  }

  const fresh = ownerSaid(prs, me, botLogin).filter((s) => newer(s.at, m.feedback_seen));
  const isCommand = (s: Said) => s.text === RETRY || s.text === RELEASE;
  const feedback = fresh.filter((s) => !isCommand(s));
  if (feedback.length > 0) {
    const kinds = new Set(feedback.map((s) => s.kind));
    const text = feedback.map((s) => (kinds.size > 1 ? `(${s.kind} PR) ${s.text}` : s.text)).join("\n\n");
    // `data.answer` too: `apply` keeps `text` only on a continue, the worker's prompt needs it after
    // any move back to build, design or plan.
    return {
      event: m.stage === "blocked" ? "answered" : "feedback",
      text,
      set: { feedback_seen: latest(feedback) },
      data: { answer: text },
    };
  }
  const retries = fresh.filter((s) => s.text === RETRY);
  if (retries.length > 0) {
    // AUT-21: a gate waiting on a risk check that didn't finish runs the check again.
    const again = recheck(m);
    if (again) return { ...again, set: { feedback_seen: latest(retries) } };
    return { event: "retry_fresh", set: { feedback_seen: latest(retries) } };
  }

  // PIP-81: an open spec PR that no longer merges into base gets a design revision, at most twice.
  const spec = prs.spec;
  if (spec?.state === "OPEN" && m.stage === "approval:spec" && spec.mergeable === "CONFLICTING") {
    const done = dataOf<{ specConflicts?: number }>(m).specConflicts ?? 0;
    if (done >= SPEC_CONFLICT_REVISIONS)
      return { event: "wait", waiting: "spec conflict", why: "the spec PR still conflicts with its base" };
    return {
      event: "feedback",
      text: SPEC_CONFLICT_TEXT,
      data: { answer: SPEC_CONFLICT_TEXT, specConflicts: done + 1, mergeMain: true },
    };
  }

  const code = prs.code;
  if (code?.state === "OPEN" && m.pr !== null) {
    // LOOP-18: the same conflict repair CI gives, so the build merges the base first instead of
    // building on the old base again (a round that would conflict forever).
    if (code.mergeable === "CONFLICTING") {
      // PIP-134: after the last round only the stages that take a `conflict` ask the owner. A round
      // still running (GitHub shows the old state until the merge is pushed) and an owner who was
      // already asked are left alone.
      const spent = conflictRoundsDone(m) >= CODE_CONFLICT_ROUNDS;
      if (!spent) return conflictOutcome(m);
      if (m.stage !== "blocked" && next(m.stage, "conflict").kind === "go") return conflictOutcome(m);
      return null;
    }
    if (m.head && code.head && code.head !== m.head) return { event: "head_moved" };
  }
  return null;
}

/**
 * PIP-43: the owner's Approve review, newer than `feedback_seen` and on the PR's current head,
 * on the open PR the mission waits on → that PR's number, for Towercab to merge as the owner.
 */
export function approveRequested(m: Mission, prs: Prs, me: string): number | null {
  const kind = WAITS_ON[m.stage];
  if (!kind) return null;
  const pr = prs[kind];
  const n = prNumber(m, kind);
  if (!pr || n === null || pr.state !== "OPEN") return null;
  const ok = pr.reviews.some(
    (r) =>
      isOwner(r.author, me) &&
      r.state === "APPROVED" &&
      newer(r.at, m.feedback_seen) &&
      (r.commit === null || r.commit === pr.head),
  );
  return ok ? n : null;
}

/** The reply to `/release` while the ship stage is parked. */
export const RELEASE_PARKED =
  "`/release` is reserved for the ship stage, which is parked for now: there is nothing to release. Merging the code PR is the last step today.";

/** The reply's text; its marker lets the next read see the comment was answered. */
export function releaseReply(commentId: string): string {
  return `<!-- towercab:release:${commentId} -->\n${RELEASE_PARKED}`;
}

/** A `/release` the bot hasn't answered yet: post `reply` on that PR as the App. */
export interface ReleaseAsk {
  kind: PrKind;
  pr: number;
  commentId: string;
  reply: string;
}

/** PIP-45: the owner's `/release` comments with no bot reply carrying their marker. */
export function releaseRequested(m: Mission, prs: Prs, me: string, botLogin: string): ReleaseAsk[] {
  if (finished(m.stage)) return [];
  const out: ReleaseAsk[] = [];
  for (const kind of KINDS) {
    const pr = prs[kind];
    const n = prNumber(m, kind);
    if (!pr || n === null) continue;
    for (const c of pr.comments) {
      if (!isOwner(c.author, me) || c.body.trim() !== RELEASE || !c.id) continue;
      const marker = `<!-- towercab:release:${c.id} -->`;
      const answered = pr.comments.some((b) => isBot(b.author, botLogin) && b.body.includes(marker));
      if (!answered) out.push({ kind, pr: n, commentId: c.id, reply: releaseReply(c.id) });
    }
  }
  return out;
}

/**
 * At most one event from the intents repo: the file gone (`intent` null or in `done/`) →
 * `intent_removed`; `retry: fresh` → `retry_fresh`; `waiting` removed while blocked → `answered`.
 * None while the entry write is due (`step = 'enter'`: the intent doesn't show the wait yet).
 */
export function intentEvents(m: Mission, intent: Intent | null): Outcome | null {
  if (finished(m.stage) || m.step === "enter") return null;
  if (!intent || intent.done) return { event: "intent_removed" };
  if (intent.retry === "fresh") return { event: "retry_fresh" };
  if (m.stage === "blocked" && !intent.waiting) return { event: "answered" };
  return null;
}
