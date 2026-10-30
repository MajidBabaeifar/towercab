// The worker's guard (PIP-29, PIP-31): the hook blocks protected, outside and locked paths, and fails closed.

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ASK,
  type GuardRules,
  guardDecision,
  guardMain,
  lockedTests,
  publishRefusals,
  runGuardHook,
  writeGuardRules,
} from "../../src/pipeline/guard.ts";
import { DEFAULT_TESTS } from "../../src/repo/files.ts";
import { Protected } from "../../src/repo/protected.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

function world(over: Partial<GuardRules> = {}): { checkout: string; runs: string; rules: string } {
  const root = tempDir();
  const checkout = join(root, "work", "c");
  mkdirSync(join(checkout, "src"), { recursive: true });
  const runs = join(root, "runs");
  mkdirSync(runs);
  const rules = writeGuardRules(runs, {
    checkout,
    protected: ["src/machine.ts"],
    granted: [],
    locked: ["tests/a.test.ts"],
    ...over,
  });
  return { checkout, runs, rules };
}

const input = (tool: string, path: string) =>
  JSON.stringify({ tool_name: tool, tool_input: { file_path: path } });

test("guard: blocks a protected path", () => {
  const w = world();
  // Control files are always in the rules file.
  expect(JSON.parse(readFileSync(w.rules, "utf8")).protected).toEqual([
    "CLAUDE.md",
    "AGENTS.md",
    "REVIEW.md",
    "TOWERCAB.md",
    ".github/**",
    ".claude/**",
    ".git/**",
    "src/machine.ts",
  ]);
  for (const rel of ["CLAUDE.md", ".github/workflows/ci.yml", "src/machine.ts", "src/../CLAUDE.md"]) {
    const r = runGuardHook(w.rules, input("Edit", join(w.checkout, rel)));
    expect(r.code, rel).toBe(2);
    expect(r.stderr.endsWith(`${ASK}\n`), r.stderr).toBe(true);
  }
  expect(runGuardHook(w.rules, input("Write", join(w.checkout, "CLAUDE.md"))).stderr).toBe(
    `CLAUDE.md is protected: ${ASK}\n`,
  );
  // A relative path is relative to the checkout; a notebook too.
  const nb = JSON.stringify({ tool_name: "NotebookEdit", tool_input: { notebook_path: ".claude/x.ipynb" } });
  expect(runGuardHook(w.rules, nb).code).toBe(2);
  // `.git` is never writable, granted or not.
  const all = world({ granted: ["**"] });
  expect(runGuardHook(all.rules, input("Write", join(all.checkout, ".git/config"))).code).toBe(2);
  // Each block is logged next to the rules.
  const log = readFileSync(join(w.runs, "guard-blocks.jsonl"), "utf8").trim().split("\n");
  expect(log.length).toBe(6);
  expect(JSON.parse(log[0]!).reason).toContain("is protected");
});

test("guard: allows a granted path", () => {
  const w = world({ granted: [".github/workflows/ci.yml", "src/machine.ts"] });
  expect(runGuardHook(w.rules, input("Edit", join(w.checkout, "src/main.ts")))).toEqual({
    code: 0,
    stderr: "",
  });
  expect(runGuardHook(w.rules, input("Edit", join(w.checkout, "src/machine.ts"))).code).toBe(0);
  expect(runGuardHook(w.rules, input("Write", join(w.checkout, ".github/workflows/ci.yml"))).code).toBe(0);
  expect(runGuardHook(w.rules, input("Write", join(w.checkout, ".github/workflows/release.yml"))).code).toBe(
    2,
  );
  // a1–a3 and a5 grant everything but `.git`.
  const all = world({ granted: ["**"] });
  expect(runGuardHook(all.rules, input("Write", join(all.checkout, "CLAUDE.md"))).code).toBe(0);
  expect(
    guardDecision(
      { checkout: w.checkout, protected: [], granted: [], locked: [] },
      { file_path: join(w.checkout, "new/dir/file.ts") },
    ),
  ).toEqual({ block: false });
});

