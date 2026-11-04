// Owner steps and honest verdicts (PIP-119..121): an outcome only the owner can do never blocks
// approval or starts a fix round, and the Review comment says what Towercab does next.

import { expect, test } from "vitest";
import { approvedOf, reviewComment, reviewDecision, verdictLine } from "../../src/pipeline/review.ts";
import type { ReviewResult } from "../../src/pipeline/schemas.ts";
import { defaultReview } from "../../src/repo/files.ts";
import { build, CODE, happy, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const R = REVIEW as ReviewResult;
const MET = { bullet: "The page says hello", met: true, owner: false, why: "greeting.txt" };
const SECRETS = {
  bullet: "Add the secrets with sops",
  met: false,
  owner: true,
  why: "only the owner has the key",
};
const BUG = {
  severity: "important",
  pass: "Bugs",
  file: "greeting.txt",
  line: 1,
  what: "The greeting has no full stop.",
};

/** The moves out of review, with their reasons. */
const fromReview = (p: Pipe, id: number) =>
  p.db
    .all<{ to_stage: string; why: string | null }>(
      "SELECT to_stage, why FROM transitions WHERE mission = ? AND from_stage = 'review' ORDER BY id",
      id,
    )
    .map((t) => [t.to_stage, t.why]);

const comments = (p: Pipe) => p.prNo("web", p.mission()!.pr!).comments.map((c) => c.body);

test("pipeline: an owner-only outcome doesn't block approval", () => {
  expect(approvedOf({ ...R, outcomes: [MET, SECRETS] })).toBe(true);
  // The reviewer's yes is still needed.
  expect(approvedOf({ ...R, approved: false, outcomes: [MET, SECRETS] })).toBe(false);
});

test("pipeline: an unmet outcome the worker can meet still blocks approval", () => {
  const unmet = { bullet: "It says goodbye", met: false, owner: false, why: "missing" };
  expect(approvedOf({ ...R, outcomes: [MET, SECRETS, unmet] })).toBe(false);
  // Written by an older reviewer, without `owner`, it blocks as before.
  expect(approvedOf({ ...R, outcomes: [{ bullet: "b", met: false, why: "missing" }] })).toBe(false);
  expect(reviewDecision({ ...R, outcomes: [unmet] }, 0).round).toBe(1);
});

test("pipeline: owner steps are listed for the owner", () => {
  const r = { ...R, outcomes: [MET, SECRETS] };
  expect(reviewDecision(r, 0).ownerSteps).toEqual([{ bullet: SECRETS.bullet, why: SECRETS.why }]);
  const body = reviewComment(r, defaultReview());
  expect(body).toContain(`**For you to do**\n\n- ${SECRETS.bullet} (${SECRETS.why})`);
  expect(body).toContain(`- Owner step: ${SECRETS.bullet}`);
});

test("pipeline: an approved review with an owner step goes to the gate, not to build", async () => {
  // infra#50: the reviewer approves, one outcome is an owner step.
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("review", reply({ ...REVIEW, outcomes: [MET, SECRETS] }));
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  const m = p.mission()!;
  expect(m.stage, p.moves()).toBe("done");
  expect(fromReview(p, m.id)).toEqual([["gate", null]]);
  const d = JSON.parse(m.data);
  expect(d.reviewFixes).toBeUndefined();
  expect(d.ownerSteps).toEqual([{ bullet: SECRETS.bullet, why: SECRETS.why }]);
  expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(1);
  const pr = p.prNo("web", m.pr!);
  expect(pr.body).toContain(`- [ ] ${SECRETS.bullet}`);
  const review = pr.comments[0]!.body;
  expect(review).toContain("**Verdict:** Approve");
  expect(review).toContain("**For you to do**");
}, 30_000);

test("pipeline: a review with nothing the worker can fix gets no fix round", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("review", reply({ ...REVIEW, approved: false, summary: "Not sure." }));
  await p.start();
  const m = await p.untilStage("approval:merge");
  expect(fromReview(p, m.id)).toEqual([["gate", null]]);
  expect(JSON.parse(m.data).reviewFixes).toBeUndefined();
  expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(1);
  expect(comments(p)[0]).toContain("**Verdict:** Not approved");
}, 30_000);

test("pipeline: an important finding still gets a fix round", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("review", reply({ ...REVIEW, approved: false, outcomes: [MET, SECRETS], findings: [BUG] }));
  p.queue("worker", reply(build(), CODE), reply(build(), { "greeting.txt": "hello.\n" }));
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  const m = p.mission()!;
  expect(fromReview(p, m.id)).toEqual([
    ["build", "the review didn't approve: fix round 1 of 2"],
    ["gate", null],
  ]);
}, 30_000);

test("pipeline: the review comment says a fix round is coming", () => {
  const d = reviewDecision({ ...R, approved: false, findings: [BUG] as ReviewResult["findings"] }, 1);
  expect(d.round).toBe(2);
  expect(verdictLine(d)).toBe("**Verdict:** Sending back for fixes (round 2 of 2): 1 important finding");
  // Rounds used up: no promise of a fix round.
  const last = reviewDecision({ ...R, approved: false, findings: [BUG] as ReviewResult["findings"] }, 2);
  expect(last.round).toBeNull();
  expect(verdictLine(last)).toContain(
    "**Verdict:** Not approved: 1 important finding. The fix rounds are used up.",
  );
});

test("pipeline: the review comment never approves above a fix round", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // The reviewer says yes, but names an important finding.
  p.queue("review", reply({ ...REVIEW, findings: [BUG] }));
  p.queue("worker", reply(build(), CODE), reply(build(), { "greeting.txt": "hello.\n" }));
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  const first = comments(p)[0]!;
  expect(first).toContain("**Verdict:** Sending back for fixes (round 1 of 2)");
  expect(first).not.toContain("**Verdict:** Approve");
}, 30_000);

test("pipeline: the review comment names the check that overrode the agent", () => {
  const d = reviewDecision({ ...R, approved: true, tests_weakened: { value: true, where: "tests/a.sh" } }, 0);
  expect(d.overridden).toBe(true);
  expect(verdictLine(d)).toContain(
    "Towercab overrode the reviewer's Approve: tests were weakened (tests/a.sh).",
  );
  // No override when the reviewer didn't approve in the first place.
  expect(verdictLine(reviewDecision({ ...R, approved: false, findings: [BUG] as never }, 0))).not.toContain(
    "overrode",
  );
});
