// A repo that needs a teammate's review (PIP-142..146): the spec and code PRs wait for a listed
// reviewer at autonomy 5, the owner's Approve neither merges nor counts, and a review that didn't
// approve goes to the owner first, who passes it on with `/pass`.

import { expect, test } from "vitest";
import { build, CODE, happy, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { type FakePr, Pipe } from "../helpers/pipe.ts";

/** A world whose repo needs teammate review: alice and bob are listed. */
function teamWorld(a = 5): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a })));
  happy(p);
  p.db.run(
    "INSERT INTO repos (name, github, base, source, added, teammate_review, reviewers) VALUES ('web', 'owner/web', 'main', 'cli', 0, 1, 'alice,bob')",
  );
  return p;
}

/** A reviewer approves the PR's current head. */
function approve(p: Pipe, pr: FakePr, who = "alice", body = ""): void {
  pr.reviews.push({ author: who, state: "APPROVED", body, at: p.at(), commit: p.headSha(pr.repo, pr.head) });
}

const requests = (p: Pipe, repo: string, n: number) =>
  p.tools.lines("gh").filter((l) => l.includes(`repos/${repo}/pulls/${n}/requested_reviewers`));

const said = (pr: FakePr) => pr.comments.map((c) => c.body);

test("pipeline: gate waits for a teammate approval at a4 and a5", async () => {
  const p = teamWorld(5);
  await p.start();
  // The spec PR waits for a teammate first: at a5 Towercab would have merged it itself.
  const spec = await p.untilStage("approval:spec");
  expect(spec.waiting, p.moves()).toBe("teammate review of spec");
  expect(spec.why).toBe("Waiting for teammate review from alice, bob.");
  const specPr = p.prNo("web", spec.spec_pr!);
  expect(specPr.state).toBe("OPEN");
  expect(requests(p, "owner/web", specPr.number)).toHaveLength(2);
  // The owner's own Approve does nothing: the plan and the code stay as they are.
  p.ownerReview(specPr, "APPROVED", "");
  await p.until(() => said(specPr).some((c) => c.includes("towercab:approve:")), 3);
  expect(p.mission()!.waiting).toBe("teammate review of spec");
  expect(specPr.state).toBe("OPEN");
  // A listed reviewer's approval, with text, lets the spec through.
  approve(p, specPr, "alice", "Spec reads fine.");
  const code = await p.untilStage("approval:merge");
  expect(code.waiting, p.moves()).toBe("teammate review");
  expect(code.why).toBe("Waiting for teammate review from alice, bob.");
  expect(said(specPr)).toContain("alice approved: Spec reads fine.");
  // PIP-144: a plan PR in the owner's intents repo does not wait for a teammate.
  const plans = p.prs.filter((x) => x.repo === "owner/intents");
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) {
    expect(plan.state).toBe("MERGED");
    expect(requests(p, "owner/intents", plan.number)).toHaveLength(0);
  }
  // PIP-143: each listed reviewer was asked once, for this head.
  const codePr = p.prNo("web", code.pr!);
  const asked = requests(p, "owner/web", codePr.number);
  expect(asked.map((l) => l.split(" ").at(-1))).toEqual(["reviewers[]=alice", "reviewers[]=bob"]);
  // PIP-146: the owner is assigned to the spec and code PRs, never to a plan PR.
  const edits = p.tools.lines("gh").filter((l) => l.includes("--add-assignee"));
  expect(edits).toContain(`pr edit ${specPr.number} -R owner/web --add-assignee owner`);
  expect(edits).toContain(`pr edit ${codePr.number} -R owner/web --add-assignee owner`);
  expect(edits.some((l) => l.includes("owner/intents"))).toBe(false);
  // The owner's Approve neither merges nor counts: one reply, and the PR stays open.
  p.ownerReview(codePr, "APPROVED", "");
  await p.until(() => said(codePr).some((c) => c.includes("towercab:approve:")), 3);
  expect(said(codePr).filter((c) => c.includes("Towercab is waiting for your teammates")).length).toBe(1);
  expect(p.mission()!.waiting).toBe("teammate review");
  expect(codePr.state).toBe("OPEN");
  await p.until(() => false, 3);
  expect(said(codePr).filter((c) => c.includes("towercab:approve:")).length).toBe(1);
  // A listed reviewer approves: at a5 Towercab merges, on the head the approval is for.
  approve(p, codePr, "alice", "Ship it.");
  await p.until(() => codePr.state === "MERGED");
  expect(codePr.state, p.moves()).toBe("MERGED");
  expect(p.mission()!.merged_by).toBe("towercab");
  expect(said(codePr)).toContain("alice approved: Ship it.");
  expect(requests(p, "owner/web", codePr.number)).toHaveLength(2);
}, 90_000);

