# Ship

**Status:** Live: SHIP-1..22, SHIP-30..32, SHIP-33..36 · **Prefix:** SHIP

## Purpose

After a merge, Towercab follows the change until it is live, tests the live app end to end, and, when
the change broke it, gets the last good version back and fixes the problem itself. It works with any
platform: it learns what is live and asks for an older version through a small adapter, and it never
deploys anything or touches a server. A repo opts in; without that, a change ends as merged but not
verified live (SHIP-21). Steps only the owner can do are listed in the plan and ticked off in Towercab
(SHIP-17..19); a change is done only once they are done and the live app passes its tests (SHIP-20).

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
- Changed by SHIP-37: `adapter` also accepts `gitlab`, and a GitLab repo's default is `gitlab`. The rest stands.
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
- Both run like the suites (SHIP-9): in the sandbox with the network of [PIP-158](pipeline.md) (the registry list, the plan's grants, the live URL's host and the repo's `ship_network` domains), the secrets, `BASE_URL`,
  `TOWERCAB_ENVIRONMENT`, in the checkout at the shipped commit, 5 minutes each. A non-zero exit of
  `live_command` is pending; of `rollback_command`, a failed rollback.
- Verified by: `ship: command adapter`

### SHIP-6 · Stages after the merge

After its code PR is merged, a mission ships instead of finishing.

- New stages: `deploy` and `e2e` in the order after `merge` and before `done`; `rollback` and `revert`
  are working stages outside the order. All four are phase `code`.
- `code_merged` (build … merge, approval:merge, blocked) → `deploy`; a wait that came out of a ship
  stage keeps seeing its merged PR, so there it is ignored. At `deploy`: `ok` → `e2e`, `red`
  → `rollback`, `skip` → `done`. At `e2e`: `ok` → `done`, `red` → `rollback`. At `rollback`: `ok` →
  `build`, `revert` → `revert`. `revert` leaves only through a wait. [LOOP-3](loop.md)'s tables say so.
- Verified by: `machine: ship transitions`

### SHIP-7 · Waiting for the deploy

After the merge, Towercab waits until the platform says the merge commit is live.

- `deploy` fetches the base branch first, so a `live` block merged after the change was built still
  counts. No `live` block → `skip`. Else the merge commit joins `data.ship.merges`, and `outcome`
  is read every `ci_poll`: live → `ok`; failed → `red` "the deploy failed: <reason>"; `timeout`
  minutes after entering → `red` "not live after <n> minutes".
- Verified by: `ship: deploy waits for the merge commit`, `ship: a failed deploy is red`, `ship: no deploy in time is red`, `ship: a live block merged meanwhile counts`

### SHIP-8 · Every change brings its e2e tests

In an opted-in repo, a change comes with end-to-end tests for what it adds.

- The plan agent gets the suites and their test globs, and its result names the e2e tests it will add
  or says why none is needed (`e2e: {tests, none_why}`). The review agent is told to check that the
  e2e tests cover the new behaviour.
- Gate ([PIP-7](pipeline.md)): a live repo, no changed file under a suite's `tests` globs and no
  `none_why` in the plan → `approval:merge` "The change has no test that runs against the live app."
  A fix round (SHIP-11) is
  exempt: the suite that failed checks the fix once it ships.
- e2e test files need the live app, so they don't count as the change's tests in the red→green proof
  ([PIP-30](pipeline.md)).
- Verified by: `ship: the gate wants an e2e test`, `ship: the plan names its e2e tests`

### SHIP-9 · Running the e2e suites

Once the merge is live, Towercab runs the repo's e2e suites against the live URL.

- In the mission's checkout, detached at the shipped commit: the `setup` block (with the network of PIP-158), then
  each suite's command in the sandbox ([PIP-23](pipeline.md)) with the network of PIP-158 (which includes the live URL's host), `BASE_URL=<url>`,
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
  and `merge_sha` start empty; the replaced PR's number goes to `data.ship.prs`, so the intent page
  still lists it ([UI-124](ui.md)). The fix goes through verify, proof, CI, review and gate as usual.
- At most 2 fixes per mission (`data.ship.fixes`); a third red goes to `revert`.
- Verified by: `ship: rollback starts a fix round`, `ship: two fixes then revert`

### SHIP-12 · Revert

When two fixes didn't hold, Towercab undoes the intent's merges on `main` and hands the intent back.

