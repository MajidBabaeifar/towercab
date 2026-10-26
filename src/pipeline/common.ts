// What every stage handler shares: the mission's intent, repo, files and checkout; Claude runs and
// how their ends become outcomes; git as the bot; questions; the intent's PRs.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { effectiveA } from "../autonomy.ts";
import { git, gitSane } from "../checkout.ts";
import { type ClaudeRun, parseRun, prepareRun, type RunEnd, type RunKind } from "../claude.ts";
import { clonePath, type RepoConfig } from "../config.ts";
import { classifyRun } from "../faults.ts";
import { type Step, upsertStageComment } from "../github/comments.ts";
import { type ChildEnd, type Ctx, EnvError, type Progress } from "../handlers.ts";
import type { Intent } from "../intents/types.ts";
import { cooldown } from "../limits.ts";
import { type Outcome, wait } from "../machine.ts";
import { dataOf, type Mission } from "../mission.ts";
import { loadRepoFiles, RepoError, type RepoFiles } from "../repo/files.ts";
import { checkoutRoot } from "../service.ts";
import { check } from "../tools.ts";
import { grantsFor, parseAccess } from "./access.ts";
import { cacheEnv } from "./sandbox.ts";
import type { Access, JsonSchema, Question } from "./schemas.ts";

/** `missions.data`, as the pipeline uses it. */
export interface PipeData {
  design?: {
    type: string;
    scope: string;
    breaking: boolean;
    specIds: string[];
    concerns: { what: string; why: string }[];
    pr: string;
  };
  specBranch?: string;
  plan?: { md: string; access: Access };
  /** The merged plan's ticked access. */
  granted?: Access;
  unplanned?: Access;
  /** The owner's last words for the worker (an answer, feedback). */
  answer?: string;
  /** Why the next build round runs: a repair's what and details. */
  repair?: { what: string; details: string; kind: "verify" | "proof" | "ci" | "conflict" };
  /** Head at the end of the last non-repair round (PIP-31). */
  lockHead?: string;
  build?: { pr: string | null; notes: string; planChanged: string | null };
  /** Runs per kind, for file names. */
  n?: Record<string, number>;
  /** `<kind>`: a cut-off run gets one continue (PIP-1). */
  continued?: Record<string, boolean>;
  setup?: string;
  verify?: { log: string; result: "green" | "red" };
  shots?: string[];
  proof?: "proven" | "none needed" | "not proven";
  proofWaited?: boolean;
  unproven?: boolean;
  ci?: { result: "green" | "none" | "pending"; reruns?: Record<string, boolean>; since?: number };
  review?: {
    approved: boolean;
    door: "one-way" | "two-way";
    redLines: boolean;
    summary: string;
    details: string;
    patchId: string;
  } | null;
  /** Session cost already counted (MET-28). */
  sessionCost?: Record<string, number>;
  mergeTries?: number;
  dropped?: boolean;
}

export const data = (m: Mission): PipeData => dataOf(m) as PipeData;

export const TAIL = 12_000;

export function tail(text: string, max = TAIL): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  return `…\n${cut.slice(cut.indexOf("\n") + 1)}`;
}

/** The intent of a mission (open or done). */
export async function intentOf(cx: Ctx, m: Mission): Promise<Intent> {
  return cx.store.get(m.intent);
}

export function cloneOf(cx: Ctx, m: Mission): string {
  return clonePath(cx.repo(m), cx.home.root);
}

