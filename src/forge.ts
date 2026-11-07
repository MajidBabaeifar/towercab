// What Towercab needs from a code host (the "forge"). Stages ask for these things in the host's own
// terms; `src/github/forge.ts` answers them with `gh`. Nothing outside `src/github/` builds `gh` arguments
// or reads GitHub's JSON for what is in here.
//
// Merge states (`MergeStatus.mergeState`) keep GitHub's words (`CLEAN`, `BEHIND`, `DIRTY`, `BLOCKED`,
// `UNSTABLE`, `DRAFT`, `HAS_HOOKS`): another host maps its own into them.

import type { ProposedCache, ProposedPr } from "./github/proposed.ts";

/** How a change request is merged. */
export type MergeMethod = "squash";

/** The one way Towercab merges. */
export const MERGE_METHOD: MergeMethod = "squash";

/** The host refused for lack of permission. */
export class ForgeDenied extends Error {}

/** The host answered, but not with what was asked for. */
export class ForgeBadReply extends Error {}

/** The result of a change the caller may live with failing. */
export interface Result {
  ok: boolean;
  /** Why it failed (the host's own words); empty when ok. */
  reason: string;
}

/** Throw `<what>: <first line of why>` when `o` failed. */
export function must(o: Result, what: string): void {
  if (o.ok) return;
  const why = o.reason.split("\n").find((l) => l.trim()) ?? "failed";
  throw new Error(`${what}: ${why.trim()}`);
}

export interface Bot {
  login: string;
  id: number;
  email: string;
}

export interface GitAuth {
  args: string[];
  env: Record<string, string>;
}

/** One check of a change request. */
export interface Check {
  name: string;
  kind: "run" | "status";
  status: string;
  conclusion: string;
  startedAt: number | null;
  run: number | null;
  url: string;
}

export interface ChecksRead {
  head: string;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string;
  checks: Check[];
}

export interface MergeStatus {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  mergeState: string;
  mergeCommit: string | null;
}

/** A change request as its owner sees it before acting on it. */
export interface PrBrief {
  state: string;
  draft: boolean;
  head: string;
  merged: boolean;
}

export interface Review {
  author: string;
  state: string;
}

export interface FileChange {
  filename: string;
  status: string;
}

/** PIP-148: one open code scanning alert. */
export interface CodeScanningAlert {
  rule: string;
  path: string;
  line: number | null;
  message: string;
}

export interface Deployment {
  id: number;
  sha: string;
  task: string;
  createdAt: string;
  payload: unknown;
}

export interface DeploymentStatus {
  state: string;
  description: string;
}

// biome-ignore lint/suspicious/noExplicitAny: the host's JSON, read field by field
export type Json = Record<string, any>;

/** What the settings script can change, as the host has it now. */
export interface SettingsSnapshot {
  defaultBranch: string;
  /** The repository as the host describes it. */
  repository: Json;
  securityAndAnalysis: Json | null;
  rulesets: Json[];
  /** Classic branch protection by branch; null: the branch has none. */
  protection: Record<string, Json | null>;
  /** Workflow permissions; null: absent. */
  workflow: Json | null;
  vulnerabilityAlerts: boolean;
}

export interface ReleaseInfo {
  tag: string;
  url: string;
  draft: boolean;
  createdAt: string;
}

/** A check's state on a commit, by name. */
export type CheckState = "green" | "pending" | "red";

export interface IssueRow {
  number: number;
  url: string;
  state: string;
  /** The author's login, or null. */
  author: string | null;
  labels: string[];
  /** INT-63: the host says the issue is confidential. A host with no such issues leaves it out. */
  confidential?: boolean;
}

export interface IssueText {
  title: string;
  body: string;
  author: string | null;
  labels: string[];
  /** INT-63: as in `IssueRow`; the text of a confidential issue is not used. */
  confidential?: boolean;
}

export interface PrReview {
  author: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: string;
  body: string;
  /** RFC 3339. */
  at: string;
  /** The head it reviewed, when the host says. */
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

/** One change request as the loop reads it (PIP-21). */
export interface PrState {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  mergeCommit: string | null;
  head: string;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string;
  body: string;
  isDraft: boolean;
  /** PIP-142: the PR's author, the host's review decision and the base branch, when the host says. */
  author?: string;
  reviewDecision?: string;
  base?: string;
  reviews: PrReview[];
  /** Conversation comments, then review comments. */
  comments: PrComment[];
}

export interface BranchPr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** The login as the host prints it (`app/x`, `x`, `x[bot]`). */
  author: string;
}

