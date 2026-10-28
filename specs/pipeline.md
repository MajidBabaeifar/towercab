# Pipeline

**Status:** Live: PIP-1..54, PIP-70..81 · **Prefix:** PIP

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
  Commit line) and goes to verify. No diff → `waiting: no changes`. Timeout, budget used up, or no
  valid result → one continue with `Continue where you stopped.` and the step's full time budget
  again, then the matching wait.
- Verified by: `pipeline: build prompt has plan, intent and checks`, `pipeline: build commits as the bot`, `pipeline: no changes waits`, `pipeline: timeout continues once`

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
  the screenshots (PIP-49). Its verdict is posted as a Review comment (PIP-42).
- Verified by: `pipeline: review on every PR`, `pipeline: review reused for an unchanged diff`, `pipeline: review comment is posted`

### PIP-5 · Review verdict

The review returns a structured verdict, and code decides from it whether the PR is approved.

- **Schemas** `review`: `approved`, one verdict per `Proposed outcome` bullet (`met`, `why`),
  `tests_weakened` (`value`, `where`), `plan_followed` (`value`, `where`), `findings` (`severity`
  `important`/`nit`, `file`, `line`, `what`), `door` (`one-way`/`two-way`), `red_lines` (touched,
  with file), `summary` (markdown, for the owner). Approved = `approved` ∧ every outcome met ∧ no
  weakened tests ∧ plan followed ∧ no important finding. Nits are capped by `REVIEW.md`.
- Verified by: `pipeline: approval is computed in code`

### PIP-6 · Review rounds

Removed: in v1 already.

### PIP-7 · Gate

After the review, code decides whether Towercab merges the code PR or the owner does.

- Effective `a` and caps from [AUT-8, 13](autonomy.md). First match wins → `approval:merge`
  (`waiting: review and merge PR`, why): CI not green; review not approved; access beyond the plan at
  a4 (AUT-15); proof missing (PIP-30); effective `a` ≤ 3; no `a` and not low-risk (AUT-9); someone
  else's commits on the PR (PIP-2); the build departed from the approved plan, below a5 (PIP-28).
  Else → `merge`. The PR body's Checks section is updated first (PIP-48).
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
  more after 60 s, then red. The run set ([REPO-9](repo.md)) runs in order without network, each
  bounded by `check_timeout`. Logs: `runs/<id>/verify-<n>.log` (`$ <command>` before each output); under LOOP-39 they move to `runs/<id>/verify/check-<n>.log`.
- Red → a repair round in `build` with the log tail (at most 2 for verify and proof together,
  `repairs`), then `waiting: checks red`. A log that shows a missing tool or a sandbox failure is a
  fault ([LOOP-10](loop.md)), not a repair.
- **Sandbox**: `bwrap [--unshare-net] --unshare-pid --unshare-ipc --unshare-uts --new-session
  --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /run --tmpfs <HOME> --tmpfs /tmp`,
  the toolchain dirs read-only with credential files masked, the repo cache (LOOP-34), `--bind
  <checkout>` with its `.git` read-only, `--chdir <checkout>`, `sh -c <line>`.
- Verified by: `pipeline: verify runs setup then checks`, `pipeline: verify red repairs then waits`, `pipeline: sandbox argv`

### PIP-24 · Claude runs

Every Claude run is headless, sandboxed, and gets only the tools and access its job needs.

- `claude -p --output-format json --permission-mode dontAsk --strict-mcp-config --setting-sources ""
  --append-system-prompt-file <runs>/system-<kind>.md --settings <runs>/settings-<kind>.json (both
  move into the stage folder under LOOP-39) --model
  <m> --tools <list> [--allowedTools …] [--disallowedTools …] [--session-id|--resume <uuid>]
  [--max-budget-usd <n>] [--json-schema <schema>]`, the prompt on stdin. The system file = the base
  branch's `CLAUDE.md` + the writing guide (PIP-39). Env: HOME, PATH, LANG, the repo cache's
  variables (LOOP-34), `[agent].env`; never a GitHub token.
- Settings: `sandbox {enabled, failIfUnavailable, allowUnsandboxedCommands: false, filesystem
  {denyRead: secret paths, denyWrite: <checkout>/.git + blocked protected paths, allowWrite: the repo
  cache}, network {allowedDomains: the granted domains}}`, `permissions.allow: WebFetch(domain:<d>)`
  per granted domain (`WebFetch(domain:*)` at a5), the guard hook for workers (PIP-29). Secret paths:
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
  `towercab/<id>-<slug>-spec`, pushes, and opens the spec PR (title `docs(specs): <title>`). Then the
  spec gate ([AUT-11](autonomy.md)): the owner (`approval:spec`) or Towercab (PIP-50). No behaviour
  change (`spec_ids` empty, no diff) → no spec PR; on to plan.