test("pipeline: an unapproved review goes to the owner before the teammates, who are asked once it is passed on", async () => {
  const NOT_YET = { ...REVIEW, approved: false, summary: "Not yet." };
  const p = teamWorld(5);
  p.queue("review", reply(NOT_YET), reply(NOT_YET), reply(NOT_YET));
  p.queue(
    "worker",
    reply(build(), CODE),
    reply(build(), { "greeting.txt": "hello.\n" }),
    reply(build(), { "greeting.txt": "hello!\n" }),
  );
  await p.start();
  const spec = await p.untilStage("approval:spec");
  approve(p, p.prNo("web", spec.spec_pr!));
  const m = await p.untilStage("approval:merge");
  // The owner looks first: no teammate has been asked, and the card offers to pass it on.
  expect([m.waiting, m.why], p.moves()).toEqual([
    "review and merge PR",
    "The independent code review didn't approve it. Look at it, then reply `/pass` (or press Pass on to teammates) to ask your teammates.",
  ]);
  expect(JSON.parse(m.data).teammate.passNeeded).toBe(true);
  const codePr = p.prNo("web", m.pr!);
  expect(requests(p, "owner/web", codePr.number)).toHaveLength(0);

  // The owner passes it on: `/pass` asks the teammates and the wait names them.
  p.ownerComment(codePr, "/pass");
  const next = await p.until(() => p.mission()!.waiting === "teammate review");
  expect(next, p.moves()).toBeGreaterThan(0);
  expect(p.mission()!.why).toBe("Waiting for teammate review from alice, bob.");
  expect(requests(p, "owner/web", codePr.number)).toHaveLength(2);
  expect(JSON.parse(p.mission()!.data).teammate.passNeeded).toBe(false);

  // Teammates approve; the review still didn't, so the owner merges: the gate's own table applies.
  approve(p, codePr, "bob");
  await p.until(() => p.mission()!.waiting === "review and merge PR");
  expect(p.mission()!.why).toBe("The independent code review didn't approve it, even after fix rounds.");
  expect(codePr.state).toBe("OPEN");
}, 90_000);

test("pipeline: the owner merges at a3 once the teammates approved", async () => {
  const p = teamWorld(3);
  await p.start();
  const spec = await p.untilStage("approval:spec");
  expect(spec.waiting, p.moves()).toBe("teammate review of spec");
  approve(p, p.prNo("web", spec.spec_pr!));
  // At a3 the owner merges the plan PR too: their Approve there is the usual one.
  const plan = await p.untilStage("approval:plan");
  p.ownerReview(p.prNo("intents", plan.plan_pr!), "APPROVED", "");
  const code = await p.untilStage("approval:merge");
  expect(code.waiting, p.moves()).toBe("teammate review");
  const codePr = p.prNo("web", code.pr!);
  // Before the teammates approve nothing is for the owner to merge.
  expect(requests(p, "owner/web", codePr.number)).toHaveLength(2);
  approve(p, codePr, "bob");
  await p.until(() => p.mission()!.waiting === "review and merge PR");
  expect(p.mission()!.why, p.moves()).toBe("At autonomy a3 you merge every change yourself.");
  expect(codePr.state).toBe("OPEN");
}, 90_000);
