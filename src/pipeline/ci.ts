// CI (PIP-3, PIP-18): poll the PR's checks, bucket them in code, rerun a first red or cancelled
// Actions run once, send a red to the worker as a repair (2 at most), else wait for the owner.

import { git, refreshBase } from "../checkout.ts";
import { RetryRefused } from "../forge/gitlab-ci.ts";
import type { Check } from "../forge.ts";
import { conflictOutcome } from "../github/events.ts";
import type { Ctx, Handler, Progress } from "../handlers.ts";
import { ok, red, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { alertsBlock } from "./alerts.ts";
import { asEnv, ask, cloneOf, coGit, data, tail, viaForge } from "./common.ts";
import { cutLog, isSummary, jobId, LOG_TAIL } from "./job-log.ts";
import { classify, ignoreDetails, oldFindingQuestion, type Verdict } from "./old-finding.ts";

export type { Check };

export type Bucket =
  | { kind: "pending"; runs: number[]; manual?: string }
  | { kind: "green" }
  | { kind: "none" }
  | { kind: "red"; checks: Check[] }
  | { kind: "cancel"; checks: Check[] };

export const MAX_CI_REPAIRS = 2;

const passed = (c: Check) =>
  c.kind === "run"
    ? c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)
    : c.conclusion === "SUCCESS";
const failed = (c: Check) =>
  c.kind === "run"
    ? c.status === "COMPLETED" &&
      ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion)
    : ["FAILURE", "ERROR"].includes(c.conclusion);
const cancelled = (c: Check) => c.kind === "run" && c.status === "COMPLETED" && c.conclusion === "CANCELLED";

/**
 * The checks in code (PIP-3): `towercab/*` ignored; within `grace` s of the push, checks started
 * before it are ignored and none counted = pending (after it: none). A failed check → red, else a
 * cancelled one → cancel (each only once its Actions run finished), else pending until all passed.
 */
export function bucket(checks: Check[], pushedAt: number, now: number, grace: number): Bucket {
  const within = now - pushedAt < grace;
  const counted = checks
    .filter((c) => !c.name.startsWith("towercab/"))
    .filter((c) => !(within && c.startedAt !== null && c.startedAt < pushedAt));
  if (counted.length === 0) return within ? { kind: "pending", runs: [] } : { kind: "none" };
  // GL-11: a manual job waits for a person, so it neither makes its pipeline busy nor can be cancelled.
  const busy = new Set(
    counted
      .filter((c) => c.kind === "run" && c.status !== "COMPLETED" && c.run && !c.waitsFor)
      .map((c) => c.run),
  );
  const settled = (c: Check) => c.run === null || !busy.has(c.run);
  const r = counted.filter((c) => failed(c) && settled(c));
  if (r.length) return { kind: "red", checks: r };
  const x = counted.filter((c) => cancelled(c) && settled(c));
  if (x.length) return { kind: "cancel", checks: x };
  if (counted.every(passed)) return { kind: "green" };
  const manual = busy.size === 0 ? counted.find((c) => c.waitsFor)?.waitsFor : undefined;
  return { kind: "pending", runs: [...busy] as number[], ...(manual ? { manual } : {}) };
}

/**
 * PIP-171: a check pending past `ci_wait` whose Actions runs were not yet cancelled for this head nor
 * rerun for a red: `mark` records that first, then the runs are cancelled (the cancel branch reruns them).
 * Null when there is nothing to cancel; `error` when `gh` refuses.
 */
