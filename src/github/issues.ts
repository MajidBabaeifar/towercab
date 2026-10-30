// GitHub issues become intents (INT-20..28): every poll lists the issues of each `[repos]` repo, reads
// only the ones the owner wrote or labelled `towercab`, has a tool-less Claude run score them, writes
// the intent straight to `main`, and tells the issue. Issue text is untrusted: the list carries none,
// and the text of an ineligible issue is never fetched.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentBudgetUsd, loadAgent } from "../agents.ts";
import { type ClaudeRun, parseRun, prepareRun } from "../claude.ts";
import type { Config, RepoConfig } from "../config.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { Home } from "../home.ts";
import type { Intent, IntentStore, Listing } from "../intents/types.ts";
import { oneLine } from "../machine.ts";
import { fence, render } from "../pipeline/prompts.ts";
import { parseResult, SCHEMAS, type ScoreResult } from "../pipeline/schemas.ts";
import { isParked, pickOrder } from "../priority.ts";
import { checkoutRoot } from "../service.ts";
import { check, type Tools } from "../tools.ts";

/** The label that makes another author's issue eligible (INT-20). */
export const TRIGGER_LABEL = "towercab";
/** Added once the issue is queued (INT-25). */
export const QUEUED_LABEL = "towercab:queued";
/** Added when scoring failed twice; the issue is not polled again until it is removed (INT-22). */
export const FAILED_LABEL = "towercab:failed";

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

/** INT-25: the comment that says the issue is queued (the writing guide's style, no internal terms). */
export function queuedComment(o: {
  title: string;
  intentUrl: string | null;
  reasons: string;
  place: { n: number } | "parked" | null;
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
    o.reasons,
    where,
    "To drop it, close this issue before work starts. To change its order, edit the scores in the intent file.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
  repo: RepoConfig,
  args: string[],
  what: string,
  input?: string,
): Promise<string> {
  return check(await d.github.gh(repo.github, args, input === undefined ? {} : { input }), what);
}

async function ensureLabel(d: IssueDeps, repo: RepoConfig, label: string, color: string): Promise<void> {
  await gh(
    d,
    repo,
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
  await gh(d, repo, ["issue", "edit", String(n), "-R", repo.github, "--add-label", label], "gh issue edit");
}

/** INT-25: the comment, then the label; the place is the intent's spot in the pick order (PRI-4, PRI-5). */
async function announce(d: IssueDeps, repo: RepoConfig, issue: Listed, intent: Intent): Promise<void> {
  const l = await d.store.list();
  const cur = l.open.find((i) => i.id === intent.id) ?? intent;
  const at = pickOrder(l, d.config.intents.cutoff).findIndex((i) => i.id === cur.id);
  const place = isParked(cur, d.config.intents.cutoff) ? "parked" : at >= 0 ? { n: at + 1 } : null;
  const body = queuedComment({
    title: cur.title,
    intentUrl: d.store.url(cur),
    reasons: cur.sections.get("Towercab") ?? "",
    place,
  });
  await gh(
    d,
    repo,
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

async function pollIssue(
  d: IssueDeps,
  repo: RepoConfig,
  issue: Listed,
  listing: Listing,
  known: Map<string, Intent>,
): Promise<void> {
  const labels = names(issue.labels);
  const intent = known.get(issue.url);

  // INT-28: closing the issue before the intent starts drops it.
  if (issue.state.toUpperCase() === "CLOSED") {
    if (intent && !intent.done && intent.stage === null && !d.busy().has(intent.id)) {
      await d.store.update(intent.id, "drop", (e) => {
        e.setField("stage", "dropped");
        e.removeField("waiting");
        e.setSection("Towercab", "issue closed");
      });
      d.log(`${issue.url}: closed; dropped ${intent.id}`);
    }
    return;
  }
  if (!isEligible(issue, d.github.me)) return;

  // INT-25: an intent without the label (a crash, a failed comment) is announced, not written again.
  if (intent) {
    if (!intent.done && !labels.includes(QUEUED_LABEL)) await announce(d, repo, issue, intent);
    return;
  }
  // INT-22: scoring failed twice before; the owner removes the label to try again.
  if (labels.includes(FAILED_LABEL) || labels.includes(QUEUED_LABEL)) return;
  // INT-26: an unreadable file of an earlier intent still counts.
  if (await mentionedInUnreadable(d, listing, issue.url)) return;
  const mark = `Towercab-Issue: ${issue.url}`;
  if (await d.store.hasMark(mark)) return;

  const view = JSON.parse(
    await gh(
      d,
      repo,
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
      repo,
      ["issue", "comment", String(issue.number), "-R", repo.github, "--body-file", "-"],
      "gh issue comment",
      failedComment(),
    );
    await addLabel(d, repo, issue.number, FAILED_LABEL, "d93f0b");
    return;
  }
  const s = scored.value;
  const added = await d.store.add(
    {
      repo: repo.name,
      title: plain(s.title).slice(0, 120) || `GitHub issue #${issue.number}`,
      u: s.u,
      i: s.i,
      a: autonomyFrom(names(view.labels), d.config.intents.issueA),
      source: "issue",
      fields: { issue: issue.url },
      body: bodyOf(s),
      mark,
    },
    new Date(d.clock.now() * 1000),
  );
  d.log(`${issue.url}: queued as ${added.id}`);
  await announce(d, repo, issue, added);
}

/**
 * INT-21: one poll of every repo. A repo or an issue that fails does not stop the others; the
 * failures come back as one error, which the loop records as a `github` fault (LOOP-10).
 */
export async function pollIssues(d: IssueDeps): Promise<void> {
  const errors: string[] = [];
  for (const repo of d.config.repos.values()) {
    try {
      const listed = JSON.parse(
        await gh(
          d,
          repo,
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
          await pollIssue(d, repo, issue, listing, known);
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
