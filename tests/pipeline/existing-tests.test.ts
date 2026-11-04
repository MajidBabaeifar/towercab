// Existing tests are read-only for the worker (REPO-13, PIP-115..118): blocked from the first round,
// granted by the plan or the owner, refused for good, and checked again at publish.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { planGate } from "../../src/autonomy.ts";
import type { Ctx } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import {
  answerTest,
  blockedTests,
  parseAccess,
  readsAsAllow,
  renderAccess,
  sortTestRequests,
  testGrantsOf,
  testQuestion,
} from "../../src/pipeline/access.ts";
import {
  ASK_TEST,
  existingChanged,
  existingTests,
  type GuardRules,
  guardDecision,
  publishRefusals,
  runGuardHook,
  writeGuardRules,
} from "../../src/pipeline/guard.ts";
import { TESTS_WHY } from "../../src/pipeline/plan.ts";
import { codeBody, planBody } from "../../src/pipeline/prtext.ts";
import { extraAccess } from "../../src/pipeline/risk.ts";
import { DEFAULT_TESTS } from "../../src/repo/files.ts";
import { Protected } from "../../src/repo/protected.ts";
import { riskFloor } from "../../src/risk.ts";
import { existingTestsOf } from "../../src/ui/state.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

/** A repo whose `main` holds `files`, with `refs/remotes/origin/main` at it (Towercab's checkout). */
function repoWith(files: Record<string, string>): string {
  const repo = join(tempDir(), "co");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  put(repo, files);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

function put(repo: string, files: Record<string, string>): void {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), t);
  }
}

const BASE = {
  "tests/a.test.ts": "a",
  "tests/b.test.ts": "b",
  "src/c.spec.ts": "c",
  "src/main.ts": "m",
  "README.md": "r",
};

const mission = (data: unknown) => ({ data: JSON.stringify(data) }) as Mission;
const rules = (over: Partial<GuardRules>): GuardRules => ({
  checkout: "/x",
  protected: [],
  granted: [],
  locked: [],
  existing: [],
  ...over,
});

test("repo: existing tests are blocked", async () => {
  const repo = repoWith(BASE);
  const existing = await existingTests(new FakeTools(), repo, "main", DEFAULT_TESTS, null);
  expect(existing.sort()).toEqual(["src/c.spec.ts", "tests/a.test.ts", "tests/b.test.ts"]);
  // Nothing granted: every one of them is blocked; the guard says so and how to ask.
  const blocked = blockedTests(existing, {});
  expect(blocked.sort()).toEqual(existing.sort());
  for (const rel of blocked) {
    const d = guardDecision(rules({ checkout: repo, existing: blocked }), { file_path: join(repo, rel) });
    expect(d.block && d.reason, rel).toBe(`${rel} is an existing test: ${ASK_TEST}`);
  }
});

test("repo: new tests are not blocked", async () => {
  const repo = repoWith(BASE);
  const existing = await existingTests(new FakeTools(), repo, "main", DEFAULT_TESTS, null);
  const r = rules({ checkout: repo, existing });
  expect(guardDecision(r, { file_path: join(repo, "tests/new.test.ts") })).toEqual({ block: false });
  expect(guardDecision(r, { file_path: join(repo, "src/main.ts") })).toEqual({ block: false });
});

test("repo: granted tests unblock", async () => {
  const repo = repoWith(BASE);
  const existing = await existingTests(new FakeTools(), repo, "main", DEFAULT_TESTS, null);
  const state = {
    granted: { tests: [{ path: "tests/a.test.ts", why: "the greeting changed" }] },
    testAllowed: [{ path: "src/c.spec.ts", why: "renamed export" }],
  };
  expect(testGrantsOf(state)).toEqual([
    { path: "tests/a.test.ts", why: "the greeting changed", by: "plan" },
    { path: "src/c.spec.ts", why: "renamed export", by: "owner" },
  ]);
  const blocked = blockedTests(existing, state);
  expect(blocked).toEqual(["tests/b.test.ts"]);
  const r = rules({ checkout: repo, existing: blocked });
  expect(guardDecision(r, { file_path: join(repo, "tests/a.test.ts") })).toEqual({ block: false });
  expect(guardDecision(r, { file_path: join(repo, "tests/b.test.ts") }).block).toBe(true);
});