export async function cancelHung(
  cx: Ctx,
  github: string,
  runs: number[],
  mark: () => void,
): Promise<{ poll: number } | { error: string } | null> {
  if (runs.length === 0) return null;
  mark();
  try {
    for (const run of runs) await cx.github.cancelRun(github, run);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { poll: cx.config.agent.ciPoll };
}

/** PIP-171: why the owner is asked after a hang (twice, or a cancel `gh` refused). */
export function hungReason(cx: Ctx, again: boolean, error?: string): string {
  const min = Math.round(cx.config.agent.ciWait / 60);
  if (error) return `no result after ${min} min, and the run could not be cancelled: ${error}`;
  return again
    ? `the run hung twice: no result within ${min} min, and again after a rerun`
    : `no result after ${min} min`;
}

export type CiState = Bucket | { kind: "moved"; head: string } | { kind: "conflict" };

/** Read a PR's checks for `head` (PIP-18: only checks on that head count). */
export async function ciState(
  cx: Ctx,
  github: string,
  pr: number,
  head: string | null,
  pushedAt: number,
): Promise<CiState> {
  const v = await viaForge(cx.github.readChecks(github, pr));
  if (head && v.head !== head) return { kind: "moved", head: v.head };
  if (v.mergeable === "CONFLICTING") return { kind: "conflict" };
  return bucket(v.checks, pushedAt, cx.clock.now(), cx.config.agent.ciGrace);
}

/**
 * PIP-83: the failing jobs' log tails when the PR's checks on its current head are red, else null.
 * Unlike `ciState` a conflict or a moved head hides nothing: the checks are read as they stand.
 */
export async function redLog(cx: Ctx, github: string, pr: number, pushedAt: number): Promise<string | null> {
  const v = await viaForge(cx.github.readChecks(github, pr));
  const b = bucket(v.checks, pushedAt, cx.clock.now(), cx.config.agent.ciGrace);
  return b.kind === "red" ? (await failedLog(cx, github, pr, b.checks)).text : null;
}

/**
 * The failed jobs' log, cut to what matters (PIP-154): each real failed job's own log, else the run's
 * `gh run view --log-failed` (summary jobs only, no job id, or an unreadable job). Then the open code
 * scanning alerts for a failed check that has no run (PIP-148). `jobs` are the cut logs of the failed
 * jobs' own logs, empty unless every failed check was read that way and nothing else failed (PIP-193).
 */
async function failedLog(
  cx: Ctx,
  github: string,
  pr: number,
  checks: Check[],
): Promise<{ text: string; jobs: string[] }> {
  const withRun = checks.filter((c) => c.run !== null);
  const real = withRun.filter((c) => !isSummary(c.name));
  const parts: string[] = [];
  const jobs: string[] = [];
  const seen = new Set<number>();
  const runLog = async (run: number) => {
    if (seen.has(run)) return;
    seen.add(run);
    try {
      parts.push(tail(await viaForge(cx.github.failedLog(github, run)), LOG_TAIL));
    } catch (e) {
      parts.push(`(the log of run ${run} couldn't be read: ${(e as Error).message})`);
    }
  };
  if (real.length === 0) {
    const runs = [...new Set(withRun.map((c) => c.run as number))];
    for (const run of runs.slice(0, 3)) await runLog(run);
  }
  for (const c of real.slice(0, 3)) {
    const job = jobId(c.url);
    if (job !== null) {
      try {
        const text = tail(cutLog(await viaForge(cx.github.jobLog(github, job))), LOG_TAIL).trim();
        if (text) {
          parts.push(`Job ${c.name}:\n${text}`);
          jobs.push(text);
          continue;
        }
      } catch (e) {
        parts.push(`(the log of job ${c.name} couldn't be read: ${(e as Error).message})`);
      }
    }
    await runLog(c.run as number);
  }
  const named = checks.map((c) => `- ${c.name}: ${c.conclusion.toLowerCase()} ${c.url}`).join("\n");
  const alerts = await alertsBlock(cx, github, pr, checks);
  if (alerts) parts.push(alerts);
  // Every failed check must be a job read on its own: a summary-only or run-level log proves nothing.
  const whole =
    !alerts &&
    real.length > 0 &&
    jobs.length === real.length &&
    checks.every((c) => isSummary(c.name) || c.run !== null);
  return { text: `${named}\n\n${parts.join("\n\n")}`.trim(), jobs: whole ? jobs : [] };
}

/** Move the mission's checkout to the PR's `head` (fetched through Towercab's clone). */
async function adoptHead(cx: Ctx, m: Mission, head: string): Promise<void> {
  const repo = cx.repo(m);
  const clone = cloneOf(cx, m);
  await git(cx.tools, clone, ["fetch", "--quiet", "origin"], await cx.github.gitAuth(repo.github)).catch(
    (e) => {
      throw asEnv(e);
    },
  );
  await refreshBase(cx.tools, clone, cx.checkout(m), repo.base);
  await coGit(cx, m, [
    "fetch",
    "--quiet",
    clone,
    `+refs/remotes/origin/${m.branch}:refs/remotes/origin/${m.branch}`,
  ]);
  await coGit(cx, m, ["reset", "--hard", "--quiet", head]);
}

export const ciHandler: Handler = {
  async step(cx: Ctx, m: Mission): Promise<Progress> {
    const repo = cx.repo(m);
    const d = data(m);
    const pushedAt = m.pushed_at ?? cx.clock.now();
    const s = await ciState(cx, repo.github, m.pr!, m.head, pushedAt);
    switch (s.kind) {
      case "moved":
        // Someone else pushed (the owner, GitHub's update branch): the checkout takes their head, so
        // the review reads it and a later round builds on it instead of pushing over it.
        await adoptHead(cx, m, s.head);
        // GitHub's update-branch (asked for by merge) isn't someone else's work.
        cx.record(
          m,
          m.step,
          { head: s.head, pushed_at: cx.clock.now() },
          d.updatedBranch ? { updatedBranch: undefined } : { foreignHead: true },
        );
        return { poll: cx.config.agent.ciPoll };
      case "conflict":
        return { done: conflictOutcome(m) };
      case "pending": {
        if (cx.timeouts && cx.clock.now() - pushedAt > cx.config.agent.ciWait) {
          if (s.manual) return { done: wait("CI stuck", `job ${s.manual} is waiting for a manual start`) };
          const head = m.head ?? "";
          const hung = d.ci?.hung ?? {};
          const again = hung[head] === true;
          if (!again && !d.ci?.reruns?.[head]) {
            const c = await cancelHung(cx, repo.github, s.runs, () =>
              cx.record(
                m,
                m.step,
                { pushed_at: cx.clock.now() },
                { ci: { ...d.ci, result: "pending", hung: { ...hung, [head]: true } } },
              ),
            );
            if (c && "poll" in c) return c;
            if (c) return { done: wait("CI stuck", hungReason(cx, false, c.error)) };
          }
          return { done: wait("CI stuck", hungReason(cx, again)) };
        }
        return { poll: cx.config.agent.ciPoll };
      }
      case "none":
        return { done: ok({ why: "no CI on this repo", data: { ci: { result: "none" } } }) };
      case "green":
        return { done: ok({ data: { ci: { result: "green" } } }) };
      case "red":
      case "cancel": {
        const reruns = { ...(d.ci?.reruns ?? {}) };
        const runs = [...new Set(s.checks.map((c) => c.run).filter((r): r is number => r !== null))];
        if (!reruns[m.head ?? ""] && runs.length) {
          for (const run of runs) {
            try {
              await cx.github.rerunFailed(repo.github, run);
            } catch (e) {
              // GL-12: GitLab refused the retry; its reason is the owner's to read.
              if (e instanceof RetryRefused) return { done: wait("CI red", e.message) };
              throw asEnv(e);
            }
          }
          cx.record(
            m,
            m.step,
            { pushed_at: cx.clock.now() },
            { ci: { ...d.ci, result: "pending", reruns: { ...reruns, [m.head ?? ""]: true } } },
          );
          return { poll: cx.config.agent.ciPoll };
        }
        // A rerun of a run Towercab cancelled for hanging, cancelled again: nothing failed in a log.
        if (s.kind === "cancel" && d.ci?.hung?.[m.head ?? ""])
          return { done: wait("CI stuck", hungReason(cx, true)) };
        if (s.kind === "cancel" && !reruns[`${m.head}:cancel`]) {
          cx.record(
            m,
            m.step,
            {},
            { ci: { ...d.ci, result: "pending", reruns: { ...reruns, [`${m.head}:cancel`]: true } } },
          );
          return { poll: cx.config.agent.ciPoll };
        }
        const { text: log, jobs } = await failedLog(cx, repo.github, m.pr!, s.checks);
        // PIP-192, PIP-193, PIP-196: a finding only in older commits, gone at the head, is ignored by
        // fingerprint or asked about; once per head, and anything unclear is a normal repair.
        const head = m.head ?? "";
        const verdict: Verdict =
          head && m.ci_repairs < MAX_CI_REPAIRS
            ? await classify((args) => coGit(cx, m, args), head, jobs, d.ci?.ignored)
            : { kind: "normal" };
        const handled = { ci: { ...d.ci, ignored: { ...d.ci?.ignored, [head]: true } } };
        if (verdict.kind === "ask") {
          const o = await ask(cx, m, oldFindingQuestion(verdict.findings));
          return { done: { ...o, data: { ...o.data, ...handled } } };
        }
        if (m.ci_repairs >= MAX_CI_REPAIRS)
          return { done: wait("CI red", s.checks.map((c) => c.name).join(", ")) };
        const what = "CI failed on the PR.";
        return {
          done: red(`CI failed: ${s.checks.map((c) => c.name).join(", ")}`, {
            set: { ci_repairs: m.ci_repairs + 1 },
            data:
              verdict.kind === "ignore"
                ? {
                    ...handled,
                    repair: {
                      what,
                      details: ignoreDetails(verdict.findings),
                      kind: "ci",
                      ignore: { fingerprints: verdict.findings.map((f) => f.fingerprint), fallback: log },
                    },
                  }
                : { repair: { what, details: log, kind: "ci" } },
          }),
        };
      }
    }
  },
  async finish() {
    return { poll: 0 };
  },
};
