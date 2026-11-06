# Kinds of work

**Status:** Draft · **Prefix:** KND

## Purpose

Not every intent needs the full path. A bugfix, a refactor, a CI change and a spec edit each skip the
steps that add nothing for them, so a one-line fix does not take the rounds of a new feature. The
kind picks the path; autonomy ([autonomy.md](autonomy.md)) still decides who approves each gate.

## Requirements

### KND-1 · An intent has a kind

Every intent is one of five kinds of work, and the kind decides which steps it goes through.

- Kinds: `bugfix` (behaviour that a spec row already promises is broken), `refactor` (structure
  changes, behaviour doesn't), `infra` (CI, build, deploy or other configuration), `feature` (new or
  changed behaviour), `spec` (spec-only or settings-only: no program code changes).
- The owner may write `kind: <name>` in the intent's front matter ([INT-69](intents.md)); an unknown
  value is a bad intent. Without it Towercab infers it (KND-2). The kind in use is kept in
  `missions.data.kind` (`kind`, `by`: `owner`, `towercab` or `escalated`, `why`) and fixed for the
  mission; a change to the field applies to the next attempt ([LOOP-15](loop.md) `retry`).
- Verified by: `kinds: the owner's kind field is used`, `kinds: an unknown kind makes the intent unreadable`

### KND-2 · Towercab infers the kind

When the owner didn't set a kind, a short read-only run reads the intent and the repo's specs and picks one, and any doubt means `feature`.

- One run at pick, on the review model, tools Read, Glob and Grep, like the risk agent
  ([AUT-16](autonomy.md)); result `kind` and `why` (one plain sentence). A run that fails after its one
  continue, an unknown value or a missing answer → `feature`.
- It picks `bugfix` only when a spec row already describes the behaviour the intent says is broken, and
  `spec` only when the outcome names no change to program code. Cost counts in the intent's metrics
  ([MET-1](metrics.md)).
- Verified by: `kinds: an intent without a kind is inferred`, `kinds: doubt means feature`

### KND-3 · Each kind has its own path

The stages a mission goes through depend on its kind; the stages that remain run as they do today.

| Kind | Spec PR | Plan PR | Build | Proof | Code PR, CI, review, gate, merge |
|---|---|---|---|---|---|
| feature | yes | yes | yes | red→green ([PIP-30](pipeline.md)) | yes |
| bugfix | no | no | yes | red→green | yes |
| refactor | no | yes | yes | behaviour unchanged (KND-5) | yes |
| infra | no | yes | yes | apply (KND-6) | yes |
| spec | yes | no | no | none | none; the spec PR is the only PR (KND-7) |

- A skipped stage is recorded (`ctx.record`) with the reason and the kind, and the mission moves to the
  next stage that runs. The order of [LOOP-3](loop.md) is unchanged; a kind only leaves stages out.
- The kind never changes the checks that remain: verify, CI, the review, the risk check and the gate
  run as for a feature, and autonomy (AUT-3..AUT-12) decides who approves each. A skipped gate has no
  risk assessment.
- Verified by: `kinds: each kind runs its own stages`, `kinds: a skipped stage is recorded`, `machine: every stage and event pair is defined`

### KND-4 · A bugfix has no spec PR and no plan PR

A bugfix goes straight to build with only the access every intent has, and it still proves its test failed before the fix.

- The worker gets the intent and the spec rows it names; no spec PR and no plan PR are made, so there is
  no plan to grant access: the grants are the default network list, the intent's own `unlock` and
  `network`, and owner-allowed requests ([AUT-27](autonomy.md)). A protected path is blocked at a4 and
  needs the owner's answer.
- The red→green proof applies whatever the design's `type` ([PIP-30](pipeline.md)); a bugfix whose test
  doesn't fail without the fix is repaired as any failed proof.
- Verified by: `kinds: a bugfix skips the spec and the plan`, `kinds: a bugfix still needs a failing test first`

### KND-5 · A refactor keeps its behaviour and its tests

A refactor has no spec PR, and instead of a failing test it proves that the existing tests still pass untouched.

