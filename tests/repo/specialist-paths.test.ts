// A repo's own specialist paths (REPO-42): `## Specialist paths` in REVIEW.md.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { defaultReview, parseReview } from "../../src/repo/files.ts";

test("repo: REVIEW.md specialist paths", () => {
  const r = parseReview(
    "## Specialist paths\n\n- Security: `src/auth/**`, lib/keys.ts\n- **infra**: deploy/{a,b}/**\n- security: extra/**\n",
  );
  expect(r.specialistPaths).toEqual({
    security: ["src/auth/**", "lib/keys.ts", "extra/**"],
    infra: ["deploy/{a,b}/**"],
  });
  // Towercab's own file lists its own code there; the shared default has none of it.
  const own = parseReview(readFileSync("REVIEW.md", "utf8"));
  expect(own.specialistPaths.security).toContain("src/pipeline/sandbox.ts");
});

test("repo: REVIEW.md without specialist paths", () => {
  expect(parseReview("## Passes\n\n- Bugs: wrong results\n").specialistPaths).toEqual({
    security: [],
    infra: [],
  });
  expect(defaultReview().specialistPaths).toEqual({ security: [], infra: [] });
  expect(parseReview("## Specialist paths\n\nNone yet.\n").specialistPaths).toEqual({
    security: [],
    infra: [],
  });
});

test("repo: unknown specialist area is ignored", () => {
  const r = parseReview(
    "## Specialist paths\n\n- legal: contracts/**\n- security:\n- security: , ,\n- no colon\n",
  );
  expect(r.specialistPaths).toEqual({ security: [], infra: [] });
});
