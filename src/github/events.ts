// Events from the intent's PRs and the intents repo (LOOP-18, PIP-43..45). Pure and
// level-triggered: each read re-derives at most one event against `feedback_seen` and `head`.

import type { Intent } from "../intents/types.ts";
import { finished, next, type Outcome, type Stage } from "../machine.ts";
import { dataOf, type Mission } from "../mission.ts";
import { parseAllow } from "../pipeline/access.ts";
import { recheck } from "../risk.ts";
import { stripAgentHeader } from "./agent-header.ts";
import { agentOfBody } from "./comments.ts";
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
/** PIP-143: the owner's comment that passes a change the automated review didn't approve to the teammates. */
export const PASS = "/pass";

/** The waits of a change that needs a teammate's review (PIP-143, PIP-144). */
const TEAMMATE_WAITS = ["teammate review", "teammate review of spec"];

/**
 * What a repo that needs a teammate's review adds to a PR read (PIP-142, PIP-143, PIP-145): the PR the
 * mission waits on, the reviewers who are heard, and what the rules found of it.
 */
export interface TeamReads {
  kind: PrKind;
  /** The PR's reviewers, lowercase (never the owner or the bot). */
  heard: ReadonlySet<string>;
  /** A teammate approval counts on the PR's head. */
  approved: boolean;
  /** The owner may pass the change on now (the automated review didn't approve; teammates not asked). */
  passable: boolean;
  /** REST ids of the approving reviews: their inline comments are not feedback. */
  approvedReviewIds: ReadonlySet<string>;
}
/** The comment that asks what the ship stage does with the PR (PIP-45). */
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
  /** PIP-185: the agent whose marker the owner-account comment carries. */
  agent?: string;
}

