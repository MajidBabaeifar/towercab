// Protected paths (REPO-8, **Grammar** globs): what the guard blocks and what the sandbox denies.

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { CONTROL, glob, Protected } from "../../src/repo/protected.ts";
import { tempDir } from "../helpers/world.ts";

function write(root: string, rel: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), "x\n");
}

test("repo: protected paths block", () => {
  expect(CONTROL).toEqual(["CLAUDE.md", "AGENTS.md", "REVIEW.md", "TOWERCAB.md", ".github/**", ".claude/**", ".git/**"]);
  const p = new Protected(
    ["src/machine.ts", "migrations/**", "db/*.sql", "./ops/", "/docs/{api,auth}/**", "v?.txt", "[ab].lock"],
    [],
  );
  for (const rel of [
    "CLAUDE.md",
    "REVIEW.md",
    "TOWERCAB.md",
    ".github",
    ".github/workflows/ci.yml",
    ".claude/settings.json",
    "./CLAUDE.md",
    "src//machine.ts",
    "src/machine.ts",
    "migrations",
    "migrations/a/b/c.sql",
    "db/a.sql",
    "ops",
    "ops/bands.yaml",
    "docs/api/v1.md",
    "docs/auth",
    "v1.txt",
    "a.lock",
    "/etc/passwd",
    "../outside",
    "src/../CLAUDE.md",
  ]) {
    expect(p.blocks(rel), rel).toBe(true);
  }
  for (const rel of [
    "docs/CLAUDE.md",
    "claude.md",
    "src/main.ts",
    "src/machine.ts.bak",
    "db/sub/a.sql",
    "db/a.sqlx",
    "docs/other/x.md",
    "v10.txt",
    "c.lock",
    ".githubx",
    ".gitignore",
    "",
  ]) {
    expect(p.blocks(rel), rel).toBe(false);
  }
  // Globs: `*` stays in a component, `**` spans them, `P/**` also matches `P`; case-sensitive.
  const m = glob("src/**");
  expect([m("src"), m("src/a"), m("src/a/b"), m("srcx"), m("x/src")]).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
  expect([glob("*.rs")("main.rs"), glob("*.rs")("src/main.rs")]).toEqual([true, false]);
  expect([glob("**/*.rs")("main.rs"), glob("**/*.rs")("src/a/main.rs")]).toEqual([true, true]);
  const alt = glob("{src,lib}/*/**");
  expect([alt("src/a"), alt("lib/a/b"), alt("src")]).toEqual([true, true, false]);
  expect(glob("Src/**")("src/a")).toBe(false);
  expect(glob("./a/b/")("a/b")).toBe(true);
  expect([glob("weird/a\\*b.txt")("weird/a*b.txt"), glob("weird/a\\*b.txt")("weird/axb.txt")]).toEqual([
    true,
    false,
  ]);
  const opt = glob("{a,{b,c}}/x{,.bak}");
  expect([opt("c/x"), opt("a/x.bak"), opt("d/x")]).toEqual([true, true, false]);
  for (const g of ["", "/", "./", "../x", "a/../b", "a//b", "a/./b", ".", "a\\", "a/[b", "{a,b"]) {
    expect(() => glob(g), g).toThrow(`bad glob "${g}"`);
  }
  expect(() => new Protected(["ok/**", "../x"], [])).toThrow('protected: bad glob "../x"');
  expect(() => new Protected([], ["a/[b"])).toThrow('granted: bad glob "a/[b"');
});

test("repo: granted paths unblock", () => {
  const p = new Protected(
    ["migrations/**", "db/*.sql"],
    [".github/workflows/ci.yml", "migrations/**", "**/b.sql"],
  );
  expect(p.blocks(".github/workflows/ci.yml")).toBe(false);
  expect(p.blocks(".github/workflows/release.yml")).toBe(true);
  expect(p.blocks(".github")).toBe(true);
  expect([p.blocks("migrations"), p.blocks("migrations/x/y.sql")]).toEqual([false, false]);
  expect([p.blocks("db/b.sql"), p.blocks("db/a.sql")]).toEqual([false, true]);
  expect(p.blocks("CLAUDE.md")).toBe(true);
  expect(p.blocks("/abs/.github/workflows/ci.yml")).toBe(true);

  // denyWrite: existing paths, granted ones dropped, directories a grant reaches into split.
  const root = join(tempDir(), "checkout");
  for (const rel of [
    "CLAUDE.md",
    "REVIEW.md",
    ".github/CODEOWNERS",
    ".github/ISSUE_TEMPLATE/bug.md",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".git/config",
    "src/machine.ts",
    "src/main.ts",
    "db/a.sql",
    "db/b.sql",
    "db/readme.md",
    "db/sub/c.sql",
    "db/dir.sql/inner.sql",
    "migrations/001.sql",
    "Cargo.lock",
    "sub/pkg/x.lock",
    "weird/a*b.txt",
    "weird/ok.txt",
  ]) {
    write(root, rel);
  }
  symlinkSync("/etc/passwd", join(root, "db/link.sql"));
  const globs = ["src/machine.ts", "migrations/**", "db/*.sql", "ops/bands.yaml", "**/*.lock", "weird/*.txt"];
  const abs = (rels: string[]) => rels.map((r) => join(root, r));
  expect(new Protected(globs, []).denyWrite(root)).toEqual(
    abs([
      ".git",
      ".github",
      "CLAUDE.md",
      "Cargo.lock",
      "REVIEW.md",
      "db/a.sql",
      "db/b.sql",
      "db/dir.sql",
      "db/link.sql",
      "migrations",
      "src/machine.ts",
      "sub/pkg/x.lock",
      // `weird/a*b.txt` can't be a sandbox entry: left to the guard and publish.
      "weird/ok.txt",
    ]),
  );
  expect(
    new Protected(globs, [".github/workflows/ci.yml", "migrations/**", "db/a.sql"]).denyWrite(root),
  ).toEqual(
    abs([
      ".git",
      ".github/CODEOWNERS",
      ".github/ISSUE_TEMPLATE",
      ".github/workflows/release.yml",
      "CLAUDE.md",
      "Cargo.lock",
      "REVIEW.md",
      "db/b.sql",
      "db/dir.sql",
      "db/link.sql",
      "src/machine.ts",
      "sub/pkg/x.lock",
      "weird/ok.txt",
    ]),
  );
  // None inside another; duplicates once.
  expect(new Protected(["src/**", "src/machine.ts", "./src/"], []).denyWrite(root)).toEqual(
    abs([".git", ".github", "CLAUDE.md", "REVIEW.md", "src"]),
  );
  // Everything granted (a1–a3, a5): only `.git` stays.
  expect(new Protected(globs, ["**"]).denyWrite(root)).toEqual(abs([".git"]));
  // A checkout whose path can't be a sandbox entry is refused, never an empty list.
  const wild = join(tempDir(), "work[1]");
  write(wild, "CLAUDE.md");
  expect(() => new Protected(globs, []).denyWrite(wild)).toThrow("denyWrite can't name it");
});

test("repo: .git is never writable", () => {
  const p = new Protected([], [".git/**", "**"]);
  expect([p.blocks("CLAUDE.md"), p.blocks(".github/workflows/ci.yml")]).toEqual([false, false]);
  for (const rel of [".git", ".git/config", "./.git/hooks/post-checkout", ".git/index.lock"]) {
    expect(p.blocks(rel), rel).toBe(true);
  }
  const root = join(tempDir(), "c");
  write(root, ".git/config");
  write(root, "CLAUDE.md");
  expect(p.denyWrite(root)).toEqual([join(root, ".git")]);
});