test("guard: blocks an existing test", () => {
  const root = tempDir();
  const checkout = join(root, "c");
  mkdirSync(join(checkout, "tests"), { recursive: true });
  const runs = join(root, "runs");
  mkdirSync(runs);
  const file = writeGuardRules(runs, rules({ checkout, existing: ["tests/a.test.ts"] }));
  expect(JSON.parse(readFileSync(file, "utf8")).existing).toEqual(["tests/a.test.ts"]);
  const input = (p: string) =>
    JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(checkout, p) } });
  const blocked = runGuardHook(file, input("tests/a.test.ts"));
  expect(blocked.code).toBe(2);
  expect(blocked.stderr).toBe(`tests/a.test.ts is an existing test: ${ASK_TEST}\n`);
  expect(runGuardHook(file, input("tests/new.test.ts")).code).toBe(0);
  // A rules file without the list fails closed.
  writeFileSync(file, JSON.stringify({ checkout, protected: [], granted: [], locked: [] }));
  expect(runGuardHook(file, input("tests/new.test.ts")).code).toBe(2);
});

test("pipeline: plan.md lists existing tests to change", () => {
  const access = {
    domains: [],
    paths: [],
    tests: [{ path: "tests/a.test.ts", why: "the greeting\nchanged" }],
  };
  const md = renderAccess(access, 5, ["tests/new.test.ts"]);
  expect(md).toContain("- [x] test: tests/a.test.ts (the greeting changed)");
  expect(md).not.toContain("Nothing beyond what the level grants.");
  expect(md).toContain("tests/new.test.ts");
  // The plan PR says it, too.
  const links = { intentUrl: null, specPrUrl: null, planPrUrl: null };
  expect(planBody("## Approach\n\nA.", access, links)).toContain(
    "**Access asked for:** changing the existing test tests/a.test.ts.",
  );
  // The dropped sentence is not read back as a grant.
  expect(parseAccess(md).tests).toEqual([{ path: "tests/a.test.ts", why: "the greeting changed" }]);
});

test("pipeline: merged plan grants its ticked tests", () => {
  const md = renderAccess(
    {
      domains: [],
      paths: [],
      tests: [
        { path: "tests/a.test.ts", why: "one" },
        { path: "tests/b.test.ts", why: "two" },
      ],
    },
    4,
  );
  const granted = parseAccess(`# Plan: X\n\n## Steps\n\n- [x] test: tests/z.test.ts (a step)\n\n${md}`);
  expect(granted.tests.map((t) => t.path)).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  const state = { granted };
  expect(testGrantsOf(state).map((g) => [g.path, g.by])).toEqual([
    ["tests/a.test.ts", "plan"],
    ["tests/b.test.ts", "plan"],
  ]);
  expect(blockedTests(["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"], state)).toEqual([
    "tests/c.test.ts",
  ]);
});

test("pipeline: unticked test is not granted", () => {
  const md = renderAccess(
    {
      domains: [],
      paths: [],
      tests: [
        { path: "tests/a.test.ts", why: "one" },
        { path: "tests/b.test.ts", why: "two" },
      ],
    },
    4,
  ).replace("- [x] test: tests/b.test.ts", "- [ ] test: tests/b.test.ts");
  const granted = parseAccess(md);
  expect(granted.tests).toEqual([{ path: "tests/a.test.ts", why: "one" }]);
  expect(blockedTests(["tests/a.test.ts", "tests/b.test.ts"], { granted })).toEqual(["tests/b.test.ts"]);
});

test("pipeline: a plan that changes existing tests waits for the owner at a5", () => {
  // Low risk at a5 would go ahead alone; a plan that lists tests never does, at any autonomy.
  expect(planGate(5, "low", false)).toBe(false);
  expect(planGate(5, "low", true)).toBe(true);
  expect(planGate(4, "low", true)).toBe(true);
  expect(TESTS_WHY).toBe("The plan asks to change existing tests; you decide which.");
});

test("pipeline: a plan that changes existing tests is at least medium risk", () => {
  const m = mission({
    plan: { access: { domains: [], paths: [], tests: [{ path: "tests/a.test.ts", why: "w" }] } },
  });
  const cx = { config: { agent: { network: [] } } } as unknown as Ctx;
  const access = extraAccess(cx, m);
  expect(access).toEqual(["test: tests/a.test.ts"]);
  const easy = {
    blast_radius: { size: "small" as const, who: "x" },
    door: { kind: "two-way" as const, why: "x" },
    certainty: { level: "high" as const, why: "x" },
  };
  expect(riskFloor(easy, { access }).level).toBe("medium");
  expect(riskFloor(easy, {}).level).toBe("low");
});

