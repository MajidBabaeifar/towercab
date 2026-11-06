// The repair lock on pushed tests (PIP-31, PIP-151..153): only tests on the base stay locked, the owner's
// allow unlocks one, and a merge of the base may adapt a test the base itself changed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { next } from "../../src/machine.ts";
import { reverseRefusals } from "../../src/pipeline/access.ts";
import {
  existingTests,
  guardDecision,
  lockableTests,
  lockedTests,
  openedByMerge,
  publishRefusals,
} from "../../src/pipeline/guard.ts";
import { refusalWait } from "../../src/pipeline/publish.ts";
import { DEFAULT_TESTS } from "../../src/repo/files.ts";
import { Protected } from "../../src/repo/protected.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

const tools = new FakeTools();
const noProtected = new Protected([], []);

function put(repo: string, files: Record<string, string>): void {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), t);
  }
}

/** A checkout whose `main` holds `files` (also as `origin/main`). */
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

const BASE = { "tests/a.test.ts": "a", "tests/b.test.ts": "b", "src/main.ts": "m" };

/** A branch with its first push done: it added tests/new.test.ts. Returns the repo and the pushed head. */
function pushed(): { repo: string; head: string } {
  const repo = repoWith(BASE);
  git(repo, "checkout", "-q", "-b", "towercab/x");
  put(repo, { "tests/new.test.ts": "n1", "src/main.ts": "m2" });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "build");
  return { repo, head: git(repo, "rev-parse", "HEAD").trim() };
}

/** What a repair round that changed `files` leaves for publish: the refusals, with the lock as the build computes it. */
async function round(
  repo: string,
  head: string,
  files: Record<string, string>,
  d: Parameters<typeof lockableTests>[2] = {},
  opened: string[] = [],
): Promise<{ refusals: string[]; locked: string[] }> {
  put(repo, files);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "repair");
  const onBase = await existingTests(tools, repo, "main", DEFAULT_TESTS, null);
  const locked = lockableTests(await lockedTests(tools, repo, head, DEFAULT_TESTS), onBase, d).filter(
    (p) => !opened.includes(p),
  );
  const sinceHead = git(repo, "diff", "--name-status", `${head}..HEAD`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, ...p] = l.split("\t");
      return { status: status ?? "", path: p[p.length - 1] ?? "" };
    });
  return { refusals: publishRefusals([], noProtected, sinceHead, locked), locked };
}

test("pipeline: a repair round may edit a test the pull request added", async () => {
  const { repo, head } = pushed();
  const r = await round(repo, head, { "tests/new.test.ts": "n2" });
  expect(r.refusals).toEqual([]);
  expect(r.locked).not.toContain("tests/new.test.ts");
  // The guard leaves it writable too, in this and every later round.
  const rules = { checkout: repo, protected: [], granted: [], locked: r.locked, existing: [] };
  expect(guardDecision(rules, { file_path: join(repo, "tests/new.test.ts") })).toEqual({ block: false });
});

test("pipeline: a repair round that edits a test from the base still waits", async () => {
  const { repo, head } = pushed();
  const r = await round(repo, head, { "tests/a.test.ts": "a-weakened" });
  expect(r.locked.sort()).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  expect(r.refusals).toEqual(["tests/a.test.ts (a test already pushed)"]);
  const rules = { checkout: repo, protected: [], granted: [], locked: r.locked, existing: [] };
  expect(guardDecision(rules, { file_path: join(repo, "tests/a.test.ts") }).block).toBe(true);
});

test("pipeline: a granted test is not locked in a repair round", async () => {
  const { repo, head } = pushed();
  const d = {
    granted: { tests: [{ path: "tests/a.test.ts", why: "plan" }] },
    testAllowed: [{ path: "tests/b.test.ts", why: "owner" }],
  };
  const r = await round(repo, head, { "tests/a.test.ts": "a2", "tests/b.test.ts": "b2" }, d);
  expect(r.locked).toEqual([]);
  expect(r.refusals).toEqual([]);
});

