// The repo files (REPO-1, 2, 4, 5, 6, 10, **Grammar**): parsed from text and read from the base branch.

import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  DEFAULT_DO_NOT_REPORT,
  DEFAULT_PASSES,
  DEFAULT_TESTS,
  defaultReview,
  defaultTowercab,
  loadRepoFiles,
  parseRepoFiles,
  parseReview,
  parseTowercab,
  parseVerifying,
  RepoError,
} from "../../src/repo/files.ts";
import { hasCi } from "../../src/repo/runset.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir } from "../helpers/world.ts";

/** A `CLAUDE.md` whose verifying section is `section`. */
function claude(section: string): string {
  return `# Repo\n\nSome prose.\n\n## Commands\n\n- \`make\`\n\n## Verifying your work\n\n${section}\n## After\n\nMore prose.\n`;
}
const CHECKS = "```checks\ncargo test\n```\n";

function error(fn: () => unknown): RepoError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RepoError) return e;
    throw e;
  }
  throw new Error("no error");
}
const invalid = (fn: () => unknown) => {
  const e = error(fn);
  expect(e.kind).toBe("invalid");
  return e.message;
};

test("repo: parse the three files", () => {
  const claudeMd = claude(`Run these.\n\n\`\`\`setup\ncargo fetch\n\`\`\`\n\n${CHECKS}`);
  const review =
    "# Review\n\n## Passes\n\n- **Bugs**: wrong things\n\n## Red lines\n\n- `migrations/**`: data\n";
  const towercab = "---\nmax_autonomy: 3\nprotected: [src/machine.ts]\n---\n\nNotes.\n";
  const files = parseRepoFiles(claudeMd, review, towercab);
  expect(files.claudeMd).toBe(claudeMd);
  expect(files.verifying).toEqual({
    setup: ["cargo fetch"],
    checks: ["cargo test"],
    fast: null,
    screenshots: null,
  });
  expect(files.review.text).toBe(review);
  expect(files.review.passes).toEqual([{ name: "Bugs", what: "wrong things" }]);
  expect(files.review.redLines).toEqual(["`migrations/**`: data"]);
  expect(files.towercab).toEqual({ maxAutonomy: 3, protected: ["src/machine.ts"], tests: DEFAULT_TESTS });

  // Absent REVIEW.md and TOWERCAB.md → defaults.
  const bare = parseRepoFiles(claudeMd, null, null);
  expect(bare.review).toEqual(defaultReview());
  expect(bare.towercab).toEqual(defaultTowercab());

  // A leading BOM and CRLF line ends are fine in every file.
  const crlf = (s: string) => `\uFEFF${s.replaceAll("\n", "\r\n")}`;
  const again = parseRepoFiles(crlf(claudeMd), crlf(review), crlf(towercab));
  expect(again.verifying.checks).toEqual(["cargo test"]);
  expect(again.review.passes[0]!.what).toBe("wrong things");
  expect(again.towercab.maxAutonomy).toBe(3);

  // CLAUDE.md, REVIEW.md, TOWERCAB.md in that order; the first error wins.
  const badReview = "## Passes\n\n- no colon here\n";
  const badTowercab = "---\nmax_autonomy: 9\n---\n";
  expect(error(() => parseRepoFiles(null, badReview, badTowercab)).kind).toBe("noVerifying");
  expect(invalid(() => parseRepoFiles(claudeMd, badReview, badTowercab))).toBe(
    'REVIEW.md: ## Passes: want "<name>: <what>", got "no colon here"',
  );
  expect(invalid(() => parseRepoFiles(claudeMd, review, badTowercab))).toBe(
    "TOWERCAB.md: front matter: max_autonomy must be an integer 1-5",
  );
});

