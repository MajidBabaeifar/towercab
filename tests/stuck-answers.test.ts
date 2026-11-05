import { expect, test } from "vitest";
import { wait } from "../src/machine.ts";
import { dataOf } from "../src/mission.ts";
import { exitsWorld } from "./helpers/exits.ts";

test("machine: an answer without words still counts as new", () => {
  const w = exitsWorld();
  w.set({ stage: "build", head: "abc" });
  w.move(wait("no changes"));
  // The owner removed `waiting` from the intent: no text, but an answer.
  w.move({ event: "answered", counted: true });
  expect(dataOf(w.move(wait("no changes"))).stuck).toBeUndefined();
  // A bare event nobody counted (the loop's own) leaves it stuck.
  w.move({ event: "answered" });
  expect(dataOf(w.move(wait("no changes"))).stuck).toBe(true);
});

test("machine: to_steps moves only a wait on the owner", () => {
  for (const stage of ["build", "plan", "steps", "approval:merge", "deploy"] as const) {
    const w = exitsWorld();
    w.set({ stage });
    expect(w.move({ event: "to_steps", data: { delivery: "steps" } }).stage, stage).toBe(stage);
  }
  const b = exitsWorld();
  b.set({ stage: "blocked", waiting: "no changes", from_stage: "build" });
  expect(b.move({ event: "to_steps", data: { delivery: "steps" } }).stage).toBe("plan");
});
