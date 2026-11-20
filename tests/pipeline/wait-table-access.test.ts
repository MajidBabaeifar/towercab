// A plan that adds an owner wait lists the wait table up front (PIP-194).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseAccess, renderAccess } from "../../src/pipeline/access.ts";

const read = (rel: string) => readFileSync(join(import.meta.dirname, "..", "..", rel), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

test("pipeline: plan prompt tells the planner to list the wait table for a new wait", () => {
  const text = flat(read("agents/plan.md"));
  expect(text).toContain("adds an owner wait or a new question");
  expect(text).toContain("`WAITS` entry");
  expect(text).toContain("`EXITS` entry");
  expect(text).toContain("`src/machine.ts` in `access.paths`");
  expect(text).toContain("`wait table entries only`");
  expect(text).toContain("also changes transitions or `apply`");
});

test("pipeline: plan access lists the wait table with a wait table reason", () => {
  const entry = { glob: "src/machine.ts", why: "wait table entries only" };
  const md = renderAccess({ domains: [], paths: [entry], tests: [] }, 5);
  expect(md).toContain(`- [x] path: ${entry.glob} (${entry.why})`);
  expect(parseAccess(md).paths).toEqual([entry]);
  // An unticked box is not granted (PIP-115).
  expect(parseAccess(md.replace("- [x] path", "- [ ] path")).paths).toEqual([]);
});
