# Pipeline

**Status:** Live: PIP-1..54, PIP-70..83, PIP-85..100, PIP-106..121, PIP-130..172, PIP-182..186, PIP-192..194, PIP-196..207, PIP-210, PIP-223..226 · **Prefix:** PIP

## Purpose

What happens to an intent from "picked" to "merged". One worker session designs the spec change,
plans the work and builds it; code runs the checks, proves the tests, watches CI, gets a review and
decides the merge. The owner sees and steers it through three pull requests (spec, plan, code) using
ordinary GitHub actions, and everything Towercab writes for a person reads like a colleague wrote it.

## Requirements

### PIP-1 · Build

The worker builds the plan in the mission's checkout: failing tests first, then the code, then the
docs, until the repo's checks pass.

- Resumes the worker session ([PIP-13](pipeline.md)) on the intent's model, after the repo's
  ` ```setup ` ran in the checkout. The prompt (`agents/worker.md`) gives `plan.md`, `intent.md` (with
  `## Answers`), the spec IDs, the run set ([REPO-9](repo.md)), the access granted
  ([AUT-14](autonomy.md)) and the writing guide (PIP-39). The worker writes a failing test for each
  spec row's `Verified by` and each `Proposed outcome` bullet, implements, runs the checks itself,
  updates docs, and switches the spec rows it built from Draft to Live.
- Result (`--json-schema`, **Schemas** `build`): `status` `done`, `blocked` (with a `question`,
  PIP-41) or `access` (with what and why, [AUT-15](autonomy.md)); `pr` (the code PR's text, PIP-48);
  `plan_changed` (markdown, when it departed from the plan, with why); `lower_a`, `lower_why`.
- Towercab then commits everything as the bot (`git add -A`, message = the design's Conventional
  Commit line) and goes to verify. No diff → `waiting: no changes`. A repair round (not a conflict)
  that adds nothing to the branch and carries no words from the owner also → `waiting: no changes`,
  why `The repair round changed nothing.` plus the worker's notes, so the same red check never runs
  again unchanged; with the owner's words it goes on, and after a CI repair that head's red is rerun
  once more (PIP-18). Timeout, budget used up, or no
  valid result → one continue with `Continue where you stopped.` and the step's full time budget
  again, then the matching wait.
- Verified by: `pipeline: build prompt has plan, intent and checks`, `pipeline: build commits as the bot`, `pipeline: no changes waits`, `pipeline: a repair that changes nothing waits`, `pipeline: after an answer an unchanged head gets CI again`, `pipeline: timeout continues once`

### PIP-2 · Publish

After green checks and a proof, Towercab pushes the branch and opens the code PR; later rounds only
push.

- Push `towercab/<id>-<slug>` from Towercab's clone (fetched from the checkout by path). First time:
  `gh pr create` (ready for review, not a draft), title = the design's Conventional Commit line, body
  = PIP-48; `missions.pr`, `head`, `pushed_at` recorded first. A push refused other than as
  non-fast-forward, or rejected 3 times → `waiting: answer the question` with the reason (a
  non-fast-forward refusal: PIP-85; a branch left over from before the first push: PIP-86).
- Never a force-push: commits someone else pushed to the PR branch (the owner) are merged into the
  checkout first, at the start of each later build round and before each push; a conflict there is a
  conflict round. Such a PR is marked as having someone else's commits (PIP-7).
- Verified by: `pipeline: first publish opens the code PR`, `pipeline: later rounds only push`, `pipeline: the owner's commits on the PR are kept`

### PIP-3 · CI

Towercab waits for the PR's checks and sorts them into pass, fail and pending in code.

- `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup` every `ci_poll` s. A check run
  `COMPLETED` with `SUCCESS`, `NEUTRAL` or `SKIPPED` passes; `FAILURE`, `TIMED_OUT`,
  `ACTION_REQUIRED`, `STARTUP_FAILURE`, or a status `FAILURE`/`ERROR` fails; `CANCELLED` cancels;
  else pending. Within `ci_grace` s of a push, checks started before it are ignored. No checks after
  `ci_grace` → green with `no CI on this repo`. Pending past `ci_wait` → `waiting: CI stuck`.
- Red → a repair round in `build` with the failing jobs' log tails (at most 2, `ci_repairs`), then
  `waiting: CI red`.
- Verified by: `pipeline: CI buckets`, `pipeline: no checks counts as green`, `pipeline: CI red repairs twice then waits`

### PIP-4 · Review

A separate, read-only Claude session reviews every code PR against the intent, the plan and the
repo's `REVIEW.md`, and posts what it found on the PR.

- After green CI, again on each new head (reused when the diff's `git patch-id` is unchanged). Model:
  the intent's `review`, else `[agent].review_model`, else one step above the worker (haiku → sonnet →
  opus; opus stays). Given intent, spec IDs, `plan.md`, the PR diff, the CI result, `REVIEW.md` and
  the screenshots (PIP-49). Its verdict is posted as a Review comment (PIP-42). One that doesn't
  approve goes back to build first (PIP-98); then the risk agent assesses the diff (PIP-96).
- Verified by: `pipeline: review on every PR`, `pipeline: review reused for an unchanged diff`, `pipeline: review comment is posted`

### PIP-5 · Review verdict

The review returns a structured verdict, and code decides from it whether the PR is approved.

- **Schemas** `review`: `approved`, one verdict per `Proposed outcome` bullet (`met`, `why`),
  `tests_weakened` (`value`, `where`), `plan_followed` (`value`, `where`), `findings` (`severity`
  `important`/`nit`, `file`, `line`, `what`), `door` (`one-way`/`two-way`), `red_lines` (touched,
  with file), `summary` (markdown, for the owner). Approved = `approved` ∧ every outcome met ∧ no
  weakened tests ∧ plan followed ∧ no important finding. Nits are capped by `REVIEW.md`. An outcome
  only the owner can do counts as met (PIP-119).
- Verified by: `pipeline: approval is computed in code`

### PIP-6 · Review rounds

Removed: in v1 already.

### PIP-7 · Gate

After the review, code decides whether Towercab merges the code PR or the owner does.

- Effective `a` and caps from [AUT-8, 13](autonomy.md). First match wins → `approval:merge`
  (`waiting: review and merge PR`, why, worded plainly per PIP-110): CI not green; review not
  approved (or didn't finish); access beyond the plan at a4 (AUT-15); proof missing (PIP-30);
  effective `a` ≤ 3; a risk that waits at this `a` ([AUT-18](autonomy.md), the code's risk of the
  reviewed diff, none → AUT-19); someone else's commits on the PR (PIP-2); the build departed from
  the approved plan, below a5 (PIP-28); in a repo with a `live` block, no e2e test for the change
  ([SHIP-8](ship.md)). Else → `merge`. The PR
  body's Checks and Risk sections are updated first (PIP-48, PIP-99). Before any of it, while another change in the repo
  ships, the gate holds ([SHIP-14](ship.md)).
- Verified by: `pipeline: gate table`

### PIP-8 · Deploy

Removed: the ship stage is parked (intent 261026-2204-4).

### PIP-9 · e2e

Removed: with PIP-8.

### PIP-10 · e2e watch

Removed: in v1 already.

### PIP-11 · PR description by Haiku

Removed: replaced by PIP-39, 40 and 48.

### PIP-12 · Towercab's own CI

Towercab's repo runs its checks on every PR and push to `main`.

- `.github/workflows/ci.yml`: job `Node 22: lint, typecheck, tests` (`actions/setup-node` with
  `node-version: 22`, `cache: npm`): `npm ci`, `npm run check`. Job `Playwright: UI screenshots`:
  `npx playwright install --with-deps chromium`, `npm run test:ui`, screenshots uploaded as an
  artifact. Every job sets `name:`.
- Verified by: `public: CI workflow runs the checks`

### PIP-13 · One worker session per mission

Design, plan, build and every repair continue the same Claude session, so the worker keeps its
context.

- The uuid is picked at pick ([LOOP-5, 7](loop.md)); design's run gets `--session-id`, every later
  worker run `--resume` from the same checkout. A repair's prompt is short: what failed, the findings
  or the log tail, fenced as data. Review is always a fresh session.
- Verified by: `pipeline: one session from design to repairs`

### PIP-14 · PR body lifecycle

Removed: replaced by PIP-48.

### PIP-15 · Writer fallback

Removed: there is no separate writer; PIP-48 says what happens without a worker text.

### PIP-16 · Message texts are code

Telegram messages come from code templates, never a model.

- One template per wait ([LOOP-14](loop.md) **Waits**); tests pin each text.
- Verified by: `outbox: every wait has a text`

### PIP-17 · Continue by waiting

Removed: replaced by owner gestures (PIP-43).

### PIP-18 · CI guards

A stale check never counts, and a first red or cancelled Actions run is rerun once before it counts.

- Checks count only for `headRefOid` = `missions.head` from the same call. The first red or cancel on
  a head → `gh run rerun <run> --failed` once (run ID from the check's `detailsUrl`), no repair
  counted; a second cancel = red; a check that isn't an Actions run is never rerun.
- Verified by: `pipeline: stale green is ignored`, `pipeline: red is rerun once`

### PIP-19 · Revert mission

Removed: parked with the ship stage.

### PIP-20 · e2e triage

Removed: parked with the ship stage.

### PIP-21 · Reading the intent's PRs

Every minute Towercab reads the intent's open PRs: their state, the owner's reviews and comments,
and conflicts.

- For each of `spec_pr`, `plan_pr`, `pr` that is open, and the current PR (the newest of the three)
  even when merged: `gh pr view <n> --json state,mergedAt,mergeCommit,headRefOid,mergeable,
  reviews,comments,body` plus `gh api --paginate repos/<r>/pulls/<n>/comments?per_page=100`
  (pages read as a stream of JSON arrays). The events it gives: PIP-43.
- Verified by: `github: PR read parses gh 2.46 output`

### PIP-22 · Merge

Towercab merges in code, only on the head that passed the gate.

- `gh pr view --json headRefOid,mergeStateStatus`: head ≠ gated head → `ci`. `CLEAN`/`HAS_HOOKS` →
  `gh pr merge <n> --squash` with `--match-head-commit <head>`. `BEHIND` → `gh api -X PUT
  repos/<r>/pulls/<n>/update-branch -f expected_head_sha=<head>` → `ci`. `DIRTY` → a conflict round
  in `build`. `BLOCKED`/`UNSTABLE` → read again after `ci_poll` (the third time → `approval:merge`).
  Refused otherwise → `waiting: merge failed`. While paused, a mission entering `merge` holds until
  `resume`.
- Verified by: `pipeline: merge on the gated head`, `pipeline: behind updates the branch`, `pipeline: dirty is a conflict round`

### PIP-23 · Verify

After each build or repair, code runs the repo's setup and checks in a sandbox and sends failures
back to the worker.

- ` ```setup ` (base branch's) runs first, with network and the repo cache writable; non-zero → once
  more after 60 s, then red. The run set ([REPO-9](repo.md)) runs in order, each bounded by
  `check_timeout`. Setup and the run set both reach only the built-in registry list, through the allowlist
  proxy (PIP-158). Logs: `runs/<id>/verify-<n>.log` (`$ <command>` before each output); under LOOP-39 they move to `runs/<id>/verify/check-<n>.log`.
- Red → a repair round in `build` with the log tail (at most 2 for verify and proof together,
  `repairs`), then `waiting: checks red`. A log that shows a missing tool or a sandbox failure is a
  fault ([LOOP-10](loop.md)), not a repair.
  What the owner reads names what failed: the reason is `The checks failed: <lines>`, with up to three
  lines of the log that name a failing test or an error (`×`, `FAIL`, `not ok`, `error…`, an assertion or
  a panic), else the log's last line, each cut to 100 characters, and `(and N more)` beyond three; never
  only "The checks failed." The worker's repair prompt keeps the full log tail.
  A log that shows the checks could not write to the repo cache is a question for the owner
  (PIP-95), not a repair.
- **Sandbox**: `bwrap --unshare-net --unshare-pid --unshare-ipc --unshare-uts --new-session
  --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /run [the proxy's node, bridge and socket,
  PIP-158] --tmpfs <HOME> --tmpfs /tmp`, the toolchain dirs read-only with credential files masked, the repo
  cache (LOOP-34), `--bind <checkout>` with its `.git` read-only, `--chdir <checkout>`, `sh -c <line>`. Every
  part is fixed in code (PIP-157).
- Verified by: `pipeline: verify runs setup then checks`, `pipeline: verify red repairs then waits`, `pipeline: sandbox argv`, `verify: a red check names what failed`

### PIP-24 · Claude runs

Every Claude run is headless, sandboxed, and gets only the tools and access its job needs.

- `claude -p --output-format json --permission-mode dontAsk --strict-mcp-config --setting-sources ""
  --append-system-prompt-file <runs>/system-<kind>.md --settings <runs>/settings-<kind>.json (both
  move into the stage folder under LOOP-39) --model
  <m> --tools <list> [--allowedTools …] [--disallowedTools …] [--session-id|--resume <uuid>]
  [--max-budget-usd <n>] [--json-schema <schema>]`, the prompt on stdin. The system file = the base
  branch's `CLAUDE.md` + the writing guide (PIP-39). Env: HOME, PATH (a constant, PIP-157), LANG, the repo
  cache's variables (LOOP-34) and the repo's own variables that pass PIP-159; never a GitHub token.
- Settings: `sandbox {enabled, failIfUnavailable, allowUnsandboxedCommands: false, filesystem
  {denyRead: secret paths, denyWrite: <checkout>/.git + blocked protected paths, allowWrite: the repo
  cache}, network {allowedDomains: the granted domains}}`, `permissions.allow: WebFetch(domain:<d>)`
  per granted domain (never `*`, AUT-26), the guard hook for workers (PIP-29). Secret paths:
  `~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.gnupg`, `~/.config/towercab`, `~/.claude/.credentials.json`,
  `~/.netrc`, `~/.git-credentials`, `~/.config/sops`, `~/.config/restic`, `~/.config/age`,
  `~/.password-store`, `~/.docker`, `~/.kube`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials*`,
  `~/.config/rclone`; and Towercab's home outside this mission (other checkouts, run files and caches,
  the clones, the intents checkout, the database and log).
- Tools by agent: **Agents** table. Disallowed for every run: `Bash(git push:*)`,
  `Bash(git remote:*)`, `Bash(git config:*)`, `Bash(gh:*)`, `Bash(ssh:*)`, `Bash(sudo:*)`, `Read` of
  each secret path. A denied push or secret read fails the step.
- Verified by: `claude: worker argv`, `claude: review argv`, `claude: settings by autonomy`, `claude: result parse`, `claude: no token in env`, `claude: other missions are unreadable`

### PIP-25 · Design

The worker's first run turns the intent into spec changes, and Towercab opens them as the spec PR.

- Given `intent.md`, the repo's `specs/`, `CLAUDE.md` and the writing guide; tools Read, Glob, Grep,
  Edit, Write, allowed to edit `specs/**` only. Result (**Schemas** `design`): `type`, `scope`,
  `breaking`, `spec_ids`, `concerns` (`what`, `why`), `open_questions` (each answered or left to the
  owner), `pr` (the spec PR's text: what changes in behaviour and why, for a reader who wasn't
  there).
- Spec rows added here are `Draft`: kept out of the file's Status line (a bare `Live` becomes
  `Live: <prefix>-<first>..<last built>`), so the repo's spec check stays green. Towercab commits `docs(specs): <title>` on
  `towercab/<id>-<slug>-spec`, pushes, and opens the spec PR (title `docs(specs): <title>`). Once its
  checks pass, the risk agent and second reviewer read it (PIP-96, PIP-97), then the spec gate
  ([AUT-11](autonomy.md)): the owner (`approval:spec`) or Towercab (PIP-50). No behaviour
  change (`spec_ids` empty, no diff) → no spec PR; on to plan.
- The owner's review comments on the spec PR → a design revision in the same session, a new commit
  on the same PR. Red checks on the spec PR start one too (PIP-82), and every revision sees their
  logs (PIP-83).
- PIP-172 widens "`specs/**` only" by one table: the README's docs index, when the design adds a spec file.
- Verified by: `pipeline: design edits only specs`, `pipeline: spec PR is opened`, `pipeline: no behaviour change skips the spec PR`, `pipeline: feedback revises the spec`

### PIP-26 · Spec approval

Removed: now AUT-11 with PIP-25 and PIP-50.

### PIP-27 · Policy skills

Removed: never configured; parked as intent 261026-2204-5.

### PIP-28 · Plan

The worker plans the build, read-only, and Towercab opens the plan as a PR on the intents repo.

- Resumes the session; tools Read, Glob, Grep and read-only git. Result (**Schemas** `plan`): `plan`
  (markdown, PIP-46) and `access` (`domains` and `paths`, each with `why`).
- A placeholder is refused: a `plan` with fewer than 80 characters of text or no listed step, or a `brief`
  under 20 characters, is a bad result and the planner is asked again (PIP-13); no plan PR is opened for
  it. (A plan whose whole text was `x` was once published and merged.)
- Towercab writes `intents/<id>-<slug>/plan.md` (PIP-46) on branch `plan/<id>-<slug>` of the intents
  repo, pushes, and opens the plan PR (title `docs(plan): <title>`, body: the approach in a few
  sentences and the access asked for). Then the risk agent reads it (PIP-96), and the plan gate
  ([AUT-12](autonomy.md)): the owner (`approval:plan`) or Towercab (PIP-51).
- The owner's comments on the plan PR → a plan revision, a new commit on the same PR. Merged → the
  grants are read from the merged `plan.md` (PIP-47) and the build starts.
- A build that departs from the plan returns `plan_changed`; Towercab commits it to `plan.md` on
  `main` of the intents repo (`towercab: plan changed <id>`), keeping the merged Access section, and the
  gate sends the PR to the owner below a5. A revised plan PR keeps the boxes the owner unticked.
- Verified by: `pipeline: plan PR is opened on intents`, `pipeline: feedback revises the plan`, `pipeline: merged plan grants its ticked access`, `plan: a placeholder plan is refused and asked again`

### PIP-29 · Guard

A hook stops the worker from writing paths it hasn't been granted, and tells it how to ask.

- Every worker run's settings add a `PreToolUse` hook on `Edit|Write|NotebookEdit` running
  `towercab hook guard <runs>/guard.json` (`{version, checkout, protected, granted, locked, existing}`;
  a file of another `version` is refused as skew, [LOOP-106](loop.md)), which exits 2
  with a reason for: a path outside the checkout, a protected path not granted
  ([REPO-8](repo.md), [AUT-14](autonomy.md)), a locked test (PIP-31). The reason for a protected path
  ends `if you need it, finish what you can and return status access with this path and why`. It
  fails closed (unreadable rules, no path, an error → exit 2).
- Publish also refuses a diff that touches a protected path that isn't granted.
- Verified by: `guard: blocks a protected path`, `guard: allows a granted path`, `guard: blocks outside the checkout`, `guard: fails closed`

### PIP-30 · Red→green proof

Towercab checks that the PR's tests fail without the change, so the tests prove something.

- After green verify, when the design changed spec rows or its `type` is `fix`: a checkout of
  `origin/<base>` with the PR's changed test files laid over it (globs: `TOWERCAB.md` `tests`, default
  `tests/**`, `test/**`, `**/__tests__/**`, `**/*_test.*`, `**/test_*.*`, `**/*.test.*`,
  `**/*.spec.*`; e2e tests under a `live` block's suites are left out, [SHIP-8](ship.md)) runs setup, then the run set (from the PR's `CLAUDE.md` when PIP-54 applies). Red = proven. Green → a repair round asking for a test
  that fails without the change, naming the commands the proof ran on base and saying that a change
  to how tests run isn't used there, so a worker that can't wire its test into them asks the owner; after the repairs → `waiting: tests don't prove the change`. After
  the owner answers, a proof that still fails to prove → publish with `data.unproven` (the gate then
  sends the PR to the owner, PIP-7).
- Verified by: `pipeline: proof red on base proves`, `pipeline: green on base repairs`, `pipeline: unproven goes to the owner`

### PIP-31 · Test lock in repair rounds

During repair rounds the worker can't change tests it already pushed, so it can't make a red check
green by weakening the test.

