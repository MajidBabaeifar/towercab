// PIP-220..222: every text for a person has a people part first and the agent part folded.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { loadAgent } from "../../src/agents.ts";
import { WRITING_GUIDE } from "../../src/claude.ts";
import { stageComment } from "../../src/github/comments.ts";
import { questionMd } from "../../src/pipeline/common.ts";
import {
  checkPeople,
  checkTwoPart,
  codeBody,
  fitPeople,
  PEOPLE_MAX_CHARS,
  planBody,
  specBody,
  splitTwoPart,
  twoPartMd,
  twoPartOr,
} from "../../src/pipeline/prtext.ts";
import { parseResult, SCHEMAS } from "../../src/pipeline/schemas.ts";
import { build, DESIGN, PLAN, REVIEW } from "../helpers/flows.ts";

const links = { intentUrl: "https://x/intent", specPrUrl: null, planPrUrl: null };
const people = "People can log in from a link in their email. Nothing needs deciding.";
const fold = (s: string) => `<details><summary>Agent context</summary>\n\n${s}\n\n</details>`;

test("pipeline: twoPartMd puts the people part first and folds the agent part", () => {
  const text = twoPartMd({ people, agent: "Files: src/a.ts\n\nFindings: none" });
  expect(text).toBe(`## For people\n\n${people}\n\n${fold("Files: src/a.ts\n\nFindings: none")}`);
  expect(checkTwoPart(text)).toBeNull();
});

test("pipeline: no fold when there is no agent detail", () => {
  expect(twoPartMd({ people })).toBe(`## For people\n\n${people}`);
  expect(twoPartMd({ people, agent: "  " })).not.toContain("<details>");
});

test("pipeline: every PR body opens with the people part and folds the agent part", () => {
  const spec = specBody("Adds WEB-3.", ["WEB-3"], links, [], people);
  const plan = planBody("## Approach\n\nA token.", { domains: [], paths: [], tests: [] }, links, "", people);
  const code = codeBody({
    worker: "## What this does\n\nIt logs in.",
    brief: people,
    intentTitle: "Log in",
    intentProblem: null,
    checks: { verify: "passed", proof: "proven", ci: "green", review: "approved" },
    unplanned: [],
    specIds: ["WEB-3"],
    links,
    reviewDetails: "All outcomes met.",
    footer: { intentUrl: null, costUsd: 1, secs: 60 },
  });
  for (const [name, body] of [
    ["spec", spec],
    ["plan", plan],
    ["code", code],
  ] as const) {
    expect(body.startsWith(`## For people\n\n${people}`), name).toBe(true);
    expect(body, name).toContain("<details><summary>Agent context</summary>");
    expect(checkTwoPart(body), name).toBeNull();
  }
  // The spec IDs, the checks and the review are agent detail; the footer stays after the fold.
  const folded = code.slice(code.indexOf("<details>"), code.indexOf("</details>"));
  for (const part of ["**Spec IDs:** WEB-3", "## Checks", "## Review details"])
    expect(folded).toContain(part);
  expect(code.trim().split("\n").pop()).toMatch(/^<sub>Built by Towercab/);
});

test("pipeline: stage, review and question comments open with the people part", () => {
  const stage = stageComment(
    "Build",
    1,
    { people, agent: "Handoff: step 2 next" },
    { agent: "builder", intent: "i" },
  );
  expect(stage).toMatch(
    /^<!-- towercab:build:1 -->\n\*\*Build\*\* · builder · i · round 1\n\n## For people\n\n/,
  );
  expect(stage).toContain(fold("Handoff: step 2 next"));
  const q = {
    context: "Two ways to split the totals; the code reads them in src/totals.ts.",
    question: "Split by currency?",
    // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
    options: [{ option: "Yes", then: "one row each" }],
    recommendation: "Yes",
  };
  const asked = questionMd(q, people);
  expect(asked.startsWith(`## For people\n\n${people}\n\n**Split by currency?**`)).toBe(true);
  expect(asked.endsWith(fold(q.context))).toBe(true);
  expect(checkTwoPart(asked)).toBeNull();
  // A question asked without a brief opens with the question as its people part, context folded.
  const bare = questionMd(q);
  expect(bare.startsWith("## For people\n\nSplit by currency?")).toBe(true);
  expect(bare.endsWith(fold(q.context))).toBe(true);
  expect(checkTwoPart(bare)).toBeNull();
});

test("pipeline: a reply to the owner's comment has the two parts", () => {
  const long = `Nothing to change: the file already does that.\n\n${"Details of how it was read. ".repeat(30)}`;
  const { people: p, agent } = splitTwoPart(long);
  expect(p).toBe("Nothing to change: the file already does that.");
  expect(agent).toContain("Details of how");
  expect(checkTwoPart(twoPartMd({ people: p, agent }))).toBeNull();
  // One long paragraph is cut to the limit; the rest moves to the agent part.
  const cut = splitTwoPart("x".repeat(2000));
  expect(cut.people.length).toBeLessThanOrEqual(PEOPLE_MAX_CHARS);
  expect(checkPeople(cut.people)).toBeNull();
  expect(cut.agent.length).toBeGreaterThan(1000);
});

test("pipeline: an over-long people part is refused", () => {
  expect(checkPeople("a\nb\nc\nd\ne\nf")).toBe("people part is 6 lines; the limit is 5");
  expect(checkPeople("x".repeat(601))).toBe("people part is 601 characters; the limit is 600");
  expect(() => twoPartMd({ people: "a\nb\nc\nd\ne\nf" })).toThrow("people part is 6 lines; the limit is 5");
  expect(checkPeople("one\n- a\n- b\n- c\n- d")).toBe("people part has a list of more than 3 items");
  expect(checkPeople("see ```code```")).toBe("people part contains a code fence");
});

