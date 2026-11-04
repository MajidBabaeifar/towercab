// The `publish` stage (PIP-2, PIP-29, PIP-31): refuse what the guard should have stopped, push the
// branch as the bot, open the code PR the first time.

import { git } from "../checkout.ts";
import { type BranchPr, deleteBranch, prsOnBranch } from "../github/branches.ts";
import { isBot } from "../github/events.ts";
import { closeIfOpen } from "../github/prs.ts";
import type { Ctx, Handler, Progress } from "../handlers.ts";
import { type Outcome, ok, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { CONTROL, Protected } from "../repo/protected.ts";
import { blockedTests, testGrantsOf } from "./access.ts";
import {
  asEnv,
  ask,
  branchInTheWay,
  cloneOf,
  coGit,
  commitTitle,
  data,
  gh,
  grants,
  intentOf,
  PushRefused,
  prUrl,
  pushBranch,
  refusedPush,
  repoFiles,
  takeRemote,
} from "./common.ts";
import { existingChanged, existingTests, lockedTests, publishRefusals, sameAsBase } from "./guard.ts";
import { codeBody } from "./prtext.ts";

export const publishHandler: Handler = {
  async step(cx, m) {
    if (m.step === "pr") return openPr(cx, m);
    const repo = cx.repo(m);
    const intent = await intentOf(cx, m);
    const files = await repoFiles(cx, m);
    const d = data(m);
    const g = grants(m, intent, files, cx);
    const changed = (await coGit(cx, m, ["diff", "--name-only", `refs/remotes/origin/${repo.base}...HEAD`]))
      .split("\n")
      .filter(Boolean);
    const sinceHead = d.lockHead
      ? (await coGit(cx, m, ["diff", "--name-status", `${d.lockHead}..HEAD`]))
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [status, ...p] = l.split("\t");
            return { status: status ?? "", path: p[p.length - 1] ?? "" };
          })
      : [];
    const locked = await lockedTests(cx.tools, cx.checkout(m), d.lockHead ?? null, files.towercab.tests);
    // PIP-31: a locked test that now reads as on the base came in with a merge of the base, not from the worker.
    const touched = sinceHead.filter((c) => locked.includes(c.path)).map((c) => c.path);
    const fromBase = await sameAsBase(cx.tools, cx.checkout(m), `refs/remotes/origin/${repo.base}`, touched);
    // PIP-117: a test on the base branch that no grant covers can't be modified or deleted.
    const blocked = blockedTests(
      await existingTests(cx.tools, cx.checkout(m), repo.base, files.towercab.tests, files.towercab.live),
      d,
    );
    const bad = publishRefusals(
      changed,
      new Protected([...CONTROL, ...files.towercab.protected], g.paths),
      sinceHead.filter((c) => !fromBase.includes(c.path)),
      locked,
      await existingChanged(cx.tools, cx.checkout(m), repo.base, blocked),
    );
    if (bad.length)
      return { done: wait("answer the question", `the branch changes paths it may not: ${bad.join(", ")}`) };
    if (m.pr && (await takeRemote(cx, m, m.branch)) === "conflict") {
      await coGit(cx, m, ["merge", "--abort"]).catch(() => "");
      return {
        done: wait(
          "answer the question",
          "commits pushed to the PR conflict with Towercab's; reply to let the worker merge them",
        ),
      };
    }
    const head = (await coGit(cx, m, ["rev-parse", "HEAD"])).trim();
    const fresh = cx.record(m, "push", { head });
    if (!m.pr && !data(m).pushed) {
      const stop = await clearLeftover(cx, fresh, head);
      if (stop) return { done: stop };
    }
    try {
      await pushBranch(cx, fresh, m.branch, m.branch);
    } catch (e) {
      if (e instanceof PushRefused) return refusedPush(cx, fresh, e);
      throw e;
    }
    return openPr(
      cx,
      cx.record(fresh, "pr", { pushed_at: cx.clock.now() }, { pushed: true, pushRefusals: 0 }),
    );
  },
  async finish() {
    return { poll: 0 };
  },
};

