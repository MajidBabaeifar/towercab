// GitHub issues become intents (INT-20..28): every poll lists the issues of each `[repos]` repo, reads
// only the ones the owner wrote or labelled `towercab`, has a tool-less Claude run score them, proposes
// the intent as a PR on the intents repo that only the owner's merge accepts, and tells the issue.
// Issue text is untrusted: the list carries none, and the text of an ineligible issue is never fetched.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentBudgetUsd, loadAgent } from "../agents.ts";
import { type ClaudeRun, parseRun, prepareRun } from "../claude.ts";
import type { Config, RepoConfig } from "../config.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { Home } from "../home.ts";
import { newId, slugOf } from "../intents/id.ts";
import { plainLine, TITLE_MAX } from "../intents/naming.ts";
import { intentText } from "../intents/store.ts";
import type { Intent, IntentStore, Listing, NewIntent } from "../intents/types.ts";
import { oneLine } from "../machine.ts";
import { prUrl } from "../pipeline/common.ts";
import { commitToIntents } from "../pipeline/plan.ts";
import { fence, render } from "../pipeline/prompts.ts";
import { parseResult, SCHEMAS, type ScoreResult } from "../pipeline/schemas.ts";
import { isParked, pickOrder } from "../priority.ts";
import { checkoutRoot } from "../service.ts";
import { check, type Tools } from "../tools.ts";
import { prsOnBranch } from "./branches.ts";

/** The label that makes another author's issue eligible (INT-20). */
export const TRIGGER_LABEL = "towercab";
/** Added once the intent PR is open and waits for the owner (INT-25). */
export const PROPOSED_LABEL = "towercab:proposed";
/** Added once the owner merged the intent PR and it is queued (INT-25). */
export const QUEUED_LABEL = "towercab:queued";
/** Added when scoring failed twice; the issue is not polled again until it is removed (INT-22). */
export const FAILED_LABEL = "towercab:failed";

/** The clone under `<home>` that intent PRs are pushed from (INT-23). */
const CLONE = "issues";

/** How many issues one list call reads. */
const LIMIT = 200;
/** The longest issue body a scoring run reads. */
const BODY_MAX = 20_000;

export interface IssueDeps {
  config: Config;
  home: Home;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: GitHub;
  log(line: string): void;
  /** IDs of intents that have an unfinished mission (INT-28: a started intent is left alone). */
  busy(): Set<string>;
  /** Default: this checkout's `bin/towercab`. */
  towercabExe?: string;
  /** The user's HOME. Default: `os.homedir()`. */
  userHome?: string;
}

/** What the list call returns per issue: no title and no body. */
interface Listed {
  number: number;
  url: string;
  state: string;
  author: { login?: string } | null;
  labels: { name: string }[];
}

interface Viewed {
  title: string;
  body: string;
  author: { login?: string } | null;
  labels: { name: string }[];
}

const names = (labels: { name: string }[] | undefined): string[] => (labels ?? []).map((l) => l.name);

/** INT-20: written by `me` (case-insensitive), or labelled `towercab`. */
export function isEligible(
  i: { author?: { login?: string } | null; labels?: { name: string }[] },
  me: string,
): boolean {
  if (i.author?.login?.toLowerCase() === me.toLowerCase()) return true;
  return names(i.labels).includes(TRIGGER_LABEL);
}

/** INT-24: the issue's `a1`..`a5` label (the lowest if several), else `dflt`. */
export function autonomyFrom(labels: string[], dflt: number): number {
  const as = labels.flatMap((l) => {
    const m = /^a([1-5])$/.exec(l);
    return m ? [Number(m[1])] : [];
  });
  return as.length ? Math.min(...as) : dflt;
}

/** INT-61: said when an earlier merged proposal left no intent file behind. */
const LOST_NOTE = "The earlier intent for this issue was lost, so Towercab wrote it again.";