/** The owner's comments and steering reviews on the read PRs, oldest first (commands included). */
function ownerSaid(prs: Prs, me: string, botLogin: string, ownerOnlyIntent = false): Said[] {
  const out: Said[] = [];
  for (const kind of KINDS) {
    const pr = prs[kind];
    if (!pr) continue;
    for (const c of pr.comments) {
      if (!isOwner(c.author, me) || isBot(c.author, botLogin) || !c.body.trim()) continue;
      // PIP-185: an agent's comment under the owner's login is ignored on an a0 intent, else it counts.
      const agent = agentOfBody(c.body) ?? undefined;
      if (agent && ownerOnlyIntent) continue;
      const where = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}: ` : "";
      out.push({
        kind,
        at: c.at,
        text: `${where}${stripAgentHeader(c.body).trim()}`,
        ...(agent ? { agent } : {}),
      });
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

/** A reply on a PR that doesn't count (AUT-32): who, where, and a stable key so it is noted once. */
export interface IgnoredReply {
  key: string;
  author: string;
  kind: PrKind;
  pr: number | null;
  what: string;
}

/**
 * AUT-32: on an owner-only intent, the comments and reviews from anyone but the owner or Towercab's own
 * bot. PIP-44 already ignores them; this lists them so the loop can note each once on the intent.
 */
export function ignoredReplies(m: Mission, prs: Prs, me: string, botLogin: string): IgnoredReply[] {
  const out: IgnoredReply[] = [];
  for (const kind of KINDS) {
    const pr = prs[kind];
    if (!pr) continue;
    const base = { kind, pr: prNumber(m, kind) };
    for (const c of pr.comments) {
      if (isOwner(c.author, me) || isBot(c.author, botLogin) || !c.body.trim()) continue;
      out.push({ ...base, key: `${kind}:comment:${c.id}`, author: c.author, what: "comment" });
    }
    for (const r of pr.reviews) {
      if (isOwner(r.author, me) || isBot(r.author, botLogin)) continue;
      const counts = r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.body.trim() !== "";
      if (!counts || r.state === "PENDING" || r.state === "DISMISSED") continue;
      out.push({ ...base, key: `${kind}:review:${r.author}:${r.at}`, author: r.author, what: "review" });
    }
  }
  return out;
}

/** PIP-185: an owner-account comment that carries an agent's marker. */
export interface AgentComment {
  key: string;
  agent: string;
  kind: PrKind;
  pr: number | null;
  at: string;
  excerpt: string;
}

/** PIP-185: the comments under the owner's login that an agent marked, for the record (any level). */
export function agentComments(m: Mission, prs: Prs, me: string, botLogin: string): AgentComment[] {
  const out: AgentComment[] = [];
  for (const kind of KINDS) {
    for (const c of prs[kind]?.comments ?? []) {
      if (!isOwner(c.author, me) || isBot(c.author, botLogin)) continue;
      const agent = agentOfBody(c.body);
      if (!agent) continue;
      const text = c.body.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
      out.push({
        key: `${kind}:agent:${c.id}`,
        agent,
        kind,
        pr: prNumber(m, kind),
        at: c.at,
        excerpt: text.slice(0, 200),
      });
    }
  }
  return out;
}

/** PIP-185: `answeredBy` is set, and so always replaces an earlier one, only on a marked agent's answer. */
const answeredBy = (xs: Said[]): { answeredBy: string | null } | Record<string, never> =>
  xs.some((s) => s.agent)
    ? { answeredBy: xs.every((s) => s.agent) ? [...new Set(xs.map((s) => s.agent))].join(", ") : null }
    : {};

const latest = (xs: Said[]) => xs.reduce((a, b) => (newer(b.at, a.at) ? b : a)).at;

/**
 * PIP-145: a reviewer's request for changes, or a comment outside an approval, on the PR the mission
 * waits on. An approval, its text and its inline comments never are; a reviewer's slash commands and
 * `allow` replies are not heard.
 */
function reviewerSaid(prs: Prs, team: TeamReads): Said[] {
  const pr = prs[team.kind];
  if (!pr) return [];
  const out: Said[] = [];
  const isCommand = (t: string) => t === RETRY || t === RELEASE || t === PASS || parseAllow(t) !== null;
  for (const c of pr.comments) {
    const text = c.body.trim();
    if (!team.heard.has(c.author.toLowerCase()) || !text || isCommand(text)) continue;
    if (c.reviewId && team.approvedReviewIds.has(c.reviewId)) continue;
    const where = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}: ` : "";
    out.push({ kind: team.kind, at: c.at, text: `${c.author}: ${where}${text}` });
  }
  for (const r of pr.reviews) {
    if (!team.heard.has(r.author.toLowerCase())) continue;
    const text = r.body.trim();
    if (r.state === "CHANGES_REQUESTED") {
      out.push({
        kind: team.kind,
        at: r.at,
        text: `${r.author} asked for changes: ${text || "Changes requested."}`,
      });
    } else if (r.state === "COMMENTED" && text && !isCommand(text)) {
      out.push({ kind: team.kind, at: r.at, text: `${r.author}: ${text}` });
    }
  }
  return out;
}

/** PIP-145: what the approving reviewers wrote, for the record (`alice approved: …`); nothing more happens. */
export function approvalNotes(prs: Prs, team: TeamReads): string[] {
  const pr = prs[team.kind];
  if (!pr) return [];
  return pr.reviews
    .filter((r) => r.state === "APPROVED" && team.heard.has(r.author.toLowerCase()) && r.body.trim())
    .map((r) => `${r.author} approved: ${r.body.trim()}`);
}

/**
 * At most one event from a PR read, in LOOP-18's order: merged (the current PR) > closed >
 * the owner's feedback (`answered` while blocked) > `/retry` > conflict > head moved (code PR).
 * Only the owner's comments newer than `feedback_seen` count; taking one moves it forward.
 */