/** The repo files from the base branch of Towercab's clone (REPO-1). */
export async function repoFiles(cx: Ctx, m: Mission): Promise<RepoFiles> {
  try {
    return await loadRepoFiles(cx.tools, cloneOf(cx, m), cx.repo(m).base);
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

export function effectiveOf(m: Mission, intent: Intent, files: RepoFiles): number | null {
  return effectiveA(m.a_at_pick, intent.a, files.towercab.maxAutonomy, intent.source);
}

/** The worker's grants (AUT-14). */
export function grants(m: Mission, intent: Intent, files: RepoFiles, cx: Ctx) {
  const d = data(m);
  return grantsFor({
    a: effectiveOf(m, intent, files),
    source: intent.source,
    plan: d.granted ?? null,
    unlock: intent.unlock,
    network: intent.network,
    defaults: cx.config.agent.network,
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
  /** The recorded step name while this run is out. */
  step: string;
  prompt: string;
  schema: JsonSchema | null;
  /** The worker session (`m.session`), or a fresh one per run (review). */
  session: "worker" | "fresh";
  model: string;
  files: RepoFiles;
  intent: Intent;
  guard?: ClaudeRun["guardRules"];
}

/** Record the step, then spawn a Claude run (LOOP-6, LOOP-7, PIP-13, PIP-24). */
export function spawnRun(cx: Ctx, m: Mission, p: RunPlan, resumePrompt?: string): Progress {
  const repo = cx.repo(m);
  const runs = cx.runs(m);
  const cache = cx.home.cache(repo.name);
  const reentered = m.step === p.step;
  const { n, data: nd } = reentered ? { n: currentN(m, p.kind), data: {} } : nextN(m, p.kind);
  let session: ClaudeRun["session"];
  if (p.session === "fresh") session = { mode: "new", id: crypto.randomUUID() };
  else session = { mode: m.session_used ? "resume" : "new", id: m.session };
  const fresh = cx.record(m, p.step, p.session === "worker" ? { session_used: 1 } : {}, nd);
  const run: ClaudeRun = {
    kind: p.kind,
    model: p.model,
    cwd: cx.checkout(fresh),
    runsDir: runs,
    n,
    prompt: reentered && resumePrompt ? resumePrompt : p.prompt,
    schema: p.schema,
    session,
    budgetUsd: p.kind === "review" ? null : cx.config.agent.maxBudgetUsd,
    claudeMd: p.files.claudeMd,
    grants:
      p.kind === "worker"
        ? grants(fresh, p.intent, p.files, cx)
        : { domains: cx.config.agent.network, paths: [], open: false },
    guardRules: p.guard ?? null,
    cacheEnv: cacheEnv(cache, cx.config, repo),
    cache,
    config: cx.config,
  };
  return {
    spawn: prepareRun(run, { towercabExe: join(checkoutRoot(), "bin", "towercab"), home: homedir() }),
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
  const e: RunEnd = parseRun(out, err, end.code, {
    model: m.model,
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
      const sessionKey = kind === "review" ? `review:${e.result.sessionId}` : m.session;
      const before = d.sessionCost?.[sessionKey] ?? 0;
      const delta = Math.max(0, e.result.costUsd - before);
      cx.db.run(
        "UPDATE missions SET cost_usd = cost_usd + ?, agent_secs = agent_secs + ?, data = json_set(data, '$.sessionCost', json(?), '$.continued', json(?)) WHERE id = ?",
        delta,
        e.result.durationMs / 1000,
        JSON.stringify({ ...(d.sessionCost ?? {}), [sessionKey]: e.result.costUsd }),
        JSON.stringify({ ...continued, [kind]: false }),
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
            limit: cooldown(e.limit, backoffsOf(cx, m.model), cx.clock.now()),
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
export async function botAuthor(cx: Ctx): Promise<string[]> {
  const bot = await cx.github.bot();
  return ["-c", `user.name=${bot.login}`, "-c", `user.email=${bot.email}`, "-c", "commit.gpgsign=false"];
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
      ["push", "--quiet", "--force", "origin", `refs/heads/${remoteBranch}:refs/heads/${remoteBranch}`],
      auth,
    );
  } catch (e) {
    throw asEnv(e);
  }
  return (await git(cx.tools, clone, ["rev-parse", `refs/heads/${remoteBranch}`])).trim();
}

/** A failed git or gh call: network or auth failures become an `EnvError` (LOOP-10). */
export function asEnv(e: unknown): Error {
  const msg = (e as Error).message;
  return /could not resolve|connection|timed out|unable to access|HTTP 5\d\d|Bad credentials|401/i.test(msg)
    ? new EnvError("github", msg)
    : (e as Error);
}

/** `gh` as the App for the mission's repo, checked. */
export async function gh(cx: Ctx, github: string, args: string[], input?: string): Promise<string> {
  const r = await cx.github.gh(github, args, input === undefined ? {} : { input });
  try {
    return check(r, `gh ${args.slice(0, 2).join(" ")}`);
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

/** A question in Markdown (PIP-41). */
export function questionMd(q: Question): string {
  const opts = q.options.map((o) => `- **${o.option}**: ${o.then}`).join("\n");
  return `${q.context.trim()}\n\n**${q.question.trim()}**\n\n${opts}\n\n**Recommendation:** ${q.recommendation.trim()}\n\nReply to this comment to answer; Towercab continues with your reply.`;
}

/** Ask the owner: a Question comment on the current PR, or the intent's `## Towercab` (PIP-41). */
export async function ask(cx: Ctx, m: Mission, q: Question): Promise<Outcome> {
  const repo = cx.repo(m);
  const pr = currentPr(cx, m, repo);
  const body = questionMd(q);
  if (pr) await upsertStageComment(cx.github, pr.github, pr.n, "Question", m.continued + 1, body);
  else await cx.store.update(m.intent, "question", (e) => e.setSection("Towercab", body));
  return wait("answer the question", q.question);
}

/** A stage comment on the current PR, never failing the step. */
export async function note(cx: Ctx, m: Mission, step: Step, round: number, body: string): Promise<void> {
  const pr = currentPr(cx, m, cx.repo(m));
  if (!pr) return;
  try {
    await upsertStageComment(cx.github, pr.github, pr.n, step, round, body);
  } catch (e) {
    cx.log(`${m.intent}: couldn't post the ${step} comment: ${(e as Error).message}`);
  }
}

/** The merged plan's ticked access, from `plan.md` on the intents repo's main. */
export async function grantedFromPlan(cx: Ctx, intent: Intent): Promise<Access> {
  const md = await cx.store.readFile(`${intent.dir}/plan.md`);
  return md ? parseAccess(md) : { domains: [], paths: [] };
}

/** The Conventional Commit line of the change (from the design; a plain `feat` without one). */
export function commitTitle(m: Mission, intent: Intent): string {
  const d = data(m).design;
  const type = d?.type || "feat";
  const scope = d?.scope ? `(${d.scope})` : "";
  return `${type}${scope}${d?.breaking ? "!" : ""}: ${lowerFirst(intent.title)}`;
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}
