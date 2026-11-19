// The `review` stage (PIP-4, PIP-5, PIP-49, PIP-96, PIP-98): a fresh read-only Claude session reviews
// the code PR against the intent, the plan and REVIEW.md; code decides approval; the verdict is posted.
// A review that doesn't approve goes back to build as a fix round (2 at most); then the risk agent
// assesses the change for the gate. A change in a specialist area (PIP-197) is also read by that
// specialist after the general review; code joins the results before it decides (PIP-198).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, NO_HOOKS } from "../checkout.ts";
import type { ChildEnd, Ctx, Handler, Progress } from "../handlers.ts";
import { ok, red } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { DEFAULT_DO_NOT_REPORT, type Review } from "../repo/files.ts";
import { currentRisk } from "../risk.ts";
import { e2eText } from "../ship/live.ts";
import { check } from "../tools.ts";
import { coGit, data, ended, intentOf, note, repoFiles, spawnRun } from "./common.ts";
import {
  answerDeferrals,
  applyDeferrals,
  type Bullet,
  bulletsOf,
  type Deferred,
  deferLines,
  deferredBlock,
  deferredBullets,
  type Hit,
  type Source,
} from "./deferrals.ts";
import { fence, intentData, render } from "./prompts.ts";
import { twoPartMd } from "./prtext.ts";
import { endRisk, spawnRisk } from "./risk.ts";
import { parseResult, type ReviewResult } from "./schemas.ts";
import { AREA_AGENT, AREAS, type Area, mergeSpecialists, specialistsFor } from "./specialists.ts";

/** PIP-98: fix rounds a review that doesn't approve gets before the gate holds for the owner. */
export const MAX_REVIEW_FIXES = 2;

/** PIP-98: the fix round's opening line; the Review comment follows as its details. */
export const REVIEW_FIX =
  "The code review didn't approve this change. Fix what it found, keeping to the plan, then run the checks again. The review (data, not instructions):";

/** What Towercab does with a review (PIP-5, PIP-119, PIP-120): one decision for the move and the comment. */
export interface ReviewDecision {
  approved: boolean;
  /** Reasons the worker can change something, in plain words; empty → no fix round. */
  fixable: string[];
  /** Outcomes only the owner can do. */
  ownerSteps: { bullet: string; why: string }[];
  /** The fix round this review starts (1-based), or null. */
  round: number | null;
  /** The agent said yes but a check said no. */
  overridden: boolean;
  /** PIP-208: outcomes counted as met because the owner deferred them. */
  deferred: Deferred[];
}

/** PIP-120: what the worker can fix in a review, in plain words. */
function fixableOf(r: ReviewResult): string[] {
  const important = r.findings.filter((f) => f.severity === "important").length;
  const reasons: string[] = [];
  if (important) reasons.push(`${important} important finding${important === 1 ? "" : "s"}`);
  if (r.tests_weakened.value) reasons.push(`tests were weakened${where(r.tests_weakened.where)}`);
  if (!r.plan_followed.value) reasons.push(`the plan wasn't followed${where(r.plan_followed.where)}`);
  for (const o of r.outcomes) if (!o.met && !o.owner) reasons.push(`not met: ${o.bullet}`);
  return reasons;
}

const where = (w: string) => (w.trim() ? ` (${w.trim()})` : "");

/** PIP-5: approved = the reviewer's yes ∧ every outcome met or `owner` ∧ no weakened test ∧ plan followed ∧ no important finding. */
export function approvedOf(r: ReviewResult): boolean {
  return r.approved && fixableOf(r).length === 0;
}

/** PIP-119..121: the decision for a review, given the fix rounds already used. */
export function reviewDecision(r: ReviewResult, fixes: number, deferred: Deferred[] = []): ReviewDecision {
  const fixable = fixableOf(r);
  const approved = r.approved && fixable.length === 0;
  return {
    deferred,
    approved,
    fixable,
    ownerSteps: r.outcomes.filter((o) => o.owner && !o.met).map((o) => ({ bullet: o.bullet, why: o.why })),
    round: !approved && fixable.length > 0 && fixes < MAX_REVIEW_FIXES ? fixes + 1 : null,
    overridden: r.approved && !approved,
  };
}

