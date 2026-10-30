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
import { ask, cloneOf, coGit, data, nextN, repoFiles, tail } from "./common.ts";

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
            `You didn't allow the checks of ${repo} to write to its build cache, so they can't run.`,
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
          network: true,
          cacheWritable: true,
          log: logPath(cx, fresh, "verify", `verify-${n}-setup.log`),
          timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
        }),
      };
    }
    if (m.step === "checks") return checks(cx, m);
    if (m.step === "shots") return shots(cx, m);
    return { done: { event: "bad_result", why: `unknown verify step ${m.step}` } };
  },

  async finish(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
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
  const lines = await runLines(cx, m);
  const n = data(m).n?.verify ?? 1;
  if (lines.length === 0) return { done: ok({ why: "no local checks: CI runs the suite" }) };
  return {
    spawn: sandboxSpec(cx, m, {
      kind: "checks",
      lines,
      dir: cx.checkout(m),
      network: false,
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
      network: false,
      cacheWritable: checksMayWrite(cx, m),
      log: logPath(cx, m, "verify", `shots-${n}.log`),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
      extraEnv: { TOWERCAB_SHOTS: dir },
    }),
  };
}

/** A red verify: a repair round, or after the repairs `checks red`. */
function failed(cx: Ctx, m: Mission, what: string, log: string): Progress {
  void cx;
  if (m.repairs >= MAX_REPAIRS) return { done: wait("checks red", what) };
  return {
    done: red(what, {
      set: { repairs: m.repairs + 1 },
      data: {
        repair: { what, details: tail(log), kind: "verify" },
        verify: { log: tail(log, 2000), result: "red" },
      },
    }),
  };
}