/**
 * Before the first push (PIP-86): a branch of that name already on GitHub is cleared away when only
 * Towercab's own earlier PRs are on it (an older attempt, or v1); with anyone else's open PR, or no PR
 * of ours at all, the owner is asked and nothing is touched. Returns the wait, or null to go on.
 */
async function clearLeftover(cx: Ctx, m: Mission, head: string): Promise<Outcome | null> {
  const repo = cx.repo(m);
  const clone = cloneOf(cx, m);
  const auth = await cx.github.gitAuth(repo.github);
  let listed: string;
  try {
    listed = await git(cx.tools, clone, ["ls-remote", "--heads", "origin", `refs/heads/${m.branch}`], auth);
  } catch (e) {
    throw asEnv(e);
  }
  const sha = listed.trim().split(/\s+/)[0] ?? "";
  // Gone, or already ours (a push that finished before a crash): nothing in the way.
  if (!sha || sha === head) return null;
  let prs: BranchPr[];
  try {
    prs = await prsOnBranch(cx.github, repo.github, m.branch);
  } catch (e) {
    throw asEnv(e);
  }
  const bot = (await cx.github.bot()).login;
  const foreign = prs.find((p) => p.state === "OPEN" && !isBot(p.author, bot));
  if (foreign || !prs.some((p) => isBot(p.author, bot))) {
    return ask(
      cx,
      m,
      branchInTheWay(
        m.branch,
        foreign ? { number: foreign.number, url: prUrl(repo.github, foreign.number) } : undefined,
      ),
    );
  }
  const why = `Towercab started this intent over, so this PR is closed. The new attempt pushes its own work to \`${m.branch}\` and opens its own PR.`;
  for (const p of prs) if (p.state === "OPEN") await closeOwn(cx, repo.github, p.number, why);
  try {
    await deleteBranch(cx.github, repo.github, m.branch, cx.store.github());
  } catch (e) {
    throw asEnv(e);
  }
  return null;
}

async function closeOwn(cx: Ctx, github: string, n: number, why: string): Promise<void> {
  try {
    await closeIfOpen(cx.github, github, n, why);
  } catch (e) {
    throw asEnv(e);
  }
}

async function openPr(cx: Ctx, m: Mission): Promise<Progress> {
  if (m.pr) return { done: ok() };
  const repo = cx.repo(m);
  const intent = await intentOf(cx, m);
  const d = data(m);
  const existing = JSON.parse(
    await gh(cx, repo.github, [
      "pr",
      "list",
      "-R",
      repo.github,
      "--head",
      m.branch,
      "--state",
      "open",
      "--json",
      "number",
    ]),
  ) as { number: number }[];
  let n = existing[0]?.number;
  if (!n) {
    const body = codeBody({
      worker: d.build?.pr ?? null,
      brief: d.build?.brief ?? "",
      intentTitle: intent.title,
      intentProblem: intent.sections.get("Problem") ?? null,
      checks: null,
      unplanned: [],
      tests: testGrantsOf(d),
      specIds: d.design?.specIds ?? [],
      links: {
        intentUrl: cx.store.url(intent),
        specPrUrl: m.spec_pr ? prUrl(repo.github, m.spec_pr) : null,
        planPrUrl: m.plan_pr && cx.store.github() ? prUrl(cx.store.github()!, m.plan_pr) : null,
      },
      reviewDetails: null,
      footer: { intentUrl: cx.store.url(intent), costUsd: m.cost_usd, secs: m.agent_secs },
      issue: { url: intent.issue, repo: repo.github },
    });
    const url = await gh(
      cx,
      repo.github,
      [
        "pr",
        "create",
        "-R",
        repo.github,
        "--base",
        repo.base,
        "--head",
        m.branch,
        "--title",
        commitTitle(m, intent),
        "--body-file",
        "-",
      ],
      body,
    );
    n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  }
  return { done: ok({ set: { pr: n } }) };
}
