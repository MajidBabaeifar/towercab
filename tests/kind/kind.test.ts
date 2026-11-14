// The kind module (INT-76, INT-77, PIP-228) and the results of the kind agent and the infra plan (PIP-229).

import { expect, test } from "vitest";
import {
  isKind,
  kindNote,
  kindOf,
  needsDesign,
  parseKindComment,
  skippedStages,
  WORK_KINDS,
} from "../../src/kind.ts";
import { parseResult } from "../../src/pipeline/schemas.ts";

test("kind: an intent's own kind wins over the guess, and no kind counts as feature", () => {
  expect(kindOf("bugfix", { kind: "infra" })).toBe("bugfix");
  expect(kindOf(null, { kind: "infra" })).toBe("infra");
  expect(kindOf(undefined, {})).toBe("feature");
  expect(kindOf("nonsense", { kind: "nonsense" })).toBe("feature");
});

test("kind: only feature and spec-only start at design", () => {
  expect(WORK_KINDS.filter(needsDesign)).toEqual(["feature", "spec-only"]);
  expect(isKind("spec-only")).toBe(true);
  expect(isKind("docs")).toBe(false);
  expect(skippedStages("feature")).toEqual([]);
  for (const k of WORK_KINDS.filter((k) => k !== "feature"))
    expect(skippedStages(k).length).toBeGreaterThan(0);
});

test("kind: the note names a guess and how to change it, and says nothing for an owner's kind", () => {
  const note = kindNote({ kind: "bugfix", kindWhy: "It fixes a wrong total.", kindBy: "guess" });
  expect(note).toContain("guessed this is a bugfix: It fixes a wrong total.");
  expect(note).toContain("kind:");
  expect(kindNote({ kind: "bugfix", kindBy: "owner" })).toBe("");
  expect(kindNote({})).toBe("");
});

test("kind: a comment that is exactly kind: and a value switches", () => {
  expect(parseKindComment("kind: feature")).toBe("feature");
  expect(parseKindComment("  Kind: `spec-only`.  ")).toBe("spec-only");
  expect(parseKindComment("kind: chore")).toBeNull();
  expect(parseKindComment("please make it kind: feature")).toBeNull();
  expect(parseKindComment("kind: feature\nand more")).toBeNull();
});

test("kind: the agent's result needs a known kind and a short reason", () => {
  expect(parseResult("kind", { kind: "refactor", why: "Only code moves." }).ok).toBe(true);
  expect(parseResult("kind", { kind: "chore", why: "x" }).ok).toBe(false);
  expect(parseResult("kind", { kind: "bugfix", why: "x".repeat(161) }).ok).toBe(false);
});

const PLAN = {
  brief: "Fixes the build.",
  plan: "## Approach\n\nA long enough plan to read.\n\n## Steps\n\n1. Do the thing in the repo for real.",
  access: { domains: [], paths: [], tests: [] },
  e2e: null,
};

test("kind: a plan without apply reads as none, and apply is capped and never empty", () => {
  const ok = parseResult("plan", PLAN);
  expect(ok.ok && ok.value.apply).toEqual([]);
  const one = { command: "npm run build", why: "Shows the build works." };
  expect(parseResult("plan", { ...PLAN, apply: [one] }).ok).toBe(true);
  expect(parseResult("plan", { ...PLAN, apply: Array(6).fill(one) }).ok).toBe(false);
  expect(parseResult("plan", { ...PLAN, apply: [{ command: "  ", why: "x" }] }).ok).toBe(false);
});