- Locked = test files (PIP-30's globs) at the head of the last non-repair round; the guard blocks
  them and publish refuses a diff that changes or deletes them. New test files are fine. A locked
  test that reads at the new head exactly as on the base branch came in with a merge of the base (a
  conflict round), so publish lets it through.
- Which tests stay locked is narrowed by PIP-151 (tests the PR added or its plan allowed are not locked),
  PIP-152 (an owner's allow unlocks a path) and PIP-153 (a forced edit that comes with a merge of the base).
- Verified by: `pipeline: repair can't edit pushed tests`, `pipeline: a merge of the base may change pushed tests`

### PIP-32 · Verifier

Removed: never used; parked as intent 261026-2204-5. Screenshots (PIP-49) replace its UI check.

### PIP-33 · Evals

Removed: parked as intent 261026-2204-5.

### PIP-34 · Release gate

Removed: parked with the ship stage (intent 261026-2204-4).

### PIP-35 · Rollback rehearsal

Removed: parked with the ship stage.

### PIP-36 · Findings feed CLAUDE.md

Removed: parked as intent 261026-2204-3.

### PIP-37 · Answers in the continue prompt

Removed: in v1 already.

### PIP-38 · Environment failures in a run

Removed: in v1 already; now LOOP-10.

### PIP-39 · Writing guide

Every Claude run gets one writing guide, so everything Towercab writes for a person reads clearly.

- `prompts/writing.md`, appended to every run's system file (PIP-24). It covers: who the reader is
  (the owner, who wasn't there; a reviewer); the answer or outcome first; full sentences; plain words
  before identifiers; one idea per paragraph; headings and lists only where they help; no internal
  jargon (step names, field names, schema keys) in text for a person; questions with context, options
  and a recommendation.
- Verified by: `prompts: writing guide is in every run`

### PIP-40 · Text a person reads is free Markdown

Claude writes the text a person reads as Markdown in its own words; JSON carries only what code
needs.

- Text for people: the spec, plan and code PR texts, questions, the review summary. These are
  Markdown strings in the result, written by the run that did the work, on its own model. Code adds
  only facts it owns (links, check results, the footer) and never stitches sentences from fields.
- Verified by: `pipeline: PR text comes from the worker`

### PIP-41 · Questions

When the worker needs the owner, it asks one question with its context, the options and its
recommendation.

- `question`: `context` (what it was doing and why it is stuck), `question`, `options` (each with
  what follows from it), `recommendation`. Towercab renders it as a Question comment (PIP-42) on the
  intent's current PR, or, with no PR yet, in the intent's `## Towercab` section; `waiting: answer the
  question`.
- Verified by: `pipeline: question comment has context, options, recommendation`, `pipeline: question without a PR goes to the intent`

### PIP-42 · Stage comments

Every comment Towercab posts on a PR says which step wrote it, and only informs.

- Visible header `**<Step>** · round <n>` (Design, Plan, Build, Verify, Proof, CI, Review, Gate,
  Question, Access) and a hidden marker `<!-- towercab:<step>:<n> -->` on the first line. A comment
  for the same step and round is edited, not added again. Towercab's own comments never cause an
  event.
- Verified by: `github: stage comment has header and marker`, `github: same step edits its comment`

### PIP-43 · The owner's GitHub actions

What the owner does on a PR moves the intent: merge approves, close drops, a review or comment
steers.

- Merged spec, plan or code PR → `spec_merged`, `plan_merged`, `code_merged`. Closed without merge →
  `closed` (the mission stops and the intent is dropped, [PRI-9](priority.md)). A review with
  Approve on a PR waiting on the owner → Towercab merges it (as the owner's approval). A review with
  Request changes, or a comment, → `feedback` with its text (or `answered` while blocked). A comment
  that is exactly `/retry` → `retry_fresh`. Edited checkboxes in an open plan PR are read when it
  merges.
- Verified by: `events: merge, close, review and comment`, `events: approve review merges`, `events: retry command`

### PIP-44 · Only the owner acts

Only the owner's reviews and comments move an intent; anyone else's are ignored.

- Author login = `[github].me` (case-insensitive), with a non-empty body or a review state. Comments
  by the App's bot or anyone else never raise an event. Comments older than `feedback_seen` are
  skipped; `feedback_seen` moves forward when an event is taken.
- With `[auth]` set ([users.md](users.md)), [USR-9](users.md) decides who counts instead of the owner's login alone.
- Verified by: `events: only the owner's comments count`

### PIP-45 · Slash commands

Two short commands cover what a GitHub action can't express.

- `/retry` (alone in a comment by the owner on any of the intent's PRs): a fresh attempt.
  `/release` (alone in a comment by the owner on any of the intent's PRs): Towercab answers once per
  comment with a reply that says what the ship stage does with this PR. It starts nothing; releases
  are made by release-please ([SHIP-30](ship.md)).
- The reply has one line per repo of the intent, the lead first, each starting with the repo's name
  (`owner/name`). A single-repo intent gets one line. The line depends on that repo's `live` block
  ([SHIP-1](ship.md)) and the mission's stage:
  - no `live` block: there is no live check, so merging the code PR is the last step;
  - a `live` block, before the merge: after the merge Towercab waits for the deploy and runs the
    e2e suites ([SHIP-20](ship.md));
  - a `live` block, after the merge: what it is waiting for now (the owner's steps, the deploy, the
    e2e suites, a rollback or a revert), in one sentence each;
  - a `live` block, finished (`done`): it is live and passed its tests.
  The text never says the ship stage is parked or switched off.
- Verified by: `events: retry command`, `events: release without a live block says merging is the last step`, `events: release with a live block says what the ship stage does`, `events: release of a multi-repo intent has a line per repo`, `events: release after the merge says what it waits for`

### PIP-46 · plan.md

The plan explains the approach before the steps, so the owner can judge it in a minute.

- `plan.md`: `# Plan: <title>`, a line with the intent and spec IDs, then the worker's markdown:
  `## Approach` (what will be built and why this way), `## Files that change` (PIP-91), `## Steps`
  (in order; failing tests first),
  `## Risks`, `## How to check it`; then Towercab's `## Access` (PIP-47).
- Verified by: `pipeline: plan.md sections`

### PIP-47 · Access checklist

The plan lists the access the worker expects to need as checkboxes, and the merged boxes are what
it gets.

- `## Access` lines: `- [x] network: <domain> (<why>)` and `- [x] path: <glob> (<why>)`, ticked by
  default; plus a sentence on what each level grants ([AUT-14](autonomy.md)). Parsed from the merged
  `plan.md`: ticked lines are granted, unticked ones are not; no section → nothing beyond the
  defaults.
- Verified by: `pipeline: access checklist round-trips`, `pipeline: unticked access is not granted`

### PIP-48 · The code PR's text

The code PR opens with what it does, why, and what to check before merging, in plain words; the
technical detail follows.

- Body: `## In plain words` and the risk first (PIP-108); then the worker's `pr` markdown (sections
  `## What this does`, `## Why`, `## What to check before merging`, `## Changes`); then Towercab's `## Checks` (one line each: verify, proof, CI, review, in
  plain words), `## Access beyond the plan` (when any), links to the spec PR and the plan PR, the spec
  IDs, the review's details in a `<details>` block, and the footer `<sub>Built by Towercab · intent ·
  $<cost> · <h>h<mm>m</sub>`. Updated at the gate. Without a worker text: the intent's title and
  problem under `## What this does`.
- Verified by: `pipeline: code PR body sections`, `pipeline: body without worker text`

### PIP-49 · Screenshots in the review

For a repo with a screenshots command, the review sees the UI as it now looks.

- After green verify, the ` ```screenshots ` command ([REPO-10](repo.md)) runs in the sandbox with
  network to localhost only; its PNGs are copied to `runs/<id>/shots-<n>/` and their paths go into the
  review prompt (the review reads them with `Read`). A failing command is logged and noted in the
  review prompt; it never blocks.
- Verified by: `pipeline: screenshots reach the review`

### PIP-50 · Towercab merges the spec PR

When the owner doesn't need to approve the spec, Towercab merges the spec PR once its checks pass.

- Spec gate open ([AUT-11](autonomy.md)) → wait for the spec PR's CI on the head Towercab pushed
  (PIP-3 rules, no repairs: a red that survives the rerun and one revision (PIP-82), a conflict or
  someone else's push → `waiting: approve spec` with the reason), then
  `gh pr merge --squash --match-head-commit <head>`. The same checks come first when the gate is
  closed (PIP-82).
- Verified by: `pipeline: spec PR merged when the gate is open`

### PIP-51 · Towercab merges the plan PR at a4 and a5

At a4 and a5, when the plan's risk lets it go ahead, Towercab merges its own plan PR and starts
building.

- Plan gate open ([AUT-12](autonomy.md), [AUT-18](autonomy.md)) → `gh pr merge --squash` on the
  intents repo as the App, why `a<n>, <level> risk: Towercab approved its own plan`.
- Verified by: `pipeline: plan PR merged at a5`, `autonomy: every stage runs at every level`

### PIP-52 · A change's three PRs link to each other

Each PR links to the intent and to the intent's other PRs, so the owner can follow a change from
any of them.

- Spec and plan PR bodies end with links to the intent file and the PRs before them; the code PR
  links both (PIP-48). The intent records each URL ([INT-5](intents.md)).
- Verified by: `pipeline: PRs link to each other`

### PIP-53 · A fresh attempt closes the old one's PRs

When an intent starts over, the replaced attempt's open PRs are closed, so only the new attempt's
PRs wait for review.

- Entering `stopped` with a newer attempt (`retry_fresh`, `/retry`): its open spec, plan and code PRs
  are closed as the App (`gh pr close --comment`, saying the intent started over); merged or closed
  ones are left. Their branches are deleted too (PIP-87). A failure is retried next pass (LOOP-6).
- Verified by: `pipeline: a fresh attempt closes the old PRs`

### PIP-54 · Proof runs the PR's checks block when it changes it

When the owner let the PR change `CLAUDE.md`, the proof runs the checks that file now lists, so a test
added to the checks block can prove the change.

- Applies when the PR's diff against the base changes `CLAUDE.md` and that path is granted
  ([REPO-8](repo.md), [AUT-14](autonomy.md)). Publish already refuses an ungranted change, so the
  base's block is used otherwise.
- Then the proof's run set (REPO-9, `runSet`) is built from the `## Verifying your work` section of
  `CLAUDE.md` at the PR's head, not the base's. `setup` still comes from the base and runs on the bare
  base before the tests are laid (PIP-30). Only `CLAUDE.md` is read from the head; `REVIEW.md` and
  `TOWERCAB.md` stay the base's.
- The PR's `CLAUDE.md` is not laid into the proof checkout; only its parsed blocks are used. If it
  doesn't parse or has no non-empty `checks` block, the base's block is used and the proof's log says so.
- Verify (PIP-23) and CI keep the base's block.
- When the PR's block is used, red on base is not enough: the same lines then run on the PR's head, in
  the mission's checkout without network, and must pass (log `proof-head.log`). Red there → a repair
  round (counted with verify's, at most 2), then `waiting: checks red`; never the unproven path, so an
  always-failing line can't count as proven.
- Verified by: `pipeline: proof uses the PR's checks block when CLAUDE.md is granted`, `pipeline: proof keeps the base's checks block when CLAUDE.md is not granted`, `pipeline: proof falls back to the base's checks block when the PR's does not parse`, `pipeline: proof needs the PR's checks block green on head`

### PIP-70 · One file per agent

Each kind of Claude run Towercab starts is configured by one file, `agents/<name>.md`, and nowhere else.

- Agents: `design`, `plan`, `worker`, `repair`, `review`, `score`. The file name is the agent's name.
- The front matter holds what the run is allowed and limited to (PIP-71); the body is the prompt
  template (`{{key}}`, PIP-39 fences as today). `prompts/<stage>.md` is replaced by these bodies;
  `prompts/writing.md` stays, since it is not an agent.
- `src/claude.ts`, `src/pipeline/prompts.ts`, `src/pipeline/schemas.ts` and the stage handlers read the
  agent file; the `KINDS` table, the per-kind timeout constants and the per-kind model choice in code are
  removed. The result schemas stay in `schemas.ts`, found by the name the file gives.
- Agent files ship with Towercab and are read from its checkout. A target repo cannot override one; it
  still adds `CLAUDE.md` and `REVIEW.md` as today (REPO-1, REPO-2).
- Verified by: `agents: every agent has a file`, `agents: claude.ts has no per-kind table`

### PIP-71 · Agent front matter

An agent file's front matter says which tools the agent has, what it may do without asking, and how long and how much it may run.

- Keys, all required: `tools` (list; empty list means `--tools ""`), `allow` (list of permission rules,
  each `Tool` or `Tool(pattern)`), `sandbox` (`strict` or `none`; see PIP-78), `model`
  (`mission`, `review` or `agent`: which configured model it takes, as the Model column of the old
  **Claude runs** table did), `session` (`new`, `resume` or `none`), `timeout_min` (integer), `max_cost_usd`
  (number or `null`; `[agent]` config can only lower it) and `schema` (a name in `schemas.ts`, or
  `null` for none).
- Unknown keys, a missing key or a wrong type fail the load with an error naming the file and the key.
- The values equal today's behaviour except where PIP-77 names a narrowing. `[agent]` settings (model,
  limits) still apply on top, as the lower of the two for limits.
- Verified by: `agents: front matter parses`, `agents: unknown or missing key is refused`, `agents: config can lower a limit but not raise it`

### PIP-72 · Runs are built from the agent file

The command line of a Claude run comes from the agent's file, so the file is the whole truth about what that run may do.

- `claudeArgv` takes `--tools`, the allowed rules, the session mode, the budget and the schema from the
  agent; the timeout of the run is its `timeout_min`. The disallowed list (PIP-24) is added to every
  agent and is not in the file.
- Handlers start a run by agent name; none passes tools, permissions or a timeout of its own.
- Verified by: `claude: worker argv`, `claude: review argv`, `claude: argv comes from the agent file`

### PIP-73 · Every agent file is checked

A test reads every file in `agents/` and fails when one is wrong, so the files and the code cannot drift apart.

- For each file: the front matter parses (PIP-71); every `tools` entry is a Claude Code tool name and
  every `allow` rule parses and names a tool the agent has; the `schema` exists in `schemas.ts`; the
  prompt renders with the variables its handler provides, and a `{{key}}` outside that set fails.
- Every name in the agent list (PIP-70) has a file, and every file is in the list.
- No `allow` rule matches a command the disallowed list (PIP-24) forbids.
- Verified by: `agents: tools and permissions parse`, `agents: schema exists`, `agents: prompt fills without an unknown placeholder`, `agents: allow does not overlap disallowed`

### PIP-74 · Repair and score have their own agents

The repair run and the issue scorer each get their own file, so their role is written down instead of borrowed from the worker.

- `agents/repair.md`: the prompt of a repair round (red checks, a merge conflict, a review fix), the
  worker's result schema and `session: resume`, so it continues the mission's session (PIP-13). Its
  tools are the worker's (no gain, PIP-77).
- `agents/score.md`: the issue scorer (INT-22), no tools, `session: none`, `timeout_min: 5`.
- The PR text is part of the build result, written by the worker. It stays in `worker.md` as its own
  section of the prompt rather than a separate run; PIP-75 records this.
- `agents/worker.md` and `agents/repair.md` carry the same "Parallel work" rules (LOOP-160): no merge or
  rebase of the base only because it moved (only for a conflict, a failing check or real base risk, then
  rerun the affected checks); checks from an older head are no evidence for the new one; never stash,
  reset or delete work the agent didn't create, nor touch another mission's branch or worktree;
  conflicts are resolved only by the merge queue's head.
- Verified by: `agents: repair continues the worker session`, `agents: score has no tools`, `agents: worker and repair carry the parallel work rules`

### PIP-75 · The audit

The pull request that builds this carries a written audit of every Claude run Towercab starts, so the owner can see what changed and what is still open.

- For each agent: its prompt, tools, permissions, schema, model, session, time and cost limit as they were
  before and after.
- Gaps found are listed: a run without its own prompt, a permission broader than its stage needs, a
  schema field no code reads, a limit that lived only in code. Each is fixed in the same PR or named as
  left open, with the reason.
- Verified by: manual (the code PR's description lists the audit)

### PIP-76 · Agents table

The spec lists every agent in one table, with what it is for and what it may touch, linking to its file.

- Replaces the former **Claude runs** table. Columns: Agent (link to
  `agents/<name>.md`), Purpose, May touch (tools and the paths or commands allowed), Session, Model.
- One row per agent in PIP-70's list; a test fails when a file has no row or a row has no file.
- Verified by: `agents: spec table lists every agent`

### PIP-77 · No agent gains a permission

Moving the settings into files makes no agent more powerful than it is today.

- For every agent, the tools and `allow` rules are a subset of today's (the former **Claude runs** table).
  `repair` takes the worker's set or less. A narrowing is allowed and is named in the code PR.
- A test holds the table's values for each agent as a ceiling and fails when a file goes beyond it.
- Verified by: `agents: no agent has more than the previous table allowed`

### PIP-78 · Agent files do not loosen the guard or the sandbox

An agent file can only narrow what a run may do; the sandbox, the guard and the protected paths are checked separately and the file cannot switch them off.

- `sandbox` is `strict` for every agent that has `Bash`, `Edit` or `Write`; `none` is accepted only for an
  agent with no tools. The sandbox settings (PIP-24), the worker's guard (PIP-29) and the protected
  paths (REPO-8) are built in code from the mission, not from the file.
- Verified by: `agents: a tool-using agent cannot disable the sandbox`, `claude: settings by autonomy`

### PIP-79 · Reserved

Reserved for this intent (agent files); not used.

- Verified by: manual (nothing to check: no behaviour)

### PIP-80 · Designs do not take the same IDs

Each design is told which requirement IDs other unmerged spec PRs of the repo already add, and must not use them.

- Before a design or a design revision runs, Towercab lists the repo's open spec PRs
  (`towercab/*-spec` branches of other intents), reads each diff against `main` and collects the
  `### <ID> ·` headings they add. The prompt gets them as data: "IDs already taken by other open
  spec PRs: …". The design must pick IDs outside that list and outside `main`, and still only from the
  IDs the intent reserves.
- A PR that cannot be read is skipped and logged, not a failure. No other open spec PR → the list is
  empty and the prompt says so.
- Verified by: `pipeline: design is told the IDs other spec PRs add`, `pipeline: an unreadable spec PR does not stop the design`
- PIP-130 extends this: any open PR that adds requirement headings counts, the design is checked again before the spec PR is pushed, and a clash is moved by Towercab itself.

### PIP-81 · A spec PR that conflicts with main is revised

When the spec PR no longer merges into `main`, the design resolves the conflict in a revision, like a red check on the spec PR.

- While the spec waits for approval ([AUT-11](autonomy.md)), a spec PR GitHub reports as conflicting
  (typically a Status line another spec PR changed) sends the mission back to design in the same
  session. Towercab merges `main` into the branch, the design edits only `specs/**` to resolve the
  markers and keep both sides' rows, and Towercab commits and pushes on the same PR. The prompt names
  the conflicted files and the IDs other open spec PRs add (PIP-80).
- At most 2 conflict revisions per spec PR; after that the mission waits for the owner
  (`waiting: spec conflict`). A conflict outside `specs/**` is not edited: the same wait.
- Verified by: `pipeline: a conflicting spec PR is revised`, `pipeline: a spec conflict that stays waits for the owner`
- PIP-133 makes the code do this before the owner is asked and adds when the owner is asked earlier.

### PIP-133 · A conflicting spec PR is revised twice, without asking

A spec PR that conflicts with `main` gets up to two automatic revisions that merge `main` in and keep every row, so the owner is not asked to merge the base by hand.

- Applies in `specCi`, before the owner is asked (`approval:spec`) and before Towercab merges (PIP-50),
  as PIP-82 does for a red check. A conflict sends the mission back to design in the same session
  (PIP-81's merge of `main` into the branch). The prompt says: keep every row from both sides; if
  `main` took an ID this PR adds, renumber this PR's row (and its references) to the next free
  reserved ID outside the IDs other open spec PRs add (PIP-80); edit only `specs/**`.
- At most 2 conflict revisions per spec PR (as PIP-81), counted apart from the red revisions of
  PIP-82. The owner is asked (`waiting: spec conflict`, the reason names the files) when the PR still
  conflicts after the second revision, when a conflict is outside `specs/**`, or when a revision
  altered a row that `main` changed (the revision is not pushed).
- Three-way compare, before the push: a row counts as "from main" only if `main` changed it since this
  PR's merge base (`git merge-base origin/<base> HEAD`). Rows this PR edited on purpose (its own diff
  against the merge base, such as an existing row it amends) are its own and may be kept in this PR's
  form. Rows neither side changed are ignored. A revision that alters, drops or reorders-with-edits a
  row `main` changed since the merge base goes to the owner; one that only keeps both sides, adds this
  PR's rows or renumbers this PR's own new IDs does not.
- No owner comment is posted in the owner's name. The revision is a new commit on the same PR (PIP-25).
- Verified by: `pipeline: a conflicting spec PR is revised without asking`, `pipeline: a spec conflict that stays after two revisions waits for the owner`, `pipeline: a revision that changes a row main changed waits for the owner`, `pipeline: a row the PR itself amended may be kept`

### PIP-134 · A code PR in conflict is resolved before the gate without asking

A code PR that conflicts with its base is merged with the base by Towercab's conflict round, and the owner is asked only when that round fails.

- Applies to the conflict round of PIP-31 and PIP-22 (`DIRTY`), also when the conflict is found before
  the gate (in `ci` or `review`): the mission goes to `build` with `repair.kind = "conflict"` and never
  to an owner wait first. The conflict round's first run is not counted as a fix round.
- Once missions are queued to merge, only the head of the repo's merge queue runs a conflict round; the
  others wait their turn without one (LOOP-160).
- Up to 2 automatic conflict rounds per code PR. The owner is asked (`waiting: merge failed`) only
  when the PR still conflicts after the second round.
- Verified by: `pipeline: a code PR in conflict is resolved without asking`, `pipeline: a code conflict that stays after two rounds asks the owner`

### PIP-82 · A red spec PR is revised once

When the checks on the spec PR stay red after the rerun, the design revises the spec once by itself, so the owner never has to review a red spec PR.

- Applies to every spec PR before it goes to the owner (`approval:spec`) or to Towercab's merge
  (PIP-50). Towercab reads the spec PR's checks as PIP-3 does, on the head it pushed, with the
  first-red rerun of PIP-18 first. A check that is still red after that rerun sends the mission back
  to design in the same session, as if the owner had commented. The revision is a new commit on the
  same PR (PIP-25), and its checks are read the same way.
- The prompt is the one PIP-83 describes; nothing in the owner's name is posted.
- At most 1 red revision per spec PR (counted separately from the conflict revisions of
  PIP-81). If the PR is still red after it, or the revision changes nothing, the mission waits for the
  owner (`waiting: approve spec`) and the reason says which checks are red. A red spec PR does not
  count as ready to merge: Towercab does not merge it (PIP-50) and the owner is not asked to approve it
  before the revision has run.
- A cancelled check is rerun once like a red one; if it stays cancelled the owner is asked
  (`waiting: approve spec`, the reason names it) without a revision. Checks pending past `ci_wait`
  also → `waiting: approve spec` with that reason. No checks on the repo → nothing to revise.
- Verified by: `pipeline: a red spec PR is revised once`, `pipeline: a red spec PR that stays red waits for the owner`, `pipeline: a red spec PR waiting for approval is revised first`

### PIP-83 · Design revisions see the failing logs

Every design revision on a spec PR whose checks are red gets the tails of the failing jobs' logs in its prompt, because the design session has no shell to read them.

- Applies to a revision started by the red checks (PIP-82), by the owner's comment (PIP-25), or by a
  conflict (PIP-81), whenever the spec PR's checks on its current head are red. The log tails are
  fetched the way PIP-3 does for a code PR and passed as fenced data (PIP-39), with each job's name.
- Green, pending or absent checks → the prompt has no log section. A log that cannot be fetched is
  noted in the prompt as unavailable; it does not stop the revision.
- A revision that started from a comment and finds nothing wrong in the spec but sees a red log is
  told to fix whatever in `specs/**` makes the check fail, or to say in `concerns` that the cause lies
  outside `specs/**`.
- Verified by: `pipeline: a design revision gets the failing logs`, `pipeline: a design revision without red checks has no log section`, `pipeline: an unreadable log does not stop the revision`

### PIP-85 · A refused push is a question, not a crash

When GitHub refuses a push because it already has commits on the branch that Towercab doesn't, the mission asks the owner instead of counting a crash.

- A push rejected as non-fast-forward is thrown as a typed error, not a plain one, so the crash counter
  (LOOP-6) does not count it. It counts as a refused push instead: after 3 refusals the mission is
  `waiting: answer the question`.
- The question follows the writing guide (PIP-39): it names the branch, says GitHub already has commits
  on it that Towercab doesn't, and offers what the owner can do: delete the branch on GitHub and reply,
  or start the intent over (Retry; the new attempt's branch has a new name). Never a force-push (PIP-2).
- The same goes for the spec branch's push. Each refusal is retried on the next pass; the third asks.
- Verified by: `pipeline: a refused push waits with the reason`, `pipeline: a refused push is not counted as a crash`

### PIP-86 · A leftover branch is replaced only when it is Towercab's own

Before a mission's first push, Towercab checks whether the branch already exists on GitHub and clears it away only when an earlier Towercab PR is all that is on it.

- Check: `towercab/<id>-<slug>` on GitHub (`git ls-remote`) and the PRs with that head (`gh pr list
  --head`, all states). No branch → push as today.
- The branch exists, at least one PR on it was opened by the Towercab App, and no open PR on it is
  anyone else's: Towercab closes each open one with a comment saying the intent started over, deletes
  the branch (PIP-89), then pushes. An earlier attempt or a v1 PR is the usual case; a branch whose App
  PRs are all closed is replaced the same way.
- The branch exists and an open PR was opened by anyone else, or there are commits on the branch and
  no PR of the App's at all: nothing is closed or deleted, and the mission is `waiting: answer the
  question`. The ask names the branch and the foreign PR if any, and offers: delete the branch on
  GitHub and reply, or start the intent over (Retry). Towercab does not pick the next free name
  `-<n>` by itself, since the commits may be someone's work.
- A branch whose head is the commit about to be pushed (a push that finished before a crash) is not in
  the way. Not checked again once the first push has succeeded; later rounds only push (PIP-2).
- Verified by: `pipeline: a leftover App PR is closed and replaced`, `pipeline: someone else's branch is left alone`, `pipeline: a leftover branch with commits but no PR waits`

### PIP-87 · A PR Towercab closes loses its branch

When Towercab itself closes a PR, it deletes that PR's branch on GitHub too.

- Applies to the closing in PIP-53 (`/retry` replacing an attempt: spec, plan and code PRs), to a
  mission stopped by `drop` or because its intent was removed ([PRI-9](priority.md); its open PRs are
  closed first, with a comment saying the intent was dropped), and to PIP-86. Merged PRs are not
  touched; the repo setting deletes their branches (PIP-89).
- Done on entering `stopped`, after the close, subject to the guards in PIP-89. A branch that another
  open PR still uses as its head (a newer attempt) is kept.
- Verified by: `pipeline: retry deletes the old attempt's branches`, `pipeline: drop deletes the PR's branch`

### PIP-88 · A PR the owner closes loses its branch

When a mission stops because the owner closed its PR, Towercab deletes that PR's branch.

- `machine.apply` moves the mission to `stopped` on the `closed` event (PIP-43: a PR closed without
  merge, the intent is dropped). That move is the record; the entry step of `stopped` then deletes the
  branches of the mission's closed PRs.
- Subject to the guards in PIP-89.
- Verified by: `pipeline: a PR the owner closes loses its branch`

### PIP-89 · Branch deletion is guarded and retried

Towercab deletes only branches it made for a PR it opened, and tries again if GitHub fails.

- Deleted only if the branch starts with `towercab/` (or `plan/` in the intents repo, where the plan
  PRs' branches live), its PR was opened by the Towercab App, and the PR is closed without merge. A
  branch with an open PR from anyone else, or outside those names, is never deleted. A branch already
  gone counts as done.
- The deletion is a side effect: the move to `stopped` (or, for PIP-86, `ctx.record`) is stored first,
  then `gh api -X DELETE repos/<repo>/git/refs/heads/<branch>`. A failure leaves the entry step due, so
  the next pass retries it (LOOP-6).
- Merged branches stay the job of the repo setting `delete_branch_on_merge` (`apply-settings`); Towercab
  does not delete them.
- Verified by: `pipeline: a branch outside towercab/ is never deleted`, `pipeline: a failed branch delete is retried`, `pipeline: a merged PR's branch is left to the repo setting`

### PIP-90 · One required check for Towercab's CI

Towercab's CI ends in one job, `All required checks passed`, that is green only when every other job is green or skipped on purpose; the repo's ruleset requires only that job.

- `.github/workflows/ci.yml` follows the org template: triggers `pull_request`, `push` to `main` and `workflow_dispatch`; top-level `permissions: {}` with each job granting what it needs; every third-party action pinned by commit SHA (version in a trailing comment).
- Jobs: the shared `checks` job (PR title as Conventional Commit, gitleaks, actionlint, zizmor, OSV-Scanner) and the `sast` job (CodeQL for `actions,javascript-typescript` once the repo is public, Semgrep CE while it is private), both from `MajidBabaeifar/ci`; the repo's own `Node 22: lint, typecheck, tests` and `Playwright: UI screenshots` (PIP-12) stay custom, because `npm run check` is the repo's definition of green and the shared node job does not build the UI; and `ci-ok` with `name: All required checks passed`, `needs:` every other job, `if: always()`, failing when any needed job failed or was cancelled.
- The jobs need no manual step for Towercab's own PRs: Playwright installs its browser in the job, tests use no network.
- The ruleset (`apply-settings`) is applied only after this workflow is on `main` and `ci-ok` has run there; it is not part of the code.
- A public repo can't call a private repo's workflows, so the shared ones are synced copies (REPO-9 in `MajidBabaeifar/ci`): `checks.yml`, `sast.yml` and `release.yml` sit in `.github/workflows/` with the first line `# Synced from MajidBabaeifar/ci@<sha> <path>; edit there, not here.`, and the callers use `./.github/workflows/<name>.yml`. `ci`'s daily `sync-copies` keeps them current by PR.
- Verified by: `public: CI workflow has one required aggregate job`, `public: CI workflow pins actions by SHA and grants permissions per job`, `public: CI calls synced copies of the shared workflows`

### PIP-91 · Releases and dependency updates

Towercab's repo opens a release PR from its Conventional Commits, tags and publishes a release when it is merged, and gets dependency update PRs.

- `release-please.yml` runs release-please on pushes to `main`, with `release-please-config.json` (`release-type: node`) and `.release-please-manifest.json` starting at the current `package.json` version (`1.0.0`), all from the org templates; the job calls the synced copy of the org's shared release workflow (`release.yml`, PIP-90), with `permissions: {}` at the top and the grants on the job.
- `renovate.json` is `{"extends": ["github>MajidBabaeifar/ci"]}`, which holds the 3-day release age.
- Creating the release PR needs the repo setting that lets Actions create PRs, which `apply-settings` sets.
- Verified by: `public: release-please files are present and consistent`, `public: renovate extends the org config`

### PIP-92 · Review findings name their pass

Each finding the review reports says which pass found it, so the owner sees at a glance whether it is
a bug, a security problem or a departure from the spec and plan.

- **Schemas** `review`: each item of `findings` gains `pass` (string), the pass's name as `REVIEW.md`
  `## Passes` writes it, or one of the defaults `Bugs`, `Security`, `Compliance`
  ([REPO-4](repo.md)). `agents/review.md` asks for it. A name outside that list is kept as written,
  not refused.
- The Review comment (PIP-42) shows each finding as `` - <pass> · `<file>:<line>`: <what> `` under its
  severity's heading. Approval (PIP-5) and the nit cap do not change.
- Verified by: `pipeline: review findings name their pass`, `pipeline: review comment shows each finding's pass`

### PIP-93 · The plan names the files that change

The plan lists the files the build will add, change or delete, so the owner sees how far the change
reaches before approving it, and someone who wasn't in the session could build from the plan alone.

- `plan.md` (PIP-46) gets `## Files that change` between `## Approach` and `## Steps`: one bullet
  per path, `` `<path>` (new|changed|deleted): <what changes> ``, tests included. A glob may stand
  for many similar files (generated screenshots, fixtures).
- `agents/plan.md` asks for the section and states the bar: the plan is complete enough for another
  engineer to build it without the session's context.
- A build that touches a file the plan didn't list is not refused; the review's `plan_followed`
  (PIP-5) judges it as today.
- Verified by: `pipeline: plan names the files that change`

### PIP-94 · The review has a cost cap

A review run stops at $3, as every other run has a limit, so a runaway review cannot spend without
bound.

- `agents/review.md`: `max_cost_usd: 3` (was `null`). `[agent].max_budget_usd` can only lower it
  (PIP-71). The 9 reviews run so far cost $0.23 to $1.18 each, so $3 leaves room for a large diff.
- A review that uses up its budget ends as any run that does (PIP-24, budget used up): the mission
  waits for the owner, with the reason. This narrows the review's limits; it gains nothing (PIP-77).
- Verified by: `agents: review has a cost cap`

### PIP-95 · Checks that must write to the build cache ask first

When the checks fail only because they could not write to the repo's build cache, Towercab explains
what happened and asks the owner whether the checks may write there. It does not send the failure to
the worker, because it is not a code problem.

- The checks, the proof, the screenshots and e2e run with the repo cache (LOOP-34) read-only, so they
  cannot change what setup and the worker built there. Some tools cannot run that way: cargo keeps its
  build output and its lock under `CARGO_TARGET_DIR=<cache>/target`, so `cargo clippy` stops at once.
- Detection, in verify: a red checks log with a read-only error (`Read-only file system`, `os error
  30`, `Errno 30` or `EROFS`) that names a path under `<home>/cache/<repo>/`, on that line or the 3
  lines before it. A read-only error on any other path stays a red as before.
- The mission waits `allow check writes` (stage `blocked`) and asks a question (PIP-41: on the
  current PR, else in the intent file). Its context names the command, the path, why the cache is
  read-only and that the code is not at fault. The options: `Allow` (Towercab remembers it for the
  repo and runs the checks again; later missions of the repo do not ask) and `Don't allow` (the
  mission waits `checks red`, and the owner can make the checks write inside the checkout, for example
  `CARGO_TARGET_DIR` under `[repos.<r>].env` (a name PIP-159 allows), then reply, or drop the intent). It recommends allowing,
  since setup and the worker already write there.
- An answer that starts with `allow`, `yes` or `ok` (any case) allows; any other answer does not. The
  answer continues the mission at the stage that asked, not at `build`.
- An allowed repo has the `meta` row `checks-write:<repo>` = `1`; from then on its checks, proof,
  screenshots and e2e get the cache writable. Deleting that row takes the permission back.
- Verified by: `pipeline: a read-only cache write asks the owner`, `pipeline: allowing cache writes reruns the checks writable`, `pipeline: refusing cache writes waits checks red`, `checks: read-only cache path`

### PIP-96 · An independent risk agent at each gate

Before each gate decides, a separate read-only agent that didn't write the change judges its risk
([AUT-16](autonomy.md)).

- `agents/risk.md`: tools and permissions as the review's, `session: new` (never the mission's
  session), the review model, schema `risk`. Run kind `risk`, step `risk` of the stage it judges; its
  files go to that stage's folder (`design/`, `plan/`, `review/`, as `risk-<n>.*`).
- Spec: in `design`, after the spec PR's checks are green or absent, given the spec diff
  (`git diff <base>...HEAD -- specs`), the design's concerns and the open questions it left to the
  owner. Plan: in `plan`, after the plan PR is opened, given the plan and the access it asks for. Code:
  in `review`, after a review that approves or has used its fix rounds (PIP-98), given the diff, the CI
  and proof results and the review's summary; the review's `door` and red lines feed the floor
  ([AUT-17](autonomy.md)). A review that didn't finish gets no risk run (the gate holds anyway).
- Each assessment is kept with what it judged (`riskOf.<gate>` = `riskKey`: the spec PR's head plus a
  hash of the owner's answers on it (PIP-97), a hash of the plan and its access, the diff's `git
  patch-id`) and is reused while that is unchanged; a new spec head, answer, plan or diff gets a new
  run. Its cost counts like the review's, on a session of its own (MET-28).
- Verified by: `pipeline: risk is assessed at each gate`, `pipeline: review reused for an unchanged diff`

### PIP-97 · A second reviewer reads the spec

At the spec gate the risk agent is also a second reviewer: when it finds the spec clear, with nothing
the owner must decide, the spec moves on (subject to its risk); open points go to the owner.

- Its `open_points` (`point`, `why`) at the spec gate: the decisions the owner must make before the
  spec is built, taken from the design's concerns and open questions or found in the spec. Any → the
  spec gate waits ([AUT-11](autonomy.md), why `The spec leaves <n> questions for you to settle before
  it is built.`, `one question` for one; PIP-110), the points are in
  the spec PR's body under `## Open points for you` and on the card. None → the risk decides. At the
  plan and code gates the list is empty.
- The owner's answers on the spec PR (the feedback that starts a design revision, not Towercab's own
  conflict or red-check revisions) are kept in `data.specAnswers` and given to the next spec risk run
  as decided, not to be raised again. They are part of the spec's risk key, so an answer gets a new
  check even when the revision changes nothing in the spec.
- Verified by: `pipeline: open points send the spec to the owner`, `pipeline: an answered open point lets the spec go on`

### PIP-98 · Review findings go back to the builder first

A code review that doesn't approve sends its findings back to the worker, for up to 2 fix rounds,
before the change waits for the owner.

- Review not approved (PIP-5), something the worker can fix (PIP-120) and `reviewFixes` < 2 → event `red` from `review` to `build` (why `the
  review didn't approve: fix round <n> of 2`) with `repair` kind `review`: the Review comment as the
  details, in `<review>` tags, run by `agents/repair.md` in the worker's session (tests locked as in
  PIP-31). The new diff gets a new review. After 2 fix rounds the gate holds as before (`review not
  approved`). A fix round that changes nothing waits `no changes`. `reviewFixes` starts over on a ship
  fix round ([SHIP-11](ship.md)).
- Verified by: `pipeline: a review that doesn't approve gets two fix rounds`, `pipeline: a review fix round that lands goes on`

### PIP-99 · The risk in the PR texts

Each of the three PRs says how risky the change is, in plain words.

- Once assessed, the spec, plan and code PR bodies carry `## Risk: <level>` with the three answers
  in plain words (`riskWords`, [AUT-20](autonomy.md)), the agent's summary and, when the floor raised
  it, why. The spec PR's body also lists `## Open points for you` (PIP-97). The spec and plan PR bodies
  are rewritten after the risk run; the code PR's at the gate (PIP-48). A risk run that didn't finish
  says so.
- Verified by: `pipeline: risk is assessed at each gate`, `pipeline: gate table`

### PIP-100 · Agents that only read can't write the checkout

An agent without Edit or Write can't change the checkout through its shell either.

- `claudeSettings`: for an agent whose `tools` have neither `Edit` nor `Write` (today `plan`,
  `review`, `risk`), the checkout itself is in the sandbox's `denyWrite`, besides its `.git`. Their
  allowed `Bash(git diff:*)`, `git log` and `git show` accept `--output=<file>`, so text planted in a
  diff could otherwise make them write files; the sandbox, not a pattern on the command, stops it.
- Verified by: `claude: read-only agents can't write the checkout`, `claude: review argv`

### PIP-106 · Two kinds of text

Every agent that writes for the owner writes two kinds of text: a plain brief that someone who doesn't
code understands, and the technical text agents and reviewers work from, kept as before.

- The `design`, `plan`, `build` (worker and repair) and `review` results have a required `brief`
  (string): two to four sentences on what changes for the people who use the product, what the owner
  is asked to decide or do, and the risk in everyday words, with no file names, functions, flags,
  field names, spec IDs or step names. The risk agent's `summary` is its plain brief. Each agent's
  prompt asks for it, and the writing guide (`prompts/writing.md`, PIP-39) has a section "Two kinds of
  text": who reads which, plain brief first, technical detail second, and a brief that stands on its
  own.
- Verified by: `schemas: every result a person reads has a plain brief`, `prompts: every agent that writes for the owner asks for a plain brief`

### PIP-107 · Briefs are kept with the mission

Towercab keeps each stage's plain brief beside its technical text, so cards and pages can lead with it.

- `missions.data`: `design.brief` and `design.title` (INT-34), `plan.brief`, `build.brief` (the
  worker's latest, a repair round's included), `review.brief`, and `brief` for the question being
  asked (`ask(cx, m, q, waiting, brief)`: the worker's brief when it is blocked; none clears an
  earlier one). Any wait that asks no question of its own (`apply`) drops `question` and `brief`, so an
  answered question never comes back on a later card. A question posted on a PR or in the intent opens
  with `**In plain words:** <brief>`, and so does the Review comment; the review's `details` (the
  card's and the PR's technical text) stay without it.
- Verified by: `ui: the card leads with the plain brief, the technical text folded`, `pipeline: every PR body opens in plain words`, `machine: an answered question doesn't come back on a later wait`

### PIP-108 · PR bodies open in plain words

The spec, plan and code PRs start with what the change means in plain words, with the risk and what
the owner decides beside it; the technical text is folded under "Details".

- `plainMd(brief)` = `## In plain words\n\n<brief>` ("" without a brief); `detailsMd` folds the
  technical part as `<details><summary>Details</summary>…</details>`. Spec PR: the brief, the open
  points and the risk (PIP-99), then, folded, the design's `pr` text and the spec IDs; the links stay
  open. Plan PR: the brief and the risk, the approach folded, then the access asked for, the merge line
  and the links. Code PR (PIP-48): the worker's brief, the risk and the access beyond the plan open;
  folded, the worker's sections, the checks and the review details; then the IDs, the issue line, the
  links and the footer open. Without a brief (a run from before briefs) nothing is folded and the
  bodies read as before.
- Verified by: `pipeline: every PR body opens in plain words`, `pipeline: PR text comes from the worker`

### PIP-109 · The design names the intent

The design also returns the intent's title as a plain user story, which Towercab uses for intents the
owner didn't write.

- `design.title`: one plain sentence of about 6 to 14 words, no period, naming the product and what
  someone can do or see once it's done ([INT-33](intents.md)). Kept in `data.design.title`; applied
  as [INT-34](intents.md) says. The owner's own intents keep their title whatever it returns.
- Verified by: `pipeline: an intent from elsewhere takes a plain title at pick`, `pipeline: the owner's titles are never renamed`, `pipeline: a title that breaks the naming rule is not used`

### PIP-110 · Asks and reasons say what the owner decides

What a card or message asks, and why it waits, says in plain words what the owner needs to decide or
do, not what Towercab did.

- The asks of **Waits** ([LOOP-14](loop.md)) name the decision or the step ("Decide if this change
  can go live: merge the PR to ship it, or comment what to fix."); their keys don't change, since
  intent files store them.
- The reasons an approval waits are plain sentences: the gate's (`GATE_WHY` in `src/autonomy.ts`,
  `GATE_HOLD` in `src/pipeline/gate.ts`), the risk's (`riskWhy`: `It is <level> risk, and at autonomy
  a<n> only low-risk changes go ahead without you.`; none → `The risk check didn't finish, so you
  decide whether it goes ahead.`), the spec's open points (`openPointsWhy`), the spec PR's checks and
  conflicts (each says what to do: comment so Towercab revises it, re-run the checks, or merge it
  anyway), and GitHub's refusal to merge (`mergeStateWhy`: behind, dirty, blocked, unstable, draft and
  any other state, each with the step that clears it). A blocked wait's reason stays what Towercab saw
  (a check's name, an error line, prefixed `Still failing after 2 fix attempts:` when the repairs ran
  out) and is shown as technical text (UI-126); the `checks red` ask names no count, since the owner
  refusing cache writes (PIP-95) reaches it too.
- The message of an intent-only wait (`unknown repo`, `bad after:`) opens with its ask from **Waits**.
- Verified by: `machine: every ask says what the owner decides, as the spec's table does`, `pipeline: gate table`, `autonomy: gate table`, `pipeline: open points send the spec to the owner`, `ui: the card leads with the plain brief, the technical text folded`, `pipeline: GitHub's merge state in plain words`, `pipeline: a red spec PR that stays red waits for the owner`, `loop: a repo added while running is picked up`

### PIP-111 · PR titles and commits stay short

PR titles and commit messages name the change in a few words, as the owner's rule asks, even when the
intent's title is a long user story.

- The design also returns `subject`: two to six words, Conventional Commit description style
  (lowercase, no period, no product name). `subjectOf` cleans it like a title (INT-36) to at most 60
  characters and lowers its first letter; it titles the spec PR and its commit (`docs(specs):
  <subject>`), the plan PR and its commit (`docs(plan): <subject>`), and the code PR, its commits and
  the squash merge (`<type>(<scope>)!: <subject>`). Without one, or when it cleans to nothing, the
  intent's title as before.
- Verified by: `pipeline: PR titles use the design's short subject`

### PIP-112 · The plan says how the intent is delivered

The plan states whether the intent ends as a code change or as steps the owner does, so Towercab never builds something only the owner can finish.

- The plan result (**Schemas** `plan`) gains `delivery`: `code` or `steps`; missing counts as `code`. `plan.md` (PIP-46) gets
  a line `Delivery: code` or `Delivery: steps` under the IDs line. The plan agent picks `steps` when the
  intent's outcome is a change only the owner can make (a setting on a service, an account, a machine)
  and no change to the repo would deliver it.
- A `steps` plan has at least one entry in `owner_steps` (SHIP-17), whose `when` is ignored since there is no merge: the
  checklist, its ticking and its storage (`## Your steps`, `data.steps`, SHIP-22) are SHIP-17..22 and are
  not redefined here. A `steps` plan with no `owner_steps` entry is a bad result and is asked for again
  (PIP-13). A `code` plan keeps SHIP-17 as it is.
- The plan PR shows the delivery in its description in plain words ("Nothing to build; you do these
  steps"). The merged `plan.md` is the record: the delivery is read from it, not from the mission.
- Verified by: `pipeline: plan.md carries its delivery`, `pipeline: a steps plan needs steps the owner can tick`, `pipeline: a plan without delivery counts as code`, `pipeline: an owner's edit of the delivery from code to steps is followed`, `pipeline: an owner's edit of the delivery from steps to code is followed`

### PIP-113 · A steps-delivered intent skips the code PR

When the merged plan says `steps`, Towercab opens no code PR, and the intent ends done when the owner ticks its last step.

- Merging the plan PR (`plan_merged`, LOOP-3) moves a `steps` mission to the stage `steps` and its wait
  `your steps` (LOOP-73, LOOP-74, SHIP-19), not to `build`. No build, verify, proof, publish, CI, review
  or deploy runs, and no branch or code PR is made.
- The owner ticks the steps as in SHIP-22. Ticking the last one is `ok` at `steps`; for a `steps`
  delivery it goes to `done` instead of `deploy` (SHIP-20 is for code), and the intent's `stage` becomes
  `done`. The `done` exit of LOOP-76 ends it early. Until then the wait keeps the exits of LOOP-76.
- Changing a `code` mission to `steps` (PIP-114) closes an open code PR by itself, as `drop` does
  (PIP-87), after commenting on it why ("Closed: the owner will do this by hand, so there is nothing to
  merge."). It then commits `Delivery: steps` and the steps to `plan.md` on `main` of the intents repo as for
  `plan_changed` (PIP-28), and moves the mission to `steps`. The steps come from the question's option
  or the plan; with none, the plan step is asked to add them first. Nothing the owner already merged is
  undone.
- How merged code PRs end is unchanged: a `code` plan builds, ships and ends as before.
- Verified by: `pipeline: a steps plan skips build and the code PR`, `pipeline: ticking the last step of a steps plan ends the intent done`, `pipeline: switching to steps closes the open code PR and says why`, `pipeline: a code plan ends as before`, `pipeline: a code change waiting for its steps cannot be marked done`, `pipeline: switching to steps with only before-merge steps waits for the owner`, `machine: to_steps moves only a wait on the owner`

### PIP-114 · Every option in a question maps to something Towercab does

Each option in a worker's question is one of three things Towercab can do, so choosing it always moves the intent.

- Each `options` entry in the `question` result (PIP-41) gains `do`: `continue` (resume the work with
  this option as the answer, LOOP-38), `steps` (switch the delivery to steps, PIP-113) or `drop` (stop
  the intent, PRI-9). A result with an option that has no `do`, or any other value, is a bad result and
  the worker is asked to fix it (PIP-13). A question with no option that moves the intent is refused the
  same way.
- The Question comment (PIP-42) and the plain brief name what each option will do ("Carry on with the
  build", "I'll do this myself, give me the steps", "Drop the intent"). The agent file for the worker
  tells it that options are limited to these three effects.
- An owner's own reply still answers as before (`continue` with the text); `do` only governs the
  options.
- Verified by: `pipeline: every question option maps to continue, steps or drop`, `pipeline: a question option without a valid action is asked again`, `pipeline: question comment says what each option does`

### PIP-115 · The plan names the existing tests it changes

A plan that has to change a test already on the base branch lists that test and why, and approving the
plan allows exactly those files.

- The plan result's `access` gains `tests: [{path, why}]` (**Schemas**); `path` is a file, not a glob.
  `plan.md`'s `## Access` section (PIP-47) gets one line each, ticked by default:
  `- [x] test: <path> (<why>)`. A path that matches none of PIP-30's globs, or doesn't exist on the base
  branch, is dropped with a note, since new and non-test files need no grant.
- Merging the plan PR grants the ticked test lines and no others; unticked lines are not granted. A
  revised plan PR keeps the boxes the owner unticked, as for other access.
- A plan with any test line is at least medium risk (AUT-17), and at every autonomy, a5 included, the
  owner merges it: the plan gate (AUT-12) and AUT-18 do not let Towercab merge such a plan, and the
  wait says `The plan asks to change existing tests; you decide which.` (PIP-110). Towercab never
  grants a planned test by itself.
- A granted test is no longer blocked for the worker (REPO-13). The grant is kept in the mission's
  grants as `tests` (`path`, `why`, `by: plan`).
- Verified by: `pipeline: plan.md lists existing tests to change`, `pipeline: merged plan grants its ticked tests`, `pipeline: unticked test is not granted`, `pipeline: a plan that changes existing tests waits for the owner at a5`, `pipeline: a plan that changes existing tests is at least medium risk`

### PIP-116 · An unplanned test change is asked, not taken

When the worker finds mid-build that it must change an existing test the plan didn't grant, it asks the
owner, naming the test and why, and the owner's answer decides.

- The worker returns `status: access` with `access.tests: [{path, why}]` (**Schemas** `build`); the
  guard's block reason for a protected existing test ends `if you need it, finish what you can and
  return status access with this test and why`. Like all unplanned access (AUT-15) this is never
  granted by Towercab itself, at any autonomy: the mission waits with a question that names the test
  and the reason (PIP-110), with the options `Allow this change` and `No, keep the test as it is` (PIP-138), and a
  recommendation.
- The owner's answer is read as a choice (PIP-138): allow → the file joins the grants (`by: owner`) and the
  worker resumes with it writable; refusal → refused; a reply that is neither is asked again (PIP-139). A refused
  file is recorded in `data.refusedTests`, stays blocked for the rest of the mission, and the resumed
  worker is told it is refused and must finish without changing it, or ask in another way
  (`status: blocked`). Asking again for a refused file doesn't ask the owner twice: it is refused at
  once.
- Verified by: `pipeline: an unplanned test change asks the owner`, `pipeline: allowing a test grants that file`, `pipeline: a refused test stays blocked`

### PIP-117 · Publish refuses a changed existing test that wasn't granted

The code PR can't change or delete an existing test unless it was granted, even if the guard was
bypassed.

- Publish compares the head with `origin/<base>`: any file matching PIP-30's globs that exists on the
  base and is modified, deleted or renamed away, and is not granted (PIP-115, PIP-116), refuses the
  push, naming the files, as for a protected path (PIP-29). New test files pass. A repair round
  returns to the worker as for PIP-31.
- A file that reads at the new head exactly as on the base branch is not a change: a merge of the base
  that brought test changes in (a conflict round) passes, as in PIP-31. PIP-31's repair lock and the
  review's weakened-test check (PIP-5) are unchanged and apply to granted tests too.
- Verified by: `pipeline: publish refuses an ungranted change to an existing test`, `pipeline: publish refuses deleting an existing test`, `pipeline: new tests and granted tests pass publish`, `pipeline: a merge of the base may bring in test changes`

### PIP-118 · The intent page shows the tests that were granted

The intent page lists which existing tests the worker was allowed to change, and why, so the owner sees
every goalpost that moved.

- The intent page (UI-62) gets an "Existing tests changed" section, shown when the mission has any grant
  in `tests` or a refusal: one line each with the path, the reason, who allowed it (the plan or the
  owner) and, for a refused one, "refused". The code PR's body lists the granted ones under "Tests
  changed beyond new ones" in plain words; none → neither section appears.
- Verified by: `ui: the intent page lists granted existing tests`, `pipeline: the code PR lists granted existing tests`

### PIP-135 · The plan predicts the existing tests a change touches

The planner looks up which existing tests cover the files the plan changes and lists them for the
owner up front, so the build does not stop to ask about each one.

- Extends PIP-115. For every file the plan changes, the planner finds the existing test files that
  cover it: those that import it, or whose name matches it (`src/machine.ts` → `tests/machine.test.ts`),
  and the shared helpers those tests import (PIP-137). A plan that changes behaviour a state machine,
  schema or public function defines also lists the tests that assert that behaviour.
- Each such file the change will edit, delete or rename goes into `access.tests` with a `why` that
  names the file or behaviour that makes it necessary. Tests the plan only adds to, and tests it
  expects to stay unchanged, are not listed. PIP-115's drop rule, ticking, risk and owner-merge rules
  apply unchanged.
- The planner's agent file (`agents/plan.md`) tells it to do this search before it writes `## Access`.
- Verified by: `pipeline: plan prompt tells the planner to predict covering tests`, `pipeline: plan access lists tests that import a changed file`

### PIP-136 · Guarded tests are asked once, all together

When the worker needs several guarded tests mid-build, it keeps working on everything else and asks the
owner once, with the whole list.

- Extends PIP-116. The guard's block reason (REPO-13) tells the worker to carry on with all work that
  does not need the file, note every guarded file it needs and why, and return one `status: access`
  with every file in `access.tests`. The worker does not stop at the first block. The agent file for
  the worker says the same.
- The mission waits with one question (PIP-110) listing each file and its reason, with the options
  `Allow all of them` and `No, keep all as they are` (PIP-138), and a recommendation. A reply that names some of the
  files allows those. Following PIP-116's rule, a file the reply does not clearly allow is refused.
- Allowed files join the grants (`by: owner`); refused ones go to `data.refusedTests` (PIP-116). A
  list of one file asks as before. Files already granted or refused are left out of the list; if all
  are, nothing is asked.
- Verified by: `pipeline: a build needing three guarded tests asks once with all three`, `pipeline: a reply can allow some of the asked tests`, `pipeline: the guard reason tells the worker to collect every guarded test`

### PIP-137 · A helper can get additions without asking

A shared test helper with no test cases of its own can get new exported functions, types and constants
without asking; any other change to it is asked.

- A *helper* is a file on the base branch that matches PIP-30's globs and contains no test cases (no
  `it`, `test` or `describe` call; `tests/helpers/**` is the usual case). A helper is not
  write-blocked (REPO-13), so the worker can edit it. A file with any test case stays blocked as
  before: this never loosens the guard for tests.
- A helper change is *free* only when, against `origin/<base>`, it removes or changes no existing line
  and every added top-level statement is a new exported function, type, interface or constant (with
  the imports they need). Any other added top-level statement is not free: code that runs on import,
  `vi.mock` or other mocks, `beforeEach`/`afterEach` hooks, changed setup. Deleting or renaming a
  helper is not free.
- When a worker round ends with a helper whose change is not free and not granted, the edit stays in
  the worktree but is *held*: it is not published. Towercab adds the helper to the batched question
  (PIP-136) with the reason. On allow, the file joins the grants (`by: owner`) and the edit stays; on
  refuse, the helper is restored to the base content then and recorded in `data.refusedTests`
  (PIP-116). The worker's other work is kept throughout.
- Publish (PIP-117) refuses any helper whose change is not free and still has no answer, naming the
  files, so nothing ungranted ships. A free change passes. The planner (PIP-135) lists a helper only
  when the plan changes more than that free kind. The intent page (PIP-118) does not list helpers that
  only had free changes.
- Verified by: `guard: a helper without test cases is not blocked`, `pipeline: adding an exported function to a helper does not ask`, `pipeline: changing a helper function asks`, `pipeline: a new top-level statement in a helper asks`, `pipeline: a held helper edit stays until the owner answers`, `pipeline: a refused helper edit is restored`, `pipeline: publish refuses an unanswered helper change`, `pipeline: publish passes a free helper change`, `repo: a file with test cases stays blocked`

### PIP-138 · A reply that starts with yes is an allow, with its conditions passed on

An owner's reply to a test question is read by how it starts, and anything after a yes is an instruction
for the worker, not a refusal.

- Replaces the reading rule of PIP-116 and PIP-136 (`readsAsAllow`). The reply is trimmed and lower-cased,
  then read by its first whole word (the text up to the first space or punctuation, so `no,` is `no` but
  `not` and `nothing` are not): an *allow* starts with the word `yes`, `allow`, `ok`, `okay`, `approve`,
  `approved` or the phrase `go ahead`; a *refusal* starts with exactly the word `no`, `refuse`, `don't`,
  `dont` or `keep`; a reply that starts with anything else is *unclear*. So `Keep the test as it is`
  and `No, keep all as they are` refuse, while `Not sure` and `Nothing against it, go ahead` are
  unclear, never refusals. Words later in the reply (`not`, `keep`, `without`, `don't`) never change
  the reading.
- The suggested answers start with the reading word: the options of the test question (PIP-116) are
  `Allow this change` and `No, keep the test as it is`, and those of the batched question (PIP-136) are
  `Allow all of them` and `No, keep all as they are`, so choosing an option as written is read as
  intended.
- On an allow, whatever follows the allow word is passed to the resumed worker as the owner's conditions
  ("The owner allowed you to change X, on these conditions: …"), with the full reply quoted. A bare
  allow adds no conditions line.
- In a batched question (PIP-136) a reply that allows names the files it allows: a bare allow allows all
  asked; a reply naming some allows those and leaves the rest unanswered, not refused (PIP-139).
- Verified by: `access: a reply starting with yes allows even with a condition`, `access: the fifteen replies of 261031-1714-5 read as allow`, `access: a reply starting with no refuses`, `access: a reply starting with keep refuses`, `pipeline: the test question options start with the word they are read by`, `access: only whole first words refuse`, `pipeline: conditions after a yes reach the worker`

### PIP-139 · An unclear reply is asked again, never read as allow or refusal

When a reply starts with neither an allow nor a refusal word, Towercab asks again instead of deciding.

- The default stays safe: an unclear reply (including an empty one) never allows and never records a
  refusal, since a refusal is permanent without PIP-141. The mission keeps waiting and Towercab posts
  (as an owner reply, PIP-140) "I could not tell whether this is a yes or a no. Reply starting with yes or no." The
  question is not re-created; it stays the same one.
- In a batched question, files the reply names with a clear allow or refusal are decided; files it does
  not decide stay asked, with the same line. This replaces PIP-136's "not clearly allowed is refused".
- Verified by: `access: an unclear reply is asked again`, `pipeline: an unclear reply records no refusal`, `pipeline: undecided files of a batch stay asked`

### PIP-140 · Towercab says how it read each answer

Every answer to a test question gets a reply that states what Towercab did with it, so a misreading shows at once.

- After an answer is processed (PIP-116, PIP-136, PIP-137, PIP-141), Towercab posts one reply where the
  answer came from (the PR or the intent page): `Allowed: <paths>` and/or `Refused: <paths>`, plus
  `Still asked: <paths>` for undecided files, and a line "Reply `allow <path>` to change a refusal."
  when anything was refused. Paths are listed as files, one per line when more than three.
- The text follows `prompts/writing.md`. It is posted before the worker resumes (record first, then the
  side effect), so the owner sees it even if the build ends blocked.
- Verified by: `pipeline: the reply states which tests were allowed and refused`, `pipeline: the reply lists tests still asked`, `pipeline: the reply tells how to reverse a refusal`

### PIP-141 · The owner can reverse a refusal

A refused test can be allowed later, for the running mission, without throwing the build away.

- `towercab answer <id> allow <path>` and, on GitHub, a plain reply `allow <path>` on the mission's PR or
  on the question (same exits as `towercab answer`, LOOP wait rules) move `<path>` from `data.refusedTests` to the grants (`by: owner`).
  `<path>` must be in `data.refusedTests`; otherwise the command fails with an error that says so and
  lists the refused paths. Several paths may follow `allow`.
- Only a running mission can be changed: a merged, dropped or failed one refuses with the reason. Nothing
  moves the other way: an allowed test is not refused again by this command.
- The next guard rules (REPO-13) leave the file writable, and a worker that was told the file was refused
  (PIP-116) is told it is now allowed on its next round. A mission blocked on the refusal continues. The
  intent page (PIP-118) shows the file as allowed by the owner. Towercab replies as in PIP-140.
- Verified by: `cli: answer allow moves a refused test to allowed`, `cli: answer allow fails for a test that was not refused`, `pipeline: a reversed refusal leaves the test writable in the next guard rules`, `pipeline: a blocked mission continues after a refusal is reversed`

### PIP-142 · A teammate's approval is its own thing

In a repo that needs a teammate's review, only an approval from someone other than the owner, the bot and the Claude review counts as that review.

- Applies when the repo has `teammate_review=on` (LOOP-83). A teammate approval is a GitHub review in
  state `APPROVED` on the PR's current head (`commit.oid` = `headRefOid`), whose author is not
  `[github].me`, not the App's bot and not the PR's author when that is the owner. The Claude review
  (PIP-4) and the owner's own Approve (PIP-43) never count; a later `CHANGES_REQUESTED` from the same
  reviewer replaces their earlier approval.
- **Stale approvals.** An approval of an older head is stale and does not count, except when the head
  moved only by bringing the branch up to date with the base: the PR's own changes are the same, i.e.
  `git patch-id --stable` of the diff from the merge base to the approved commit equals that of the
  diff from the merge base to the current head (both computed from the git history, nothing
  remembered). Any difference in the PR's own diff cancels the approval and the teammates are asked
  again (PIP-143). If the host's branch rules dismiss stale approvals, Towercab follows the host: a
  review the host reports `DISMISSED` never counts, and Towercab does not re-count it.
- **Who counts.** Only two kinds of people: the logins in `reviewers` (LOOP-83) and the **code
  owners** of the PR's changed paths. Anyone else the host was asked to review, whoever asked
  (Towercab, a teammate, a rule), does not count and is not heard (PIP-145), even when the host
  already reports the PR `APPROVED` (`reviewDecision`). A listed login counts for every path.
- **Code owners.** Read from the repo's `CODEOWNERS` (`.github/`, the root or `docs/`, first found)
  on the **base branch**, so a PR cannot change its own owners; the PR's changed paths come from its
  file list (`gh pr view --json files`). Per path the last matching pattern wins, as on GitHub; its
  `@login` owners are the path's code owners. Read again with the PR (PIP-21) before every decision
  that uses them (the gate, a merge, an event); nothing is remembered.
- **Stricter where the case is unclear**, always the option that counts fewer people:
  - a team owner (`@org/team`) or an email owner is not expanded and counts for nobody; list the
    people instead;
  - an unreadable or missing `CODEOWNERS`, a file list that cannot be read (or is cut off by the host
    at 3000 files), and a path no pattern matches mean no code owners for that path;
  - the owner (`[github].me`), the bot and the PR's author never count, even if listed or a code owner;
  - an approval counts only when the host also keeps it: a review the host reports `DISMISSED`
    does not count.
- With no listed login and no code owner for any changed path, nobody is known to review: the mission
  asks the owner to list reviewers (`towercab repo set <name> reviewers=…`, LOOP-83) and does not
  merge. One counted approval is enough for Towercab; the host's own rules must also be met (PIP-147).
- Verified by: `pipeline: a listed reviewer's approval counts`, `pipeline: the owner's approval is not a teammate approval`, `pipeline: an approval of an older head with a changed diff is stale`, `pipeline: a code owner of a changed path counts`, `pipeline: someone the host was asked to review but is neither listed nor a code owner does not count`, `pipeline: an unlisted approval does not count even if the host approved`, `pipeline: CODEOWNERS is read from the base branch`, `pipeline: the last matching CODEOWNERS pattern wins`, `pipeline: a team owner counts for nobody`, `pipeline: an unreadable CODEOWNERS means no code owners`, `pipeline: no reviewers and no code owners asks the owner`

### PIP-143 · Review is requested once the PR is ready

When the code PR is ready, Towercab asks the listed reviewers (or the code owners) to review and shows who it is waiting for; if the automated review did not approve, the owner looks first.

- "Ready" = not draft, CI green (PIP-3) and the Claude review approved (PIP-5). Then, once per head,
  Towercab requests review from the `reviewers` list (`gh api -X POST
  repos/<r>/pulls/<n>/requested_reviewers`); with an empty list it requests nobody and leaves it to
  CODEOWNERS. A reviewer whose request fails (not a collaborator) is named in an owner step; the
  others are still requested.
- A PR the Claude review did not approve (after its fix rounds, PIP-98) waits for the owner as the
  gate says (PIP-7, `approval:merge`, worded for this case as "look at it, then pass it on to your
  teammates"). Teammates are asked only after the owner **passes it on**: a comment that is exactly
  `/pass` (alongside PIP-45's commands) or the card's button (UI-168) raises `passed_on`. The owner's
  Approve review does not pass it on and does not merge here (PIP-144). Pass-on holds for the head it
  was given on; a new head is reviewed by Claude again and, if not approved, comes back to the owner.
- The mission waits as `teammate review` at the code PR's `approval:merge` (`teammate review of spec` at
  the spec PR's `approval:spec`); its why names who: `Waiting for teammate review from alice, bob.`, or
  `from the code owners`, worded plainly per PIP-110. `status`, `next` and the intent page show the same wait. It does not use a build place (LOOP-100) and has a way out
  (LOOP-76): the owner can `/retry`, change the list, or close the PR.
- A new head whose own diff changed (a repair round, PIP-142) asks again and drops the wait on the old
  approval. A head that only brought the branch up to date with the base keeps the approval and asks
  nobody again, unless the host dismissed it.
- Verified by: `pipeline: gate waits for a teammate approval at a4 and a5` (the listed reviewers are asked once, the wait names them), `pipeline: an approval survives an update that only brings the branch up to date`, `pipeline: a changed diff cancels the approval and asks again`, `pipeline: a dismissed approval is not counted again`, `pipeline: an unapproved review goes to the owner before the teammates, who are asked once it is passed on`, `events: pass comment passes it on`, `events: approve review does not pass it on`

### PIP-144 · Nothing merges without the teammate's approval

In such a repo the gate never merges before a teammate approval, at any autonomy level.

- PIP-7's table gets one row, right after its rows for CI and the review: no teammate approval on the
  gated head (PIP-142) → `teammate review` (PIP-143), at `a` 4 and 5 too, whatever the risk
  level (AUT-18) or caps. In this repo the "review not approved" row holds for the owner until the
  owner passes it on (PIP-143); after that the teammate row applies. Once approved, the rest of the
  table applies unchanged.
- At `a` ≤ 3, once the teammate approvals the host requires are in (PIP-142, PIP-147), the mission
  waits for the owner as everywhere else (PIP-7, `approval:merge`) and the owner merges the usual
  ways: the card's Merge button, `towercab approve <id>`, or GitHub's own merge button (the host
  decides whether it allows it; Towercab does not stop it). Before the approvals are in, the card's
  Merge button and `towercab approve` are refused with the reason (`waiting for teammate review from
  <who>`).
- The owner's Approve review on the PR is not one of those ways in these repos (it overrides PIP-43
  here): it never counts as a teammate approval, never merges and never passes the PR on. Towercab
  replies once, "Reply `/pass` to ask your teammates" before they are asked, or "Merge with the card's
  button or `towercab approve`" after.
- The owner's own merge (the card's Merge, `towercab approve`) re-checks too: it is refused until the
  change is passed on, and, where the gate did not check for a teammate approval (the review or CI had
  not finished, or any wait on a spec PR), until the owner's `gh` reads a counted approval on the PR's
  head. A PR that can't be read is refused.
- Towercab merging (PIP-22) re-checks the approval on the head it merges. If the host refuses the
  merge for the review rule, the mission goes back to this wait; Towercab never works around the host's
  rules, and the host's rules and the list are both required (a listed approval does not override a
  host rule it does not meet).
- Spec PRs follow the same rule: Towercab merges one at a4 and a5 (PIP-50) only after a teammate
  approval, and waits as above. Plan PRs in the owner's intents repo (PIP-51) do not: that repo is the
  owner's own.
- Verified by: `pipeline: gate waits for a teammate approval at a4 and a5`, `pipeline: owner approve does not merge in a teammate review repo`, `pipeline: the owner merges at a3 once the teammates approved`, `pipeline: merge and approve are refused before the teammates approved` (the page's Merge; the approve command gives the same refusal), `pipeline: the owner's merge needs the pass-on first`, `pipeline: the owner's merge is refused where the gate skipped the teammate check`, `pipeline: the owner's merge of a spec PR checks for a teammate approval`, `pipeline: the owner's merge is untouched where no teammate review is needed`, `pipeline: the owner's merge is refused when the PR can't be read`

### PIP-145 · A reviewer's feedback starts a repair round

A request for changes or comment from a listed reviewer or a code owner of the changed paths is treated like the owner's feedback, and nobody else's is.

- Extends PIP-44 for repos with `teammate_review=on`: reviews and comments by one of the PR's reviewers
  (PIP-142: listed, or a code owner of a changed path, read again before the event is taken;
  case-insensitive, never the bot or the owner) raise `feedback` (PIP-43) with their text, prefixed with who wrote
  it (`alice asked for changes: …`). Feedback is a review in state `CHANGES_REQUESTED`, or a
  non-empty comment that is not part of an approval: an issue comment, or an inline review comment
  (PIP-21) belonging to a review that is not `APPROVED`. They follow `feedback_seen` as the owner's do.
- An approval is an approval, with or without text: an `APPROVED` review, its body and its inline
  comments never raise `feedback` and never start a repair round. Its text is added to the mission's
  record (`alice approved: …`, shown on the intent page and in the stage comment, PIP-42) so the owner
  can read it, and nothing more happens.
- The feedback starts a repair round like the owner's, goes into the continue prompt (PIP-37) and
  clears the teammate approval of the old head. Slash commands (PIP-45) and `allow` replies still
  need the owner. Anyone who is neither listed nor a code owner of a changed path is ignored as before, even if the host asked them to review.
- Verified by: `events: a listed reviewer's request for changes is feedback`, `events: a listed reviewer's comment is feedback`, `events: a code owner's request for changes is feedback`, `events: someone neither listed nor a code owner is ignored`, `events: someone the host asked to review but who is not a code owner is ignored`, `events: a reviewer cannot send slash commands`, `events: an approval with text is not feedback`, `events: inline comments of an approval are not feedback`, `pipeline: an approval's text is shown in the record`, `pipeline: reviewer feedback names who wrote it`

### PIP-146 · The owner answers for the PR

In a repo that needs a teammate's review, the PR is assigned to the owner.

- With `teammate_review=on`, Towercab assigns `[github].me` to the spec and code PRs when it opens
  them (`gh pr edit --add-assignee`, once; a failure is logged, not a wait). Plan PRs in the owner's
  intents repo are not assigned. A repo with the setting off is unchanged.
- Verified by: `pipeline: gate waits for a teammate approval at a4 and a5` (the owner is assigned to the spec and code PRs, never a plan PR)

### PIP-147 · A warning when the host asks for more approvals than the reviewers can give

When the host's rules need approvals the reviewers can't supply, Towercab says so on the PR's card and the repo page so the owner can fix the list.

- Both the reviewers' approval (PIP-142) and the host's rules must be met; Towercab never merges around
  the host. The mission carries `data.reviewWarning` (text, or none) while either holds, for a PR
  waiting at `teammate review` or refused by the host for its review rule (PIP-144):
  the host requires `n` approvals (branch protection or ruleset, as in LOOP-84) and the reviewers
  (PIP-142, minus the PR's author) number fewer than `n`; or the PR has the reviewers' approval but the
  host still reports it `REVIEW_REQUIRED` or the merge is refused for approvals.
- Text, plain (PIP-110): `GitHub needs <n> approvals and your reviewers can give <k>: add reviewers
  with towercab repo set <name> reviewers=…`, or `GitHub still wants an approval you have not got: …
  from <who the host asks, e.g. the code owners>`. It clears when the cause is gone. It does not
  stop the wait and is shown, not sent as a message (LOOP-14).
- Verified by: `pipeline: too few reviewers for the host's rule sets a warning`, `pipeline: a host that still wants approval after the reviewers' sets a warning`, `pipeline: the warning clears when the list is fixed`

### PIP-148 · A repair round sees the code scanning alerts that failed the pull request

When a failed check has no Actions run log, such as `CodeQL`, the repair round gets the open code scanning alerts of the pull request, each with its rule, file, line and message.

- Applies wherever PIP-83's log tails are built for a red pull request (the code PR's repair rounds in
  `ci.ts` and the spec PR's revisions, PIP-83). A red check has no run log when its `run` is null.
- For such checks the `Forge` reads the open alerts of the merge ref: `gh api
  repos/<repo>/code-scanning/alerts?ref=refs/pull/<n>/merge&state=open`, like the other host reads only
  `GitHubForge` builds the arguments. A host without code scanning returns no alerts.
- The read uses the GitHub App's token, like the other host reads (not the owner's `gh` login).
- Only alerts in files the pull request changes are kept: an alert is kept when its path is one of the
  files the PR's diff touches (the PR's changed-file list, read through the `Forge`). Alerts in other
  files, such as old ones on the base branch, are left out and not counted.
- Each kept alert becomes one line after the check list: `- <rule id> at <path>:<line>: <message>`, in
  the alerts' order, at most 20; more are summarised as `and <k> more`. The block is passed as fenced
  data (PIP-39), with the tail limit of the run logs. Checks that do have a run keep their log tail as today.
- No open alerts in the PR's files, or all checks have a run → no alert block, and the details are as before.
- Verified by: `pipeline: a red CodeQL check without a run gives the repair round the alert's rule, file and line`, `pipeline: a check with a run log gets no alert block`, `pipeline: alerts in files the pull request did not change are left out`

### PIP-149 · Unreadable code scanning alerts are noted, not fatal

When the alerts can't be read, the repair details say so in one line and the repair round goes on.

- A failure of the read in PIP-148 (the host unreachable, an error from `gh`) adds
  `(the code scanning alerts couldn't be read: <reason>)` to the details, as an unreadable run log does
  (PIP-83); it neither throws nor counts as a crash (LOOP-6), and the repair round starts.
- A refusal by the host (403, "Resource not accessible by integration") is the missing App permission
  and gets its own line instead: `(the code scanning alerts couldn't be read: the GitHub App needs the
  Code scanning alerts: read permission)`. PIP-150 adds the owner step.
- Verified by: `pipeline: unreadable code scanning alerts are noted in the repair details`, `pipeline: a refused alert read names the missing permission`

### PIP-150 · A missing code scanning permission is one owner step

If the GitHub App can't read code scanning alerts, the owner gets one step to grant it, shown once, and no mission waits on it.

- The first refusal in PIP-149 stores `code-scanning-permission` and adds one owner step, shown with the
  repo's other steps and not once per repo or per pull request: `Grant the Towercab GitHub App the Code
  scanning alerts: read permission`, ticked by the owner (as REPO-32 does for Administration).
- While the flag is set, the repair details carry the one line of PIP-149 and the read is not retried.
  Ticking the step clears the flag so the next red check reads again; a read that is refused again sets
  it and shows the step again.
- No mission waits on it and nothing is sent as a message (LOOP-14).
- Verified by: `pipeline: a refused alert read becomes one owner step`, `pipeline: a refused alert read is not retried until the step is ticked`

### PIP-151 · A change keeps editing the tests it added itself

Repair rounds can edit a test file the pull request created or its plan allowed; only tests that already exist on the base branch stay locked.

- The lock of PIP-31 covers a test file (PIP-30's globs) only when it exists on `origin/<base>` and is
  not granted. A file absent on the base (the PR added it), or granted by the plan or the owner (REPO-13,
  PIP-116, PIP-141), is never locked, in the guard rules (`locked` in `guard.json`, PIP-29) and in
  publish's check, in every later round: CI fixes, review fixes, answers and conflict rounds.
- "Absent on the base" is read at the base branch tip fetched for the round, so a file whose path was
  added to the base by someone else meanwhile counts as a base file and is locked.
- A test file that exists on the base stays locked even if the PR edited it in its first push.
- The looser lock keeps its two safeguards: the red→green proof (PIP-30) runs again after every round that
  changes a test, so the PR's tests must still fail without the change, and the review sees the test
  diff. `agents/review.md` gets one line: flag a fix round that weakens the PR's own tests (it counts as
  `tests_weakened`, PIP-5).
- Verified by: `pipeline: a repair round may edit a test the pull request added`, `pipeline: a repair round that edits a test from the base still waits`, `pipeline: a granted test is not locked in a repair round`, `pipeline: proof runs again after a round that edited a test`, `pipeline: the review prompt asks to flag a fix round that weakens the PR's own tests`

### PIP-152 · An owner's allow also unlocks a test locked by the repair lock

`towercab answer <id> allow <path>` (or a reply `allow <path>` on the PR) lets the worker edit a test that PIP-31 locked, for the rest of that mission.

- `allow <path>` is valid for a path that is in `data.refusedTests` (PIP-141) or that a repair round was
  stopped on because of the lock (guard or publish). A stop on the lock records the path as
  `data.lockedTests` and the question or wait names it, with the line "Reply `allow <path>` to let the
  worker edit it."
- An allow moves the path to the grants (`by: owner`); the next guard rules and publish check leave it
  unlocked in every later round of the mission, and the command fails for any other path with the error
  of PIP-141 listing the refused and locked paths. Towercab replies as in PIP-140 and the blocked
  mission continues.
- The grant is for this mission only; it does not outlast a merge or a new mission.
- Verified by: `cli: answer allow unlocks a test locked in a repair round`, `pipeline: an allowed locked test passes publish in later rounds`, `pipeline: a stop on the repair lock names the path and how to allow it`

### PIP-153 · A merge of the base may force an edit to a locked test

A conflict round may change a locked test where the base's own changes force it, and publish accepts that as part of the merge.

- In a conflict round (PIP-134, PIP-22), edits to a locked test (PIP-31) are accepted by publish and the
  guard when the base changed, since the merge base, that test file or a file under `src/` that the test
  imports (directly, by its relative `import`s). There is no matching of lines or hunks: the whole file is
  open for that round.
- A locked test whose own file and imported `src/` files are unchanged on the base stays locked in the
  conflict round. Only the conflict round gets this; a CI, review or answer round does not.
- Proof and review (PIP-151) apply to these edits like to any other.
- Verified by: `pipeline: a merge of the base may edit a pushed test whose imported source changed on the base`, `pipeline: a merge of the base may edit a pushed test that changed on the base`, `pipeline: a conflict round can't edit a pushed test the base did not touch`

### PIP-154 · A repair round reads the log of the job that failed

When a run's failed-jobs log is only a summary job's, the repair round gets the own log of each job that really failed.

- Applies wherever PIP-83's log tails are built for a red pull request (the code PR's repair rounds in
  `ci.ts` and the spec PR's revisions). For a failed check with a `run`, the job id is the number after
  `/job/` in the check's details URL (`Check.url`). The `Forge` gets `jobLog(repo, job)`, which reads
  `gh api repos/<repo>/actions/jobs/<job id>/logs`; like the other host reads only `GitHubForge` builds the
  arguments.
- A check is a summary job when its name's last segment (after the final ` / `) is `ci-ok`. When at least
  one failed check is not a summary job, summary checks are skipped and only the others are read. When
  every failed check is a summary job, the log is read as before (PIP-83).
- Each job's tail is the last 6000 characters of its log (PIP-83's limit) under the line `Job <check name>:`;
  at most 3 jobs are read per round, in the order of the checks. The run-level `--log-failed` read of
  PIP-83 is kept for a check whose URL holds no job id and for the all-summary case.
- Verified by: `pipeline: a red run whose failed log is only the summary job gives the repair round the failed job's finding`, `pipeline: summary jobs are skipped when another check failed`, `pipeline: a check without a job id in its URL keeps the run log`, `forge: jobLog reads the job's own log through the api`

### PIP-155 · A long job log is cut around the finding, never the secret

A long log from a secret scanner or Semgrep is cut to the findings, and a secret's value never reaches the repair round.

- A job log longer than the tail limit (PIP-154) is cut before the tail is taken: for gitleaks, to the
  finding blocks (the `RuleID`, `File`, `Line` and `Fingerprint` lines of each block); for Semgrep, to
  the block that starts at `Findings:` or `Code Finding` and ends at the summary line. Other logs keep
  their last 6000 characters.
- Lines that carry the secret are dropped for gitleaks: `Secret:`, `Match:` and the `Finding:` line,
  whatever the log level prefix. The rule applies to a log of any length, also one that is short enough
  to pass whole. A repair round is told the file and line, not the value.
- If no block is recognised, the tail applies as before, with the same lines dropped.
- Verified by: `pipeline: a long gitleaks log is cut to its RuleID, File and Line blocks`, `pipeline: a gitleaks secret value never reaches the repair details`, `pipeline: a long Semgrep log is cut to its findings block`, `pipeline: a log without a known finding block keeps its tail`

### PIP-156 · An unreadable job log is noted, not fatal

When one job's log can't be read, the repair details say so in one line and the round goes on.

- A failure of the read in PIP-154 adds `(the log of job <name> couldn't be read: <reason>)` and the run's
  `--log-failed` output is used for that check instead; it neither throws nor counts as a crash (LOOP-6).
- Verified by: `pipeline: an unreadable job log is noted and the run log is used`

### PIP-157 · The sandbox is fixed in code

Nothing a person or a repo writes can loosen the sandbox: its arguments, mounts, masked files, environment and network are decided by Towercab's code alone.

- `sandboxArgv`, the Claude run's sandbox settings (PIP-24) and the sandbox environment are built from the mission only (checkout, cache, granted domains). No config key, no `TOWERCAB.md`, `CLAUDE.md` or agent file, no intent field and no plan text adds a mount, removes a mask, adds a variable, passes a bwrap or Claude sandbox argument or turns the sandbox off.
- There is no "unsafe" switch, flag or environment variable. `[agent].toolchain`, `[agent].path`, `[agent].env` and `[agent].sandbox_unix_sockets` no longer reach a sandboxed command: the toolchain directories (`~/.local/bin`, the standard install places of PIP-223, and the directory of the Node running Towercab when it lives under HOME; when that directory is a `bin` of its own install, such as `~/.local/node/bin`, the whole install is mounted read-only so `npm` and `npx`, links into `../lib`, resolve), `PATH` and the masked files are decided in `src/pipeline/sandbox.ts`, and the sandbox of repo commands never binds unix sockets in (nor does Claude's own, PIP-162). The one setting that stays is a repo's named variables, `[repos.<r>].env`, under the narrow rule of PIP-159. A config that still sets an ignored key loads, and `towercab doctor` names the key as ignored.
- A repo file that asks for more (a `TOWERCAB.md` setting, an agent file with `sandbox: none` for a tool-using agent, PIP-78) is refused with the reason or ignored, and never changes the argv.
- Verified by: `sandbox: config keys do not change the argv`, `sandbox: repo and intent files do not change the argv`, `sandbox: no unsafe switch exists`, `sandbox: ignored config keys are named by doctor`, `sandbox: node's whole install is mounted so npm resolves`

### PIP-158 · Network goes through an allowlist proxy

A sandboxed command has no network of its own: it reaches only the domains the run is granted, through a proxy that checks every connection.

- The sandbox always runs with `--unshare-net`. A proxy run by Towercab outside the sandbox listens on a unix socket bound into it; the sandbox sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` for it (and their lower-case forms) and has no other route out.
- The proxy allows a `CONNECT` or request only to a granted domain (AUT-14, AUT-26; `*.d` matches subdomains). It refuses IP literals, a name that resolves to a loopback, private or link-local address, a port other than 80 and 443, and any host not granted; a refusal is logged with the domain.
- The built-in package-registry list (AUT-14, AUT-26) is the same for setup (PIP-23), checks, proof, screenshots and e2e commands and Claude runs, and nothing more: any other domain reaches a command only as a plan grant (AUT-14). The one exception is the ship stage (SHIP-5, SHIP-9): its commands (the e2e suites, `live_command`, `rollback_command`) also reach the host of the live URL, the app just shipped to. A platform's API is a plan grant or, for every intent of a repo, the owner's `towercab repo set <name> ship_network=<domains>` (LOOP-69; kept in the database, never in a repo file, and named by `towercab doctor`); a private-address or `localhost` live URL stays unreachable. Nothing else changes by command or by autonomy level. With no domain at all, no proxy socket is bound and nothing is reachable. An error of an upstream or a client (a reset in the middle of a download, a client that vanishes) ends only that connection: a 502 if no response has started, else the response is destroyed; nothing is thrown out of the proxy into Towercab's process.
- Verified by: `sandbox: network is always unshared`, `sandbox: the proxy allows a granted domain`, `sandbox: the proxy refuses a domain that is not granted`, `sandbox: the proxy refuses IP literals and private addresses`, `sandbox: no grant binds no proxy`, `sandbox: a plan's domains reach commands too`, `sandbox: the ship stage reaches the live app's host`, `sandbox escape: a granted domain goes through the bridge and an ungranted one is refused`, `sandbox: ship commands reach the platform domains the owner approved`, `sandbox: an upstream reset mid-download does not stop the proxy`

### PIP-159 · A repo's commands never see a credential

Setup, checks and e2e commands of a repo run with no token, key or login of the person running Towercab, nor of Towercab itself.

- The environment is built from an allowlist: `HOME` (an empty tmpfs), `PATH`, `LANG`, `TMPDIR`, the proxy variables (PIP-158), the cache variables (LOOP-34) and the repo's own named variables `[repos.<r>].env`. No variable of Towercab's own environment passes, so `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_*`, `SSH_AUTH_SOCK`, `AWS_*`, `SOPS_*` and `AGE_*` are never set.
- A repo variable in `[repos.<r>].env` passes only if its name is not token-like (it contains none of `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `AUTH`, any case) and its value is not a secret pattern (a GitHub, Anthropic, AWS, Slack or similar token prefix, a JWT, or a PEM block). It cannot be `PATH`, `HOME`, `LD_*`, `SOPS_*`, `AGE_*` or a proxy variable. `towercab repo set` refuses such a pair with the reason (LOOP-69); one already in the config is left out of the sandbox, and `towercab doctor` names it and the rule. Variables that fit stay allowed, for example `CARGO_TARGET_DIR` (PIP-95).
- Secret paths are not visible: `~/.ssh`, `~/.config/gh`, `~/.claude`, `~/.config/towercab` (the App key, secrets files), the other secret paths of PIP-24 and Towercab's home outside this mission. They are hidden by the tmpfs home and the masks, not by a permission the command could change.
- No credential helper, agent socket or `gh` login is reachable. The `claude` run keeps its own credentials only for the Claude process, never for the commands it starts (PIP-24).
- Verified by: `sandbox: a repo command sees no credential variable`, `sandbox: ssh keys and the app key are unreadable`, `sandbox: gh and claude credentials are unreadable`, `sandbox: a token-like repo variable name is left out`, `sandbox: a secret-looking repo variable value is left out`, `sandbox: a repo variable that fits the rule passes`, `sandbox: PATH and HOME cannot be set by a repo`

### PIP-160 · Escape attempts run in CI and all fail

A suite of real escape attempts runs in CI against the real sandbox, and every attempt must fail.

- Each attempt runs a command through the same builder as production (`sandboxArgv` and the Claude settings) and passes only if the attempt fails: reading `~/.ssh` and the App key, writing outside the checkout, writing into `<checkout>/.git`, reaching a host without a grant (direct, by IP, by a non-granted name, through a granted name that resolves to a private address), reading a secret environment variable and listing host processes (`/proc` shows only the sandbox's own). What the proxy refuses (a granted name that resolves to a private address, an IP literal, a port) is checked by its own tests (PIP-158).
- The suite is part of `npm run check` and of the CI workflow. Where bwrap is not installed, each attempt is skipped with the note `skipped: no bwrap`, so a local run still passes. The CI workflow installs bwrap and the AppArmor profile of PIP-162 and fails if bwrap is missing there, so the suite always runs in CI. A leak fails with the attempt and what it read or wrote.
- Verified by: `sandbox escape: ssh keys cannot be read`, `sandbox escape: the app key cannot be read`, `sandbox escape: a write outside the checkout fails`, `sandbox escape: a write into .git fails`, `sandbox escape: the network is unreachable without a grant`, `sandbox escape: secret variables are not set`, `sandbox escape: host processes are not visible`, `sandbox escape: without bwrap the attempts are skipped with a note`, `sandbox escape: CI installs bwrap and fails when it is missing`

### PIP-161 · No sandbox, no run

When the sandbox cannot start, the run stops as a fault; Towercab never falls back to running without it.

- A bwrap that is missing, refused (user namespaces denied) or that fails before the command starts is a fault ([LOOP-10](loop.md)) naming the reason, for setup, checks, e2e, proof and Claude runs alike. The Claude settings keep `failIfUnavailable: true` and `allowUnsandboxedCommands: false`.
- The fault text never tells the owner to set a config key or variable that loosens the sandbox (it replaces `set [agent] sandbox_unix_sockets = true`); where user namespaces are restricted it gives the profile fix of PIP-162, else "check bwrap".
- No config key, flag or retry path runs the command unsandboxed. A fault does not count as a repair round or a red check.
- Verified by: `sandbox: a missing bwrap is a fault, not a run`, `sandbox: a refused namespace is a fault, not a repair`, `sandbox: no path runs a command unsandboxed`, `sandbox: the fault text names no setting that loosens the sandbox`

### PIP-162 · It works on Ubuntu's restricted user namespaces

The sandbox runs on Ubuntu with unprivileged user namespaces restricted, without asking the owner to switch that protection off.

- Towercab never tells the owner to set `kernel.apparmor_restrict_unprivileged_userns=0` or `kernel.unprivileged_userns_clone`. Where the restriction blocks bwrap, `towercab doctor` and the fault of PIP-161 say it and give the narrow fix: an AppArmor profile that allows only the `bwrap` binary Towercab uses to create user namespaces.
- The self-test of PIP-163 runs the real argv, so a restricted host is found before a mission starts.
- The probe decides (PIP-163): a sandbox that works never gets a card, whatever files exist. When the probe fails, nothing is picked and no Claude run starts (a run asked for waits `fix sandbox`, stage `blocked`; a retry after the fix carries on). The text the owner sees is the probe's own error and, only if `kernel.apparmor_restrict_unprivileged_userns` is 1 and Towercab's profile (`/etc/apparmor.d/towercab-bwrap`) is not installed, the one step with the exact install command; `towercab doctor` shows the same step. Nothing is loosened to make a run work: Claude's own sandbox never gets `allowAllUnixSockets`, and the host's sockets stay hidden.
- Ubuntu's own profile for `bwrap` (`/etc/apparmor.d/bwrap-userns-restrict`, on by default from 24.10) lets bwrap start but refuses a user namespace to whatever bwrap starts. Claude's sandbox starts every shell command in one, so with that profile a worker has no shell and builds blind while Towercab's own checks still run. When the probe fails for this reason (PIP-163) with the restriction on and that profile active, the owner's step is to switch the stock profile off (a link in `/etc/apparmor.d/disable/` and `apparmor_parser -R`) and install Towercab's profile, as one set of commands; two profiles can't both own `bwrap`. The step still never touches the sysctl and never loosens Claude's sandbox.
- Verified by: `sandbox: a restricted user namespace gives the apparmor profile fix`, `sandbox: doctor never suggests turning the restriction off`, `hostcheck: a failed probe with the restriction on and no profile shows the install command`, `hostcheck: a working sandbox runs with the restriction on and no profile file`, `hostcheck: a failed probe otherwise shows the probe's error`, `hostcheck: a refused nested namespace with the stock profile shows the swap command`

### PIP-163 · The sandbox is tested at start

Towercab proves the sandbox holds on this machine before it runs a mission, and again in `doctor`.

- At service start and in `towercab doctor`, a probe runs through the production builder: a read of a planted canary outside the checkout fails, a write into `.git` fails, and a request without a grant fails, and a command inside can create a user namespace of its own (`unshare -Ur true`, skipped where `unshare` is missing), because Claude's sandbox needs that for every shell command a worker runs. A failed probe is a fault (PIP-161) and the loop takes no mission until the next successful probe.
- The probe's result and the bwrap version show in `doctor`.
- Verified by: `sandbox: the start probe passes on a sound sandbox`, `sandbox: a failed probe stops the loop taking missions`, `doctor: shows the sandbox probe`

### PIP-164 · Granted domains are the only widening, and are checked

The only thing a plan or a request can widen in a sandbox is a domain, and a domain that would open the whole internet is refused.

- A grant (plan Access section, mid-build request, an intent's `network` field, AUT-14) must be a host name or `*.<name>` with at least two labels. `*`, a bare TLD, `*.com`, an IP literal, a URL or a name with a port is refused with the reason; a plan with one waits for the owner as an invalid grant, and a mid-build request is refused without asking (AUT-27). A grant is added only from an approved plan, the intent or an owner's answer (AUT-15); a worker's request never adds one by itself.
- A path or test grant (REPO-8, PIP-151) never reaches the sandbox arguments beyond the checkout: protected paths stay inside the checkout, and `.git` stays read-only.
- Verified by: `sandbox: a wildcard or TLD grant is refused`, `sandbox: an IP literal grant is refused`, `sandbox: a path grant does not widen the mounts`

### PIP-130 · The design treats IDs of other open spec PRs as taken

Two open spec pull requests never get the same requirement numbers: the design leaves out every number another open one already added.

- Before the design runs, and again before it pushes a revision, Towercab lists the open spec PRs of the repo (head `towercab/*-spec` or any PR touching `specs/`), reads the requirement headings each one adds (`### <ID> ·` lines in its diff against the base branch), and puts them in the design prompt as taken, with the IDs already on the base branch.
- An ID the intent reserved is kept wherever it sits, gap or not, as long as nothing on `main` or in an open spec PR uses it (PIP-131). New IDs that are not reserved take the next free number after the highest taken one for the prefix. The design never renumbers a row that exists on `main` or in another PR.
- If a check finds that an ID this PR added is also added by another open spec PR, one of the two yields: the one that is not yet approved; if neither or both are approved, the later one. The yielding PR moves its own rows to free numbers and, in the same revision, updates every reference it owns to them (its plan, its PR body, its intent).
- If the open PRs cannot be listed (GitHub unreachable), spec writing goes on: the design is marked "IDs unchecked against open PRs", and Towercab lists the open PRs again before the spec PR is opened or updated. A clash found then is renumbered as above. The CI check (PIP-132) is the backstop.
- Verified by: `pipeline: design prompt lists IDs added by other open spec PRs`, `pipeline: second design takes the next free ID`, `pipeline: a reserved ID in a gap is kept when free`, `pipeline: the unapproved spec PR yields a clashing ID`, `pipeline: the later spec PR yields when both are unapproved`, `pipeline: a renumbering updates the plan and PR body in the same revision`, `pipeline: design goes on and is re-checked when open spec PRs cannot be listed`

### PIP-131 · Reserved IDs in an intent are checked when it is picked

An intent that names requirement numbers in advance gets different ones, written back to the intent, when they are taken.

- At pick, Towercab reads the IDs in the intent's `## Proposed outcome` (`spec IDs: PIP-130..132`, ranges and lists) and checks them against the base branch and the requirement IDs added by open spec PRs (PIP-130).
- A reserved range that sits in a gap is valid when nothing on `main` or in an open spec PR uses its IDs; it is never renumbered just for being in a gap.
- An ID is taken only when it exists on the base branch or in an open spec PR of another intent; an ID that is the intent's own (written by its own merged or open spec PR, or named by the intent file as already written) is never taken (PIP-202).
- A clash renumbers the whole reserved range to the next free numbers of the same prefix, keeping its length, and rewrites that line and any other mention of the old IDs in the intent through `setField`-style edits that leave other lines byte-identical; the new numbers are what the design gets as its reserved IDs.
- The change is committed to the intents repo like any intent edit (INT rules) and noted in the mission's log; nothing else in the intent changes. No clash → the intent is untouched.
- Verified by: `pipeline: reserved IDs that clash are renumbered at pick`, `pipeline: renumbered IDs are written back to the intent`, `pipeline: free reserved IDs leave the intent untouched`, `pipeline: a reserved range in a gap is not renumbered`

### PIP-132 · A check fails a spec PR that reuses a requirement ID

A pull request that adds a requirement ID already taken fails a check, so duplicates are caught without reading diffs.

- `towercab specs check-ids` (also run by `npm run check`) compares the requirement headings a PR adds with the base branch: an added `### <ID> ·` whose ID already exists there fails with the ID, the file and the reason. Repos that use this spec format run the same command in their CI.
- In Towercab's own CI the check also fails when an ID the PR adds is added by another open PR, naming that PR. It needs the PR list from GitHub, so it is skipped with a note where none is available (a fork, a local run).
- Moving or editing an existing heading is not an add; a heading that keeps `Removed: <why>` stays and its ID is still taken.
- Verified by: `specs: an added ID that exists on main fails the check`, `specs: an added ID that another open PR adds fails the check`, `specs: editing an existing requirement passes the check`, `specs: the open PR comparison is skipped without a PR list`

### PIP-119 · An outcome only the owner can do doesn't block approval

The review marks an outcome that only the owner can do as an owner step, and it no longer counts as
not met.

- `review.outcomes[]` gets `owner: bool`: true for an outcome no worker can do in the sandbox (adding
  a secret, applying to a server, a setting that needs admin rights). An outcome with `owner` true is
  not judged `met`; PIP-5's "every outcome met" reads "every outcome met or `owner`". The prompt
  (`agents/review.md`) says when to use it: only for what the worker cannot do, never for something
  it merely did badly or left out.
- Owner steps (the bullet and its `why`) are carried on the mission (`data.ownerSteps`), listed in the
  Review comment under "For you to do" and in the code PR body's checklist, and shown on the gate's
  wait. They never start a fix round and never make the gate wait by themselves. The gate still
  holds for its other reasons (PIP-7); a PR with owner steps is not marked as done work for them.
- PIP-5 still applies to every outcome the worker can meet: an outcome with `owner` false and `met`
  false blocks approval as before.
- Verified by: `pipeline: an owner-only outcome doesn't block approval`, `pipeline: an unmet outcome the worker can meet still blocks approval`, `pipeline: owner steps are listed for the owner`

### PIP-120 · A fix round starts only when the worker can change something

After a review that doesn't approve, Towercab sends the change back to build only when there is
something the worker can fix; otherwise it goes on to the gate.

- A fix round (PIP-98) starts when the review has at least one of: an important finding, weakened
  tests, a plan deviation (`plan_followed` false), or an outcome with `met` false and `owner` false.
  With none of these (so the only reason is an owner step, or `approved` false with nothing named),
  there is no fix round: `reviewFixes` is unchanged and the mission goes on to the gate with the owner
  steps listed (PIP-119). A review whose `approved` is false and names no such reason is treated as
  not approved at the gate (PIP-7), as before.
- The infra#50 case: the reviewer approves, one outcome is an owner step, every other outcome is met
  → approved, the mission goes to the gate, not to build, and no fix round is logged.
- Verified by: `pipeline: an approved review with an owner step goes to the gate, not to build`, `pipeline: a review with nothing the worker can fix gets no fix round`, `pipeline: an important finding still gets a fix round`

### PIP-121 · The Review comment says what Towercab does next

The verdict line of the Review comment always matches what Towercab does with the review.

- The verdict shown is computed from the same code as the decision (PIP-5, PIP-120), never copied
  from the agent's `approved` alone. Approved → `Approve`. A fix round → `Sending back for fixes
  (round <n> of 2)` followed by the reasons the worker can fix, in plain words. Not approved with no
  fix round (rounds used up, or nothing the worker can fix) → `Not approved` with the reason; the
  comment never shows `Approve` above a fix round.
- If the agent's `approved` differs from the computed verdict, the comment says which check
  overrode it, in plain words.
- Verified by: `pipeline: the review comment says a fix round is coming`, `pipeline: the review comment never approves above a fix round`, `pipeline: the review comment names the check that overrode the agent`

### PIP-165 · A spec settles after two rounds of answers

Once the owner has answered a spec PR twice, the design and the second reviewer stop raising new open points and decide them.

- A round is one owner answer on the spec PR that starts a design revision (PIP-97's `data.specAnswers`; Towercab's own conflict and red-check revisions don't count). Rounds = the number of kept answers.
- From the third design run on (rounds ≥ 2) the design prompt says: no new `open_questions` left unanswered, and each point it would have asked is decided with the conservative option (the one that is easiest to undo, changes least, or keeps today's behaviour). The result's `open_questions` then all carry an `answer`.
- Every such choice is listed in the spec PR body under `## Decisions`, one line each: the point, the option taken, and why it is the conservative one. The section is added by the design run in `pr`; the earlier rounds' entries are kept.
- This includes a point that contradicts an earlier owner answer: the design decides it, keeps the earlier answer where it can, and records the choice under `## Decisions`. It is not asked.
- At the spec gate the second reviewer's `open_points` (PIP-97) are dropped when rounds ≥ 2, apart from the unsafe gap in PIP-166: its prompt is told the spec is settled. The gate then decides on risk alone, and the spec PR body has no `## Open points for you` section.
- Verified by: `pipeline: a third design run after two answered rounds leaves no open points and lists its decisions`, `pipeline: a contradiction with an earlier answer after two rounds is decided and listed`, `pipeline: after two rounds the spec gate ignores new open points`, `pipeline: before two rounds open questions still go to the owner`

### PIP-166 · After two rounds only an unsafe gap can still be raised

After two rounds, the second reviewer may still raise a point when leaving it open would make the spec unsafe, and says so.

- Unsafe means a gap in security, a risk of data loss, or an irreversible action. A detail, a preference, an unclear intent or a contradiction with an earlier answer is not unsafe and follows PIP-165.
- The reviewer labels such a point `Unsafe:` with the kind (`security`, `data loss` or `irreversible action`) and why; `open_points` entries carry that label in `point`. An unlabelled point is dropped as in PIP-165. The design run itself never asks after two rounds, unsafe or not; it records how it covered the gap under `## Decisions`.
- A labelled point is an open point as PIP-97 describes: the spec gate waits for it and the spec PR body lists it under `## Open points for you`. It is the only kind the gate keeps after two rounds.
- Verified by: `pipeline: after two rounds the reviewer may still raise an unsafe gap, labelled`, `pipeline: after two rounds an unlabelled reviewer point is dropped`, `pipeline: the design never asks after two rounds, even for an unsafe gap`

### PIP-167 · A conflict where both sides only added is resolved by code

Before a conflict round goes to the worker, Towercab tries to merge the base into the PR by itself when both sides only added lines.

- Applies to every conflict round (PIP-134, PIP-31, PIP-22, and the merge of commits pushed to the PR in PIP-2), before the worker runs. Towercab merges `origin/<base>` into the checkout and looks at each conflict hunk.
- A hunk is additive when neither side removed or changed a line the other kept: relative to the merge base, each side only inserted lines. An additive hunk keeps both sides, ours (the PR's) first, then theirs (the base's).
- Two import lines from the same module (`import { a } from "./x.ts"` and `import { b } from "./x.ts"`) become one import with the names merged, sorted and without duplicates. Other import hunks keep both sides as above.
- A spec file's Status line (`**Status:** Live: …`) where both sides added IDs becomes one line: the `Live:` lists are united and ID ranges of one prefix are merged and sorted (`PIP-1..54, PIP-167` and `PIP-1..54, PIP-160..166` give `PIP-1..54, PIP-160..167`).
- If any hunk is not additive (one side deleted or edited a line the other kept), or the resolved tree fails the full checks of [repo.md](repo.md) (the repo's `checks` block, run as in PIP-23, not the `fast` subset), or the merge review of PIP-169 says a side was lost, the resolution is dropped without trace: the merge is aborted and the conflict round goes to the worker as before. No commit is pushed, and the failed attempt is not counted as one of the 2 automatic conflict rounds of PIP-134.
- Verified by: `pipeline: a conflict where both sides added imports is resolved without a worker`, `pipeline: a conflict where both sides added keys to a list is resolved without a worker`, `pipeline: a conflict where one side deleted a line goes to the worker`, `pipeline: a mechanical resolution that fails the full checks goes to the worker`, `pipeline: spec Status lines from both sides are merged`

### PIP-168 · A conflict that splits a block is resolved by applying the PR's own diff

When a conflict hunk cuts through a block (CSS rules, say), Towercab takes the base branch's file and applies the PR's own change to it.

- Applies per file, after PIP-167's hunk rule: a file where a hunk is not additive only because it splits a block, or where the hunk rule cannot decide, is resolved with the PR's diff for that file (merge base → PR head) applied onto the file as it is on `origin/<base>`. The patch must apply with no conflict and no fuzz (plain `git apply`, no three-way merge).
- Other files of the same merge keep the result of PIP-167. If the patch does not apply cleanly to any such file, or the result fails the full checks or the merge review (PIP-167, PIP-169), the whole attempt is dropped and the worker's conflict round runs as before.
- Only when the PR's own change to the file removes or edits no line: a PR that deleted a line the base kept always goes to the worker. The context of the patch is the check that the base's side did not change what the PR's lines sit next to.
- A file the base deleted or renamed is never resolved this way; it goes to the worker.
- Verified by: `pipeline: a conflict that splits a CSS block is resolved by applying the PR's diff`, `pipeline: a PR diff that does not apply cleanly goes to the worker`

### PIP-169 · The mechanical resolution is Towercab's own merge commit, reviewed only as a merge

A conflict that code resolved is committed as Towercab's merge commit, checked in full and reviewed for the merge alone, so the gate never reads it as someone else's work and the whole PR is not reviewed again.

- The commit is a merge of `origin/<base>` into the PR branch with Towercab's commit identity, the same as the worker's merge in a conflict round, and a message that says the base was merged and no files needed a worker. Both parents are kept; no force-push (PIP-2).
- The gate's check for someone else's commits (PIP-7) does not count this commit, nor the base commits it brings in. Publish then pushes it, the mission goes on to `ci` on the new head, and no worker round or fix round is used.
- The test lock of PIP-31 treats the files it changed as a merge of the base (PIP-153).
- Merge review: after the full checks pass and before the push, a read-only session of the review model (PIP-4) is given only the diff of the merge commit against its first parent (the PR head before the merge) and the hunks Towercab resolved. It answers one question: did the combination keep both sides, nothing lost and nothing duplicated? Its result is `kept_both` (boolean) and `lost` (what was dropped or doubled, with file). `kept_both` false → the attempt is dropped (PIP-167). The verdict is posted as a short comment on the PR, written for the owner (PIP-39).
- No full review follows: the review of the previous head (PIP-4) stands for the merge head, because the merge brings in no new content of the PR's own. The mission goes from the push to `ci`, and the review stage records the carried-over review instead of running again. The risk agent's assessment (PIP-96) is likewise carried over. A later push that changes the PR's own diff is reviewed in full as PIP-4 says. It stands only when that review is of the PR as it was just before the merge (the patch id of the PR's own diff against the merged-in base matches); an older review, from before a fix round, is not carried over and the PR is reviewed in full.
- Verified by: `pipeline: a mechanical merge commit is Towercab's own at the gate`, `pipeline: a mechanical resolution uses no worker round`, `pipeline: a mechanical merge is reviewed on its own diff only`, `pipeline: a merge review that finds a lost side goes to the worker`, `pipeline: a mechanical merge does not trigger a full review`, `pipeline: a review of an older head is not carried over a mechanical merge`

### PIP-170 · Every job in Towercab's CI has a time limit

A job in Towercab's own CI that hangs fails within minutes instead of holding up a pull request for hours.

- Every job in `.github/workflows/ci.yml` that runs steps sets `timeout-minutes`, sized to its normal run: 15 for `Playwright: UI screenshots` and `Node 22: lint, typecheck, tests`, 10 for every other such job, including `ci-ok`. GitHub's 6-hour default never applies to them.
- The jobs that call a shared workflow (`uses:`, PIP-90) set no limit and the test skips them; they rely on the cancel and rerun of PIP-171. A limit inside the shared workflows is a separate change in `MajidBabaeifar/ci`, not part of this requirement.
- A job that hits its limit ends as a failure; Towercab reads it as red (PIP-3) and the first-red rerun of PIP-18 takes over.
- Verified by: `public: every CI job that runs steps sets timeout-minutes`, `public: jobs that call a shared workflow are exempt from the limit`

### PIP-171 · A check that hangs is cancelled and rerun by Towercab, not left to the owner

On any repo, when a check stays pending past the CI wait, Towercab cancels that run and reruns it, and asks the owner only if the rerun hangs too.

- A check still pending past `ci_wait` (PIP-3) whose run is an Actions run (run ID from `detailsUrl`, PIP-18) is, once per head: recorded first, then `gh run cancel <run>`, and when the run has ended `gh run rerun <run> --failed`. This replaces the owner's ask for the first hang; no repair is counted and the run's timer (`ci_wait`) starts again from the rerun. The same applies to the spec PR's checks (PIP-82). Only `GitHubForge` builds these `gh` arguments (the owner allowed the cancel here; an agent session still may not cancel runs).
- The rerun pending past `ci_wait` again, a cancel or rerun that `gh` refuses, or a head that was already rerun for a red (PIP-18) → `waiting: CI stuck` (on a spec PR `waiting: approve spec`, PIP-82); the reason says the run hung twice, or why `gh` refused.
- A check that is not an Actions run is never cancelled or rerun: pending past `ci_wait` is stuck at once.
- A new head starts again with no run used.
- Verified by: `pipeline: a hung Actions run is cancelled and rerun once`, `pipeline: a rerun that hangs too waits for the owner`, `pipeline: a pending check that is not an Actions run is stuck at ci_wait`, `pipeline: a hung spec PR check is cancelled and rerun`

### PIP-172 · A spec that adds a spec file also links it from the README

When a spec PR adds a new spec file in a repo whose README indexes its specs, the design adds the link to that index too, so the repo's own docs check stays green.

- Applies when the design creates a `specs/*.md` that `main` does not have, and the repo's root `README.md` has a docs index: a Markdown table under a `## Docs` heading that links `specs/*.md` files (as Towercab's own PUB-4). No such table, or no new spec file → the design edits only `specs/**`, as PIP-25 says.
- The design's prompt says so when a new spec file is possible: add one row for each new, non-removed spec file to that table, in the table's own style (`| [specs/<name>.md](specs/<name>.md) | <what it covers> |`), and touch nothing else in `README.md`.
- Design guard: of `README.md`, Towercab keeps only changes inside the docs table (the rows of the table under `## Docs`; the rest of the file is byte-identical to base) and only when the diff adds a `specs/*.md` file. Any other change to `README.md`, or any other path outside `specs/`, is discarded as in PIP-25. Revisions (PIP-81, PIP-82, PIP-133) follow the same rule.
- Publish guard: the spec PR's diff may touch `specs/**` and, under the conditions above, the README's docs table; a README change outside the table fails the guard like any path outside `specs/`.
- The design's requirement IDs stay checked against `main` before publishing (PIP-80, PIP-130).
- Verified by: `pipeline: a design that adds a spec file may edit the README docs table`, `pipeline: the publish guard accepts the README docs table for a new spec file`, `pipeline: other README edits in a design are still refused`, `pipeline: a README docs table edit without a new spec file is refused`

### PIP-182 · Every Towercab comment names the agent and the intent

Each comment Towercab posts on GitHub says in its first visible line which agent wrote it and for which intent.

- Header: `**<Step>** · <agent> · <intent id> · round <n>`, for example `**Question** · designer · 261105-2152-9 · round 3`. The agent is one of `designer`, `planner`, `builder`, `reviewer`, `risk`, or `towercab` for a comment no agent wrote (Verify, Proof, CI, Gate, Access, merge notes). The agent follows the stage that wrote the text, as the agent table says (design, plan, worker and repair → `builder`, review, risk).
- This extends PIP-42: the hidden marker `<!-- towercab:<step>:<n> -->` and the edit-in-place rule do not change, and the intent id in the header is not part of the marker. A comment written before this change keeps its old header and is still found by its marker.
- Comments Towercab posts on a PR of any repo it works on, GitHub or GitLab (GL), carry the header; on GitLab the same text goes into the merge request note.
- Verified by: `github: stage comment names the agent and the intent`, `pipeline: question comment header carries the agent and intent`, `github: same step edits its comment`

### PIP-183 · Issue intake notes carry the same header and a marker

The notes Towercab writes on a GitHub issue (written up as an intent, queued, and the like) show the same header and a hidden marker, so they can be told from anyone else's.

- Every issue comment from the intake (INT-22 and the notes that follow it) starts with the hidden marker `<!-- towercab:intake:<n> -->`, then the header `**Intake** · scorer · <intent id> · round <n>` (before the intent exists, `#<issue number>` takes the place of the id). `<n>` says which note it is: 1 written up, 2 queued, 3 proposal closed, 4 scoring failed.
- Each note is written once, as today (the labels and the existing guards decide when); the marker makes a repeat of the same kind recognisable. Notes already on the issue are left as they are. On a GitLab issue the same text is posted as a note.
- Towercab's own notes never raise an event (PIP-44).
- Verified by: `github: an issue intake note has the header and marker`, `github: an intake note is written once`

### PIP-184 · Agents that act for the owner post through `towercab reply`

An agent session that speaks on GitHub as the owner posts through Towercab, which marks the comment as the agent's own.

- `towercab reply <intent id> --by <agent> "<text>"` posts `<text>` on the intent's current PR (or its issue when it has no PR yet) through the owner's login, as UI-66 does for the page. `--by` is required, a plain name of letters, digits and `-`, up to 32 characters (for example `claude-code`, `shadow`); a missing or invalid name, an unknown intent, a blank text or an intent with nowhere to comment is refused with the reason and nothing is posted.
- The comment's first visible line is `🤖 <agent> (for <owner>)`, where `<owner>` is the owner's first name from config, or their login when none is set; then a blank line and the text. A hidden marker `<!-- towercab:agent:<agent> -->` is on the line before it, so it is the first line of the body.
- The shadow's own comments (SHD-12) will carry the same marker with the name `shadow` when the shadow is built; the code here has no shadow yet, so nothing is done for it.
- The command is allowed on every intent, an `a0` one included: it only posts, and on an `a0` intent what it posts is ignored as input (PIP-185). The agents' tools and the sandbox's `gh` stay as they are (PIP-70): the rule is an instruction in the agent prompts and `prompts/writing.md`, which tell a session that talks on GitHub for the owner to use this command instead of `gh pr comment`. Blocking raw `gh` for such sessions is a later option (see Decisions).
- Readers of an answer (the yes/no and `allow` reading of PIP-138, PIP-141, and the feedback text of PIP-185) skip the leading agent lines: the marker, the `🤖 <agent> (for <owner>)` line and an older `[answered by … acting for the owner]` line. An agent's "Allow both." is read as an allow.
- Verified by: `cli: reply --by writes the first line and marker`, `cli: reply refuses a missing or invalid agent name`, `cli: reply works on an a0 intent`, `pipeline: an agent reply is read for its answer`

### PIP-185 · An agent's comment under the owner's login is recorded, and ignored on an a0 intent

A comment under the owner's login that carries the agent marker is recorded as an agent's; an `a0` intent ignores it, and on any other intent it still counts, shown as "agent for owner".

- A comment by `[github].me` whose first line is `<!-- towercab:agent:<name> -->` is an agent's comment. Towercab records it once per comment for the intent page (PIP-186), whatever the autonomy level.
- Intent at `a0` (AUT-31): the comment raises no event: it does not steer, answer, approve or retry, `/retry` inside it does nothing. It is noted once as AUT-32 says, with the same wording as other ignored replies, and never answers a wait.
- Intent at any other level: the comment is read as the owner's word as before (PIP-43, PIP-44), so it answers, steers or retries. Towercab keeps the agent's name with the event, so the Answer comment that says how the reply was read (PIP-140) starts with `Answered by <agent>, for the owner.`, and the card and the page show "agent for owner" (PIP-186). Which agent decided is visible and the work is not held up.
- A comment by `[github].me` without the marker counts as the owner's, as before. Towercab cannot tell an agent that posts with a raw `gh pr comment` from the owner, and this requirement does not claim to (see Decisions).
- At `a0` this includes the `allow <path>` reply of PIP-141: a marked one does not lift a refusal.
- Reviews with a state (Approve, Request changes) are always the owner's and are not affected.
- Verified by: `events: an agent-marked comment on an a0 intent is not an event`, `events: an agent-marked comment on another intent still counts and names the agent`, `events: an unmarked comment under the owner's login still counts`, `autonomy: an a0 mission ignores a marked agent reply`, `autonomy: an a0 mission does not let a marked agent reply lift a refusal`, `github: a stage comment says an agent answered for the owner`

### PIP-186 · The intent page shows which comments an agent wrote

The intent page lists the owner-account comments that agents wrote, so the owner can see what was said in their name.

- For each marked comment recorded by PIP-185 the page lists one line: the agent's name, a link to the PR it is on, the time, and the first 200 characters of its text. They are marked "agent, for you" in a section of their own, apart from the owner's own comments, and show whether the intent ignored them (`a0`) or acted on them.
- When a marked comment on a non-`a0` intent answered or steered it (PIP-185), the intent's card shows the tag "agent for owner" with the agent's name until the next owner or agent decision.
- `GET /api/intents/<id>` includes the comments as `agent_comments: [{agent, url, at, excerpt, acted_on}]` in time order, an empty list when there are none; the card's data (and the page's) has `decided_by_agent: <name>` when an agent answered for the owner, and no such key otherwise.
- Verified by: `ui: the intent page lists agent comments written under the owner's login`, `ui: the intent api returns agent comments`, `ui: a card shows agent for owner after an agent's answer`

### PIP-192 · A secret finding fixed in a later commit is ignored by fingerprint

When a secrets check fails only on commits older than the pull request's head, in test or fixture files, and the head no longer has the flagged text, the repair round is told to add exactly those findings to `.gitleaksignore`.

- Applies when every finding in the failed gitleaks job log (PIP-154, PIP-155) names a commit that is not the PR head, the file is a test or fixture path (PIP-196), and for each the flagged file at the head no longer holds the flagged line. Towercab checks the head with `git show <head>:<file>` through `Tools`, comparing the text of the finding's line in its own commit, never putting it in the details.
- The repair details then say that the findings are only in older commits and are already fixed at the head, and ask for one `.gitleaksignore` line per finding, copying each `Fingerprint` (`commit:file:rule:line`) as the log gives it. They ask for nothing else: no code change, no `paths`, `rules` or other broad allowlist (PUB-8).
- The details carry the fingerprints, file and line only, never the secret value (PIP-155).
- The path ignore round runs once per head. If the secrets check is still red on the new head, the next round is a normal repair (PIP-193's details).
- After the round, the new commit may be pushed only if it changes nothing but `.gitleaksignore`, by adding those fingerprints. Otherwise Towercab throws the round's changes away: it resets the branch to the head it had before the round, then runs the normal repair round (PIP-193's details), and pushes nothing from the discarded round.
- Verified by: `pipeline: a red secrets log whose finding commit is not the head and whose line is gone at head asks for one gitleaksignore line`, `pipeline: a secrets repair that changes more than the listed fingerprints is reset and repaired normally`, `pipeline: a secrets repair that only adds the listed fingerprints is pushed`, `pipeline: a second red secrets round after an ignore commit is a normal repair`

### PIP-193 · A secret finding still at the head is fixed in the code, never ignored

A finding whose text is still in the head, or one Towercab cannot place, is fixed in the code as before.

- If any finding is at the head commit, or its flagged line is still present in the file at the head, or the file or commit cannot be read, PIP-192 does not apply to the round: the details are the usual ones (PIP-154, PIP-155) and do not mention `.gitleaksignore`.
- Mixed findings (some old and fixed, some at the head) count as still present: the round fixes the code, and the old ones are handled by PIP-192 only after the head is clean.
- Verified by: `pipeline: a secrets finding still present at head is not offered for gitleaksignore`, `pipeline: a secrets log with a finding at the head asks for a code fix only`, `pipeline: an unreadable finding commit keeps the usual repair details`

### PIP-196 · An old finding outside tests and fixtures stops and asks the owner

An old secret finding in a file that is not a test or fixture is never ignored on its own: the mission asks the owner, because the value may be a real key that needs rotating.

- Test or fixture path: starts with `tests/`, `test/`, `__tests__/` or `fixtures/`, has a `/tests/`, `/test/`, `/__tests__/` or `/fixtures/` segment, or its file name matches `*.test.*` or `*.spec.*`. Nothing else counts (no `mocks/`, `examples/`, `docs/`).
- The path is taken as the log gives it and must have no `..` segment and no leading `/`; otherwise it is not a test path.
- When every finding is older than the head and its line is gone at the head (PIP-192's test), but any finding's file is not a test or fixture path, no repair round runs and nothing is added to `.gitleaksignore`. The mission waits for the owner, with the reason.
- The question names, for each finding, the rule, file, line and commit (never the value), says the value may be a real key that needs rotating, and offers the owner to rotate the key and then tell Towercab to ignore the fingerprint, or to fix it another way.
- A finding still at the head is not affected: it is fixed in the code (PIP-193).
- Verified by: `pipeline: an old finding outside tests asks the owner with rule, file, line and commit`, `pipeline: an old finding outside tests is not offered for gitleaksignore`, `pipeline: test and fixture paths are recognised`, `pipeline: a path with a parent segment is not a test path`

### PIP-197 · A change in a specialist area also gets a specialist review

A code PR that touches security or infrastructure files is also reviewed by a specialist for that
area, next to the general review, so the risky parts are read by someone who knows what to look for.

- Areas and the paths that call them in, matched by code on the PR's changed files, not by the agent.
  The shared default list holds generic patterns only. `Security`: any path with a `sandbox`, `auth`,
  `secret`, `token`, `credential`, `permission`, `crypto`, `session` or `password` segment or file-name
  word (broad on purpose: a missed security issue costs more than an extra run). `Infra`: `ansible/**`,
  `deploy/**`, `infra/**`, `terraform/**`, `Dockerfile*`, `docker-compose*`, `*.service`,
  `.github/workflows/**`. No file of Towercab itself is in the default.
- A repo adds its own paths per area in `REVIEW.md` under `## Specialist paths` ([REPO-42](repo.md)); they
  extend the default, never replace it. A path may call in both areas. No path matches → no specialist
  runs and the review is as in PIP-4.
- Each called-in specialist runs after the general review, on the same head and with the same inputs
  (intent, spec IDs, plan, diff, CI result, `REVIEW.md`), read-only and in a new session. Agents
  `review-security` and `review-infra` (`agents/*.md`, PIP-76) differ from `review` only in their
  brief: what to look for in that area.
- A specialist's result is kept with what it judged and reused while the diff's `git patch-id` is
  unchanged (as PIP-4). Its cost counts with the review's (MET-28).
- A specialist that fails to finish ends as any run does (PIP-24): the mission waits for the owner
  with the reason. It is not skipped.
- Verified by: `pipeline: a repo's specialist paths also call in a specialist`, `pipeline: a security change gets a security review`, `pipeline: an infra change gets an infra review`, `pipeline: a change outside the specialist areas gets only the general review`, `pipeline: specialist review reused for an unchanged diff`

### PIP-198 · Specialist findings follow the rules of the general review

A specialist reports only Important findings, never nits, and its findings count toward approval and
go back to the builder like any others.

- Schema `review` (PIP-5) is used unchanged. The specialist's prompt asks only for `important`
  findings, with `pass` set to `Security` or `Infra`; any `nit` it returns is dropped by code before
  the verdict. `REVIEW.md`'s `## What Important means here` applies to it too.
- The verdict (PIP-5) is computed over the general review and every specialist together: approved
  only when each is approved, and with no important finding from any of them. The specialist's
  `door` and `red_lines` are merged into the general review's (a one-way door from any wins).
- Its findings appear in the Review comment (PIP-42, PIP-92) under their pass, and a specialist that
  doesn't approve sends the change back to build in the same two fix rounds as PIP-98, not extra
  ones. The general review's and every specialist's findings go into the same round: one repair
  run with all of them as the details, then one new review pass (general and specialists) on the new diff.
- Verified by: `pipeline: specialist nits are dropped`, `pipeline: a specialist's important finding stops approval`, `pipeline: specialist findings go back to the builder in the same fix rounds`, `pipeline: both reviewers' findings go into one fix round`, `pipeline: review comment shows specialist findings under their pass`

### PIP-199 · A specialist review has the review's limits

A specialist review runs under the same limits and permissions as the general review, so an extra
reviewer cannot read more or spend more than the first.

- `agents/review-security.md` and `agents/review-infra.md` carry the front matter of `agents/review.md`
  (tools, `allow`, sandbox, model `review`, `session: new`, `timeout_min`, `max_cost_usd: 3`; PIP-94);
  `[agent].max_budget_usd` can only lower it (PIP-71).
- Both are listed in the agents table with the same permissions as `review`; this narrows nothing
  and gains nothing (PIP-77).
- Verified by: `agents: specialist reviews have the review's limits`

### PIP-194 · A plan that adds a wait lists the wait table in its access

When a plan adds an owner wait or a new question, it asks up front for the file that holds the wait
table, so the build does not stop to ask for it.

- A "new wait" is a `waiting:` text a handler can set that `WAITS` in `src/machine.ts` does not yet have
  (REPO-13's guard covers the file; AUT-15 is what the worker hit in 261105-2210 and 261105-2250).
  Each needs a `WAITS` entry (its stage and ask) and an `EXITS` entry (its exit kinds).
- The planner's agent file (`agents/plan.md`) tells it to check, for every wait or ask the plan adds,
  that `src/machine.ts` is in `access.paths`, with the `why` `wait table entries only`. A plan that
  also changes transitions or `apply` lists the file with a `why` that says so instead.
- PIP-115's rules apply unchanged: the owner can untick the box, and an unticked path is not granted.
- Verified by: `pipeline: plan prompt tells the planner to list the wait table for a new wait`, `pipeline: plan access lists the wait table with a wait table reason`

### PIP-195 · A wait table edit is covered by a plan that adds a wait

Removed: the owner decided that an edit to `src/machine.ts` the plan did not list still waits for the
owner as unplanned access (AUT-15), even when it only adds wait table entries. PIP-194 is the whole
fix: the plan lists the file up front.

### PIP-200 · Stage tests use a fake forge, not fake `gh` command lines

The tests of the pipeline stages and the loop check what a stage asks the code host to do through a fake `Forge`, so they do not depend on how `GitHubForge` words its `gh` commands.

- `FakeForge` (`tests/helpers/fake-forge.ts`) implements all of `Forge` (every host read and write) in memory: it records each call by method and arguments and answers from the test's setup. Tests that need a host failure make a method throw.
- Tests under `tests/pipeline/` and the loop tests build their `Ctx` with `FakeForge`; none of them registers a `gh` command line on `FakeTools` or builds a `GitHubForge`.
- `gh` command lines are faked only in the tests of `GitHubForge` and of `src/github/` itself, and in tests of code that still calls `GitHub` directly (settings, releases, secrets, readiness) until it moves behind `Forge`.
- A guard test fails when a file under `tests/pipeline/` mentions a `gh` argument list (an `args` check for `"gh"`, `"pr"`, `"api"` or `"run"` handed to `FakeTools`) or imports `GitHubForge`.
- Behaviour does not change: every stage test keeps its title and asserts the same outcome.
- Verified by: `forge: stage tests hold no fake gh command lines`, `forge: FakeForge records calls and answers from setup`, `forge: FakeForge fails a method on request`

### PIP-201 · Stages reach the code host only through `Forge`

A stage can only call the code host through the `Forge` interface; the raw `gh` calls are not within its reach.

- `Ctx.github` is typed `Forge`, not `Forge & GitHub`; the `Host` type is removed from the stage contract (`src/handlers.ts`). The loop keeps the concrete object that is both, and gives stages only its `Forge` side.
- A stage that today calls `gh`, `owner`, `gitAuth` or `bot` through `Ctx.github` reaches the same result through a `Forge` method (a new method where none fits), built by `GitHubForge` alone.
- The code that still needs the raw calls (settings, releases, secrets, readiness) takes a separate `GitHub` dependency from the loop, not from `Ctx`.
- `npm run typecheck` fails when a stage reads a `GitHub` member from `Ctx.github`.
- Verified by: `forge: Ctx.github is a Forge and nothing more`, `forge: stages make the same host calls through Forge`

### PIP-202 · An intent's own spec rows are never renumbered

Towercab never moves an ID that is the intent's own: one its own spec pull request wrote (merged or open), or one the intent file itself names as already written.

- At pick (PIP-131) and in the checks before the design runs and before it publishes (PIP-130), a reserved ID is counted as taken only if it exists on the base branch or is added by an open spec PR of another intent, and is not the intent's own.
- An ID is the intent's own when either holds: (a) its row on the base branch, or in an open spec PR, was added by a spec PR of this intent; or (b) the intent file names it as already written (for example "already written; make them Live"). A spec PR belongs to the intent when its head branch starts with `towercab/<intent id>-`, ends with `-spec`, and the segment right after the prefix is not a bare number (the real form is `towercab/<intent id>-<short title>-spec`; the shorter `towercab/<intent id>-spec` also matches). A bare number there marks a sibling intent: `towercab/261105-2152-2-…-spec` does not belong to `261105-2152`. For a merged PR, the IDs are the `### <ID> ·` headings its merge adds.
- An own ID on the base branch stays as written, and the design gets it as an existing row to build or make Live, not as a new one. An open spec PR of the same intent never makes its own IDs a clash.
- A reserved ID whose rows on the base branch belong to another intent, or to no intent (no matching spec PR and not named as already written by the intent), is still moved by PIP-131. Narrowed by PIP-210: when the intent's spec-IDs line words an ID as existing ("made true as written", "changed"), it is a reference and is not moved.
- If the merged spec PRs cannot be read, the reserved IDs are left unmoved except those that exist on the base branch with no own-ID evidence from the intent file; the mission's log notes "IDs unchecked against merged spec PRs", and PIP-132 stays the backstop.
- Verified by: `pipeline: reserved IDs from the intent's own merged spec PR are kept`, `pipeline: reserved IDs from the intent's own open spec PR are kept`, `pipeline: reserved IDs the intent names as already written are kept`, `pipeline: a spec PR head is matched by the intent id prefix and the -spec suffix`, `pipeline: a sibling intent's spec PR head is not matched`, `pipeline: reserved IDs that belong to another intent's rows are still moved`, `pipeline: reserved IDs on main that belong to no intent are still moved`, `pipeline: unreadable merged spec PRs leave reserved IDs unmoved`

### PIP-203 · A revision started by the owner's comment is answered with a reply

When a design, plan or build revision answers the owner's comments, the worker also writes a reply to them.

- The result of a revision that the owner's feedback started (PIP-25, PIP-43; on the spec, plan or code PR) gains `reply`: Markdown written by the worker (PIP-40), asked for in the prompt and required in that run's result schema (no other run's schema has it). A revision that changes nothing is asked to return one saying `Nothing to change: <why>`, and it is posted (PIP-204).
- A missing, empty or unreadable `reply` never blocks, fails, repeats or delays the revision: the revision is applied and pushed as if the reply were there, and Towercab posts a generic reply in its place: `Revised in <short commit sha>`, the list of files the revision changed (at most 20, then "and <n> more"), and the line `Generated by Towercab: the worker wrote no reply.` It is built by code from facts it owns (PIP-40) and posted and threaded like a written reply (PIP-204). When nothing changed, it says `No files changed.` Towercab never starts another revision to get a better reply. The reply is not asked for on a revision Towercab started itself (red checks PIP-82, conflicts PIP-81, review or gate fixes, repairs) nor on a first run.
- The prompt lists each comment of the feedback with its id, so the reply can answer them one by one (PIP-205). The PR description is still rewritten as before (PIP-48); `reply` is in addition.
- Verified by: `pipeline: a feedback revision asks for a reply`, `pipeline: a missing reply gets a generic one with files and commit`, `pipeline: the generic reply is marked generated`, `pipeline: a missing reply never blocks or repeats a revision`, `pipeline: a revision Towercab started needs no reply`, `pipeline: a revision that changes nothing still replies`, `pipeline: the feedback prompt lists each comment with its id`

### PIP-204 · The reply is one PR comment, with a pointer in each line thread

Towercab posts the reply as one general comment on the PR the revision changed, and adds a one-line pointer in each line thread it answers, so no thread looks ignored.

- Posted by `Forge` after the revision's commit is pushed. The general comment is a new PR comment that names the agent and answers every comment of the revision, quoting or linking each one (PIP-205). It is the only place the full reply is written.
- For each owner comment of the revision that is a line comment or part of a review thread, `Forge` also posts a threaded reply in that thread: `Answered in <link to the general comment>`. Plain PR comments and review bodies (Approve or Request changes) cannot be threaded, so they get no pointer; the general comment quotes and links them.
- The general comment has the header `**Reply** · <agent> · <intent> · round <n>` (PIP-182) and the marker `<!-- towercab:reply:<n> -->`, as PIP-42; the pointers carry the header and the marker `<!-- towercab:reply-pointer:<n>:<comment id> -->`. The same round edits its general comment and its pointers instead of adding more. Nothing is posted before the commit it describes. Pointers are posted after the general comment, since they link to it.
- A host failure while posting the general comment is retried on the next pass, up to 3 posts in all, then the reply is given up and logged; it never loses the revision or sends the mission back. A pointer that fails is logged and does not hold back the general comment. A host whose `Forge` has no `replyInThread` gets no pointers.
- Verified by: `github: the reply is one general comment with header and marker`, `github: a line comment gets an answered-in pointer in its thread`, `github: a plain comment gets no pointer and is quoted`, `pipeline: the reply is posted after the revision is pushed`, `pipeline: a failed reply post is retried`, `pipeline: a failed pointer does not hold back the reply`

### PIP-205 · What the reply says

The reply tells the owner, in plain words, how Towercab read the comment, what it changed or left alone, and what is still open.

- Written to `prompts/writing.md`: the outcome first; no step names, field names or other internal terms. Parts: how the comment was read; what changed in the PR (and what was not changed and why); new or still-open questions and points, each with a recommendation, or one line saying nothing is open.
- Each comment of the revision gets its own part, quoted or linked (PIP-204), so that several comments handled in one revision get one reply that answers each of them (PIP-203). A comment the worker did not act on is still answered, with the reason.
- A comment that needs no change is answered briefly in the form `Nothing to change: <why>`, so silence never reads as ignored.
- `agents/design.md`, `agents/plan.md`, `agents/worker.md` and `agents/repair.md` carry these rules for a feedback revision, and the revision prompt repeats them beside the list of comments.
- Verified by: `prompts: revision prompts ask for a reply that answers each comment`, `prompts: the reply rules follow the writing guide`, `prompts: a comment needing no change is answered Nothing to change`

### PIP-206 · A reply is not feedback and does not replace the description

Towercab's replies never start a revision, and the PR description is kept up to date as before.

- A reply is a comment of the App's bot, so it never raises an event (PIP-42, PIP-44), including in a thread under the owner's comment, and never moves `feedback_seen`.
- The PR description is rewritten by every revision as today (PIP-48); a reply does not stand in for it.
- Verified by: `events: a reply under the owner's comment raises no event`, `pipeline: a revision still rewrites the PR description`

### PIP-207 · One reply per revision, even when handled together

Several comments taken in one revision, and a comment arriving while a reply is posted, never produce two replies for the same revision.

- A revision takes every unseen owner comment on the PR (PIP-44) and returns one `reply` for them. The reply is posted once per revision round (PIP-204). A comment that arrives after the revision started waits for the next revision and gets its own reply then.
- Verified by: `pipeline: several comments get one reply that answers each`, `pipeline: a comment that arrives during a revision gets the next reply`

### PIP-208 · An outcome the owner deferred counts as met

An outcome the owner has put off to another intent is not held against the code PR, so it never overrides a reviewer's Approve.

- An outcome is deferred in exactly three ways, and nothing else defers one:
  (a) an owner comment or answer on the intent or its PRs has a line that starts with `defer`, names the outcome, and names an intent id, for example `defer "Stage tests use a FakeForge" to 261105-2120`. The outcome is named by its text in quotes (matched to a `Proposed outcome` bullet or a spec row name, ignoring case and surrounding space) or by its number (`defer 3 to 261105-2120`, the bullet's position, counting from 1);
  (b) the intent file marks the bullet `deferred: <intent id>`;
  (c) the plan (the plan PR's text) has its own line in the same strict form as (a): `defer "<outcome>" to <intent id>` or `defer <number> to <intent id>`. Merging the plan PR approves that line. Loose wording in a plan ("for a later slice", "follow-up") defers nothing, and a plan line in a plan PR that is not merged defers nothing.
  A line in any other wording is not a deferral, however clear it reads to a person. An agent's comment (PIP-182) or a non-owner never defers an outcome in (a). The named intent must exist in the intents repo; otherwise the outcome stays as judged.
- `review.outcomes[]` gets no new key: Towercab sets `met` true for a deferred outcome after the review returns, and keeps the follow-up id and the reason on the mission (`data.deferred`). PIP-5's "every outcome met" and PIP-120's fix-round test then read it as met, so a deferred outcome starts no fix round.
- The prompt (`agents/review.md`) lists the deferred outcomes as data and says not to judge them; a review that marks one `met` false is overridden as above.
- Verified by: `pipeline: a deferred outcome does not override an Approve`, `pipeline: an outcome marked deferred in the intent counts as met`, `pipeline: a defer line naming an outcome by its quoted text defers it`, `pipeline: a defer line naming an outcome by its number defers it`, `pipeline: a comment not in the defer form defers nothing`, `pipeline: a defer line in the plan defers the outcome`, `pipeline: loose wording in a plan defers nothing`, `pipeline: a defer line in an unmerged plan defers nothing`, `pipeline: a deferral by an agent or a non-owner is ignored`, `pipeline: a deferral to an unknown intent is ignored`, `pipeline: a deferred outcome starts no fix round`

### PIP-209 · A deferred outcome is shown, not hidden

Deferred outcomes are listed in the review comment and the code PR body with the intent they moved to.

- The Review comment and the code PR's description (PIP-48) carry a "Deferred" list: the bullet, the follow-up intent id and who deferred it. Absent when nothing is deferred.
- The verdict line (PIP-121) names the deferral: an Approve that stands because of one says so.
- Verified by: `pipeline: the review comment lists deferred outcomes`, `pipeline: the PR body lists deferred outcomes`

### PIP-210 · An ID the intent says exists on main is a reference and is never moved

Towercab leaves alone an ID that the intent's own wording says already exists, even when the row on `main` was written by another intent; any other ID that is already on `main` is a clash and is moved.

- The signal is the wording of the intent's spec-IDs line (the `spec IDs:` line of `## Proposed outcome`, PIP-131). An ID or range on that line is a reference when the words attached to it say the row exists: "as written" (as in "made true as written" or "met as written"), "already written", "changed", "exists", or "existing" (case-insensitive), or it is named as an existing row. The wording covers the IDs it is attached to: the list or range it ends, up to the next `;` or sentence end.
- A reference is never renumbered, whichever intent or spec PR wrote its row and even when an open spec PR of another intent adds the same ID. It needs a row on the base branch to be a reference; a reference with no row there is treated as a reservation.
- An ID on that line with no such wording is a reservation. If a row with that ID already exists on the base branch, that is a collision and it is moved to the next free numbers of the same prefix as PIP-131 does today; an ID that does not exist on `main` is moved only when an open spec PR of another intent adds it (PIP-130).
- A line that mixes both is split by its wording: references stay, reservations are checked and moved as above. The design gets the references as existing rows to build or make Live, and the reservations as new rows.
- The own-ID rules of PIP-202 stay as they are (an intent's own rows are kept without any wording); the line of PIP-202 on rows of another intent is narrowed by this row.
- If the base branch cannot be read, no ID is moved, the mission's log notes "IDs unchecked against main", and PIP-132 stays the backstop.
- Verified by: `pipeline: reserved IDs the intent words as made true as written are kept`, `pipeline: reserved IDs the intent words as already written or changed are kept`, `pipeline: an ID on main with no reference wording is moved as a collision`, `pipeline: a reference is kept when an open spec PR adds it too`, `pipeline: a reserved ID another open spec PR claims is still moved`, `pipeline: a line of references and reservations is split by its wording`, `pipeline: a reference with no row on main is treated as a reservation`, `pipeline: an unreadable base branch leaves reserved IDs unmoved`

### PIP-211 · A setup-only secrets file per repo

A repo that installs from a private package registry can have a file of secrets, in the config folder, that only its setup commands use.

- `<config dir>/setup-secrets/<repo>.env` (default `~/.config/towercab/setup-secrets/<repo>.env`): `KEY=VALUE` lines, `#` comments and blank lines skipped, the first `=` splits, no quoting or expansion. It is a different file from the e2e secrets of [SHIP-2](ship.md); a key in one is never given to the other's commands. No file = no setup secrets.
- A line that is not `KEY=VALUE`, or a key that is not `[A-Za-z_][A-Za-z0-9_]*`, makes the stage wait on `fix repo files` with "<path> line <n> is not KEY=VALUE" (the line's text is not quoted). A key that is `PATH`, `HOME`, `LD_*`, a proxy variable (PIP-158) or a cache variable (LOOP-34) is refused the same way.
- Any group or other permission bit set → the stage waits on `fix repo files` with "<path> is readable by others; chmod 600 it", as for SHIP-2. The check runs each time the file is read, before setup starts.
- Unlike the repo's named variables (PIP-159), a setup secret may have a token-like name (`NPM_TOKEN`, `PIP_INDEX_URL`, `CI_JOB_TOKEN`) and any value: the point is to hold a token.
- The value is the token alone, never a URL or a header: a value that contains `://`, whitespace or a quote makes the stage wait on `fix repo files` with "<path>: <KEY> must hold the token only". A repo's setup commands build any URL or auth line from the variable (`//registry.example.com/:_authToken=${NPM_TOKEN}`), so Towercab knows exactly what to hide.
- A token shorter than 8 characters is refused: the stage waits on `fix repo files` with "<path>: <KEY> is shorter than 8 characters" (never the value). So every secret value is long enough to be redacted (PIP-213).
- A token can have a username, declared in the same file as a second line `<KEY>_USERNAME=<name>` next to it (for example `NPM_TOKEN` and `NPM_TOKEN_USERNAME`). The username is set in the setup environment like any other line, is not a secret and has no length rule. A `<KEY>_USERNAME` line with no `<KEY>` line is not a token pair and is read as an ordinary secret line.
- Whether to add the registry host to the repo's network list is the owner's choice: nothing is added on its own. A host beyond the built-in registry list comes from a plan grant, the intent's `network` field or an owner's answer ([AUT-14, AUT-26](autonomy.md)).
- Not in this requirement: a per-repo `.npmrc` or `pip.conf` mounted into the setup home. A repo that needs one commits an `.npmrc` that reads `${NPM_TOKEN}`, or its setup line writes the file into the setup credentials folder (PIP-212), which is empty at the start and deleted after setup.
- Verified by: `pipeline: a setup secret that holds a url is refused`, `pipeline: setup secrets file must be private`, `pipeline: a malformed setup secrets line waits on fix repo files`, `pipeline: a setup secret may have a token-like name`, `pipeline: no setup secrets file means no setup secrets`, `pipeline: a setup token shorter than 8 characters is refused`, `pipeline: a setup token username is read from the line next to it`

### PIP-212 · Setup secrets reach only the setup commands

The values of a repo's setup secrets are in the environment of its setup commands and nowhere else.

- The values are added to the environment of the ` ```setup ` commands run by verify ([PIP-23](pipeline.md)) and by any other stage that runs the repo's setup (proof, screenshots, e2e preparation), on top of the allowlist of PIP-159. They are never in the environment of a check, an e2e suite, an adapter command, a Claude run (worker, repair, review or any other agent), the guard hook or a hook of Towercab.
- They are never written into a prompt, a plan, a spec, a PR title or body, a comment, a question, a Telegram or UI message, a finding, a stored run record or the intent file. Setup secrets stay out of the mission's database: only the file path and the key names are recorded.
- Each setup run gets its own empty **credentials folder**, `<work>/setup-creds/` (outside the checkout), bound writable into the setup sandbox only. Setup is told to use it for registry credentials: `NPM_CONFIG_USERCONFIG=<creds>/npmrc`, `PIP_CONFIG_FILE=<creds>/pip.conf`, `XDG_CONFIG_HOME=<creds>/xdg`, `POETRY_CONFIG_DIR=<creds>/poetry` (set only when the repo has a setup secrets file, after the variables of PIP-159). The folder is never bound into a check, e2e, proof, screenshot or Claude run, and is deleted after the scan below, hit or not. The sandbox home stays an empty tmpfs (PIP-23). The credential masks of the sandbox stay in force ([PIP-159](pipeline.md)); `<config dir>/setup-secrets/` is hidden like the rest of `~/.config/towercab`.
- For a repo with a setup secrets file, the shared download cache (LOOP-34) is read-only for the worker and its repair rounds, as it already is for checks; setup still writes it. The owner's allowance of PIP-95 does not lift this for such a repo. A repo without a setup secrets file keeps today's rules.
- Right after every setup run, before any worker, repair or check starts in that checkout, Towercab scans for each setup token and its encoded forms (PIP-213): every file of the pass-1 tree (`setup-tree/`, PIP-214), ignored output included, and, as a second guard, every file of the worker's checkout; the small git files of the checkout's `.git` (`config`, `config.worktree`, `info/*`, `hooks/*`, `modules/*/config`, never `objects/` or packs); the whole credentials folder; and, in the shared cache, only files created or changed during this setup run and no larger than 256 KiB (the cache is not scanned in full). It is a literal search for the known values, run by Towercab, because a generic scanner does not know them. A hit stops the stage: the mission waits for the owner with one line, "setup left a secret in <path> (<KEY>)", naming the file (for the credentials folder, `setup-creds/<name>`) and the key, never the value or the line. No repair round runs and the worker never starts; the line is posted without the value as everywhere else (PIP-213).
- Setup with secrets never runs code the branch controls: it follows PIP-214, runs its first pass in a clean copy outside the checkout, and the scan above runs after that pass, before anything is copied into the checkout.
- Setup runs again, and the scan with it, on the owner's next resume. A file in the shared cache that is changed during setup but larger than 256 KiB is not read; that gap is known and is named in the PR's concerns.
- Verified by: `pipeline: setup gets its own empty credentials folder`, `pipeline: the credentials folder is not bound into the worker or the checks`, `pipeline: the shared cache is read-only for the worker when the repo has setup secrets`, `pipeline: a setup secret in git config stops the stage`, `pipeline: a setup secret in the credentials folder stops the stage`, `pipeline: a setup secret in a changed cache file stops the stage`, `pipeline: git objects are not scanned`, `pipeline: setup secrets are set for setup commands only`, `pipeline: the worker environment never holds a setup secret`, `pipeline: a check and an e2e suite do not see setup secrets`, `pipeline: no prompt or PR text holds a setup secret`, `pipeline: the setup secrets directory is unreadable in the sandbox`, `pipeline: a setup secret left in the checkout stops the stage before the worker`, `pipeline: the setup secret scan names the file and key and not the value`, `pipeline: the setup secret scan covers ignored files`, `pipeline: a clean checkout after setup lets the worker start`

### PIP-213 · Setup secret values are redacted from every log

Wherever Towercab keeps or shows output from a setup command, each setup secret value shows as `[redacted]`.

- Every setup token (all are 8 or more characters, PIP-211) is replaced with `[redacted]`, in the verify log, the repair details, the mission's log and error messages, the UI, the API and Telegram messages, before the text is stored or sent. Redaction runs on the raw output, so a value split across two reads of the same stream is still covered.
- The token is hidden wherever it appears: in output text, in a line written to the mission's log, in a message, in the scan result (PIP-212) and in any error text, not only in the setup log.
- Each token is also replaced in its encodings: URL-encoded (percent-encoding, upper- and lower-case hex) and base64 (standard and URL-safe, with and without padding, and at each of the three alignments a token can have inside a longer base64 string).
- When a token has a username (PIP-211), the HTTP Basic-auth value built from `<username>:<token>` is replaced too, as base64 in the same forms, in the `Authorization: Basic <value>` header and bare. The username alone is not redacted.
- The failed-setup retry (PIP-23) and the repair round use the redacted log only; the redacted log is also what the worker reads if setup is red.
- Verified by: `pipeline: setup secrets are redacted from the verify log`, `pipeline: a redacted setup log is what the repair round gets`, `pipeline: a url-encoded setup secret is redacted`, `pipeline: a base64 setup secret is redacted in every alignment`, `pipeline: a basic-auth header built from the username and token is redacted`, `pipeline: a setup username alone is not redacted`, `pipeline: a setup secret split across output chunks is redacted`

### PIP-214 · Setup with secrets never runs the branch's code

When a repo has setup secrets, the token is used only to install what the main branch already lists, with install scripts off; whatever the branch changed installs afterwards without any secret.

- **Pass 1, with secrets, in a separate clean copy.** The repo's ` ```setup ` lines (the base branch's, PIP-23) run with the setup secrets (PIP-212) in `<work>/setup-tree/`, a fresh export of the **base commit's tree** (`git archive <base commit>`, no `.git`, no ignored folder, nothing the worker or the branch wrote), made new for every pass and never reused. The sandbox binds it at the checkout's own path, so absolute paths in the install output (a virtualenv, a `.bin` link) are the same in the worker's checkout. So manifests, lockfiles, `.npmrc`, `pip.conf` and every script the setup lines call are main's, never the branch's, and the worker's checkout is not mounted in this pass at all.
- **System tools only.** In pass 1 `PATH` is the sandbox's system directories alone (PIP-159): never `node_modules/.bin`, a project virtualenv (`.venv/bin`, `venv/bin`), `./`, `~/.local/bin` or any directory of the checkout. Tools the install itself puts in `setup-tree/node_modules/.bin` come from main's own manifests, so they may run from inside that tree only.
- **Copy out.** After pass 1 and a clean scan (PIP-212), its install output is copied into the worker's checkout: only the paths in `setup-tree/` that are untracked in main's tree and ignored by main's `.gitignore` (such as `node_modules` or `.venv`), at the same relative paths, with links kept as links, modes kept and setuid/setgid bits cleared, and the setup credentials folder, `setup-tree/.git` and the scan files never copied. The copy never overwrites or deletes a file the branch tracks. Any other file pass 1 created (untracked and not ignored) is not copied and is named in the verify log. A scan hit means nothing is copied. The checkout never held a secret, because the secret pass never ran in it.
- **Scripts off.** Pass 1 sets, after and over every repo variable: `npm_config_ignore_scripts=true` (npm, pnpm, yarn 1), `YARN_ENABLE_SCRIPTS=false`, `PIP_ONLY_BINARY=:all:` and `UV_NO_BUILD=1`, so no lifecycle script (`preinstall`, `install`, `postinstall`, `prepare`) and no source build runs. If a setup line uses a tool with no such switch (`cargo`, `go`, `bundle`, `gem`, `make`, `mvn`, `gradle`, read as a command word), pass 1 does not run: the stage waits on `fix repo files` with "setup secrets cannot be used with <tool>: its install scripts cannot be turned off".
- **Pass 2, without secrets.** If the branch head differs from the base commit in a manifest or lockfile (`package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `.yarnrc.yml`, `.npmrc`, `requirements*.txt`, `constraints*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`, `Pipfile`, `Pipfile.lock`, `pip.conf`, `setup.py`, `setup.cfg`; at any depth, added, changed or deleted), the same setup lines run once more in the worker's checkout (after the copy above, with the usual `PATH`) with no setup secret, no credentials folder and only the built-in registry list (PIP-158; plan grants and the intent's `network` are not given), as setup runs today otherwise. Install scripts run as they would without secrets; there is nothing for them to read.
- A pass 2 that fails because it needs something private (the proxy refused a host, PIP-158, or the log shows 401, 403, `E404` or `Unauthorized` for a registry) is not a repair round: the mission asks the owner, naming the changed files and the refused host, "The change updates packages that need the private registry. Add them on the main branch first, or change the manifests to public packages?". Any other pass 2 failure is red as usual (PIP-23).
- No change to a manifest or lockfile → no pass 2. A repo with no setup secrets file runs setup once, as today.
- Verified by: `pipeline: setup with secrets runs on a fresh export of the base commit's tree`, `pipeline: the secret pass does not mount the worker's checkout`, `pipeline: the secret pass binds its tree at the checkout path`, `pipeline: a branch that plants a fake node_modules bin tool does not run it in the secret pass`, `pipeline: the secret pass path is the system directories only`, `pipeline: install output is copied into the checkout after a clean scan`, `pipeline: only ignored untracked output is copied`, `pipeline: a scan hit copies nothing`, `pipeline: the copy never overwrites a tracked file`, `pipeline: the copy clears setuid bits and keeps links as links`, `pipeline: a branch that adds a postinstall script does not run it in the secret pass`, `pipeline: a branch that adds a postinstall script runs it in pass 2 with no secret in its environment`, `pipeline: a branch that changes a script the setup calls does not run it with the secret`, `pipeline: install scripts are switched off in the secret pass`, `pipeline: a setup tool with no scripts switch is refused with secrets`, `pipeline: a branch that changes a manifest gets a second pass without secrets`, `pipeline: an unchanged manifest gets no second pass`, `pipeline: the second pass gets no plan grant and no credentials folder`, `pipeline: a second pass that needs a private package asks the owner`, `pipeline: a second pass that fails otherwise is red`, `pipeline: a repo without setup secrets runs setup once`

### PIP-215 · Spec rows that say parked cite a parked intent

A spec row that says it is removed because something is parked must name that parked intent, and the specs README lists which intents are still parked, so a row cannot go on calling a built feature parked.

- `specs/README.md` holds a `## Parked` table: one row per parked intent, its ID (`YYMMDD-HHMM-N`) in the first column and one line on what it holds in the second.
- The check reads every `specs/*.md` row, removed ones included, and ignores the Status line. A row's text is its heading's section, and the README's own table is not checked.
- It applies only to a sentence that calls something removed, parked or deferred: one with `parked`, `deferred` or `Removed:` followed by `parked`/`deferred`, such as `parked as`, `parked with`, `is parked`, `are parked`, `stays parked`, `(parked)` or `parked in intent`. The priority cutoff's parked state (PRI-5), the UI's Parked list and a `parked` priority state are not that and are left alone. A sentence that cites an intent only as an origin or an example (it says `replaces`, `replaced`, `e.g.` or `for example`) is left alone too.
- A checked sentence with no intent ID fails: `<ID>: says parked without an intent id`. An intent ID in it that is not in the Parked table fails: `<ID>: cites <intent id>, which is not parked`. A `Removed: replaced by <ID>` row (or `superseded by`) whose `<ID>` is not a heading in any spec file fails: `<ID>: replaced by <other>, which does not exist`.
- Taking an intent's ID out of the Parked table when its feature is built makes the check list every row that still cites it, so none is left calling it parked.
- The initial Parked table holds the intents still open and parked: 261026-2204-3 (only the part that turns review findings into intents and feeds a repo's `CLAUDE.md`; its issue intake is built), 261026-2204-5, 261030-0401-2 and 261030-0401-3. 261026-2204-2 is closed and is not listed.
- The build that adds the check also fixes every row it flags, so the check starts green: rows citing 261026-2204-4 (the ship stage, now live: AUT-5, REPO-3, PIP-8, PIP-34 and the other removed rows that cite it) say what replaced them (a SHIP row) or lose the word parked; `maintain.md`, its README line and any row citing 261026-2204-2 say it is closed, not parked; rows that say parked with no ID (such as the ship notes on migration-aware rollback) cite a listed intent or are reworded. Their IDs and headings stay.
- Verified by: `specs: parked rows cite a parked intent`

### PIP-216 · A large plan is built over several runs

When a build run ends with plan steps still open, the next run carries on from the first open step, and the review runs once every step is built.

- Total = the numbered items under `## Steps` of the merged `plan.md` (PIP-46), read by code. The build result gains `steps_done` (int, the count of steps built from step 1 in order, so far; `null` is read as "all", which keeps a plan without numbered steps one run). Towercab keeps `data.build.steps_done` and `steps_total` on the mission, recorded before the next run starts.
- A run that ends `done` with `steps_done < steps_total`, and made progress (PIP-217), is not finished: Towercab commits and verifies it as today (PIP-1, PIP-23), pushes it to the same branch and PR (PIP-2), then starts a new build run in a fresh session (PIP-219), which is told the steps already built and to start at the first open step. The review, and the gate after it, start only when `steps_done = steps_total`.
- The intermediate rounds count no repair (PIP-18) and no fix round: only red checks and review findings do. The code PR text is written on the last run and covers the whole intent.
- One intent, one PR, one branch: no extra intent and no extra PR is made for later runs.
- A run that ends `done` with `steps_done` lower than before is read as no change in `steps_done`.
- Verified by: `pipeline: a six-step plan builds in three runs and then goes to review`, `pipeline: open steps send the mission back to build, not review`, `pipeline: the build prompt names the steps already built`, `pipeline: intermediate runs count no repair`

### PIP-217 · A run makes progress when it adds a passing commit

A build run counts as progress only if it adds new commits to the branch and its checks pass; two runs in a row without it stop the build and ask the owner.

- Progress = the branch head moved since the run started (the run's commit, PIP-1) and verify (PIP-23) is green on it. A run with no new commit, or whose checks stay red after their repair rounds, is no progress. Red checks are repaired first, as today (PIP-18); progress is judged after them.
- `data.build.stalled` counts runs in a row without progress and is reset by a run with progress. At 1 the next run starts as above. At 2 the mission waits as a blocked wait, `answer the question`, with a question naming the steps built (`steps_done of steps_total`), what the last two runs did, the options (carry on for two more runs, change the plan, drop) and a recommendation. A run with no new commit while steps are open does not end in `waiting: no changes` (PIP-1) before this count is reached; with all steps built it does, as today.
- The owner's answer to that question resets `stalled` to 0.
- Verified by: `pipeline: a run with no new commits counts as no progress`, `pipeline: two runs without progress ask the owner`, `pipeline: a run with progress resets the stall count`, `pipeline: a run with red checks after repairs is no progress`

### PIP-218 · A long build has a limit per run and a cap on runs

Each run of a long build gets the per-run spending limit, the whole build is capped at 3 runs by default, and the repo, daily and monthly caps still apply on top.

- Each build run is limited by `[agent].max_budget_usd` (default 10, PIP-71, LOOP-1) on its own, not shared out of a total. A single-repo build is therefore limited to `max_build_runs` × that limit without the owner stepping in.
- New setting `[agent].max_build_runs`: integer ≥ 1, default 3, in the settings table of LOOP-1 and editable like the other `[agent]` keys; an invalid value is ignored and shown as a problem. It counts the build runs of one intent's code phase (`data.build.runs`, kept on the mission; repair rounds are not counted). 1 gives today's single run.
- When `runs` has reached `max_build_runs` with steps still open, the mission enters the blocked wait `worker budget` (LOOP-1), as for any spent intent; the owner's reply to carry on grants another `max_build_runs` runs from the first open step (`steps_done` kept, `runs` reset to 0), or the owner starts over or drops.
- A multi-repo intent (LOOP-78) keeps its single total cap across parts as written there; `max_build_runs` counts each part's runs on its own.
- Every run's cost counts in the intent's spend (MET). A daily or monthly budget or a repo cap reached (MET-33) lets a run already going finish and starts no further run; the mission waits at its next owner wait and resumes when the cap is raised or a new period starts. The next run is not skipped, and `steps_done` and `runs` are kept.
- Verified by: `pipeline: each run of a long build gets the per-run limit`, `pipeline: max_build_runs stops a long build with steps open and asks`, `pipeline: the owner's reply grants another set of runs`, `pipeline: max_build_runs is read from config.toml and a bad value is ignored`, `pipeline: all runs of a long build count in the intent's spend`, `pipeline: a repo cap pauses a long build between runs`, `pipeline: a long build resumes at the first open step after a pause`

### PIP-219 · Each later run starts fresh from a handoff note

A later run of a long build starts a new session with the plan, the steps already built and a short note the previous run wrote, not a growing conversation.

- The first run is as PIP-1. Every later run of the same code phase starts a new session (no resume) and is given: `plan.md`, `intent.md` with `## Answers`, the spec IDs, the access and the run set as PIP-1 does, the list of steps already built, and the previous run's handoff note.
- The built steps come from the branch's commits (the commit subjects since base, from `git log`) and the `steps_done` Towercab recorded (PIP-216), not from the old session. The prompt tells the worker to commit by step.
- The build result gains `handoff` (string, required when `steps_done < steps_total`, else `null`): what is done, what is next, anything surprising, in a few sentences. Towercab stores it in `data.build.handoff` before the next run starts and replaces it each run. A run that ends without a valid `handoff` while steps are open gets one continue asking only for it (as PIP-1's continue), then the matching wait.
- Repair rounds (PIP-18) and fix rounds (PIP-98) resume the session of the run they follow, as today.
- Verified by: `pipeline: a later build run starts a new session`, `pipeline: the later run prompt has the plan, built steps and the handoff note`, `pipeline: built steps are read from the branch commits`, `pipeline: a run with steps open and no handoff is asked for it`, `pipeline: a repair round resumes the run's session`

### PIP-220 · Every text for a person has a part for people and a folded part for agents

Every text Towercab writes that a person may read opens with a short part for people, and the detail meant for agents follows, folded away.

- Applies to PR bodies (spec, plan, code), stage and review comments, questions, replies to the owner's comments, the spec-overlap line (UI-202), and the intent and plan PRs. Not to code, commit subjects or JSON read only by code.
- One helper (`twoPartMd({people, agent})` in `src/pipeline/prtext.ts`, next to `plainMd`/`detailsMd` of PIP-108) builds the shape and is the only way a writer produces such text: `## For people\n\n<people>`, then `<details><summary>Agent context</summary>\n\n<agent>\n\n</details>`. The old `## In plain words` heading and the `**In plain words:**` lead of PIP-107 become `## For people` and `**For people:**` (comments); PIP-108's folding of the technical part is this fold, titled `Agent context` instead of `Details`.
- The people part is the plain brief of PIP-106: what happened, why it matters, what (if anything) the owner decides. At most 5 lines and 600 characters, no list of files, no step or field names. Readable without the agent part: never "see below".
- The agent part holds findings, file lists, logs, handoff notes, IDs and the footer's links to the intent. It is always inside the fold; with no agent detail the fold is left out. The footer line (`<sub>Built by Towercab …</sub>`) and the machine markers Towercab parses stay outside it, after it.
- A run from before this rule (no separate fields, PIP-221) falls back to its brief as the people part and its technical text as the agent part.
- Verified by: `pipeline: twoPartMd puts the people part first and folds the agent part`, `pipeline: every PR body opens with the people part and folds the agent part`, `pipeline: stage, review and question comments open with the people part`, `pipeline: a reply to the owner's comment has the two parts`, `pipeline: no fold when there is no agent detail`

### PIP-221 · Agents return the people part and the agent part as separate fields

Each agent that writes for the owner returns the people part and the agent part as two fields, so Towercab never has to split one text.

- `brief` stays the people part (PIP-106). The agent part is the existing technical field of each result: `design.pr`, `plan.plan`, `build.pr` and `build.notes`, `review.outcomes`/`findings`/`summary`, the question's `context`. Where a result has none yet, an `agent` string (required, may be empty) is added: `review` and `risk` (`summary` stays the risk agent's people part). Schemas in PIP-71 stay closed.
- `prompts/writing.md` has a section "People part, agent part" stating PIP-220's rule, and every agent prompt that writes for the owner (`design`, `plan`, `worker`, `repair`, `review`, `review-security`, `review-infra`, `risk`, `merge-review`) asks for the two fields and says the people part is at most 5 lines and holds no agent detail.
- Verified by: `schemas: every result a person reads has a people part and an agent part`, `prompts: every agent that writes for the owner asks for the two parts`, `prompts: writing.md states the people part and agent part rule`

### PIP-222 · A text with a missing or over-long people part is refused

Towercab checks the shape before it posts, so a long or misplaced text never reaches the owner.

- `checkTwoPart(text)` fails when: the people part is empty; it is over 5 lines or 600 characters; it contains a `<details>` block, a code fence, a file path line or a list of more than 3 items; or agent detail (a `Findings`, `Files` or `Handoff` heading, a spec-ID list) sits outside the fold. The error reads as the reason, e.g. `people part is 9 lines; the limit is 5`.
- Applied in two places. On an agent result: a `brief` that fails is handled as an invalid result, so the run gets one continue asking only for a shorter people part (as PIP-1's continue), then the failure of PIP-1 for no valid result. On Towercab's own writers: the helper (PIP-220) throws before anything is posted or recorded as posted, so a bug in a writer fails its test, not the owner's phone.
- An owner's own comments and PR text are never checked.
- Verified by: `pipeline: an over-long people part is refused`, `pipeline: a missing people part is refused`, `pipeline: agent detail outside the fold is refused`, `pipeline: a result with a long brief gets one continue for a shorter one`, `pipeline: the owner's own text is not checked`

### PIP-223 · The sandbox binds the toolchains installed in their usual places

A repo's setup, checks and builds find Rust, Go, Zig and Node when they are installed where their installers put them.

- `toolchainDirs(home)` (PIP-157) returns, for each of these that exists, a read-only bind: `~/.cargo/bin`, `~/.rustup`, `~/.local/go`, every `~/.local/zig-*` directory, `~/.local/node`, plus `~/.local/bin` and the directory of the Node running Towercab when it lives under HOME, as today. The list is fixed in `src/pipeline/sandbox.ts`; no config key, repo file or intent field adds to it (PIP-157).
- A directory that does not exist, or that is a symlink leaving HOME, is skipped without error; nothing else of `~/.cargo` (so not `registry`, `git` or `env`) is bound.
- The `bin` directory of each bound toolchain is on `PATH` ahead of the system's, in a fixed order: `~/.cargo/bin`, `~/.local/go/bin`, each `~/.local/zig-*` (the directory holds the `zig` binary; several versions sort by name, the newest first), `~/.local/node/bin`, `~/.local/bin`, then the system directories (PIP-159). `PATH` is still a constant of the code, not read from Towercab's environment.
- Nothing is writable: a command that writes into a toolchain directory fails.
- Verified by: `sandbox: a repo command finds cargo, go and zig installed in the usual places`, `sandbox: a missing toolchain directory is skipped`, `sandbox: toolchain directories are read-only`, `sandbox: config keys do not change the argv`

### PIP-224 · Credential files under a toolchain stay unreadable

A token that a toolchain's own tool left in its install directory is never visible to a repo's commands.

- Every bound toolchain directory (PIP-223) gets the masked files of `MASKED` (`credentials`, `credentials.toml`, `.git-credentials`, `.netrc`, `.npmrc`, `auth.json` and the rest of that list) bound over with `/dev/null`, as `~/.local/bin` does today, at the top of the directory and one level below it. `~/.cargo/credentials.toml` is out of reach because only `~/.cargo/bin` is bound; a `credentials.toml` placed inside a bound directory reads empty.
- A masked file that does not exist is not created and adds no argument.
- Verified by: `sandbox: a credentials file under a toolchain directory stays unreadable`, `sandbox: the rest of ~/.cargo is not bound`, `sandbox escape: a toolchain credential file reads empty`

### PIP-225 · Go and Zig write their caches into the sandbox cache

Go and Zig never need to write into the read-only install or the empty home: their caches live in the mission's writable cache, like Cargo's.

- `cacheEnv` (LOOP-34) also sets `GOPATH` and `GOMODCACHE` under the cache's `go` directory, `GOCACHE` stays where it is, and `ZIG_GLOBAL_CACHE_DIR` and `ZIG_LOCAL_CACHE_DIR` point under the cache's `zig` directory. `CARGO_HOME` stays in the cache and `RUSTUP_HOME` points at the bound `~/.rustup` so the installed toolchains are found.
- `GOPATH`, `GOMODCACHE`, `ZIG_GLOBAL_CACHE_DIR`, `ZIG_LOCAL_CACHE_DIR` and `RUSTUP_HOME` are fixed in code: a repo's `[repos.<r>].env` of the same name is dropped. The older cache variables (`CARGO_HOME`, `CARGO_TARGET_DIR`, `GOCACHE`, …) stay overridable by a repo's named variables, as before (PIP-159).
- Verified by: `sandbox: go and zig caches are inside the sandbox cache`, `sandbox: rustup home points at the bound toolchains`, `sandbox: a repo variable cannot override a cache variable`

### PIP-226 · `towercab doctor` lists the toolchains it binds

The owner can see which toolchains a repo's commands will find, and which are missing.

- Doctor prints one line per toolchain location of PIP-223 as `toolchain <path>: bound` or `toolchain <path>: not found`, and for each bound one `bin` directory that is on `PATH`. Missing is information, not a fault: the exit code does not change.
- A Zig directory shows one line per `~/.local/zig-*` match. It prints no file content and no environment value.
- Verified by: `doctor: lists the toolchains it found and binds`, `doctor: a missing toolchain is not a fault`

### PIP-227 · A worker's question keeps the work it has done

When a worker stops mid-build to ask the owner something, what it has written so far is still there when the answer arrives.

- A build round that ends with the worker's own question (`status: blocked` with a `question`, PIP-41) marks the mission (`data.askedMidBuild`). The round after the answer does not reset or clean the checkout and does not move the branch back to the base branch, as after a test question (PIP-116); the worker's session continues on its own uncommitted files. The mark is cleared when that round starts.
- A conflict round is the exception: it merges the base branch first, on a clean checkout, as before. `retry` still starts from nothing.
- Before this, an answered question on a first round threw the work away while the resumed session still believed it was in place.
- Verified by: `pipeline: a worker's question keeps its uncommitted work for the next round`

**Agents** (`agents/<name>.md`, PIP-76; loaded by `src/agents.ts`)

| Agent | Purpose | May touch | Session | Model |
|---|---|---|---|---|
| [design](../agents/design.md) | Turns the intent into spec changes and the spec PR's text. | Read, Glob, Grep; Edit only under `specs/**` and the README's docs table (PIP-172); Write. | mission's | mission |
| [plan](../agents/plan.md) | Plans the build; reads only. | Read, Glob, Grep; Bash for `git log`, `git diff`, `git show`, `ls`. | mission's | mission |
| [worker](../agents/worker.md) | Writes tests and code, and the code PR's text. | Read, Edit, Write, Glob, Grep, Bash in the sandbox; WebFetch for granted domains; protected paths per the grants. | mission's | mission |
| [repair](../agents/repair.md) | Fixes red checks, a conflict, a review finding or an owner's answer in the worker's session. | The worker's tools and permissions, no more. | mission's | mission |
| [review](../agents/review.md) | Reviews the code PR against the intent, plan and `REVIEW.md`; reads only. | Read, Glob, Grep; Bash for `git diff`, `git log`, `git show`. | new per run | review model |
| [review-security](../agents/review-security.md) | The security specialist's review of a code PR that touches security files (PIP-197); Important findings only; reads only. | Specialist reviews of a code PR that touches security or infra files; Important findings only; read only. | Read, Glob, Grep; Bash for `git diff`, `git log`, `git show`. | new per run | review model |
| [review-infra](../agents/review-infra.md) | The infra specialist's review of a code PR that touches infra files (PIP-197); Important findings only; reads only. | Specialist reviews of a code PR that touches security or infra files; Important findings only; read only. | Read, Glob, Grep; Bash for `git diff`, `git log`, `git show`. | new per run | review model |
| [risk](../agents/risk.md) | Judges the risk of the spec, plan and code at their gates, and reviews the spec a second time (PIP-96, PIP-97); reads only. | Read, Glob, Grep; Bash for `git diff`, `git log`, `git show`. | new per run | review model |
| [merge-review](../agents/merge-review.md) | Checks that a merge Towercab made by code kept both sides (PIP-169); reads only. | Read, Glob, Grep; Bash for `git diff`, `git log`, `git show`. | new per run | review model |
| [score](../agents/score.md) | Turns a GitHub issue into a scored intent ([INT-22](intents.md)); runs outside any mission in an empty folder. | Nothing: no tools. | none | `[agent].model` |
| [shadow](../agents/shadow.md) | The owner's shadow in Telegram ([SHD-1](shadow.md)); one long-lived session, outside any mission, in an empty folder. | Nothing: no tools; Towercab runs its reads and actions. | resume | `[shadow].model`, else `[agent].model` |
| [observer](../agents/observer.md) | Reads 14 days of how Towercab ran and proposes improvements ([OBV-1](observer.md)); runs outside any mission, in an empty folder. | Nothing: no tools, no network; Towercab builds its evidence and opens the proposals. | none | `[observer].model`, else `[agent].model` |
| [features](../agents/features.md) | Writes a repo's live features from its README and specs ([INT-39](intents.md)); runs outside any mission in a fresh checkout of base. | Read, Glob, Grep in the sandbox; no network. | none | `[agent].model` |

Each file's front matter also holds the time and cost limits and the result schema (PIP-71). `repair`
runs under the worker's run kind, so its run files and counters are the worker's.

Result: the last stdout line that is a JSON object with `type: "result"`: `is_error`, `result`,
`session_id`, `total_cost_usd`, `duration_ms`, `structured_output`, `permission_denials`. A failed
run is, first match: session gone, a usage limit ([LOOP-9](loop.md)), a network or auth failure
([LOOP-10](loop.md)), budget used up, a denied push or secret read, no valid result, other failure.

**Schemas** (`src/pipeline/schemas.ts`; every object closed, every key required, `null` where
optional)

```
design   {title: S, subject: S, brief: S, type, scope, breaking: bool, spec_ids: [S], concerns: [{what, why}],
          open_questions: [{question, answer: S?}], pr: S}
plan     {brief: S, plan: S, access: {domains: [{domain, why}], paths: [{glob, why}], tests: [{path, why}]}, e2e}
build    {status: "done"|"blocked"|"access", brief: S, pr: S?, notes: S,
          question: {context, question, options: [{option, then}], recommendation}?,
          access: {domains: [{domain, why}], paths: [{glob, why}], tests: [{path, why}]}?,
          plan_changed: S?, lower_a: int?, lower_why: S?}
review   {brief: S, approved: bool, outcomes: [{bullet, met: bool, owner: bool, why}], tests_weakened: {value: bool, where},
          plan_followed: {value: bool, where}, findings: [{severity, pass, file, line: int?, what}],
          door: "one-way"|"two-way", red_lines: [{line, file}], summary: S}
risk     {blast_radius: {size: "small"|"medium"|"large", who}, door: {kind: "two-way"|"one-way", why},
          certainty: {level: "high"|"medium"|"low", why}, level: "low"|"medium"|"high", summary: S,
          open_points: [{point, why}]}
score    {u: int 1-5, u_why: S, i: int 1-5, i_why: S, title: S, problem: S, outcome: [S],
          affected: S, constraints: [S], open_questions: [S]}
```

**Code** (`src/pipeline/`; tests `tests/pipeline/*.test.ts`)

| File | What |
|---|---|
| `index.ts` | `handlers()`: one handler per stage. |
| `design.ts`, `plan.ts`, `build.ts`, `verify.ts`, `proof.ts`, `publish.ts`, `ci.ts`, `review.ts`, `gate.ts`, `merge.ts` | One stage each. |
| `risk.ts` | The risk agent's runs at the three gates (PIP-96); the level, floor and words are in `src/risk.ts`. |
| `sandbox.ts`, `guard.ts`, `access.ts`, `prtext.ts`, `prompts.ts`, `schemas.ts` | Sandbox argv; the guard hook; grants and the checklist; PR bodies; prompt templates (the body of `agents/*.md`, `{{key}}`, data fenced as `<intent>…</intent>` and marked data, not instructions); schemas. |

## Out of scope

- After the merge, deploy, e2e, rollback and revert are the ship stage ([ship.md](ship.md)); a release
  gate and rollback rehearsals stay out.
- Evals, the verifier, policy skills (intent 261026-2204-5).

## Decisions

- Three PRs per intent (the owner's call): the spec, the plan and the code are reviewed where they
  live, and merging each one is the approval. The plan PR lives in `intents`, so plans don't clutter
  the target repo's history.
- The worker writes its own PR text: it knows the change; v1's separate Haiku writer saw only
  truncated notes.
- Questions before a PR exists go into the intent file, so there is always one place to answer.
- Mixed interaction model (the owner's call): GitHub gestures first, plain replies for answers and
  feedback, `/retry` and `/release` as the only commands.
- The worker gets general Bash inside the sandbox: v1's per-command allowlist caused most of its
  blocked waits ("compound command refused"), and the sandbox, not the allowlist, is what keeps the
  machine safe.
- Spec rows are `Draft` in the spec PR and the code PR flips them to `Live`, so `main` never claims
  something is built before it is.
- Agent comments (PIP-182..186, from intent 261106-0530-1): the marker is a label for readers and for the
  a0 filter, not a security boundary, in line with a0 (AUT-31). A session that posts with raw `gh`
  still reads as the owner. The owner's calls: the marker is ignored only on a0 intents and elsewhere a
  marked reply still counts but is shown as "agent for owner"; agents are told to use `towercab reply` by
  prompt only. Later option: a Claude Code hook in the owner's own settings that blocks raw
  `gh pr comment` for agent sessions; it is the owner's to add and is not a requirement here. Chosen without asking: the agent is named by the stage that wrote the text;
  the command posts on the current PR (or the issue); old comments keep their headers; the marker only
  excludes comments, it never grants anything.
- Deferred outcomes (PIP-208, PIP-209, from intent 261105-0810, the owner's calls): a deferral is a strict `defer "<outcome>" to <intent id>` line (or the bullet's number) in an owner comment or in a merged plan; loose wording defers nothing, because the review overrode on 1546, 1547 and 2152-2 only from that case. Decided without asking: a quoted outcome matches a bullet or spec row name ignoring case and space; an unmerged plan defers nothing; a deferral never turns a `met` false review into a weaker verdict, it only counts the outcome as met and shows it in the review and PR body. PIP-208 does not touch PIP-210: PIP-210 decides whether a reserved ID is a reference or a collision at pick, PIP-208 decides how the review counts an outcome, and the two never read the same text.
- Reference IDs (PIP-210, from intent 261107-1130-1; the owner's call, 2026-11-07): the intent's wording, not
  the mere presence of a row on `main`, marks an ID as a reference; without such wording an ID on `main` is a
  collision and is moved as before. Decided without asking: the cue words are "made true as written",
  "already written", "changed", "exists" and "existing", read on the list or range they end; a "reference"
  with no row on `main` falls back to being a reservation; with `main` unreadable nothing is moved; PIP-202's
  own-ID rules keep working without wording.
- Hung CI (PIP-170, PIP-171, the owner's calls, 2026-11-06): limits only on Towercab's own step-running jobs; the
  shared-workflow callers have none and rely on cancel and rerun; a hung check is cancelled and rerun by Towercab
  on any repo, once per head. Decided without asking: the rerun waits `ci_wait` again before the owner is asked;
  a check that is not an Actions run is never touched; the rerun counts no repair; a new head starts again with
  the run unused; the stuck wait on a spec PR follows the same path. The flaky UI test is fixed in UI-190, not
  by a new row.
- Sandbox locked in code (the owner's call, 2026-11-06; PIP-157..164): built rows stay true to today's
  code and the new behaviour is Draft until the code PR switches both together. Conservative defaults
  taken where the intent was silent: the only configurable sandbox input is a repo's named variables
  (no token-like name, no secret-looking value); the registry list is the same for setup, checks, e2e
  and Claude runs; escape tests skip with a note where bwrap is missing but CI must have it; a
  mid-build access request is asked, never granted, for paths as well as domains; an invalid domain
  is refused without asking.
- The agent files were compared with Anthropic's AI-Native SDLC Playbook (2026-10-28). Taken: findings
  name their pass (PIP-92), the plan names its files (PIP-93), the review gets a cost cap (PIP-94), the
  scorer fills the intent's other sections ([INT-32](intents.md)), and the review skips what the
  checks already enforce ([REPO-12](repo.md)). Not taken: a narrow Bash allowlist (the decision
  above); denying `.env*` and `secrets/` inside the checkout, because the checkout is a fresh clone
  that never holds a real secret and the secret paths outside it are already denied (PIP-24); and the
  target repo's own skills and subagents, which `--setting-sources ""` keeps out so a repo cannot
  change what an agent may do (PIP-70). The verifier, evals and policy skills stay parked in intent
  261026-2204-5.
