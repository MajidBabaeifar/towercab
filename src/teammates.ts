// A teammate's approval (PIP-142, PIP-145, PIP-147): who counts as a reviewer, which approvals count,
// and the wording of the wait and the warning. Pure: the callers read GitHub and git and pass in
// what they found, so every rule is testable without either.

import { isBot, isOwner } from "./github/events.ts";
import type { PrReview } from "./github/prs.ts";

/** One `CODEOWNERS` line: a pattern and the owners after it. */
export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/** Where GitHub looks for `CODEOWNERS`, first found wins. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** The most files GitHub lists for a PR; a PR at the limit has a file list that may be cut off. */
export const FILES_LIMIT = 3000;

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern: pattern!, owners });
  }
  return rules;
}

/** A CODEOWNERS pattern as a regular expression over a repo path (gitignore-like, as GitHub reads it). */
function patternRegex(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}${dirOnly ? "/.*" : "(?:/.*)?"}$`);
}

/**
 * The `@login` owners of one path: the last matching pattern wins. A team (`@org/team`) or an email
 * owner is not expanded and counts for nobody (PIP-142).
 */
export function codeOwnersOfPath(path: string, rules: CodeownersRule[]): string[] {
  let hit: CodeownersRule | null = null;
  for (const r of rules) if (patternRegex(r.pattern).test(path)) hit = r;
  if (!hit) return [];
  return hit.owners.filter((o) => /^@[A-Za-z0-9-]+$/.test(o)).map((o) => o.slice(1).toLowerCase());
}

/** The code owners of every changed path, once each. */
export function codeOwnersOf(paths: string[], rules: CodeownersRule[]): string[] {
  const out = new Set<string>();
  for (const p of paths) for (const o of codeOwnersOfPath(p, rules)) out.add(o);
  return [...out];
}

/** What the rules decide on: the setting, the PR and what was read of the host. */
export interface TeamInput {
  /** `reviewers` from `repo set`. */
  listed: string[];
  me: string;
  bot: string;
  /** The PR author's login. */
  author: string;
  /** `CODEOWNERS` from the base branch; null = missing or unreadable. */
  codeowners: string | null;
  /** The PR's changed paths; null = unreadable or cut off. */
  files: string[] | null;
}

const lower = (s: string) => s.toLowerCase();

/**
 * PIP-142: the PR's reviewers, lowercase: the listed logins plus the code owners of the changed paths.
 * The owner, the bot and the PR's author never count, even when listed. Anyone the host was merely
 * asked to review does not count, whoever asked.
 */
export function reviewersOf(t: TeamInput): string[] {
  const owners =
    t.codeowners !== null && t.files !== null ? codeOwnersOf(t.files, parseCodeowners(t.codeowners)) : [];
  const out = new Set<string>();
  for (const l of [...t.listed, ...owners]) {
    const login = lower(l);
    if (login === "" || isOwner(login, t.me) || isBot(login, t.bot) || login === lower(t.author)) continue;
    out.add(login);
  }
  return [...out];
}

export type Teammate =
  /** A counted approval on the PR; `by` are the logins. */
  | { kind: "approved"; by: string[] }
  /** Waiting for one of `who`. */
  | { kind: "waiting"; who: string[] }
  /** Nobody is known to review: no listed login and no code owner. */
  | { kind: "nobody" };

/** What `approval` needs of the PR. */
export interface PrFacts {
  head: string;
  reviews: PrReview[];
  /** Older commits whose diff from the base equals the head's (`git patch-id --stable`). */
  sameDiff: ReadonlySet<string>;
}

/**
 * PIP-142: the PR's teammate approval. A reviewer's latest review that says approve, request changes
 * or dismissed decides; it counts only when it approves, the host did not dismiss it, and it is of the
 * head or of an older head with the same changes.
 */
export function approval(t: TeamInput, pr: PrFacts): Teammate {
  const reviewers = reviewersOf(t);
  if (reviewers.length === 0) return { kind: "nobody" };
  const latest = new Map<string, PrReview>();
  for (const r of [...pr.reviews].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
    latest.set(lower(r.author), r);
  }
  const by = reviewers.filter((who) => {
    const r = latest.get(who);
    if (r?.state !== "APPROVED") return false;
    return r.commit !== null && (r.commit === pr.head || pr.sameDiff.has(r.commit));
  });
  return by.length > 0 ? { kind: "approved", by } : { kind: "waiting", who: reviewers };
}

/** `alice, bob`, or `the code owners` when nobody is listed. */
export function whoText(listed: string[]): string {
  return listed.length > 0 ? listed.join(", ") : "the code owners";
}

/** PIP-143: the wait's why. */
export function waitWhy(listed: string[]): string {
  return `Waiting for teammate review from ${whoText(listed)}.`;
}

export const NOBODY_WHY =
  "Nobody is known to review this change: list reviewers with `towercab repo set <repo> reviewers=…`, or add a CODEOWNERS entry for the changed files.";

/** PIP-143: why a change the automated review didn't approve goes to the owner before the teammates. */
export const PASS_ON_WHY =
  "The independent code review didn't approve it. Look at it, then reply `/pass` (or press Pass on to teammates) to ask your teammates.";

/** PIP-144: the one-time reply to the owner's Approve in such a repo, by where the change is. */
export const APPROVE_NOTICE = {
  before: "Your approval isn't a teammate review. Reply `/pass` to ask your teammates.",
  waiting: "Your approval isn't a teammate review. Towercab is waiting for your teammates to approve.",
  after:
    "Your approval isn't a teammate review. Merge with the card's button or `towercab approve` now that your teammates have approved.",
} as const;

/**
 * PIP-145: who is heard besides the owner: the PR's reviewers (never the owner or the bot). Their
 * request for changes, or a comment outside an approval, is feedback; an approval never is.
 */
export function heardOf(t: TeamInput): Set<string> {
  return new Set(reviewersOf(t));
}

/**
 * PIP-147: the warning when the host asks for approvals the reviewers can't give, or null.
 * `required`: the host's required approvals (null = unknown); `decision`: its `reviewDecision`.
 */
export function reviewWarning(o: {
  repoName: string;
  required: number | null;
  reviewers: string[];
  approved: boolean;
  decision: string;
}): string | null {
  const k = o.reviewers.length;
  if (o.required !== null && o.required > k) {
    return `GitHub needs ${o.required} approval${o.required === 1 ? "" : "s"} and your reviewers can give ${k}: add reviewers with towercab repo set ${o.repoName} reviewers=…`;
  }
  if (o.approved && o.decision === "REVIEW_REQUIRED") {
    return "GitHub still wants an approval you have not got: it asks for a review from someone other than your reviewers (for example the code owners).";
  }
  return null;
}

/** LOOP-84: whether fewer reviewers are listed than the host requires. */
export function tooFewListed(listed: string[], me: string, required: number): boolean {
  return listed.filter((l) => !isOwner(l, me)).length < required;
}
