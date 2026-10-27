// The `review` stage (PIP-4, PIP-5, PIP-49): a fresh read-only Claude session reviews the code PR
// against the intent, the plan and REVIEW.md; code decides approval; the verdict is posted.

import { gitEnv, NO_HOOKS } from "../checkout.ts";
import type { ChildEnd, Ctx, Handler, Progress } from "../handlers.ts";
import { ok } from "../machine.ts";
import type { Mission } from "../mission.ts";
import type { Review } from "../repo/files.ts";
import { check } from "../tools.ts";
import { coGit, data, ended, intentOf, note, repoFiles, spawnRun } from "./common.ts";
import { fence, intentData, render } from "./prompts.ts";
import { parseResult, type ReviewResult } from "./schemas.ts";

/** PIP-5: approved = the reviewer's yes ∧ every outcome met ∧ no weakened test ∧ plan followed ∧ no important finding. */
export function approvedOf(r: ReviewResult): boolean {
  return (
    r.approved &&
    r.outcomes.every((o) => o.met) &&
    !r.tests_weakened.value &&
    r.plan_followed.value &&
    !r.findings.some((f) => f.severity === "important")
  );
}

/** The Review comment's body: the summary, then findings (nits capped by REVIEW.md). */
export function reviewComment(r: ReviewResult, review: Review): string {
  const important = r.findings.filter((f) => f.severity === "important");
  const nits = r.findings.filter((f) => f.severity === "nit").slice(0, review.nitCap);
  const at = (f: ReviewResult["findings"][number]) => `\`${f.file}${f.line ? `:${f.line}` : ""}\``;
  const parts = [r.summary.trim()];
  if (important.length)
    parts.push(`**Needs attention**\n\n${important.map((f) => `- ${at(f)}: ${f.what}`).join("\n")}`);
  if (nits.length) parts.push(`**Smaller things**\n\n${nits.map((f) => `- ${at(f)}: ${f.what}`).join("\n")}`);
  const outcomes = r.outcomes.map((o) => `- ${o.met ? "Met" : "Not met"}: ${o.bullet} (${o.why})`).join("\n");
  if (outcomes) parts.push(`<details><summary>Outcomes</summary>\n\n${outcomes}\n\n</details>`);
  return parts.join("\n\n");
}

/** The PR diff's `git patch-id --stable` (line numbers and whitespace don't change it); "" for none. */
async function patchId(cx: Ctx, m: Mission): Promise<string> {
  const repo = cx.repo(m);
  const diff = await coGit(cx, m, ["diff", `refs/remotes/origin/${repo.base}...HEAD`]);
  if (!diff.trim()) return "";
  const r = await cx.tools.run("git", [...NO_HOOKS, "patch-id", "--stable"], {
    cwd: cx.checkout(m),
    env: gitEnv(cx.checkout(m)),
    input: diff,
  });
  return check(r, "git patch-id").trim().split(/\s+/)[0] ?? "";
}

export const reviewHandler: Handler = {
  async step(cx, m) {
    const d = data(m);
    const pid = await patchId(cx, m);
    if (d.review && d.review.patchId === pid)
      return { done: ok({ why: "the diff is unchanged: the review stands" }) };
    const intent = await intentOf(cx, m);
    const files = await repoFiles(cx, m);
    const repo = cx.repo(m);
    const plan = (await cx.store.readFile(`${intent.dir}/plan.md`)) ?? d.plan?.md ?? "(no plan)";
    const shots = d.shots?.length
      ? `Screenshots of the UI after the change (read them with the Read tool):\n${d.shots.map((s) => `- ${s}`).join("\n")}`
      : "";
    const prompt = render("review", {
      intent: intentData(intent.text),
      spec_ids: d.design?.specIds.join(", ") || "none",
      plan: fence(plan, "plan"),
      review_md: fence(
        files.review.text || "(no REVIEW.md: use the default passes Bugs, Security, Compliance)",
        "review_md",
      ),
      ci: d.ci?.result === "none" ? "no CI on this repo" : "green",
      screenshots: shots,
      diff_cmd: `git diff refs/remotes/origin/${repo.base}...HEAD`,
    });
    // A run cut off by a crash runs again as the same round, so its comment is edited, not added.
    const at = m.step === "review" ? m : cx.record(m, "pending", {}, { review: null });
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
    const approved = approvedOf(v);
    const body = reviewComment(v, files.review);
    const round = data(m).n?.review ?? 1;
    await note(cx, m, "Review", round, body);
    return {
      done: ok({
        data: {
          review: {
            approved,
            door: v.door,
            redLines: v.red_lines.length > 0,
            summary: v.summary,
            details: body,
            patchId: await patchId(cx, m),
          },
        },
      }),
    };
  },
};
