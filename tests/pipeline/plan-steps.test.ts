// The numbered steps of a plan and the count a build run reports (PIP-216).

import { expect, test } from "vitest";
import { clampSteps, planSteps } from "../../src/pipeline/plan-steps.ts";

const PLAN = `# Plan: Greeting

## Approach

Add it.

## Steps

1. Write the failing test
   for the greeting
2. Add the file
3) Update the docs

## Risks

1. Not a step

## Access

- [x] test: tests/a.test.ts (why)
`;

test("pipeline: plan steps are the numbered items under Steps", () => {
  expect(planSteps(PLAN)).toEqual([
    "Write the failing test for the greeting",
    "Add the file",
    "Update the docs",
  ]);
  expect(planSteps("## Approach\n\nNo steps here.\n")).toEqual([]);
});

test("pipeline: steps done never goes down or past the plan", () => {
  expect(clampSteps(null, 0, 6)).toBe(6);
  expect(clampSteps(2, 0, 6)).toBe(2);
  expect(clampSteps(1, 3, 6)).toBe(3);
  expect(clampSteps(9, 3, 6)).toBe(6);
});
