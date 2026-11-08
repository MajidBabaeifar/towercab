// What every stage handler shares: the mission's intent, repo, files and checkout; Claude runs and
// how their ends become outcomes; git as the bot; questions; the intent's PRs.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AfterHold } from "../after.ts";
import { type Agent, type AgentName, agentBudgetUsd, loadAgent } from "../agents.ts";
import { effectiveA } from "../autonomy.ts";
import { withFlag } from "../autonomy-change.ts";
import { git, gitSane } from "../checkout.ts";
import { type ClaudeRun, freshContext, parseRun, prepareRun, type RunEnd, type RunKind } from "../claude.ts";
import { clonePath, type RepoConfig } from "../config.ts";
import { classifyFailure, classifyRun } from "../faults.ts";
import { must, type Result } from "../forge.ts";
import {
  agentOf,
  answeredByLine,
  type By,
  type Step,
  type TwoPart,
  upsertStageComment,
} from "../github/comments.ts";
import { PausedHold } from "../github/paused.ts";
import { type ChildEnd, type Ctx, EnvError, type GitHub, type Progress } from "../handlers.ts";
import { plainLine, SUBJECT_MAX } from "../intents/naming.ts";
import type { Intent } from "../intents/types.ts";
import { cooldown } from "../limits.ts";
import { type Outcome, wait } from "../machine.ts";
import { dataOf, type Mission } from "../mission.ts";
import { loadRepoFiles, RepoError, type RepoFiles } from "../repo/files.ts";
import type { Risk } from "../risk.ts";
import { checkoutRoot } from "../service.ts";
import { combine, type OwnerStep, type PlanStep, parseNoneLive, parseSteps } from "../steps.ts";
import { grantsFor, parseAccess, type TestAsk } from "./access.ts";
import type { Mech } from "./mechanical.ts";
import { foldMd, plainMd, splitTwoPart, twoPartMd } from "./prtext.ts";
import { cacheEnv, DEFAULT_NETWORK } from "./sandbox.ts";
import { type Access, type Question, type ReviewResult, SCHEMAS } from "./schemas.ts";

/** `missions.data`, as the pipeline uses it. */
export interface ShipData {
  /** The intent's merge commits, oldest first. */
  merges: string[];
  /** When the current wait for a deploy began (unix s). */
  since?: number;
  /** Fix rounds after a rollback (SHIP-11). */
  fixes: number;
  /** The code PRs fix rounds replaced, oldest first (UI-124). */
  prs?: number[];
  /** The e2e run: suite names in order, the one running, its tries. */
  e2e?: { order: string[]; i: number; tries: number };
  /** The version a rollback goes back to. */
  target?: string;
  /** The rollback Deployment Towercab asked for (github adapter). */
  requested?: number;
  /** Smoke suites still to run after a rollback or revert. */
  smoke?: string[];
  /** The last red suite and its redacted log (tail). */
  red?: { suite: string; log: string; path: string };
  /** The revert PR (SHIP-12). */
  revert?: { branch: string; pr: number | null; head: string | null; sha: string | null };
}

/** SHIP-34, SHIP-35: one secret step's progress. */
export interface SecretState {
  pr?: number;
  branch?: string;
  /** The owner approved the PR; Towercab merges it. */
  approved?: boolean;
  /** Failures in a row; at 3 Towercab stops trying until the owner tries again. */
  fails?: number;
  /** The last failure, redacted. */
  error?: string;
}

