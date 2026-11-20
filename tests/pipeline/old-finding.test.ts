// A secrets finding only in an older commit, gone at the head, is ignored by fingerprint; one still at
// the head or outside tests is not (PIP-192, PIP-193, PIP-196).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
  classify,
  ignoreDetails,
  ignoreRoundOk,
  isTestPath,
  oldFindingQuestion,
  type ReadGit,
} from "../../src/pipeline/old-finding.ts";
import { git, tempDir } from "../helpers/world.ts";

const SECRET = "AKIAFAKESECRETVALUE123";
const KEY_LINE = `const key = "${SECRET}";`;

/** A repo whose first commit holds `KEY_LINE` at line 2 of each of `files`; a second commit changes them. */
function repo(
  files: string[],
  after: (file: string) => string | null,
): { read: ReadGit; first: string; head: string } {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  const write = (f: string, text: string) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  };
  for (const f of files) write(f, `// header\n${KEY_LINE}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  const first = git(dir, "rev-parse", "HEAD").trim();
  for (const f of files) {
    const next = after(f);
    if (next !== null) write(f, next);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "second");
  const head = git(dir, "rev-parse", "HEAD").trim();
  return { read: async (args) => git(dir, ...args), first, head };
}

const log = (commit: string, file: string, line = 2) =>
  [
    `RuleID:      generic-api-key`,
    `File:        ${file}`,
    `Line:        ${line}`,
    `Fingerprint: ${commit}:${file}:generic-api-key:${line}`,
    "",
  ].join("\n");

const fixed = () => `// header\nconst key = process.env.KEY;\n`;

test("pipeline: a red secrets log whose finding commit is not the head and whose line is gone at head asks for one gitleaksignore line", async () => {
  const r = repo(["tests/a.test.ts"], fixed);
  const v = await classify(r.read, r.head, [log(r.first, "tests/a.test.ts")]);
  expect(v.kind).toBe("ignore");
  if (v.kind !== "ignore") return;
  const details = ignoreDetails(v.findings);
  const print = `${r.first}:tests/a.test.ts:generic-api-key:2`;
  expect(v.findings.map((f) => f.fingerprint)).toEqual([print]);
  expect(details.split("\n").filter((l) => l === print)).toHaveLength(1);
  expect(details).toContain(".gitleaksignore");
  expect(details).not.toContain(SECRET);
});

test("pipeline: a secrets repair that only adds the listed fingerprints is pushed", () => {
  const print = "abc1234:tests/a.test.ts:generic-api-key:2";
  const diff = `diff --git a/.gitleaksignore b/.gitleaksignore\nnew file mode 100644\n--- /dev/null\n+++ b/.gitleaksignore\n@@ -0,0 +1 @@\n+${print}\n`;
  expect(ignoreRoundOk(".gitleaksignore", diff, [print])).toBe(true);
});

test("pipeline: a secrets repair that changes more than the listed fingerprints is reset and repaired normally", () => {
  const print = "abc1234:tests/a.test.ts:generic-api-key:2";
  const diff = `--- a/.gitleaksignore\n+++ b/.gitleaksignore\n@@ -0,0 +1 @@\n+${print}\n`;
  // Another file changed, an extra line, a removed line, a missing fingerprint: none is pushed.
  expect(ignoreRoundOk(`.gitleaksignore\nsrc/a.ts`, diff, [print])).toBe(false);
  expect(ignoreRoundOk(".gitleaksignore", `${diff}+other:line\n`, [print])).toBe(false);
  expect(ignoreRoundOk(".gitleaksignore", `${diff}-old line\n`, [print])).toBe(false);
  expect(ignoreRoundOk(".gitleaksignore", diff, [print, "def5678:x.test.ts:r:1"])).toBe(false);
  expect(ignoreRoundOk("tests/a.test.ts", diff, [print])).toBe(false);
});

test("pipeline: a second red secrets round after an ignore commit is a normal repair", async () => {
  const r = repo(["tests/a.test.ts"], fixed);
  const text = log(r.first, "tests/a.test.ts");
  expect((await classify(r.read, r.head, [text], {})).kind).toBe("ignore");
  expect((await classify(r.read, r.head, [text], { [r.head]: true })).kind).toBe("normal");
});

test("pipeline: a secrets finding still present at head is not offered for gitleaksignore", async () => {
  const r = repo(["tests/a.test.ts"], () => null);
  expect((await classify(r.read, r.head, [log(r.first, "tests/a.test.ts")])).kind).toBe("normal");
  // The line moved down but is still there.
  const moved = repo(["tests/a.test.ts"], () => `// header\n// more\n${KEY_LINE}\n`);
  expect((await classify(moved.read, moved.head, [log(moved.first, "tests/a.test.ts")])).kind).toBe("normal");
});

test("pipeline: a secrets log with a finding at the head asks for a code fix only", async () => {
  const r = repo(["tests/a.test.ts", "tests/b.test.ts"], (f) => (f.endsWith("a.test.ts") ? fixed() : null));
  // One old and fixed finding, one still at the head (same commit as its file): the whole round is normal.
  const mixed = log(r.first, "tests/a.test.ts") + log(r.first, "tests/b.test.ts");
  expect((await classify(r.read, r.head, [mixed])).kind).toBe("normal");
  // A finding whose commit is the head itself is never old.
  expect((await classify(r.read, r.head, [log(r.head, "tests/a.test.ts")])).kind).toBe("normal");
});

test("pipeline: an unreadable finding commit keeps the usual repair details", async () => {
  const r = repo(["tests/a.test.ts"], fixed);
  const ghost = "1234567890abcdef1234567890abcdef12345678";
  expect((await classify(r.read, r.head, [log(ghost, "tests/a.test.ts")])).kind).toBe("normal");
  // A log that was cut: more RuleID blocks than fingerprints.
  const cut = `${log(r.first, "tests/a.test.ts")}RuleID:      generic-api-key\n`;
  expect((await classify(r.read, r.head, [cut])).kind).toBe("normal");
  // Nothing from a job's own log: a summary-only or unreadable run.
  expect((await classify(r.read, r.head, [])).kind).toBe("normal");
});

test("pipeline: an old finding outside tests asks the owner with rule, file, line and commit", async () => {
  const r = repo(["src/config.ts"], fixed);
  const v = await classify(r.read, r.head, [log(r.first, "src/config.ts")]);
  expect(v.kind).toBe("ask");
  if (v.kind !== "ask") return;
  const q = oldFindingQuestion(v.findings);
  expect(q.context).toContain("generic-api-key");
  expect(q.context).toContain("src/config.ts line 2");
  expect(q.context).toContain(r.first.slice(0, 7));
  expect(q.context).toContain("real key that needs rotating");
  expect(JSON.stringify(q)).not.toContain(SECRET);
});

test("pipeline: an old finding outside tests is not offered for gitleaksignore", async () => {
  // One test file and one source file: nothing is ignored on its own.
  const r = repo(["tests/a.test.ts", "src/config.ts"], fixed);
  const both = log(r.first, "tests/a.test.ts") + log(r.first, "src/config.ts");
  const v = await classify(r.read, r.head, [both]);
  expect(v.kind).toBe("ask");
});

test("pipeline: test and fixture paths are recognised", () => {
  for (const p of [
    "tests/a.ts",
    "test/a.ts",
    "__tests__/a.ts",
    "fixtures/key.txt",
    "pkg/tests/a.ts",
    "pkg/test/a.ts",
    "pkg/__tests__/a.ts",
    "pkg/fixtures/a.json",
    "src/a.test.ts",
    "src/a.spec.js",
    "a.test.tsx",
  ])
    expect(isTestPath(p), p).toBe(true);
  for (const p of [
    "src/config.ts",
    "docs/a.md",
    "mocks/a.ts",
    "examples/a.ts",
    "src/attest.ts",
    "contest/a.ts",
  ])
    expect(isTestPath(p), p).toBe(false);
});

test("pipeline: a path with a parent segment is not a test path", () => {
  expect(isTestPath("tests/../src/config.ts")).toBe(false);
  expect(isTestPath("../tests/a.ts")).toBe(false);
  expect(isTestPath("/tests/a.ts")).toBe(false);
});
