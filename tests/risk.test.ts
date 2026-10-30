// A change's risk (AUT-16, AUT-17, AUT-20): the level from three answers, its floor, the plain words.

import { expect, test } from "vitest";
import type { RiskResult } from "../src/pipeline/schemas.ts";
import { openPointsMd, riskFloor, riskMd, riskOf, riskWords } from "../src/risk.ts";
import { risk } from "./helpers/flows.ts";

const answer = (o: Record<string, unknown> = {}) => risk(o) as RiskResult;
const oneWay = { kind: "one-way", why: "It drops a column." };
const large = { size: "large", who: "Every user." };
const unsure = { level: "low", why: "It depends on the live mail server." };

test("risk: three answers give a level", () => {
  // Nothing in the answers calls for more: the agent's level stands.
  for (const level of ["low", "medium", "high"]) {
    const r = riskOf(answer({ level }), "abc");
    expect([r.level, r.said, r.raised, r.of]).toEqual([level, level, null, "abc"]);
  }
  const r = riskOf(answer(), "abc");
  expect(r.blast).toEqual({ size: "small", who: "Visitors of the page." });
  expect(r.door.kind).toBe("two-way");
  expect(r.certainty.level).toBe("high");
  expect(r.openPoints).toEqual([]);
});

test("risk: the floor raises the level", () => {
  // One of a one-way door, a large blast radius, low certainty → at least medium.
  expect(riskFloor(answer({ door: oneWay })).level).toBe("medium");
  expect(riskFloor(answer({ blast_radius: large })).level).toBe("medium");
  expect(riskFloor(answer({ certainty: unsure })).level).toBe("medium");
  // Two or more → high.
  expect(riskFloor(answer({ door: oneWay, certainty: unsure })).level).toBe("high");
  // A medium blast radius or certainty alone doesn't raise it.
  expect(
    riskFloor(
      answer({ blast_radius: { size: "medium", who: "x" }, certainty: { level: "medium", why: "y" } }),
    ).level,
  ).toBe("low");
  // At the code gate the review counts: its one-way door, and a touched red line makes it high.
  expect(riskFloor(answer(), { door: "one-way", redLines: false }).level).toBe("medium");
  expect(riskFloor(answer(), { door: "two-way", redLines: true }).level).toBe("high");
  // The agent's low is raised and says why; its high is never lowered.
  const r = riskOf(answer({ door: oneWay }), "x");
  expect([r.level, r.said]).toEqual(["medium", "low"]);
  expect(r.raised).toBe("Raised from low to medium: it is hard to undo.");
  expect(riskOf(answer({ level: "high" }), "x").level).toBe("high");
  const two = riskOf(answer({ door: oneWay, blast_radius: large }), "x");
  expect(two.raised).toBe(
    "Raised from low to high: it is hard to undo, and it could affect many people or systems.",
  );
});

test("risk: plain words for the owner", () => {
  const r = riskOf(answer({ door: oneWay, level: "medium" }), "x");
  expect(riskWords(r)).toEqual({
    label: "Medium risk",
    blast: "Affects few: Visitors of the page.",
    door: "Hard to undo: It drops a column.",
    certainty: "Sure it works once live: A test covers the greeting.",
  });
  const md = riskMd(r);
  expect(md.split("\n")[0]).toBe("## Risk: medium");
  expect(md).toContain("- **Can it be undone:** Hard to undo: It drops a column.");
  expect(md).toContain("A small, tested change that is easy to undo.");
  // Not assessed yet → nothing; a run that didn't finish → says so.
  expect(riskMd(undefined)).toBe("");
  expect(riskMd(null)).toContain("The risk check didn't finish");
  // Open points: a list for the spec PR, nothing without any.
  expect(openPointsMd(r)).toBe("");
  const p = riskOf(answer({ open_points: [{ point: "Keep old links?", why: "Bookmarks break." }] }), "x");
  expect(openPointsMd(p)).toBe("## Open points for you\n\n- Keep old links? Bookmarks break.");
});