export interface PipeData {
  design?: {
    type: string;
    scope: string;
    breaking: boolean;
    specIds: string[];
    concerns: { what: string; why: string }[];
    /** The intent's open questions the design left to the owner (PIP-97 reads them). */
    open?: string[];
    pr: string;
    /** PIP-106: the design's plain brief. */
    brief?: string;
    /** INT-34: the plain title it proposed. */
    title?: string;
    /** PIP-111: the change in a few words, for PR titles and commits. */
    subject?: string;
  };
  specBranch?: string;
  /** PIP-130: the open PRs couldn't be read when the design last looked, so its IDs are unchecked against them. */
  idsUnchecked?: boolean;
  /** PIP-130: spec IDs this mission moved because another open spec PR added them (old → new). */
  idsRenumbered?: Record<string, string>;
  /** Spec-PR revisions made for a conflict with base (PIP-81). */
  specConflicts?: number;
  /** The next design run first merges base into the spec branch (PIP-81). */
  mergeMain?: boolean;
  /** Spec-PR revisions made for red checks (PIP-82). */
  specRedRevisions?: number;
  /** The next design run is the revision for red checks, not an owner's comment (PIP-82). */
  specRed?: boolean;
  /** Heads of the spec PR whose red checks were rerun (PIP-18). */
  specReruns?: Record<string, boolean>;
  /** Heads of the spec PR whose hung runs were cancelled (PIP-171). */
  specHung?: Record<string, boolean>;
  plan?: {
    md: string;
    access: Access;
    /** PIP-115: test paths the plan named that are not existing tests, so got no grant line. */
    droppedTests?: string[];
    e2e?: { tests: string[]; none_why: string } | null;
    /** INT-43: the repos of a multi-repo plan, in landing order; absent for a single-repo plan. */
    parts?: string[];
    /** PIP-106: the plan's plain brief. */
    brief?: string;
    /** SHIP-17, SHIP-21: the owner's steps and the "nothing to check live" claim the plan made. */
    ownerSteps?: PlanStep[];
    liveNoneWhy?: string;
  };
  /** PIP-112, PIP-113: absent counts as `code`; `steps` means the owner does the work. */
  delivery?: "code" | "steps";
  /** LOOP-77: the last blocked wait (key, head, count of owner answers) and whether it came back unchanged. */
  lastWait?: { key: string; head: string | null; answers: number };
  stuck?: boolean;
  /** Owner answers given so far (LOOP-77). */
  answers?: number;
  /** SHIP-17: the owner's steps, read from the merged `plan.md` (the file is the record). */
  steps?: OwnerStep[];
  /** SHIP-34: where each secret step is (by step number): its PR, approval and failures. Never a value. */
  secrets?: Record<string, SecretState>;
  /** SHIP-21: the merged plan's claim that nothing about the change can be checked live. */
  liveNoneWhy?: string;
  /** SHIP-22: a tick the database has and `plan.md` doesn't yet; the loop writes it. */
  stepsDirty?: number;
  /** The merged plan's ticked access. */
  granted?: Access;
  /** AUT-15: access the owner allowed mid-build (never granted by Towercab itself). */
  unplanned?: Omit<Access, "tests">;
  /** AUT-15: access the owner refused mid-build, and the request being asked about. */
  refusedAccess?: Omit<Access, "tests">;
  accessAsk?: Omit<Access, "tests">;
  /** PIP-116: existing tests the owner allowed or refused mid-build, and the one being asked about. */
  testAllowed?: { path: string; why: string }[];
  refusedTests?: { path: string; why: string }[];
  testAsk?: TestAsk;
  /** What the resumed worker is told about the owner's answer on a test. */
  testNote?: string;
  /** PIP-152: the existing tests the last worker run was blocked from, which the owner may allow. */
  lockedTests?: string[];
  /** PIP-153: the tests a conflict round may edit, because the base changed them or what they import. */
  mergeOpened?: string[];
  /** The owner's last words for the worker (an answer, feedback). */
  answer?: string;
  /** Why the next build round runs: a repair's what and details. */
  repair?: {
    what: string;
    details: string;
    kind: "verify" | "proof" | "ci" | "conflict" | "e2e" | "review";
    /** PIP-192: an ignore round: the only lines it may add to `.gitleaksignore`, and the details to fall back to. */
    ignore?: { fingerprints: string[]; fallback: string };
  };
  /** Conflict rounds of the code PR since the owner last commented (`seen` = `feedback_seen`; PIP-134). */
  conflictRounds?: { n: number; seen: string | null };
  /** PIP-167..169: a conflict resolved by code, until the review carries over or a worker round starts. */
  mech?: Mech;
  /** PIP-167: the mechanical resolution failed its checks; the next conflict round goes to the worker. */
  mechFailed?: boolean;
  /** Review fix rounds sent back to build (PIP-98). */
  reviewFixes?: number;
  /**
   * PIP-143: `requested` = the head whose reviewers were asked; `passNeeded` = the code PR waits for the
   * owner to pass it on; `passedOn` = the head the owner passed on.
   */
  teammate?: { requested?: string; passNeeded?: boolean; passedOn?: string; unchecked?: boolean };
  /** PIP-147: why the host's review rule can't be met by the reviewers; shown, never sent. */
  reviewWarning?: string;
  /** PIP-145: what approving reviewers wrote, for the record. */
  approvalNotes?: string[];
  /** PIP-119: outcomes only the owner can do, from the last review. */
  ownerSteps?: { bullet: string; why: string }[];
  /** The risk agent's assessment per gate (PIP-96, AUT-16); null = the run didn't finish. */
  risk?: { spec?: Risk | null; plan?: Risk | null; code?: Risk | null };
  /** What each gate's assessment was of (`Risk.of`), kept also when the run didn't finish. */
  riskOf?: { spec?: string; plan?: string; code?: string };
  /** PIP-97: the owner's answers on the spec PR, for the second reviewer; part of the spec's risk key. */
  specAnswers?: string[];
  /** AUT-21: the next step runs the gate's risk check again instead of the stage's run. */
  recheck?: boolean;
  /** The ship stage's state (SHIP-7..12). */
  ship?: ShipData;
  /** HEAD when the current build round began (PIP-1). */
  roundFrom?: string;
  /** LOOP-115: the owner answered a wait; the next build round merges the base branch first. */
  answered?: boolean;
  /** LOOP-117: the mission waits at build for the intents its intent file says it comes after. */
  afterHold?: AfterHold;
  /** Head at the end of the last non-repair round (PIP-31). */
  lockHead?: string;
  /** `brief`: the worker's plain brief of what changed (PIP-106). */
  build?: { pr: string | null; notes: string; planChanged: string | null; brief?: string };
  /** The step whose child really started (LOOP-4); a step re-entered without it never ran. */
  launched?: string;
  /** Runs per kind, for file names. */
  n?: Record<string, number>;
  /** `<kind>`: a cut-off run gets one continue (PIP-1). */
  continued?: Record<string, boolean>;
  /** Unix times of the build runs refused for guard version skew; an hour's worth counts (LOOP-106). */
  skew?: number[];
  /** `<stage>:<round start>`: the build round already retried once for a known setup error (LOOP-107). */
  setupRetried?: Record<string, boolean>;
  setup?: string;
  verify?: { log: string; result: "green" | "red" };
  shots?: string[];
  proof?: "proven" | "none needed" | "not proven";
  proofWaited?: boolean;
  /** The lines the proof ran on base, and whether they are the PR's checks block (PIP-54). */
  proofLines?: { lines: string[]; fromPr: boolean };
  unproven?: boolean;
  ci?: {
    result: "green" | "none" | "pending";
    reruns?: Record<string, boolean>;
    /** Heads whose hung runs were cancelled (PIP-171). */
    hung?: Record<string, boolean>;
    /** Heads that were given an ignore round or an owner question for an old secrets finding (PIP-192, PIP-196). */
    ignored?: Record<string, boolean>;
    since?: number;
  };
  review?: {
    approved: boolean;
    door: "one-way" | "two-way";
    redLines: boolean;
    summary: string;
    details: string;
    patchId: string;
    /** PIP-106: the review's plain brief. */
    brief?: string;
  } | null;
  /**
   * PIP-197: a review waiting for its specialists. `pid` = the diff reviewed, `round` = the Review comment's
   * number, `general` = the general review's result, `areas` = the specialists called in, in run order,
   * `done` = the results in so far.
   */
  specialists?: {
    pid: string;
    round: number;
    general: ReviewResult;
    areas: ("security" | "infra")[];
    done: Partial<Record<"security" | "infra", ReviewResult>>;
  } | null;
  /** Session cost already counted (MET-28). */
  sessionCost?: Record<string, number>;
  mergeTries?: number;
  /** Someone else's commits are on the branch (takeRemote, CI's adopted head). */
  foreignHead?: boolean;
  /** Merge asked GitHub to update the branch: the next moved head is that, not someone else's. */
  updatedBranch?: boolean;
  dropped?: boolean;
  /** Pushes GitHub refused as non-fast-forward, in a row (PIP-85). */
  pushRefusals?: number;
  /** The code branch was pushed once: no leftover check any more (PIP-86). */
  pushed?: boolean;
  /** The question the owner is asked (the UI's card). */
  question?: Question;
  /** PIP-106: the plain brief of the question the owner is asked, when its asker wrote one. */
  brief?: string;
  /** Verify asked whether the checks may write to the repo cache (PIP-95); the answer decides. */
  cacheAsk?: boolean;
  /** The plan's access list (the UI's plan card). */
  access?: Access;
  /** Each run's time and cost, 30 days (MET-29). */
  runs?: { at: number; cost: number }[];
}

