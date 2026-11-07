// The red→green proof (PIP-30): the PR's changed test files, laid over base, must fail; then the tests
// prove the change. Green on base → a repair round asking for a proving test; after the repairs the
// owner decides; after the owner answers, an unproven change goes on, flagged for the gate.
// When the PR changes `CLAUDE.md` and may (PIP-54), its checks block is the one that runs, and it must
// also pass on the PR's head.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCheckout, git, removeCheckout } from "../checkout.ts";
import { classifyRun } from "../faults.ts";
import { type ChildEnd, type Ctx, EnvError, type Handler, type Progress } from "../handlers.ts";
import { ok, red, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { parseVerifying, type RepoFiles, type Verifying } from "../repo/files.ts";
import { CONTROL, Protected } from "../repo/protected.ts";
import { hasCi, quote, runSet } from "../repo/runset.ts";
import { withoutE2e } from "../ship/live.ts";
import { checksMayWrite, logPath, sandboxSpec } from "./checks.ts";
import { cloneOf, coGit, data, grants, intentOf, repoFiles, tail } from "./common.ts";
import { changedTests, MAX_REPAIRS } from "./verify.ts";

const proofDir = (cx: Ctx, m: Mission) => `${cx.checkout(m)}-proof`;

function read(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export const proofHandler: Handler = {
  async step(cx, m) {
    const d = data(m);
    const needed = (d.design?.specIds.length ?? 0) > 0 || d.design?.type === "fix";
    if (!needed) return { done: ok({ why: "no proof needed", data: { proof: "none needed" } }) };
    const files = await repoFiles(cx, m);
    const tests = withoutE2e(await changedTests(cx, m, files.towercab.tests), files.towercab.live);
    if (tests.length === 0) return notProven(cx, m, "The change adds or changes no test files.");
    if (m.step === "" || m.step === "setup") {
      const repo = cx.repo(m);
      const dir = proofDir(cx, m);
      removeCheckout(dir);
      await createCheckout(cx.tools, cloneOf(cx, m), dir, repo.base, `${m.branch}-proof`);
      const fresh = cx.record(m, "setup");
      if (files.verifying.setup.length === 0) return lay(cx, fresh, tests);
      return {
        spawn: sandboxSpec(cx, fresh, {
          kind: "proof-setup",
          lines: files.verifying.setup,
          dir,
          cacheWritable: true,
          log: logPath(cx, fresh, "proof", "proof-setup.log"),
          timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
        }),
      };
    }
    if (m.step === "head") return head(cx, m);
    return lay(cx, m, tests);
  },

  async finish(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
    if (m.step === "setup") {
      const files = await repoFiles(cx, m);
      return lay(cx, m, withoutE2e(await changedTests(cx, m, files.towercab.tests), files.towercab.live));
    }
    if (m.step === "head") return headEnd(cx, m, end);
    removeCheckout(proofDir(cx, m));
    if (end.code !== 0 || end.timedOut) {
      // Red on base. The PR's own checks block must also pass on the branch, or a line that always fails
      // would count as proof (PIP-54).
      if (data(m).proofLines?.fromPr) return head(cx, cx.record(m, "head"));
      return { done: ok({ why: "the new tests fail without the change", data: { proof: "proven" } }) };
    }
    return notProven(
      cx,
      m,
      `The PR's tests pass without the change, so they don't prove it.\n\n${tail(read(end.stdout), 3000)}`,
    );
  },
};

/** Lay the PR's test files over base (from the head commit, regular files only), then run the checks. */
async function lay(cx: Ctx, m: Mission, tests: string[]): Promise<Progress> {
  const dir = proofDir(cx, m);
  for (const t of tests) {
    const mode = (await coGit(cx, m, ["ls-tree", "HEAD", "--", t])).split(/\s/)[0];
    if (mode !== "100644" && mode !== "100755") continue;
    const text = await coGit(cx, m, ["show", `HEAD:${t}`]);
    mkdirSync(dirname(join(dir, t)), { recursive: true });
    writeFileSync(join(dir, t), text);
  }
  const files = await repoFiles(cx, m);
  const checks = await proofChecks(cx, m, files);
  const ci = await hasCi(cx.tools, cloneOf(cx, m), cx.repo(m).base);
  const lines = runSet(checks.verifying, ci, tests);
  void git;
  // A note on why the PR's block wasn't used goes first, so the log says so.
  const script = checks.note ? [`echo ${quote(checks.note)}`, ...lines] : lines;
  const fresh = cx.record(m, "checks", {}, { proofLines: { lines, fromPr: checks.fromPr } });
  return {
    spawn: sandboxSpec(cx, fresh, {
      kind: "proof",
      lines: script,
      dir,
      cacheWritable: checksMayWrite(cx, fresh),
      log: logPath(cx, fresh, "proof", "proof.log"),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000 * Math.max(1, script.length),
    }),
  };
}

/**
 * The checks the proof runs (PIP-54): the PR's `CLAUDE.md` block when the PR changes that file and the
 * worker may write it (publish's own test), else the base's. A PR file that doesn't parse, or isn't a
 * regular file, falls back to the base's, with a note for the log. Only the parsed block is used; the
 * file itself is never laid into the proof checkout.
 */
async function proofChecks(
  cx: Ctx,
  m: Mission,
  files: RepoFiles,
): Promise<{ verifying: Verifying; fromPr: boolean; note: string | null }> {
  const base = { verifying: files.verifying, fromPr: false, note: null };
  const changed = (
    await coGit(cx, m, ["diff", "--name-only", `refs/remotes/origin/${cx.repo(m).base}...HEAD`])
  ).split("\n");
  if (!changed.includes("CLAUDE.md")) return base;
  const g = grants(m, await intentOf(cx, m), files, cx);
  if (new Protected([...CONTROL, ...files.towercab.protected], g.paths).blocks("CLAUDE.md")) return base;
  const mode = (await coGit(cx, m, ["ls-tree", "HEAD", "--", "CLAUDE.md"])).split(/\s/)[0];
  const fallback = (why: string) => ({
    ...base,
    note: `CLAUDE.md in the PR doesn't parse (${why}); using the base's checks`,
  });
  if (mode !== "100644" && mode !== "100755") return fallback("it is not a regular file");
  try {
    return {
      verifying: parseVerifying(await coGit(cx, m, ["show", "HEAD:CLAUDE.md"])),
      fromPr: true,
      note: null,
    };
  } catch (e) {
    return fallback((e as Error).message);
  }
}

/** The PR's checks block on the PR's head, in the mission's checkout, which verify already set up. */
function head(cx: Ctx, m: Mission): Progress {
  const lines = data(m).proofLines?.lines ?? [];
  return {
    spawn: sandboxSpec(cx, m, {
      kind: "proof-head",
      lines,
      dir: cx.checkout(m),
      cacheWritable: checksMayWrite(cx, m),
      log: logPath(cx, m, "proof", "proof-head.log"),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000 * Math.max(1, lines.length),
    }),
  };
}

/**
 * Green on head → proven. Red → a repair round, then `checks red` as verify does: an owner's "go on"
 * never sends a failing block through as unproven.
 */
function headEnd(cx: Ctx, m: Mission, end: ChildEnd): Progress {
  if (end.code === 0 && !end.timedOut) {
    return {
      done: ok({
        why: "the new tests fail without the change and the checks pass with it",
        data: { proof: "proven" },
      }),
    };
  }
  const log = `${read(end.stdout)}${read(end.stderr)}`;
  const env = classifyRun(log);
  if (env) throw new EnvError(env.kind, env.why);
  const what = "The checks block your change adds to CLAUDE.md fails on your branch.";
  if (m.repairs >= MAX_REPAIRS)
    return { done: wait("checks red", `Still failing after ${MAX_REPAIRS} fix attempts: ${what}`) };
  return {
    done: red("the PR's checks block fails on the branch", {
      set: { repairs: m.repairs + 1 },
      data: {
        repair: {
          what: `${what} Make it pass: fix the code or the block, and keep the test that proves the change.`,
          details: tail(log),
          kind: "proof",
        },
      },
    }),
  };
}

function notProven(cx: Ctx, m: Mission, why: string): Progress {
  void cx;
  const d = data(m);
  if (d.proofWaited) {
    return {
      done: ok({
        why: "unproven; the owner decides at the gate",
        data: { proof: "not proven", unproven: true },
      }),
    };
  }
  if (m.repairs >= MAX_REPAIRS) {
    return {
      done: wait("tests don't prove the change", why.split("\n")[0], { data: { proofWaited: true } }),
    };
  }
  // What the proof ran, so the worker can tell a test that passes on base from one base never runs.
  const lines = d.proofLines?.lines ?? [];
  const ran = lines.length
    ? ` The proof copies only your changed test files onto the base branch and runs the base's checks there:\n\n${lines.map((l) => `    ${l}`).join("\n")}\n\nChanges to how tests run (a script, CI, a file you may not write) aren't used, so these commands must already run your test. If they can't, return status blocked with a question for the owner.`
    : "";
  return {
    done: red("no test fails without the change", {
      set: { repairs: m.repairs + 1 },
      data: {
        repair: {
          what: `No test fails without your change. Add or change a test that fails on the base branch and passes with the change; don't weaken existing tests.${ran}`,
          details: why,
          kind: "proof",
        },
      },
    }),
  };
}