- Branch `towercab/<intent>-revert` from base with `git revert --no-edit` of every merge of the intent,
  newest first, as the bot; a PR "Revert: <title>" whose body names the merges, the failing suite and
  the log's tail. Towercab merges it once its CI is green (or the repo has none), whatever the
  intent's autonomy: the repo
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
- Changed by SHIP-21: `skip` now ends as merged, not verified live, unless the plan says there is
  nothing to check live; only then it is still `done`. The rest stands.
- Verified by: `ship: no live block means done at merge`

### SHIP-16 · The deploy contract

A public page tells a platform team what to build so Towercab can ship to their platform.

- `docs/deploy-contract.md`: the two adapters and what a platform must do for each (record each deploy
  as a GitHub Deployment with a final status; deploy the commit a `deploy:rollback` Deployment asks
  for; or the two commands), the `live` block, the secrets file, and the worked example of one VPS
  deploying from GitHub Actions over Tailscale. Short sketches for an Argo CD notification hook and for
  Vercel or Fly through the command adapter. The README links it.
- Verified by: manual (read `docs/deploy-contract.md`; the README links it)

### SHIP-17 · Owner steps in the plan

The plan lists every step only the owner can do for the change to work, and says whether it is needed
before the merge or after it.

- The plan agent's result gets `owner_steps`: a list of `{when, text, why}`, `when` = `before` or `after`
  the merge, `text` one action in plain words ("add the `NPM_TOKEN` secret to the repo"), `why` one
  sentence. None needed → an empty list. A step is anything the worker can't do: a secret, an apply, an
  account or a setting on a platform. A step Towercab or CI can do is not one.
- `plan.md` ([PIP-46](pipeline.md)) gets Towercab's `## Your steps` after `## Access`, written like it:
  `- [ ] before merge: <text> (<why>)` and `- [ ] after merge: <text> (<why>)`, numbered by order. No
  steps → no section. A ticked step reads `- [x] … · ticked <RFC3339 time>` (SHIP-22).
- Read from the merged `plan.md` into the mission as `data.steps` (`{n, when, text, why, done_at}`),
  ticks included, so the file is the record and the database a copy of it. A plan that changes later
  (`plan_changed`) keeps the ticks of steps whose text is unchanged.
- Verified by: `ship: the plan lists owner steps`, `ship: steps are read from the merged plan`

### SHIP-18 · Steps before the merge hold the merge

A change whose plan has steps needed before the merge doesn't merge, or ask the owner to, until they
are ticked.

- At the gate ([PIP-7](pipeline.md)), before deciding: any `before` step not ticked → wait
  `your steps first` (blocked), ask "Do these before this change merges." with the unticked steps as a
  checklist in the why. Towercab neither merges nor asks for the merge meanwhile, whatever the intent's
  autonomy.
- Ticking the last one continues at the gate. A reply or `/retry` act as for any blocked wait
  ([LOOP-74](loop.md)).
- Verified by: `ship: the gate waits for steps before the merge`, `ship: ticking the last step continues the gate`

### SHIP-19 · Your steps after the merge

After the merge, the change waits at a "Your steps" stage until the owner has ticked the `after` steps.

- Stage `steps` in the order between `merge` and `deploy` ([LOOP-73](loop.md)). Entered from
  `code_merged` only when an `after` step is unticked; else `deploy` directly. Wait `your steps`, ask
  "Do these so the change works live." with the checklist. Nothing is deployed or applied by Towercab;
  it only waits for the ticks.
- All ticked → `deploy`, which so counts the owner's work (secrets, an apply) as done before the
  live check. A fix round (SHIP-11) doesn't visit `steps` again.
- Verified by: `ship: merge goes to your steps when the plan has after steps`, `ship: no after steps goes straight to deploy`, `ship: a fix round skips your steps`

### SHIP-20 · Done means it works live

A change is done only after its merge, its steps and a green live check.

- Order: merge, `steps` (SHIP-19), `deploy` (SHIP-7), `e2e` (SHIP-9), `done`. The live check is the
  `live` block and its suites; nothing new is run. Rollback and fix rounds are as before
  (SHIP-10..12).
- Verified by: `ship: done only after steps, deploy and e2e`

### SHIP-21 · Merged, not verified live

When a repo can't check live, the change ends as merged and not verified, unless the plan says there is
nothing to check live.