export const data = (m: Mission): PipeData => dataOf(m) as PipeData;

/** PIP-165: owner answers on a spec PR after which the spec is settled: no new open points. */
export const SETTLED_ROUNDS = 2;

/**
 * PIP-165: the rounds of owner answers on the spec PR: the kept ones (`specAnswers`) plus the one the
 * current design run is handling (not Towercab's own conflict or red-check revisions).
 */
export function specRounds(d: PipeData): number {
  const pending = d.answer && !d.mergeMain && !d.specRed ? 1 : 0;
  return (d.specAnswers?.length ?? 0) + pending;
}

export const TAIL = 12_000;

export function tail(text: string, max = TAIL): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  return `…\n${cut.slice(cut.indexOf("\n") + 1)}`;
}

/** The intent of a mission (open or done). */
export async function intentOf(cx: Ctx, m: Mission): Promise<Intent> {
  // AUT-8, AUT-35: the level is read now, at each gate; a raise nobody confirmed does not count yet.
  return withFlag(cx.db, await cx.store.get(m.intent));
}

export function cloneOf(cx: Ctx, m: Mission): string {
  return clonePath(cx.repo(m), cx.home.root);
}

/** The repo files from the base branch of Towercab's clone (REPO-1). */
export async function repoFiles(cx: Ctx, m: Mission): Promise<RepoFiles> {
  try {
    const files = await loadRepoFiles(cx.tools, cloneOf(cx, m), cx.repo(m).base);
    // UI-257: the page shows a repo's cap beside the autonomy control.
    cx.db.setMeta(`a-cap:${m.repo}`, String(files.towercab.maxAutonomy));
    return files;
  } catch (e) {
    if (e instanceof RepoError && e.kind === "git") throw new EnvError("github", e.message);
    throw e;
  }
}

