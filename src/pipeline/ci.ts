// CI (PIP-3, PIP-18): poll the PR's checks, bucket them in code, rerun a first red or cancelled
// Actions run once, send a red to the worker as a repair (2 at most), else wait for the owner.

import { git, refreshBase } from "../checkout.ts";
import { conflictOutcome } from "../github/events.ts";
import type { Ctx, Handler, Progress } from "../handlers.ts";
import { ok, red, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { asEnv, cloneOf, coGit, data, gh, tail } from "./common.ts";

export interface Check {
  name: string;
  kind: "run" | "status";
  status: string;
  conclusion: string;
  startedAt: number | null;
  run: number | null;
  url: string;
}

export type Bucket =
  | { kind: "pending" }
  | { kind: "green" }
  | { kind: "none" }
  | { kind: "red"; checks: Check[] }
  | { kind: "cancel"; checks: Check[] };

export const MAX_CI_REPAIRS = 2;

const unix = (s: unknown) => {
  const t = typeof s === "string" ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) ? null : t / 1000;
};
const str = (v: Record<string, unknown>, k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");

/** The Actions run of a check's `detailsUrl`. */
export function runId(url: string): number | null {
  const m = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** `statusCheckRollup` → checks. */
export function checksOf(rollup: unknown): Check[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.map((raw) => {
    const c = raw as Record<string, unknown>;
    const startedAt = unix(c.startedAt) ?? unix(c.createdAt);
    if (c.__typename === "StatusContext" || (c.context !== undefined && c.name === undefined)) {
      const state = str(c, "state");
      return {
        name: str(c, "context"),
        kind: "status" as const,
        status: ["PENDING", "EXPECTED", ""].includes(state) ? "PENDING" : "COMPLETED",
        conclusion: state,
        startedAt,
        run: null,
        url: str(c, "targetUrl"),
      };
    }
    const url = str(c, "detailsUrl");
    return {
      name: str(c, "name"),
      kind: "run" as const,
      status: str(c, "status"),
      conclusion: str(c, "conclusion"),
      startedAt,
      run: runId(url),
      url,
    };
  });
}

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
  if (counted.length === 0) return within ? { kind: "pending" } : { kind: "none" };
  const busy = new Set(
    counted.filter((c) => c.kind === "run" && c.status !== "COMPLETED" && c.run).map((c) => c.run),
  );
  const settled = (c: Check) => c.run === null || !busy.has(c.run);
  const r = counted.filter((c) => failed(c) && settled(c));
  if (r.length) return { kind: "red", checks: r };
  const x = counted.filter((c) => cancelled(c) && settled(c));
  if (x.length) return { kind: "cancel", checks: x };
  return counted.every(passed) ? { kind: "green" } : { kind: "pending" };
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
  const v = JSON.parse(
    await gh(cx, github, [
      "pr",
      "view",
      String(pr),
      "-R",
      github,
      "--json",
      "headRefOid,mergeable,statusCheckRollup",
    ]),
  ) as { headRefOid: string; mergeable: string; statusCheckRollup: unknown };
  if (head && v.headRefOid !== head) return { kind: "moved", head: v.headRefOid };
  if (v.mergeable === "CONFLICTING") return { kind: "conflict" };
  return bucket(checksOf(v.statusCheckRollup), pushedAt, cx.clock.now(), cx.config.agent.ciGrace);
}

/**
 * PIP-83: the failing jobs' log tails when the PR's checks on its current head are red, else null.
 * Unlike `ciState` a conflict or a moved head hides nothing: the checks are read as they stand.
 */
export async function redLog(cx: Ctx, github: string, pr: number, pushedAt: number): Promise<string | null> {
  const v = JSON.parse(
    await gh(cx, github, ["pr", "view", String(pr), "-R", github, "--json", "statusCheckRollup"]),
  ) as { statusCheckRollup: unknown };
  const b = bucket(checksOf(v.statusCheckRollup), pushedAt, cx.clock.now(), cx.config.agent.ciGrace);
  return b.kind === "red" ? failedLog(cx, github, b.checks) : null;
}

/** The failed jobs' log, cut to what matters (`gh run view --log-failed`). */
async function failedLog(cx: Ctx, github: string, checks: Check[]): Promise<string> {
  const runs = [...new Set(checks.map((c) => c.run).filter((r): r is number => r !== null))];
  const parts: string[] = [];
  for (const run of runs.slice(0, 3)) {
    try {
      parts.push(
        tail(await gh(cx, github, ["run", "view", String(run), "-R", github, "--log-failed"]), 6000),
      );
    } catch (e) {
      parts.push(`(the log of run ${run} couldn't be read: ${(e as Error).message})`);
    }
  }
  const named = checks.map((c) => `- ${c.name}: ${c.conclusion.toLowerCase()} ${c.url}`).join("\n");
  return `${named}\n\n${parts.join("\n\n")}`.trim();
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
          return { done: wait("CI stuck", `no result after ${Math.round(cx.config.agent.ciWait / 60)} min`) };
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
          for (const run of runs)
            await gh(cx, repo.github, ["run", "rerun", String(run), "-R", repo.github, "--failed"]);
          cx.record(
            m,
            m.step,
            { pushed_at: cx.clock.now() },
            { ci: { result: "pending", reruns: { ...reruns, [m.head ?? ""]: true } } },
          );
          return { poll: cx.config.agent.ciPoll };
        }
        if (s.kind === "cancel" && !reruns[`${m.head}:cancel`]) {
          cx.record(
            m,
            m.step,
            {},
            { ci: { result: "pending", reruns: { ...reruns, [`${m.head}:cancel`]: true } } },
          );
          return { poll: cx.config.agent.ciPoll };
        }
        const log = await failedLog(cx, repo.github, s.checks);
        if (m.ci_repairs >= MAX_CI_REPAIRS)
          return { done: wait("CI red", s.checks.map((c) => c.name).join(", ")) };
        return {
          done: red(`CI failed: ${s.checks.map((c) => c.name).join(", ")}`, {
            set: { ci_repairs: m.ci_repairs + 1 },
            data: { repair: { what: "CI failed on the PR.", details: log, kind: "ci" } },
          }),
        };
      }
    }
  },
  async finish() {
    return { poll: 0 };
  },
};