- The plan agent's result gets `live_none_why`: empty by default, else one sentence on why nothing
  about this change can be seen live (docs, CI or tests only). Towercab writes it to `plan.md` after
  `## Your steps` as `Nothing to check live: <why>`, and the review agent is told to check the claim.
  With a `live` block it is ignored: the suites run anyway (SHIP-20).
- `deploy` → `skip` (no `live` block, SHIP-15) → with `live_none_why` set: `done`, as before this
  requirement. Without it: stage `unverified`, terminal like `done` (ignores every event), phase
  `done` ([INT-5](intents.md)). Towercab sets `verified: no` on the intent (with `setField`) and moves
  the folder to `done/` as for `done`. A mission that reaches `done` has no such field.
- Unverified is a successful end: no rollback, no hold ([SHIP-14](ship.md) doesn't apply). It still
  waits for the owner's steps first (SHIP-18, SHIP-19).
- Verified by: `ship: no live block ends unverified`, `ship: nothing to check live ends done`, `ship: unverified marks the intent`

### SHIP-22 · Ticking steps

The owner ticks steps off in Towercab, and the ticks are kept in the plan as well as the database.

- UI action `{action: "step", intent, n, done}` (UI-160) and `towercab step <id> <n…|all>`; both tick a
  step (stored with the time, in one transaction) and the CLI prints the steps left. `done: false`
  unticks one. Refusals: `<id> has no steps`, `step <n> isn't one of <id>'s steps`.
- Each tick is also written to `intents/<id>-<slug>/plan.md` on `main` of the intents repo (SHIP-17's
  line, `[x]` and the time), committed as `towercab: ticked step <n> of <id>` and pushed like other
  plan changes. A failed push is retried on the next pass; the database tick counts meanwhile. If the
  database is lost or rebuilt, the ticks come back from `plan.md`.
- A tick that completes the steps the mission waits for continues it on the next pass; ticks outside
  the wait are stored and counted when the wait comes.
- Verified by: `ship: ticking steps from the CLI`, `ship: ticks outside the wait are kept`, `ship: ticks are written to plan.md`, `ship: ticks survive a rebuilt database`

### SHIP-23 · A tick is never lost

A step the owner ticks while Towercab is reading the plan is still ticked afterwards.

- `refreshSteps` (`src/pipeline/steps.ts`) reads `plan.md` outside the transaction, then re-reads the
  mission inside `Db.tx` and merges: a step ticked in the database since the read stays ticked (with
  its time) unless the file has it ticked too, and `stepsDirty` stays set so the tick is written to
  `plan.md` on the next pass (SHIP-22). Nothing is awaited inside the transaction.
- A step is unticked only by an explicit untick (SHIP-22), never by a refresh.
- Verified by: `ship: a tick during a plan read is kept`

### SHIP-24 · The waiting card lists only open steps

The "your steps" card and its message list the steps still to do, and a comment during the hold doesn't repeat the message.

- The `your steps` wait card and its message (LOOP-74, UI-160) list only the unticked steps of the
  phase waited for; ticked steps are left out. The before-merge hold (SHIP-18) lists its open steps the same way.
- Each pull request comment during the before-merge hold re-checks the hold. A message to the owner is
  queued only the first time, and again only when the set of open steps has changed (a step ticked,
  unticked or added); otherwise nothing is queued.
- Verified by: `ship: the steps card lists only open steps`, `ship: a comment during the hold sends no repeat message`, `ship: a changed set of open steps sends a new message`

### SHIP-25 · The stage map shows an unverified end as passed

A deploy that ends as merged, not verified live shows as passed on the stage map, with its own label, not as sent back.

- In the visits of UI-72, a visit whose move ends in stage `unverified` (SHIP-21) has outcome `passed`
  and `reason` "Merged, not verified live"; the map's node shows that label in place of "passed"
  (UI-73). Moves to `done` stay `passed`; other ends stay `sent back`.
- The UI screenshot test includes the intent page of an unverified intent, with its card and stage map.
- Verified by: `ui: unverified deploy shows as passed with its own label`, `ui: unverified intent screenshot`

### SHIP-33 · A secret is an owner step

A plan can list a secret as an owner step, saying where it goes, what it is for and whether Towercab may make it up.

- `owner_steps` entries (SHIP-17) may carry `secret`: `{repo, file, key, purpose, source}`. `repo` is a
  registered repo (the infra repo), `file` a path in it that is a SOPS file, `key` the name inside the
  file (`[A-Za-z0-9_.-]+`), `purpose` one sentence, `source` = `generate` (random passwords, session
  secrets) or `supply` (third-party tokens, only the owner has them). A `generate` step may also set
  `length` (1–256, default 43) and `alphabet` (`urlsafe` default, `hex`, `alnum`); `supply` steps may not
  (refused like any bad plan result). A step with `secret` has `when`
  as any other; its `text` is derived ("Add `KEY` to `file`") if left empty.
- `plan.md` writes the line as in SHIP-17 plus `· secret <key> in <repo>/<file> (generate|supply)`, with
  `, length <n>` and `, alphabet <a>` inside the brackets when set, before any `· ticked` time. The
  value is never part of the plan, the step or any text the worker produces. A plan listing a secret the
  agent could not name a `file` and `key` for is refused like any bad plan result.
- A secret step is ticked only by SHIP-34 or SHIP-35, never by hand (SHIP-22 refuses with
  `step <n> ticks itself once <key> exists in <file>`).
- Verified by: `ship: the plan lists a secret as an owner step`, `ship: a secret step is not ticked by hand`

### SHIP-34 · Generated secrets are set by Towercab

For a secret Towercab may generate, it creates the value and writes it to the encrypted file in a pull request, and the step ticks itself.

- On each pass while the mission waits on the step (`your steps first`, `your steps`, SHIP-18, SHIP-19),
  the Towercab process, not a worker, creates the value from the system's
  secure random source: by default 43 characters of URL-safe base64 without padding (32 random bytes;
  letters, digits, `-`, `_`), or `length` characters of the step's `alphabet` (`hex` = `0-9a-f`, `alnum` =
  `A-Za-z0-9`, `urlsafe` = `A-Za-z0-9-_`), drawn without modulo bias. It runs `sops set` through `Tools`
  on a clean checkout of the repo's default branch, with the age key from Towercab's own environment. The
  value is passed on stdin or a file Towercab deletes, never on a command line. The commit
  `chore(secrets): add <key> to <file>` goes on a branch `towercab/secret-<id>-<key>` and opens a PR as
  the App; its body names the file, key and purpose, never the value.
