// The guard's rules file is versioned (LOOP-106): another version is refused as skew, with a record for
// the loop; a malformed file of the right version still fails closed with its own reason.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { readHead } from "../../src/head.ts";
import {
  GUARD_VERSION,
  readGuardReasons,
  readSkew,
  runGuardHook,
  SKEW_REASON,
  writeGuardRules,
} from "../../src/pipeline/guard.ts";
import { tempDir } from "../helpers/world.ts";

function world(): { checkout: string; runs: string; rules: string } {
  const root = tempDir();
  const checkout = join(root, "work", "c");
  mkdirSync(join(checkout, "src"), { recursive: true });
  const runs = join(root, "runs");
  mkdirSync(runs);
  const rules = writeGuardRules(runs, {
    checkout,
    protected: [],
    granted: [],
    locked: [],
    existing: [],
  });
  return { checkout, runs, rules };
}

const write = (checkout: string) =>
  JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(checkout, "src/a.ts") } });

test("guard: a rules file of another version is refused as skew", () => {
  const w = world();
  expect(JSON.parse(readFileSync(w.rules, "utf8")).version).toBe(GUARD_VERSION);
  expect(runGuardHook(w.rules, write(w.checkout))).toEqual({ code: 0, stderr: "" });
  const base = { checkout: w.checkout, protected: [], granted: [], locked: [] };
  const older = [
    // What the loop wrote before `existing` and `version` existed.
    base,
    { ...base, existing: [] },
    { version: GUARD_VERSION - 1, ...base, existing: [] },
    { version: GUARD_VERSION + 1, ...base, existing: [] },
    { version: String(GUARD_VERSION), ...base, existing: [] },
  ];
  for (const rules of older) {
    writeFileSync(w.rules, JSON.stringify(rules));
    const r = runGuardHook(w.rules, write(w.checkout));
    // Even a write the rules would allow is refused: the file can't be trusted.
    expect(r, JSON.stringify(rules)).toEqual({ code: 2, stderr: `${SKEW_REASON}\n` });
  }
  // Each refusal is recorded next to the rules, with where the hook runs from.
  const skew = readSkew(w.runs);
  expect(skew).toHaveLength(older.length);
  const hookCheckout = resolve(import.meta.dirname, "..", "..");
  expect(skew[0]).toMatchObject({
    rulesVersion: null,
    hookVersion: GUARD_VERSION,
    hookCommit: readHead(hookCheckout),
    hookCheckout,
  });
  expect(skew[2]!.rulesVersion).toBe(GUARD_VERSION - 1);
  // A skew is not an ordinary block.
  expect(readGuardReasons(w.runs)).toEqual([]);
});

test("guard: a malformed rules file of the current version fails closed", () => {
  const w = world();
  const good = {
    version: GUARD_VERSION,
    checkout: w.checkout,
    protected: [],
    granted: [],
    locked: [],
    existing: [],
  };
  const { existing: _existing, ...noExisting } = good;
  for (const [rules, why] of [
    [noExisting, "existing missing"],
    [{ ...good, checkout: "relative" }, "checkout missing or not absolute"],
    [{ ...good, granted: "all" }, "granted missing"],
  ] as const) {
    writeFileSync(w.rules, JSON.stringify(rules));
    const r = runGuardHook(w.rules, write(w.checkout));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(why);
    expect(r.stderr).not.toBe(`${SKEW_REASON}\n`);
    expect(r.stderr.endsWith(": blocked\n")).toBe(true);
  }
  // Not JSON at all, and a missing file: the same.
  writeFileSync(w.rules, "{");
  expect(runGuardHook(w.rules, write(w.checkout)).code).toBe(2);
  expect(runGuardHook(join(w.runs, "nope.json"), write(w.checkout)).code).toBe(2);
  // None of it is skew, and each is logged as the guard's own refusal.
  expect(existsSync(join(w.runs, "guard-skew.jsonl"))).toBe(false);
  expect(readGuardReasons(w.runs)).toHaveLength(5);
});
