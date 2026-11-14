// The `gate` (PIP-7, AUT-3, AUT-4, AUT-15, AUT-18) and `merge` (PIP-22) stages, in code only.

import { gate } from "../autonomy.ts";
import { MERGE_METHOD } from "../forge.ts";
import { conflictOutcome } from "../github/events.ts";
import type { Ctx, Handler } from "../handlers.ts";
import { ok, wait } from "../machine.ts";
import { getMission, type Mission } from "../mission.ts";
import { type Risk, riskMd } from "../risk.ts";
import { PASS_ON_WHY } from "../teammates.ts";
import { testGrantsOf } from "./access.ts";
import { data, effectiveOf, gateLevelOf, intentOf, mustForge, prUrl, repoFiles, viaForge } from "./common.ts";
import { type Checks, codeBody } from "./prtext.ts";
import { HOLD_SECS, holder } from "./ship.ts";
import { stepsBeforeMerge } from "./steps.ts";
import { teammateStep } from "./teammate.ts";
import { changedTests } from "./verify.ts";

/** PIP-110: why the PR waits for the owner beyond the gate table, in plain sentences. */
export const GATE_HOLD = {
  foreign: "Someone else added commits to the PR, so Towercab won't merge it on its own.",
  planChanged: "The build changed course from the plan you approved.",
  noE2e: "The change has no test that runs against the live app.",
} as const;

/**
 * PIP-110: why GitHub won't merge the PR, from its `mergeStateStatus`, as what the owner can do about
 * it. Any state not listed gets a general line that still names it.
 */
export function mergeStateWhy(status: string): string {
  switch (status.toUpperCase()) {
    case "BLOCKED":
      return "GitHub won't merge it yet: a required check or review is missing. Check the PR's merge box on GitHub, then merge it yourself.";
    case "UNSTABLE":
      return "GitHub won't merge it yet: some checks fail or haven't finished. Look at the failing checks, then merge it or comment what to fix.";
    case "BEHIND":
      return "The PR is behind its base branch. Update the branch on GitHub, then merge it.";
    case "DIRTY":
      return "The PR clashes with changes on its base branch. Resolve the clash on GitHub, or comment so Towercab fixes it.";
    case "DRAFT":
      return "The PR is still a draft. Mark it ready for review on GitHub, then merge it.";
    default:
      return `GitHub won't merge it yet (it says "${status.toLowerCase()}"). Check the PR's merge box on GitHub, then merge it yourself.`;
  }
}

