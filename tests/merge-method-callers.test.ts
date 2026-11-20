// LOOP-154: every merge goes through the repo's method, not a fixed one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

test("merge: no caller passes a fixed method to mergePr", () => {
  const found = sources(SRC).filter((f) =>
    /mergePr\([^)]*method:\s*MERGE_METHOD/s.test(readFileSync(f, "utf8")),
  );
  expect(found.map((f) => f.slice(SRC.length + 1))).toEqual([]);
});