/** INT-25: the comment that says the issue is queued (the writing guide's style, no internal terms). */
export function queuedComment(o: {
  title: string;
  intentUrl: string | null;
  reasons: string;
  place: { n: number } | "parked" | null;
  /** INT-61: the intent had been lost and is written again. */
  lost?: boolean;
}): string {
  const what = o.intentUrl ? `[${o.title}](${o.intentUrl})` : o.title;
  const where =
    o.place === "parked"
      ? "Its priority is below the cutoff, so it stays parked until its scores are raised."
      : o.place
        ? `It is number ${o.place.n} in the queue.`
        : "It waits for the intents it depends on.";
  return [
    `This issue is queued as work for Towercab: ${what}.`,
    o.lost ? LOST_NOTE : "",
    o.reasons,
    where,
    "To drop it, close this issue before work starts. To change its order, edit the scores in the intent file.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** INT-25: the comment that says the intent waits for the owner's merge. */
export function proposedComment(prUrl: string): string {
  return [
    `Towercab has written this issue up as work in [a pull request](${prUrl}) for the owner to approve.`,
    "Nothing starts until the owner merges it. Closing it, or this issue, means no.",
  ].join("\n\n");
}

/** INT-23: the intent PR's body. */
function proposalBody(o: { issueUrl: string; reasons: string; a: number; lost?: boolean }): string {
  return [
    `Towercab wrote this intent from ${o.issueUrl}.`,
    o.lost ? LOST_NOTE : "",
    o.reasons,
    `It runs at autonomy a${o.a}.`,
    "Merging this pull request accepts it as work. Closing it says no, and the issue is not proposed again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** INT-23: the intents-repo branch an issue's intent is proposed from. */
export function proposalBranch(repo: RepoConfig, n: number): string {
  return `issue/${repo.name}-${n}`;
}

/** INT-62: the comment that says a closed proposal cleared the label. */
export function closedProposalComment(prUrl: string): string {
  return [
    `The [pull request](${prUrl}) that proposed this issue as work was closed without merging, so Towercab removed its label.`,
    "Towercab will not propose this issue again.",
  ].join("\n\n");
}

function failedComment(): string {
  return "Towercab could not turn this issue into a description of work: its scoring run gave no usable answer twice. Please write the intent by hand in the intents repo, or remove the `towercab:failed` label to try again.";
}

type Scored =
  | { kind: "ok"; value: ScoreResult }
  | { kind: "bad"; why: string }
  | { kind: "later"; why: string };

/** INT-22: one tool-less run over the issue's title, body and labels. */
async function scoreOnce(d: IssueDeps, text: string, product: string): Promise<Scored> {
  const runsDir = d.home.runs("issues");
  const cwd = join(runsDir, "empty");
  mkdirSync(cwd, { recursive: true });
  const n = readdirSync(runsDir).filter((f) => /^score-\d+\.prompt$/.test(f)).length + 1;
  const agent = loadAgent("score");
  const run: ClaudeRun = {
    kind: "score",
    model: d.config.agent.model,
    cwd,
    runsDir,
    n,
    prompt: render("score", { issue: fence(text, "issue"), product }),
    agent: "score",
    schema: SCHEMAS[agent.schema!],
    session: { mode: "none", id: "" },
    budgetUsd: agentBudgetUsd(agent, d.config),
    claudeMd: "",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    config: d.config,
  };
  const home = d.userHome ?? homedir();
  const spec = {
    ...prepareRun(run, { towercabExe: d.towercabExe ?? join(checkoutRoot(), "bin", "towercab"), home }),
    slot: false,
  };
  const handle = d.tools.spawn(spec);
  let timer: NodeJS.Timeout | undefined;
  const end = await Promise.race([
    handle.done,
    new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), (agent.timeoutMin * 60 + 10) * 1000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (end === "timeout") {
    handle.kill("SIGKILL");
    return { kind: "later", why: "the scoring run timed out" };
  }
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const r = parseRun(read(spec.stdout), read(spec.stderr), end.code, {
    model: d.config.agent.model,
    now: new Date(d.clock.now() * 1000),
    home,
  });
  if (r.kind === "limit" || r.kind === "env" || r.kind === "sessionGone")
    return { kind: "later", why: r.kind === "env" ? `${r.fault}: ${r.text}` : r.kind };
  if (r.kind !== "ok") return { kind: "bad", why: r.kind };
  const parsed = parseResult("score", r.result.structuredOutput);
  if (!parsed.ok) return { kind: "bad", why: parsed.why };
  if (!oneLine(parsed.value.title, 200).trim()) return { kind: "bad", why: "result.title is empty" };
  return { kind: "ok", value: parsed.value };
}

/** A bad result is retried once (INT-22). */
async function score(d: IssueDeps, text: string, product: string): Promise<Scored> {
  const first = await scoreOnce(d, text, product);
  return first.kind === "bad" ? scoreOnce(d, text, product) : first;
}

/** One line, no leading list marker or heading. */
function plain(s: string): string {
  return oneLine(s, 400)
    .replace(/^(?:[-*]\s+|#+\s*)/, "")
    .trim();
}

/** The intent's body from a score (INT-23). Model text cannot open a section of its own. */
function bodyOf(s: ScoreResult): string {
  const problem = s.problem
    .split("\n")
    .map((l) => l.replace(/^\s{0,3}#+\s*/, ""))
    .join("\n")
    .trim();
  const outcome = s.outcome.map(plain).filter(Boolean);
  const affected = plain(s.affected);
  const constraints = s.constraints.map(plain).filter(Boolean);
  const questions = s.open_questions.map(plain).filter(Boolean);
  // INT-32: a section only when the issue said something for it.
  const more = [
    ...(affected ? ["## Affected users and systems", "", affected, ""] : []),
    ...(constraints.length ? ["## Constraints", "", ...constraints.map((c) => `- ${c}`), ""] : []),
    ...(questions.length ? ["## Open questions", "", ...questions.map((q) => `- ${q}`), ""] : []),
  ];
  return [
    "## Problem",
    "",
    problem || "See the GitHub issue.",
    "",
    "## Proposed outcome",
    "",
    ...(outcome.length ? outcome : ["The issue is resolved."]).map((o) => `- ${o}`),
    "",
    ...more,
    "## Towercab",
    "",
    `- Urgency ${s.u} of 5: ${plain(s.u_why)}`,
    `- Importance ${s.i} of 5: ${plain(s.i_why)}`,
  ].join("\n");
}

/** What the scoring run reads: the title, the labels and the body, and nothing else (INT-22). */
function issueText(v: Viewed): string {
  const body = v.body.length > BODY_MAX ? `${v.body.slice(0, BODY_MAX)}\n[cut]` : v.body;
  return `Title: ${oneLine(v.title, 300)}\nLabels: ${names(v.labels).join(", ") || "none"}\n\n${body}`;
}

async function gh(
  d: IssueDeps,
  github: string,
  args: string[],
  what: string,
  input?: string,
): Promise<string> {
  return check(await d.github.gh(github, args, input === undefined ? {} : { input }), what);
}

async function ensureLabel(d: IssueDeps, repo: RepoConfig, label: string, color: string): Promise<void> {
  await gh(
    d,
    repo.github,
    ["label", "create", label, "-R", repo.github, "--force", "--color", color, "--description", "Towercab"],
    "gh label create",
  );
}

async function addLabel(
  d: IssueDeps,
  repo: RepoConfig,
  n: number,
  label: string,
  color: string,
): Promise<void> {
  await ensureLabel(d, repo, label, color);
  await gh(
    d,
    repo.github,
    ["issue", "edit", String(n), "-R", repo.github, "--add-label", label],
    "gh issue edit",
  );
}

/** INT-62: take labels off an issue in one call. */
async function removeLabels(d: IssueDeps, repo: RepoConfig, n: number, labels: string[]): Promise<void> {
  if (!labels.length) return;
  await gh(
    d,
    repo.github,
    ["issue", "edit", String(n), "-R", repo.github, ...labels.flatMap((l) => ["--remove-label", l])],
    "gh issue edit",
  );
}

/**
 * INT-61: whether the owner set the issue's latest `towercab:queued` label, which is their approval.
 * A failed read throws, so the issue is tried again and never counts as set by someone else.
 */
async function queuedByOwner(d: IssueDeps, repo: RepoConfig, n: number): Promise<boolean> {
  const out = await gh(
    d,
    repo.github,
    [
      "api",
      `repos/${repo.github}/issues/${n}/events`,
      "--paginate",
      "--jq",
      '.[] | select(.event == "labeled") | {label: .label.name, actor: .actor.login}',
    ],
    "gh api issue events",
  );
  const events = out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { label: string; actor: string | null })
    .filter((e) => e.label === QUEUED_LABEL);
  const last = events[events.length - 1];
  return !!last?.actor && last.actor.toLowerCase() === d.github.me.toLowerCase();
}

/** INT-25: the comment, then the label; the place is the intent's spot in the pick order (PRI-4, PRI-5). */
async function announce(
  d: IssueDeps,
  repo: RepoConfig,
  issue: Listed,
  intent: Intent,
  lost = false,
): Promise<void> {
  const l = await d.store.list();
  const cur = l.open.find((i) => i.id === intent.id) ?? intent;
  const at = pickOrder(l, d.config.intents.cutoff).findIndex((i) => i.id === cur.id);
  const place = isParked(cur, d.config.intents.cutoff) ? "parked" : at >= 0 ? { n: at + 1 } : null;
  const body = queuedComment({
    title: cur.title,
    intentUrl: d.store.url(cur),
    reasons: cur.sections.get("Towercab") ?? "",
    place,
    lost,
  });
  await gh(
    d,
    repo.github,
    ["issue", "comment", String(issue.number), "-R", repo.github, "--body-file", "-"],
    "gh issue comment",
    body,
  );
  await addLabel(d, repo, issue.number, QUEUED_LABEL, "0e8a16");
}

/** True when some intent file that cannot be read mentions `url` (INT-26). */
async function mentionedInUnreadable(d: IssueDeps, listing: Listing, url: string): Promise<boolean> {
  for (const u of listing.unreadable) {
    if (!u.path.endsWith("intent.md")) continue;
    const text = await d.store.readFile(u.path).catch(() => null);
    if (text?.includes(url)) return true;
  }
  return false;
}

/** What one poll shares between issues: the IDs handed out so far (INT-23). */
interface Poll {
  /** The intents repo on GitHub; null when its remote isn't GitHub. */
  intents: string | null;
  /** IDs on `main`, in other open intent PRs, and handed out in this poll; null until first needed. */
  taken: Set<string> | null;
}

/** The intents repo on GitHub: without one no issue can be proposed (INT-23). */
function intentsRepo(poll: Poll): string {
  if (!poll.intents)
    throw new Error("the intents repo isn't on GitHub, so an issue can't be proposed as an intent PR");
  return poll.intents;
}

/** INT-23: the IDs no new proposal may take: `main`'s, and those in the titles of open `issue/*` PRs. */
async function takenIds(d: IssueDeps, poll: Poll, listing: Listing): Promise<Set<string>> {
  if (poll.taken) return poll.taken;
  const intents = intentsRepo(poll);
  const open = JSON.parse(
    await gh(
      d,
      intents,
      [
        "pr",
        "list",
        "-R",
        intents,
        "--state",
        "open",
        "--limit",
        String(LIMIT),
        "--json",
        "headRefName,title",
      ],
      "gh pr list",
    ),
  ) as { headRefName: string; title?: string }[];
  const taken = new Set<string>([
    ...listing.open.map((i) => i.id),
    ...listing.done.map((i) => i.id),
    ...listing.doneIds,
    ...listing.unreadable.flatMap((u) => (u.id ? [u.id] : [])),
  ]);
  for (const p of open) {
    const m = /^docs\(intents\): add (\S+) /.exec(p.title ?? "");
    if (p.headRefName.startsWith("issue/") && m) taken.add(m[1]!);
  }
  poll.taken = taken;
  return taken;
}

/** INT-23: commit the intent on its branch of the intents repo and open the PR; returns its URL. */
async function propose(
  d: IssueDeps,
  poll: Poll,
  listing: Listing,
  branch: string,
  n: NewIntent,
  issueUrl: string,
  reasons: string,
  lost = false,
): Promise<string> {
  const intents = intentsRepo(poll);
  const now = new Date(d.clock.now() * 1000);
  const text = intentText(n, now);
  const taken = await takenIds(d, poll, listing);
  const id = newId(now, taken);
  taken.add(id);
  const title = `docs(intents): add ${id} ${n.title.trim()}`;
  await commitToIntents(
    d,
    branch,
    "origin/main",
    { [`intents/${id}-${slugOf(n.title.trim())}/intent.md`]: text },
    title,
    CLONE,
  );
  // INT-61: the owner's own label is their yes, so the intent goes straight to `main` with no PR.
  if (branch === "main") return "";
  const out = await gh(
    d,
    intents,
    ["pr", "create", "-R", intents, "--base", "main", "--head", branch, "--title", title, "--body-file", "-"],
    "gh pr create",
    proposalBody({ issueUrl, reasons, a: n.a ?? d.config.intents.issueA, lost }),
  );
  const m = /\/pull\/(\d+)/.exec(out);
  if (!m) throw new Error(`gh pr create printed no PR URL: ${oneLine(out, 200)}`);
  return prUrl(intents, Number(m[1]));
}

/** INT-25: tell the issue its intent PR waits for the owner, then label it. */
async function proposed(d: IssueDeps, repo: RepoConfig, issue: Listed, url: string): Promise<void> {
  await gh(
    d,
    repo.github,
    ["issue", "comment", String(issue.number), "-R", repo.github, "--body-file", "-"],
    "gh issue comment",
    proposedComment(url),
  );
  await addLabel(d, repo, issue.number, PROPOSED_LABEL, "fbca04");
}

async function pollIssue(
  d: IssueDeps,
  poll: Poll,
  repo: RepoConfig,
  issue: Listed,
  listing: Listing,
  known: Map<string, Intent>,
): Promise<void> {
  const labels = names(issue.labels);
  const intent = known.get(issue.url);
  const branch = proposalBranch(repo, issue.number);

  // INT-28: closing the issue before the intent starts drops it, or closes its open intent PR.
  if (issue.state.toUpperCase() === "CLOSED") {
    if (intent && !intent.done && intent.stage === null && !d.busy().has(intent.id)) {
      await d.store.update(intent.id, "drop", (e) => {
        e.setField("stage", "dropped");
        e.removeField("waiting");
        e.setSection("Towercab", "issue closed");
      });
      d.log(`${issue.url}: closed; dropped ${intent.id}`);
    } else if (!intent && labels.includes(PROPOSED_LABEL)) {
      const intents = intentsRepo(poll);
      for (const pr of await prsOnBranch(d.github, intents, branch)) {
        if (pr.state !== "OPEN") continue;
        await gh(
          d,
          intents,
          ["pr", "close", String(pr.number), "-R", intents, "--comment", "The issue was closed."],
          "gh pr close",
        );
        d.log(`${issue.url}: closed; closed its intent PR #${pr.number}`);
      }
    }
    return;
  }
  if (!isEligible(issue, d.github.me)) return;

  // INT-25: an intent the owner merged is announced once, never written again.
  if (intent) {
    if (!intent.done && !labels.includes(QUEUED_LABEL)) await announce(d, repo, issue, intent);
    return;
  }
  // INT-22: scoring failed twice before; the owner removes the label to try again.
  if (labels.includes(FAILED_LABEL)) return;
  // INT-60: a queued or proposed label promises an intent or an open proposal.
  const labelled = labels.includes(QUEUED_LABEL) || labels.includes(PROPOSED_LABEL);
  // INT-26: an unreadable file of an earlier intent still counts.
  if (await mentionedInUnreadable(d, listing, issue.url)) return;
  // INT-26: a PR from this issue's branch, in any state, is its one proposal; a closed one is a no.
  const intents = intentsRepo(poll);
  const prs = await prsOnBranch(d.github, intents, branch);
  const latest = prs.reduce<(typeof prs)[number] | null>((a, p) => (!a || p.number > a.number ? p : a), null);
  let lost = false;
  if (prs.length) {
    const open = prs.find((p) => p.state === "OPEN");
    if (open) {
      // INT-61: a queued label beside an open proposal is corrected to proposed.
      if (!labels.includes(PROPOSED_LABEL)) await proposed(d, repo, issue, prUrl(intents, open.number));
      if (labels.includes(QUEUED_LABEL)) await removeLabels(d, repo, issue.number, [QUEUED_LABEL]);
      return;
    }
    if (!labelled) return;
    if (latest!.state === "CLOSED") {
      // INT-62: the comment first, then the labels, so a failed comment is tried again.
      await gh(
        d,
        repo.github,
        ["issue", "comment", String(issue.number), "-R", repo.github, "--body-file", "-"],
        "gh issue comment",
        closedProposalComment(prUrl(intents, latest!.number)),
      );
      await removeLabels(
        d,
        repo,
        issue.number,
        labels.filter((l) => l === QUEUED_LABEL || l === PROPOSED_LABEL),
      );
      d.log(`${issue.url}: its intent PR #${latest!.number} was closed; removed the label`);
      return;
    }
    // INT-61: merged, yet no intent file is left.
    lost = true;
  }
  const byOwner = labels.includes(QUEUED_LABEL) && (await queuedByOwner(d, repo, issue.number));

  const view = JSON.parse(
    await gh(
      d,
      repo.github,
      ["issue", "view", String(issue.number), "-R", repo.github, "--json", "title,body,author,labels"],
      "gh issue view",
    ),
  ) as Viewed;
  // The labels may have changed since the list.
  if (!isEligible(view, d.github.me)) return;

  const scored = await score(d, issueText(view), repo.name);
  if (scored.kind === "later") {
    d.log(`${issue.url}: not scored, trying again later: ${scored.why}`);
    return;
  }
  if (scored.kind === "bad") {
    d.log(`${issue.url}: scoring failed twice: ${scored.why}`);
    await gh(
      d,
      repo.github,
      ["issue", "comment", String(issue.number), "-R", repo.github, "--body-file", "-"],
      "gh issue comment",
      failedComment(),
    );
    await addLabel(d, repo, issue.number, FAILED_LABEL, "d93f0b");
    return;
  }
  const s = scored.value;
  const n: NewIntent = {
    repo: repo.name,
    title: plainLine(s.title, TITLE_MAX) || `GitHub issue #${issue.number}`,
    u: s.u,
    i: s.i,
    a: autonomyFrom(names(view.labels), d.config.intents.issueA),
    source: "issue",
    fields: { issue: issue.url },
    body: bodyOf(s),
  };
  const reasons = [
    `- Urgency ${s.u} of 5: ${plain(s.u_why)}`,
    `- Importance ${s.i} of 5: ${plain(s.i_why)}`,
  ].join("\n");
  if (byOwner) {
    await propose(d, poll, listing, "main", n, issue.url, reasons, lost);
    d.log(`${issue.url}: queued by the owner; wrote its intent to main`);
    // A crash from here on leaves the label and no comment; the intent itself is found next poll.
    const now = (await d.store.list()).open.find((i) => i.issue === issue.url);
    if (now) await announce(d, repo, issue, now, lost);
    return;
  }
  const url = await propose(d, poll, listing, branch, n, issue.url, reasons, lost);
  d.log(`${issue.url}: proposed as ${url}`);
  await proposed(d, repo, issue, url);
  if (labels.includes(QUEUED_LABEL)) await removeLabels(d, repo, issue.number, [QUEUED_LABEL]);
}

/**
 * INT-21: one poll of every repo. A repo or an issue that fails does not stop the others; the
 * failures come back as one error, which the loop records as a `github` fault (LOOP-10).
 */
export async function pollIssues(d: IssueDeps): Promise<void> {
  const errors: string[] = [];
  const poll: Poll = { intents: d.store.github(), taken: null };
  for (const repo of d.config.repos.values()) {
    try {
      const listed = JSON.parse(
        await gh(
          d,
          repo.github,
          [
            "issue",
            "list",
            "-R",
            repo.github,
            "--state",
            "all",
            "--limit",
            String(LIMIT),
            "--json",
            "number,url,state,author,labels",
          ],
          "gh issue list",
        ),
      ) as Listed[];
      const listing = await d.store.list();
      const known = new Map<string, Intent>();
      for (const i of [...listing.open, ...listing.done]) if (i.issue) known.set(i.issue, i);
      for (const issue of listed.sort((a, b) => a.number - b.number)) {
        try {
          await pollIssue(d, poll, repo, issue, listing, known);
        } catch (e) {
          errors.push(`${repo.github}#${issue.number}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push(`${repo.github}: ${(e as Error).message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}