- Every secret PR waits for the owner, whatever the repo's own rules, autonomy or review say. The wait
  is the "Your steps" one the mission is already in, so the owner's card for it is that one: the step on
  the intent page shows the PR link and a button "Approve secret <key> for <file>" (UI action
  `{action: "approve-secret", intent, n}`). Only after that click does Towercab merge the PR (squash, as
  the App). Closing the PR without a merge clears the step's progress, and the next pass opens a new PR.
- The step ticks itself once `<key>` exists in `<file>` on the default branch (read from the file's
  plain-text key names, never by decrypting it), and a key that already exists is never overwritten or replaced: the step ticks without a PR or a card.
  Rotating a secret is a separate owner action and is not part of this requirement.
- A failure (no age key, `sops` error, push refused) is logged without the value and retried on a later
  pass. After 3 in a row Towercab stops trying that step; the step on the page shows the reason and a
  "Try again" button (the same action as the approval), which starts the count again.
- Verified by: `ship: a generated secret is set with sops and the step ticks`, `ship: a generated secret defaults to 43 url-safe characters`, `ship: a step sets the length and alphabet of a generated secret`, `ship: a secret PR waits for the owner's approval`, `ship: a secret PR closed unmerged clears the card`, `ship: an existing key is not overwritten`, `ship: a failed secret write is retried then held`

### SHIP-35 · Supplied secrets are typed into Towercab

For a secret only the owner has, the intent page has a field that writes it the same way, and the step ticks itself.

- A `supply` step shows on the intent page ([UI-160](ui.md)) a password-type field with the key, file and
  purpose. UI action `{action: "secret", intent, n, value}`: the server checks the step is an unticked
  secret step of `supply` kind, writes the value as in SHIP-34 (same branch, PR and tick rules), and
  answers `ok` or the refusal. The value is held in memory for that request only; it is not stored in
  the database, the run record, the event log or the browser (the field is cleared on send). The PR it
  opens waits for the owner's approval like a generated one (SHIP-34), so typing the value is followed by
  one click on the step's "Approve secret" button.
