// The red→green proof (PIP-30): the PR's changed test files, laid over base, must fail; then the tests
// prove the change. Green on base → a repair round asking for a proving test; after the repairs the
// owner decides; after the owner answers, an unproven change goes on, flagged for the gate.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCheckout, git, removeCheckout } from "../checkout.ts";
import type { ChildEnd, Ctx, Handler, Progress } from "../handlers.ts";
import { ok, red, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { hasCi, runSet } from "../repo/runset.ts";
import { logPath, sandboxSpec } from "./checks.ts";
import { cloneOf, coGit, data, repoFiles, tail } from "./common.ts";
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
    const tests = await changedTests(cx, m, files.towercab.tests);
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
          network: true,
          cacheWritable: true,
          log: logPath(cx, fresh, "proof-setup.log"),
          timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
        }),
      };
    }
    return lay(cx, m, tests);
  },

  async finish(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
    if (m.step === "setup") {
      const files = await repoFiles(cx, m);
      return lay(cx, m, await changedTests(cx, m, files.towercab.tests));
    }
    removeCheckout(proofDir(cx, m));
    if (end.code !== 0 || end.timedOut)
      return { done: ok({ why: "the new tests fail without the change", data: { proof: "proven" } }) };
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
  const ci = await hasCi(cx.tools, cloneOf(cx, m), cx.repo(m).base);
  const lines = runSet(files.verifying, ci, tests);
  void git;
  const fresh = cx.record(m, "checks");
  return {
    spawn: sandboxSpec(cx, fresh, {
      kind: "proof",
      lines,
      dir,
      network: false,
      cacheWritable: false,
      log: logPath(cx, fresh, "proof.log"),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000 * Math.max(1, lines.length),
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
  return {
    done: red("no test fails without the change", {
      set: { repairs: m.repairs + 1 },
      data: {
        repair: {
          what: "No test fails without your change. Add or change a test that fails on the base branch and passes with the change; don't weaken existing tests.",
          details: why,
          kind: "proof",
        },
      },
    }),
  };
}