/** The outcome for repo files that don't load: a wait for the owner (REPO-5). */
export function repoFilesWait(e: unknown): Outcome | null {
  if (!(e instanceof RepoError)) return null;
  if (e.kind === "noVerifying") return wait("add CLAUDE.md verifying block");
  if (e.kind === "invalid") return wait("fix repo files", e.message);
  return null;
}

export function effectiveOf(_m: Mission, intent: Intent, files: RepoFiles): number {
  return effectiveA(intent.a, files.towercab.maxAutonomy, intent.source);
}

/** The worker's grants (AUT-14). */
export function grants(m: Mission, intent: Intent, files: RepoFiles, _cx?: Ctx) {
  const d = data(m);
  return grantsFor({
    a: effectiveOf(m, intent, files),
    source: intent.source,
    plan: d.granted ?? null,
    unlock: intent.unlock,
    network: intent.network,
    defaults: [...DEFAULT_NETWORK],
    unplanned: d.unplanned ?? null,
  });
}

export function nextN(m: Mission, kind: string): { n: number; data: Partial<PipeData> } {
  const counts = { ...(data(m).n ?? {}) };
  counts[kind] = (counts[kind] ?? 0) + 1;
  return { n: counts[kind]!, data: { n: counts } };
}

export function currentN(m: Mission, kind: string): number {
  return data(m).n?.[kind] ?? 1;
}

export interface RunPlan {
  kind: RunKind;
  /** Whose `agents/<agent>.md` configures it: model, session, limits, schema (PIP-72). */
  agent: AgentName;
  /** The recorded step name while this run is out. */
  step: string;
  prompt: string;
  files: RepoFiles;
  intent: Intent;
  guard?: ClaudeRun["guardRules"];
  /** The stage folder of its files when the kind runs in more than one stage (LOOP-39). */
  stage?: string;
}

const STRONGER: Record<string, string> = { haiku: "sonnet", sonnet: "opus", opus: "opus" };

/** The review model: the intent's, else `[agent].review_model`, else one step stronger than the worker. */
export function reviewModel(cx: Ctx, worker: string, intentReview: string | null): string {
  if (intentReview) return intentReview;
  if (cx.config.agent.reviewModel) return cx.config.agent.reviewModel;
  return STRONGER[worker] ?? worker;
}

/** The model the agent's file asks for (PIP-71 `model`). */
function modelOf(cx: Ctx, m: Mission, agent: Agent, intent: Intent): string {
  if (agent.model === "review") return reviewModel(cx, m.model, intent.review);
  if (agent.model === "agent") return cx.config.agent.model;
  return m.model;
}

/** The stage folder a Claude run's files go to (LOOP-39). */
const STAGE_OF_KIND: Record<RunKind, string> = {
  design: "design",
  plan: "plan",
  worker: "build",
  review: "review",
  // The risk agent runs at three gates; its handler names the stage folder (PIP-96).
  risk: "review",
  score: "design",
  features: "design",
  shadow: "design",
};

