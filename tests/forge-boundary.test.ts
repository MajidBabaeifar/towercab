// The code host sits behind `Forge` (src/forge.ts): outside `src/github/` nothing builds `gh` arguments,
// names a merge flag or reads GitHub's check rollup.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MERGE_METHOD } from "../src/forge.ts";

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return p === join(SRC, "github") ? [] : sources(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

const BANNED: [RegExp, string][] = [
  [/\.gh\(/, "a raw `gh` call"],
  [/\.owner\(/, "a raw owner `gh` call"],
  [/"--squash"/, "a merge flag"],
  [/statusCheckRollup/, "GitHub's check rollup"],
  [/\["(pr|api)", "/, "gh arguments"],
  [/\["(pr|api)",\s*$/m, "gh arguments"],
];

test("forge: nothing outside src/github builds gh arguments", () => {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const [rx, what] of BANNED) if (rx.test(text)) found.push(`${file.slice(SRC.length + 1)}: ${what}`);
  }
  expect(found).toEqual([]);
});

test("forge: the merge method is one value, and it is squash", () => {
  expect(MERGE_METHOD).toBe("squash");
});