/** The code's risk (AUT-16) when it is of the reviewed diff; null when none finished for it. */
export function codeRisk(m: Mission): Risk | null {
  const d = data(m);
  if (!d.review || d.riskOf?.code !== d.review.patchId) return null;
  return d.risk?.code ?? null;
}

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
    brief: d.build?.brief ?? "",
    intentTitle: intent.title,
    intentProblem: intent.sections.get("Problem") ?? null,
    checks: checksLine(m),
    unplanned: [
      ...(d.unplanned?.domains ?? []).map((x) => ({ what: `network access to ${x.domain}`, why: x.why })),
      ...(d.unplanned?.paths ?? []).map((x) => ({ what: `writing ${x.glob}`, why: x.why })),
    ],
    tests: testGrantsOf(d),
    specIds: d.design?.specIds ?? [],
    links: {
      intentUrl: cx.store.url(intent),
      specPrUrl: m.spec_pr ? prUrl(repo.github, m.spec_pr) : null,
      planPrUrl: m.plan_pr && cx.store.github() ? prUrl(cx.store.github()!, m.plan_pr) : null,
    },
    reviewDetails: d.review?.details ?? null,
    ownerSteps: d.ownerSteps,
    deferred: d.deferred,
    risk: d.review ? riskMd(codeRisk(m)) : "",
    footer: { intentUrl: cx.store.url(intent), costUsd: m.cost_usd, secs: m.agent_secs },
    issue: { url: intent.issue, repo: repo.github },
  });
  try {
    await viaForge(cx.github.updatePrBody(repo.github, m.pr!, body));
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
    // SHIP-18: steps only the owner can do before the merge hold it, whatever the autonomy.
    const held = await stepsBeforeMerge(cx, m);
    m = held.m;
    if (held.why) return { done: wait("your steps first", held.why) };
    const intent = await intentOf(cx, m);
    const files = await repoFiles(cx, m);
    const d = data(m);
    const unplanned = (d.unplanned?.domains.length ?? 0) + (d.unplanned?.paths.length ?? 0) > 0;
    await updateBody(cx, m);
    // PIP-143, PIP-144: where a teammate's review is needed it comes right after CI and the review, at
    // every autonomy level. A review that didn't approve goes to the owner first, who passes it on.
    if (cx.repo(m).teammateReview && (d.ci?.result === "green" || d.ci?.result === "none") && d.review) {
      if (!d.review.approved && d.teammate?.passedOn !== m.head) {
        return {
          done: wait("review and merge PR", PASS_ON_WHY, {
            data: { teammate: { ...d.teammate, passNeeded: true } },
          }),
        };
      }
      const t = await teammateStep(cx, m, "code");
      if (t) return t;
      m = getMission(cx.db, m.id) ?? m;
    }
    // The teammate check above runs only once CI is green and a review is in; any other hold for the owner
    // leaves the approval unchecked, which the owner's merge then checks itself (PIP-144).
    const skipped = Boolean(
      cx.repo(m).teammateReview && !((d.ci?.result === "green" || d.ci?.result === "none") && d.review),
    );
    const teammate = cx.repo(m).teammateReview
      ? { data: { teammate: { ...data(m).teammate, unchecked: skipped } } }
      : {};
    const g = gate({
      a: gateLevelOf(cx, m, intent, files),
      accessA: effectiveOf(m, intent, files),
      ciGreen: d.ci?.result === "green" || d.ci?.result === "none",
      review: d.review ? { approved: d.review.approved } : null,
      unplanned,
      proven: !d.unproven,
      risk: codeRisk(m)?.level ?? null,
    });
    // PIP-119: the owner's steps are shown on the wait; they never make the gate wait by themselves.
    const steps = d.ownerSteps?.length
      ? ` For you to do: ${d.ownerSteps.map((s) => s.bullet).join("; ")}.`
      : "";
    if (!g.merge) return { done: wait("review and merge PR", g.why + steps, teammate) };
    // Beyond the gate table: work Towercab didn't check itself goes to the owner.
    const a = effectiveOf(m, intent, files);
    if (d.foreignHead) return { done: wait("review and merge PR", GATE_HOLD.foreign, teammate) };
    if (d.build?.planChanged && a !== 5) {
      return { done: wait("review and merge PR", GATE_HOLD.planChanged, teammate) };
    }
    // SHIP-8: in a live repo a change brings an e2e test, or its plan says why it needs none.
    const live = files.towercab.live;
    if (live && !d.plan?.e2e?.none_why?.trim() && !(d.ship?.fixes ?? 0)) {
      const e2e = await changedTests(
        cx,
        m,
        live.suites.flatMap((s) => s.tests),
      );
      if (e2e.length === 0) return { done: wait("review and merge PR", GATE_HOLD.noE2e, teammate) };
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
    // INT-44: never merge only the lead of a multi-repo intent (LOOP-78 is not built yet); this also stops
    // an intent that gained `repos:` after its build began.
    if (((await intentOf(cx, m)).repos ?? []).length > 0) {
      return { done: wait("several repos", "The intent lists other repos in `repos:`.") };
    }
    const repo = cx.repo(m);
    const d = data(m);
    const v = await viaForge(cx.github.mergeStatus(repo.github, m.pr!));
    if (v.state === "MERGED") {
      return {
        done: {
          event: "code_merged",
          set: { merge_sha: v.mergeCommit, merged_by: m.merged_by ?? "towercab" },
        },
      };
    }
    if (v.head !== m.head)
      return { done: { event: "head_moved", why: "the PR's head moved after the gate" } };
    // PIP-144: Towercab re-checks the teammate approval on the head it merges.
    if (v.mergeState === "CLEAN" || v.mergeState === "HAS_HOOKS") {
      const t = await teammateStep(cx, m, "code");
      if (t) return t;
    }
    switch (v.mergeState) {
      case "CLEAN":
      case "HAS_HOOKS": {
        const fresh = cx.record(m, "merging", { merged_by: "towercab" });
        const r = await cx.github.mergePr(repo.github, m.pr!, { method: MERGE_METHOD, head: m.head! });
        if (!r.ok) return { done: wait("merge failed", r.reason.split("\n")[0]) };
        void fresh;
        return { poll: 1 };
      }
      case "BEHIND":
        await viaForge(cx.github.updateBranch(repo.github, m.pr!, m.head!));
        return {
          done: {
            event: "head_moved",
            why: "updated the branch with its base",
            data: { updatedBranch: true },
          },
        };
      case "DIRTY":
        return { done: conflictOutcome(m) };
      case "BLOCKED":
      case "UNSTABLE": {
        const tries = (d.mergeTries ?? 0) + 1;
        if (tries >= MAX_BLOCKED_READS)
          return {
            done: wait("review and merge PR", mergeStateWhy(v.mergeState)),
          };
        cx.record(m, m.step, {}, { mergeTries: tries });
        return { poll: cx.config.agent.ciPoll };
      }
      case "DRAFT":
        mustForge(await cx.github.markReady(repo.github, m.pr!), "gh pr ready");
        return { poll: 10 };
      default:
        return { poll: cx.config.agent.ciPoll };
    }
  },
  async finish() {
    return { poll: 0 };
  },
};
