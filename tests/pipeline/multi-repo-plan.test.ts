// INT-43: the plan of a multi-repo intent has a part per repo, in an order that works part by part.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { checkParts, type RepoPart, reposMd, withRepos } from "../../src/pipeline/repos.ts";
import { parseResult } from "../../src/pipeline/schemas.ts";

const part = (repo: string, waits_on: string[] = [], change = `change ${repo}`): RepoPart => ({
  repo,
  change,
  waits_on,
  safe_alone: `${repo} works without the later parts`,
});

test("plan: a multi-repo plan has a part per repo", () => {
  // The plan lists them out of order; the landing order follows `waits_on`.
  const r = checkParts(
    "specfork",
    ["infra", "ci"],
    [part("specfork", ["infra"]), part("ci"), part("infra", ["ci"])],
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.parts.map((p) => p.repo)).toEqual(["ci", "infra", "specfork"]);
  const md = reposMd(r.value);
  expect(md).toContain("## Repos");
  expect(md.indexOf("### ci")).toBeLessThan(md.indexOf("### infra"));
  expect(md).toContain("Lands after: infra.");
  expect(md).toContain("Works without the later parts: ci works without the later parts");
  // A part missing from the plan is refused, and a single-repo intent takes no parts.
  const missing = checkParts("specfork", ["infra"], [part("specfork")]);
  expect(missing).toEqual({ ok: false, why: expect.stringContaining("no part for infra") });
  expect(checkParts("specfork", [], [])).toEqual({ ok: true, value: { parts: [], dropped: [] } });
  // The section replaces the planner's own and goes before the files.
  const plan = withRepos("## Approach\n\nA.\n\n## Repos\n\nold\n\n## Files that change\n\n- x\n", md);
  expect(plan.match(/^## Repos$/gm)).toHaveLength(1);
  expect(plan.indexOf("## Repos")).toBeLessThan(plan.indexOf("## Files that change"));
  expect(plan).not.toContain("old");
});

test("plan: a cycle in the merge order is refused", () => {
  const r = checkParts("a", ["b"], [part("a", ["b"]), part("b", ["a"])]);
  expect(r).toEqual({ ok: false, why: expect.stringContaining("cycle") });
  const own = checkParts("a", ["b"], [part("a", ["a"]), part("b")]);
  expect(own).toEqual({ ok: false, why: expect.stringContaining("waits on itself") });
  // A part that doesn't say why it works alone is refused too.
  const unsafe = checkParts("a", ["b"], [part("a", ["b"]), { ...part("b"), safe_alone: " " }]);
  expect(unsafe).toEqual({
    ok: false,
    why: expect.stringContaining("works live without the parts after it"),
  });
});

test("plan: a repo the intent does not name is refused", () => {
  const extra = checkParts("a", ["b"], [part("a"), part("b"), part("zzz")]);
  expect(extra).toEqual({ ok: false, why: expect.stringContaining("zzz, which the intent doesn't name") });
  const waits = checkParts("a", ["b"], [part("a", ["zzz"]), part("b")]);
  expect(waits).toEqual({ ok: false, why: expect.stringContaining("waits on zzz") });
});

test("plan: a repo with no change is dropped from the parts", () => {
  const r = checkParts("a", ["b", "c"], [part("a", ["b", "c"]), part("b", [], ""), part("c")]);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.parts.map((p) => p.repo)).toEqual(["c", "a"]);
  expect(r.value.dropped).toEqual(["b"]);
  expect(reposMd(r.value)).toContain("No change in b, so it has no part.");
  // Waiting on the dropped repo is no wait; the lead can't be the one dropped.
  expect(reposMd(r.value)).toContain("Lands after: c.");
  const lead = checkParts("a", ["b"], [part("a", [], ""), part("b")]);
  expect(lead).toEqual({ ok: false, why: expect.stringContaining("always has a part") });
});

test("review: a plan whose early part breaks without a later one is a finding", () => {
  // The planner is told to order parts so each works alone, and the reviewer to flag one that doesn't.
  const plan = readFileSync("agents/plan.md", "utf8");
  expect(plan).toContain("backward compatible");
  expect(plan).toContain("`safe_alone`");
  const review = readFileSync("agents/review.md", "utf8");
  expect(review).toContain("would break the live app until a later part lands");
  expect(review).toMatch(/`important`\s+finding/);
  // A plan result without `repos` (a single-repo plan, or an older one) reads as no parts.
  const base = {
    brief: "b",
    plan: "p",
    access: { domains: [], paths: [], tests: [] },
    e2e: null,
    owner_steps: [],
    live_none_why: "",
    delivery: "code",
  };
  const parsed = parseResult("plan", base);
  expect(parsed.ok && parsed.value.repos).toEqual([]);
  const one = { repo: "a", change: "x", waits_on: [], safe_alone: "y" };
  expect(parseResult("plan", { ...base, repos: [one] }).ok).toBe(true);
  expect(parseResult("plan", { ...base, repos: [{ repo: "a" }] }).ok).toBe(false);
});