/** Record the step, then spawn a Claude run (LOOP-6, LOOP-7, PIP-13, PIP-24). */
export function spawnRun(cx: Ctx, m: Mission, p: RunPlan, resumePrompt?: string): Progress {
  // PIP-161, PIP-162: while the sandbox probe fails no Claude run starts: the owner gets the probe's error, or,
  // where user namespaces are restricted and the profile is missing, the one install command. A retry after the
  // fix carries on; a working sandbox never gets this.
  const probe = cx.sandbox?.();
  if (probe && !probe.ok) return { done: wait("fix sandbox", probe.why) };
  const repo = cx.repo(m);
  const runs = cx.runs(m);
  const cache = cx.home.cache(repo.name);
  const reentered = m.step === p.step;
  // Only a run that really started is resumed: one that waited for a slot never saw its prompt.
  const resumed = reentered && data(m).launched === p.step;
  const { n, data: nd } = reentered ? { n: currentN(m, p.kind), data: {} } : nextN(m, p.kind);
  const agent = loadAgent(p.agent);
  // `resume`: the mission's session, started by its first run; `new`: a session of its own per run.
  const onWorkerSession = agent.session === "resume";
  let session: ClaudeRun["session"];
  if (agent.session === "none") session = { mode: "none", id: "" };
  else if (!onWorkerSession) session = { mode: "new", id: crypto.randomUUID() };
  else session = { mode: m.session_used ? "resume" : "new", id: m.session };
  const fresh = cx.record(m, p.step, {}, nd);
  let prompt = resumed && resumePrompt ? resumePrompt : p.prompt;
  // A resumed step on a new worker session: the old one was gone (LOOP-7), so the new one is
  // told where the work is, then given the step's task.
  if (resumed && onWorkerSession && session.mode === "new") {
    const pr = currentPr(cx, m, repo);
    const plan = m.plan_pr && cx.store.github() ? prUrl(cx.store.github()!, m.plan_pr) : null;
    prompt = `${freshContext(
      m.branch,
      pr ? prUrl(pr.github, pr.n) : null,
      cx.store.url(p.intent) ?? `${p.intent.dir}/intent.md in the intents repo`,
      data(m).design?.specIds ?? [],
      plan,
    )}\n\n${p.prompt}`;
  }
  const run: ClaudeRun = {
    kind: p.kind,
    agent: p.agent,
    model: modelOf(cx, m, agent, p.intent),
    cwd: cx.checkout(fresh),
    runsDir: runs,
    stage: p.stage ?? STAGE_OF_KIND[p.kind],
    n,
    prompt,
    schema: agent.schema ? SCHEMAS[agent.schema] : null,
    session,
    budgetUsd: agentBudgetUsd(agent, cx.config),
    claudeMd: p.files.claudeMd,
    grants:
      p.kind === "worker"
        ? grants(fresh, p.intent, p.files, cx)
        : { domains: [...DEFAULT_NETWORK], paths: [] },
    guardRules: p.guard ?? null,
    cacheEnv: cacheEnv(cache, repo),
    cache,
    config: cx.config,
  };
  return {
    spawn: prepareRun(run, { towercabExe: join(checkoutRoot(), "bin", "towercab"), home: homedir() }),
    // The session exists once its first run starts, not when the run is asked for.
    launched: onWorkerSession ? { session_used: 1 } : {},
  };
}

export type Ended<T> =
  | { ok: true; value: T; costDelta: number; secs: number }
  | { ok: false; progress: Progress };

/**
 * A finished Claude run → its structured result, or the outcome for how it failed. Limits cool,
 * network failures back off, a gone session restarts fresh, a cut-off gets one continue (PIP-1).
 */
export function ended<T>(
  cx: Ctx,
  m: Mission,
  kind: RunKind,
  end: ChildEnd,
  parse: (v: unknown) => { ok: true; value: T } | { ok: false; why: string },
): Ended<T> {
  const out = readText(end.stdout);
  const err = readText(end.stderr);
  // The model that ran (the review's may differ from the mission's): a limit cools that one.
  const model = m.child_model ?? m.model;
  const e: RunEnd = parseRun(out, err, end.code, {
    model,
    now: new Date(cx.clock.now() * 1000),
    home: homedir(),
  });
  const d = data(m);
  const continued = d.continued ?? {};
  const once = (waiting: string, why: string): Ended<T> => {
    if (!continued[kind]) {
      return {
        ok: false,
        progress: {
          done: {
            event: end.timedOut ? "timeout" : "bad_result",
            why,
            // The one continue gets the step's whole budget again.
            set: { step_secs: 0 },
            data: { continued: { ...continued, [kind]: true } },
          },
        },
      };
    }
    return {
      ok: false,
      progress: { done: wait(waiting, why, { data: { continued: { ...continued, [kind]: false } } }) },
    };
  };
  if (end.timedOut) return once("worker timeout", "the run hit its time limit");
  switch (e.kind) {
    case "ok": {
      const env = classifyRun(e.result.result);
      const parsed = parse(e.result.structuredOutput);
      if (!parsed.ok) {
        if (env) throw new EnvError(env.kind, env.why);
        return once("no result", parsed.why);
      }
      // The first success on a model ends its cooldown and resets its backoff (LOOP-9).
      cx.db.delMeta(`cooldown:${model}`);
      // The review and the risk agent run in sessions of their own (PIP-4, PIP-96).
      const sessionKey = kind === "review" || kind === "risk" ? `${kind}:${e.result.sessionId}` : m.session;
      const before = d.sessionCost?.[sessionKey] ?? 0;
      const delta = Math.max(0, e.result.costUsd - before);
      const now = cx.clock.now();
      const runs = [...(d.runs ?? []), { at: now, cost: delta }].filter((r) => r.at > now - 62 * 86400);
      cx.db.run(
        "UPDATE missions SET cost_usd = cost_usd + ?, agent_secs = agent_secs + ?, data = json_set(data, '$.sessionCost', json(?), '$.continued', json(?), '$.runs', json(?)) WHERE id = ?",
        delta,
        e.result.durationMs / 1000,
        JSON.stringify({ ...(d.sessionCost ?? {}), [sessionKey]: e.result.costUsd }),
        JSON.stringify({ ...continued, [kind]: false }),
        JSON.stringify(runs),
        m.id,
      );
      return { ok: true, value: parsed.value, costDelta: delta, secs: e.result.durationMs / 1000 };
    }
    case "sessionGone":
      cx.db.run("UPDATE missions SET session = ?, session_used = 0 WHERE id = ?", crypto.randomUUID(), m.id);
      return {
        ok: false,
        progress: { done: { event: "bad_result", why: "the session was gone; starting a fresh one" } },
      };
    case "limit":
      return {
        ok: false,
        progress: {
          done: {
            event: "limit",
            limit: cooldown(e.limit, backoffsOf(cx, model), cx.clock.now()),
            why: e.limit.text,
          },
        },
      };
    case "env":
      throw new EnvError("claude", e.text);
    case "budget":
      return { ok: false, progress: { done: wait("worker budget", "the run used up its budget") } };
    case "denied":
      return {
        ok: false,
        progress: { done: wait("answer the question", `the worker tried something it may not: ${e.what}`) },
      };
    case "noResult":
    case "failed": {
      const env = classifyRun(`${err}\n${e.why}`);
      if (env) throw new EnvError(env.kind, env.why);
      return once("no result", e.why);
    }
  }
}

