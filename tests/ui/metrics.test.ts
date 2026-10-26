// MET-29, MET-30: spend per day and time per step, as the page computes them.

import { expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { budgetReached, spend, stepTimes } from "../../src/ui/state.ts";
import { testConfig } from "../helpers/world.ts";

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0).getTime() / 1000;
const NOW = local(26, 15);

function withRuns(db: Db, updated: number, runs: { at: number; cost: number }[]) {
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, model, session, checkout, branch, data, created, updated)
     VALUES (?, 'web', 1, 'build', 'opus', 's', 'w', 'b', ?, ?, ?)`,
    `i${updated}-${runs.length}`,
    JSON.stringify({ runs }),
    updated - 3600,
    updated,
  );
}

test("metrics: spend today and 7 days", () => {
  const db = Db.memory();
  withRuns(db, NOW - 60, [
    { at: local(26, 9), cost: 1.5 },
    { at: local(26, 14, 30), cost: 2.25 },
    { at: local(25, 23, 59), cost: 4 },
  ]);
  withRuns(db, local(21, 12), [
    { at: local(20, 10), cost: 3 },
    { at: local(21, 11), cost: 0.75 },
  ]);
  // Older than 7 days, in the future, or malformed: not counted.
  withRuns(db, local(25, 1), [
    { at: local(18, 10), cost: 100 },
    { at: NOW + 3600, cost: 50 },
  ]);
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, model, session, checkout, branch, data, created, updated)
     VALUES ('bad', 'web', 1, 'build', 'opus', 's', 'w', 'b', 'not json', ?, ?)`,
    NOW,
    NOW,
  );
  const s = spend(db, NOW);
  expect(s.today).toBeCloseTo(3.75);
  expect(s.days.map((d) => d.date)).toEqual([
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
  ]);
  expect(s.days.map((d) => d.cost)).toEqual([3, 0.75, 0, 0, 0, 4, 3.75]);
  expect(s.week).toBeCloseTo(11.5);
  const config = testConfig({ agent: { daily_budget_usd: 3.5 } });
  expect(budgetReached(db, config, NOW)).toBe(true);
  expect(budgetReached(db, testConfig({ agent: { daily_budget_usd: 5 } }), NOW)).toBe(false);
  expect(budgetReached(db, testConfig(), NOW)).toBe(false);
});

test("metrics: time per step from moves", () => {
  const t0 = 1_000_000;
  const moves = [
    { at: t0 + 30, from_stage: "pick", to_stage: "design" },
    { at: t0 + 630, from_stage: "design", to_stage: "approval:spec" },
    { at: t0 + 4230, from_stage: "approval:spec", to_stage: "plan" },
    { at: t0 + 4830, from_stage: "plan", to_stage: "build" },
    { at: t0 + 6630, from_stage: "build", to_stage: "verify" },
    { at: t0 + 6930, from_stage: "verify", to_stage: "build" },
    { at: t0 + 7530, from_stage: "build", to_stage: "blocked" },
  ] as const;
  const r = stepTimes([...moves], { start: t0, now: t0 + 9330 });
  expect(r.steps.map((s) => [s.words, s.secs, s.owner])).toEqual([
    ["Starting", 30, false],
    ["Writing the spec", 600, false],
    ["Waiting for your spec review", 3600, true],
    ["Planning", 600, false],
    ["Building", 2400, false],
    ["Running checks", 300, false],
    ["Waiting for your answer", 1800, true],
  ]);
  expect(r.towercab).toBe(30 + 600 + 600 + 2400 + 300);
  expect(r.owner).toBe(5400);
  // A finished mission adds nothing after its last move.
  const done = stepTimes([{ at: 10, from_stage: "merge", to_stage: "done" }], { start: 0, now: 1000 });
  expect(done.steps.map((s) => [s.words, s.secs])).toEqual([["Merging", 10]]);
  expect(stepTimes([]).steps).toEqual([]);
});