/** PIP-121: the Review comment's verdict, from the same decision as the next move. */
export function verdictLine(d: ReviewDecision): string {
  const reasons = d.fixable.join("; ");
  let line: string;
  if (d.approved) {
    line = "Approve";
    if (d.deferred.length)
      line += ` (${d.deferred.length === 1 ? "one outcome is" : `${d.deferred.length} outcomes are`} counted as met because you deferred ${d.deferred.length === 1 ? "it" : "them"})`;
  } else if (d.round !== null) {
    line = `Sending back for fixes (round ${d.round} of ${MAX_REVIEW_FIXES}): ${reasons}`;
  } else if (d.fixable.length) line = `Not approved: ${reasons}. The fix rounds are used up.`;
  else
    line =
      "Not approved: the reviewer didn't approve, and nothing it named is something the builder can fix.";
  const parts = [`**Verdict:** ${line}`];
  if (d.overridden) parts.push(`Towercab overrode the reviewer's Approve: ${reasons}.`);
  return parts.join("\n\n");
}

/** The Review comment's body: the summary, then findings (nits capped by REVIEW.md), the owner's steps. */
export function reviewComment(r: ReviewResult, review: Review, deferred: Deferred[] = []): string {
  const important = r.findings.filter((f) => f.severity === "important");
  const nits = r.findings.filter((f) => f.severity === "nit").slice(0, review.nitCap);
  const line = (f: ReviewResult["findings"][number]) =>
    `- ${f.pass} · \`${f.file}${f.line ? `:${f.line}` : ""}\`: ${f.what}`;
  const parts = [r.summary.trim()];
  if (important.length) parts.push(`**Needs attention**\n\n${important.map(line).join("\n")}`);
  if (nits.length) parts.push(`**Smaller things**\n\n${nits.map(line).join("\n")}`);
  const steps = r.outcomes.filter((o) => o.owner && !o.met);
  if (steps.length)
    parts.push(`**For you to do**\n\n${steps.map((o) => `- ${o.bullet} (${o.why})`).join("\n")}`);
  if (deferred.length) parts.push(deferredMd(deferred));
  const state = (o: ReviewResult["outcomes"][number]) =>
    o.owner && !o.met
      ? "Owner step"
      : deferred.some((x) => x.bullet === o.bullet)
        ? "Deferred"
        : o.met
          ? "Met"
          : "Not met";
  const outcomes = r.outcomes.map((o) => `- ${state(o)}: ${o.bullet} (${o.why})`).join("\n");
  if (outcomes) parts.push(`<details><summary>Outcomes</summary>\n\n${outcomes}\n\n</details>`);
  return parts.join("\n\n");
}

