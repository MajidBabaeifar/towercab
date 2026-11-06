// The ship stage (SHIP-6..15): after the merge, wait until the platform says the commit is live,
// run the repo's e2e suites against it, and when they fail, ask for the last good version, fix
// forward, and after two fixes revert. Towercab never deploys; the adapter only reads and asks.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { git, refreshBase } from "../checkout.ts";
import { classifyRun } from "../faults.ts";
import { MERGE_METHOD } from "../forge.ts";
import { prsOnBranch } from "../github/branches.ts";
import { type ChildEnd, type Ctx, EnvError, type Handler, type Progress } from "../handlers.ts";
import { type Outcome, ok, red, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { type Adapter, adapterOf, RollbackRefused, shipEnv } from "../ship/adapter.ts";
import { type Live, liveDomains, smokeSuites, suiteOrder } from "../ship/live.ts";
import { readSecrets, type Secrets, secretsPath } from "../ship/secrets.ts";
import { checksMayWrite, logPath, sandboxSpec } from "./checks.ts";
import { ciState } from "./ci.ts";
import {
  botAuthor,
  cloneOf,
  coGit,
  data,
  intentOf,
  nextN,
  type PipeData,
  pushBranch,
  repoFiles,
  repoFilesWait,
  type ShipData,
  tail,
  viaForge,
} from "./common.ts";

export const MAX_FIXES = 2;
const HOLD_POLL = 60;

/** The `meta` key of a repo's last good version (SHIP-9). */
export const lastGoodKey = (repo: string) => `lastgood:${repo}`;

interface ShipCx {
  live: Live;
  secrets: Secrets;
  adapter: Adapter;
  ship: ShipData;
}

/** The live block, the secrets and the adapter; a repo-file or secrets problem is a wait. */
async function shipCx(cx: Ctx, m: Mission): Promise<ShipCx | { done: Outcome } | null> {
  let live: Live | null;
  try {
    live = (await repoFiles(cx, m)).towercab.live;
  } catch (e) {
    const w = repoFilesWait(e);
    if (w) return { done: w };
    throw e;
  }
  if (!live) return null;
  let secrets: Secrets;
  try {
    secrets = readSecrets(secretsPath(cx.config.file, m.repo));
  } catch (e) {
    return { done: wait("fix repo files", (e as Error).message) };
  }
  const adapter = adapterOf({ cx, m, live, secrets, clone: cloneOf(cx, m), dir: cx.checkout(m) });
  return { live, secrets, adapter, ship: data(m).ship ?? { merges: [], fixes: 0 } };
}

const short = (sha: string) => sha.slice(0, 7);

/** The mission's checkout, clean, with base fresh from the clone, detached at `sha` (or left on base). */
async function checkoutAt(cx: Ctx, m: Mission, sha: string | null): Promise<void> {
  const repo = cx.repo(m);
  const clone = cloneOf(cx, m);
  await git(cx.tools, clone, ["fetch", "--quiet", "origin"], await cx.github.gitAuth(repo.github));
  await refreshBase(cx.tools, clone, cx.checkout(m), repo.base);
  await coGit(cx, m, ["reset", "--quiet", "--hard"]);
  await coGit(cx, m, ["clean", "-fdq"]);
  if (sha) await coGit(cx, m, ["checkout", "--quiet", "--detach", sha]);
}
const minutes = (live: Live) => `${live.timeout} minute${live.timeout === 1 ? "" : "s"}`;
const late = (cx: Ctx, s: ShipData, live: Live) =>
  cx.clock.now() - (s.since ?? cx.clock.now()) > live.timeout * 60;

// ── Suites (SHIP-9, SHIP-10) ─────────────────────────────────────────────────────────────────────

type SuiteRun = { kind: "e2e"; retry: true } | { kind: "smoke"; retry: false };

/** The repo's setup block in the checkout, with network, before the suites; none → the first suite. */
async function startSuites(
  cx: Ctx,
  m: Mission,
  sc: ShipCx,
  order: string[],
  run: SuiteRun,
): Promise<Progress> {
  const files = await repoFiles(cx, m);
  const ship: ShipData = { ...sc.ship, e2e: { order, i: 0, tries: 0 } };
  const fresh = cx.record(m, `${run.kind}-setup`, {}, { ship });
  if (files.verifying.setup.length === 0) return nextSuite(cx, cx.record(fresh, `${run.kind}-suite`), sc);
  const { n, data: nd } = nextN(fresh, "e2e");
  const at = cx.record(fresh, fresh.step, {}, nd);
  const sha = (await coGit(cx, at, ["rev-parse", "HEAD"])).trim();
  return {
    spawn: sandboxSpec(cx, at, {
      kind: "e2e-setup",
      lines: files.verifying.setup,
      dir: cx.checkout(at),
      cacheWritable: true,
      log: logPath(cx, at, "e2e", `${n}-setup.log`),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
      extraEnv: shipEnv(sc, sha),
      domains: liveDomains(sc.live),
    }),
  };
}

async function nextSuite(cx: Ctx, m: Mission, sc: ShipCx): Promise<Progress> {
  const e = (data(m).ship ?? sc.ship).e2e!;
  const suite = sc.live.suites.find((s) => s.name === e.order[e.i]);
  if (!suite) return { done: { event: "bad_result", why: `no suite ${e.order[e.i]}` } };
  const { n, data: nd } = nextN(m, "e2e");
  const at = cx.record(m, m.step, {}, nd);
  const sha = (await coGit(cx, at, ["rev-parse", "HEAD"])).trim();
  return {
    spawn: sandboxSpec(cx, at, {
      kind: "e2e",
      lines: [suite.command],
      dir: cx.checkout(at),
      cacheWritable: checksMayWrite(cx, at),
      log: logPath(cx, at, "e2e", `${n}-${suite.name}.log`),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
      extraEnv: shipEnv(sc, sha),
      domains: liveDomains(sc.live),
    }),
  };
}

/** A finished run's output, redacted in the files Towercab keeps (SHIP-2). */
function keptLog(end: ChildEnd, secrets: Secrets): string {
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const log = secrets.redact(`${read(end.stdout)}${read(end.stderr)}`);
  try {
    writeFileSync(end.stdout, log);
    rmSync(end.stderr, { force: true });
  } catch {
    // The log is gone; the redacted text still goes on.
  }
  return log;
}

type SuitesDone =
  | { green: true; m: Mission }
  | { green: false; m: Mission; suite: string; log: string; path: string };

/** A setup or suite child ended: the next suite, a retry, or the result. */
async function suiteEnded(
  cx: Ctx,
  m: Mission,
  sc: ShipCx,
  end: ChildEnd,
  run: SuiteRun,
): Promise<Progress | SuitesDone> {
  const log = keptLog(end, sc.secrets);
  const e = sc.ship.e2e!;
  if (m.step === `${run.kind}-setup`) {
    if (end.code !== 0) {
      const env = classifyRun(log);
      if (env) throw new EnvError(env.kind, env.why);
      return { green: false, m, suite: "setup", log: tail(log), path: end.stdout };
    }
    return nextSuite(cx, cx.record(m, `${run.kind}-suite`), sc);
  }
  const name = e.order[e.i]!;
  if (end.code !== 0 || end.timedOut) {
    if (run.retry && e.tries === 0) {
      const again = cx.record(m, m.step, {}, { ship: { ...sc.ship, e2e: { ...e, tries: 1 } } });
      return nextSuite(cx, again, sc);
    }
    return { green: false, m, suite: name, log: tail(log), path: end.stdout };
  }
  if (e.i + 1 < e.order.length) {
    const on = cx.record(m, m.step, {}, { ship: { ...sc.ship, e2e: { ...e, i: e.i + 1, tries: 0 } } });
    return nextSuite(cx, on, sc);
  }
  return { green: true, m };
}

const isDone = (p: Progress | SuitesDone): p is SuitesDone => "green" in p;

// ── deploy (SHIP-7, SHIP-15) ─────────────────────────────────────────────────────────────────────

export const deployHandler: Handler = {
  async step(cx, m) {
    // The live block is read from base, which now holds the merge and anything merged before it:
    // fetch first, or a block added since the clone's last fetch is missed (SHIP-7).
    if (m.step === "") {
      const repo = cx.repo(m);
      await git(
        cx.tools,
        cloneOf(cx, m),
        ["fetch", "--quiet", "origin"],
        await cx.github.gitAuth(repo.github),
      );
    }
    const sc = await shipCx(cx, m);
    if (sc === null) return { done: { event: "skip" } };
    if ("done" in sc) return sc;
    if (m.step === "") {
      if (!m.merge_sha) return { done: { event: "bad_result", why: "the merge commit is unknown" } };
      const merges = sc.ship.merges.includes(m.merge_sha) ? sc.ship.merges : [...sc.ship.merges, m.merge_sha];
      m = cx.record(m, "wait", {}, { ship: { ...sc.ship, merges, since: cx.clock.now() } });
      await checkoutAt(cx, m, m.merge_sha);
      sc.ship = data(m).ship!;
    }
    const sha = sc.ship.merges.at(-1)!;
    const o = await sc.adapter.outcome(sha);
    if (o.state === "live") return { done: ok({ why: `${short(sha)} is live` }) };
    if (o.state === "failed") return { done: shipRed(sc, "deploy", `the deploy failed: ${o.why}`, "") };
    if (late(cx, sc.ship, sc.live))
      return { done: shipRed(sc, "deploy", `not live after ${minutes(sc.live)}`, "") };
    return { poll: cx.config.agent.ciPoll };
  },
  async finish() {
    return { poll: 0 };
  },
};

/** A red deploy or e2e run: the rollback gets what failed (SHIP-10, SHIP-11). */
function shipRed(sc: ShipCx, suite: string, why: string, log: string, path = ""): Outcome {
  return red(why, {
    data: { ship: { ...sc.ship, red: { suite, log: log || why, path }, since: undefined } },
  });
}

// ── e2e (SHIP-9) ─────────────────────────────────────────────────────────────────────────────────

export const e2eHandler: Handler = {
  async step(cx, m) {
    const sc = await shipCx(cx, m);
    if (sc === null) return { done: ok({ why: "no live block" }) };
    if ("done" in sc) return sc;
    if (m.step === "") {
      const sha = sc.ship.merges.at(-1)!;
      await checkoutAt(cx, m, sha);
      const changed = (
        await coGit(cx, m, ["diff", "--name-only", "--diff-filter=AMR", `${sc.ship.merges[0]}^`, sha])
      )
        .split("\n")
        .filter(Boolean);
      const order = suiteOrder(sc.live, changed).map((s) => s.name);
      return startSuites(cx, m, sc, order, { kind: "e2e", retry: true });
    }
    if (m.step === "e2e-setup")
      return startSuites(cx, m, sc, sc.ship.e2e!.order, { kind: "e2e", retry: true });
    if (m.step === "e2e-suite") return nextSuite(cx, m, sc);
    return { done: { event: "bad_result", why: `unknown e2e step ${m.step}` } };
  },
  async finish(cx, m, end) {
    const sc = await shipCx(cx, m);
    if (sc === null || "done" in sc) return { poll: 0 };
    const r = await suiteEnded(cx, m, sc, end, { kind: "e2e", retry: true });
    if (!isDone(r)) return r;
    const sha = sc.ship.merges.at(-1)!;
    if (r.green)
      return {
        done: ok({
          why: `e2e green on ${short(sha)}`,
          meta: { [lastGoodKey(m.repo)]: sha },
          data: { ship: { ...data(r.m).ship!, e2e: undefined } },
        }),
      };
    const what = r.suite === "setup" ? "the e2e setup failed" : `e2e suite ${r.suite} failed twice`;
    return {
      done: shipRed(
        { ...sc, ship: data(r.m).ship! },
        r.suite,
        `${what} against ${sc.live.url}`,
        r.log,
        r.path,
      ),
    };
  },
};

// ── rollback (SHIP-10, SHIP-11, SHIP-13) ─────────────────────────────────────────────────────────

async function targetOf(cx: Ctx, m: Mission, sc: ShipCx): Promise<string> {
  const good = cx.db.meta(lastGoodKey(m.repo));
  if (good) return good;
  return (await git(cx.tools, cloneOf(cx, m), ["rev-parse", `${sc.ship.merges[0]}^`])).trim();
}

const frozen = (why: string) => wait("rollback failed", why);

export const rollbackHandler: Handler = {
  async step(cx, m) {
    const sc = await shipCx(cx, m);
    if (sc === null) return { done: frozen("the repo's live block is gone") };
    if ("done" in sc) return sc;
    const broken = sc.ship.merges.at(-1)!;
    if (m.step === "") {
      const target = await targetOf(cx, m, sc);
      m = cx.record(m, "request", {}, { ship: { ...sc.ship, target, since: cx.clock.now() } });
      sc.ship = data(m).ship!;
    }
    const target = sc.ship.target!;
    if (m.step === "request") {
      if ((await sc.adapter.current()) !== target) {
        try {
          const id = await sc.adapter.rollback({
            sha: target,
            from: broken,
            reason: sc.ship.red?.suite
              ? `${sc.ship.red.suite} red after ${short(broken)}`
              : "red after the merge",
            intent: m.intent,
            since: sc.ship.since ?? cx.clock.now(),
          });
          m = cx.record(m, "wait", {}, { ship: { ...sc.ship, requested: id ?? undefined } });
        } catch (e) {
          if (e instanceof RollbackRefused)
            return { done: frozen(`asking for ${short(target)} failed: ${e.message}`) };
          throw e;
        }
      } else {
        m = cx.record(m, "wait");
      }
      sc.ship = data(m).ship!;
    }
    if (m.step === "wait") {
      if ((await sc.adapter.current()) === target) {
        await checkoutAt(cx, m, target);
        return startSuites(
          cx,
          m,
          sc,
          smokeSuites(sc.live).map((s) => s.name),
          { kind: "smoke", retry: false },
        );
      }
      const o = await sc.adapter.outcome(target);
      if (o.state === "failed")
        return { done: frozen(`the platform failed to deploy ${short(target)}: ${o.why}`) };
      if (late(cx, sc.ship, sc.live))
        return { done: frozen(`${short(target)} was not live after ${minutes(sc.live)}`) };
      return { poll: cx.config.agent.ciPoll };
    }
    if (m.step === "smoke-setup")
      return startSuites(
        cx,
        m,
        sc,
        smokeSuites(sc.live).map((s) => s.name),
        { kind: "smoke", retry: false },
      );
    if (m.step === "smoke-suite") return nextSuite(cx, m, sc);
    return { done: { event: "bad_result", why: `unknown rollback step ${m.step}` } };
  },
  async finish(cx, m, end) {
    const sc = await shipCx(cx, m);
    if (sc === null || "done" in sc) return { poll: 0 };
    const r = await suiteEnded(cx, m, sc, end, { kind: "smoke", retry: false });
    if (!isDone(r)) return r;
    const target = sc.ship.target!;
    if (!r.green)
      return {
        done: frozen(`back on ${short(target)}, but smoke suite ${r.suite} is red: ${tail(r.log, 300)}`),
      };
    const ship = data(r.m).ship!;
    if (ship.fixes >= MAX_FIXES)
      return {
        done: {
          event: "revert",
          why: `back on ${short(target)}; ${MAX_FIXES} fixes didn't hold, reverting`,
          data: { ship: { ...ship, e2e: undefined } },
        },
      };
    return { done: fixRound(r.m, sc, ship, target) };
  },
};

/** SHIP-11: back to build on a new branch from base, with the e2e failure as the repair. */
function fixRound(m: Mission, sc: ShipCx, ship: ShipData, target: string): Outcome {
  const n = ship.fixes + 1;
  const base = m.branch.replace(/-fix\d+$/, "");
  const red = ship.red ?? { suite: "e2e", log: "", path: "" };
  const broken = ship.merges.at(-1)!;
  const what =
    red.suite === "deploy"
      ? `After ${short(broken)} was merged, the deploy to ${sc.live.url} failed (${red.log}). The live app is back on ${short(target)}. Find and fix the cause on top of main, with a test that would have caught it.`
      : `After ${short(broken)} went live, the e2e suite \`${red.suite}\` failed twice against ${sc.live.url}. The live app is back on ${short(target)}. Find and fix the cause on top of main, with a test that would have caught it. The suite's log:`;
  // Everything a first build round finds empty starts empty again (PIP-1).
  const clear: Partial<Record<keyof PipeData, undefined>> = {
    build: undefined,
    lockHead: undefined,
    roundFrom: undefined,
    pushed: undefined,
    ci: undefined,
    review: undefined,
    reviewFixes: undefined,
    ownerSteps: undefined,
    proof: undefined,
    proofLines: undefined,
    proofWaited: undefined,
    unproven: undefined,
    verify: undefined,
    shots: undefined,
    foreignHead: undefined,
    mergeTries: undefined,
    updatedBranch: undefined,
    unplanned: undefined,
  };
  return ok({
    why: `back on ${short(target)}; fix ${n} of ${MAX_FIXES}`,
    set: {
      branch: `${base}-fix${n}`,
      pr: null,
      head: null,
      merge_sha: null,
      merged_by: null,
      pushed_at: null,
      repairs: 0,
      ci_repairs: 0,
    },
    data: {
      ...clear,
      repair: { kind: "e2e", what, details: red.suite === "deploy" ? "" : red.log },
      ship: {
        ...ship,
        fixes: n,
        e2e: undefined,
        since: undefined,
        requested: undefined,
        prs: m.pr !== null ? [...(ship.prs ?? []), m.pr] : ship.prs,
      },
    },
  });
}

// ── revert (SHIP-12) ─────────────────────────────────────────────────────────────────────────────

export const revertHandler: Handler = {
  async step(cx, m) {
    const sc = await shipCx(cx, m);
    if (sc === null) return { done: frozen("the repo's live block is gone") };
    if ("done" in sc) return sc;
    const repo = cx.repo(m);
    const branch = `towercab/${m.intent}-revert`;
    if (m.step === "") {
      m = cx.record(
        m,
        "branch",
        {},
        { ship: { ...sc.ship, revert: { branch, pr: null, head: null, sha: null } } },
      );
      sc.ship = data(m).ship!;
    }
    const rv = sc.ship.revert!;
    if (m.step === "branch") {
      const clone = cloneOf(cx, m);
      await git(cx.tools, clone, ["fetch", "--quiet", "origin"], await cx.github.gitAuth(repo.github));
      await checkoutAt(cx, m, null);
      await coGit(cx, m, ["checkout", "--quiet", "-B", branch, `refs/remotes/origin/${repo.base}`]);
      const author = await botAuthor(cx);
      for (const sha of [...sc.ship.merges].reverse()) {
        try {
          await coGit(cx, m, [...author, "revert", "--no-edit", sha]);
        } catch {
          await coGit(cx, m, ["revert", "--abort"]).catch(() => "");
          return { done: frozen(`reverting ${short(sha)} on ${repo.base} conflicts`) };
        }
      }
      const head = (await coGit(cx, m, ["rev-parse", "HEAD"])).trim();
      await pushBranch(cx, m, branch, branch);
      m = cx.record(
        m,
        "pr",
        { pushed_at: cx.clock.now() },
        { ship: { ...sc.ship, revert: { ...rv, head } } },
      );
      sc.ship = data(m).ship!;
    }
    if (m.step === "pr") {
      const r = sc.ship.revert!;
      let pr =
        (await prsOnBranch(cx.github, repo.github, branch)).find((p) => p.state === "OPEN")?.number ?? null;
      if (!pr) {
        const intent = await intentOf(cx, m);
        const body = revertBody(sc, intent.title);
        pr = await viaForge(
          cx.github.openPr(repo.github, {
            base: repo.base,
            head: branch,
            title: `Revert: ${intent.title}`,
            body,
          }),
        );
        if (!pr) return { done: frozen("GitHub didn't return the revert PR's number") };
      }
      m = cx.record(m, "ci", {}, { ship: { ...sc.ship, revert: { ...r, pr }, since: cx.clock.now() } });
      sc.ship = data(m).ship!;
    }
    if (m.step === "ci") {
      const r = sc.ship.revert!;
      const st = await ciState(cx, repo.github, r.pr!, r.head, m.pushed_at ?? cx.clock.now());
      if (st.kind === "green" || st.kind === "none") {
        const fresh = cx.record(m, "merge");
        const res = await cx.github.mergePr(repo.github, r.pr!, { method: MERGE_METHOD, head: r.head! });
        if (!res.ok)
          return {
            done: frozen(`GitHub refused to merge the revert PR: ${res.reason.split("\n")[0]}`),
          };
        m = fresh;
      } else if (st.kind === "red" || st.kind === "cancel" || st.kind === "conflict" || st.kind === "moved") {
        return { done: frozen(`the revert PR's CI is ${st.kind === "moved" ? "on a moved head" : st.kind}`) };
      } else if (cx.clock.now() - (sc.ship.since ?? cx.clock.now()) > cx.config.agent.ciWait) {
        return { done: frozen("the revert PR's CI didn't finish in time") };
      } else {
        return { poll: cx.config.agent.ciPoll };
      }
    }
    if (m.step === "merge") {
      const r = sc.ship.revert!;
      const v = await viaForge(cx.github.mergeStatus(repo.github, r.pr!));
      if (v.state !== "MERGED" || !v.mergeCommit) return { poll: 5 };
      m = cx.record(
        m,
        "live",
        {},
        { ship: { ...sc.ship, revert: { ...r, sha: v.mergeCommit }, since: cx.clock.now() } },
      );
      sc.ship = data(m).ship!;
    }
    if (m.step === "live") {
      const sha = sc.ship.revert!.sha!;
      const o = await sc.adapter.outcome(sha);
      if (o.state === "live") {
        await checkoutAt(cx, m, sha);
        return startSuites(
          cx,
          m,
          sc,
          smokeSuites(sc.live).map((s) => s.name),
          { kind: "smoke", retry: false },
        );
      }
      if (o.state === "failed")
        return { done: frozen(`the revert ${short(sha)} failed to deploy: ${o.why}`) };
      if (late(cx, sc.ship, sc.live))
        return { done: frozen(`the revert ${short(sha)} was not live after ${minutes(sc.live)}`) };
      return { poll: cx.config.agent.ciPoll };
    }
    if (m.step === "smoke-setup")
      return startSuites(
        cx,
        m,
        sc,
        smokeSuites(sc.live).map((s) => s.name),
        { kind: "smoke", retry: false },
      );
    if (m.step === "smoke-suite") return nextSuite(cx, m, sc);
    return { done: { event: "bad_result", why: `unknown revert step ${m.step}` } };
  },
  async finish(cx, m, end) {
    const sc = await shipCx(cx, m);
    if (sc === null || "done" in sc) return { poll: 0 };
    const r = await suiteEnded(cx, m, sc, end, { kind: "smoke", retry: false });
    if (!isDone(r)) return r;
    if (!r.green)
      return { done: frozen(`the revert is live, but smoke suite ${r.suite} is red: ${tail(r.log, 300)}`) };
    const red = sc.ship.red;
    return {
      done: wait(
        "rolled back, revise",
        red
          ? `${red.suite} failed against ${sc.live.url}${red.path ? ` (log: ${red.path})` : ""}`
          : `the change failed against ${sc.live.url}`,
      ),
    };
  },
};

function revertBody(sc: ShipCx, title: string): string {
  const red = sc.ship.red;
  const merges = sc.ship.merges.map((s) => `- ${s}`).join("\n");
  const why = red
    ? `After it went live, the e2e suite \`${red.suite}\` failed against ${sc.live.url}, and ${MAX_FIXES} fixes didn't hold.`
    : `After it went live, it failed against ${sc.live.url}, and ${MAX_FIXES} fixes didn't hold.`;
  const log = red?.log
    ? `\n\nThe last failing run, ending:\n\n\`\`\`text\n${tail(red.log, 3000)}\n\`\`\``
    : "";
  return `This reverts the merges of "${title}" so \`main\` matches what is live again. ${why} The live app is already back on the last good version; this PR only cleans up \`main\`. The intent goes back to the owner to revise.\n\nMerges reverted, newest first:\n\n${merges}${log}\n`;
}

// ── hold (SHIP-14) ───────────────────────────────────────────────────────────────────────────────

const SHIPPING = ["deploy", "e2e", "rollback", "revert"];

/** Another mission of the repo that is shipping, being fixed, or frozen; null when the repo is free. */
export function holder(cx: Ctx, m: Mission): Mission | null {
  const others = cx.db.all<Mission>(
    "SELECT * FROM missions WHERE repo = ? AND id != ? AND stage NOT IN ('done', 'stopped', 'unverified')",
    m.repo,
    m.id,
  );
  return (
    others.find(
      (o) =>
        SHIPPING.includes(o.stage) ||
        (o.stage === "blocked" && o.waiting === "rollback failed") ||
        ((data(o).ship?.fixes ?? 0) > 0 && o.waiting !== "rolled back, revise"),
    ) ?? null
  );
}

export const HOLD_SECS = HOLD_POLL;