function backoffsOf(cx: Ctx, model: string): number {
  try {
    const raw = cx.db.meta(`cooldown:${model}`);
    return raw ? ((JSON.parse(raw) as { backoffs?: number }).backoffs ?? 0) : 0;
  } catch {
    return 0;
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** `git` in the mission checkout after a run was there (checks its config first). */
export async function coGit(cx: Ctx, m: Mission, args: string[]): Promise<string> {
  return gitSane(cx.tools, cx.checkout(m), args);
}

/** `-c user.name=… -c user.email=…` of the App's bot, for Towercab's commits. */
export async function botAuthor(cx: { github: Pick<GitHub, "bot"> }): Promise<string[]> {
  const bot = await cx.github.bot();
  return ["-c", `user.name=${bot.login}`, "-c", `user.email=${bot.email}`, "-c", "commit.gpgsign=false"];
}

/** GitHub refused a push because the branch has commits Towercab doesn't (PIP-85); never a crash. */
export class PushRefused extends Error {
  readonly branch: string;
  constructor(branch: string, message: string) {
    super(message);
    this.branch = branch;
  }
}

/** Pushes refused as non-fast-forward before the mission asks the owner. */
export const PUSH_TRIES = 3;

/** A refused push: try again next pass, and after `PUSH_TRIES` refusals ask the owner (PIP-85). */
export async function refusedPush(cx: Ctx, m: Mission, e: PushRefused): Promise<Progress> {
  const n = (data(m).pushRefusals ?? 0) + 1;
  if (n < PUSH_TRIES) {
    cx.record(m, m.step, {}, { pushRefusals: n });
    return { poll: 5 };
  }
  const o = await ask(cx, m, branchInTheWay(e.branch));
  return { done: { ...o, data: { ...o.data, pushRefusals: 0 } } };
}

/** The owner's question when `branch` holds commits Towercab can't build on (PIP-85, PIP-86). */
export function branchInTheWay(branch: string, pr?: { number: number; url: string }): Question {
  const where = pr ? ` Its open PR is ${pr.url}, which Towercab did not open.` : "";
  return {
    context: `Towercab can't push \`${branch}\`: GitHub already has commits on that branch that Towercab doesn't, and Towercab never overwrites commits.${where} To keep the old branch, use Start over in the card's menu (or \`/retry\` on the PR): the new attempt uses a new branch name.`,
    question: `What should happen to \`${branch}\` on GitHub?`,
    options: [
      {
        option: "Delete the branch on GitHub, then reply here",
        do: "continue",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "Towercab builds once more and pushes a fresh branch of that name. Anything on the old branch is lost.",
      },
    ],
    recommendation:
      "Start over if the commits might be someone's work; delete the branch if you know it is only an old attempt.",
  };
}

/** Push `branch` of the checkout to GitHub through Towercab's clone (LOOP-8). */
export async function pushBranch(
  cx: Ctx,
  m: Mission,
  localBranch: string,
  remoteBranch: string,
): Promise<string> {
  const repo = cx.repo(m);
  const clone = cloneOf(cx, m);
  const auth = await cx.github.gitAuth(repo.github);
  await git(cx.tools, clone, [
    "fetch",
    "--quiet",
    cx.checkout(m),
    `+refs/heads/${localBranch}:refs/heads/${remoteBranch}`,
  ]);
  try {
    await git(
      cx.tools,
      clone,
      // Never --force: someone else's commits on the branch are merged in first (takeRemote), so a push
      // that isn't a fast-forward means a race, and it fails instead of dropping their work.
      ["push", "--quiet", "origin", `refs/heads/${remoteBranch}:refs/heads/${remoteBranch}`],
      auth,
    );
  } catch (e) {
    const err = asEnv(e);
    if (!(err instanceof EnvError) && /non-fast-forward|fetch first/i.test(err.message)) {
      throw new PushRefused(remoteBranch, err.message);
    }
    throw err;
  }
  return (await git(cx.tools, clone, ["rev-parse", `refs/heads/${remoteBranch}`])).trim();
}

/** A failed git or gh call: network or auth failures become an `EnvError` (LOOP-10). */
export function asEnv(e: unknown): Error {
  const msg = (e as Error).message;
  return classifyFailure(msg) || /unable to access/i.test(msg) ? new EnvError("github", msg) : (e as Error);
}

/** A call to the forge: network and auth failures become an `EnvError` (LOOP-10). */
export async function viaForge<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    throw asEnv(e);
  }
}

