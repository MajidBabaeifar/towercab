import { expect, test } from "vitest";
import { render } from "../../src/pipeline/prompts.ts";
import {
  codeBody,
  footer,
  linkLine,
  planBody,
  planFile,
  section,
  specBody,
} from "../../src/pipeline/prtext.ts";

const links = {
  intentUrl: "https://github.com/o/intents/blob/main/intents/261026-1000-log-in/intent.md",
  specPrUrl: "https://github.com/o/web/pull/7",
  planPrUrl: "https://github.com/o/intents/pull/3",
};

const worker = `## What this does

People can log in with a link sent to their email instead of a password.

## Why

Passwords were the top support request.

## What to check before merging

Nothing special.

## Changes

- A login link that expires after 15 minutes`;

test("pipeline: code PR body sections", () => {
  const body = codeBody({
    worker,
    intentTitle: "Log in with a magic link",
    intentProblem: null,
    checks: {
      verify: "passed",
      proof: "the new tests fail without the change",
      ci: "green",
      review: "approved",
    },
    unplanned: [{ what: "network access to api.postmarkapp.com", why: "send the email" }],
    specIds: ["WEB-3", "WEB-4"],
    links,
    reviewDetails: "All outcomes met.",
    footer: { intentUrl: links.intentUrl, costUsd: 3.456, secs: 3900 },
  });
  const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual([
    "What this does",
    "Why",
    "What to check before merging",
    "Changes",
    "Checks",
    "Access beyond the plan",
  ]);
  expect(body).toContain("- CI: green");
  expect(body).toContain("**Spec IDs:** WEB-3, WEB-4");
  expect(body).toContain("<details><summary>Review details</summary>");
  expect(body.trim().split("\n").pop()).toBe(
    `<sub>Built by Towercab · [intent](${links.intentUrl}) · $3.46 · 1h05m</sub>`,
  );
});

const withIssue = (url: string | null) =>
  codeBody({
    worker,
    intentTitle: "Log in with a magic link",
    intentProblem: null,
    checks: null,
    unplanned: [],
    specIds: [],
    links,
    reviewDetails: null,
    footer: { intentUrl: links.intentUrl, costUsd: 1, secs: 60 },
    issue: { url, repo: "o/web" },
  });

test("prtext: a same-repo issue gets Fixes", () => {
  expect(withIssue("https://github.com/o/web/issues/12")).toContain("\nFixes #12\n");
  // GitHub repo names are case-insensitive.
  expect(withIssue("https://github.com/O/Web/issues/12")).toContain("\nFixes #12\n");
  expect(withIssue(null)).not.toContain("Fixes");
});

test("prtext: another repo's issue is only linked", () => {
  const body = withIssue("https://github.com/o/api/issues/12");
  expect(body).not.toContain("Fixes");
  expect(body).toContain("https://github.com/o/api/issues/12");
});

test("pipeline: body without worker text", () => {
  const body = codeBody({
    worker: null,
    intentTitle: "Log in with a magic link",
    intentProblem: "Passwords get forgotten.",
    checks: null,
    unplanned: [],
    specIds: [],
    links: { intentUrl: null, specPrUrl: null, planPrUrl: null },
    reviewDetails: null,
    footer: { intentUrl: null, costUsd: 0, secs: 0 },
  });
  expect(body).toMatch(
    /^## What this does\n\nLog in with a magic link\.\n\n## Why\n\nPasswords get forgotten\./,
  );
  expect(footer({ intentUrl: null, costUsd: 0, secs: 59 })).toBe(
    "<sub>Built by Towercab · intent · $0.00 · 0h00m</sub>",
  );
});

test("pipeline: plan.md sections", () => {
  const md = planFile(
    "Log in with a magic link",
    "261026-1000",
    ["WEB-3"],
    "## Approach\n\nA signed token.\n\n## Steps\n\n1. Tests\n\n## Risks\n\nNone.\n\n## How to check it\n\nLog in.",
    "## Access\n\n- [x] network: api.postmarkapp.com (send the email)",
  );
  expect(md.split("\n")[0]).toBe("# Plan: Log in with a magic link");
  expect(md).toContain("Intent 261026-1000. Spec IDs: WEB-3.");
  expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
    "Approach",
    "Steps",
    "Risks",
    "How to check it",
    "Access",
  ]);
  expect(section(md, "Approach")).toBe("A signed token.");
});

test("pipeline: PRs link to each other", () => {
  expect(linkLine(links)).toBe(
    `Part of this change: [intent](${links.intentUrl}) · [spec PR](${links.specPrUrl}) · [plan PR](${links.planPrUrl}).`,
  );
  expect(specBody("Text.", ["WEB-3"], { ...links, specPrUrl: null, planPrUrl: null })).toContain(
    `Part of this change: [intent](${links.intentUrl}).`,
  );
  const plan = planBody(
    "## Approach\n\nA signed token in the link.\n\nMore detail.",
    { domains: [{ domain: "api.postmarkapp.com", why: "email" }], paths: [] },
    { ...links, planPrUrl: null },
  );
  expect(plan).toMatch(
    /^A signed token in the link\.\n\n\*\*Access asked for:\*\* network access to api\.postmarkapp\.com\./,
  );
  expect(plan).toContain("[spec PR]");
});

test("prompts: templates fill every key", () => {
  const vars = {
    intent: "x",
    earlier: "",
    reserved: "",
    spec_ids: "WEB-1",
    checks: "npm test",
    plan: "p",
    access: "none",
    review_md: "",
    ci: "green",
    screenshots: "",
    diff_cmd: "git diff",
    what: "w",
    details: "d",
  };
  for (const name of ["design", "plan", "worker", "review", "repair"] as const) {
    const text = render(name, vars);
    expect(text, name).not.toMatch(/\{\{\w+\}\}/);
  }
  expect(() => render("plan", {})).toThrow(/uses \{\{intent\}\}/);
});
