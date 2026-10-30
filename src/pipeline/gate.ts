// The `gate` (PIP-7, AUT-3, AUT-4, AUT-9, AUT-15) and `merge` (PIP-22) stages, in code only.

import { gate } from "../autonomy.ts";
import type { Ctx, Handler } from "../handlers.ts";
import { ok, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { data, effectiveOf, gh, intentOf, prUrl, repoFiles } from "./common.ts";
import { type Checks, codeBody } from "./prtext.ts";
import { HOLD_SECS, holder } from "./ship.ts";
import { changedTests } from "./verify.ts";

export function checksLine(m: Mission): Checks {
  const d = data(m);
  return {
    verify: d.verify?.result === "green" ? "passed" : "not run",
    proof:
      d.proof === "proven"
        ? "the new tests fail without the change"
        : d.proof === "none needed"
          ? "not needed (no behaviour change)"
          : "no test fails without the change",
    ci: d.ci?.result === "none" ? "no CI on this repo" : "green",
    review: d.review
      ? d.review.approved
        ? "approved"
        : "not approved; see the Review comment"
      : "didn't finish",
  };
}

/** Write the code PR's final text (PIP-48). */
async function updateBody(cx: Ctx, m: Mission): Promise<void> {
  const repo = cx.repo(m);
  const intent = await intentOf(cx, m);
  const d = data(m);
  const body = codeBody({
    worker: d.build?.pr ?? null,
    intentTitle: intent.title,
    intentProblem: intent.sections.get("Problem") ?? null,
    checks: checksLine(m),
    unplanned: [
      ...(d.unplanned?.domains ?? []).map((x) => ({ what: `network access to ${x.domain}`, why: x.why })),
      ...(d.unplanned?.paths ?? []).map((x) => ({ what: `writing ${x.glob}`, why: x.why })),
    ],
    specIds: d.design?.specIds ?? [],
    links: {
      intentUrl: cx.store.url(intent),
      specPrUrl: m.spec_pr ? prUrl(repo.github, m.spec_pr) : null,
      planPrUrl: m.plan_pr && cx.store.github() ? prUrl(cx.store.github()!, m.plan_pr) : null,
    },
    reviewDetails: d.review?.details ?? null,
    footer: { intentUrl: cx.store.url(intent), costUsd: m.cost_usd, secs: m.agent_secs },
    issue: { url: intent.issue, repo: repo.github },
  });
  try {
    await gh(
      cx,
      repo.github,
      ["api", "-X", "PATCH", `repos/${repo.github}/pulls/${m.pr}`, "-F", "body=@-"],
      body,
    );
  } catch (e) {
    cx.log(`${m.intent}: couldn't update the PR text: ${(e as Error).message}`);
  }
}

export const gateHandler: Handler = {
  async step(cx, m) {
    // SHIP-14: one ship at a time per repo; nothing merges while another change ships or is fixed.
    const h = holder(cx, m);
    if (h) {
      cx.record(m, "hold", { why: `repo on hold: ${h.intent} is shipping` });
      return { poll: HOLD_SECS };
    }
    const intent = await intentOf(cx, m);
    const files = await repoFiles(cx, m);
    const d = data(m);
    const unplanned = (d.unplanned?.domains.length ?? 0) + (d.unplanned?.paths.length ?? 0) > 0;
    await updateBody(cx, m);
    const g = gate({
      a: effectiveOf(m, intent, files),
      cap: files.towercab.maxAutonomy,
      ciGreen: d.ci?.result === "green" || d.ci?.result === "none",
      review: d.review
        ? { approved: d.review.approved, door: d.review.door, redLines: d.review.redLines }
        : null,
      unplanned,
      proven: !d.unproven,
    });
    if (!g.merge) return { done: wait("review and merge PR", g.why) };
    // Beyond the gate table: work Towercab didn't check itself goes to the owner.
    const a = effectiveOf(m, intent, files);
    if (d.foreignHead) return { done: wait("review and merge PR", "someone else pushed commits to the PR") };
    if (d.build?.planChanged && a !== 5) {
      return { done: wait("review and merge PR", "the build departed from the approved plan") };
    }
    // SHIP-8: in a live repo a change brings an e2e test, or its plan says why it needs none.
    const live = files.towercab.live;
    if (live && !d.plan?.e2e?.none_why?.trim() && !(d.ship?.fixes ?? 0)) {
      const e2e = await changedTests(
        cx,
        m,
        live.suites.flatMap((s) => s.tests),
      );
      if (e2e.length === 0) return { done: wait("review and merge PR", "no e2e test for the change") };
    }
    return { done: ok({ set: { head: m.head } }) };
  },
  async finish() {
    return { poll: 0 };
  },
};

export const MAX_BLOCKED_READS = 3;

export const mergeHandler: Handler = {
  async step(cx, m) {
    const repo = cx.repo(m);
    const d = data(m);
    const v = JSON.parse(
      await gh(cx, repo.github, [
        "pr",
        "view",
        String(m.pr),
        "-R",
        repo.github,
        "--json",
        "headRefOid,mergeStateStatus,state,mergeCommit",
      ]),
    ) as { headRefOid: string; mergeStateStatus: string; state: string; mergeCommit: { oid: string } | null };
    if (v.state === "MERGED") {
      return {
        done: {
          event: "code_merged",
          set: { merge_sha: v.mergeCommit?.oid ?? null, merged_by: m.merged_by ?? "towercab" },
        },
      };
    }
    if (v.headRefOid !== m.head)
      return { done: { event: "head_moved", why: "the PR's head moved after the gate" } };
    switch (v.mergeStateStatus) {
      case "CLEAN":
      case "HAS_HOOKS": {
        const fresh = cx.record(m, "merging", { merged_by: "towercab" });
        const r = await cx.github.gh(repo.github, [
          "pr",
          "merge",
          String(m.pr),
          "-R",
          repo.github,
          "--squash",
          "--match-head-commit",
          m.head!,
        ]);
        if (r.code !== 0) return { done: wait("merge failed", r.stderr.trim().split("\n")[0]) };
        void fresh;
        return { poll: 1 };
      }
      case "BEHIND":
        await gh(cx, repo.github, [
          "api",
          "-X",
          "PUT",
          `repos/${repo.github}/pulls/${m.pr}/update-branch`,
          "-f",
          `expected_head_sha=${m.head}`,
        ]);
        return {
          done: {
            event: "head_moved",
            why: "updated the branch with its base",
            data: { updatedBranch: true },
          },
        };
      case "DIRTY":
        return {
          done: {
            event: "conflict",
            why: "the PR conflicts with its base",
            data: {
              repair: { what: "The PR conflicts with its base branch.", details: "", kind: "conflict" },
            },
          },
        };
      case "BLOCKED":
      case "UNSTABLE": {
        const tries = (d.mergeTries ?? 0) + 1;
        if (tries >= MAX_BLOCKED_READS)
          return {
            done: wait("review and merge PR", `GitHub says the PR is ${v.mergeStateStatus.toLowerCase()}`),
          };
        cx.record(m, m.step, {}, { mergeTries: tries });
        return { poll: cx.config.agent.ciPoll };
      }
      case "DRAFT":
        await gh(cx, repo.github, ["pr", "ready", String(m.pr), "-R", repo.github]);
        return { poll: 10 };
      default:
        return { poll: cx.config.agent.ciPoll };
    }
  },
  async finish() {
    return { poll: 0 };
  },
};
