// A repair round that changes nothing (PIP-1): it asks the owner at once instead of sending the same
// head through CI again; after the owner's answer an unchanged head goes on and CI runs it once more.

import { afterAll, beforeAll, expect, test } from "vitest";
import { build, CODE, checkRun, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { type FakePr, Pipe } from "../helpers/pipe.ts";

let p: Pipe;
let code: FakePr;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  let round = 0;
  p.respond.worker = () => {
    round++;
    if (round === 1) return { structured: build(), edits: CODE };
    return { structured: build({ notes: "Nothing to fix: the checks pass here." }) };
  };
  await p.start();
  await p.until(() => {
    const pr = p.prs.find((x) => x.head === `towercab/${ID}-${SLUG}`);
    if (pr) {
      code = pr;
      // The run stays red until it is rerun a second time, as a flaky test would.
      pr.checks = () => [checkRun("test", p.reruns.length >= 2 ? "SUCCESS" : "FAILURE", 300)];
    }
    return p.mission()?.stage === "blocked";
  });
}, 60_000);

afterAll(() => p.cleanup());

test("pipeline: a repair that changes nothing waits", () => {
  const m = p.mission()!;
  expect([m.stage, m.waiting, m.why], p.moves()).toEqual([
    "blocked",
    "no changes",
    "The repair round changed nothing. Nothing to fix: the checks pass here.",
  ]);
  // One red, one repair: the unchanged head never went back through CI.
  const reds = p.db.all("SELECT why FROM transitions WHERE event = 'red' AND mission = ?", m.id);
  expect(reds).toEqual([{ why: "CI failed: test" }]);
  expect(p.stages(m.id).filter((s) => s === "publish")).toHaveLength(1);
  expect(p.reruns).toEqual([300]);
});

test("pipeline: after an answer an unchanged head gets CI again", async () => {
  const before = p.mission()!.head;
  p.ownerComment(code, "The test is flaky; go on.");
  p.clock.advance(61);
  await p.until(() => ["approval:merge", "done"].includes(p.mission()?.stage ?? ""), 40);
  const m = p.mission()!;
  // The worker saw the answer, changed nothing again, and the same head went on.
  const last = p.claudeCalls.filter((c) => c.kind === "worker").at(-1)!;
  expect(last.prompt).toContain("The test is flaky; go on.");
  expect(m.head).toBe(before);
  expect(p.reruns).toEqual([300, 300]);
}, 60_000);