test("pipeline: proof runs again after a round that edited a test", () => {
  // Every build round, repair rounds included, goes on to verify and then to the proof (PIP-30).
  for (const stage of ["verify", "proof", "ci", "review"] as const) {
    expect(next(stage, "red")).toMatchObject({ kind: "go", to: "build" });
  }
  expect(next("build", "ok")).toMatchObject({ to: "verify" });
  expect(next("verify", "ok")).toMatchObject({ to: "proof" });
  expect(next("proof", "ok")).toMatchObject({ to: "publish" });
});

test("pipeline: the review prompt asks to flag a fix round that weakens the PR's own tests", () => {
  const review = readFileSync("agents/review.md", "utf8");
  expect(review).toContain("Flag a fix round that weakens\n   the PR's own tests");
});

test("pipeline: an allowed locked test passes publish in later rounds", async () => {
  const { repo, head } = pushed();
  // A round stopped on tests/a.test.ts; the owner allows it.
  const stop = await round(repo, head, { "tests/a.test.ts": "a2" });
  expect(stop.refusals).toHaveLength(1);
  const wait = refusalWait(stop.refusals, []);
  const d = { lockedTests: (wait.data as { lockedTests: string[] }).lockedTests };
  const r = reverseRefusals(d, ["tests/a.test.ts"]);
  const after = { ...d, ...r.patch };
  // The grant is in the data every later round (CI, review, an answer) reads: nothing is refused.
  for (const edit of ["a3", "a4", "a5"]) {
    const later = await round(repo, head, { "tests/a.test.ts": edit }, after);
    expect(later.refusals).toEqual([]);
  }
});

test("pipeline: a stop on the repair lock names the path and how to allow it", () => {
  const w = refusalWait(
    ["tests/a.test.ts (a test already pushed)", "src/x.ts (protected)"],
    ["tests/z.test.ts"],
  );
  expect(w.why).toContain("tests/a.test.ts (a test already pushed)");
  expect(w.why).toContain("Reply `allow <path>` to let the worker edit it.");
  expect(w.data).toEqual({ lockedTests: ["tests/z.test.ts", "tests/a.test.ts"] });
  // No test among them: the old wait, with nothing recorded.
  const plain = refusalWait(["src/x.ts (protected)"], []);
  expect(plain.why).not.toContain("allow");
  expect(plain.data).toBeUndefined();
});

/** A branch that edited tests/a.test.ts and imports src/lib.ts; the base then changes `change`. */
function diverged(change: Record<string, string>): { repo: string } {
  const repo = repoWith({
    "tests/a.test.ts": 'import { f } from "../src/lib.js";\n',
    "tests/b.test.ts": 'import { g } from "../src/other.js";\n',
    "src/lib.ts": "export const f = 1;\n",
    "src/other.ts": "export const g = 1;\n",
  });
  git(repo, "checkout", "-q", "-b", "towercab/x");
  put(repo, { "src/new.ts": "x" });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "build");
  git(repo, "checkout", "-q", "main");
  put(repo, change);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main moves");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "checkout", "-q", "towercab/x");
  return { repo };
}

test("pipeline: a merge of the base may edit a pushed test whose imported source changed on the base", async () => {
  const { repo } = diverged({ "src/lib.ts": "export const f = 2;\n" });
  const opened = await openedByMerge(tools, repo, "main", ["tests/a.test.ts", "tests/b.test.ts"]);
  expect(opened).toEqual(["tests/a.test.ts"]);
});

test("pipeline: a merge of the base may edit a pushed test that changed on the base", async () => {
  const { repo } = diverged({ "tests/b.test.ts": 'import { g } from "../src/other.js";\n// changed\n' });
  const opened = await openedByMerge(tools, repo, "main", ["tests/a.test.ts", "tests/b.test.ts"]);
  expect(opened).toEqual(["tests/b.test.ts"]);
});

test("pipeline: a conflict round can't edit a pushed test the base did not touch", async () => {
  const { repo } = diverged({ "README.md": "docs" });
  expect(await openedByMerge(tools, repo, "main", ["tests/a.test.ts", "tests/b.test.ts"])).toEqual([]);
  // A change to a file the test does not import, or one outside src/, opens nothing either.
  const other = diverged({ "src/unrelated.ts": "x", "lib/lib.ts": "y" });
  expect(await openedByMerge(tools, other.repo, "main", ["tests/a.test.ts"])).toEqual([]);
});
