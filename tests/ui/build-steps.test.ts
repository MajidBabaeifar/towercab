// The intent page and card say which plan step a long build is on (UI-279).

import { expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { buildProgress } from "../../src/ui/state.ts";

const mission = (stage: string, build: unknown, from: string | null = null) =>
  ({ stage, from_stage: from, data: JSON.stringify({ build }) }) as unknown as Mission;

test("ui: the intent page shows the plan step being built", () => {
  const b = { pr: null, notes: "", planChanged: null, stepsDone: 2, stepsTotal: 6 };
  expect(buildProgress(mission("build", b))).toEqual({
    stepsDone: 2,
    stepsTotal: 6,
    label: "step 3 of 6",
  });
  // Between runs, or waiting for the owner, it says how many are built.
  expect(buildProgress(mission("blocked", b, "build"))?.label).toBe("2 of 6 steps built");
  // Once every step is built, or the review has started, there is no count.
  expect(buildProgress(mission("build", { ...b, stepsDone: 6 }))).toBeNull();
  expect(buildProgress(mission("review", b))).toBeNull();
});

test("ui: no step count for a one-run plan", () => {
  const plain = { pr: null, notes: "", planChanged: null };
  expect(buildProgress(mission("build", plain))).toBeNull();
  expect(buildProgress(mission("build", { ...plain, stepsTotal: 1 }))).toBeNull();
  expect(buildProgress(mission("build", undefined))).toBeNull();
});
