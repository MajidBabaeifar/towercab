// The `publish` stage (PIP-2, PIP-29, PIP-31): refuse what the guard should have stopped, push the
// branch as the bot, open the code PR the first time.

import type { Ctx, Handler, Progress } from "../handlers.ts";
import { ok, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { CONTROL, Protected } from "../repo/protected.ts";
import {
  coGit,
  commitTitle,
  data,
  gh,
  grants,
  intentOf,
  prUrl,
  pushBranch,
  repoFiles,
  takeRemote,
} from "./common.ts";
import { lockedTests, publishRefusals } from "./guard.ts";
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
    const bad = publishRefusals(
      changed,
      new Protected([...CONTROL, ...files.towercab.protected], g.paths),
      sinceHead,
      locked,
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
    await pushBranch(cx, fresh, m.branch, m.branch);
    return openPr(cx, cx.record(fresh, "pr", { pushed_at: cx.clock.now() }));
  },
  async finish() {
    return { poll: 0 };
  },
};

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
      intentTitle: intent.title,
      intentProblem: intent.sections.get("Problem") ?? null,
      checks: null,
      unplanned: [],
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
