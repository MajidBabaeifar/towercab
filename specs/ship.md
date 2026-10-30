# Ship

**Status:** Draft · **Prefix:** SHIP

## Purpose

After a merge, Towercab follows the change until it is live, tests the live app end to end, and, when
the change broke it, gets the last good version back and fixes the problem itself. It works with any
platform: it learns what is live and asks for an older version through a small adapter, and it never
deploys anything or touches a server. A repo opts in; without that, merged means done, as before.

## Requirements

### SHIP-1 · The live block

A repo opts into the ship stage with a `live` block in its `TOWERCAB.md`.

- Front matter key `live` ([REPO-1](repo.md)), a mapping:
  - `url`: the app's public `https://` URL (required);
  - `environment`: the deploy environment to watch (default `production`);
  - `adapter`: `github` (default) or `command` (SHIP-5), which also needs `live_command` and
    `rollback_command` (one shell line each);
  - `timeout`: minutes to wait for a deploy, 1–120 (default 20);
  - `suites`: one or more e2e suites, each with `name` (`[a-z0-9-]+`, unique), `command` (one shell
    line), `tests` (globs where its e2e tests live, at least one), optional `paths` (source globs that
    make it relevant) and optional `smoke: true` (run after a rollback, SHIP-10).
- Anything else, or a missing required field, makes `TOWERCAB.md` invalid (`live: <why>`), and the
  intent waits on `fix repo files`. `TOWERCAB.md` is protected ([REPO-8](repo.md)), so a worker can't
  change the block.
- Verified by: `repo: live block`, `repo: live block errors`

### SHIP-2 · Secrets for the e2e tests

Secrets the tests need, such as a test login, live outside every repo in one file per repo that only
the owner can read.

- `<config dir>/secrets/<repo>.env` (default `~/.config/towercab/secrets/<repo>.env`): `KEY=VALUE`
  lines, `#` comments and blank lines skipped. Any group or other permission bit set → the stage waits
  on `fix repo files` with "<path> is readable by others; chmod 600 it". No file = no secrets.
- The values go only into the environment of the suites and the adapter's commands. Every log Towercab
  keeps or shows from them has each value of 4 or more characters replaced with `[redacted]`. They never
  reach a worker, a prompt, a PR, a comment or a message.
- Verified by: `ship: secrets file must be private`, `ship: secrets are redacted from logs`

### SHIP-3 · The adapter

Towercab talks to the platform through an adapter with three questions and one request, so any
platform can be wired in.