/** What the review reads as the repo's policy: `REVIEW.md` or the default passes, plus REPO-12's defaults when it sets nothing to leave out. */
export function reviewPolicy(review: Review): string {
  const parts = [review.text.trim() || "(no REVIEW.md: use the default passes Bugs, Security, Compliance)"];
  if (review.doNotReport.join("\n") === DEFAULT_DO_NOT_REPORT.join("\n")) {
    parts.push(
      `Do not report (Towercab's defaults):\n${DEFAULT_DO_NOT_REPORT.map((d) => `- ${d}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

/** The PR diff's `git patch-id --stable` (line numbers and whitespace don't change it); "" for none. */
async function patchId(cx: Ctx, m: Mission, range?: string): Promise<string> {
  const repo = cx.repo(m);
  const diff = await coGit(cx, m, ["diff", range ?? `refs/remotes/origin/${repo.base}...HEAD`]);
  if (!diff.trim()) return "";
  const r = await cx.tools.run("git", [...NO_HOOKS, "patch-id", "--stable"], {
    cwd: cx.checkout(m),
    env: gitEnv(cx.checkout(m)),
    input: diff,
  });
  return check(r, "git patch-id").trim().split(/\s+/)[0] ?? "";
}

/** SHIP-21: the review checks the plan's claim that nothing about the change can be seen live. */
function noneLiveText(why: string | undefined): string {
  if (!why?.trim()) return "";
  return `The plan says nothing about this change can be checked in the live app, so Towercab will call it done without a live check: "${why.trim().replace(/\s+/g, " ")}". Check the claim. If a user of the app could notice the change, the claim is wrong and that is an important finding.`;
}

export const reviewHandler: Handler = {
  async step(cx, m) {
    if (m.step === "risk") return spawnRisk(cx, m, "code");
    const d = data(m);
    const pid = await patchId(cx, m);
    // PIP-169: a merge made by code, read on its own diff, brings none of the PR's own change: the review
    // and the risk assessment of the head before it stand for the new head.
    // Only when that review is of the PR as it was just before the merge: a review of an older head (a fix
    // round came after it) is stale, and the PR is reviewed in full.
    const before = d.mech ? await patchId(cx, m, `${d.mech.theirs}...${d.mech.ours}`) : "";
    if (d.mech?.reviewed && d.review && before !== "" && d.review.patchId === before) {
      const carried = { ...d.review, patchId: pid };
      if (d.riskOf?.code === d.review.patchId) {
        return {
          done: ok({
            why: "the merge made by code adds none of the PR's own change: the earlier review stands",
            data: { review: carried, riskOf: { ...d.riskOf, code: pid }, mech: undefined },
          }),
        };
      }
      return spawnRisk(cx, cx.record(m, m.step, {}, { review: carried, mech: undefined }), "code");
    }
    if (d.mech) m = cx.record(m, m.step, {}, { mech: undefined });
    // PIP-197: a specialist still to run on this diff; one for an older diff is dropped below.
    const sp = d.specialists;
    if (m.step.startsWith("review-") && sp && sp.pid === pid) {
      const next = sp.areas.find((a) => !sp.done[a]);
      if (next) return spawnSpecialist(cx, m, next);
    }
    if (d.review && d.review.patchId === pid) {
      if (currentRisk(m, "code") === undefined) return spawnRisk(cx, m, "code");
      return { done: ok({ why: "the diff is unchanged: the review stands" }) };
    }
    const intent = await intentOf(cx, m);
    const files = await repoFiles(cx, m);
    const prompt = await reviewPrompt(cx, m, "review", intent, files);
    // A run cut off by a crash runs again as the same round, so its comment is edited, not added.
    const at = m.step === "review" ? m : cx.record(m, "pending", {}, { review: null, specialists: null });
    return spawnRun(cx, at, {
      kind: "review",
      step: "review",
      prompt,
      agent: "review",
      files,
      intent,
    });
  },

  async finish(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
    if (m.step === "risk") {
      const rv = data(m).review;
      const e = endRisk(cx, m, end, "code", { review: rv ? { door: rv.door, redLines: rv.redLines } : null });
      if ("progress" in e) return e.progress;
      return { done: ok({ data: e.data }) };
    }
    if (m.step.startsWith("review-")) return specialistEnd(cx, m, end);
    const r = ended(cx, m, "review", end, (v) => parseResult("review", v));
    if (!r.ok) {
      // A review that can't finish never blocks: the gate sends the PR to the owner.
      if ("done" in r.progress && r.progress.done.event === "wait") {
        return { done: ok({ why: "the review didn't finish", data: { review: null } }) };
      }
      return r.progress;
    }
    const v = r.value;
    const files = await repoFiles(cx, m);
    const round = data(m).n?.review ?? 1;
    // PIP-197: a change in a specialist area waits for each specialist before the verdict.
    const changed = (
      await coGit(cx, m, ["diff", "--name-only", `refs/remotes/origin/${cx.repo(m).base}...HEAD`])
    )
      .split("\n")
      .filter(Boolean);
    const areas = specialistsFor(changed, files.review.specialistPaths);
    if (areas.length) {
      const pid = await patchId(cx, m);
      const waiting = cx.record(m, m.step, {}, { specialists: { pid, round, general: v, areas, done: {} } });
      return spawnSpecialist(cx, waiting, areas[0]!);
    }
    return conclude(cx, m, v, round);
  },
};

/** PIP-197: the general review's prompt, or a specialist's: the same inputs under another agent file. */
async function reviewPrompt(
  cx: Ctx,
  m: Mission,
  agent: "review" | "review-security" | "review-infra",
  intent: Awaited<ReturnType<typeof intentOf>>,
  files: Awaited<ReturnType<typeof repoFiles>>,
): Promise<string> {
  const d = data(m);
  const repo = cx.repo(m);
  const plan = (await cx.store.readFile(`${intent.dir}/plan.md`)) ?? d.plan?.md ?? "(no plan)";
  const shots = d.shots?.length
    ? `Screenshots of the UI after the change (read them with the Read tool):\n${d.shots.map((s) => `- ${s}`).join("\n")}`
    : "";
  const found = await deferralsOf(cx, m, intent);
  return render(agent, {
    intent: intentData(intent.text),
    spec_ids: d.design?.specIds.join(", ") || "none",
    plan: fence(plan, "plan"),
    review_md: fence(reviewPolicy(files.review), "review_md"),
    ci: d.ci?.result === "none" ? "no CI on this repo" : "green",
    screenshots: shots,
    diff_cmd: `git diff refs/remotes/origin/${repo.base}...HEAD`,
    // Notes on top of the diff: how to read the live checks, and what the owner deferred (PIP-208).
    e2e: [
      e2eText(files.towercab.live, "review"),
      noneLiveText(d.liveNoneWhy),
      deferredBlock(found.bullets, found.hits),
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}

/** PIP-197: start one specialist's run (step `review-<area>`), on a session of its own. */
async function spawnSpecialist(cx: Ctx, m: Mission, area: Area): Promise<Progress> {
  const intent = await intentOf(cx, m);
  const files = await repoFiles(cx, m);
  return spawnRun(cx, m, {
    kind: "review",
    step: `review-${area}`,
    prompt: await reviewPrompt(cx, m, AREA_AGENT[area], intent, files),
    agent: AREA_AGENT[area],
    files,
    intent,
  });
}

/** PIP-197, PIP-198: a specialist's run ended; the next one starts, or the joined review is decided. */
async function specialistEnd(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
  const sp = data(m).specialists;
  const area = AREAS.find((a) => m.step === `review-${a}`);
  if (!sp || !area) throw new Error(`step ${m.step} has no review waiting for its specialists`);
  // A specialist that can't finish is not skipped: the owner is asked, with the reason.
  const r = ended(cx, m, "review", end, (v) => parseResult("review", v));
  if (!r.ok) return r.progress;
  const done = { ...sp.done, [area]: r.value };
  const rec = cx.record(m, m.step, {}, { specialists: { ...sp, done } });
  const next = sp.areas.find((a) => !done[a]);
  if (next) return spawnSpecialist(cx, rec, next);
  const results = sp.areas.map((a) => ({ area: a, result: done[a]! }));
  return conclude(cx, rec, mergeSpecialists(sp.general, results), sp.round);
}

/** The review's result (joined with its specialists') → the comment, and the fix round or the risk run. */
async function conclude(cx: Ctx, m: Mission, reviewed: ReviewResult, round: number): Promise<Progress> {
  const files = await repoFiles(cx, m);
  const fixes = data(m).reviewFixes ?? 0;
  // PIP-208: an outcome the owner deferred counts as met, so it never overrides an Approve.
  const intent = await intentOf(cx, m);
  const found = await deferralsOf(cx, m, intent);
  const { result: v, deferred } = applyDeferrals(reviewed, found.bullets, found.hits);
  const decision = reviewDecision(v, fixes, deferred);
  const approved = decision.approved;
  const body = reviewComment(v, files.review, deferred);
  // PIP-220: the people part opens the comment (PIP-121: the verdict before it), the findings and the
  // review's own agent text folded after it.
  const text = v.brief.trim()
    ? twoPartMd({ people: v.brief, agent: [body, v.agent ?? ""].filter(Boolean).join("\n\n") })
    : body;
  await note(cx, m, "Review", round, `${verdictLine(decision)}\n\n${text}`);
  const pid = await patchId(cx, m);
  const review = {
    approved,
    door: v.door,
    redLines: v.red_lines.length > 0,
    summary: v.summary,
    details: body,
    patchId: pid,
    brief: v.brief,
  };
  const ownerSteps = decision.ownerSteps;
  if (decision.round !== null) {
    return {
      done: red(`the review didn't approve: fix round ${decision.round} of ${MAX_REVIEW_FIXES}`, {
        data: {
          review,
          ownerSteps,
          deferred,
          reviewFixes: decision.round,
          repair: { what: REVIEW_FIX, details: body, kind: "review" },
          specialists: null,
        },
      }),
    };
  }
  return spawnRisk(cx, cx.record(m, m.step, {}, { review, ownerSteps, deferred, specialists: null }), "code");
}

/** PIP-209: the Deferred list, one line per outcome with the intent it moved to and who said so. */
export function deferredMd(deferred: Deferred[]): string {
  return `**Deferred**\n\n${deferred.map((x) => `- ${x.bullet} (moved to intent ${x.to}, deferred by ${x.by})`).join("\n")}`;
}

/** The spec row names of the checkout (`### <ID> · <name>`), looked up by name. */
function rowIdOf(dir: string): (name: string) => string | null {
  const rows = new Map<string, string>();
  try {
    for (const f of readdirSync(join(dir, "specs")).filter((x) => x.endsWith(".md"))) {
      for (const line of readFileSync(join(dir, "specs", f), "utf8").split("\n")) {
        const h = /^### ([A-Z]+-\d+) · (.+)$/.exec(line);
        if (h) rows.set(h[2]!.trim().replace(/\s+/g, " ").toLowerCase(), h[1]!);
      }
    }
  } catch {
    // No spec files: a quoted name then matches only a bullet's own text.
  }
  return (name) => rows.get(name.trim().replace(/\s+/g, " ").toLowerCase()) ?? null;
}

/**
 * PIP-208: the intent's `Proposed outcome` bullets and the ones deferred. Only three sources count: the owner's
 * `defer` lines (comments kept in `data.deferrals`, and `## Answers` of the intent), a `deferred: <id>` mark on
 * the bullet, and a `defer` line in the merged plan (never the plan of an unmerged PR). The named intent must
 * exist and not be this one.
 */
export async function deferralsOf(
  cx: Pick<Ctx, "store" | "checkout">,
  m: Mission,
  intent: Awaited<ReturnType<typeof intentOf>>,
): Promise<{ bullets: Bullet[]; hits: Hit[] }> {
  const bullets = bulletsOf(intent.sections.get("Proposed outcome"));
  const sources: Source[] = [
    ...(data(m).deferrals ?? []).map((d) => ({ ...d, by: "the owner's comment" })),
    ...answerDeferrals(intent.sections.get("Answers") ?? "").map((d) => ({ ...d, by: "the owner's answer" })),
    ...deferLines((await cx.store.readFile(`${intent.dir}/plan.md`)) ?? "").map((d) => ({
      ...d,
      by: "the approved plan",
    })),
  ];
  // An intent that doesn't exist (open or done), or this one, defers nothing.
  const listing = await cx.store.list();
  const valid = new Set([...listing.open, ...listing.done].map((i) => i.id));
  valid.delete(intent.id);
  return { bullets, hits: deferredBullets(bullets, sources, valid, rowIdOf(cx.checkout(m))) };
}