test("repo: verifying blocks", () => {
  // Lines trimmed, blank and `#` lines dropped, order kept.
  const v = parseVerifying(
    claude(
      "Prose.\n\n```setup\nnpm ci\n\n```\n  ```checks\n  cargo fmt --check\n\n# lint\ncargo clippy -- -D warnings  \n cargo test\n  ```\n\n```fast\nmake lint\n\n# subset\n make unit {tests}\n```\n",
    ),
  );
  expect(v.setup).toEqual(["npm ci"]);
  expect(v.checks).toEqual(["cargo fmt --check", "cargo clippy -- -D warnings", "cargo test"]);
  expect(v.fast).toEqual(["make lint", "make unit {tests}"]);
  expect(parseVerifying(claude(CHECKS)).fast).toBeNull();
  // An empty fast block is a block: no local checks.
  expect(parseVerifying(claude(`${CHECKS}\`\`\`fast\n# nothing is fast\n\`\`\`\n`)).fast).toEqual([]);
  // The heading matches case-insensitively and trimmed; blocks elsewhere are prose.
  expect(
    parseVerifying(
      "```checks\nnot this\n```\n\n## verifying YOUR work  \n\n```checks\nmake test\n```\n\n## Other\n\n```checks\nnor this\n```\n",
    ).checks,
  ).toEqual(["make test"]);
  // The section ends at the next `# ` or `## ` line, not `###`; headings inside fences don't count.
  expect(
    parseVerifying(
      "## Verifying your work\n\n### Sub\n\n```text\n## Not a heading\n```\n\n```checks\nmake\n```\n# Next\n```checks\nother\n```\n",
    ).checks,
  ).toEqual(["make"]);
  // An empty block is no block, so another one is fine.
  expect(parseVerifying(claude("```checks\n\n# nothing\n```\n\n```checks\nmake\n```\n")).checks).toEqual([
    "make",
  ]);
  // CommonMark fences: a longer fence holds shorter ones, tildes, inline code is no fence; closing `#`s.
  expect(
    parseVerifying(
      "## Verifying your work ##\n\nLike this:\n\n````markdown\n```checks\nnot this\n```\n````\n\n```inline``` code is prose.\n\n~~~checks\nmake\n```\nstill make\n~~~~\n",
    ).checks,
  ).toEqual(["make", "```", "still make"]);
  expect(error(() => parseVerifying("## Verifying your work#\n\n```checks\nmake\n```\n")).kind).toBe(
    "noVerifying",
  );
  // Errors name the file and the line.
  expect(invalid(() => parseVerifying(claude("```checks\na\n```\n```checks\nb\n```\n")))).toBe(
    "CLAUDE.md: line 14: two ```checks blocks",
  );
  expect(
    invalid(() =>
      parseVerifying(
        "## Verifying your work\n```checks\nmake\n```\n## verifying your work\n```setup\nx\n```\n",
      ),
    ),
  ).toBe("CLAUDE.md: line 5: two ## Verifying your work sections");
  expect(invalid(() => parseVerifying(`${claude(CHECKS)}\n\`\`\`text\nnever closed\n`))).toBe(
    "CLAUDE.md: line 19: unclosed ```text block",
  );
});

test("repo: screenshots block", () => {
  const v = parseVerifying(claude(`${CHECKS}\`\`\`screenshots\n# one command\nnpm run shots\n\`\`\`\n`));
  expect(v.screenshots).toBe("npm run shots");
  expect(parseVerifying(claude(CHECKS)).screenshots).toBeNull();
  expect(invalid(() => parseVerifying(claude(`${CHECKS}\`\`\`screenshots\na\nb\n\`\`\`\n`)))).toBe(
    "CLAUDE.md: screenshots: one command, got 2",
  );
});

test("repo: missing verifying block waits", () => {
  for (const text of [
    "# Repo\n\n## Commands\n\n```checks\nmake\n```\n",
    claude("Run the tests.\n\n```setup\nmake deps\n```\n"),
    claude("```checks\n\n# nothing yet\n```\n"),
    `${CHECKS}\n${claude("No block here.")}`,
    "## Verifying your work\n\n```fast\nmake lint\n```\n",
  ]) {
    const e = error(() => parseRepoFiles(text, null, null));
    expect(e.kind, text).toBe("noVerifying");
    expect(e.message).toBe("add CLAUDE.md verifying block");
  }
  expect(error(() => parseRepoFiles(null, null, null)).kind).toBe("noVerifying");
});