- The owner's review comments on the spec PR → a design revision in the same session, a new commit
  on the same PR.
- Verified by: `pipeline: design edits only specs`, `pipeline: spec PR is opened`, `pipeline: no behaviour change skips the spec PR`, `pipeline: feedback revises the spec`

### PIP-26 · Spec approval

Removed: now AUT-11 with PIP-25 and PIP-50.

### PIP-27 · Policy skills

Removed: never configured; parked as intent 261026-2204-5.

### PIP-28 · Plan

The worker plans the build, read-only, and Towercab opens the plan as a PR on the intents repo.

- Resumes the session; tools Read, Glob, Grep and read-only git. Result (**Schemas** `plan`): `plan`
  (markdown, PIP-46) and `access` (`domains` and `paths`, each with `why`).
- Towercab writes `intents/<id>-<slug>/plan.md` (PIP-46) on branch `plan/<id>-<slug>` of the intents
  repo, pushes, and opens the plan PR (title `docs(plan): <title>`, body: the approach in a few
  sentences and the access asked for). Then the plan gate ([AUT-12](autonomy.md)): the owner
  (`approval:plan`) or Towercab (PIP-51).
- The owner's comments on the plan PR → a plan revision, a new commit on the same PR. Merged → the
  grants are read from the merged `plan.md` (PIP-47) and the build starts.
- A build that departs from the plan returns `plan_changed`; Towercab commits it to `plan.md` on
  `main` of the intents repo (`towercab: plan changed <id>`), keeping the merged Access section, and the
  gate sends the PR to the owner below a5. A revised plan PR keeps the boxes the owner unticked.
- Verified by: `pipeline: plan PR is opened on intents`, `pipeline: feedback revises the plan`, `pipeline: merged plan grants its ticked access`

### PIP-29 · Guard

A hook stops the worker from writing paths it hasn't been granted, and tells it how to ask.

