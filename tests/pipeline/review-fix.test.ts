// Review findings go back to the builder first (PIP-98): a review that doesn't approve gets up to two
// fix rounds in the worker's session before the code PR waits for the owner.

import { expect, test } from "vitest";
import { REVIEW_FIX } from "../../src/pipeline/review.ts";
import { build, CODE, happy, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const NOT_YET = {
  ...REVIEW,
  approved: false,
  findings: [
    {
      severity: "important",
      pass: "Bugs",
      file: "greeting.txt",
      line: 1,
      what: "The greeting has no full stop.",
    },
  ],
  summary: "Not yet: one bug.",
};

/** The moves out of review, with their reasons. */
const fromReview = (p: Pipe, id: number) =>
  p.db
    .all<{ to_stage: string; why: string | null }>(
      "SELECT to_stage, why FROM transitions WHERE mission = ? AND from_stage = 'review' ORDER BY id",
      id,
    )
    .map((t) => [t.to_stage, t.why]);

test("pipeline: a review that doesn't approve gets two fix rounds", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("review", reply(NOT_YET), reply(NOT_YET), reply(NOT_YET));
  p.queue(
    "worker",
    reply(build(), CODE),
    reply(build(), { "greeting.txt": "hello.\n" }),
    reply(build(), { "greeting.txt": "hello!\n" }),
  );
  await p.start();
  const m = await p.untilStage("approval:merge");
  expect([m.waiting, m.why]).toEqual(["review and merge PR", "review not approved"]);
  expect(fromReview(p, m.id)).toEqual([
    ["build", "the review didn't approve: fix round 1 of 2"],
    ["build", "the review didn't approve: fix round 2 of 2"],
    ["gate", null],
  ]);
  // Each fix round is a repair in the worker's session, with the Review comment as its details.
  const workers = p.claudeCalls.filter((c) => c.kind === "worker");
  expect(workers).toHaveLength(3);
  for (const fix of workers.slice(1)) {
    expect(fix.prompt.startsWith(REVIEW_FIX)).toBe(true);
    expect(fix.prompt).toContain("<review>\nNot yet: one bug.");
    expect(fix.prompt).toContain("The greeting has no full stop.");
    expect(fix.session).toEqual({ mode: "resume", id: m.session });
  }
  expect(JSON.parse(m.data).reviewFixes).toBe(2);
  // The risk check ran once, on the diff the gate decides on.
  expect(p.claudeCalls.filter((c) => c.kind === "risk")).toHaveLength(3);
}, 30_000);

test("pipeline: a review fix round that lands goes on", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("review", reply(NOT_YET));
  p.queue("worker", reply(build(), CODE), reply(build(), { "greeting.txt": "hello.\n" }));
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  const m = p.mission()!;
  expect(m.stage, p.moves()).toBe("done");
  expect(fromReview(p, m.id)).toEqual([
    ["build", "the review didn't approve: fix round 1 of 2"],
    ["gate", null],
  ]);
  expect(p.show("web", "main", "greeting.txt")).toBe("hello.\n");
  // Two review comments: the first round's and the approving one.
  const comments = p.prNo("web", m.pr!).comments.map((c) => c.body.split("\n")[0]);
  expect(comments).toEqual(["<!-- towercab:review:1 -->", "<!-- towercab:review:2 -->"]);
}, 30_000);
