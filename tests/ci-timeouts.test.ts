// PIP-170: every job of Towercab's own CI that runs steps has a time limit.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

type Job = { name?: string; uses?: string; steps?: unknown[]; "timeout-minutes"?: unknown };
const jobs = (): Record<string, Job> => parseYaml(readFileSync(".github/workflows/ci.yml", "utf8")).jobs;

test("public: every CI job that runs steps sets timeout-minutes", () => {
  const limits: Record<string, number> = {
    "Node 22: lint, typecheck, tests": 15,
    "Playwright: UI screenshots": 15,
  };
  const withSteps = Object.entries(jobs()).filter(([, j]) => j.steps);
  expect(withSteps.length).toBeGreaterThan(0);
  for (const [id, job] of withSteps)
    expect(job["timeout-minutes"], `job ${id}`).toBe(limits[job.name ?? ""] ?? 10);
});

test("public: jobs that call a shared workflow are exempt from the limit", () => {
  const callers = Object.entries(jobs()).filter(([, j]) => j.uses);
  expect(callers.map(([id]) => id).sort()).toEqual(["checks", "sast"]);
  for (const [id, job] of callers) expect(job["timeout-minutes"], `job ${id}`).toBeUndefined();
});
