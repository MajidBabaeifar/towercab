// What Towercab checks in the observer's answer before it reaches GitHub (OBV-5, OBV-6, OBV-7).

import { expect, test } from "vitest";
import { type JudgeInput, judge } from "../../src/observer/findings.ts";
import { testConfig } from "../helpers/world.ts";
import { listing } from "../intents/fixtures.ts";
import { finding, proposedPr } from "./rig.ts";

function input(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    config: testConfig({ repos: { web: { github: "owner/web" } } }),
    ids: new Set(["i-1", "i-2"]),
    listing: listing([]),
    proposed: [],
    intentsRepo: "owner/intents",
    recent: [],
    earlier: [],
    ...over,
  };
}

test("observer: a finding with fewer than two citations is dropped", () => {
  const one = finding({ evidence: [{ id: "i-1", shows: "only one" }] });
  const twice = finding({
    evidence: [
      { id: "i-1", shows: "a" },
      { id: "i-1", shows: "the same id again" },
    ],
  });
  const j = judge([one, twice], input());
  expect(j.propose).toEqual([]);
  expect(j.dropped.map((d) => d.why)).toEqual(["fewer than two citations", "fewer than two citations"]);
});

test("observer: a cited id outside the bundle is dropped", () => {
  const j = judge(
    [
      finding({
        evidence: [
          { id: "i-1", shows: "real" },
          { id: "i-99", shows: "invented" },
        ],
      }),
    ],
    input(),
  );
  expect(j.propose).toEqual([]);
  expect(j.dropped[0]!.why).toContain("i-99");
});

test("observer: the title follows the naming rule", () => {
  const j = judge(
    [
      finding({ title: "Fix it" }),
      finding({ title: "# `Towercab` stops retrying a failing check @owner every time." }),
    ],
    input(),
  );
  expect(j.dropped).toHaveLength(1);
  expect(j.dropped[0]!.why).toContain("title:");
  expect(j.propose.map((f) => f.title)).toEqual(["Towercab stops retrying a failing check owner every time"]);
});

test("findings: a is clamped to 4", () => {
  const j = judge([finding({ a: 5 })], input());
  expect(j.propose[0]!.a).toBe(4);
});

test("findings: the same title twice in one run is proposed once", () => {
  const j = judge(
    [finding(), finding({ title: "  towercab stops retrying a check that fails the same way every time. " })],
    input(),
  );
  expect(j.propose).toHaveLength(1);
  expect(j.dropped.map((d) => d.why)).toEqual(["the same title twice in one run"]);
});

test("findings: the highest priority findings go first", () => {
  const titles = [
    "Towercab names the slow stage in plain words",
    "Towercab trims the cost of repair runs",
    "Towercab asks fewer yes or no questions",
  ];
  const config = testConfig({
    observer: { max_proposals_per_week: 2 },
    repos: { web: { github: "owner/web" } },
  });
  const j = judge(
    titles.map((title, n) => finding({ title, u: 1 + n, i: 1 + n })),
    input({ config }),
  );
  expect(j.propose.map((f) => f.title)).toEqual([titles[2], titles[1]]);
  expect(j.held.map((f) => f.title)).toEqual([titles[0]]);
});

test("findings: a comment leaves the room alone", () => {
  const prop = proposedPr(12, "Retries that never help");
  const j = judge(
    [
      finding({ overlaps: ["12"] }),
      finding({ title: "Towercab names the slow stage in plain words" }),
      finding({ title: "Towercab trims the cost of repair runs" }),
    ],
    input({
      proposed: [prop],
      recent: [{ pr: 1, intent: "x", run: 1, at: 0, title: "t", evidence: "[]" }],
    }),
  );
  // One of three used already, one comment: room for the other two.
  expect(j.comments).toHaveLength(1);
  expect(j.propose).toHaveLength(2);
});