test("pipeline: an unplanned test change asks the owner", () => {
  const q = testQuestion({ path: "tests/a.test.ts", why: "the greeting\nchanged" });
  expect(q.context).toContain("`tests/a.test.ts`");
  expect(q.context).toContain("the greeting changed");
  expect(q.question).toBe("May the worker change `tests/a.test.ts`?");
  expect(q.options.map((o) => o.option)).toEqual(["Allow this change", "Keep the test as it is"]);
  expect(q.recommendation).not.toBe("");
  // A test the plan already granted is not asked about; a blocked one is, once; a non-test is skipped.
  const state = { granted: { tests: [{ path: "tests/a.test.ts", why: "w" }] } };
  const asked = [
    { path: "tests/a.test.ts", why: "w" },
    { path: "tests/b.test.ts", why: "w2" },
    { path: "tests/b.test.ts", why: "again" },
    { path: "src/new.ts", why: "w3" },
  ];
  expect(sortTestRequests(asked, state, ["tests/a.test.ts", "tests/b.test.ts"])).toEqual({
    ask: [{ path: "tests/b.test.ts", why: "w2" }],
    refused: [],
    granted: ["tests/a.test.ts"],
    notBlocked: ["src/new.ts"],
  });
});

test("pipeline: allowing a test grants that file", () => {
  for (const yes of ["Allow this change", "yes", "OK, go ahead"]) expect(readsAsAllow(yes), yes).toBe(true);
  const ask = { path: "tests/a.test.ts", why: "w", rest: [] };
  const r = answerTest(ask, {}, "Allow this change");
  expect(r.patch).toEqual({ testAllowed: [{ path: "tests/a.test.ts", why: "w" }] });
  expect(r.note).toContain("allowed you to change tests/a.test.ts");
  // The grant is the one file, and it is no longer blocked.
  expect(blockedTests(["tests/a.test.ts", "tests/b.test.ts"], r.patch)).toEqual(["tests/b.test.ts"]);
});

test("pipeline: a refused test stays blocked", () => {
  for (const no of ["Keep the test as it is", "no", "yes, but not that one", "maybe", "", undefined]) {
    expect(readsAsAllow(no), String(no)).toBe(false);
  }
  const ask = { path: "tests/a.test.ts", why: "w", rest: [] };
  const r = answerTest(ask, {}, "Keep the test as it is");
  expect(r.patch).toEqual({ refusedTests: [{ path: "tests/a.test.ts", why: "w" }] });
  expect(r.note).toContain("refused");
  // Still blocked, and asking again is answered at once, not put to the owner twice.
  expect(blockedTests(["tests/a.test.ts"], r.patch)).toEqual(["tests/a.test.ts"]);
  expect(sortTestRequests([{ path: "tests/a.test.ts", why: "again" }], r.patch, ["tests/a.test.ts"])).toEqual(
    {
      ask: [],
      refused: ["tests/a.test.ts"],
      granted: [],
      notBlocked: [],
    },
  );
});

const noProtected = new Protected([], []);

test("pipeline: publish refuses an ungranted change to an existing test", async () => {
  const repo = repoWith(BASE);
  git(repo, "checkout", "-q", "-b", "towercab/x");
  put(repo, { "tests/a.test.ts": "a-weakened", "src/main.ts": "m2" });
  git(repo, "commit", "-q", "-am", "build");
  const existing = await existingTests(new FakeTools(), repo, "main", DEFAULT_TESTS, null);
  const changed = await existingChanged(new FakeTools(), repo, "main", blockedTests(existing, {}));
  expect(changed).toEqual(["tests/a.test.ts"]);
  expect(publishRefusals(["src/main.ts", "tests/a.test.ts"], noProtected, [], [], changed)).toEqual([
    "tests/a.test.ts (an existing test)",
  ]);
});

