// A conflict resolved by code, against real git repos (PIP-167, PIP-168).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { applyOwnDiff, resolveConflicts } from "../../src/pipeline/mechanical.ts";
import { git, tempDir } from "../helpers/world.ts";

const AUTHOR = [
  "-c",
  "user.name=towercab[bot]",
  "-c",
  "user.email=bot@localhost",
  "-c",
  "commit.gpgsign=false",
];

function put(dir: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, "add", "-A");
}

/** A PR branch (ours) and `main` (theirs) off a common base, with `main` merged into the PR: conflicted. */
function conflicted(
  base: Record<string, string>,
  ours: Record<string, string>,
  theirs: Record<string, string>,
) {
  const dir = tempDir("tc-mech-");
  git(dir, "init", "-q", "-b", "main");
  put(dir, base);
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "pr");
  put(dir, ours);
  git(dir, "commit", "-q", "-m", "ours");
  git(dir, "checkout", "-q", "main");
  put(dir, theirs);
  git(dir, "commit", "-q", "-m", "theirs");
  git(dir, "checkout", "-q", "pr");
  try {
    git(dir, "merge", "--no-edit", "main");
  } catch {
    // The conflict is the point.
  }
  const files = git(dir, "diff", "--name-only", "--diff-filter=U").trim().split("\n").filter(Boolean);
  const run = async (args: string[]) => git(dir, ...args);
  return { dir, files, run, resolve: () => resolveConflicts(run, dir, files, AUTHOR, "main into pr") };
}

const CSS = (a: string, mid = "", end = "") =>
  `.a {\n  color: ${a};\n}\n\n}\n\n${mid}.z {\n  top: 0;\n}\n${end}`;

test("pipeline: a conflict that splits a CSS block is resolved by applying the PR's diff", async () => {
  // Git itself merges these two changes, so the route is tried on the merge in progress: the PR's own
  // diff of the file (a new rule) lands on the base branch's file (an edited declaration).
  const c = conflicted(
    { "s.css": CSS("red") },
    { "s.css": CSS("red", ".ours {\n  left: 1;\n}\n\n") },
    { "s.css": CSS("green") },
  );
  expect(c.files).toEqual([]);
  git(c.dir, "reset", "-q", "--hard", "HEAD^1");
  git(c.dir, "merge", "--no-commit", "--no-ff", "main");
  expect(await applyOwnDiff(c.run, "s.css")).toBe(CSS("green", ".ours {\n  left: 1;\n}\n\n"));
  // A conflicted pair where both sides added a rule and the base's side also edited the rule's lines is
  // resolved the same way when the PR only added (here: the hunk rule alone keeps both).
  const both = conflicted(
    { "s.css": CSS("red") },
    { "s.css": CSS("red", ".ours {\n  left: 1;\n}\n\n") },
    { "s.css": CSS("red", ".theirs {\n  right: 1;\n}\n\n") },
  );
  const mech = await both.resolve();
  expect(mech).not.toBeNull();
  expect(readFileSync(join(both.dir, "s.css"), "utf8")).toBe(
    CSS("red", ".ours {\n  left: 1;\n}\n\n.theirs {\n  right: 1;\n}\n\n"),
  );
  // One merge commit with both parents.
  expect(git(both.dir, "log", "-1", "--format=%p").trim().split(" ")).toHaveLength(2);
});

test("mechanical: a line the PR deleted is left to the worker, whatever the base added", async () => {
  const c = conflicted({ "l.txt": "a\nb\nc\n" }, { "l.txt": "a\nc\n" }, { "l.txt": "a\nb\nx\nc\n" });
  expect(c.files).toEqual(["l.txt"]);
  expect(await c.resolve()).toBeNull();
  expect(git(c.dir, "diff", "--name-only", "--diff-filter=U").trim()).toBe("l.txt");
});

test("pipeline: a PR diff that does not apply cleanly goes to the worker", async () => {
  // The PR changed a line the base changed too: its diff does not fit the base's file.
  const c = conflicted({ "s.css": CSS("red") }, { "s.css": CSS("blue") }, { "s.css": CSS("green") });
  const before = git(c.dir, "rev-parse", "HEAD");
  expect(await c.resolve()).toBeNull();
  // Nothing committed, and the file is conflicted as the merge left it (no diff3 sections).
  expect(git(c.dir, "rev-parse", "HEAD")).toBe(before);
  expect(git(c.dir, "diff", "--name-only", "--diff-filter=U").trim()).toBe("s.css");
  const text = readFileSync(join(c.dir, "s.css"), "utf8");
  expect(text).toContain("<<<<<<<");
  expect(text).not.toContain("|||||||");
});
