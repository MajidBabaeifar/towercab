// The plan's Access checklist (PIP-47): rendered with the level's sentence, read back from plan.md.

import { expect, test } from "vitest";
import { levelSentence, parseAccess, renderAccess } from "../../src/pipeline/access.ts";
import type { Access } from "../../src/pipeline/schemas.ts";

const ACCESS: Access = {
  domains: [
    { domain: "api.stripe.com", why: "the SDK's docs (v2024)" },
    { domain: "*.pythonhosted.org", why: "wheels" },
  ],
  paths: [{ glob: ".github/workflows/ci.yml", why: "add the new job\nto CI" }],
  tests: [],
};

test("pipeline: access checklist round-trips", () => {
  const md = renderAccess(ACCESS, 4);
  expect(md).toBe(
    [
      "## Access",
      "",
      levelSentence(4),
      "",
      "- [x] network: api.stripe.com (the SDK's docs (v2024))",
      "- [x] network: *.pythonhosted.org (wheels)",
      "- [x] path: .github/workflows/ci.yml (add the new job to CI)",
      "",
    ].join("\n"),
  );
  const plan = `# Plan: Pay\n\nIntent 261026-1200 · PIP-4\n\n## Approach\n\nStripe.\n\n${md}`;
  expect(parseAccess(plan)).toEqual({
    domains: ACCESS.domains,
    paths: [{ glob: ".github/workflows/ci.yml", why: "add the new job to CI" }],
    tests: [],
  });
  // Each level says what it grants.
  expect(levelSentence(2)).toContain("you merge the code PR yourself");
  expect(levelSentence(5)).toContain("open network");
  expect(levelSentence(5)).toContain("unless its risk is high");
  expect(levelSentence(4)).toContain("when its risk is low");
  // Nothing asked: a line says so, and nothing is granted.
  const none = renderAccess({ domains: [], paths: [], tests: [] }, 3);
  expect(none).toContain("Nothing beyond what the level grants.");
  expect(parseAccess(none)).toEqual({ domains: [], paths: [], tests: [] });
});

test("pipeline: unticked access is not granted", () => {
  const plan = [
    "# Plan: X",
    "",
    "## Steps",
    "",
    "- [x] network: not.access.example (a step, not access)",
    "",
    "## Access",
    "",
    "At a4 …",
    "",
    "- [ ] network: evil.example (unticked by the owner)",
    "- [X] network: crates.io",
    "* [x] path: migrations/** (schema)",
    "- [ ] path: .github/** (unticked)",
    "",
    "```",
    "- [x] network: in.a.fence (example)",
    "```",
    "",
    "## How to check it",
    "",
    "- [x] path: after/** (another section)",
  ].join("\n");
  expect(parseAccess(plan)).toEqual({
    domains: [{ domain: "crates.io", why: "" }],
    paths: [{ glob: "migrations/**", why: "schema" }],
    tests: [],
  });
  // No section: nothing beyond the defaults.
  expect(parseAccess("# Plan\n\n## Approach\n\n- [x] network: x.example\n")).toEqual({
    domains: [],
    paths: [],
    tests: [],
  });
});
