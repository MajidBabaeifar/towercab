// LOOP-78's parts of a multi-repo mission: the shared cap and the move out of the parallel stages.

import { expect, test } from "vitest";
import { dataOf, insertMission, patchData } from "../src/mission.ts";
import { allAtGate, capReached, isMulti, partsOf, runBudget, seedParts, unitKey } from "../src/parts.ts";
import { testDb } from "./helpers/world.ts";

const plan = [
  { repo: "infra", waitsOn: [] },
  { repo: "web", waitsOn: ["infra"] },
];

test("parts: a mission seeded from the plan has a part per repo in landing order", () => {
  const db = testDb();
  const m = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
  expect(isMulti(m)).toBe(false);
  const parts = seedParts(plan, m);
  const fresh = patchData(db, m, { parts }, 1);
  expect(partsOf(fresh).map((p) => [p.repo, p.waitsOn, p.stage])).toEqual([
    ["infra", [], "build"],
    ["web", ["infra"], "build"],
  ]);
  expect(partsOf(fresh)[1]!.checkout).toBe(`${m.checkout}-web`);
  expect(dataOf(fresh).parts).toHaveLength(2);
  expect(unitKey(m)).toBe(String(m.id));
  expect(unitKey(m, "web")).toBe(`${m.id}:web`);
});

test("parts: the mission leaves the parallel stages only when every part is at the gate", () => {
  const m = { branch: "b", checkout: "c" };
  const parts = seedParts(plan, m);
  expect(allAtGate([])).toBe(false);
  expect(allAtGate(parts)).toBe(false);
  parts[0]!.atGate = true;
  expect(allAtGate(parts)).toBe(false);
  parts[1]!.atGate = true;
  expect(allAtGate(parts)).toBe(true);
});

test("parts: the run limit is what the one cap leaves, and a single repo is unchanged", () => {
  expect(runBudget(5, 10, { cost_usd: 8 }, true)).toBe(2);
  expect(runBudget(5, 10, { cost_usd: 1 }, true)).toBe(5);
  expect(runBudget(null, 10, { cost_usd: 4 }, true)).toBe(6);
  expect(runBudget(5, 10, { cost_usd: 99 }, false)).toBe(5);
  expect(capReached(10, { cost_usd: 9.99 })).toBe(false);
  expect(capReached(10, { cost_usd: 10 })).toBe(true);
});
