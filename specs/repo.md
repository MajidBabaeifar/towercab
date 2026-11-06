# Repo files

**Status:** Live: REPO-1..13, REPO-14..19, REPO-20..27, REPO-30..32 · **Prefix:** REPO

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
  default the list in [PIP-30](pipeline.md)), `live` (the ship stage's block, [SHIP-1](ship.md)),
  `releases` (`auto` or `manual`, default `auto`; [SHIP-30](ship.md)), `kind`, `readiness`, `waive`
  and `go_live` ([REPO-20](#repo-20--a-repos-kind), once built). Any
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

A repo without a checks block gets one drafted by Towercab ([REPO-34](#repo-34--drafting-a-verifying-section)); it waits for the owner only when no check can be found ([REPO-37](#repo-37--asking-only-when-nothing-passes)).

- No `## Verifying your work` with a non-empty ` ```checks ` block on the base → the setup path of
  REPO-34..36 runs first. Only its failure ends in `waiting: add CLAUDE.md verifying block`.
  `REVIEW.md` and `TOWERCAB.md` are optional.
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

### REPO-14 · Per-repo tuning lives in TOWERCAB.md

A repo's work limits are written in its own `TOWERCAB.md`, so anyone who reads the repo can see them.

- Two more `TOWERCAB.md` front matter keys ([REPO-1](#repo-1--read-from-the-base-branch)): `workers`
  (int 1–16, default 1: missions from build through merge at once, [LOOP-61](loop.md)) and `ahead` (int
  1–16, default 3: intents ahead of build, [LOOP-60](loop.md)). Anything else → `workers: <v> isn't a
  whole number from 1 to 16` (or `ahead: …`), which makes the file invalid like any bad key.
- A change applies on the next fetch of the base branch, not mid-run: missions already past the limit
  keep running and no new one starts until the count is under it.
- `path`, `base`, `env` and the GitHub name stay in Towercab's database ([LOOP-65](loop.md)): they say
  where the clone is and how it runs on this machine, and `base` is needed to find the file at all.
  `env` is never written to the repo, by a settings PR or the move: it can hold secrets and
  machine-specific paths. Its variable names (never the values) are shown on the repo page
  ([UI-150](ui.md)), so they aren't hidden.
- The parser ships before Towercab changes any repo's file on its own: until
  [REPO-19](#repo-19--the-one-time-move)'s 24-hour wait is over, only the owner's own save from the
  form ([REPO-16](#repo-16--a-settings-change-is-a-pull-request)) can write `workers` or `ahead`, and
  only after a confirmation: a save in that window needs `confirmed: true`, and without it the server
  refuses with `An older Towercab can't read this setting; a rollback in the next day would need a manual
  fix.` The automatic move PRs wait for the end of the window. An older Towercab rejects the unknown
  keys (REPO-1), which is why a rollback needs a manual fix.
- Verified by: `repo: TOWERCAB.md workers and ahead`, `repo: a bad workers or ahead is invalid`, `repo: a new limit applies on the next fetch`

### REPO-15 · Which value wins

`TOWERCAB.md` is the one source of truth for `workers` and `ahead`; the database value is used only until the repo has moved.

- A key written in the base branch's `TOWERCAB.md` wins. A key absent from it → the database value
  (set by `repo set`, or imported from `config.toml`) while the repo has *not moved*, and the default
  once it has. A repo has moved when its settings PR ([REPO-19](#repo-19--the-one-time-move)) is seen
  merged: `meta.repo-moved:<name>` is set then and stays.
- A repo with no readable `TOWERCAB.md` (none, or invalid, [REPO-18](#repo-18--changes-made-outside-towercab))
  keeps the values it had at the last good read; before any good read, the database values.
- After the move, `towercab repo set <name> workers=…` or `ahead=…` is refused: `workers and ahead for
  <name> now live in TOWERCAB.md; change them on the repo's page or in the file.` `doctor` names a
  `[repos.<name>]` `workers` or `ahead` that is still in `config.toml` for a moved repo as ignored.
- Verified by: `repo: a TOWERCAB.md key wins over the database`, `repo: before the move the database value is used`, `repo: after the move a missing key is the default`, `repo: an unreadable file keeps the last good limits`, `repo: repo set refuses moved keys`

### REPO-16 · A settings change is a pull request

Saving a setting opens a pull request that changes only that setting in `TOWERCAB.md`; nothing reaches the repo any other way.

- `proposeSettings(repo, changes)`: `changes` maps a key to a new value, or to `null` to remove it (back
  to the default). Only keys that differ from the base branch's file are written, with `setField` and
  `removeField` so every other line stays byte-identical. Nothing differs → no PR and the reply says
  `Nothing changed.`
- Towercab's App pushes branch `towercab/settings-<repo>-<n>` from the base branch and opens a PR titled
  `chore(towercab): change Towercab settings`, with a body in plain words (what changes, from what to
  what, that it was asked from Towercab's page) written to `prompts/writing.md`. The commit is made
  from the base branch with git plumbing in Towercab's clone, so its working tree is untouched.
- The PR goes through the repo's normal checks and always waits for the owner's approval, at any
  autonomy ([REPO-8](#repo-8--protected-paths)): Towercab never merges it itself.
- One settings PR per repo is open at a time. Saving again while it is open pushes a commit to the same
  PR with the new changes added to the old ones (a later value for the same key replaces the earlier); the
  PR's body is rewritten to match (the title names no keys, so it stays).
- A key or value that doesn't validate ([REPO-14](#repo-14--per-repo-tuning-lives-in-towercabmd)) is
  refused before any push, with the same reason. If the base branch's file is missing it is created with
  only the changed keys; if its front matter is invalid the PR is refused with the file's reason.
- Verified by: `repo: a settings change opens a PR with only that change`, `repo: unchanged settings open no PR`, `repo: other lines stay byte-identical`, `repo: a second save updates the open settings PR`, `repo: an invalid value opens no PR`, `repo: a settings PR is never merged by Towercab`

### REPO-17 · Pending until merged

A setting that is waiting in a pull request is shown as pending until the PR merges or closes.

- `pendingSettings(repo)` reads the repo's open settings PR (REPO-16) on every pass of the
  loop's PR reads and gives `{pr, url, changes}`; a setting is pending while the PR is open and
  its value differs from the base branch's.
- Merged → the value is read from the base branch at the next fetch (REPO-14) and the pending mark goes.
  Closed without merging → the mark goes and the value is unchanged. A PR the owner edits by hand shows
  what its head's file says.
- Verified by: `repo: a setting is pending while its PR is open`, `repo: a merged settings PR applies on the next fetch`, `repo: a closed settings PR leaves the value alone`

### REPO-18 · Changes made outside Towercab

A change made in the repo without Towercab applies the same way, and a file that no longer parses is reported with its reason.

- There is one path: `TOWERCAB.md` from the base branch ([REPO-1](#repo-1--read-from-the-base-branch)).
  A hand edit, another tool's PR or Towercab's own settings PR all take effect at the next fetch once on
  the base branch; Towercab keeps no second copy that could disagree.
- A file that fails to parse or validate keeps the repo in `waiting: fix repo files` as today, and the
  reason (the parser's message, for example `workers: 20 isn't a whole number from 1 to 16`) is kept with
  the repo until the file is valid again, for the repo page ([UI-153](ui.md)). Limits in force stay at
  the last good read (REPO-15).
- Verified by: `repo: a hand edit applies on the next fetch`, `repo: an invalid file reports its reason`, `repo: the reason clears when the file is valid`

### REPO-19 · The one-time move

Towercab opens one pull request per repo to bring its tuning from its own config into `TOWERCAB.md`, and stops reading the old values once it merges.

- For each repo that has not moved (REPO-15) and has no open or earlier move PR, Towercab compares the
  database `workers` and `ahead` with the defaults. Keys that differ and are absent from the base file go
  into one PR titled `chore(towercab): move Towercab settings into TOWERCAB.md` through REPO-16's path.
  Nothing differs → no PR; the repo is marked moved at once.
- The parser ships first and the move waits for it. The first time Towercab starts on a commit that
  reads `workers` and `ahead` from `TOWERCAB.md` (REPO-14), it records `meta.settings-parser` =
  `<commit> <unix time>` and never overwrites it. Move PRs are opened only when the clock reads at least
  24 hours past that time and the recorded commit is still part of the running checkout's history
  (`git merge-base --is-ancestor <commit> HEAD`). Time is elapsed, not uptime: a stop does not restart it.
  If the commit is no longer in the history (the change was rolled back or reverted, or Towercab went
  back to an older version), the record is cleared and the 24 hours start again from the next start on a
  commit with the parser. Until the gate opens, Towercab opens no move PR on its own, and `status` and
  the repo page say how long is left. The gate does not apply to the owner's own saves (REPO-14) or to
  `reopenMove`, which the owner asks for.
- Towercab asks on its own at most once per repo (`meta.repo-move:<name>` holds the PR number). A PR
  closed without merging is not replaced automatically: the database values stay in use and `doctor`
  warns `<name>: the PR that moves its settings into TOWERCAB.md was closed; open it again from the
  repo's page.` (a warning, exit code unchanged). Merging the PR marks the repo moved.
- `reopenMove(repo)`, asked by the owner from the repo's page ([UI-154](ui.md)), opens a new move PR the
  same way as the first, from the values at that moment; it is refused while a move PR is open or once
  the repo has moved (`<name> has already moved` / `a move PR is already open: #<n>`). The new PR's
  number replaces the stored one.
- Verified by: `repo: the first run of the parser is recorded once`, `repo: no move PR before 24 hours`, `repo: a save in the first 24 hours needs a confirmation`, `repo: a confirmed save in the first 24 hours opens the PR`, `repo: the move starts after 24 hours`, `repo: a rolled back parser restarts the 24 hours`, `repo: the move PR opens only once the wait is over`, `repo: the move opens one PR with the non-default values`, `repo: the move is skipped when nothing differs`, `repo: a closed move PR is not replaced on its own`, `repo: a closed move PR is a doctor warning`, `repo: the owner can open the move PR again`, `repo: a merged move PR marks the repo moved`

### REPO-20 · A repo's kind

Each repo says what kind it is in `TOWERCAB.md`, and the kind decides what setup it must have.

- `TOWERCAB.md` front matter key `kind` ([REPO-1](#repo-1--read-from-the-base-branch)): one of
  `service`, `site`, `cli`, `library`, `spec-only`, `infra`. Another value → `kind: <v> isn't one of
  service, site, cli, library, spec-only, infra`, which makes the file invalid (`waiting: fix repo files`).
- A kind written in `TOWERCAB.md` is *confirmed*. No `kind` (or no `TOWERCAB.md`) → the kind is
  *unconfirmed*: Towercab uses the kind it suggests ([REPO-21](#repo-21--suggesting-a-kind)), or none when
  there is no suggestion, and the repo only ever warns ([REPO-24](#repo-24--readiness)). Towercab never
  writes the kind: `TOWERCAB.md` is protected ([REPO-8](#repo-8--protected-paths)), so the owner confirms
  by committing it.
- `readiness`: `warn` (default) or `block`, per repo. Anything else → `readiness: <v> isn't warn or block`
  (the file is invalid). It takes effect only with a confirmed kind ([LOOP-70](loop.md)).
- `waive`: a list of lines `<item>: <reason>`, `<item>` one of REPO-22's items and the reason non-empty;
  anything else → `waive: <line>: …` (the file is invalid). A waived item counts as present
  ([REPO-24](#repo-24--readiness)).
- `infra` repos also give `go_live`, one line saying how their changes reach production (a non-empty
  string; see [REPO-22](#repo-22--required-setup-per-kind)).
- Verified by: `repo: TOWERCAB.md kind`, `repo: an unknown kind is invalid`, `repo: TOWERCAB.md readiness and waive`, `repo: a bad readiness or waive line is invalid`

### REPO-21 · Suggesting a kind

Towercab suggests a kind from the repo's files, so the owner confirms instead of working it out.

- `suggestKind(paths, manifests)` is pure, over the base branch's file list and `package.json` /
  `Cargo.toml` when present. The first rule that matches wins: `*.tf`, `ansible/` or an `apps:` file →
  `infra`; a `Dockerfile` or a compose file → `service`; a static-site generator config (`astro.config.*`,
  `_config.yml`, `hugo.*`, `mkdocs.yml`) or a root `index.html` with no server code → `site`;
  `package.json` `bin`, or `Cargo.toml` `[[bin]]` or `src/main.rs` → `cli`; `package.json` `main` or
  `exports`, or `src/lib.rs` → `library`; only Markdown and `specs/` → `spec-only`. No rule matches → no suggestion.
- Until the owner confirms a kind, the suggestion stands in for it: the required setup, the readiness
  warnings and the stage map ([REPO-26](#repo-26--which-stages-apply)) all use it. It is shown with the
  repo's missing items ([UI-156](ui.md)), but is never written to the repo.
- Verified by: `repo: suggest a kind from files`, `repo: no suggestion when nothing matches`

### REPO-22 · Required setup per kind

Each kind has a fixed list of setup a repo should have, and Towercab can hold work back until it does.

- Every repo: `ci` (CI with required checks), `settings` (the standard GitHub settings), `release`
  (release-please) and `verifying` (a `## Verifying your work` section with a `checks` block, REPO-5).
- `service` adds `image` (a signed image), `apps` (its `apps:` entry in the `infra` repo), `deploy` (the
  deploy jobs) and `live` (a `live` block with a smoke suite, [SHIP-1](ship.md)).
- `site` adds `live`.
- `cli` and `library` add `publish` (release publishing set up).
- `infra` adds `go_live` (the stated way its changes go live: a one-line `go_live` note in `TOWERCAB.md`, or a `live` block).
- `spec-only` adds nothing.
- `requiredSetup(kind)` returns the list, in this order, for the checks of REPO-23 and the words of REPO-24.
- Verified by: `repo: required setup per kind`

### REPO-23 · How each item is checked

Every item is checked from files and settings Towercab can read cheaply, never by running CI.

- From the base branch's file list and contents, plus a few `gh api` reads as the App (LOOP-19):
  - `ci`: a `.github/workflows/*.yml` file, and the base branch's rules require at least one status check
    (`gh api repos/<r>/rules/branches/<base>`).
  - `settings`: [REPO-25](#repo-25--the-settings-check).
  - `release`: `release-please-config.json`, `.release-please-manifest.json` and a workflow that uses release-please.
  - `verifying`: REPO-5's rule.
  - `image`: a workflow that builds an image and signs it (`cosign sign`, or a call to the shared image
    workflow in `ci`).
  - `apps`: the `infra` repo's `apps:` list has an entry for this repo (read from `infra`'s base branch).
  - `deploy`: a workflow with a job whose name starts `deploy`.
  - `live`: a valid `live` block with at least one suite that has `smoke: true`.
  - `publish`: a workflow job named `publish*`, or one running `npm publish`, `cargo publish` or a PyPI publish action.
  - `go_live`: a non-empty `go_live` line, or a valid `live` block.
- Nothing is cloned or built for these checks; no workflow runs. Each reads at most a handful of API
  calls, and the whole check has a 60 s limit.
- Verified by: `repo: each setup item is checked from files`, `repo: apps entry is read from infra`, `repo: live needs a smoke suite`

### REPO-24 · Readiness

A repo is ready when none of its required setup is missing, and Towercab says each missing item in
plain words; a repo whose kind nobody confirmed only warns.

- `repoReadiness(kind, confirmed, checks, waive)` → `{ kind, confirmed, ready, items: [{ item, state,
  words }] }`. `state` is `present`, `missing`, `unknown` (the check could not run, REPO-25 and
  REPO-27) or `waived` (`words` is the owner's reason). A waived item counts as present. `ready` is
  true when no item is `missing`; an `unknown` item is a warning and does not make the repo not ready.
- Unconfirmed kind: `kind` is the suggestion of REPO-21 (none → only the every-repo items), and one
  extra item `kind` is `missing` with `Say what kind of repo this is: add kind to TOWERCAB.md`
  (naming the suggestion). Words name the fix, for example `No signed image: add a workflow that builds
  and signs one` or `The standard GitHub settings differ: run bin/apply-settings`.
- The result also says whether it *blocks*: `blocks` = not ready and the kind is confirmed and
  `readiness` is `block` ([REPO-20](#repo-20--a-repos-kind)). Everything else only warns.
- The check runs whenever Towercab fetches the repo ([LOOP-8](loop.md)) and at the pick step, and the result is kept in
  `meta` (`readiness:<repo>`, JSON with the base commit it was read at and the time) so pages read no network.
- Verified by: `repo: readiness lists each missing item in words`, `repo: an unconfirmed kind uses the suggestion and only warns`, `repo: a waived item counts as present`, `repo: only a confirmed block repo blocks`, `repo: readiness is stored at fetch`

### REPO-25 · The settings check

The standard GitHub settings are checked with the same check that `ci` uses, so the two cannot disagree.

- Towercab runs `bin/apply-settings --check <owner/name>` through `Tools` from the latest `v*` tag of the
  `ci` repo (newest by version), never from the clone's working tree: it exports that tag's files with a
  private index (the clone itself is only read), runs the script there as the App, with a minimal
  environment (`PATH`, `HOME` and the App's token for the repo being checked, nothing else from the loop's),
  removes the files and logs the tag (`settings check of <repo>: bin/apply-settings from ci <tag>`). Exit 0
  is `settings` present, exit 1 is missing with the script's first output line as the words. Towercab keeps
  no copy of the list of settings. The `ci` clone is fetched at most once per 10 minutes, with the checked
  repo's own fetch, under the loop's clone lock ([LOOP-71](loop.md)).
- No `ci` clone, no `v*` tag, no such script in the tag, or a script that cannot run (not exit 0 or 1) → the item is `unknown`
  with `The standard settings could not be checked: add the ci repo to Towercab` (or the reason). It is
  shown as a warning and never blocks. `ci` is a registered repo, so the clone is normally there.
- Verified by: `repo: settings check runs ci's script`, `repo: settings check without a ci clone is unknown`, `readiness: settings run from the latest v* tag of ci`, `readiness: settings without a ci release are unknown`, `readiness: the ci release is read without touching the clone and runs with the App's token only`

### REPO-26 · Which stages apply

Every kind has the same list of stages; a stage that does not apply says why.

- `stageApplies(kind, hasLive, stage)`: the stages from design to merge apply to every kind. The ship
  stages (`deploy`, `e2e`, `rollback`, `revert`, SHIP-1) apply to `service` and `site`, and to any repo with a
  valid `live` block. Otherwise they are skipped with a reason: `a library has nothing to deploy`, `a CLI
  has nothing to deploy`, `a spec-only repo has nothing to deploy`, `this repo's changes go live outside
  Towercab: <go_live>` (infra with no `live` block).
- `kind` is the confirmed kind, else the suggested one ([REPO-21](#repo-21--suggesting-a-kind)). With
  neither, the ship stages are skipped with `kind not set`.
- Verified by: `repo: ship stages are skipped with a reason for kinds that do not deploy`

### REPO-27 · A check that cannot run

A readiness check that fails for a network or GitHub reason never blocks or unblocks a repo by itself.

- A failed read is classified as in [LOOP-10](loop.md); the last stored result stands and the check runs again on the next
  fetch. The item whose read failed is `unknown` (a warning), never `missing`. With no stored result,
  nothing blocks and the repo shows `Not checked yet` until one check succeeds.
- A file that cannot be parsed (invalid `live`, bad `kind`) is a missing item with the parse error as its words, not a failure.
- Verified by: `repo: a failed readiness read keeps the last result`, `repo: no stored result never blocks`

### REPO-30 · A daily settings check

Towercab checks the standard GitHub settings of every registered repo once a day and shows the gaps on the repo's page.

- Once per 24 h per repo (and never more often than the fetch of [LOOP-8](loop.md) allows), the loop runs
  REPO-25's check for the repo, whatever its kind and whether or not it has a `TOWERCAB.md`. The target
  repo is not cloned. The result is kept in `meta` (`settings:<repo>`, JSON: `state` `ok`, `gaps` or
  `unknown`, the script's output lines as `gaps`, the `ci` tag that ran, the time). `ci` itself is
  checked like any other repo.
- The script is the pinned release of `ci`: `ciRelease(clone)` is the latest `v*` tag (highest version)
  of `<home>/repos/ci` merged into `origin/<base>` (`git tag --merged`). Towercab exports that tag's tree to a scratch
  directory (`git read-tree` into a private index, then `git checkout-index`, so the clone is only read) and runs
  `bin/apply-settings` from there, never from the clone's working tree or main head, so what Towercab
  applies changes only with a reviewed `ci` release. The run is logged with its tag
  (`apply-settings v<x.y.z> <check|apply> <owner/name>`). No such tag → the item is `unknown` with
  `No ci release to run the standard settings from: tag a v* release on ci's main`; Towercab never
  falls back to the head.
- Each run sets `GH_TOKEN` to the App's installation token for the repo's owner and passes only the
  repo named (`apply-settings [--check] <owner/name>` acts on the repos it is given and asks nothing).
- The repo page lists the gaps in plain words and the time of the last check; `ok` says
  `Standard settings in place`. A check that cannot run is `unknown` and keeps the last result
  ([REPO-27](#repo-27--a-check-that-cannot-run)). The check never blocks work: it only warns, and
  [REPO-24](#repo-24--readiness)'s `settings` item reads the same stored result.
- Verified by: `repo: settings run from the latest ci release tag on main`, `repo: no ci release tag is unknown, never the head`, `repo: the settings run is logged with its tag`, `repo: settings are checked daily for every repo`, `repo: settings gaps are stored and shown on the repo page`, `repo: a settings check that cannot run keeps the last result`

### REPO-31 · Applying the settings

With the owner's opt-in, Towercab applies the standard settings itself and checks again, and without it only reports.

- Config `[github] settings = "check" | "apply"`, default `check`; anything else → `settings must be check
  or apply`. It is the installation's switch; with `check`, nothing in this row runs. Once it is
  `apply`, every repo is applied to unless its `TOWERCAB.md` says `settings: check`
  ([REPO-1](#repo-1--read-from-the-base-branch)'s keys gain `settings`; only `check` is allowed, any
  other value → `settings: <v> isn't check`, which makes the file invalid).
- Per repo, when REPO-30 finds gaps and the repo is to be applied to: (1) the guard below, (2) the backup
  below, (3) `apply-settings <owner/name>` (no `--check`) from the pinned release, (4) `--check` again,
  stored as the result. Still `gaps` after the apply → the remaining lines are shown and Towercab does
  not apply again until the next daily check; it never loops. A repo with no gaps is not touched.
- Towercab keeps no list of settings: what is applied is whatever the pinned script applies
  ([REPO-25](#repo-25--the-settings-check)).
- **Ruleset guard.** The ruleset requires check names that the pinned script names itself: Towercab runs
  `apply-settings --plan <owner/name>` (JSON of what it would change, including the required check names;
  added by intent 261105-0010) and reads the names from it, so none is written in Towercab (today `ci-ok`).
  Before applying, Towercab reads the check runs of the head commit of the repo's base branch (`gh api
  repos/<r>/commits/<sha>/check-runs`); the guard passes only when every required name has a run that
  concluded `success` there. Then the script is applied whole. When the guard fails, the plan can't be
  read (a release without `--plan`) or the check runs can't be read, Towercab applies with
  `apply-settings --skip-ruleset <owner/name>` (also from 261105-0010) and stores and shows the gap as
  `Ruleset not applied: <name> has not run green on main`, so no repo becomes unmergeable. A release
  that rejects `--skip-ruleset` (a usage error, before it changes anything) → nothing is applied to that
  repo, only reported, with the reason stored. The next daily check tries again.
- **Backup.** Before every apply, Towercab saves everything the script can change, as one JSON file
  `<home>/settings-backups/<owner>/<name>/<UTC time>.json`: the repo's settings (`gh api repos/<r>`),
  its `security_and_analysis`, all rulesets (`repos/<r>/rulesets`, each with its full body), the classic
  branch protection of the default branch (`branches/<default_branch>/protection`, the name read from
  the repo's settings; the script acts only on the default branch), the Actions workflow permissions
  (`actions/permissions/workflow`) and whether vulnerability alerts are on (`vulnerability-alerts`).
  When the plan ([REPO-31](#repo-31--applying-the-settings)'s guard) names another branch it would
  change, that branch's protection is saved too. A part that does not exist (a 404, such as no branch
  protection) is saved as absent. The last 5 files
  per repo are kept, older ones are deleted. A backup that cannot be read or written in full → nothing
  is applied.
- **Restore.** `towercab settings restore <repo>` writes back, with the App token, only what the newest
  backup saved: the repo's settings and `security_and_analysis` (`PATCH repos/<r>`), each saved ruleset
  (`PUT`, recreated when deleted), the saved branch protections, the workflow permissions, and vulnerability
  alerts on or off as saved. A part saved as absent is not touched. Anything added since (a ruleset not
  in the backup, branch protection the backup lacks) is left alone and listed in the output as `Not in the
  backup, left as it is: <what>`. It prints what it restored and the backup's time; no backup → `<repo>
  has no saved settings`; unknown repo → as in [LOOP-69](loop.md)'s text; a forbidden write is REPO-32's
  permission message. It does not need the loop to be running.
- Verified by: `repo: settings stay check-only by default`, `repo: TOWERCAB.md settings check keeps a repo check-only`, `repo: a bad TOWERCAB.md settings value is invalid`, `repo: apply runs the script then checks again`, `repo: a gap that survives the apply is not retried until the next day`, `repo: a bad settings mode is rejected`, `repo: the required check names come from the plan`, `repo: a green main gets the whole apply`, `repo: a main not green gets everything but the ruleset`, `repo: a release without skip-ruleset applies nothing to a repo not green`, `repo: apply backs up everything the script can change and keeps 5`, `repo: the backup includes another branch the plan names`, `repo: no backup, no apply`, `cli: settings restore writes back what was saved`, `cli: settings restore lists what was added since and leaves it`

### REPO-32 · A missing permission is said once

If the GitHub App cannot change settings, `towercab doctor` says so in one line and the owner gets one step, never a wait without an exit.

- Applying (REPO-31) needs the App's Administration (write) permission. A 403 or "Resource not accessible"
  from the apply is that permission missing (not a network failure, [LOOP-10](loop.md)): it is stored
  (`settings-permission`) and nothing more is applied until `doctor` or the next daily check sees it
  granted.
- `doctor` prints one line while `settings = "apply"` and the permission is missing: `GitHub App lacks
  Administration (write): grant it at <app settings URL> so Towercab can apply settings`. With `check`, or
  with the permission present, it says nothing about it.
- The owner gets one step, shown with the repo's gaps and not once per repo: `Grant the Towercab GitHub
  App the Administration (write) permission`, ticked by the owner. Ticking it clears
  `settings-permission` so the next check applies again. No mission waits on it.
- Verified by: `doctor: missing Administration permission is one line`, `repo: a forbidden apply becomes one owner step`, `repo: a forbidden apply is not retried until the step is ticked`

### REPO-33 · A settings-only intent is done by Towercab

An intent whose whole outcome is a GitHub settings change is delivered as steps Towercab does itself, not as a code change.

- A plan with `delivery: steps` ([PIP-112](pipeline.md)) whose steps are all the standard settings (the
  plan marks them `by: towercab`) is not handed to the owner: with `settings = "apply"`, the repo not
  set to `settings: check` and the permission present, Towercab runs REPO-31 (guard and backup
  included) for the intent's repo, and ticks the steps itself once the re-check is `ok`; the intent
  then ends done as in [PIP-113](pipeline.md). A ruleset step held back by the guard stays unticked and
  is listed for the owner with the guard's words.
- With `check` (global or in the repo's `TOWERCAB.md`), or with the permission missing (REPO-32), the same steps are listed for the owner as
  ordinary owner steps ([SHIP-17](ship.md)) with the gaps as their text, so the intent has an exit. A
  setting outside the standard list (not in `ci`'s script) stays an owner step.
- Verified by: `repo: a settings-only intent is applied and ticked by Towercab`, `repo: a settings-only intent falls back to owner steps`

### REPO-34 · Drafting a verifying section

When a repo has no checks block, Towercab drafts one from what the repo already holds.

- `draftVerifying(files)` is pure over the base branch's file list and the text of the files it reads,
  and returns a `setup` and `checks` block (REPO-2) with the evidence for each line (the file it came
  from). Sources, in order: `package.json` scripts (`check`, `test`, `lint`, `typecheck`, `build`) with the
  package manager its lockfile names; a `Makefile` target (`check`, `test`); the commands of the
  `run:` steps in `.github/workflows/*.yml` that run on pull requests; `Cargo.toml`, `go.mod`,
  `pyproject.toml` with their usual test command. A repo of plain static files (an `index.html` or `*.html`,
  data files such as `*.json`, `*.ics`, `*.csv`) gets checks that parse each HTML file and validate each
  data file. Every command is written inline in the ` ```checks ` block, with no network, using only tools
  the sandbox already has (`node`, `python3` or `sh`, as found there); no script file is ever added to the repo.
  When no inline command can check a file type (say a format with no parser at hand), that type is left out
  and the PR body says so.
- Commands that need secrets, deploy, publish or reach the network in ` ```checks ` (`npm publish`, `curl`,
  `deploy*` targets, jobs that use `secrets.`) are never taken from CI. `setup` may use the network.
- If the repo has a test folder (a directory matching PIP-30's globs, or `TOWERCAB.md` `tests`), the draft
  runs it. A repo with none gets a check that runs the globs' default folder and passes while it is empty,
  so a test added by a build runs ([PIP-30](pipeline.md)) and the proof can show it failing without the change.
- The draft states the evidence for each line in plain words; it changes nothing but `CLAUDE.md`: no
  script, config or test file, and no `.gitignore` or lockfile change.
- Verified by: `repo: draft from package scripts`, `repo: draft from a Makefile`, `repo: draft from CI workflows`, `repo: draft for a static site validates its files`, `repo: draft never takes deploy or secret commands`, `repo: draft runs the test folder`, `repo: draft runs a test folder added later`

### REPO-35 · A draft must pass first

Towercab proposes a draft only if its checks pass on the base branch.

- The draft's `setup` and `checks` run once in the sandbox ([PIP-23](pipeline.md)) on a clean checkout of
  the base branch, with the usual limits. If `checks` fail, Towercab tries the next source (REPO-34's
  order), at most 3 drafts. The first draft that exits 0 is used; the output of the run is kept for the PR.
- A check that passes only because it runs nothing (no command found, an empty test folder aside)
  doesn't count: a draft needs at least one command that reads the repo's own files.
- Verified by: `repo: a draft runs on the base branch before it is proposed`, `repo: a failing draft falls back to the next source`, `repo: a draft that checks nothing is not used`

### REPO-36 · The setup pull request

Towercab opens the chosen draft as a small pull request in the repo, and the waiting intent continues by itself once it merges.

- The PR changes exactly one file, `CLAUDE.md` (created, or given the section; text already there stays
  byte-identical). Any other changed path is a bug: Towercab refuses to push it. Branch `towercab/setup-<repo>`, title `chore(towercab): add verifying checks`, a body to
  `prompts/writing.md`: what the checks do, where each line came from, that it passed on the base
  branch, and what it doesn't cover.
- It goes through the repo's autonomy like any other change ([AUT-14](autonomy.md)), unlike a settings PR
  ([REPO-16](#repo-16--a-settings-change-is-a-pull-request)): at an autonomy that merges on its own Towercab merges
  it after CI and review (at autonomy 4 or 5 with a low-risk review, [AUT-14](autonomy.md)); otherwise it
  waits for the owner's approval. `CLAUDE.md` is protected
  ([REPO-8](#repo-8--protected-paths)), so this grant is made for this PR only.
- The review of this PR gets two extra duties besides the usual passes ([PIP-4](pipeline.md)): it re-runs
  the drafted `setup` and `checks` on the base branch and reports a **blocking** finding if they
  don't pass, and it reports a blocking finding for any drafted command that deploys, publishes,
  writes over the network or uses a secret: the checks may only verify. Such a finding keeps the PR from
  merging itself at any autonomy.
- One setup PR per repo is open at a time. Every intent of that repo that reaches the pick while it is open
  waits on it, not only the first: none can be verified without checks. Each waits with the reason
  `setting up checks: #<n>` (shown with the PR). When the PR merges and the base branch has a checks
  block, all of them continue at the next pass with no reply. A PR closed without merging → REPO-37's ask
  for each, with the PR named.
- Verified by: `repo: the setup PR changes only CLAUDE.md`, `repo: the setup PR follows the repo's autonomy`, `repo: the setup PR review re-runs the drafted checks`, `repo: the setup PR review blocks a command that is not a check`, `repo: one setup PR per repo`, `repo: every intent of the repo waits on the setup PR`, `repo: a merged setup PR resumes the waiting intents`, `repo: a closed setup PR asks the owner`

### REPO-37 · Asking only when nothing passes

The owner is asked to add a verifying section only when Towercab found no check that passes on the base branch.

- All drafts of REPO-35 failed, or nothing was found to draft from → `waiting: add CLAUDE.md verifying
  block`. The ask in [LOOP](loop.md)'s message table is fixed (`Towercab couldn't find checks that pass on
  this repo. Add a verifying section to its CLAUDE.md, then reply.`); the wait's reason says what was tried
  and the last failure (`Towercab tried <sources> and none passed on <base>: <last failure>.`). A reply
  starts one new try; a base that has a checks block by then needs nothing.
- A repo whose base branch fails its own CI checks does not count as "no check found": the failing draft is
  reported in that ask, not proposed.
- Verified by: `repo: no passing draft asks the owner`, `repo: the ask names what was tried`

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
- Drafted checks (REPO-34..37) take the conservative default wherever the intent is silent: inline
  commands in `CLAUDE.md` only, never a script or any second file; a drafted block has `checks` and,
  only if a source needs it, `setup`, but no `fast` or `screenshots`; a file type without an inline
  checker is left out and said so in the PR body, rather than guessed; a draft that cannot be shown to
  pass is never proposed (the owner is asked instead); and no setup PR is merged by Towercab if its
  review finds a command that is not a pure check.
