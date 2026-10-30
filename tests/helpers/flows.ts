// Shared pieces of pipeline flows: a target repo, intent files and Claude's usual answers, so each
// test only states what differs from the happy path.

import type { Mission } from "../../src/mission.ts";
import { type ClaudeReply, type ClaudeScript, LOW_RISK, type Pipe } from "./pipe.ts";

export const CLAUDE_MD = `# Web

## Verifying your work

\`\`\`checks
sh -c 'for t in tests/*.sh; do sh "$t" || exit 1; done'
\`\`\`
`;

/** The target repo: CLAUDE.md with a checks block, one passing test. */
export const TARGET: Record<string, string> = {
  "CLAUDE.md": CLAUDE_MD,
  "tests/base.sh": "true\n",
  "README.md": "web\n",
};

export const ID = "261026-1000";
export const SLUG = "show-a-greeting";
export const DIR = `intents/${ID}-${SLUG}`;

/** An intent file; `a` null leaves it out. */
export function intent(
  o: {
    a?: number | null;
    title?: string;
    repo?: string;
    extra?: string;
    body?: string;
    u?: number;
    i?: number;
  } = {},
): string {
  const a = o.a === undefined ? 5 : o.a;
  return `---
repo: ${o.repo ?? "web"}
u: ${o.u ?? 4}
i: ${o.i ?? 4}
${a === null ? "" : `a: ${a}\n`}source: me
${o.extra ?? ""}---

# Intent: ${o.title ?? "Show a greeting"}

## Problem
Visitors see nothing.

## Proposed outcome
- The page says hello
${o.body ?? ""}`;
}

/** The intents repo with one intent. */
export function intents(text: string = intent(), dir = DIR): Record<string, string> {
  return { [`${dir}/intent.md`]: text };
}

export const DESIGN = {
  type: "feat",
  scope: "",
  breaking: false,
  spec_ids: ["WEB-1"],
  concerns: [],
  open_questions: [],
  pr: "The page will greet visitors.",
};
export const SPEC = { "specs/web.md": "# Web\n\n### WEB-1 · Greeting\n\nThe page says hello.\n" };

export const PLAN_MD =
  "## Approach\n\nAdd a greeting file.\n\n## Steps\n\n1. Test\n2. Code\n\n## Risks\n\nNone.\n\n## How to check it\n\nRun the tests.";
export const PLAN = { plan: PLAN_MD, access: { domains: [], paths: [] }, e2e: null };

export const WORKER_PR =
  "## What this does\n\nThe page says hello.\n\n## Why\n\nVisitors saw nothing.\n\n## What to check before merging\n\nNothing special.\n\n## Changes\n\n- A greeting";

export function build(o: Record<string, unknown> = {}) {
  return {
    status: "done",
    pr: WORKER_PR,
    notes: "added greeting",
    question: null,
    access: null,
    plan_changed: null,
    lower_a: null,
    lower_why: null,
    ...o,
  };
}
export const CODE = { "greeting.txt": "hello\n", "tests/greeting.sh": "test -f greeting.txt\n" };

export const REVIEW = {
  approved: true,
  outcomes: [{ bullet: "The page says hello", met: true, why: "greeting.txt" }],
  tests_weakened: { value: false, where: "" },
  plan_followed: { value: true, where: "" },
  findings: [],
  door: "two-way",
  red_lines: [],
  summary: "Approve: small and tested.",
};

/** A reply: the structured result, the files written, and any other fields. */
export function reply(structured: unknown, edits?: Record<string, string | null>, more: ClaudeReply = {}) {
  const s: ClaudeScript = () => ({ structured, ...(edits ? { edits } : {}), ...more });
  return s;
}

/** Claude's happy-path answer per kind, used whenever no script is queued. */
export function happy(p: Pipe): void {
  p.respond.design = reply(DESIGN, SPEC);
  p.respond.plan = reply(PLAN);
  p.respond.worker = reply(build(), CODE);
  p.respond.review = reply(REVIEW);
}

/** A failing GitHub Actions check run. */
export function checkRun(
  name: string,
  conclusion: string,
  run = 101,
  status = "COMPLETED",
  startedAt?: string,
) {
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    startedAt: startedAt ?? "2026-10-26T12:00:00Z",
    detailsUrl: `https://github.com/owner/web/actions/runs/${run}/job/1`,
  };
}

/** A risk agent's answer (PIP-96): the default low risk with `o` over it. */
export function risk(o: Record<string, unknown> = {}) {
  return { ...LOW_RISK, ...o };
}

/** The owner merges whatever PR a mission waits on. */
export function ownerMerges(p: Pipe): void {
  for (const m of p.db.all<Mission>("SELECT * FROM missions WHERE stage LIKE 'approval:%' AND step = ''")) {
    const [repo, n] =
      m.stage === "approval:spec"
        ? ["web", m.spec_pr]
        : m.stage === "approval:plan"
          ? ["intents", m.plan_pr]
          : ["web", m.pr];
    const pr = p.prNo(repo!, n!);
    if (pr.state === "OPEN") p.mergePr(pr);
  }
}