- Every worker run's settings add a `PreToolUse` hook on `Edit|Write|NotebookEdit` running
  `towercab hook guard <runs>/guard.json` (`{checkout, protected, granted, locked}`), which exits 2
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
  `**/*.spec.*`) runs setup, then the run set (from the PR's `CLAUDE.md` when PIP-54 applies). Red = proven. Green → a repair round asking for a test
  that fails without the change; after the repairs → `waiting: tests don't prove the change`. After
  the owner answers, a proof that still fails to prove → publish with `data.unproven` (the gate then
  sends the PR to the owner, PIP-7).
- Verified by: `pipeline: proof red on base proves`, `pipeline: green on base repairs`, `pipeline: unproven goes to the owner`

### PIP-31 · Test lock in repair rounds

During repair rounds the worker can't change tests it already pushed, so it can't make a red check
green by weakening the test.

- Locked = test files (PIP-30's globs) at the head of the last non-repair round; the guard blocks
  them and publish refuses a diff that changes or deletes them. New test files are fine.
- Verified by: `pipeline: repair can't edit pushed tests`

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
- Verified by: `events: only the owner's comments count`

### PIP-45 · Slash commands

Two short commands cover what a GitHub action can't express.

- `/retry` (alone in a comment by the owner on any of the intent's PRs): a fresh attempt.
  `/release`: reserved for the ship stage (parked); today it gets a reply comment saying so.
- Verified by: `events: retry command`, `events: release says it is parked`

### PIP-46 · plan.md

The plan explains the approach before the steps, so the owner can judge it in a minute.

- `plan.md`: `# Plan: <title>`, a line with the intent and spec IDs, then the worker's markdown:
  `## Approach` (what will be built and why this way), `## Steps` (in order; failing tests first),
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

- Body: the worker's `pr` markdown (sections `## What this does`, `## Why`, `## What to check before
  merging`, `## Changes`); then Towercab's `## Checks` (one line each: verify, proof, CI, review, in
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
  (PIP-3 rules, no repairs: red, a conflict or someone else's push → `waiting: approve spec` with the
  reason), then `gh pr merge --squash --match-head-commit <head>`.
- Verified by: `pipeline: spec PR merged when the gate is open`

### PIP-51 · Towercab merges the plan PR at a5

At a5 Towercab merges its own plan PR and starts building.

- Plan gate open ([AUT-12](autonomy.md)) → `gh pr merge --squash` on the intents repo as the App.
- Verified by: `pipeline: plan PR merged at a5`

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
  ones are left. A failure is retried next pass (LOOP-6).
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
- Verified by: `agents: repair continues the worker session`, `agents: score has no tools`

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

<<<<<<< HEAD
### PIP-82 · A red spec PR is revised once

When the checks on the spec PR stay red after the rerun, the design revises the spec once by itself, so the owner never has to review a red spec PR.

- Applies while the spec waits for approval (`approval:spec`) and while Towercab waits to merge it
  (PIP-50). Towercab reads the spec PR's checks as PIP-3 does, on the head it pushed, with the
  first-red rerun of PIP-18 first. A check that is still red after that rerun sends the mission back
  to design in the same session, as if the owner had commented. The revision is a new commit on the
  same PR (PIP-25).
- The prompt is the one PIP-83 describes; nothing in the owner's name is posted.
- At most 1 red revision per spec PR (counted separately from the conflict revisions of
  PIP-81). If the PR is still red after it, or the revision changes nothing, the mission waits for the
  owner (`waiting: approve spec`) and the reason says which checks are red. A red spec PR does not
  count as ready to merge: Towercab does not merge it (PIP-50) and the owner is not asked to approve it
  before the revision has run.
- A cancelled or pending check is not red. No checks on the repo → nothing to revise.
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
=======
### PIP-85 · A refused push is a question, not a crash

When GitHub refuses a push because it already has commits on the branch that Towercab doesn't, the mission asks the owner instead of counting a crash.

- A push rejected as non-fast-forward is thrown as a typed error, not a plain one, so the crash counter
  (LOOP-6) does not count it. It counts as a refused push instead: after 3 refusals the mission is
  `waiting: answer the question`.
- The question follows the writing guide (PIP-39): it names the branch, says GitHub already has commits
  on it that Towercab doesn't, and offers what the owner can do (delete the branch on GitHub, or tell
  Towercab to use another name). Never a force-push (PIP-2).
- Verified by: `pipeline: a refused push waits with the reason`, `pipeline: a refused push is not counted as a crash`

### PIP-86 · A leftover branch is replaced only when it is Towercab's own

Before a mission's first push, Towercab checks whether the branch already exists on GitHub and clears it away only when an earlier Towercab PR is all that is on it.

- Check: `towercab/<id>-<slug>` on GitHub (`git ls-remote`) and the PRs with that head (`gh pr list
  --head`, all states). No branch → push as today.
- The branch exists and every PR on it is closed or merged or was opened by the Towercab App, and at
  least one is open: Towercab closes each open one with a comment saying the intent started over,
  deletes the branch (PIP-89), then pushes. An earlier attempt or a v1 PR is the usual case.
- The branch exists and an open PR was opened by anyone else, or there are commits on the branch and
  no PR of the App's at all: nothing is closed or deleted, and the mission is `waiting: answer the
  question`. The ask names the branch and the PR if any, and offers: delete the branch on GitHub, or
  say to use another name. Towercab does not pick the next free name `-<n>` by itself, since the
  commits may be someone's work.
- Not done again once the first push has succeeded; later rounds only push (PIP-2).
- Verified by: `pipeline: a leftover App PR is closed and replaced`, `pipeline: someone else's branch is left alone`, `pipeline: a leftover branch with commits but no PR waits`

### PIP-87 · A PR Towercab closes loses its branch

When Towercab itself closes a PR, it deletes that PR's branch on GitHub too.

- Applies to the closing in PIP-53 (`/retry` replacing an attempt: spec, plan and code PRs), to
  `drop` closing the current PR (the `drop` command, [PRI-9](priority.md)) and to PIP-86. Merged PRs are not touched; the repo setting
  deletes their branches (PIP-89).
- Deleted after the close, subject to the guards in PIP-89. A branch shared with a newer attempt's open
  PR is kept.
- Verified by: `pipeline: retry deletes the old attempt's branches`, `pipeline: drop deletes the PR's branch`

### PIP-88 · A PR the owner closes loses its branch

When a mission stops because the owner closed its PR, Towercab deletes that PR's branch.

- Entering `stopped` through `machine.apply` because a PR was closed without merge (PIP-43: the
  `closed` event, the intent is dropped) records the deletion of that PR's branch, then makes it.
- Subject to the guards in PIP-89.
- Verified by: `pipeline: a PR the owner closes loses its branch`

### PIP-89 · Branch deletion is guarded and retried

Towercab deletes only branches it made for a PR it opened, and tries again if GitHub fails.

- Deleted only if the branch starts with `towercab/`, its PR was opened by the Towercab App, and the PR
  is closed or Towercab is closing it. A branch with an open PR from anyone else, or outside
  `towercab/`, is never deleted. A branch already gone counts as done.
- The deletion is a side effect: `ctx.record` first, then `gh api -X DELETE
  repos/<repo>/git/refs/heads/<branch>`; a failure is retried next pass (LOOP-6).
- Merged branches stay the job of the repo setting `delete_branch_on_merge` (`apply-settings`); Towercab
  does not delete them.
- Verified by: `pipeline: a branch outside towercab/ is never deleted`, `pipeline: a failed branch delete is retried`, `pipeline: a merged PR's branch is left to the repo setting`
>>>>>>> refs/remotes/origin/main

**Agents** (`agents/<name>.md`, PIP-76; loaded by `src/agents.ts`)

| Agent | Purpose | May touch | Session | Model |
|---|---|---|---|---|
| [design](../agents/design.md) | Turns the intent into spec changes and the spec PR's text. | Read, Glob, Grep; Edit only under `specs/**`; Write. | mission's | mission |
| [plan](../agents/plan.md) | Plans the build; reads only. | Read, Glob, Grep; Bash for `git log`, `git diff`, `git show`, `ls`. | mission's | mission |
| [worker](../agents/worker.md) | Writes tests and code, and the code PR's text. | Read, Edit, Write, Glob, Grep, Bash in the sandbox; WebFetch for granted domains; protected paths per the grants. | mission's | mission |
| [repair](../agents/repair.md) | Fixes red checks, a conflict, a review finding or an owner's answer in the worker's session. | The worker's tools and permissions, no more. | mission's | mission |
| [review](../agents/review.md) | Reviews the code PR against the intent, plan and `REVIEW.md`; reads only. | Read, Glob, Grep; Bash for `git diff`, `git log`, `git show`. | new per run | review model |
| [score](../agents/score.md) | Turns a GitHub issue into a scored intent ([INT-22](intents.md)); runs outside any mission in an empty folder. | Nothing: no tools. | none | `[agent].model` |

Each file's front matter also holds the time and cost limits and the result schema (PIP-71). `repair`
runs under the worker's run kind, so its run files and counters are the worker's.

Result: the last stdout line that is a JSON object with `type: "result"`: `is_error`, `result`,
`session_id`, `total_cost_usd`, `duration_ms`, `structured_output`, `permission_denials`. A failed
run is, first match: session gone, a usage limit ([LOOP-9](loop.md)), a network or auth failure
([LOOP-10](loop.md)), budget used up, a denied push or secret read, no valid result, other failure.

**Schemas** (`src/pipeline/schemas.ts`; every object closed, every key required, `null` where
optional)

```
design   {type, scope, breaking: bool, spec_ids: [S], concerns: [{what, why}],
          open_questions: [{question, answer: S?}], pr: S}
plan     {plan: S, access: {domains: [{domain, why}], paths: [{glob, why}]}}
build    {status: "done"|"blocked"|"access", pr: S?, notes: S,
          question: {context, question, options: [{option, then}], recommendation}?,
          access: {domains: [{domain, why}], paths: [{glob, why}]}?,
          plan_changed: S?, lower_a: int?, lower_why: S?}
review   {approved: bool, outcomes: [{bullet, met: bool, why}], tests_weakened: {value: bool, where},
          plan_followed: {value: bool, where}, findings: [{severity, file, line: int?, what}],
          door: "one-way"|"two-way", red_lines: [{line, file}], summary: S}
score    {u: int 1-5, u_why: S, i: int 1-5, i_why: S, title: S, problem: S, outcome: [S]}
```

**Code** (`src/pipeline/`; tests `tests/pipeline/*.test.ts`)

| File | What |
|---|---|
| `index.ts` | `handlers()`: one handler per stage. |
| `design.ts`, `plan.ts`, `build.ts`, `verify.ts`, `proof.ts`, `publish.ts`, `ci.ts`, `review.ts`, `gate.ts`, `merge.ts` | One stage each. |
| `sandbox.ts`, `guard.ts`, `access.ts`, `prtext.ts`, `prompts.ts`, `schemas.ts` | Sandbox argv; the guard hook; grants and the checklist; PR bodies; prompt templates (the body of `agents/*.md`, `{{key}}`, data fenced as `<intent>…</intent>` and marked data, not instructions); schemas. |

## Out of scope

- Deploy, e2e, release, revert and rehearsal (intent 261026-2204-4).
- Evals, the verifier, policy skills (intent 261026-2204-5).
- Review rounds with the worker: a review that doesn't approve sends the PR to the owner.

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
