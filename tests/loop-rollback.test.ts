// LOOP-82: a red part rolls itself and the parts that landed after it back, last landed first; the parts
// before it stay. The freeze holds until the rolled-back parts are back, and only they are built again.

import { expect, test } from "vitest";
import { takeFreeze } from "../src/freeze.ts";
import { apply } from "../src/machine.ts";
import { getMission, insertMission, type Mission } from "../src/mission.ts";
import { applyPart } from "../src/partrun.ts";
import { currentPart, freezeOver, inPartStages, partsOf } from "../src/parts.ts";
import { testDb } from "./helpers/world.ts";

const PLAN = {
  parts: ["infra", "api", "web"],
  waitsOn: { infra: [], api: ["infra"], web: ["api"] },
};

/** Three parts, all merged in order, now at deploy; `shipped` of them are already live. */
function landed(shipped: string[] = []) {
  const db = testDb();
  const cx = {
    db,
    now: 10,
    subject: (m: Mission) => ({ title: "Show a greeting", repo: m.repo, link: null }),
  };
  let m = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "greet", repo: "web", model: "opus", a: 5 }, 1),
  );
  m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, { event: "ok" });
  m = apply(cx, m, { event: "wait", waiting: "approve plan", data: { plan: PLAN } });
  m = apply(cx, m, { event: "plan_merged" });
  for (const repo of PLAN.parts) {
    for (let i = 0; i < 7; i++) m = applyPart(cx, getMission(db, m.id)!, repo, { event: "ok" });
  }
  expect(getMission(db, m.id)!.stage).toBe("merge");
  for (const repo of PLAN.parts) {
    applyPart(cx, getMission(db, m.id)!, repo, { event: "code_merged", set: { merge_sha: `sha-${repo}` } });
  }
  expect(getMission(db, m.id)!.stage).toBe("deploy");
  for (const repo of shipped) {
    applyPart(cx, getMission(db, m.id)!, repo, { event: "ok" });
    applyPart(cx, getMission(db, m.id)!, repo, { event: "ok" });
  }
  return { db, cx, id: m.id, now: () => getMission(db, m.id)! };
}

const red = { event: "red" as const, why: "e2e failed", data: { ship: { merges: ["x"], fixes: 0 } } };
const stages = (m: Mission) => partsOf(m).map((p) => [p.repo, p.stage, p.merged]);

test("loop: a red part rolls itself and the later parts back, last first", () => {
  const { cx, now } = landed(["infra"]);
  applyPart(cx, now(), "api", red);
  const m = now();
  expect(m.stage).toBe("rollback");
  expect(
    partsOf(m)
      .filter((p) => p.stage === "rollback")
      .map((p) => p.repo),
  ).toEqual(["api", "web"]);
  // The part that landed last goes back first, then the red one.
  expect(currentPart(m, partsOf(m))?.repo).toBe("web");
  applyPart(cx, now(), "web", { event: "ok", set: { pr: null, head: null } });
  expect(currentPart(now(), partsOf(now()))?.repo).toBe("api");
  expect(now().stage).toBe("rollback");
});

test("loop: parts before the red one stay merged", () => {
  const { cx, now } = landed(["infra"]);
  applyPart(cx, now(), "api", red);
  applyPart(cx, now(), "web", { event: "ok" });
  applyPart(cx, now(), "api", { event: "ok" });
  expect(stages(now())).toEqual([
    ["infra", "shipped", true],
    ["api", "build", false],
    ["web", "build", false],
  ]);
});

test("loop: unmerged parts are not merged after a red part", () => {
  const { db, cx, now } = landed(["infra"]);
  // `web` never merged (a retried landing): a red `api` leaves it alone.
  const d = JSON.parse(now().data) as { parts: { repo: string; merged: boolean; stage: string }[] };
  d.parts.find((p) => p.repo === "web")!.merged = false;
  d.parts.find((p) => p.repo === "web")!.stage = "gate";
  db.run("UPDATE missions SET data = ? WHERE id = ?", JSON.stringify(d), now().id);
  applyPart(cx, now(), "api", red);
  expect(stages(now())).toEqual([
    ["infra", "shipped", true],
    ["api", "rollback", true],
    ["web", "gate", false],
  ]);
});

test("loop: the freeze holds during the rollback", () => {
  const { db, cx, now } = landed(["infra"]);
  expect(takeFreeze(db, now().id, ["infra", "api", "web"], 10)).toEqual({ ok: true });
  applyPart(cx, now(), "api", red);
  expect(freezeOver(now())).toBe(false);
  applyPart(cx, now(), "web", { event: "ok" });
  expect(freezeOver(now())).toBe(false);
  // It lifts when every rolled-back part is back and the mission builds them again.
  applyPart(cx, now(), "api", { event: "ok" });
  expect(now().stage).toBe("build");
  expect(freezeOver(now())).toBe(true);
});

test("loop: a failed rollback keeps the other repos frozen", () => {
  const { db, cx, now } = landed(["infra"]);
  takeFreeze(db, now().id, ["infra", "api", "web"], 10);
  applyPart(cx, now(), "api", red);
  applyPart(cx, now(), "web", { event: "wait", waiting: "rollback failed", why: "the platform refused" });
  const m = now();
  expect(m.stage).toBe("blocked");
  expect(m.waiting).toBe("rollback failed");
  expect(freezeOver(m)).toBe(false);
  // The parts stay as they were: the owner decides, and `continue` tries the rollback again.
  expect(
    partsOf(m)
      .filter((p) => p.stage === "rollback")
      .map((p) => p.repo),
  ).toEqual(["api", "web"]);
  const again = apply(cx, m, { event: "answered" });
  expect(again.stage).toBe("rollback");
});

test("loop: only the rolled-back parts are built again", () => {
  const { cx, now } = landed(["infra"]);
  applyPart(cx, now(), "api", red);
  applyPart(cx, now(), "web", { event: "ok" });
  applyPart(cx, now(), "api", { event: "ok" });
  const m = now();
  expect(m.stage).toBe("build");
  expect(inPartStages(m)).toBe(true);
  // The part that stayed counts as at the gate and merged; the others start again with no PR.
  expect(partsOf(m).map((p) => [p.repo, p.atGate, p.merged, p.pr])).toEqual([
    ["infra", true, true, null],
    ["api", false, false, null],
    ["web", false, false, null],
  ]);
  // Once both are at the gate again the intent lands again, `infra` counted as merged.
  for (const repo of ["api", "web"]) {
    for (let i = 0; i < 7; i++) applyPart(cx, now(), repo, { event: "ok" });
  }
  expect(now().stage).toBe("merge");
  expect(currentPart(now(), partsOf(now()))?.repo).toBe("api");
});