- The UI answers only on the loopback address the UI already uses ([UI-1](ui.md)). An empty value, or one
  over 8 KiB, is refused with `<key> needs a value` or `<key> is too long`. A `generate` step has no
  field. There is no CLI command taking the value as an argument.
- The step ticks once the key exists in the encrypted file on the default branch (SHIP-34).
- Verified by: `ship: a supplied secret typed in the UI is set and the step ticks`, `ship: a supplied secret is refused when empty or too long`, `ship: a generate step has no secret field`

### SHIP-36 · A secret value is never seen

No secret value appears in a log, a pull request, a stored record or the worker's sandbox.

- Only the Towercab process holds the age key and the value. The worker's sandbox
  gets neither the key, its file path nor the `sops` binary's configuration: no variable starting with
  `SOPS_` or `AGE_` is passed to a worker or a check, whatever `[agent].env` or a repo's `env` says.
- Every output of `sops` and of the secret write (stdout, stderr, error messages) is redacted of the value
  before it is logged, put in a PR, a comment, a UI message or `runs`. The value reaches `sops` on stdin
  (`sops set --value-stdin`), so it is in no argument list that `Tools` or a process listing could show.
- Verified by: `ship: a secret value is absent from every log line, PR body and run record`, `ship: the worker environment carries no age key`, `ship: sops output is redacted`

### SHIP-30 · Release pull requests are merged

Towercab merges the release pull request that release-please opens, once the work on `main` is green and the release changes only release files.