- `current()`: the commit live in the environment now, or none. `outcome(sha)`: whether `sha` is live
  (`live`), failed to deploy (`failed`, with the platform's reason) or not yet (`pending`); a newer
  live commit that contains `sha` counts as `live`. `rollback(sha, reason)`: ask the platform to make
  `sha` live.
- Towercab never runs a deploy itself, holds no server credential and never connects to a server.
- Verified by: `ship: adapters answer the same questions`

### SHIP-4 · The github adapter

The default adapter reads and creates GitHub Deployments on the app's repo, as Towercab's App.

- `current()`: the newest Deployment in the environment (`GET repos/<r>/deployments?environment=<e>`,
  up to 30) whose latest status (`…/deployments/<id>/statuses?per_page=1`) is `success`; its `sha`.
- `outcome(sha)`: the newest Deployment of that `sha` in the environment: latest status `success` →
  live, `failure` or `error` → failed with its description, anything else → pending. With no success
  for `sha`, `current()` containing `sha` (`git merge-base --is-ancestor` in Towercab's clone after a
  fetch) → live.
- `rollback(sha, reason)`: `POST repos/<r>/deployments` with `ref` = sha, the environment,
  `task: deploy:rollback`, `auto_merge: false`, `required_contexts: []`, a description and
  `payload: {intent, from, reason}`. A Deployment the step already created (same sha and
  `payload.intent`, after the step was recorded) is reused, so a crash never asks twice. A 403 → the
  rollback fails with "Towercab's GitHub App needs read and write access to Deployments".
- The platform's side of this contract is in `docs/deploy-contract.md` (SHIP-16).
- Verified by: `ship: github adapter reads deployments`, `ship: github adapter asks for a rollback once`

### SHIP-5 · The command adapter

A platform that doesn't react to GitHub Deployments is wired in with two commands.

- `live_command` prints the live commit; the first 40-hex word of its output is `current()`.
  `outcome(sha)` is live when that commit is `sha` or contains it, else pending (such a platform is
  red only by the timeout). `rollback_command` runs with `TOWERCAB_ROLLBACK_SHA` and
  `TOWERCAB_REASON`; exit 0 means the request was taken.
- Both run like the suites (SHIP-9): in the sandbox with network, the secrets, `BASE_URL`,
  `TOWERCAB_ENVIRONMENT`, in the checkout at the shipped commit, 5 minutes each. A non-zero exit of
  `live_command` is pending; of `rollback_command`, a failed rollback.
- Verified by: `ship: command adapter`

### SHIP-6 · Stages after the merge

After its code PR is merged, a mission ships instead of finishing.

- New stages: `deploy` and `e2e` in the order after `merge` and before `done`; `rollback` and `revert`
  are working stages outside the order. All four are phase `code`.
- `code_merged` (build … merge, approval:merge, blocked) → `deploy`. At `deploy`: `ok` → `e2e`, `red`
  → `rollback`, `skip` → `done`. At `e2e`: `ok` → `done`, `red` → `rollback`. At `rollback`: `ok` →
  `build`, `revert` → `revert`. `revert` leaves only through a wait. [LOOP-3](loop.md)'s tables say so.
- Verified by: `machine: ship transitions`

### SHIP-7 · Waiting for the deploy

After the merge, Towercab waits until the platform says the merge commit is live.

- `deploy`: no `live` block → `skip`. Else the merge commit joins `data.ship.merges`, and `outcome`
  is read every `ci_poll`: live → `ok`; failed → `red` "the deploy failed: <reason>"; `timeout`
  minutes after entering → `red` "not live after <n> minutes".
- Verified by: `ship: deploy waits for the merge commit`, `ship: a failed deploy is red`, `ship: no deploy in time is red`

### SHIP-8 · Every change brings its e2e tests

In an opted-in repo, a change comes with end-to-end tests for what it adds.

- The plan agent gets the suites and their test globs, and its result names the e2e tests it will add
  or says why none is needed (`e2e: {tests, none_why}`). The review agent is told to check that the
  e2e tests cover the new behaviour.
- Gate ([PIP-7](pipeline.md)): a live repo, no changed file under a suite's `tests` globs and no
  `none_why` in the plan → `approval:merge` "no e2e test for the change".
- e2e test files need the live app, so they don't count as the change's tests in the red→green proof
  ([PIP-30](pipeline.md)).
- Verified by: `ship: the gate wants an e2e test`, `ship: the plan names its e2e tests`

### SHIP-9 · Running the e2e suites

Once the merge is live, Towercab runs the repo's e2e suites against the live URL.

- In the mission's checkout, detached at the shipped commit: the `setup` block (with network), then
  each suite's command in the sandbox ([PIP-23](pipeline.md)) with network, `BASE_URL=<url>`,
  `TOWERCAB_SHA` and the secrets, `check_timeout_min` each.
- Order: suites whose `tests` globs match a file the intent's merges added or changed, then suites
  whose `paths` match a changed file, then the rest, each group in file order.
- A red suite runs once more. Red twice → `red` naming the suite, with its log
  (`runs/<intent>/e2e/<n>-<suite>.log`, redacted).
- All green → `ok`, and the shipped commit becomes the repo's last good version.
- Verified by: `ship: suites run in order against the URL`, `ship: a red suite runs once more`, `ship: green records the last good version`

### SHIP-10 · Rollback

When the change is broken, Towercab asks the platform for the last good version and checks it.

- Target: the repo's last good version, or before any green run, the first parent of the intent's
  first merge. When `current()` is already the target (the platform's own health check put it back),
  no request is made; else `rollback(target, reason)`.
- Then it waits for `current()` to be the target, like SHIP-7, and runs the smoke suites once each
  (`smoke: true`, or every suite when none is marked).
- Green → a fix (SHIP-11), or after two fixes a revert (SHIP-12). A refused request, a failed or late
  deploy, or a red smoke suite → `rollback failed` (SHIP-13).
- Verified by: `ship: rollback asks for the last good version`, `ship: no request when it is already back`, `ship: a failed rollback freezes the repo`

### SHIP-11 · Fix forward

After a rollback, the worker fixes the cause in a new PR on top of `main`, and that PR ships like any
other.

- `rollback` → `build` with a repair (`kind: e2e`): which suite failed against which URL after which
  commit went live, that the app is back on the last good version, and the suite's log. The worker
  keeps its session ([PIP-13](pipeline.md)), on a new branch `<branch>-fix<n>` from base; `pr`, `head`
  and `merge_sha` start empty. The fix goes through verify, proof, CI, review and gate as usual.
- At most 2 fixes per mission (`data.ship.fixes`); a third red goes to `revert`.
- Verified by: `ship: rollback starts a fix round`, `ship: two fixes then revert`

### SHIP-12 · Revert

When two fixes didn't hold, Towercab undoes the intent's merges on `main` and hands the intent back.

- Branch `towercab/<intent>-revert` from base with `git revert --no-edit` of every merge of the intent,
  newest first, as the bot; a PR "Revert: <title>" whose body names the merges, the failing suite and
  the log's tail. Towercab merges it once its CI is green, whatever the intent's autonomy: the repo
  opted into rollback with its `live` block.
- Then it waits for the revert's commit to be live (SHIP-7) and runs the smoke suites. Green → wait
  `rolled back, revise`, naming the failing suite and its log. A revert conflict, red or stuck CI, a
  failed or late deploy, or a red smoke suite → `rollback failed`.
- Verified by: `ship: revert undoes every merge and hands back`, `ship: a red revert freezes the repo`

### SHIP-13 · A failed rollback freezes the repo

When getting back to a good version fails, nothing more merges in the repo until the owner has looked.

- Wait `rollback failed` (blocked), ask "Rolling back failed. Nothing more merges in this repo until you
  fix it.", with the why saying what failed. The hold (SHIP-14) lasts while the mission waits there.
  An answer continues at `build` with it in the prompt; `/retry` starts over; `drop` ends it.
- Verified by: `ship: a failed rollback freezes the repo`

### SHIP-14 · One ship at a time

While a change ships, rolls back or is being fixed, nothing else merges in its repo.

- At the gate ([PIP-7](pipeline.md)), before deciding: another unfinished mission of the same repo at
  `deploy`, `e2e`, `rollback` or `revert`, in a fix round, or waiting on `rollback failed` → stay at the
  gate, read again after 60 s, why "repo on hold: <intent> is shipping".
- Verified by: `ship: the gate holds while another change ships`

### SHIP-15 · Without a live block nothing changes

A repo without a `live` block works as before: merged means done.

- `deploy` → `skip` → `done`; no adapter call, no suite, no hold.
- Verified by: `ship: no live block means done at merge`

### SHIP-16 · The deploy contract

A public page tells a platform team what to build so Towercab can ship to their platform.

- `docs/deploy-contract.md`: the two adapters and what a platform must do for each (record each deploy
  as a GitHub Deployment with a final status; deploy the commit a `deploy:rollback` Deployment asks
  for; or the two commands), the `live` block, the secrets file, and the worked example of one VPS
  deploying from GitHub Actions over Tailscale. Short sketches for an Argo CD notification hook and for
  Vercel or Fly through the command adapter. The README links it.
- Verified by: manual (read `docs/deploy-contract.md`; the README links it)

## Out of scope

- Database migrations: a rollback only swaps the version. The review asks for backward-compatible
  migrations where that is possible, but doesn't block on it. Migration-aware rollback is parked
  (intent 261030-0401).
- Staging and preview environments before production (parked, intent 261030-0401-2).
- Watching the live app after green, alerts and incidents: the AI SRE (parked, intent 261030-0401-3).
- A release gate, rollback rehearsals and `/release` (v1's PIP-34, PIP-35; `/release` stays reserved,
  [PIP-45](pipeline.md)).
- Changes merged by hand outside Towercab: they ship by the platform, but Towercab doesn't test them.

## Decisions

- Towercab never deploys: deploying is the platform's job, and keeping Towercab on GitHub alone lets a
  company plug in any platform without giving Towercab server access.
- GitHub Deployments are the default contract: they need no endpoint or shared secret between Towercab
  and the platform, keep an audit trail, and many platforms already write them. The command adapter
  covers the rest; an HTTP webhook adapter can come later.
- Fix forward before revert: a rollback brings the app back at once, so the worker has time to fix the
  cause properly, and a revert is the fallback after two tries.
- The hold is Towercab-wide per repo, not per file: a ship is short, and knowing exactly what to roll
  back to matters more than a few minutes of waiting.
- Suites are plain commands: Towercab doesn't know whether a test drives a browser or calls an API, so
  the same stage works for a backend, a frontend or both.