test("guard: blocks outside the checkout", () => {
  const w = world();
  for (const p of ["/etc/passwd", join(w.checkout, "../other/x"), "../x", w.checkout]) {
    const r = runGuardHook(w.rules, input("Write", p));
    expect(r.code, p).toBe(2);
    expect(r.stderr, p).toContain("is outside the checkout");
  }
  // A symlink out of the checkout is outside; a dangling one too.
  const out = tempDir();
  symlinkSync(out, join(w.checkout, "link"));
  expect(runGuardHook(w.rules, input("Write", join(w.checkout, "link/x.ts"))).stderr).toContain("outside");
  symlinkSync(join(out, "gone"), join(w.checkout, "dangling"));
  expect(runGuardHook(w.rules, input("Write", join(w.checkout, "dangling"))).stderr).toContain(
    "dangling symlink",
  );
  // A symlink inside to a protected file is that file.
  symlinkSync("../CLAUDE.md", join(w.checkout, "src/rules.md"));
  writeFileSync(join(w.checkout, "CLAUDE.md"), "x");
  expect(runGuardHook(w.rules, input("Edit", join(w.checkout, "src/rules.md"))).stderr).toContain(
    "CLAUDE.md is protected",
  );
});

test("guard: fails closed", () => {
  const w = world();
  const ok = input("Write", join(w.checkout, "src/a.ts"));
  expect(runGuardHook(w.rules, ok).code).toBe(0);
  // Bad input, no path, a missing or broken rules file: blocked.
  expect(runGuardHook(w.rules, "{").code).toBe(2);
  expect(runGuardHook(w.rules, JSON.stringify({ tool_name: "Write", tool_input: {} })).code).toBe(2);
  expect(runGuardHook(w.rules, JSON.stringify({ tool_name: "Write" })).code).toBe(2);
  const missing = runGuardHook("/nonexistent/guard.json", ok);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toMatch(/^guard: .*: blocked\n$/);
  writeFileSync(w.rules, JSON.stringify({ checkout: "relative", protected: [], granted: [], locked: [] }));
  expect(runGuardHook(w.rules, ok).code).toBe(2);
  writeFileSync(
    w.rules,
    JSON.stringify({ checkout: w.checkout, protected: ["[bad"], granted: [], locked: [] }),
  );
  expect(runGuardHook(w.rules, ok).code).toBe(2);
  // The CLI entry: no rules argument blocks too.
  expect(guardMain([], ok)).toBe(2);
});

test("pipeline: repair can't edit pushed tests", async () => {
  // The lock baseline's test files, by the repo's test globs.
  const repo = join(tempDir(), "co");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [p, t] of Object.entries({
    "tests/a.test.ts": "a",
    "src/b.spec.ts": "b",
    "src/main.ts": "m",
    "README.md": "r",
  })) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), t);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "build");
  const head = git(repo, "rev-parse", "HEAD").trim();
  const tools = new FakeTools();
  const locked = await lockedTests(tools, repo, head, DEFAULT_TESTS);
  expect(locked.sort()).toEqual(["src/b.spec.ts", "tests/a.test.ts"]);
  expect(await lockedTests(tools, repo, null, DEFAULT_TESTS)).toEqual([]);

  // The guard blocks them in a repair round; a new test file is fine.
  const rules: GuardRules = { checkout: repo, protected: [], granted: [], locked };
  const d = guardDecision(rules, { file_path: join(repo, "tests/a.test.ts") });
  expect(d.block).toBe(true);
  expect(d.block && d.reason).toContain("locked in repair rounds");
  expect(guardDecision(rules, { file_path: join(repo, "tests/new.test.ts") })).toEqual({ block: false });
  expect(guardDecision(rules, { file_path: join(repo, "src/main.ts") })).toEqual({ block: false });

  // Publish refuses a change or a delete of a locked test, and a protected path not granted.
  const prot = new Protected([], []);
  expect(
    publishRefusals(
      ["src/main.ts", ".github/workflows/ci.yml"],
      prot,
      [
        { status: "M", path: "tests/a.test.ts" },
        { status: "D", path: "src/b.spec.ts" },
        { status: "A", path: "tests/new.test.ts" },
      ],
      locked,
    ),
  ).toEqual([
    ".github/workflows/ci.yml (protected)",
    "tests/a.test.ts (a test already pushed)",
    "src/b.spec.ts (a test already pushed)",
  ]);
  expect(publishRefusals(["src/main.ts"], prot, [{ status: "A", path: "tests/n.test.ts" }], locked)).toEqual(
    [],
  );
});
