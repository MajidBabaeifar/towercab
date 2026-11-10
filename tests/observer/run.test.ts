// The weekly report (OBV-8), steering (OBV-9), cost (OBV-10) and records (OBV-12), over a whole run.

import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { Health } from "../../src/faults.ts";
import { costToday } from "../../src/observer/store.ts";
import { spendPeriods } from "../../src/ui/spend.ts";
import { budgetReached, spend } from "../../src/ui/state.ts";
import { finding, local, ObsRig } from "./rig.ts";

const TITLES = [
  "Towercab stops retrying a check that fails the same way every time",
  "Towercab shows why a build waited so long for a free slot",
  "Towercab asks one clear question instead of three vague ones",
  "Towercab explains what a rollback changed in plain words",
];

const reports = (r: ObsRig) => r.outbox().filter((m) => m.key.startsWith("observer:report:"));

test("observer: a weekly report is sent once", async () => {
  const r = new ObsRig();
  r.child([finding()]);
  const o = r.observer();
  await r.run(o);
  await r.run(o);
  await r.run(r.observer());
  expect(reports(r)).toHaveLength(1);
  expect(reports(r)[0]!.key).toBe("observer:report:2026-W46");
  expect(reports(r)[0]!.text.split("\n").length).toBeLessThanOrEqual(12);
  // Not on another day of the week.
  r.clock.t = local(2026, 11, 10, 7, 0);
  r.child([]);
  await r.run(o);
  expect(reports(r)).toHaveLength(1);
});

test("observer: the report is sent when nothing was found", async () => {
  const r = new ObsRig();
  r.child([]);
  await r.run(r.observer());
  expect(reports(r)).toHaveLength(1);
  expect(reports(r)[0]!.text).toContain("Nothing notable this week.");
});

test("observer: the report lists proposals and held findings", async () => {
  const r = new ObsRig();
  r.child(TITLES.map((title) => finding({ title })));
  await r.run(r.observer());
  const text = reports(r)[0]!.text;
  expect(text).toContain("Proposed 3:");
  expect(text).toContain("https://github.com/owner/intents/pull/7");
  expect(text).toContain("Held back (over 3 a week):");
  expect(text).toContain(TITLES[3]!);
  expect(text).toContain("Observer spend this week: $0.20.");
});

test("observer: no report when off", async () => {
  const r = new ObsRig({ enabled: false });
  r.child([]);
  await r.run(r.observer());
  expect(r.outbox()).toEqual([]);
});

test("observer: the steering text is in the bundle when present", async () => {
  const r = new ObsRig();
  r.steering = "Goal for the year: fewer red checks, nothing slower than ten minutes.";
  r.child([]);
  await r.run(r.observer());
  expect(r.prompt()).toContain("Goal for the year: fewer red checks");
});

test("observer: without steering it ranks by evidence", async () => {
  const r = new ObsRig();
  r.child([]);
  await r.run(r.observer());
  expect(r.prompt()).toContain("rank by the evidence alone");
});

test("observer: its cost is in the spend", async () => {
  const r = new ObsRig();
  r.child([], 0.4);
  await r.run(r.observer());
  const now = r.clock.now();
  expect(costToday(r.db, now)).toBeCloseTo(0.4);
  expect(spend(r.db, now).today).toBeCloseTo(0.4);
  const periods = spendPeriods(r.db, now);
  expect(periods.all.day).toBeCloseTo(0.4);
  // Overall only: no repo is charged for it.
  expect(periods.repos.get("web")?.day ?? 0).toBe(0);
});

test("observer: the daily cap stops further runs", async () => {
  const r = new ObsRig({ daily_budget_usd: 0.3 });
  r.child([], 0.4).child([]);
  const o = r.observer();
  await r.run(o);
  r.mission("i-3", "web", { waiting: "worker budget" });
  r.clock.advance(2 * 3600);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(1);
  // The next day it may run again.
  r.clock.t = local(2026, 11, 10, 6, 5);
  await r.run(o);
  expect(r.tools.spawned).toHaveLength(2);
});

test("observer: the cap does not pause picks", async () => {
  const r = new ObsRig({ daily_budget_usd: 0.3 });
  r.child([], 0.4);
  await r.run(r.observer());
  const now = r.clock.now();
  // The observer is at its own cap, but the overall budget is not reached.
  expect(costToday(r.db, now)).toBeGreaterThanOrEqual(0.3);
  expect(budgetReached(r.db, r.config, now)).toBe(false);
  // And a failing observer never holds picks back, however long its fault stays open.
  const h = new Health();
  h.fail("observer", "boom", now);
  expect(h.blocked(now + 5 * 3600)).toBe(false);
  expect(h.noticeDue(now + 5 * 3600)).toBeNull();
});

test("observer: a run is bounded by its own budget", async () => {
  const r = new ObsRig();
  r.child([]);
  await r.run(r.observer());
  const argv = r.tools.spawned[0]!.argv;
  expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("1.5");
  // What is left of the day's cap bounds it further.
  const s = new ObsRig({ daily_budget_usd: 0.5 });
  s.child([]);
  await s.run(s.observer());
  const a = s.tools.spawned[0]!.argv;
  expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.5");
});

test("observer: a run is recorded with its cost and outcome", async () => {
  const r = new ObsRig();
  r.child([finding(), finding({ repo: "nowhere", title: TITLES[1]! })], 0.35);
  await r.run(r.observer());
  const run = r.runs()[0]!;
  expect(run).toMatchObject({ trigger: "daily", outcome: "done", findings: 2, proposals: 1, comments: 0 });
  expect(run.cost).toBeCloseTo(0.35);
  expect(JSON.parse(run.dropped)).toEqual([{ title: TITLES[1], why: "unknown repo" }]);
});

test("observer: a failed run is a fault and does not stop the loop", async () => {
  const r = new ObsRig();
  r.tools.child("claude", (spec) => {
    writeFileSync(spec.stdout, "");
    writeFileSync(spec.stderr, "boom");
    return { code: 1, signal: null };
  });
  const o = r.observer();
  await expect(r.run(o)).resolves.toBeUndefined();
  expect(r.runs()[0]!.outcome).toBe("failed");
  expect(r.faults).toEqual(["observer"]);
  // It tries again at the next trigger, and a good run closes the fault.
  r.clock.t = local(2026, 11, 10, 6, 5);
  r.child([]);
  await r.run(o);
  expect(r.runs().map((x) => x.outcome)).toEqual(["failed", "done"]);
  expect(r.fine).toContain("observer");
});

test("observer: an invalid result opens nothing", async () => {
  const r = new ObsRig();
  r.tools.child("claude", (spec) => {
    writeFileSync(
      spec.stdout,
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        session_id: "s",
        total_cost_usd: 0.1,
        duration_ms: 1,
        permission_denials: [],
        modelUsage: {},
        structured_output: { findings: "open everything" },
      })}\n`,
    );
    writeFileSync(spec.stderr, "");
    return { code: 0, signal: null };
  });
  await r.run(r.observer());
  expect(r.created).toEqual([]);
  expect(r.comments).toEqual([]);
  expect(r.runs()[0]!.outcome).toBe("failed");
  expect(r.faults).toEqual(["observer"]);
});
