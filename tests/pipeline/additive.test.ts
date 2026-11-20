// The rules that resolve a conflict where both sides only added lines (PIP-167).

import { expect, test } from "vitest";
import { mergeHunk, mergeStatusLine, resolveText } from "../../src/pipeline/additive.ts";

const conflict = (ours: string, base: string, theirs: string) =>
  `<<<<<<< HEAD\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> origin/main\n`;

test("pipeline: a conflict where both sides added imports is resolved without a worker", () => {
  const h = {
    base: ['import { a } from "./x.ts";'],
    ours: ['import { a, c } from "./x.ts";'],
    theirs: ['import { a, b } from "./x.ts";'],
  };
  expect(mergeHunk(h)).toEqual(['import { a, b, c } from "./x.ts";']);
  // New import lines of one module become one import; other modules keep their own lines.
  expect(
    mergeHunk({
      base: [],
      ours: ['import { z } from "./x.ts";', 'import { y } from "./y.ts";'],
      theirs: ['import { b } from "./x.ts";'],
    }),
  ).toEqual(['import { b, z } from "./x.ts";', 'import { y } from "./y.ts";']);
  // A side that dropped a name the other kept is not additive.
  expect(
    mergeHunk({
      base: ['import { a, d } from "./x.ts";'],
      ours: ['import { a } from "./x.ts";'],
      theirs: ['import { a, d, b } from "./x.ts";'],
    }),
  ).toBeNull();
});

test("pipeline: a conflict where both sides added keys to a list is resolved without a worker", () => {
  const file = `const KEYS = [\n  "a",\n${conflict('  "ours",\n', "", '  "theirs",\n')}  "b",\n];\n`;
  expect(resolveText(file)).toEqual({
    text: 'const KEYS = [\n  "a",\n  "ours",\n  "theirs",\n  "b",\n];\n',
    hunks: 1,
  });
});

test("pipeline: spec Status lines from both sides are merged", () => {
  expect(
    mergeStatusLine(
      "**Status:** Live: PIP-1..54 · **Prefix:** PIP",
      "**Status:** Live: PIP-1..54, PIP-167 · **Prefix:** PIP",
      "**Status:** Live: PIP-1..54, PIP-160..166 · **Prefix:** PIP",
    ),
  ).toBe("**Status:** Live: PIP-1..54, PIP-160..167 · **Prefix:** PIP");
  expect(
    mergeStatusLine(
      "**Status:** Live: PIP-1..54 · **Prefix:** PIP",
      "**Status:** Live: PIP-1..40 · **Prefix:** PIP",
      "**Status:** Live: PIP-1..54, PIP-60 · **Prefix:** PIP",
    ),
  ).toBeNull();
  expect(mergeStatusLine("**Status:** Draft", "**Status:** Live", "**Status:** Draft")).toBeNull();
});

test("pipeline: a conflict where one side deleted a line goes to the worker", () => {
  // Ours removed `b`; theirs added a line next to it.
  expect(mergeHunk({ base: ["a", "b"], ours: ["a"], theirs: ["a", "b", "c"] })).toBeNull();
  expect(resolveText(conflict("a\n", "a\nb\n", "a\nb\nc\n"))).toBeNull();
  // Both sides only inserted: ours first, then theirs, around the lines they share.
  expect(mergeHunk({ base: ["a", "b"], ours: ["a", "x", "b"], theirs: ["a", "b", "y"] })).toEqual([
    "a",
    "x",
    "b",
    "y",
  ]);
});