test("pipeline: a brief stored before the limits is fitted, not refused", () => {
  // A mission in flight at deploy time: PR bodies built from its stored brief must not throw.
  const old = `${"A long sentence about the change. ".repeat(25)}\n- one\n- two\n- three\n- four\n\`\`\`x\`\`\``;
  expect(checkPeople(old)).not.toBeNull();
  const fitted = fitPeople(old);
  expect(checkPeople(fitted)).toBeNull();
  expect(fitted.endsWith("…")).toBe(true);
  for (const body of [
    specBody("t", [], links, [], old),
    planBody("## Approach\n\nA.", { domains: [], paths: [], tests: [] }, links, "", old),
  ])
    expect(checkTwoPart(body)).toBeNull();
  expect(fitPeople(people)).toBe(people);
});

test("pipeline: a reply that lists four or more files still has a valid people part", () => {
  const reply = ["Allowed:", "- a.ts", "- b.ts", "- c.ts", "- d.ts", "- e.ts"].join("\n");
  const two = splitTwoPart(reply);
  expect(checkPeople(two.people)).toBeNull();
  expect(two.agent).toContain("- d.ts");
  expect(() => twoPartMd(two)).not.toThrow();
  expect(checkTwoPart(twoPartMd(two))).toBeNull();
});

test("pipeline: a note of Towercab's own gets the two parts and a bad shape never loses it", () => {
  const note = twoPartOr("**Merge review:** both sides kept\n\nNothing was dropped.", "- `a.txt`: kept");
  expect(note.startsWith("## For people\n\n**Merge review:** both sides kept")).toBe(true);
  expect(note).toContain(fold("Nothing was dropped.\n\n- `a.txt`: kept"));
  expect(checkTwoPart(note)).toBeNull();
  // A people part that cannot pass is posted as it was rather than dropped.
  expect(twoPartOr("src/very/long/path.ts")).toBe("src/very/long/path.ts");
  // The check sees the whole people part, not its first line.
  expect(checkTwoPart(`## For people\n\n${"a\n".repeat(7)}\n${fold("x")}`)).toMatch(/lines/);
});

test("pipeline: a missing people part is refused", () => {
  expect(() => twoPartMd({ people: "  ", agent: "x" })).toThrow("people part is missing");
  expect(checkTwoPart(fold("only agent detail"))).toBe("people part is missing");
  expect(checkTwoPart("Just text, no heading.")).toBe("people part is missing");
});

test("pipeline: agent detail outside the fold is refused", () => {
  const open = `## For people\n\n${people}\n\n## Findings\n\n- a bug`;
  expect(checkTwoPart(open)).toBe("agent detail (Findings) is outside the folded block");
  expect(checkTwoPart(`## For people\n\n${people}\n\n**Spec IDs:** WEB-1`)).toBe(
    "agent detail (spec IDs) is outside the folded block",
  );
  expect(checkTwoPart(`## For people\n\n${people}\n\n${fold("## Findings\n\n- a bug")}`)).toBeNull();
  expect(checkPeople(`${people}\n<details>x</details>`)).toBe("people part contains a details block");
});

test("pipeline: a result with a long brief gets one continue for a shorter one", () => {
  const long = "word ".repeat(150);
  for (const [kind, ok, key] of [
    ["design", DESIGN, "brief"],
    ["plan", PLAN, "brief"],
    ["build", build(), "brief"],
    ["review", REVIEW, "brief"],
  ] as const) {
    const bad = parseResult(kind, { ...ok, [key]: long });
    expect(bad, kind).toMatchObject({ ok: false });
    expect((bad as { why: string }).why, kind).toContain("result.brief: people part is");
    expect(parseResult(kind, ok).ok, kind).toBe(true);
  }
  // The invalid result takes the existing path: one continue, then the wait (PIP-1).
  const src = readFileSync("src/pipeline/common.ts", "utf8");
  expect(src).toContain("if (!continued[kind])");
});

test("pipeline: the owner's own text is not checked", () => {
  // The check lives on Towercab's writers and agent results; a comment body from the owner is never parsed.
  const owner = `${"long ".repeat(400)}\n\n## Findings\n\n- anything`;
  expect(() => splitTwoPart(owner)).not.toThrow();
  expect(stageComment("Answer", 1, "short Towercab line")).toContain("short Towercab line");
});

test("schemas: every result a person reads has a people part and an agent part", () => {
  // `brief` is the people part and stays required (PIP-106); review and risk gain a required `agent`.
  for (const kind of ["review", "risk"] as const) {
    const s = SCHEMAS[kind] as { properties: Record<string, unknown>; required: string[] };
    expect(s.properties.agent, kind).toEqual({ type: "string" });
    expect(s.required, kind).toContain("agent");
  }
  expect(parseResult("review", { ...REVIEW, agent: "Walked the diff." })).toMatchObject({ ok: true });
  // A result from before `agent` reads as an empty agent part.
  expect((parseResult("review", REVIEW) as { value: { agent: string } }).value.agent).toBe("");
});

test("prompts: every agent that writes for the owner asks for the two parts", () => {
  for (const name of [
    "design",
    "plan",
    "worker",
    "repair",
    "review",
    "review-security",
    "review-infra",
    "risk",
    "merge-review",
  ] as const) {
    const prompt = loadAgent(name).prompt;
    expect(prompt, name).toMatch(/People part, agent part/);
    expect(prompt, name).toMatch(/at most 5 lines/);
  }
});

test("prompts: writing.md states the people part and agent part rule", () => {
  const guide = readFileSync(WRITING_GUIDE, "utf8");
  expect(guide).toContain("## People part, agent part");
  expect(guide).toMatch(/at most 5 lines and 600 characters/);
  expect(guide).toContain("Agent context");
});
