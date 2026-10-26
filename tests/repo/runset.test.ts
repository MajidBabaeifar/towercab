// The run set (REPO-9): fast checks with CI, full checks without, placeholders filled in.

import { expect, test } from "vitest";
import type { Verifying } from "../../src/repo/files.ts";
import { allowedCommands, runSet } from "../../src/repo/runset.ts";

function v(fast: string[] | null): Verifying {
  return { setup: ["npm ci"], checks: ["a", "b"], fast, screenshots: null };
}

test("repo: run set without CI", () => {
  // A repo without CI runs everything locally, fast block or not.
  expect(runSet(v(["lint {tests}"]), false, ["tests/a.rs"])).toEqual(["a", "b"]);
  expect(runSet(v(["lint"]), false, [])).toEqual(["a", "b"]);
  // No fast block: the full checks with CI too.
  expect(runSet(v(null), true, ["tests/a.rs"])).toEqual(["a", "b"]);
  expect(allowedCommands(v(null), false)).toEqual(["npm ci", "a", "b"]);
});

test("repo: run set with fast", () => {
  expect(runSet(v(["fmt", "lint", "build"]), true, [])).toEqual(["fmt", "lint", "build"]);
  expect(runSet(v(["fmt", "lint", "build"]), true, ["tests/a.rs"])).toEqual(["fmt", "lint", "build"]);
  // An empty fast block: no local checks at all.
  expect(runSet(v([]), true, [])).toEqual([]);
  expect(
    allowedCommands(
      v(["fmt", "pytest {tests}", "$(x) y", "cargo test $(printf -- '--test %s ' {stems})"]),
      true,
    ),
  ).toEqual(["npm ci", "fmt", "pytest", "cargo test"]);
});

test("repo: placeholders", () => {
  const fast = v([
    "fmt",
    "pytest {tests}",
    "cargo test $(printf -- '--test %s ' {stems})",
    "both {tests} and {stems}",
  ]);
  expect(runSet(fast, true, ["tests/login.rs", "tests/api/it.rs", "tests/with space.rs"])).toEqual([
    "fmt",
    "pytest tests/login.rs tests/api/it.rs 'tests/with space.rs'",
    // A file below a subdirectory of tests/ is a helper: no stem.
    "cargo test $(printf -- '--test %s ' login 'with space')",
    "both tests/login.rs tests/api/it.rs 'tests/with space.rs' and login 'with space'",
  ]);
  // A quote is escaped, a duplicate stem once.
  expect(runSet(fast, true, ["tests/it's.rs", "tests/x.sh", "tests/x.py"])[2]).toBe(
    "cargo test $(printf -- '--test %s ' 'it'\\''s' x)",
  );
  // No changed test: a line with a placeholder is skipped, never run bare.
  expect(runSet(fast, true, [])).toEqual(["fmt"]);
  expect(runSet(fast, true, ["tests/common/mod.rs"])).toEqual(["fmt", "pytest tests/common/mod.rs"]);
});