test("pipeline: publish refuses deleting an existing test", async () => {
  const repo = repoWith(BASE);
  git(repo, "checkout", "-q", "-b", "towercab/x");
  git(repo, "rm", "-q", "tests/b.test.ts");
  git(repo, "commit", "-q", "-m", "build");
  const changed = await existingChanged(new FakeTools(), repo, "main", [
    "tests/a.test.ts",
    "tests/b.test.ts",
  ]);
  expect(changed).toEqual(["tests/b.test.ts"]);
  expect(publishRefusals([], noProtected, [], [], changed)).toEqual(["tests/b.test.ts (an existing test)"]);
});

test("pipeline: new tests and granted tests pass publish", async () => {
  const repo = repoWith(BASE);
  git(repo, "checkout", "-q", "-b", "towercab/x");
  put(repo, { "tests/new.test.ts": "new", "tests/a.test.ts": "a-changed" });
  git(repo, "commit", "-q", "-am", "build");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "more");
  const existing = await existingTests(new FakeTools(), repo, "main", DEFAULT_TESTS, null);
  // tests/a.test.ts was granted by the plan: only the others stay blocked.
  const state = { granted: { tests: [{ path: "tests/a.test.ts", why: "w" }] } };
  const changed = await existingChanged(new FakeTools(), repo, "main", blockedTests(existing, state));
  expect(changed).toEqual([]);
  expect(publishRefusals(["tests/new.test.ts", "tests/a.test.ts"], noProtected, [], [], changed)).toEqual([]);
});

test("pipeline: a merge of the base may bring in test changes", async () => {
  const repo = repoWith(BASE);
  git(repo, "checkout", "-q", "-b", "towercab/x");
  put(repo, { "src/main.ts": "m2" });
  git(repo, "commit", "-q", "-am", "build");
  // The base changes a test; a conflict round merges it into the branch.
  git(repo, "checkout", "-q", "main");
  put(repo, { "tests/a.test.ts": "a-from-main" });
  git(repo, "commit", "-q", "-am", "main changes a test");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "checkout", "-q", "towercab/x");
  git(repo, "merge", "-q", "--no-edit", "main");
  const blocked = ["tests/a.test.ts", "tests/b.test.ts"];
  expect(await existingChanged(new FakeTools(), repo, "main", blocked)).toEqual([]);
  // The worker's own edit of another test, on top of the merge, is still refused.
  put(repo, { "tests/b.test.ts": "b-weakened" });
  git(repo, "commit", "-q", "-am", "repair");
  expect(await existingChanged(new FakeTools(), repo, "main", blocked)).toEqual(["tests/b.test.ts"]);
});

test("pipeline: the code PR lists granted existing tests", () => {
  const body = (tests: Parameters<typeof codeBody>[0]["tests"]) =>
    codeBody({
      worker: "## What this does\n\nIt greets.",
      brief: "It greets people.",
      intentTitle: "Greet",
      intentProblem: null,
      checks: null,
      unplanned: [],
      tests,
      specIds: [],
      links: { intentUrl: null, specPrUrl: null, planPrUrl: null },
      reviewDetails: null,
      footer: { intentUrl: null, costUsd: 1, secs: 60 },
    });
  const text = body([
    { path: "tests/a.test.ts", why: "the greeting changed", by: "plan" },
    { path: "tests/b.test.ts", why: "renamed export", by: "owner" },
  ]);
  expect(text).toContain(
    "## Tests changed beyond new ones\n\n- `tests/a.test.ts`: the greeting changed (allowed by the approved plan)\n- `tests/b.test.ts`: renamed export (allowed by you)",
  );
  expect(body([])).not.toContain("Tests changed beyond new ones");
  expect(body(undefined)).not.toContain("Tests changed beyond new ones");
});

test("ui: the intent page lists granted existing tests", () => {
  const m = mission({
    granted: { domains: [], paths: [], tests: [{ path: "tests/a.test.ts", why: "the greeting changed" }] },
    testAllowed: [{ path: "tests/b.test.ts", why: "renamed export" }],
    refusedTests: [{ path: "tests/c.test.ts", why: "wanted to drop a check" }],
  });
  expect(existingTestsOf(m)).toEqual([
    { path: "tests/a.test.ts", why: "the greeting changed", by: "plan" },
    { path: "tests/b.test.ts", why: "renamed export", by: "owner" },
    { path: "tests/c.test.ts", why: "wanted to drop a check", by: "refused" },
  ]);
  expect(existingTestsOf(mission({}))).toEqual([]);
});
