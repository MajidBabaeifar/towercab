// The pure rules behind LOOP-80..82: landing order, the rollback set and the freeze limit.

import { expect, test } from "vitest";
import { freezeDue, nextToLand, type PartState, rollbackSet, seedParts } from "../src/parts.ts";

const parts = (merged: string[]): PartState[] =>
  seedParts(
    [
      { repo: "infra", waitsOn: [] },
      { repo: "web", waitsOn: ["infra"] },
      { repo: "docs", waitsOn: ["web"] },
    ],
    { branch: "b", checkout: "/c" },
  ).map((p) => ({ ...p, merged: merged.includes(p.repo) }));

test("parts: the next part to land waits for the ones it depends on", () => {
  expect(nextToLand(parts([]))?.repo).toBe("infra");
  expect(nextToLand(parts(["infra"]))?.repo).toBe("web");
  expect(nextToLand(parts(["infra", "web", "docs"]))).toBeNull();
});

test("parts: a part that waits on an unmerged part is not ready", () => {
  const ps = parts([]);
  expect(nextToLand(ps.filter((p) => p.repo !== "infra"))?.repo).toBe("web");
  expect(nextToLand([{ ...ps[1]!, waitsOn: ["infra"] }, ps[0]!])?.repo).toBe("infra");
});

test("parts: a red part rolls back itself and the merged parts after it, last first", () => {
  expect(rollbackSet(parts(["infra", "web", "docs"]), "web").map((p) => p.repo)).toEqual(["docs", "web"]);
  expect(rollbackSet(parts(["infra", "web"]), "web").map((p) => p.repo)).toEqual(["web"]);
  expect(rollbackSet(parts(["infra", "web"]), "nowhere")).toEqual([]);
});

test("parts: the freeze is due once it has lasted the limit", () => {
  expect(freezeDue(119 * 60, 120)).toBe(false);
  expect(freezeDue(120 * 60, 120)).toBe(true);
});
