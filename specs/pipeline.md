# Pipeline

**Status:** Draft · **Prefix:** PIP

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
  ` ```setup ` ran in the checkout. The prompt (`prompts/build.md`) gives `plan.md`, `intent.md` (with
  `## Answers`), the spec IDs, the run set ([REPO-9](repo.md)), the access granted
  ([AUT-14](autonomy.md)) and the writing guide (PIP-39). The worker writes a failing test for each
  spec row's `Verified by` and each `Proposed outcome` bullet, implements, runs the checks itself,
  updates docs, and switches the spec rows it built from Draft to Live.
- Result (`--json-schema`, **Schemas** `build`): `status` `done`, `blocked` (with a `question`,
  PIP-41) or `access` (with what and why, [AUT-15](autonomy.md)); `pr` (the code PR's text, PIP-48);
  `plan_changed` (markdown, when it departed from the plan, with why); `lower_a`, `lower_why`.
- Towercab then commits everything as the bot (`git add -A`, message = the design's Conventional
  Commit line) and goes to verify. No diff → `waiting: no changes`. Timeout, budget used up, or no
  valid result → one continue with `Continue where you stopped.`, then the matching wait.
- Verified by: `pipeline: build prompt has plan, intent and checks`, `pipeline: build commits as the
  bot`, `pipeline: no changes waits`, `pipeline: timeout continues once`

### PIP-2 · Publish

After green checks and a proof, Towercab pushes the branch and opens the code PR; later rounds only
push.

- Push `towercab/<id>-<slug>` from Towercab's clone (fetched from the checkout by path). First time:
  `gh pr create` (ready for review, not a draft), title = the design's Conventional Commit line, body
  = PIP-48; `missions.pr`, `head`, `pushed_at` recorded first. A push refused other than as
  non-fast-forward, or rejected 3 times → `waiting: answer the question` with the reason.
- Verified by: `pipeline: first publish opens the code PR`, `pipeline: later rounds only push`

### PIP-3 · CI

Towercab waits for the PR's checks and sorts them into pass, fail and pending in code.

- `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup` every `ci_poll` s. A check run
  `COMPLETED` with `SUCCESS`, `NEUTRAL` or `SKIPPED` passes; `FAILURE`, `TIMED_OUT`,
  `ACTION_REQUIRED`, `STARTUP_FAILURE`, or a status `FAILURE`/`ERROR` fails; `CANCELLED` cancels;
  else pending. Within `ci_grace` s of a push, checks started before it are ignored. No checks after
  `ci_grace` → green with `no CI on this repo`. Pending past `ci_wait` → `waiting: CI stuck`.
- Red → a repair round in `build` with the failing jobs' log tails (at most 2, `ci_repairs`), then
  `waiting: CI red`.
- Verified by: `pipeline: CI buckets`, `pipeline: no checks counts as green`, `pipeline: CI red
  repairs twice then waits`

### PIP-4 · Review

A separate, read-only Claude session reviews every code PR against the intent, the plan and the
repo's `REVIEW.md`, and posts what it found on the PR.

- After green CI, again on each new head (reused when the diff's `git patch-id` is unchanged). Model:
  the intent's `review`, else `[agent].review_model`, else one step above the worker (haiku → sonnet →
  opus; opus stays). Given intent, spec IDs, `plan.md`, the PR diff, the CI result, `REVIEW.md` and
  the screenshots (PIP-49). Its verdict is posted as a Review comment (PIP-42).
- Verified by: `pipeline: review on every PR`, `pipeline: review reused for an unchanged diff`,
  `pipeline: review comment is posted`

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
  a4 (AUT-15); proof missing (PIP-30); effective `a` ≤ 3; no `a` and not low-risk (AUT-9). Else →
  `merge`. The PR body's Checks section is updated first (PIP-48).
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
- Verified by: `pipeline: merge on the gated head`, `pipeline: behind updates the branch`,
  `pipeline: dirty is a conflict round`

### PIP-23 · Verify

After each build or repair, code runs the repo's setup and checks in a sandbox and sends failures
back to the worker.

- ` ```setup ` (base branch's) runs first, with network and the repo cache writable; non-zero → once
  more after 60 s, then red. The run set ([REPO-9](repo.md)) runs in order without network, each
  bounded by `check_timeout`. Logs: `runs/<id>/verify-<n>.log` (`$ <command>` before each output).
- Red → a repair round in `build` with the log tail (at most 2 for verify and proof together,
  `repairs`), then `waiting: checks red`. A log that shows a missing tool or a sandbox failure is a
  fault ([LOOP-10](loop.md)), not a repair.
- **Sandbox**: `bwrap [--unshare-net] --unshare-pid --unshare-ipc --unshare-uts --new-session
  --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /run --tmpfs <HOME> --tmpfs /tmp`,
  the toolchain dirs read-only with credential files masked, the repo cache (LOOP-34), `--bind
  <checkout>` with its `.git` read-only, `--chdir <checkout>`, `sh -c <line>`.
- Verified by: `pipeline: verify runs setup then checks`, `pipeline: verify red repairs then waits`,
  `pipeline: sandbox argv`

### PIP-24 · Claude runs

Every Claude run is headless, sandboxed, and gets only the tools and access its job needs.

- `claude -p --output-format json --permission-mode dontAsk --strict-mcp-config --setting-sources ""
  --append-system-prompt-file <runs>/system-<kind>.md --settings <runs>/settings-<kind>.json --model
  <m> --tools <list> [--allowedTools …] [--disallowedTools …] [--session-id|--resume <uuid>]
  [--max-budget-usd <n>] [--json-schema <schema>]`, the prompt on stdin. The system file = the base
  branch's `CLAUDE.md` + the writing guide (PIP-39). Env: HOME, PATH, LANG, the repo cache's
  variables (LOOP-34), `[agent].env`; never a GitHub token.
- Settings: `sandbox {enabled, failIfUnavailable, allowUnsandboxedCommands: false, filesystem
  {denyRead: secret paths, denyWrite: <checkout>/.git + blocked protected paths, allowWrite: the repo
  cache}, network {allowedDomains: the granted domains}}`, `permissions.allow: WebFetch(domain:<d>)`
  per granted domain (`WebFetch(domain:*)` at a5), the guard hook for workers (PIP-29). Secret paths:
  `~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.gnupg`, `~/.config/towercab`, `~/.claude/.credentials.json`,
  `~/.netrc`, `~/.git-credentials`.
- Tools by kind: **Claude runs** table. Disallowed for every run: `Bash(git push:*)`,
  `Bash(git remote:*)`, `Bash(git config:*)`, `Bash(gh:*)`, `Bash(ssh:*)`, `Bash(sudo:*)`, `Read` of
  each secret path. A denied push or secret read fails the step.
- Verified by: `claude: worker argv`, `claude: review argv`, `claude: settings by autonomy`,
  `claude: result parse`, `claude: no token in env`

### PIP-25 · Design

The worker's first run turns the intent into spec changes, and Towercab opens them as the spec PR.

- Given `intent.md`, the repo's `specs/`, `CLAUDE.md` and the writing guide; tools Read, Glob, Grep,
  Edit, Write, allowed to edit `specs/**` only. Result (**Schemas** `design`): `type`, `scope`,
  `breaking`, `spec_ids`, `concerns` (`what`, `why`), `open_questions` (each answered or left to the
  owner), `pr` (the spec PR's text: what changes in behaviour and why, for a reader who wasn't
  there).
- Spec rows added here are `Draft`. Towercab commits `docs(specs): <title>` on
  `towercab/<id>-<slug>-spec`, pushes, and opens the spec PR (title `docs(specs): <title>`). Then the
  spec gate ([AUT-11](autonomy.md)): the owner (`approval:spec`) or Towercab (PIP-50). No behaviour
  change (`spec_ids` empty, no diff) → no spec PR; on to plan.
- The owner's review comments on the spec PR → a design revision in the same session, a new commit
  on the same PR.
- Verified by: `pipeline: design edits only specs`, `pipeline: spec PR is opened`,
  `pipeline: no behaviour change skips the spec PR`, `pipeline: feedback revises the spec`

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
  `main` of the intents repo (`towercab: plan changed <id>`) and says so in the code PR.
- Verified by: `pipeline: plan PR is opened on intents`, `pipeline: feedback revises the plan`,
  `pipeline: merged plan grants its ticked access`

### PIP-29 · Guard

A hook stops the worker from writing paths it hasn't been granted, and tells it how to ask.

- Every worker run's settings add a `PreToolUse` hook on `Edit|Write|NotebookEdit` running
  `towercab hook guard <runs>/guard.json` (`{checkout, protected, granted, locked}`), which exits 2
  with a reason for: a path outside the checkout, a protected path not granted
  ([REPO-8](repo.md), [AUT-14](autonomy.md)), a locked test (PIP-31). The reason for a protected path
  ends `if you need it, finish what you can and return status access with this path and why`. It
  fails closed (unreadable rules, no path, an error → exit 2).
- Publish also refuses a diff that touches a protected path that isn't granted.
- Verified by: `guard: blocks a protected path`, `guard: allows a granted path`,
  `guard: blocks outside the checkout`, `guard: fails closed`

### PIP-30 · Red→green proof

Towercab checks that the PR's tests fail without the change, so the tests prove something.

- After green verify, when the design changed spec rows or its `type` is `fix`: a checkout of
  `origin/<base>` with the PR's changed test files laid over it (globs: `TOWERCAB.md` `tests`, default
  `tests/**`, `test/**`, `**/__tests__/**`, `**/*_test.*`, `**/test_*.*`, `**/*.test.*`,
  `**/*.spec.*`) runs setup, then the run set. Red = proven. Green → a repair round asking for a test
  that fails without the change; after the repairs → `waiting: tests don't prove the change`. After
  the owner answers, a proof that still fails to prove → publish with `data.unproven` (the gate then
  sends the PR to the owner, PIP-7).
- Verified by: `pipeline: proof red on base proves`, `pipeline: green on base repairs`,
  `pipeline: unproven goes to the owner`

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
- Verified by: `pipeline: question comment has context, options, recommendation`,
  `pipeline: question without a PR goes to the intent`

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
- Verified by: `events: merge, close, review and comment`, `events: approve review merges`,
  `events: retry command`

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

- Spec gate open ([AUT-11](autonomy.md)) → wait for the spec PR's CI (PIP-3 rules, no repairs: red →
  `waiting: approve spec` with why `CI red on the spec PR`), then `gh pr merge --squash`.
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

