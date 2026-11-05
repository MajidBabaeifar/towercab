// `towercab specs check-ids` (PIP-132): hermetic, in temp git repos.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkIds, readPrList } from "../src/specs-cli.ts";
import { realTools } from "../src/tools.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tc-ids-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "specs"));
  write(dir, "specs/a.md", "# A\n\n### A-1 · One\n\nOne.\n\n### A-2 · Two\n\nTwo.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function write(dir: string, path: string, text: string) {
  writeFileSync(join(dir, path), text);
}

const run = (cwd: string, prs: { number: number; ids: string[] }[] | null = null) =>
  checkIds(realTools(), { cwd, base: "origin/main", prs });

test("specs: an added ID that exists on main fails the check", async () => {
  const dir = repo();
  // This branch started before main added A-3, and adds its own A-3.
  git(dir, "checkout", "-q", "-b", "feature");
  write(
    dir,
    "specs/a.md",
    "# A\n\n### A-1 · One\n\nOne.\n\n### A-2 · Two\n\nTwo.\n\n### A-3 · Mine\n\nMine.\n",
  );
  git(dir, "commit", "-qam", "mine");
  git(dir, "checkout", "-q", "main");
  write(dir, "specs/b.md", "# B\n\n### A-3 · Theirs\n\nTheirs.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main adds A-3");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "checkout", "-q", "feature");
  const r = await run(dir);
  expect(r.problems).toEqual(["A-3 (specs/a.md): added here, but the base branch already has this ID"]);
  // A merge of main into the branch leaves two headings with the ID: also a failure.
  git(dir, "merge", "-q", "--no-edit", "origin/main");
  const merged = await run(dir);
  expect(merged.problems).toEqual(["A-3: 2 headings carry this ID (specs/a.md, specs/b.md)"]);
});

test("specs: an added ID that another open PR adds fails the check", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "feature");
  write(
    dir,
    "specs/a.md",
    "# A\n\n### A-1 · One\n\nOne.\n\n### A-2 · Two\n\nTwo.\n\n### A-3 · Mine\n\nMine.\n",
  );
  git(dir, "commit", "-qam", "mine");
  const r = await run(dir, [
    { number: 9, ids: ["A-3", "A-4"] },
    { number: 10, ids: ["A-7"] },
  ]);
  expect(r.problems).toEqual(["A-3 (specs/a.md): also added by open pull request #9"]);
  expect(r.notes).toEqual([]);
});

test("specs: editing an existing requirement passes the check", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "feature");
  // An edited row, a moved row and a removed one keep their IDs: none is an add.
  write(
    dir,
    "specs/a.md",
    "# A\n\n### A-2 · Two, reworded\n\nTwo.\n\n### A-1 · One\n\nRemoved: no longer needed.\n",
  );
  git(dir, "commit", "-qam", "edit");
  const r = await run(dir, [{ number: 9, ids: ["A-1", "A-2"] }]);
  expect(r.problems).toEqual([]);
});

test("specs: the open PR comparison is skipped without a PR list", async () => {
  const dir = repo();
  git(dir, "checkout", "-q", "-b", "feature");
  write(
    dir,
    "specs/a.md",
    "# A\n\n### A-1 · One\n\nOne.\n\n### A-2 · Two\n\nTwo.\n\n### A-3 · Mine\n\nMine.\n",
  );
  git(dir, "commit", "-qam", "mine");
  const r = await run(dir);
  expect(r.problems).toEqual([]);
  expect(r.notes).toEqual(["open pull requests not compared: no list given (--prs)"]);
  // No base to compare with: a note, not a failure.
  const none = await checkIds(realTools(), { cwd: dir, base: "origin/missing", prs: null });
  expect(none).toEqual({ problems: [], notes: ["spec IDs not checked: no origin/missing to compare with"] });
});

test("specs: the open PR list file is validated", () => {
  expect(readPrList('[{"number":3,"ids":["A-1"]}]')).toEqual([{ number: 3, ids: ["A-1"] }]);
  expect(() => readPrList("{}")).toThrow("must be a JSON array");
  expect(() => readPrList('[{"number":"3"}]')).toThrow('needs a "number"');
  expect(() => readPrList("nope")).toThrow("isn't JSON");
});