/** The forge's answer to a change that must have worked: its failure is read as `viaForge` reads it. */
export function mustForge(o: Result, what: string): void {
  try {
    must(o, what);
  } catch (e) {
    throw asEnv(e);
  }
}

export function prUrl(github: string, n: number): string {
  return `https://github.com/${github}/pull/${n}`;
}

/** The intent's current PR (code > plan > spec), with its repo. */
export function currentPr(cx: Ctx, m: Mission, repo: RepoConfig): { github: string; n: number } | null {
  if (m.pr) return { github: repo.github, n: m.pr };
  const intents = cx.store.github();
  if (m.plan_pr && intents) return { github: intents, n: m.plan_pr };
  if (m.spec_pr) return { github: repo.github, n: m.spec_pr };
  return null;
}

/** PIP-114: what each kind of option does, in plain words. */
export const EFFECTS = {
  continue: "Carry on with the work",
  steps: "I'll do this myself: give me the steps",
  drop: "Drop the intent",
} as const;

/** PIP-182: who a stage comment of mission `m` is from: the agent of the step, and the intent. */
const byOf = (m: Mission, step: Step): By => ({ agent: agentOf(step, m.stage), intent: m.intent });

/**
 * A question in Markdown (PIP-41). With a brief it opens with the people part (PIP-220) and the
 * question's context is folded as agent context; without one (PIP-106) it reads as before.
 */
export function questionMd(q: Question, brief = ""): string {
  const opts = q.options
    .map((o) => `- **${o.option}**: ${o.then}${o.do ? ` _(${EFFECTS[o.do]})_` : ""}`)
    .join("\n");
  const ask = `**${q.question.trim()}**\n\n${opts}\n\n**Recommendation:** ${q.recommendation.trim()}\n\nReply to this comment to answer; Towercab continues with your reply.`;
  if (!brief.trim()) return `${q.context.trim()}\n\n${ask}`;
  return [plainMd(brief), ask, foldMd(q.context)].filter(Boolean).join("\n\n");
}

/**
 * Ask the owner: a Question comment on the current PR, or the intent's `## Towercab` (PIP-41). The
 * asker's plain brief, if any, is kept for the card (PIP-106); none clears an earlier one.
 */
export async function ask(
  cx: Ctx,
  m: Mission,
  q: Question,
  waiting = "answer the question",
  brief = "",
): Promise<Outcome> {
  const repo = cx.repo(m);
  const pr = currentPr(cx, m, repo);
  const body = questionMd(q, brief);
  if (pr)
    await upsertStageComment(
      cx.github,
      pr.github,
      pr.n,
      "Question",
      m.continued + 1,
      body,
      byOf(m, "Question"),
    );
  else await cx.store.update(m.intent, "question", (e) => e.setSection("Towercab", body));
  return wait(waiting, q.question, { data: { question: q, brief: brief.trim() || undefined } });
}

/** A stage comment on the current PR, never failing the step. */
export async function note(
  cx: Ctx,
  m: Mission,
  step: Step,
  round: number,
  body: string | TwoPart,
): Promise<void> {
  const pr = currentPr(cx, m, cx.repo(m));
  if (!pr) return;
  try {
    await upsertStageComment(cx.github, pr.github, pr.n, step, round, body, byOf(m, step));
  } catch (e) {
    // LOOP-113: held by the pause, not failed: the step is asked again after resume.
    if (e instanceof PausedHold) throw e;
    cx.log(`${m.intent}: couldn't post the ${step} comment: ${(e as Error).message}`);
  }
}