- Each pass looks, for every registered repo, for an open PR from branch `release-please--branches--<base>`
  (`<base>` is the repo's default branch) authored by `github-actions[bot]`. Repos without one are skipped.
- It merges (squash, as the App) when all hold, and logs `merged release PR #<n> of <repo>`:
  - the latest commit on the default branch has green required checks (the checks branch protection
    requires, or all checks if none are required). Pending or red is not green, and so is a commit
    with no checks at all: a repo that runs no checks on `main` is never green;
  - the PR is up to date with `main`: the PR's merge base with the default branch is the current head
    commit of the default branch, and the green checks above are those of that same commit. Towercab
    reads the head commit once per pass and uses it for both. If `main` has moved ahead, the PR is
    stale: it waits (no card, no edit) for release-please to update the PR, which it does on every
    push to `main`, and is checked again on a later pass;
  - every file in the PR diff is a release file (SHIP-31);
  - the release is a patch or minor one with no breaking change: no package's version in
    `.release-please-manifest.json` gains a higher major number, and the release notes (the PR body and
    the `CHANGELOG.md` lines it adds) have no `⚠ BREAKING CHANGES` section and no entry marked with `!`
    (SHIP-31 holds the rest for the owner). This also holds a breaking 0.x release.
  - the repo's `TOWERCAB.md` front matter does not say `releases: manual`. `releases` is `auto`
    (default) or `manual`, read from the base branch like the other keys ([REPO-1](repo.md)); any other
    value is refused like other bad front matter. A manual repo's release PR is never merged by
    Towercab: it gets the "Needs you" card of SHIP-31 as soon as Towercab sees it.
- The merge request names the PR head commit that was inspected, and the default branch head is read again
  just before it; if either changed, nothing is merged and the next pass starts over.
- The PR's own checks are never awaited: PRs opened with the Actions token run none.
- Towercab never edits the release PR: no pushes, no comments, no body or label changes. It only merges or holds (SHIP-31).
- Not a mission: it needs no intent and does not go through the stages or `machine.apply`. A merge that
  GitHub refuses (conflict, branch rules) is logged with GitHub's reason and retried on a later pass, with
  the "Needs you" card of SHIP-31 after 3 refusals in a row.
- Verified by: `ship: a release PR touching only release files is merged`, `ship: a release PR is merged once main is green`, `ship: a stale release PR waits for main`, `ship: a release PR is merged only against the commit that is green`, `ship: the release PR is never edited`, `ship: a refused release merge is retried then held`

### SHIP-31 · Release pull requests that need a look are held

A release pull request that is not plainly a release, or whose `main` is not green, is left alone, and the owner sees a card when it needs them.

- Release files: `CHANGELOG.md`, `.release-please-manifest.json`, and version files: `package.json`,
  `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `version.txt`, plus every path in
  the `extra-files` of `release-please-config.json`, read from the default branch (never from the PR).
  There is no per-repo list in Towercab. `go.mod` is not a version file. In a version file the changed
  lines may touch only the version, and only the versions the release bumps: the ones its
  `.release-please-manifest.json` diff names (without a manifest in the diff, one old and one new
  version in all version files together). A dependency's `version` line in a lock file therefore holds
  the PR. In an `extra-files` file every changed line must name such a version. Any other file or
  changed line in the diff → held.
- A major release or a release with a breaking change (see SHIP-30) is held the same way, with the
  card's why saying "Major release <old> → <new>." or "Breaking change: <entry>". Patch and minor
  releases without one merge on their own.
- A repo with `releases: manual` gets the card at once, whose why says "This repo merges its releases
  by hand." (the card's title names the repo). It still clears as below; Towercab does not merge,
  comment on or edit the PR.
- A `TOWERCAB.md` that doesn't parse (a mistyped `releases: Manual`, or any other front matter error)
  holds the PR with a "Needs you" card at once, whose why names the error. It is never read as `auto`,
  because it might hide `releases: manual`.
- Release files and `releases` are read from the default branch. A failed read (anything but "not
  found") is an error, never "no file": the pass for that repo stops, the held card and its 24-hour
  clock stay as they were, and GitHub is reported unreachable.
- `main` red, pending or without checks → held; the PR is looked at again each pass and merges when
  `main` turns green. No card at first.
- A PR that is stale (SHIP-30) is held like a red `main`, and the same 24 hours apply; its card says
  "It is behind main and release-please has not updated it."
- Held for 24 hours (from when Towercab first saw the PR held for this reason) → a "Needs you" card
  titled "Release PR #<n> of <repo> has waited a day", whose why names the checks: the red or pending
  ones by name, or "This repo runs no checks on main."
- A diff with other files, or a major release → a "Needs you" card at once (`{kind: "release", repo, pr}`),
  titled "Release PR #<n> of <repo> needs you", whose why lists the extra files or the major jump.
- A card clears when the PR is merged or closed, or when what held it no longer applies (the diff is
  release files only, `main` is green, or for the owner's decision on a major release, the owner merges
  it by hand). Towercab never merges a major release itself.
- Verified by: `ship: a release PR touching other files is held`, `ship: a release PR is held while main is red`, `ship: a release PR is held while main has no checks`, `ship: a major release is held for the owner`, `ship: a breaking 0.x release is held for the owner`, `ship: a breaking change in the release notes is held`, `ship: a manual repo's release PR is a Needs you card`, `ship: releases defaults to auto`, `ship: a minor release is merged`, `ship: extra-files of the release config count as release files`, `ship: go.mod is not a release file`, `ship: a release PR held for 24 hours gets a card naming the checks`, `ship: a held release PR is a Needs you card`, `ship: the card clears when the PR is merged or closed`

### SHIP-32 · Published means the release exists

A change counts as published only once the release that contains its merge exists, and the intent page links to that release.

- After an intent's merge (stage `done`, `unverified`), the mission gets the release that contains its
  merge commit: the first GitHub release of the repo whose tag commit descends from it. Towercab reads
  it on each pass until found; it adds no stage and does not hold the mission or its folder move.
- At most 5 missions are looked up per pass, so a backlog of old ones is worked off over several
  passes. If the oldest of the 100 latest releases already contains a merge (the first release is older
  than that), no release line is shown for it rather than a wrong tag.
- The lookup is cheap: it asks GitHub whether the newest of the latest 100 releases contains the merge
  (one call), remembers the answer for that release, and asks again only when a newer release appears;
  once the newest contains it, a binary search over the releases finds the first one.
- The release is stored on the mission (`release`: tag and URL). The intent page shows "Published in
  <tag>" with the link; until then it shows "Merged, waiting for a release".
- A repo with no release-please files ([REPO-23](repo.md)) has no release to wait for: the line is not shown.
- Verified by: `ship: published links the release containing the merge`, `ship: merged shows waiting for a release`, `ship: repos without release-please show no release line`

### SHIP-37 · The gitlab adapter

A GitLab repo's ship stage reads what GitLab recorded for its environment, and asks for an older version by retrying the project's own deploy job.

- `live.adapter: gitlab` is the default when the repo is a GitLab project ([GL-3](gitlab.md)); `github` stays the default for a GitHub repo. `gitlab` on a GitHub repo, or `github` on a GitLab repo, makes `TOWERCAB.md` invalid (`live: the gitlab adapter is for GitLab repos`, `live: the github adapter is for GitHub repos`). `command` works on either.
- Calls go through the GitLab forge ([GL-5](gitlab.md)) with the token of [GL-2](gitlab.md), over `GET /projects/:id/deployments?environment=<e>&order_by=id&sort=desc` (up to 30). Each deployment has `status`, `sha` and `deployable` (the job: `id`, `status`, `failure_reason`).
- `current()`: the `sha` of the newest deployment in the environment whose `status` is `success`, or none.
- `outcome(sha)`: the newest deployment of that `sha`: `success` → live; `failed` → failed with the job's `failure_reason` (for example `script_failure`), else "the deploy job failed"; anything else → pending. With no success for `sha`, `current()` being `sha` or containing it (`git merge-base --is-ancestor` in Towercab's clone after a fetch, authenticated as [GL-2](gitlab.md)) → live.
- `rollback(ask)`: finds the newest deployment of `ask.sha` in the environment whose `status` is `success` and retries its job (`POST /projects/:id/jobs/:job_id/retry`); the new job's id is returned. No such deployment → the rollback fails with "no successful deployment of <sha> in <environment> to run again". A retry the step already made (a deployment of `ask.sha` created after `ask.since`) is reused, so a crash never retries twice. A 403 → the rollback fails with "Towercab's GitLab token needs permission to run jobs in the <environment> environment". A retry GitLab refuses because the job is outdated (the project setting "Prevent outdated deployment jobs") fails the rollback with "GitLab refused to re-run the deploy job of <sha> because the setting Prevent outdated deployment jobs is on: turn it off for the <environment> environment".
- It only reads deployments and retries a job the project's pipeline defines: no pipeline is created, no variable set, nothing deployed ([SHIP-3](#ship-3--the-adapter) still holds).
- Verified by: `ship: gitlab adapter reads deployments`, `ship: gitlab adapter retries the deploy job once`, `ship: a failed gitlab deploy reports the job's reason`, `ship: gitlab is the default adapter of a GitLab repo`, `ship: gitlab adapter on a GitHub repo is invalid`