- No spec PR. The plan PR stays: it lists the files the change moves and the access it needs (PIP-28).
- Proof: the test files of the base branch are locked as in [PIP-31](pipeline.md) and a diff that
  changes, adds or removes a test file is refused; a refactor that truly needs a test change asks the
  owner as in [PIP-116](pipeline.md). Proof passes when the checks are green with those files
  unchanged; it records `behaviour unchanged`.
- Verified by: `kinds: a refactor skips the spec and keeps the plan`, `kinds: a refactor may not change tests`, `kinds: a refactor proves its tests pass untouched`

### KND-6 · Infra and config apply their change instead of a proof

A change to CI, build or other configuration has no spec PR and, instead of a failing-test proof, is applied once to show it works.

- No spec PR. The plan PR stays, because configuration lives in protected paths (REPO-8) and the plan
  is where they are granted.
- Instead of proof, the step runs the ` ```apply ` block of the base branch's `TOWERCAB.md`
  ([REPO-1](repo.md)) in the sandbox (the commands that dry-run or validate the change, such as a workflow
  linter); a failing line is repaired like a failed check. No block → nothing is run and the PR's own
  CI is the apply: the step records `applied by CI` and the mission goes on, the gate still waits for
  green CI.
- Verified by: `kinds: infra skips the spec and keeps the plan`, `kinds: infra runs the apply block instead of the proof`, `kinds: infra without an apply block relies on CI`

### KND-7 · A spec-only or settings-only change is one PR

An intent that changes only the specs or the settings files of a repo produces a single pull request, and the intent is done when it merges.

- Kind `spec`: the design (PIP-25) runs; no plan, build, proof or code PR follows. Besides `specs/**`
  the design may edit `TOWERCAB.md`, `REVIEW.md` and `CLAUDE.md` at the repo root. Any other path is
  discarded as in PIP-25 and the publish guard (PIP-172) accepts only these.
- The spec PR's merge ends the mission: `done`, and the intent's `stage` becomes `done`. Its gate is
  AUT-11; a PR that touches a settings file always goes to the owner (`approval:spec`, why: `This
  changes the settings Towercab reads from the repo, so you decide.`), at every autonomy.
- Settings that live outside the repo (Towercab's own `config.toml`, an account) are not files in a PR;
  they are delivered as steps for the owner ([PIP-112](pipeline.md)).
- Verified by: `kinds: a spec-only change ends at the merged spec PR`, `kinds: a settings file in the spec PR goes to the owner`, `kinds: the design of a spec kind may edit settings files only`

### KND-8 · A lighter path can step up to a feature

When a bugfix, refactor or infra mission finds that it changes behaviour a spec doesn't describe, it stops and restarts as a feature.

- The build result may return `needs_spec: true` with `why`. No code PR exists yet, so Towercab drops
  the branch, records `data.kind = feature` with `by: escalated` and the reason, and moves the mission
  to `design`. Anything else in the result is ignored and the kind stays.
- It never steps down: a feature never becomes lighter on its own, and the owner's `kind` field is
  not overruled by Towercab's inference, only by this escalation.
- Verified by: `kinds: a bugfix that needs a spec becomes a feature`, `kinds: a kind never steps down`

### KND-9 · The owner sees the kind

The kind and how it was chosen are shown on the intent's page and in the pull request, in plain words.

- A kind chip on the card and intent page (`Bugfix`, `Refactor`, `Infra / config`, `Feature`,
  `Spec only`) with `You set this`, `Towercab chose this: <why>` or `Moved up to a feature: <why>`;
  the PR body of each PR the path still makes names the kind in its `## What this does` section.
- Verified by: `ui: the card shows the kind`, `pipeline: PR texts name the kind`

## Out of scope

- A kind chosen by autonomy: `a` never changes the path, only who approves it (AUT-6).
- Lowering a feature to a lighter path after the spec is written.
- Kinds for work the owner starts from the shadow with a different path.

## Decisions

- The default is `feature` because the full path is the safe one: a wrong guess toward a lighter kind
  would skip the spec and the plan the owner may want.
- A bugfix has no plan because its access is the defaults; asking for more mid-build already goes to
  the owner (AUT-27), so no extra gate is needed.
- Refactor and infra keep the plan PR: a refactor's blast radius and an infra change's protected paths
  are what the plan is for.
- The skipped stage is recorded rather than silently absent, so the page and the log say why no spec PR
  was made.
