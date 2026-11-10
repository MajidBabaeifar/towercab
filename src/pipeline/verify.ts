// The `verify` stage (PIP-23, PIP-49): the repo's setup (with network) and run set (without), in the
// sandbox; a red goes back to the worker (2 repairs with proof), then waits. Green → screenshots.
// Checks that fail only because they couldn't write to the repo cache ask the owner (PIP-95).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyRun } from "../faults.ts";
import { type ChildEnd, type Ctx, EnvError, type Handler, type Progress } from "../handlers.ts";
import { ok, red, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { glob } from "../repo/protected.ts";
import { hasCi, runSet } from "../repo/runset.ts";
import { withoutE2e } from "../ship/live.ts";
import {
  allowsCacheWrite,
  cacheWriteQuestion,
  checksMayWrite,
  checksWriteKey,
  logPath,
  readOnlyCachePath,
  sandboxSpec,
} from "./checks.ts";
import {
  ask,
  cloneOf,
  coGit,
  data,
  ended,
  intentOf,
  nextN,
  note,
  repoFiles,
  spawnRun,
  tail,
} from "./common.ts";
import { intentData, render } from "./prompts.ts";
import { parseResult } from "./schemas.ts";

export const MAX_REPAIRS = 2;
export const MAX_SHOTS = 20;
export const MAX_SHOT_BYTES = 5 * 1024 * 1024;

/** Test files the PR changed against base (PIP-30's globs), sorted. */
export async function changedTests(cx: Ctx, m: Mission, tests: string[]): Promise<string[]> {
  const repo = cx.repo(m);
  const out = await coGit(cx, m, [
    "diff",
    "--name-only",
    "--diff-filter=AMR",
    `refs/remotes/origin/${repo.base}...HEAD`,
  ]);
  const ms = tests.map((g) => glob(g));
  return out
    .split("\n")
    .filter((p) => p && ms.some((match) => match(p)))
    .sort();
}

export async function runLines(cx: Ctx, m: Mission): Promise<string[]> {
  const files = await repoFiles(cx, m);
  const ci = await hasCi(cx.tools, cloneOf(cx, m), cx.repo(m).base);
  return runSet(
    files.verifying,
    ci,
    withoutE2e(await changedTests(cx, m, files.towercab.tests), files.towercab.live),
  );
}

function read(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export const verifyHandler: Handler = {
  async step(cx, m) {
    const files = await repoFiles(cx, m);
    // PIP-95: the owner answered whether the checks may write to the repo cache.
    if (data(m).cacheAsk) {
      const repo = cx.repo(m).name;
      const allowed = allowsCacheWrite(data(m).answer);
      m = cx.record(m, m.step, {}, { cacheAsk: undefined, answer: undefined });
      if (!allowed) {
        return {
          done: wait(
            "checks red",
            `You didn't allow the checks of ${repo} to write to its build cache, so they can't run. Make them write inside the checkout (for example through the repo's env in Towercab's config), then reply.`,
          ),
        };
      }
      cx.db.setMeta(checksWriteKey(repo), "1");
      cx.log(`${m.intent}: the checks of ${repo} may now write to its build cache`);
    }
    const { n, data: nd } = nextN(m, "verify");
    if (m.step === "" || m.step === "setup") {
      const fresh = cx.record(m, "setup", {}, nd);
      if (files.verifying.setup.length === 0) return checks(cx, cx.record(fresh, "checks"));
      return {
        spawn: sandboxSpec(cx, fresh, {
          kind: "setup",
          lines: files.verifying.setup,
          dir: cx.checkout(fresh),
          cacheWritable: true,
          log: logPath(cx, fresh, "verify", `verify-${n}-setup.log`),
          timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
        }),
      };
    }
    if (m.step === "checks") return checks(cx, m);
    if (m.step === "shots") return shots(cx, m);
    if (m.step === "merge-review") return mergeReview(cx, m);
    return { done: { event: "bad_result", why: `unknown verify step ${m.step}` } };
  },

  async finish(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
    if (m.step === "merge-review") return mergeReviewEnd(cx, m, end);
    const log = `${read(end.stdout)}${read(end.stderr)}`;
    if (m.step === "setup") {
      if (end.code !== 0) {
        const env = classifyRun(log);
        if (env) throw new EnvError(env.kind, env.why);
        return failed(cx, m, "The repo's setup failed.", log);
      }
      return checks(cx, cx.record(m, "checks"));
    }
    if (m.step === "checks") {
      if (end.timedOut) return failed(cx, m, "The checks timed out.", log);
      if (end.code !== 0) {
        const cache = cx.home.cache(cx.repo(m).name);
        const ro = checksMayWrite(cx, m) ? null : readOnlyCachePath(log, cache);
        if (ro) {
          // PIP-95: not the code's fault, so no repair round; the owner decides.
          const o = await ask(cx, m, cacheWriteQuestion(cx.repo(m).name, cache, ro), "allow check writes");
          return { done: { ...o, data: { ...o.data, cacheAsk: true, answer: undefined } } };
        }
        const env = classifyRun(log);
        if (env) throw new EnvError(env.kind, env.why);
        return failed(cx, m, "The checks failed.", log);
      }
      const files = await repoFiles(cx, m);
      // PIP-169: a merge made by code is read on its own diff before it goes on; no screenshots for it.
      if (data(m).mech)
        return mergeReview(
          cx,
          cx.record(m, "merge-review", {}, { verify: { log: tail(log, 2000), result: "green" } }),
        );
      if (files.verifying.screenshots)
        return shots(cx, cx.record(m, "shots", {}, { verify: { log: tail(log, 2000), result: "green" } }));
      return { done: ok({ data: { verify: { log: tail(log, 2000), result: "green" } } }) };
    }
    if (m.step === "shots") {
      const dir = join(cx.checkout(m), ".towercab-shots");
      const n = data(m).n?.verify ?? 1;
      const keep = join(cx.runs(m, "verify"), `shots-${n}`);
      const kept: string[] = [];
      if (existsSync(dir)) {
        mkdirSync(keep, { recursive: true });
        for (const f of readdirSync(dir)
          .filter((x) => x.endsWith(".png"))
          .sort()
          .slice(0, MAX_SHOTS)) {
          if (statSync(join(dir, f)).size > MAX_SHOT_BYTES) continue;
          cpSync(join(dir, f), join(keep, f));
          kept.push(join(keep, f));
        }
        rmSync(dir, { recursive: true, force: true });
      }
      if (end.code !== 0)
        cx.log(`${m.intent}: the screenshots command failed; the review goes on without them`);
      return { done: ok({ data: { shots: kept } }) };
    }
    return { done: { event: "bad_result", why: `unknown verify step ${m.step}` } };
  },
};

async function checks(cx: Ctx, m: Mission): Promise<Progress> {
  // PIP-167: a merge made by code runs the repo's full checks, not the fast subset.
  const lines = data(m).mech ? (await repoFiles(cx, m)).verifying.checks : await runLines(cx, m);
  const n = data(m).n?.verify ?? 1;
  if (lines.length === 0) return { done: ok({ why: "no local checks: CI runs the suite" }) };
  return {
    spawn: sandboxSpec(cx, m, {
      kind: "checks",
      lines,
      dir: cx.checkout(m),
      cacheWritable: checksMayWrite(cx, m),
      log: logPath(cx, m, "verify", `verify-${n}.log`),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000 * Math.max(1, lines.length),
    }),
  };
}

async function shots(cx: Ctx, m: Mission): Promise<Progress> {
  const files = await repoFiles(cx, m);
  const dir = join(cx.checkout(m), ".towercab-shots");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const n = data(m).n?.verify ?? 1;
  return {
    spawn: sandboxSpec(cx, m, {
      kind: "shots",
      lines: [files.verifying.screenshots!],
      dir: cx.checkout(m),
      cacheWritable: checksMayWrite(cx, m),
      log: logPath(cx, m, "verify", `shots-${n}.log`),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
      extraEnv: { TOWERCAB_SHOTS: dir },
    }),
  };
}

/**
 * PIP-167, PIP-169: a merge made by code that didn't pass is thrown away (it was never pushed) and the
 * worker's conflict round runs; the failed attempt is not a round or a repair.
 */
async function dropMechanical(cx: Ctx, m: Mission, why: string): Promise<Progress> {
  await coGit(cx, m, ["reset", "--hard", "--quiet", data(m).mech!.ours]);
  cx.log(`${m.intent}: the merge made by code is dropped: ${why}`);
  return {
    done: red(`the merge made by code is dropped (${why}); the worker resolves the conflict`, {
      data: {
        mech: undefined,
        mechFailed: true,
        repair: { what: "The PR conflicts with its base branch.", details: "", kind: "conflict" },
      },
    }),
  };
}

/** PIP-169: the short review of the merge commit alone (its diff against the PR head before the merge). */
async function mergeReview(cx: Ctx, m: Mission): Promise<Progress> {
  const mech = data(m).mech!;
  const intent = await intentOf(cx, m);
  return spawnRun(cx, m, {
    kind: "review",
    agent: "merge-review",
    step: "merge-review",
    stage: "verify",
    prompt: render("merge-review", {
      intent: intentData(intent.text),
      diff_cmd: `git diff ${mech.ours} HEAD`,
      resolved: mech.notes.map((n) => `- ${n}`).join("\n"),
    }),
    files: await repoFiles(cx, m),
    intent,
  });
}

async function mergeReviewEnd(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
  const mech = data(m).mech!;
  const r = ended(cx, m, "review", end, (v) => parseResult("merge_review", v));
  if (!r.ok) {
    // A review that can't finish is no yes: the worker takes the conflict as before.
    if ("done" in r.progress && r.progress.done.event === "wait")
      return dropMechanical(cx, m, "its review didn't finish");
    return r.progress;
  }
  const v = r.value;
  const round = data(m).n?.review ?? 1;
  const plain = v.summary.trim();
  const lost = v.lost.map((l) => `- \`${l.file}\`: ${l.what}`).join("\n");
  await note(
    cx,
    m,
    "Verify",
    round,
    `**Merge review:** ${v.kept_both ? "both sides kept" : "a side was lost, so the worker resolves the conflict"}\n\n${plain}${lost ? `\n\n${lost}` : ""}`,
  );
  if (!v.kept_both) return dropMechanical(cx, m, "the merge review found a side lost");
  return { done: ok({ why: "the merge kept both sides", data: { mech: { ...mech, reviewed: true } } }) };
}

const FAILING = /^\s*(?:[×✗✖]|FAIL\b|not ok\b|error(?:\[| TS\d+|:)|.*\b(?:AssertionError|panicked at)\b)/;

/**
 * What failed, for a person (PIP-23): up to three lines of the log that name a failing test or error, else its
 * last line; colour codes removed, each cut to 100 characters. Empty when the log says nothing.
 */
export function failingLines(log: string): string {
  const lines = log
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes.
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("$ "));
  const hits = [...new Set(lines.filter((l) => FAILING.test(l)))];
  const picked = hits.length ? hits.slice(0, 3) : lines.slice(-1);
  const more = hits.length > 3 ? ` (and ${hits.length - 3} more)` : "";
  return picked.map((l) => (l.length > 100 ? `${l.slice(0, 99)}…` : l)).join("; ") + more;
}

/** A red verify: a repair round, or after the repairs `checks red`. */
async function failed(cx: Ctx, m: Mission, what: string, log: string): Promise<Progress> {
  if (data(m).mech) return dropMechanical(cx, m, `${what.replace(/\.$/, "").toLowerCase()}`);
  // The owner reads which test or error it was, not only that something failed.
  const which = failingLines(log);
  const said = which ? `${what.replace(/\.$/, "")}: ${which}` : what;
  if (m.repairs >= MAX_REPAIRS)
    return { done: wait("checks red", `Still failing after ${MAX_REPAIRS} fix attempts: ${said}`) };
  return {
    done: red(said, {
      set: { repairs: m.repairs + 1 },
      data: {
        repair: { what, details: tail(log), kind: "verify" },
        verify: { log: tail(log, 2000), result: "red" },
      },
    }),
  };
}