export function prEvents(
  m: Mission,
  prs: Prs,
  me: string,
  botLogin: string,
  team?: TeamReads,
  ownerOnlyIntent = false,
  queueHeld = false,
): Outcome | null {
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

  const mine = ownerSaid(prs, me, botLogin, ownerOnlyIntent);
  const said = team ? [...mine, ...reviewerSaid(prs, team)] : mine;
  const fresh = said.filter((s) => newer(s.at, m.feedback_seen));
  // PIP-141: `allow <path>` reverses a refusal (not feedback), unless a test question is open.
  const asked = dataOf<{ testAsk?: unknown; accessAsk?: unknown }>(m);
  const asking = Boolean(asked.testAsk || asked.accessAsk);
  const isCommand = (s: Said) =>
    s.text === RETRY ||
    s.text === RELEASE ||
    (team && s.text === PASS) ||
    (!asking && parseAllow(s.text) !== null);
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
      // PIP-185: when every word came from marked agents, the answer says who gave it for the owner.
      data: { answer: text, ...answeredBy(feedback) },
    };
  }
  const retries = fresh.filter((s) => s.text === RETRY);
  if (retries.length > 0) {
    // AUT-21: a gate waiting on a risk check that didn't finish runs the check again.
    const again = recheck(m);
    if (again) return { ...again, set: { feedback_seen: latest(retries) } };
    return { event: "retry_fresh", set: { feedback_seen: latest(retries) } };
  }

  if (team) {
    // PIP-143: the owner's `/pass` hands a change the automated review didn't approve to the teammates.
    const passes = fresh.filter((s) => s.text === PASS);
    if (passes.length > 0 && team.passable && prs.code?.head) {
      const kept = dataOf<{ teammate?: object }>(m).teammate ?? {};
      return {
        event: "reviewed",
        why: "the owner passed it on to the teammates",
        set: { feedback_seen: latest(passes) },
        data: { teammate: { ...kept, passedOn: prs.code.head } },
      };
    }
    // PIP-142: a counted teammate approval ends the wait; what it says goes to the record.
    if (team.approved && m.waiting !== null && TEAMMATE_WAITS.includes(m.waiting)) {
      return {
        event: "reviewed",
        why: "a teammate approved",
        // The spec PR's gate runs again through the design's recheck (PIP-144).
        data: { approvalNotes: approvalNotes(prs, team), ...(team.kind === "spec" ? { recheck: true } : {}) },
      };
    }
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
      // LOOP-160: only the head of the repo's merge queue repairs a conflict; the rest wait their turn.
      if (queueHeld) return null;
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
export function approveRequested(m: Mission, prs: Prs, me: string, teamOn = false): number | null {
  const kind = WAITS_ON[m.stage];
  // PIP-144: in a repo that needs a teammate's review the owner's Approve never merges.
  if (!kind || (teamOn && kind !== "plan")) return null;
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

/** The marker of the one reply to the owner's Approve review submitted at `at` (PIP-144). */
export const approveMarker = (at: string) => `<!-- towercab:approve:${at} -->`;

/** An Approve of the owner's in a repo that needs a teammate's review, which the bot hasn't answered. */
export interface ApproveAsk {
  kind: PrKind;
  pr: number;
  marker: string;
}

/**
 * PIP-144: the owner's Approve reviews on the PR the mission waits on that no bot reply carrying their
 * marker answers. They neither merge nor count, so the owner is told once what to do instead.
 */
export function approveNotices(m: Mission, prs: Prs, me: string, botLogin: string): ApproveAsk[] {
  const kind = WAITS_ON[m.stage];
  if (!kind || kind === "plan" || finished(m.stage)) return [];
  const pr = prs[kind];
  const n = prNumber(m, kind);
  if (!pr || n === null || pr.state !== "OPEN") return [];
  const out: ApproveAsk[] = [];
  for (const r of pr.reviews) {
    if (!isOwner(r.author, me) || r.state !== "APPROVED" || !r.at) continue;
    const marker = approveMarker(r.at);
    if (pr.comments.some((b) => isBot(b.author, botLogin) && b.body.includes(marker))) continue;
    out.push({ kind, pr: n, marker });
  }
  return out;
}

/** What `/release` needs to know of one repo of the intent: its live URL, or why that is unknown. */
export interface ReleaseRepo {
  name: string;
  /** The repo's `live` block (SHIP-1): null when it has none. */
  live: { url: string } | null;
  /** Set when the repo's files could not be read: the reason replaces the guess. */
  unreadable?: string;
}

const AFTER_MERGE: Partial<Record<Stage, string>> = {
  steps: "waiting for your steps after the merge",
  deploy: "waiting for the deploy",
  e2e: "running the e2e suites against the live app",
  rollback: "rolling back to the last good version",
  revert: "reverting the change",
  done: "it is live and passed its tests",
  unverified: "merged, but not verified live",
};

/** PIP-45: one line per repo, the lead first, saying what the ship stage does with this PR. */
export function releaseText(stage: Stage, repos: ReleaseRepo[]): string {
  return repos
    .map((r) => {
      if (r.unreadable !== undefined)
        return `${r.name}: I could not read the live settings (${r.unreadable}), so I can't say what happens after the merge.`;
      if (!r.live) return `${r.name}: there is no live check, so merging the code PR is the last step.`;
      const now = AFTER_MERGE[stage];
      if (now) return `${r.name}: ${now}.`;
      return `${r.name}: after the merge Towercab waits for the deploy to ${r.live.url} and runs the e2e suites.`;
    })
    .join("\n");
}

/** The reply's text; its marker lets the next read see the comment was answered. */
export function releaseReply(commentId: string, text: string): string {
  return `<!-- towercab:release:${commentId} -->\n${text}`;
}

/** A `/release` the bot hasn't answered yet: post `reply` on that PR as the App. */
export interface ReleaseAsk {
  kind: PrKind;
  pr: number;
  commentId: string;
  reply: string;
}

/** PIP-45: the owner's `/release` comments with no bot reply carrying their marker. */
export function releaseRequested(
  m: Mission,
  prs: Prs,
  me: string,
  botLogin: string,
  repos: ReleaseRepo[],
): ReleaseAsk[] {
  if (finished(m.stage)) return [];
  const text = releaseText(m.stage, repos);
  const out: ReleaseAsk[] = [];
  for (const kind of KINDS) {
    const pr = prs[kind];
    const n = prNumber(m, kind);
    if (!pr || n === null) continue;
    for (const c of pr.comments) {
      if (!isOwner(c.author, me) || c.body.trim() !== RELEASE || !c.id) continue;
      const marker = `<!-- towercab:release:${c.id} -->`;
      const answered = pr.comments.some((b) => isBot(b.author, botLogin) && b.body.includes(marker));
      if (!answered) out.push({ kind, pr: n, commentId: c.id, reply: releaseReply(c.id, text) });
    }
  }
  return out;
}

/** An owner's `allow <path>` the bot hasn't answered yet (PIP-141). */
export interface ReversalAsk {
  kind: PrKind;
  pr: number;
  commentId: string;
  paths: string[];
  text: string;
}

/** The marker of the reply to the owner's comment `commentId`; it shows the comment was answered. */
export const reversalMarker = (commentId: string) => `<!-- towercab:allow:${commentId} -->`;

/**
 * PIP-141: the owner's `allow <path>` comments, newer than `feedback_seen`, that no bot reply carrying
 * their marker answers; none while a test question is open (then they are its answer).
 */
export function reversalRequested(
  m: Mission,
  prs: Prs,
  me: string,
  botLogin: string,
  ownerOnlyIntent = false,
): ReversalAsk[] {
  const open = dataOf<{ testAsk?: unknown; accessAsk?: unknown }>(m);
  if (finished(m.stage) || open.testAsk || open.accessAsk) return [];
  const out: ReversalAsk[] = [];
  for (const kind of KINDS) {
    const pr = prs[kind];
    const n = prNumber(m, kind);
    if (!pr || n === null) continue;
    for (const c of pr.comments) {
      if (!isOwner(c.author, me) || !c.id || !newer(c.at, m.feedback_seen)) continue;
      // PIP-185: on an a0 intent an agent's marked comment cannot lift a refusal.
      if (ownerOnlyIntent && agentOfBody(c.body)) continue;
      const paths = parseAllow(c.body);
      if (!paths) continue;
      const marker = reversalMarker(c.id);
      if (pr.comments.some((b) => isBot(b.author, botLogin) && b.body.includes(marker))) continue;
      out.push({ kind, pr: n, commentId: c.id, paths, text: c.body.trim() });
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