test("repo: REVIEW.md sections", () => {
  const text =
    "# Review\n\nIntro.\n\n## passes\n\n- **Bugs**: wrong behaviour,\n  unhandled errors.\n* **Security:** secrets\n+ _Spec_: rows built\n\nNot a bullet.\n\n## What IMPORTANT means here\n\nLoses data.\n\nOr merges the wrong thing.\n\n## Cap the nits\n\nShow 3 nits, then 10 more never.\n\n## Do not report\n\n- Style.\n- Docs on\n  private items.\n\n```text\n- not a bullet\n## not a section\n```\n\n## Red Lines\n\n- `migrations/**`: schema\n- auth\n\n## Other\n\n- ignored\n";
  const r = parseReview(text);
  expect(r.text).toBe(text);
  expect(r.passes).toEqual([
    { name: "Bugs", what: "wrong behaviour, unhandled errors." },
    { name: "Security", what: "secrets" },
    { name: "Spec", what: "rows built" },
  ]);
  expect(r.important).toBe("Loses data.\n\nOr merges the wrong thing.");
  expect(r.nitCap).toBe(3);
  expect(r.doNotReport).toEqual(["Style.", "Docs on private items."]);
  expect(r.redLines).toEqual(["`migrations/**`: schema", "auth"]);
  // Every list item counts: ordered, indented up to 3 spaces, a tab, nested (flattened); a rule or `-x` is none.
  const r2 = parseReview(
    "## Passes\n\n1. Bugs: wrong results\n2) Security: secrets\n\n## Red lines\n\n1. migrations/**\n - auth\n-\tbilling\n   * public API\n10. data\n    deletion\n  - nested\n---\n-x\n",
  );
  expect(r2.passes.map((p) => p.name)).toEqual(["Bugs", "Security"]);
  expect(r2.redLines).toEqual(["migrations/**", "auth", "billing", "public API", "data deletion", "nested"]);
  for (const [t, want] of [
    ["## Passes\n\n- Bugs\n", '## Passes: want "<name>: <what>", got "Bugs"'],
    ["## Passes\n\n- **Bugs**:\n", '## Passes: want "<name>: <what>", got "**Bugs**:"'],
    ["## Passes\n\n- Bugs: a\n- **bugs**: b\n", "## Passes: pass bugs twice"],
    ["## Red lines\n\n- a\n\n## RED LINES\n\n- b\n", "line 5: two ## Red lines sections"],
    ["## Cap the nits\n\n99999999999 nits\n", "## Cap the nits: 99999999999 is too large"],
    ["## Passes\n\n```\n- a: b\n", "line 3: unclosed ``` block"],
    ["~~~\n```\n", "line 1: unclosed ``` block"],
  ]) {
    expect(
      invalid(() => parseRepoFiles(claude(CHECKS), t!, null)),
      t,
    ).toBe(`REVIEW.md: ${want}`);
  }
});

test("repo: REVIEW.md defaults", () => {
  const d = defaultReview();
  expect(d.passes.map((p) => p.name)).toEqual(["Bugs", "Security", "Compliance"]);
  expect(d.passes).toEqual(DEFAULT_PASSES);
  expect([d.nitCap, d.important, d.doNotReport, d.redLines, d.text]).toEqual([
    5,
    null,
    DEFAULT_DO_NOT_REPORT,
    [],
    "",
  ]);
  // Missing sections, Passes without bullets, a cap without a number → defaults.
  const text =
    "# Review\n\n## Passes\n\nThe usual ones.\n\n## Cap the nits\n\nA few.\n\n## What Important means here\n\n\n";
  expect(parseReview(text)).toEqual({ ...defaultReview(), text });
  expect(parseReview("Just prose.\n").passes).toEqual(DEFAULT_PASSES);
  expect(parseReview("## Cap the nits\n\n0\n").nitCap).toBe(0);
});

test("repo: REVIEW.md do-not-report defaults", () => {
  expect(DEFAULT_DO_NOT_REPORT.join("\n")).toMatch(/linguist-generated/);
  expect(DEFAULT_DO_NOT_REPORT.join("\n")).toMatch(/[Ll]ockfiles/);
  expect(DEFAULT_DO_NOT_REPORT.join("\n")).toMatch(/formatter or linter/);
  // No section, or one without bullets → the defaults; a section with bullets replaces them.
  expect(parseReview("## Passes\n\n- Bugs: wrong results\n").doNotReport).toEqual(DEFAULT_DO_NOT_REPORT);
  expect(parseReview("## Do not report\n\nNothing special.\n").doNotReport).toEqual(DEFAULT_DO_NOT_REPORT);
  expect(parseReview("## Do not report\n\n- Docs.\n").doNotReport).toEqual(["Docs."]);
});