### SHIP-38 · A deploy waiting for approval is pending

A deploy that waits for a person to approve it on a protected GitLab environment is not a failure, and the wait says who has to act.

- A deployment with `status` `blocked` is pending, and `outcome` carries the reason "the deploy is waiting for approval: a person has to approve it in GitLab (<environment>)". The reason shows in the wait on the intent page and in the message the deploy wait sends once it has lasted 5 minutes ([SHIP-7](#ship-7--waiting-for-the-deploy)).
- Towercab never approves a deployment itself. The usual timeout of [SHIP-7](#ship-7--waiting-for-the-deploy) applies: unapproved after `timeout` minutes → `red` "not live after <n> minutes", with the same reason added.
- Verified by: `ship: a gitlab deploy waiting for approval is pending with the reason`, `ship: a gitlab deploy never approved times out with the reason`

### SHIP-39 · The deploy contract for GitLab

The deploy contract page tells a GitLab team what their deploy job must do.

- `docs/deploy-contract.md` gains a GitLab section: the deploy job needs `environment:` with the same name as the `live` block's `environment`; it deploys `CI_COMMIT_SHA`; rolling back re-runs an older successful job, so that job must deploy the commit it was run for and not "latest"; a protected environment with required approval makes the deploy wait for a person ([SHIP-38](#ship-38--a-deploy-waiting-for-approval-is-pending)); the token's role must be allowed to run that environment's jobs. The section tells teams to allow re-running older deploy jobs: the project setting that blocks outdated deployment jobs ("Prevent outdated deployment jobs") must be off for the environment Towercab rolls back. A short `.gitlab-ci.yml` example.
- Verified by: manual (read the GitLab section of `docs/deploy-contract.md`)

## Out of scope

- Database migrations: a rollback only swaps the version. The review asks for backward-compatible
  migrations where that is possible, but doesn't block on it. Migration-aware rollback is parked
  (intent 261030-0401).
- Staging and preview environments before production (parked, intent 261030-0401-2).
- Watching the live app after green, alerts and incidents: the AI SRE (parked, intent 261030-0401-3).
- A release gate and rollback rehearsals (v1's PIP-34, PIP-35). `/release` only reports what the ship
  stage is doing ([PIP-45](pipeline.md)); it starts nothing.
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
