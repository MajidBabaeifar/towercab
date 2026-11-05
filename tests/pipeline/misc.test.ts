// Edges of design and build (PIP-25, PIP-1): no behaviour change skips the spec PR; a build that
// changes nothing waits; a run cut off by its time limit continues once, then waits.

import { afterAll, beforeAll, expect, test } from "vitest";
import { build, DESIGN, happy, ID, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  p.queue("design", reply({ ...DESIGN, type: "refactor", spec_ids: [], pr: "No behaviour changes." }));
  p.queue("worker", reply(build({ notes: "Nothing needed changing: the greeting is already there." })));
  await p.start({ agent: { build_timeout: 1 } });
}, 30_000);

afterAll(() => p.cleanup());

test("pipeline: no behaviour change skips the spec PR", async () => {
  const m = await p.untilStage("blocked");
  const moves = p.db.all<{ from_stage: string; to_stage: string; why: string | null }>(
    "SELECT from_stage, to_stage, why FROM transitions WHERE mission = ? ORDER BY id",
    m.id,
  );
  expect(moves[1]).toEqual({
    from_stage: "design",
    to_stage: "plan",
    why: "no behaviour change: no spec PR",
  });
  expect(m.spec_pr).toBeNull();
  expect(p.prs.map((x) => x.repo)).toEqual(["owner/intents"]);
  expect(p.stages(m.id)).not.toContain("approval:spec");
  expect(p.show("intents", "main", `intents/${ID}-show-a-greeting/plan.md`)).toContain("No spec change.");
}, 30_000);

test("pipeline: no changes waits", () => {
  const m = p.mission()!;
  expect([m.stage, m.waiting, m.why]).toEqual([
    "blocked",
    "no changes",
    "Nothing needed changing: the greeting is already there.",
  ]);
  expect(m.from_stage).toBe("build");
  const msg = p.db.get<{ text: string }>("SELECT text FROM outbox WHERE mission = ?", m.id)!.text;
  expect(msg.split("\n")[0]).toBe(
    "The agent finished without changing anything. Reply with what it should do, say you did it yourself, or drop the intent if nothing is needed.",
  );
});

test("pipeline: timeout continues once", async () => {
  const m = p.mission()!;
  p.queue(
    "worker",
    () => ({ hang: true }),
    () => ({ hang: true }),
  );
  p.ownerComment(p.prNo("intents", m.plan_pr!), "Please add the greeting anyway.");
  p.clock.advance(61);
  await p.until(() => p.mission()?.waiting === "worker timeout", 20);
  const after = p.mission()!;
  expect([after.stage, after.waiting, after.why], p.moves()).toEqual([
    "blocked",
    "worker timeout",
    "the run hit its time limit",
  ]);
  const runs = p.claudeCalls.filter((c) => c.kind === "worker").slice(1);
  expect(runs).toHaveLength(2);
  expect(runs[0]!.prompt).toContain("Please add the greeting anyway.");
  expect(runs[1]!.prompt).toBe("Continue where you stopped.");
  expect(runs[1]!.session).toEqual({ mode: "resume", id: m.session });
  // Both runs got the whole budget: the continue's time doesn't count the cut-off run's.
  const timeouts = p.tools.spawned
    .filter((s) => s.kind === "worker")
    .slice(1)
    .map((s) => s.timeoutMs);
  expect(timeouts).toEqual([60_000, 60_000]);
}, 30_000);