test("repo: TOWERCAB.md front matter", () => {
  const got = parseTowercab(
    '---\nmax_autonomy: 2\nprotected: [src/machine.ts, "ops/**"]\ntests:\n  - spec/**\n  - "**/*_spec.rb"\n---\n\n# Notes\n',
  );
  expect(got).toEqual({
    maxAutonomy: 2,
    protected: ["src/machine.ts", "ops/**"],
    tests: ["spec/**", "**/*_spec.rb"],
  });
  expect(defaultTowercab()).toEqual({
    maxAutonomy: 5,
    protected: [],
    tests: [
      "tests/**",
      "test/**",
      "**/__tests__/**",
      "**/*_test.*",
      "**/test_*.*",
      "**/*.test.*",
      "**/*.spec.*",
    ],
  });
  for (const t of [
    "",
    "# Towercab\n\nNo front matter.\n",
    "---\n---\n",
    "---\n# just a comment\n---\nbody\n",
    "---\nprotected:\ntests: []\n---\n",
    "\uFEFF---\r\nprotected: []\r\ntests:\r\n---\r\n",
    // Keys in fences or indented are prose.
    "# Notes\n\n```yaml\nmax_autonomy: 3\n```\n\n  protected: [x]\nmax_autonomy_note: y\n",
  ]) {
    expect(parseTowercab(t), JSON.stringify(t)).toEqual(defaultTowercab());
  }
  for (const t of [
    "--- \nmax_autonomy: 2\nprotected: [x]\n---  \n",
    "\n  \n---\nmax_autonomy: 2\nprotected: [x]\n ---\n",
  ]) {
    expect(parseTowercab(t)).toMatchObject({ maxAutonomy: 2, protected: ["x"] });
  }
  expect(parseTowercab('---\nprotected: migrations/**\ntests: "spec/**"\n---\n')).toMatchObject({
    protected: ["migrations/**"],
    tests: ["spec/**"],
  });
  const err = (t: string) => {
    try {
      parseTowercab(t);
    } catch (e) {
      return (e as Error).message;
    }
    return "no error";
  };
  for (const [t, want] of [
    ["---\nmax_autonomy: 5\n", "front matter: no closing ---"],
    [
      "# Towercab\n\n---\nmax_autonomy: 1\nprotected: [secrets/**]\n---\n",
      "line 4: max_autonomy outside front matter",
    ],
    ["<!-- settings -->\n---\nprotected: [secrets/**]\n---\n", "line 3: protected outside front matter"],
    ["---\nmax_autonomy: 2\n---\n\ntests : [spec/**]\n", "line 5: tests outside front matter"],
    ["---\n- a\n- b\n---\n", "front matter: not a mapping"],
    ["---\nmax_autonomy: 5\nmodel: opus\n---\n", "front matter: unknown key model"],
    ["---\nmax_autonomy: 5\nmax_autonomy: 4\n---\n", "front matter: max_autonomy twice"],
    ["---\n1: x\n---\n", "front matter: unknown key 1"],
    ["---\nmax_autonomy: 0\n---\n", "front matter: max_autonomy must be an integer 1-5"],
    ['---\nmax_autonomy: "3"\n---\n', "front matter: max_autonomy must be an integer 1-5"],
    ["---\nmax_autonomy: 2.5\n---\n", "front matter: max_autonomy must be an integer 1-5"],
    ["---\nmax_autonomy:\n---\n", "front matter: max_autonomy must be an integer 1-5"],
    ["---\nprotected: 3\n---\n", "front matter: protected must be a list of globs"],
    ["---\nprotected: [a, 3]\n---\n", "front matter: protected must be a list of globs"],
    ["---\ntests: {a: b}\n---\n", "front matter: tests must be a list of globs"],
    ['---\nprotected: ["../x"]\n---\n', 'front matter: protected: bad glob "../x"'],
    ['---\nprotected: [""]\n---\n', 'front matter: protected: bad glob ""'],
    ['---\nprotected: ["src/[a"]\n---\n', 'front matter: protected: bad glob "src/[a"'],
  ]) {
    expect(err(t!), t).toBe(want);
  }
  expect(err("---\nprotected: [a\n---\n")).toMatch(/^front matter: /);
});

/** A bare origin with the three files, and Towercab's clone of it. */
function repo(files: Record<string, string>): { bare: string; clone: string } {
  const bare = bareRepo(files);
  const clone = join(tempDir("tc-clone-"), "clone");
  git(join(clone, ".."), "clone", "-q", bare, clone);
  return { bare, clone };
}

const CLAUDE = "# Repo\n\n## Verifying your work\n\n```checks\nmake test\n```\n";

