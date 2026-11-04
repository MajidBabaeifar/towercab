# Repo files

**Status:** Live: REPO-1..12 · **Prefix:** REPO

## Purpose

What Towercab reads from a target repo to know how to build and judge a change there: how to set up
and check it (`CLAUDE.md`), how to review it (`REVIEW.md`), and Towercab-specific settings
(`TOWERCAB.md`). These come from the base branch only, so a PR can't change the rules it is judged by.

## Requirements

### REPO-1 · Read from the base branch

Towercab reads `CLAUDE.md`, `REVIEW.md` and `TOWERCAB.md` from the base branch of its own clone,
never from a PR or a working tree.

- `loadRepoFiles(clone, base)`: `git ls-tree -z --full-tree refs/remotes/origin/<base> -- CLAUDE.md
  REVIEW.md TOWERCAB.md`, then `git cat-file blob <oid>` for each regular file. A symlink, directory
  or non-UTF-8 file in a file's place → `RepoError.invalid("<file>: …")`; a failed git →
  `RepoError.git`. Then the pure `parseRepoFiles(claude, review, towercab)` (**Grammar**).
- `TOWERCAB.md` front matter: `max_autonomy` (1–5, default 5), `protected` (globs), `tests` (globs,
  default the list in [PIP-30](pipeline.md)), `live` (the ship stage's block, [SHIP-1](ship.md)). Any
  other key → `unknown key <k>`.
- Verified by: `repo: parse the three files`, `repo: read from the base branch only`, `repo: TOWERCAB.md front matter`

### REPO-2 · The verifying section

`CLAUDE.md` tells Towercab how to set up and check the repo, in fenced blocks under
`## Verifying your work`.

- ` ```setup ` (commands with network after each clone and before checks, such as `npm ci`),
  ` ```checks ` (the full suite, one command per line, run without network), optional ` ```fast `
  (the subset run before publishing when the repo has CI, REPO-9), optional ` ```screenshots `
  (REPO-10). Prose around them is for the agent.
- Verified by: `repo: verifying blocks`

### REPO-3 · Live, release and rollback blocks

Removed: the ship stage is parked (intent 261026-2204-4).

### REPO-4 · REVIEW.md

`REVIEW.md` tells the reviewer what to look for in this repo and what counts as important.

- Sections: `## Passes` (bullets `name: what`; none → Bugs, Security, Compliance with the spec rows
  and the plan), `## What Important means here`, `## Cap the nits` (first number, default 5),
  `## Do not report`, `## Red lines` (paths or behaviours whose change makes a PR high-risk). The
  whole text goes to the review ([PIP-4](pipeline.md)).
- Verified by: `repo: REVIEW.md sections`, `repo: REVIEW.md defaults`

### REPO-5 · No verifying section

A repo without a checks block waits for the owner to add one.

- No `## Verifying your work` with a non-empty ` ```checks ` block on the base →
  `waiting: add CLAUDE.md verifying block`. `REVIEW.md` and `TOWERCAB.md` are optional.
- Verified by: `repo: missing verifying block waits`

### REPO-6 · Towercab's own repo files

Towercab's own `CLAUDE.md`, `REVIEW.md` and `TOWERCAB.md` describe its TypeScript codebase.

- `CLAUDE.md` (at most 60 lines: commands, conventions, architecture, what Claude gets wrong) with
  setup `npm ci` and the browser install of [REPO-11](#repo-11--playwright-browser-in-setup); checks `npm run check`; fast `npm run lint`, `npm run typecheck`,
  `npx vitest run {tests}`; screenshots `npm run test:ui`. `REVIEW.md`: passes Bugs, Security,
  Compliance; red lines `src/machine.ts`, `src/pipeline/guard.ts` and `src/claude.ts`. `TOWERCAB.md`: `max_autonomy: 5`, `protected: [src/machine.ts]`,
  `tests: [tests/**]`.
- Verified by: `repo: Towercab's own files parse`

### REPO-7 · protect

Removed: never used (no repo had a ruleset); parked as intent 261026-2204-5.

### REPO-8 · Protected paths

Some paths decide how a change is judged, so a worker can write them only when its autonomy or plan
allows ([AUT-14](autonomy.md)).

- Protected = `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `TOWERCAB.md`, `.github/**`, `.claude/**`, `.git/**` plus
  `TOWERCAB.md` `protected`. `.git/**` is never writable.
- `protectedPaths(protected, granted).blocks(rel)`: true when a protected glob matches the path or a
  parent directory and no granted glob does; an absolute path, a `..` component or `.git` → true.
  `denyWrite(checkout)` lists the absolute paths that exist and are blocked, for the sandbox.
- Verified by: `repo: protected paths block`, `repo: granted paths unblock`, `repo: .git is never writable`

### REPO-9 · Run set

Before publishing, Towercab runs the fast checks when the repo has CI, and the full checks when it
doesn't.

- `runSet(verifying, hasCi, changedTests)`: no CI → `checks`. CI and a ` ```fast ` block → its lines;
  CI and no block → `checks`. In a fast line, `{tests}` → the changed test files and `{stems}` → their
  file stems, space-separated and shell-quoted; a line with a placeholder and no changed tests is
  skipped. `hasCi` = the base branch has `.github/workflows/*.yml` or `*.yaml`.
- Verified by: `repo: run set without CI`, `repo: run set with fast`, `repo: placeholders`

### REPO-10 · Screenshots block

A repo with a UI can give Towercab a command that takes screenshots, and the review sees them.

- ` ```screenshots ` under `## Verifying your work`: one command, run after green checks in the
  sandbox ([PIP-23](pipeline.md)) with `TOWERCAB_SHOTS=<dir>` set; every `*.png` it writes there
  (at most 20, each ≤ 5 MB) goes to the review ([PIP-49](pipeline.md)). No block → no screenshots.
- Verified by: `repo: screenshots block`, `pipeline: screenshots reach the review`

### REPO-11 · Playwright browser in setup

Towercab's own setup installs Playwright's headless Chromium into the mission's build cache, so the
screenshots command runs in every mission.

- Towercab's `CLAUDE.md` ` ```setup ` block is `npm ci` then `npx playwright install chromium`. The
  browser lands under `XDG_CACHE_HOME` (`<cache>/xdg/ms-playwright`, [LOOP-34](loop.md)), where the
  later screenshots run finds it; a second mission finds it already there and downloads nothing.
- Setup runs with network ([PIP-23](pipeline.md)), so it can reach `cdn.playwright.dev` without a
  change to `[agent].network` or the repo's allowed domains. No default domain is added.
- With the browser installed, the screenshots log of a new mission shows `npm run test:ui` passing
  with no browser-missing error, and the review gets the screenshots ([REPO-10](#repo-10--screenshots-block)).
- Verified by: `repo: Towercab's own files parse`, `repo: Towercab's setup installs the Playwright browser`

### REPO-12 · What the review leaves out by default

Without a `## Do not report` section, the review still skips generated files and the style the
repo's checks already enforce, so it spends no findings on what CI catches anyway.

- No `REVIEW.md`, or one without `## Do not report` ([REPO-4](#repo-4--reviewmd)) → the review
  prompt ([PIP-4](pipeline.md)) gets these defaults: files `.gitattributes` marks
  `linguist-generated`, lockfiles, and formatting or lint issues a formatter or linter in the repo's
  checks would catch. A `## Do not report` section with bullets replaces the defaults; one without
  bullets keeps them, as `## Passes` does.
- Verified by: `repo: REVIEW.md do-not-report defaults`, `pipeline: review prompt has the do-not-report defaults`

### REPO-13 · Existing tests are write-blocked

From the first build round, a worker can't edit or delete a test file that already exists on the base
branch unless that file was granted; new test files stay free.

- Blocked = files at `origin/<base>` matching PIP-30's globs (`TOWERCAB.md` `tests`, or the defaults;
  e2e suites under a `live` block are left out as there), listed when the run starts. Like a
  protected path (REPO-8) they go into the guard's rules and the sandbox's `denyWrite`; a file
  matching `protected` is blocked either way. A file is unblocked only by a grant (PIP-115,
  PIP-116), whatever the autonomy ([AUT-14](autonomy.md)'s access levels do not apply).
- The guard's reason names the test and ends with how to ask (PIP-116). The block holds in
  every worker round, repairs included; PIP-31's lock on tests pushed earlier is separate and stays.
- Verified by: `repo: existing tests are blocked`, `repo: new tests are not blocked`, `repo: granted tests unblock`, `guard: blocks an existing test`

**Grammar** (`src/repo/markdown.ts`)

- Every file: UTF-8, a leading BOM dropped, lines split on `\n`, a trailing `\r` dropped. The first
  error wins and reads `<file>: <where>: <what>`.
- Fence: a line starting (after spaces) with 3 or more backticks or tildes opens a block named by the
  rest of the line; the next line of at least as many of the same character closes it (none →
  `unclosed ```<name> block`). Body = its lines trimmed, minus blank lines and lines starting `#`.
  Two blocks of one name → `two ```<name> blocks`.
- Section: outside fences, a column-0 `## <title>` line up to the next `# ` or `## ` line; titles
  compare trimmed and case-insensitive. A known title twice → `two ## <title> sections`.
- Bullet: a list item (`-`, `*`, `+`, or digits and `.` or `)`), continued by the indented lines
  after it.
- Globs (`protected`, `tests`, `unlock`): `picomatch` with `dot: true`; `*` stays in one path
  component, `**` spans them; relative to the repo root; `P/**` also matches `P`. A bad glob →
  `<key>: bad glob "<g>"`.

## Out of scope

- Live, release and rollback blocks; rulesets (parked).

## Decisions

- The base branch is the only source: a PR that edits `CLAUDE.md` can't loosen its own checks.
  One exception: when the owner granted the PR the right to change `CLAUDE.md`, the red→green proof
  runs that PR's checks block ([PIP-54](pipeline.md)); verify and CI still use the base's.
- `fast` exists so a repo with CI doesn't run a slow full suite on every round locally; CI stays the
  gate.