/**
 * PIP-140: tell the owner how their answer was read, where it came from: an "Answer" stage comment on
 * the current PR, or the top of the intent's `## Towercab` section, above `keep` (the question that
 * is still open, if any). Never fails the step.
 */
export async function tellOwner(cx: Ctx, m: Mission, body: string, keep = ""): Promise<void> {
  const pr = currentPr(cx, m, cx.repo(m));
  // PIP-185: an answer an agent gave for the owner says so.
  const agent = dataOf<{ answeredBy?: string | null }>(m).answeredBy;
  try {
    // PIP-220: the reply opens with its people part; the rest is folded. Inside the try: a shape
    // problem is logged, it never fails the step.
    const two = body.trim() ? twoPartMd(splitTwoPart(body)) : body;
    const said = agent ? `${answeredByLine(agent)}\n\n${two}` : two;
    if (pr) {
      await upsertStageComment(cx.github, pr.github, pr.n, "Answer", m.continued, said, byOf(m, "Answer"));
    } else {
      const text = keep ? `${said}\n\n${keep}` : said;
      await cx.store.update(m.intent, "answer", (e) => e.setSection("Towercab", text));
    }
  } catch (e) {
    if (e instanceof PausedHold) throw e;
    cx.log(`${m.intent}: couldn't say how the answer was read: ${(e as Error).message}`);
  }
}

/** The merged plan's ticked access, from `plan.md` on the intents repo's main. */
export async function grantedFromPlan(cx: Ctx, intent: Intent): Promise<Access> {
  const md = await cx.store.readFile(`${intent.dir}/plan.md`);
  return md ? parseAccess(md) : { domains: [], paths: [], tests: [] };
}

/**
 * SHIP-17, SHIP-22: the merged plan's steps and its "nothing to check live" claim, read from `plan.md`.
 * Ticks the database has and the file doesn't yet (`stepsDirty`) are kept, so a failed write is never lost.
 */
export async function stepsFromPlan(cx: Ctx, m: Mission): Promise<Partial<PipeData>> {
  const intent = await intentOf(cx, m);
  const md = await cx.store.readFile(`${intent.dir}/plan.md`);
  if (md === null) return {};
  const d = data(m);
  // PIP-113: a steps delivery has no merge, so every step is asked for after the plan.
  const file = parseSteps(md).map((s) => (d.delivery === "steps" ? { ...s, when: "after" as const } : s));
  const c = combine(file, d.steps, d.stepsDirty !== undefined);
  return { steps: c.steps, liveNoneWhy: parseNoneLive(md), stepsDirty: c.dirty ? d.stepsDirty : undefined };
}

/**
 * PIP-111: the change in a few words for PR titles and commits: the design's `subject`, cleaned to a
 * plain line; without one (a design from before subjects, or one that cleans to nothing), the intent's
 * title as before.
 */
export function subjectOf(m: Mission, intent: Intent): string {
  return lowerFirst(plainLine(data(m).design?.subject ?? "", SUBJECT_MAX) || intent.title);
}

/** The Conventional Commit line of the change (from the design; a plain `feat` without one). */
export function commitTitle(m: Mission, intent: Intent): string {
  const d = data(m).design;
  const type = d?.type || "feat";
  const scope = d?.scope ? `(${d.scope})` : "";
  return `${type}${scope}${d?.breaking ? "!" : ""}: ${subjectOf(m, intent)}`;
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * Commits someone else pushed to `remoteBranch` (the owner, GitHub's update-branch) come into the
 * checkout before Towercab builds or pushes on top: merged, never dropped. Marks `foreignHead`, so the
 * gate sends the PR to the owner at a4 and above.
 */
export async function takeRemote(
  cx: Ctx,
  m: Mission,
  remoteBranch: string,
): Promise<"none" | "merged" | "conflict"> {
  const repo = cx.repo(m);
  const clone = cloneOf(cx, m);
  await git(
    cx.tools,
    clone,
    ["fetch", "--quiet", "--prune", "origin"],
    await cx.github.gitAuth(repo.github),
  ).catch((e) => {
    throw asEnv(e);
  });
  const ref = `refs/remotes/origin/${remoteBranch}`;
  const remote = await git(cx.tools, clone, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  if (!remote.trim()) return "none";
  await coGit(cx, m, ["fetch", "--quiet", clone, `+${ref}:${ref}`]);
  const isAncestor = await coGit(cx, m, ["merge-base", "--is-ancestor", ref, "HEAD"])
    .then(() => true)
    .catch(() => false);
  if (isAncestor) return "none";
  const merged = await coGit(cx, m, [...(await botAuthor(cx)), "merge", "--no-edit", ref])
    .then(() => true)
    .catch(() => false);
  cx.record(m, m.step, {}, { foreignHead: true });
  return merged ? "merged" : "conflict";
}