test("repo: read from the base branch only", async () => {
  const tools = new FakeTools();
  const { bare, clone } = repo({
    "CLAUDE.md": CLAUDE,
    "REVIEW.md": "## Red lines\n\n- auth\n",
    "TOWERCAB.md": "---\nmax_autonomy: 3\n---\n",
  });
  const files = await loadRepoFiles(tools, clone, "main");
  expect(files.claudeMd).toBe(CLAUDE);
  expect(files.verifying.checks).toEqual(["make test"]);
  expect(files.review.redLines).toEqual(["auth"]);
  expect(files.towercab.maxAutonomy).toBe(3);

  // Never the working tree or a local (PR) branch.
  writeFileSync(join(clone, "CLAUDE.md"), "nothing here\n");
  git(clone, "checkout", "-q", "-b", "towercab/1-x");
  writeFileSync(join(clone, "TOWERCAB.md"), "---\nmax_autonomy: 5\n---\n");
  git(clone, "add", "TOWERCAB.md");
  git(clone, "commit", "-q", "-m", "pr");
  expect((await loadRepoFiles(tools, clone, "main")).towercab.maxAutonomy).toBe(3);

  // origin/<base> as it is: no fetch here; after the caller fetches, the new base.
  pushFiles(bare, { "CLAUDE.md": CLAUDE.replace("make test", "make check") });
  expect((await loadRepoFiles(tools, clone, "main")).verifying.checks).toEqual(["make test"]);
  git(clone, "fetch", "-q", "origin");
  expect((await loadRepoFiles(tools, clone, "main")).verifying.checks).toEqual(["make check"]);

  // A missing base, or a bad one: a git error naming the clone.
  const e1 = await loadRepoFiles(tools, clone, "nope").catch((e: RepoError) => e);
  expect(e1).toBeInstanceOf(RepoError);
  expect((e1 as RepoError).kind).toBe("git");
  expect((e1 as RepoError).message.startsWith(`${clone}: `)).toBe(true);
  const e2 = await loadRepoFiles(tools, clone, "main:sub").catch((e: RepoError) => e);
  expect((e2 as RepoError).message).toBe(`${clone}: bad base "main:sub"`);
  // A directory inside the clone is no clone.
  mkdirSync(join(clone, "sub"));
  expect(((await loadRepoFiles(tools, join(clone, "sub"), "main").catch((e) => e)) as RepoError).kind).toBe(
    "git",
  );

  // Absent optional files default; an executable file is a regular file.
  pushFiles(bare, { "REVIEW.md": null, "TOWERCAB.md": null });
  git(clone, "fetch", "-q", "origin");
  const later = await loadRepoFiles(tools, clone, "main");
  expect(later.review).toEqual(defaultReview());
  expect(later.towercab).toEqual(defaultTowercab());

  // A symlink in a file's place is invalid.
  const work = join(tempDir(), "w");
  git(join(work, ".."), "clone", "-q", bare, work);
  chmodSync(join(work, "CLAUDE.md"), 0o755);
  symlinkSync("CLAUDE.md", join(work, "REVIEW.md"));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "link");
  git(work, "push", "-q", "origin", "main");
  git(clone, "fetch", "-q", "origin");
  const e3 = (await loadRepoFiles(tools, clone, "main").catch((e) => e)) as RepoError;
  expect([e3.kind, e3.message]).toEqual(["invalid", "REVIEW.md: a symlink, not a file"]);
});

test("repo: Towercab's own files parse", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  const own = parseRepoFiles(read("CLAUDE.md"), read("REVIEW.md"), read("TOWERCAB.md"));
  expect(own.claudeMd.split("\n").length).toBeLessThanOrEqual(61);
  expect(own.verifying.setup).toEqual(["npm ci", "npx playwright install chromium"]);
  expect(own.verifying.checks).toEqual(["npm run check"]);
  expect(own.verifying.fast).toEqual(["npm run lint", "npm run typecheck", "npx vitest run {tests}"]);
  expect(own.review.passes.map((p) => p.name)).toEqual(["Bugs", "Security", "Compliance"]);
  expect(own.review.redLines.some((l) => l.includes("src/machine.ts"))).toBe(true);
  expect(own.towercab).toEqual({ maxAutonomy: 5, protected: ["src/machine.ts"], tests: ["tests/**"] });
});

test("repo: Towercab's setup installs the Playwright browser", () => {
  const own = parseRepoFiles(
    readFileSync("CLAUDE.md", "utf8"),
    readFileSync("REVIEW.md", "utf8"),
    readFileSync("TOWERCAB.md", "utf8"),
  );
  expect(own.verifying.setup.at(-1)).toBe("npx playwright install chromium");
  expect(own.verifying.screenshots).toBe("npm run test:ui");
  expect(own.claudeMd.split("\n").length).toBeLessThanOrEqual(61);
});

test("repo: CI is read from the base branch", async () => {
  const tools = new FakeTools();
  const { bare, clone } = repo({ "CLAUDE.md": CLAUDE });
  expect(await hasCi(tools, clone, "main")).toBe(false);
  pushFiles(bare, { ".github/workflows/README.md": "no\n" });
  git(clone, "fetch", "-q", "origin");
  expect(await hasCi(tools, clone, "main")).toBe(false);
  pushFiles(bare, { ".github/workflows/build.yaml": "on: push\n" });
  expect(await hasCi(tools, clone, "main")).toBe(false);
  git(clone, "fetch", "-q", "origin");
  expect(await hasCi(tools, clone, "main")).toBe(true);
});
