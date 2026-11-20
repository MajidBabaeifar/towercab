// PIP-114: every option of a question maps to something Towercab does.

import { expect, test } from "vitest";
import { testQuestion } from "../../src/pipeline/access.ts";
import { cacheWriteQuestion } from "../../src/pipeline/checks.ts";
import { branchInTheWay, questionMd } from "../../src/pipeline/common.ts";
import { parseResult, type Question } from "../../src/pipeline/schemas.ts";

const BUILD = (options: unknown[]) => ({
  status: "blocked",
  brief: "The agent needs you to pick.",
  pr: null,
  notes: "stuck",
  question: { context: "c", question: "q?", options, recommendation: "a" },
  access: null,
  plan_changed: null,
  lower_a: null,
  lower_why: null,
  steps_done: null,
  handoff: null,
});
// biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
const opt = (o: Record<string, unknown>) => ({ option: "a", then: "b", ...o });

test("pipeline: every question option maps to continue, steps or drop", () => {
  for (const d of ["continue", "steps", "drop"]) {
    expect(parseResult("build", BUILD([opt({ do: d })])).ok, d).toBe(true);
  }
  // The questions Towercab asks itself are all `continue`: the owner's reply is the answer.
  const own: Question[] = [
    branchInTheWay("towercab/x"),
    cacheWriteQuestion("web", "/cache", { path: "/cache/x", command: null }),
    testQuestion({ path: "tests/a.test.ts", why: "old" }),
  ];
  for (const q of own) {
    expect(q.options.length).toBeGreaterThan(0);
    for (const o of q.options) expect(["continue", "steps", "drop"]).toContain(o.do);
  }
});

test("pipeline: a question option without a valid action is asked again", () => {
  const missing = parseResult("build", BUILD([opt({})]));
  expect(missing.ok).toBe(false);
  const other = parseResult("build", BUILD([opt({ do: "merge" })]));
  expect(other.ok).toBe(false);
  if (!other.ok) expect(other.why).toMatch(/do must be one of continue, steps, drop/);
  // No option at all gives the owner nothing to pick.
  const none = parseResult("build", BUILD([]));
  expect(none.ok).toBe(false);
});

test("pipeline: question comment says what each option does", () => {
  const q: Question = {
    context: "c",
    question: "Who does it?",
    options: [
      // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
      { option: "Go on", then: "the worker tries again", do: "continue" },
      // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
      { option: "I do it", then: "you get a checklist", do: "steps" },
      // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
      { option: "Stop", then: "the intent ends", do: "drop" },
    ],
    recommendation: "Go on",
  };
  const md = questionMd(q);
  expect(md).toContain("- **Go on**: the worker tries again _(Carry on with the work)_");
  expect(md).toContain("- **I do it**: you get a checklist _(I'll do this myself: give me the steps)_");
  expect(md).toContain("- **Stop**: the intent ends _(Drop the intent)_");
});