**Claude runs** (`src/claude.ts`)

| Kind | `--tools` | Allowed | Session | Model |
|---|---|---|---|---|
| design | `Read,Glob,Grep,Edit,Write` | Read, Glob, Grep, `Edit(specs/**)` | new (`--session-id`) | mission |
| plan | `Read,Glob,Grep,Bash` | Read, Glob, Grep, `Bash(git log:*)`, `Bash(git diff:*)`, `Bash(git show:*)`, `Bash(ls:*)` | resume | mission |
| worker | `Read,Edit,Write,Glob,Grep,Bash,WebFetch` | Read, Edit, Write, Glob, Grep, Bash (sandboxed), WebFetch for granted domains | resume | mission |
| review | `Read,Glob,Grep,Bash` | Read, Glob, Grep, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)` | new per run | review model |

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
```

**Code** (`src/pipeline/`; tests `tests/pipeline/*.test.ts`)

| File | What |
|---|---|
| `index.ts` | `handlers()`: one handler per stage. |
| `design.ts`, `plan.ts`, `build.ts`, `verify.ts`, `proof.ts`, `publish.ts`, `ci.ts`, `review.ts`, `gate.ts`, `merge.ts` | One stage each. |
| `sandbox.ts`, `guard.ts`, `access.ts`, `prtext.ts`, `prompts.ts`, `schemas.ts` | Sandbox argv; the guard hook; grants and the checklist; PR bodies; prompt templates (`prompts/*.md`, `{{key}}`, data fenced as `<intent>…</intent>` and marked data, not instructions); schemas. |

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