export interface Forge {
  /** `[github].me`: the owner's login. */
  readonly me: string;
  /** The bot user (commit author). */
  bot(): Promise<Bot>;
  /** Git arguments and environment that push and fetch `repo` as the bot. */
  gitAuth(repo: string): Promise<GitAuth>;
  /** The same forge acting as the owner (their own login), not the bot. */
  asOwner(): Forge;

  /** Open a change request; its number, or null when the host did not say. */
  openPr(
    repo: string,
    o: { base: string; head: string; title: string; body: string },
  ): Promise<number | null>;
  /** The number of the open change request whose branch is `head`, or null. */
  openPrOn(repo: string, head: string): Promise<number | null>;
  /** Every open change request: number and branch. */
  openPrBranches(repo: string): Promise<{ number: number; branch: string }[]>;
  /** Merged change requests (the latest 300): number, branch and merge commit (null when the host did not say). */
  mergedPrBranches(repo: string): Promise<{ number: number; branch: string; mergeCommit: string | null }[]>;
  reviews(repo: string, n: number): Promise<Review[]>;
  updatePrBody(repo: string, n: number, body: string): Promise<void>;
  commentOnPr(repo: string, n: number, text: string, how?: { inline?: boolean }): Promise<Result>;
  markReady(repo: string, n: number): Promise<Result>;
  mergePr(repo: string, n: number, o: { method: MergeMethod; head?: string }): Promise<Result>;
  closePr(repo: string, n: number, comment?: string): Promise<Result>;
  /** Merge the base branch into the change request's head, if the head is still `expectedHead`. */
  updateBranch(repo: string, n: number, expectedHead: string): Promise<void>;
  mergeStatus(repo: string, n: number): Promise<MergeStatus>;
  prBrief(repo: string, n: number): Promise<PrBrief>;
  prFiles(repo: string, n: number): Promise<FileChange[]>;

  readChecks(repo: string, n: number): Promise<ChecksRead>;
  rerunFailed(repo: string, run: number): Promise<void>;
  /** Cancel a run that hangs (PIP-171). */
  cancelRun(repo: string, run: number): Promise<void>;
  /** The log of the failed jobs of a run. */
  failedLog(repo: string, run: number): Promise<string>;
  /** The whole log of one job of a run (PIP-154). */
  jobLog(repo: string, job: number): Promise<string>;
  /**
   * PIP-148: the open code scanning alerts of a change request's merge ref (none for a host without
   * code scanning). Throws `ForgeDenied` when the bot may not read them.
   */
  codeScanningAlerts(repo: string, n: number): Promise<CodeScanningAlert[]>;

  listDeployments(repo: string, environment: string, sha?: string): Promise<Deployment[]>;
  /** The newest status of a deployment, or null. */
  deploymentStatus(repo: string, id: number): Promise<DeploymentStatus | null>;
  /** Ask for a deployment; its id. Throws `ForgeDenied` when the bot may not. */
  createDeployment(repo: string, body: Record<string, unknown>): Promise<number>;

  /** `repo`'s own spelling of its name and its default branch. Throws the host's reason. */
  repoInfo(repo: string): Promise<{ name: string; defaultBranch: string }>;

  /** The login the owner's tool is signed in as (the active one), or null. */
  activeOwnerLogin(): Promise<string | null>;
  /** Every login the owner's tool is signed in as, lowercase. */
  ownerLogins(): Promise<string[]>;

