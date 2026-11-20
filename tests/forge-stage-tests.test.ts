// PIP-200, PIP-201: stage tests ask a fake code host (`FakeForge`) at the `Forge` interface, and a stage
// holds the `Forge` alone: it cannot reach the raw `gh` calls.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, expectTypeOf, test } from "vitest";
import type { Forge } from "../src/forge.ts";
import type { Ctx } from "../src/handlers.ts";

const TESTS = join(import.meta.dirname);

/** What a stage test must not hold: a fake `gh` command line or a `GitHubForge` of its own. */
const IMITATIONS: [RegExp, string][] = [
  [/\blines\(\s*"gh"\s*\)/, "reads fake gh lines"],
  [/\.on\(\s*"gh"/, "answers the gh command"],
  [/\brun\(\s*"gh"/, "runs gh"],
  [/\bcmd\s*===\s*"gh"/, "intercepts gh"],
  [/\bGitHubForge\b/, "builds a GitHubForge"],
  [/\bfakeGitHub\b/, "builds a GitHub over a fake gh"],
];

function files(dir: string, ends: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ends))
    .map((f) => join(dir, f));
}

test("forge: stage tests hold no fake gh command lines", () => {
  const found: string[] = [];
  // The stage tests, and the world they run in (the `Pipe` helpers).
  const scanned = [
    ...files(join(TESTS, "pipeline"), ".test.ts"),
    join(TESTS, "helpers", "pipe.ts"),
    join(TESTS, "helpers", "pipe-forge.ts"),
    join(TESTS, "helpers", "fake-forge.ts"),
  ];
  for (const file of scanned) {
    const text = readFileSync(file, "utf8");
    for (const [rx, what] of IMITATIONS)
      if (rx.test(text)) found.push(`${file.slice(TESTS.length + 1)}: ${what}`);
  }
  expect(found).toEqual([]);
});

test("forge: Ctx.github is a Forge and nothing more", () => {
  expectTypeOf<Ctx["github"]>().toEqualTypeOf<Forge>();
  // A raw call is not a member of it: reading one is a type error.
  // @ts-expect-error `gh` belongs to the raw `GitHub`, not to the `Forge` a stage holds
  type Raw = Ctx["github"]["gh"];
  expectTypeOf<Raw>().toBeAny();
  expect(true).toBe(true);
});
