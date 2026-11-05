# Repo files

**Status:** Live: REPO-1..13, REPO-20..27 · **Prefix:** REPO

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
  `kind`, `readiness`, `waive` and `go_live` ([REPO-20](#repo-20--a-repos-kind), once built). Any
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

- Towercab runs `bin/apply-settings --check <owner/name>` through `Tools`, as the App, from the latest
  `v*` tag of the `ci` repo (newest by version), never from the clone's working tree: after a fetch of
  its tags it makes a worktree of that tag, runs the script there, removes the worktree and logs the tag
  (`settings check of <repo>: bin/apply-settings from ci <tag>`). Exit 0 is `settings` present, exit 1 is
  missing with the script's first output line as the words. Towercab keeps no copy of the list of settings.
- No `ci` clone, no `v*` tag, no such script in the tag, or a script that cannot run (not exit 0 or 1) → the item is `unknown`
  with `The standard settings could not be checked: add the ci repo to Towercab` (or the reason). It is
  shown as a warning and never blocks. `ci` is a registered repo, so the clone is normally there.
- Verified by: `repo: settings check runs ci's script`, `repo: settings check without a ci clone is unknown`, `readiness: settings run from the latest v* tag of ci`, `readiness: settings without a ci release are unknown`

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
  of `<home>/repos/ci` whose commit is an ancestor of `origin/<base>` (`git merge-base --is-ancestor`).
  Towercab exports that tag's tree to a scratch directory (`git archive`) and runs
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