  /** A file of `repo` at `ref` as text, or null when it is not there. Throws on any other failure. */
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  /** The names of the checks that ended `success` on the head of `branch`; null when that can't be read. */
  greenChecks(repo: string, branch: string): Promise<Set<string> | null>;
  /** Everything the settings script can change. Throws `ForgeDenied` when the bot may not read it. */
  readSettings(repo: string, base: string, extraBranches?: string[]): Promise<SettingsSnapshot>;
  /** Write a snapshot back; what was done and what could not be, one line each. */
  restoreSettings(repo: string, snapshot: SettingsSnapshot): Promise<string[]>;
  /** Whether the base branch requires a status check; null when the host can't say. */
  requiresStatusChecks(repo: string, branch: string): Promise<boolean | null>;
  /** Open change requests whose branch is `branch` of `repo`'s own owner: number, text, author, head commit. */
  openPrsFrom(
    repo: string,
    branch: string,
  ): Promise<{ number: number; body: string | null; author: string; head: string }[]>;
  /** The commit a branch points at. */
  branchHead(repo: string, branch: string): Promise<string>;
  /** The commit `a` and `b` share, or null. */
  mergeBase(repo: string, a: string, b: string): Promise<string | null>;
  /** The files of a change request with their patches. */
  prPatches(repo: string, n: number): Promise<{ name: string; patch: string | null }[]>;
  /** Every check of a commit by name, and the checks `branch` requires (empty when it names none). */
  commitChecks(
    repo: string,
    sha: string,
    branch: string,
  ): Promise<{ seen: Map<string, CheckState>; required: string[] }>;
  /** The newest releases, at most `limit`. */
  listReleases(repo: string, limit: number): Promise<ReleaseInfo[]>;
  /** Whether `tag` contains `sha`; null when the host can't say. */
  tagContains(repo: string, sha: string, tag: string): Promise<boolean | null>;
  /** Every issue (open and closed) up to `limit`, without their text. */
  listIssues(repo: string, limit: number): Promise<IssueRow[]>;
  /** One issue's text. */
  readIssue(repo: string, n: number): Promise<IssueText>;
  commentOnIssue(repo: string, n: number, text: string): Promise<void>;
  /** Put a label on an issue, creating the label (with `color`) first. */
  addLabel(repo: string, n: number, label: string, color: string): Promise<void>;
  removeLabels(repo: string, n: number, labels: string[]): Promise<void>;
  /** Who put `label` on issue `n`, oldest first (`actor` null: unknown). */
  labelEvents(repo: string, n: number, label: string): Promise<{ label: string; actor: string | null }[]>;

  /** The branch and title of the open change requests, at most `limit`. */
  openPrTitles(repo: string, limit: number): Promise<{ branch: string; title: string }[]>;
  /** A change request with its reviews and comments (PIP-21). */
  readPr(repo: string, n: number): Promise<PrState>;
  /** PIP-142: the author, review decision and base branch of a change request. */
  readPrExtra(repo: string, n: number): Promise<Pick<PrState, "author" | "reviewDecision" | "base">>;
  /** The change requests, in any state, whose branch is `branch`. */
  prsOnBranch(repo: string, branch: string): Promise<BranchPr[]>;
  /** Delete a branch of Towercab's (PIP-89); one already gone counts as deleted. */
  deleteBranch(repo: string, branch: string, intentsRepo: string | null): Promise<void>;
  /** After a change request was closed unmerged, delete its branch if it is Towercab's alone (PIP-87, PIP-88). */
  retireBranch(repo: string, n: number, intentsRepo: string | null): Promise<string | null>;
  /** Edit the bot's comment whose first line is `marker`, else post `text`; whether it edited. */
  upsertPrComment(repo: string, n: number, marker: string, text: string): Promise<{ edited: boolean }>;
  /** PIP-146: make the owner the assignee; false when the host refuses. */
  assignOwner(repo: string, n: number): Promise<boolean>;
  /** `CODEOWNERS` from `base`; null when it can't be read. */
  codeowners(repo: string, base: string): Promise<string | null>;
  /** A change request's changed paths; null when unreadable or possibly cut off. */
  changedPaths(repo: string, n: number): Promise<string[] | null>;
  /** The ids of a change request's approving reviews. */
  approvedReviewIds(repo: string, n: number): Promise<Set<string>>;
  /** The approvals `base` requires; null when that can't be read. */
  requiredApprovals(repo: string, base: string): Promise<number | null>;
  /** PIP-143: ask each login for a review, one by one; the ones that failed. */
  requestReviewers(repo: string, n: number, logins: string[]): Promise<{ failed: string[] }>;
  /** The open change requests that propose intents (INT-*). Throws when the host can't be read. */
  readProposed(repo: string, cache: ProposedCache, bot: string): Promise<ProposedPr[]>;
}
