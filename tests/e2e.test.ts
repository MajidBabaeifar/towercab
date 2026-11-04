// One intent end to end (PIP-2, PIP-25, PIP-28, PIP-50, PIP-51, LOOP-6): pick → spec PR → plan PR →
// build → verify → proof → code PR → CI → review → gate → merge → done, with real git.

import { afterEach, expect, test } from "vitest";
import { getMission } from "../src/mission.ts";
import { Pipe, result } from "./helpers/pipe.ts";

const CLAUDE_MD = `# Web

## Verifying your work

\`\`\`checks
sh -c 'for t in tests/*.sh; do sh "$t" || exit 1; done'
\`\`\`
`;

const INTENT = (a: number) => `---
repo: web
u: 4
i: 4
a: ${a}
source: me
---

# Intent: Show a greeting

## Problem
Visitors see nothing.

## Proposed outcome
- The page says hello
`;

const design = result(
  {
    title: "Show a greeting",
    subject: "show a greeting",
    brief: "Visitors will see a hello.",
    type: "feat",
    scope: "",
    breaking: false,
    spec_ids: ["WEB-1"],
    concerns: [],
    open_questions: [],
    pr: "The page will greet visitors.",
  },
  { "specs/web.md": "# Web\n\n### WEB-1 · Greeting\n\nThe page says hello.\n" },
);
const plan = result({
  brief: "The build adds the hello.",
  plan: "## Approach\n\nAdd a greeting file.\n\n## Steps\n\n1. Test\n2. Code\n\n## Risks\n\nNone.\n\n## How to check it\n\nRun the tests.",
  access: { domains: [], paths: [], tests: [] },
  e2e: null,
});
const build = result(
  {
    status: "done",
    brief: "Visitors now see a hello.",
    pr: "## What this does\n\nThe page says hello.\n\n## Why\n\nVisitors saw nothing.\n\n## What to check before merging\n\nNothing special.\n\n## Changes\n\n- A greeting",
    notes: "added greeting",
    question: null,
    access: null,
    plan_changed: null,
    lower_a: null,
    lower_why: null,
  },
  { "greeting.txt": "hello\n", "tests/greeting.sh": "test -f greeting.txt\n" },
);
const review = result({
  brief: "It does what was asked.",
  approved: true,
  outcomes: [{ bullet: "The page says hello", met: true, why: "greeting.txt" }],
  tests_weakened: { value: false, where: "" },
  plan_followed: { value: true, where: "" },
  findings: [],
  door: "two-way",
  red_lines: [],
  summary: "Approve: small and tested.",
});

let saved: string | undefined;
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

test("e2e: an a5 intent goes from pick to done", async () => {
  saved = process.env.GIT_CONFIG_GLOBAL;
  const p = new Pipe(
    { "CLAUDE.md": CLAUDE_MD, "tests/base.sh": "true\n", "README.md": "web\n" },
    { "intents/261026-1000-show-a-greeting/intent.md": INTENT(5) },
  );
  p.script(design, plan, build, review);
  await p.start();
  const passes = await p.until(
    () => p.db.get<{ stage: string }>("SELECT stage FROM missions LIMIT 1")?.stage === "done",
  );
  await p.loop.pass(); // the done entry effect: the intent file
  const m = getMission(p.db, 1)!;
  expect(
    [m.stage, m.waiting, m.why],
    JSON.stringify(p.db.all("SELECT from_stage, event, to_stage, why FROM transitions")),
  ).toEqual(["done", null, null]);
  expect(passes).toBeGreaterThan(0);
  // The risk agent checks each of the three PRs in a session of its own (PIP-96).
  expect(p.claudeCalls.map((c) => c.kind)).toEqual([
    "design",
    "risk",
    "plan",
    "risk",
    "worker",
    "review",
    "risk",
  ]);
  // Three PRs, all merged; the spec landed first.
  expect(p.prs.map((x) => [x.repo, x.title, x.state])).toEqual([
    ["owner/web", "docs(specs): show a greeting", "MERGED"],
    ["owner/intents", "docs(plan): show a greeting", "MERGED"],
    ["owner/web", "feat: show a greeting", "MERGED"],
  ]);
  expect(p.show("web", "main", "specs/web.md")).toContain("WEB-1");
  expect(p.show("web", "main", "greeting.txt")).toBe("hello\n");
  const planMd = p.show("intents", "main", "done/261026-1000-show-a-greeting/plan.md");
  expect(planMd).toMatch(/^# Plan: Show a greeting/);
  expect(planMd).toContain("## Access");
  // The code PR reads like a person wrote it, then Towercab's facts.
  const code = p.prs[2]!;
  // PIP-108: the plain brief first, then the worker's technical text.
  expect(code.body).toMatch(/^## In plain words\n\nVisitors now see a hello\.\n\n## Risk: low/);
  expect(code.body).toContain("## What this does\n\nThe page says hello.");
  expect(code.body).toContain("- Test proof: the new tests fail without the change");
  expect(code.comments.some((c) => c.body.includes("<!-- towercab:review:1 -->"))).toBe(true);
  // The intent is done, with its cost, in done/.
  const intent = await p.store.get("261026-1000").catch(() => null);
  expect(intent).toBeNull();
  const done = p.show("intents", "main", "done/261026-1000-show-a-greeting/intent.md");
  expect(done).toMatch(/stage: done/);
  // The worker session reports its running total ($0.50) on each run, so design, plan and build add
  // $0.50 once (MET-28); the review is its own session: $1.00 in all.
  expect(done).toMatch(/cost: 1\.00\nagent_time: 240\nattempts: 1/);
});
