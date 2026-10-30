# Loop

**Status:** Live: LOOP-1..42, LOOP-60..69 · **Prefix:** LOOP

## Purpose

Towercab is one long-running program on the owner's machine. Code owns every step, wait, poll and
recovery; Claude Code (`claude -p`) runs only where judgment is needed ([pipeline.md](pipeline.md)).
It survives crashes, restarts and usage limits without losing work, tells the owner only what needs
them, and updates itself when its own code changes.

## Requirements

### LOOP-1 · Program, home and config

Towercab is a TypeScript program run by Node from a git checkout, with its state in one home folder
and its settings in one TOML file.

- Runtime: Node ≥ 22.18 (native TypeScript type stripping, built-in `node:sqlite`), no build step for
  the program; the UI is built by Vite (UI-55). Entry: `bin/towercab` → `src/cli.ts`.
- Home (`--home` > `TOWERCAB_HOME` > `~/.local/share/towercab`, created 0700): `towercab.db`
  (LOOP-37), `towercab.lock`, `towercab.log`, `intents/` (INT-1), `repos/<name>/` (clones, LOOP-8),
  `work/<id>-<attempt>/` (checkouts), `runs/<id>/` (run files), `cache/<repo>/` (LOOP-34).
- Config: `~/.config/towercab/config.toml` (`--config`, `TOWERCAB_CONFIG`), parsed with `smol-toml`.
  Sections and defaults in **Config**. Unknown keys are ignored. A wrong type or range →
  `config: <file>: <section>.<key> <what>`, exit 1. `run` and `up` also need `[github]` and at least
  one repo (LOOP-65).
- Verified by: `config: loads defaults`, `config: bad values name the key`, `home: layout`

### LOOP-2 · Service

`towercab up` installs and starts a systemd user service that runs the loop from this checkout.

- `up` writes `~/.config/systemd/user/towercab.service` (**Unit**, `ExecStart=<checkout>/bin/towercab
  run --watch`), then `systemctl --user daemon-reload` and `enable --now`. `down` = `disable --now`
  (missions stay). `restart` = `systemctl --user restart towercab` (a few seconds: no build).
  `logs` execs `journalctl --user -u towercab -f`. A failing `systemctl` → exit 1 with its stderr.
- Verified by: `service: unit file`, `service: up, down, restart, logs`

### LOOP-3 · State machine

Every mission moves through one fixed set of stages, and one table decides every move.

- A mission is one attempt at one intent. Stages (`src/machine.ts`): the order `pick → design →
  plan → build → verify → proof → publish → ci → review → gate → merge → deploy → e2e → done`,
  the ship stages outside the order `rollback` and `revert` ([SHIP-6](ship.md)), the waits
  `approval:spec`, `approval:plan`, `approval:merge` (the owner merges a PR) and `blocked` (any other
  wait), and `stopped`. Events and the table: **Transitions**. Only `apply(mission, outcome)` moves a
  mission; `done` and `stopped` ignore every event.
- Phase (the intent's `stage` field, [INT-5](intents.md)): pick, design, approval:spec → `spec`;
  plan, approval:plan → `plan`; build … e2e, rollback, revert, approval:merge → `code`; `blocked` keeps the phase it
  came from; `done` → `done`; `stopped` by a closed PR or `drop` → `dropped`.
- Verified by: `machine: every stage and event pair is defined`, `machine: order`, `machine: continue after an answer`, `machine: ship transitions`

### LOOP-4 · How much runs at once

At most `[agent].parallel` Claude runs or checks at a time; per repo, `ahead` intents before build
(LOOP-60) and `workers` in build (LOOP-61).

- A slot is a child process that does work (a Claude run, setup, checks, screenshots); git and gh
  calls don't take one. Per repo, at most `[repos.<r>].ahead` (default 3) intents are ahead of build and
  at most `[repos.<r>].workers` (default 1) build through merge; the rest wait (LOOP-60, LOOP-61).
  An intent has at most one unfinished mission.
- A free slot goes first to unfinished missions in priority order, then to a new pick, so a PR
  waiting on the owner never stops other repos.
- A run asked for while every slot is taken waits and is asked for again; it starts later with its
  own prompt, as if new. Only a run that really started (`data.launched` = its step, set when the
  child starts, cleared by a new step or stage) resumes with `Continue where you stopped.`
  (LOOP-7), and a session counts as used (`session_used`) only once a
  run of it has started.
- Verified by: `loop: picks while others wait`, `loop: one intent builds at a time per repo`, `loop: one mission per intent`, `loop: a run that waits for a slot keeps its prompt`

### LOOP-5 · Pick

The loop starts the highest-priority intent that can run.

- `decide(listing, state)` (pure, also behind `next`): the picker's list ([PRI-5](priority.md)),
  skipping: parked, paused, a repo with `ahead` intents ahead (LOOP-60), the model cooling down (LOOP-9), GitHub or Claude
  unreachable (LOOP-10). An intent whose repo Towercab doesn't know (LOOP-65) gets `waiting: unknown repo`; one
  whose `after` names an unknown, dropped or cyclic intent gets `waiting: bad after:`.
- Picked → one transaction inserts the mission: `attempt` = last + 1, a new session uuid, `model` =
  the intent's `model` or `[agent].model`, `a_at_pick`, checkout `work/<id>-<attempt>`, branch
  `towercab/<id>-<slug>` (attempt ≥ 2: `-<attempt>` appended). The pick step fetches the clone, loads
  the repo files ([REPO-1](repo.md); none → `waiting: add CLAUDE.md verifying block`, invalid →
  `waiting: fix repo files`) and makes the checkout.
- An intent with a `stage` but no unfinished mission and no `waiting` (for example after a crash)
  loses its `stage` and is picked again.
- Verified by: `pick: order and skips`, `pick: parked waits`, `pick: bad after`, `pick: unknown repo`, `pick: orphaned stage is cleared`

### LOOP-6 · Durable steps

Before any side effect, a handler records what it is about to do, so a crash never repeats or loses
a step.

- `apply` writes a move in one SQLite transaction: the mission's `stage`, `step = 'enter'`, the
  outcome's columns, `waiting`, `why`, a `transitions` row and its outbox row (LOOP-14). The loop
  then runs the entry effects (idempotent: the intent's lifecycle fields, a PR comment) and sets
  `step = ''`.
- `ctx.record(mission, step, set)` stores the step and the IDs it will use (session, branch, head, PR
  number) in one transaction before the Claude run, push, PR, merge or intent write it guards. A
  re-entered step first checks what already happened: an open PR for the branch, a merge commit, a
  pushed head.
- Verified by: `loop: a crash at every durable write still ends done once`

### LOOP-7 · Crash and restart

After a crash or restart, every mission continues from its recorded step, and a cut-off Claude run
resumes its own session.

- `meta.running` = `<pid> <start>` while the loop runs; found at start → the last exit was unclean:
  leftover child process groups are killed, and every mission that was busy gets `unclean + 1`
  (3 in a row → `waiting: crashed at <stage>`).
- Sessions: the uuid is chosen at pick; the session's first run gets `--session-id <uuid>`, later
  ones `--resume <uuid>` from the same checkout; after a cut-off the prompt is `Continue where you
  stopped.` A missing session (`No conversation found with session ID`) → a new uuid and a prompt
  naming the branch, PRs, `intent.md`, spec IDs and `plan.md`.
- SIGTERM or SIGINT: SIGTERM to each child's group, SIGKILL after 10 s, `interrupted` for its mission
  (not counted), `meta.running` removed, exit 0.
- Verified by: `loop: resume after kill`, `loop: missing session starts fresh`, `loop: SIGTERM is not counted`, `loop: three crashes wait for the owner`

### LOOP-8 · Clones and checkouts

Towercab keeps its own clone of each repo and a separate checkout per mission, and runs nothing from
a checkout's `.git`.

- Clone: the repo's `path` (LOOP-65; default `<home>/repos/<r>`), cloned from `https://github.com/<github>.git`
  when missing; only fetched into and pushed from.
- Checkout `work/<id>-<attempt>`: made in a `.tmp` folder and renamed into place; `git clone
  --no-checkout <clone>`, origin removed, base fetched by path, `git checkout -B <branch>
  refs/remotes/origin/<base>`. Every git call there uses `-c core.hooksPath=/dev/null
  -c core.fsmonitor=false`, and Towercab's own git there first checks the `.git/config` holds only
  plain keys. `pick` always makes it fresh, replacing whatever is at that path (a crashed pick's, or
  an older Towercab's with the same `<id>-<attempt>`); later stages keep it until the mission is done,
  stopped or replaced.
- The checkout is Towercab's alone: each build round first runs `git reset --hard` and `git clean -fd`,
  so a file another program left there (an untracked file, an edit) can't block the checkout of base
  or ride into the PR. Ignored files, such as caches, stay.
- Verified by: `checkout: kept across steps`, `checkout: pick replaces a leftover`, `checkout: has no remote`, `checkout: a planted git config is refused`, `pipeline: a build round starts from a clean checkout`

### LOOP-9 · Usage limits

When Claude hits a usage limit, the mission waits for the reset and resumes the same step; other
models keep working.

- `detectLimit(text)` (case-insensitive): `rate.?limit|usage.?limit|hit your limit|limit reached|
  limit will reset|quota|too many requests|\b429\b|overloaded|rate_limit_error|overloaded_error`.
- `parseReset(text, now)`: the first rule that matches wins: epoch `|1760540400`; `retry-after: N`
  seconds; `try again|retry|resets? in N unit [N unit]`; RFC 3339 or `YYYY-MM-DD HH:MM[:SS][zone]`;
  `resets [at|on] [<Mon> <day>,] <h>[:mm] [am|pm] [(<IANA zone>)]` (needs am/pm, minutes or a date;
  a past clock time → tomorrow; a past date → next year). None → backoff 1, 2, 4 … 60 min.
- A cooldown per model (`until` = reset + 30 s) is kept in `meta`; the mission keeps its step and
  re-enters it after `until` with `Continue where you stopped.` (a review starts a fresh session
  instead, PIP-13). A limit wait is never a crash, a repair or a timeout. The first success on a model resets its backoff.
- Verified by: `limits: reset formats`, `limits: resume the same step`, `limits: other models run`, `limits: past reset backs off`

### LOOP-10 · Network and auth failures

A failed network or login call is retried with backoff and never stops the loop.

- `classifyFailure(stderr)`: network (DNS, refused, reset, timeout, TLS, HTTP 5xx) or auth (HTTP 401,
  `Bad credentials`, Claude's `/login`, git's `remote: Repository not found`, which is how GitHub
  refuses a token on a private repo). Every git and `gh` failure in the pipeline goes through it. A step that hits one retries after 30, 60, 120, 240, then
  300 s; a Claude run resumes its session.
- Health (in memory): per kind `github`, `claude`, `tool:<exe>`, `sandbox`, open from the first
  failure to the next success. Open for 15 minutes → picks pause, one message names the fix, the UI
  shows it under Problems. Calls are bounded: `gh` 120 s, `git` 300 s.
- A worker's output that shows a broken environment (the sandbox didn't start, `command not found`)
  is that fault, not a question for the owner.
- Verified by: `faults: classify`, `faults: a blip keeps looping`, `faults: one message after 15 minutes`, `faults: a missing tool is a fault`

### LOOP-11 · Stay awake

The machine doesn't sleep while Towercab is actively working.

- While any mission is in a working stage (not waiting on the owner, not in a limit wait), one child
  `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=Towercab --why=<id> <stage> --mode=block
  sleep infinity`; killed when nothing is driven and at shutdown.
- Woke from suspend (the wall clock ran ahead of the monotonic clock by more than 3 passes) → every
  poll is due at once and no wait timeout fires before its poll.
- Verified by: `awake: inhibit while driving`, `awake: wake re-polls before timeouts`

### LOOP-12 · The pass

Every 5 seconds the loop does one pass: read inputs, move missions, start work, send messages.

- Order: signals; wake check; apply `commands`; finished children → their handler; entry effects
  due; child timeouts; due polls (intents every 60 s when `main` moved, PRs every 60 s, GitHub issues every
  300 s, [INT-21](intents.md), CI every `ci_poll`); step due missions; pick; self-update check (LOOP-35); outbox; inhibitor.
- Children (`src/child.ts`): own process group, env cleared then set, stdin from a file or
  `/dev/null`, stdout and stderr to files in `runs/<id>/`; a timeout (the step's budget minus the run
  time already spent) sends SIGTERM to the group, SIGKILL 10 s later.
- Verified by: `loop: polls while a child runs`, `loop: cadence`, `loop: timeout kills the group`

### LOOP-13 · status and next

`towercab status` and `towercab next` print what is happening in plain lines, with or without a
running loop.

- `status`: running or not (paused, problems), active work (intent, stage, model, since), waiting on
  the owner (with the ask and the PR), waiting on CI, queued, cooling models, open problems, next.
  `next`: the intent the picker would take and why, then each skipped one with its reason.
- Verified by: `status: shows each section`, `status: next explains skips`

### LOOP-14 · Messages only when the owner must act

Towercab sends a Telegram message only when the owner has to do something, and each says what, on
which intent, with a link.

- Every wait on the owner (**Waits**) writes one outbox row in its move's transaction (key: mission,
  wait, `continued`), so each new wait sends once. Text: the ask in one sentence, `<title> (<repo>)`,
  the reason when there is one, and the link (the PR, else the intent page in the UI, else the
  intent file). Also: GitHub or Claude unreachable for 15 minutes; a self-update that failed.
- Never on: done, merges, limits, a PR the owner closed. A queued message whose wait is over is
  dropped.
- Verified by: `outbox: only actionable messages`, `outbox: every wait has a text`, `outbox: an obsolete message is dropped`

### LOOP-15 · Commands

The CLI covers running the service and the few actions that have no GitHub gesture.

- `up`, `down`, `restart`, `logs` (LOOP-2); `run [--watch] [--intent <id>]`; `status`, `next`
  (LOOP-13); `add` ([INT-2](intents.md)); `answer <id> <text>` (LOOP-38); `start <id>` (LOOP-63); `retry <id>` (a fresh
  attempt); `drop <id>` ([PRI-9](priority.md)); `approve <id>` (merges the PR the intent waits on, as
  the owner, LOOP-38); `pause`, `resume`; `repo add | remove | set | list` (LOOP-66, LOOP-67, LOOP-69); `ui` (opens
  the page); `doctor`; `update` (LOOP-35);
  `hook guard <rules>` (internal, [PIP-29](pipeline.md)); `--version`.
- One loop per home: a lock file; a second `run` → `towercab is running (pid N): towercab down
  first`. `answer`, `retry`, `drop`, `start`, `pause` and `resume` insert a `commands` row the loop applies on
  its next pass; with no loop running the CLI applies it itself.
- Errors print `towercab: <reason>` and exit 1; bad arguments exit 2.
- Verified by: `cli: commands`, `cli: second run is refused`, `commands: applied by the loop`, `commands: applied without a loop`

### LOOP-16 · Telegram

Telegram only delivers Towercab's messages; the owner acts on GitHub or in the UI.

- `POST <api_base>/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview: true}` (≤ 4000
  characters, 10 s timeout). Unsent rows go oldest first, stop at the first failure and retry with
  LOOP-10's backoff. Failures are logged once per outage without the token. No `[telegram]` → rows
  are written and never sent.
- Verified by: `telegram: retries until sent`, `telegram: failures never raise`

### LOOP-17 · Idle

With nothing to do, the loop keeps polling quietly.

- No message, no exit with `--watch`; without `--watch`, `run` exits 0 once nothing is runnable and
  nothing is driven.
- Verified by: `loop: idle`

### LOOP-18 · Events from GitHub and the intents repo

Towercab reads the intent's PRs and the intents repo every minute and turns what the owner did there
into events.

- PR reads (LOOP-38, [PIP-21](pipeline.md)) give at most one event per read, in this order: merged,
  closed, owner feedback, `/retry`, conflict, head moved. They are re-derived from the PR each time
  (level-triggered), so nothing is lost while a child runs. A conflict carries the same conflict repair
  as CI's (PIP-1): the build merges the base branch first, so the next round no longer conflicts.
- Intents repo: the intent file gone → `intent_removed` (stop); `retry: fresh` written → `retry_fresh`;
  `waiting` removed by the owner while blocked → `answered` with no text.
- A move out of a stage kills that stage's child.
- Verified by: `events: PR events by priority`, `events: intent events`, `events: owner merge during CI ships`

### LOOP-19 · GitHub App identity

Towercab acts on GitHub as its own GitHub App, so its work is clearly separate from the owner's.

- App from `ops/github-app.json` (contents, pull requests, issues, checks, statuses, workflows,
  actions: write; metadata: read), installed on `intents` and each `[repos]` repo. Key `app.pem` next
  to the config (refused if readable by group or others). RS256 JWT → an installation token, cached
  per repo (1 hour, re-minted when under 10 minutes left), passed as `GH_TOKEN` to `gh` and to `git`
  through a credential helper; never to Claude runs. The token covers the installation's repos, not
  just one: since 2026-10-27 GitHub's git answers 404 to a token scoped with `repositories` or
  `repository_ids` on a private repo, while the REST API accepts it.
- Commits are authored as `towercab[bot] <<id>+towercab[bot]@users.noreply.github.com>`.
- Verified by: `github: installation token per repo`, `github: git uses the App token`, `github: commits are authored by the bot`, `github: no token in Claude's environment`

### LOOP-20 · gh 2.46

Towercab works with gh 2.46, the version Ubuntu ships.

- No `api --slurp`, `pr checks --json`, `pr update-branch`, `run view --json attempt`. `doctor`
  prints the gh version and warns below 2.46.
- Verified by: `github: only gh 2.46 flags`

### LOOP-21 · Log lines

Every log line is one readable line; long messages go whole to a file.

- To stderr (the journal): the first meaningful line, control characters as spaces, at most 300
  characters, `(+<n> lines)` when cut, and the whole text after `--- <time>` in `towercab.log`
  (rotated at 5 MiB). Every stage move logs `<intent> <from> → <to> (<event>[: <why>])`. A warning
  repeating every pass is logged once until it changes.
- Verified by: `log: one line`, `log: full text in file`, `log: moves are logged`

### LOOP-22 · Answer command

Removed: in v1 already; now LOOP-38.

### LOOP-34 · Shared build cache per repo

Each repo has one build cache that every mission reuses, so a new mission doesn't compile from
scratch.

- `<home>/cache/<repo>/`: writable for setup and the worker of that repo; read-only for its checks,
  proof, screenshots and e2e unless the owner allowed them to write ([PIP-95](pipeline.md)). Env for those runs:
  `XDG_CACHE_HOME=<cache>/xdg`, `npm_config_cache=<cache>/npm`, `CARGO_HOME=<cache>/cargo`,
  `CARGO_TARGET_DIR=<cache>/target`, `GOCACHE=<cache>/go`, `PIP_CACHE_DIR=<cache>/pip`, then
  `[agent].env` and `[repos.<r>].env`. With one worker per repo (LOOP-4) two missions never share it
  at once.
- Verified by: `cache: one cache per repo across missions`

### LOOP-35 · Self-update

When Towercab's own `main` moves, the running Towercab updates itself and restarts within a minute.

- Every 60 s, when the checkout Towercab runs from is clean, on `main`, and `[update].auto` is true
  (default): `git fetch`; if `origin/main` is ahead, wait until no child runs, then `git merge
  --ff-only`, `npm ci` when `package-lock.json` changed, `npm run build:ui` when `ui/` changed, and
  check the new tree with `bin/towercab doctor --quick`, which reads only the config, the tools and the
  modules: it never opens the database, so new code that is then rejected has migrated or imported
  nothing. Pass → exit 75 and systemd starts the new code. Fail → `git reset --hard <previous>`, keep running, one message `self-update failed: <why>`.
- `towercab update` does the same now. `status` and the UI show the running commit and whether it is
  behind `main`. Never moves to an older commit.
- Verified by: `update: pulls and restarts when idle`, `update: a failed check rolls back`, `update: a dirty checkout is left alone`, `cli: doctor --quick leaves the database alone`

### LOOP-36 · Dev loop

A code change to Towercab runs on the owner's machine within seconds.

- The service runs the checkout's own files (no build), so `towercab restart` (or `npm run dev`:
  `node --watch` on the loop with a scratch home) runs an edit at once. `npm run dev:ui` serves the
  UI with Vite's hot reload, proxying `/api` to the running loop.
- Verified by: `manual (edit a status line, towercab restart, towercab status shows it)`

### LOOP-37 · Database

One SQLite file holds what the loop must not forget: missions, their moves, commands, messages and repos.

- `node:sqlite`, WAL, `synchronous=FULL`, `busy_timeout=5000`; migrations by `PRAGMA user_version`.
  Tables in **Schema**: `missions`, `transitions`, `commands`, `outbox`, `repos` (LOOP-65), and a key-value `meta`
  (running pid, paused, cooldowns, bot identity, last pass). `tx(fn)` = one `BEGIN IMMEDIATE`.
- v2 starts a new `towercab.db`; a v1 one at that path is moved aside to `towercab.v1.db`, unused.
- A migration that only adds (a table, a column, a meta key older code doesn't read) is listed in
  `ADDITIVE`. Each migration records in `meta.compatible_from` the oldest Towercab (by its number of
  migrations) that can still use the database. A Towercab finding a newer `user_version` opens the
  database as it is when `compatible_from` is at most its own number, and otherwise refuses:
  `towercab.db is version <n>, newer than this Towercab (<m>)`. Migration 3 (`repos`, LOOP-65) is
  additive, so `compatible_from` stays 2.
- Rolling back past LOOP-65 by hand: Towercab versions from before it don't read `compatible_from`, so
  stop Towercab and run `sqlite3 ~/.local/share/towercab/towercab.db 'PRAGMA user_version=2'` first.
  The old version then reads its repos from `config.toml` again (keep the tables until you won't roll
  back, LOOP-65). Upgrading again re-runs migration 3, which keeps the `repos` table and its rows
  (`CREATE TABLE IF NOT EXISTS`).
- Verified by: `db: schema matches the spec`, `db: migrations run in order`, `db: a v1 database is moved aside`, `db: a newer database that only added opens, and rolls back by hand`

### LOOP-38 · Acting as the owner

Actions the owner starts from the UI or the CLI happen on GitHub under the owner's own login, so
GitHub shows they were the owner's.

- `ownerGh(args)` = `gh` with the owner's login (no `GH_TOKEN`; `gh auth status` must show
  `[github].me`). `approve` → `gh pr merge <n> --squash` on the PR the intent waits on; a reply from
  the UI → `gh pr comment`; drop from the UI → `gh pr close` on the current PR. Before any PR exists:
  `answer` appends to the intent's `## Answers` ([INT-15](intents.md)) and continues it.
- Verified by: `owner: approve merges as the owner`, `owner: answer without a PR`

### LOOP-39 · Run files by stage

Every file a mission writes is kept in a folder named for the stage that wrote it.

- `runs/<id>/<stage>/` with `<stage>` one of `design`, `plan`, `build`, `verify`, `proof`, `publish`,
  `ci`, `review`, `gate`, `merge`. Everything the stage writes goes there: prompts, Claude's answers,
  stdout and stderr, the Claude settings and system prompt, the guard file, setup and check logs,
  screenshots. Build keeps its worker files and its setup log together. This replaces the flat
  `runs/<id>/` of LOOP-1 and LOOP-12 (children write their stdout and stderr into the stage folder).
- Verified by: `runs: files land in the stage folder`

### LOOP-40 · Rounds keep their number

A later round never replaces an earlier round's files, and an empty error file is not left behind.

- A file written more than once in a stage carries the round in its name
  (`worker-2.prompt`, `worker-2.json`, `verify-2.log`, `shots-2/`); the first round carries its number too. Empty `.err` files
  are removed when the child ends.
- Verified by: `runs: rounds keep separate files`, `runs: empty error files are removed`

### LOOP-41 · Readers use the stage folders

Everything that reads run files finds them in the stage folders.

- Repair prompts (log tails), the review (logs and screenshots) and the run file API (UI-65, which
  accepts `<stage>/<file>`) read from `runs/<id>/<stage>/`. The API still refuses a path outside
  `runs/<id>/`: no `..`, no symlink out, text only, at most 2 MB.
- Verified by: `runs: repair prompt reads the stage log`, `runs: review reads logs and shots from stage folders`, `ui: run files stay inside runs`

### LOOP-42 · Old runs still show

Runs written before the stage folders keep working, with no migration.

- Files in the flat `runs/<id>/` are assigned to a stage by the old name prefixes (`worker-*` and
  `build-setup.log` → build, `verify-*` → verify, `shots-*` → verify, `settings-*`, `system-*` and
  `guard.json` → the stage of their Claude kind, and so on). Nothing is moved, so a running mission
  is never disturbed. A name that matches no stage is listed under "Other".
- Verified by: `runs: flat runs are assigned to stages by prefix`, `ui: flat runs get a map`

### LOOP-60 · Intents ahead of build

A repo can have up to 3 intents being designed, planned or waiting for approval at the same time, so one intent's wait for the owner no longer stops the next one.

- New setting `[repos.<r>].ahead`, int 1–16, default 3. An intent is *ahead* while its mission is at
  `pick`, `design`, `approval:spec`, `plan` or `approval:plan`, or is `blocked` in the spec or plan
  phase. A mission that is building or later, or whose plan is approved and waits for the build slot
  (LOOP-61), is not ahead.
- `decide` skips an intent of a repo that already has `ahead` intents ahead (`waiting: repo has <n>
  intents ahead`, shown in plain words by UI-61), except one started with `start` (LOOP-63). Free
  places go to intents in the picker's order ([PRI-5](priority.md)).
- A higher-priority intent that arrives while the repo is full waits for a free place; no running or
  waiting design is stopped, paused or dropped for it.
- This replaces the "one unmerged intent per repo" limit of LOOP-4 for the work before build; the
  `workers` limit moves to LOOP-61. `[agent].parallel` still caps all Claude runs and checks (LOOP-4):
  with 1, a design run queues behind other runs.
- Verified by: `loop: up to ahead intents per repo are designed at once`, `loop: a higher priority arrival does not stop a design`, `config: ahead default and range`

### LOOP-61 · Build slot

Only one intent per repo builds at a time, and when the slot is free it goes to the highest-priority intent whose plan is approved.

- `[repos.<r>].workers` (default 1) now counts missions from `build` through `merge` (including
  `approval:merge` and `blocked` in the code phase). When the plan PR is merged and the repo already
  has `workers` such missions, the mission does not start `build`: it waits as *ready to build*, with
  no message to the owner and its intent `stage` still `plan`.
- Each pass, for each repo with a free slot, the ready mission with the highest priority starts
  `build` (ties: the one approved first). A ready mission never takes the slot from a running build.
- A ready mission is not ahead (LOOP-60), so its place goes to the next intent. `drop`, `retry` and a
  closed plan PR work on it as at `approval:plan`.
- Verified by: `loop: one intent builds at a time per repo`, `loop: the free build slot goes to the highest priority plan-approved intent`, `loop: a ready intent does not count as ahead`, `machine: plan merged while the slot is taken waits`

### LOOP-62 · Starting past the limit

Not used: kept free; `start` is LOOP-63.

- Verified by: manual (nothing to check: no behaviour)

### LOOP-63 · start

`towercab start <intent>` begins that intent's design now, even when the repo already has 3 intents ahead.

- Inserts a `start` row in `commands` (LOOP-15; applied by the loop, or by the CLI with no loop). The
  intent is then picked as if the repo had a free place: it goes over `ahead` and nothing running is
  stopped. Other skips still apply: parked, paused, unknown repo, bad `after`, cooling down, GitHub
  or Claude unreachable (LOOP-5, LOOP-9, LOOP-10).
- Refused with a reply of `start: <reason>` (the CLI prints it): the intent is unknown, `<id> has
  already started` (it has a mission, or an earlier `start` is still waiting for its pass), or `<id> is
  done or dropped`. A started intent is picked before others, so it begins on the next pass.
- `start` only moves design forward. It does not skip the build slot: an intent with an approved plan
  still waits its turn by priority (LOOP-61).
- Verified by: `cli: start`, `loop: start goes over the ahead limit`, `loop: start does not skip the build slot`, `commands: start is refused for a started intent`

### LOOP-64 · status and next show the wait

`status` and `next` say when an intent waits for a place or for the build slot.

- A skipped intent reads `waiting: repo has <n> intents ahead (start <id> to go now)`; a ready mission
  reads `ready to build, behind <id>`.
- Verified by: `status: ready to build and ahead limit are shown`

### LOOP-65 · Repos live in the database

The repos Towercab works on are kept in its database, so they can be added and removed while it
runs; the config file's repo tables are only read once, to bring them in.

- Table `repos` in **Schema**: `name` (the short name intents use), `github` (`owner/name`), `path`
  (`''` = `<home>/repos/<name>`), `base`, `workers`, `ahead`, `env` (a JSON object), `source`
  (`config`, `cli` or `ui`), `added`.
- On start (every CLI command that reads the home, and the loop's startup), each valid
  `[repos.<name>]` table is imported once: unless `meta.repo-imported:<name>` is set, it is set and the
  table becomes a row (a name already in the table is left as it is). A table is never imported
  again, so a repo removed with `repo remove` stays removed.
- `Config.repos` (the Map the rest of the code reads) is then filled from the table, and stays the same
  Map object afterwards. A table whose repo is in the database, or was imported and removed, is ignored:
  it no longer tunes the repo (that is `repo set`, LOOP-69). `doctor` names each one: `<name>:
  [repos.<name>] in <file> is ignored: the repo is in Towercab's database now (towercab repo list,
  towercab repo set). Keep it only while you might go back to a Towercab from before repos moved into
  the database; then delete it.` (or `…the repo was removed with towercab repo remove. Keep it only…`).
  A table that fails to validate and has no row still fails only what uses it, as before.
- Verified by: `repos: config tables are imported once`, `repos: doctor says which config tables to delete`, `db: schema matches the spec`

### LOOP-66 · repo add

`towercab repo add <owner/name>` adds a repo with nothing else to fill in: Towercab checks it can reach
it, takes its default branch and clones it.

- `repo add <owner/name> [--name <short>]`: a `https://github.com/` prefix or `.git` suffix is dropped;
  the owner and the repo part must each be a repo name (INT-2: no `.` or `..`). The short name defaults
  to the repo part; it must be a repo name and not `intents`.
- Towercab's GitHub App must reach the repo: `gh api repos/<owner/name> --jq '.full_name + " " +
  .default_branch'` as the App (LOOP-19). GitHub's `full_name` is stored as `github` (its spelling of
  the name) and the default branch as `base`; `workers` 1, `ahead` 3, `env` empty, `path` `''`. The repo
  is cloned as in LOOP-8 into `<home>/repos/<name>`; a clone already there is reused only when its
  origin is this repo (compared without case). Only then is the row stored, in a transaction that checks
  for duplicates again (`source` `cli`, or `ui` from the page, UI-130).
- One process adds a name or repo once at a time; a second add while the first runs is refused.
- Refusals are the reason, printed `towercab: <reason>` with exit 1: `repo add needs [github] in <file>
  (app_id, me)`; `<text> isn't a GitHub repo: write it as owner/name`; `<name> can't be a repo name: use
  letters, digits, dots, dashes and underscores`; `<owner/name> is being added already`; `<name> is
  already a repo (<github>)`; `<owner/name> is already added as <name>`; `Towercab can't reach
  <owner/name>: <why>` (the App isn't installed on it, GitHub's refusal, no `app.pem`); `GitHub didn't
  say which branch is <owner/name>'s default`; `<clone> already holds a clone of another repo: move it
  away first`; `Towercab couldn't clone <owner/name>: <why>`.
- Verified by: `repos: add checks GitHub, reads the base and clones`, `repos: add refuses an unreachable repo`, `repos: add refuses a duplicate`, `cli: repo commands`

### LOOP-67 · repo remove and repo list

The owner can list the repos and remove one nothing is working on.

- `repo list`: one line per repo, `<name>: <owner/name> · base <base> · <n> worker(s) · ahead <n> ·
  <clone path>`, then `· env <names>` when it has variables (names only, never values), by name; none →
  `no repos yet: add one with towercab repo add <owner/name>`.
- `repo remove <name>` deletes the row in one transaction with the check that no mission still needs
  the repo: none is unfinished, and none that finished still has its entry step to run (`step != ''`:
  closing its PRs, retiring its branch, LOOP-6); refused with `<name> still has unfinished intents (<ids>): let them finish or drop them
  first`, or `<name> isn't a repo Towercab knows (towercab repo list)`. The clone stays on disk.
- Verified by: `repos: remove refuses while an intent is unfinished`, `cli: repo commands`

### LOOP-68 · The running loop sees repo changes

A repo added or removed while Towercab runs counts from its next pass, without a restart, and the
intents that waited for it start.

- Each pass first makes `Config.repos` equal the `repos` table, changing only the entries that differ
  (`repo add` from the CLI is another process; the page adds in the loop's own).
- An intent with `waiting: unknown repo`, no unfinished mission, and a repo that is now known loses its
  `waiting`; when at least one did, the intents are read again in the same pass, so it can be picked at
  once.
- The pass awaits the network between its sync and its pick, so the pick's transaction checks that the
  picked intent's repo row still exists; if it was removed meanwhile, nothing is picked and the log says
  `<id>: its repo <name> was just removed; not picked`.
- Verified by: `loop: a repo added while running is picked up`, `loop: a repo removed during a pass is not picked`

### LOOP-69 · repo set

`towercab repo set <name> key=value…` changes a repo's settings; config tables no longer do.

- Keys: `workers`, `ahead` (integers 1–16), `base` (a branch name), `path` (absolute or `~/`; empty =
  `<home>/repos/<name>`), `env` (`env=NAME=value` sets one variable, `env=NAME=` sets it empty;
  `env={"NAME":"value",…}`, a JSON object of strings, replaces them all). Several pairs at once; one bad
  pair changes nothing. Prints the repo's `repo list` line after `set `. The running loop uses the new
  values from its next pass (LOOP-68).
- `base` and `path` change only while no mission needs the repo (as for `repo remove`): `<name> has
  unfinished intents (<ids>): change base or path once they are done`.
- Other refusals: `<key> must be an integer 1-16`; `base: <value> is not a branch name`; `path must be
  absolute or start with ~/`; `env must be NAME=value or a JSON object of strings`; `unknown setting
  <key>: use workers, ahead, base, path or env`; `<pair> isn't key=value`; `<name> isn't a repo Towercab
  knows (towercab repo list)`.
- Verified by: `repos: set changes a repo's settings`, `cli: repo commands`

**Config** (`src/config.ts`)

| Key | Type, range | Default |
|---|---|---|
| `intents.remote`, `intents.path` | URL; path (`~/` expanded) | required; `<home>/intents` |
| `intents.cutoff` | int 1–15 | 7 |
| `intents.issue_a` | int 1–5 | 3 |
| `agent.model`, `agent.review_model` | model name | `opus`; one step above the worker's |
| `agent.parallel` | int 1–16 | 1 |
| `agent.build_timeout`, `review_timeout`, `check_timeout` | minutes 1–1440 | 60, 15, 10 |
| `agent.max_budget_usd`, `agent.daily_budget_usd` | number > 0 | 10; none |
| `agent.ci_poll`, `ci_grace`, `ci_wait` | seconds | 30, 120, 1800 |
| `agent.path` | `PATH` for runs and checks | the loop's `PATH` |
| `agent.toolchain` | list of absolute dirs (`~/` expanded) | `~/.local/bin` |
| `agent.env` | table of strings | `{}` |
| `agent.network` | list of domains | AUT-14's default list |
| `agent.sandbox_unix_sockets` | bool | false |
| `repos.<r>.github`, `path`, `base`, `workers`, `env` | `owner/name`; path; branch; int 1–16; table | required; `<home>/repos/<r>`; `main`; 1; `{}` |
| `repos.<r>.ahead` | int 1–16 | 3 |
| `github.app_id`, `github.me`, `github.api_base` | int; login; URL | required; required; `https://api.github.com` |
| `telegram.bot_token`, `telegram.chat_id`, `telegram.api_base` | strings; URL | none (no Telegram); `https://api.telegram.org` |
| `ui.port` | int 0–65535 (0 = off) | 7311 |
| `update.auto` | bool | true |

v1's `[tasks]` is read as `[intents]` when `[intents]` is absent.

`[repos.<r>]` tables are imported into the database once (LOOP-65) and ignored after that: they no longer
tune an imported repo; `towercab repo set` does (LOOP-69).

**Schema** (`src/db.ts`; times are unix seconds)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE missions (
  id INTEGER PRIMARY KEY, intent TEXT NOT NULL, repo TEXT NOT NULL, attempt INTEGER NOT NULL,
  stage TEXT NOT NULL, step TEXT NOT NULL DEFAULT 'enter', from_stage TEXT,
  waiting TEXT, why TEXT, continued INTEGER NOT NULL DEFAULT 0,
  busy INTEGER NOT NULL DEFAULT 0, unclean INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL, a_at_pick INTEGER, session TEXT NOT NULL, session_used INTEGER NOT NULL DEFAULT 0,
  checkout TEXT NOT NULL, branch TEXT NOT NULL, base_sha TEXT, head TEXT,
  spec_pr INTEGER, plan_pr INTEGER, pr INTEGER, pushed_at REAL, feedback_seen TEXT,
  merged_by TEXT, merge_sha TEXT,
  repairs INTEGER NOT NULL DEFAULT 0, ci_repairs INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0, retry_at REAL, limit_model TEXT, step_secs REAL NOT NULL DEFAULT 0,
  child_pid INTEGER, child_kind TEXT, child_since REAL, child_model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, agent_secs REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL, updated REAL NOT NULL, finished REAL);
CREATE UNIQUE INDEX missions_one_per_intent ON missions(intent) WHERE stage NOT IN ('done','stopped');
CREATE TABLE transitions (id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  at REAL NOT NULL, from_stage TEXT NOT NULL, event TEXT NOT NULL, to_stage TEXT NOT NULL, why TEXT);
CREATE TABLE commands (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume','start')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
CREATE TABLE outbox (key TEXT PRIMARY KEY, mission INTEGER, text TEXT NOT NULL, created REAL NOT NULL,
  sent_at REAL, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0);
CREATE TABLE repos (name TEXT PRIMARY KEY, github TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL, workers INTEGER NOT NULL DEFAULT 1, ahead INTEGER NOT NULL DEFAULT 3,
  env TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL, added REAL NOT NULL);
```

**Transitions** (`next(stage, event)`; "next" = the next stage of the order; `U` = unexpected, counted
like a crash; `–` = ignored)

| Event | Working stages | approval:spec | approval:plan | approval:merge | blocked |
|---|---|---|---|---|---|
| ok | next (e2e → done; rollback → build; revert U) | U | U | U | U |
| red | verify, proof, ci, review → build; deploy, e2e → rollback; else U | U | U | U | U |
| skip | deploy → done; else U | U | U | U | U |
| revert | rollback → revert; else U | U | U | U | U |
| timeout, bad_result, interrupted | again | – | – | – | – |
| limit | cool | U | U | U | U |
| wait (a handler's) | to the wait's stage | same | same | same | same |
| env_fail | backoff | backoff | backoff | backoff | backoff |
| crash | recover | – | – | – | – |
| spec_merged | design → plan; else – | → plan | – | – | from design → plan |
| plan_merged | plan → build; else – | – | → build | – | from plan → build |
| code_merged | build … merge → deploy; else – | – | – | → deploy | → deploy, unless it came from deploy … revert |
| closed | → stopped | → stopped | → stopped | → stopped | → stopped |
| feedback | build … merge → build; else – | → design | → plan | → build | as answered |
| answered | – | – | – | – | continue |
| conflict | ci … merge → build; else – | – | – | → build | → build |
| head_moved | review … merge → ci; else – | – | – | → ci | – |
| intent_removed | → stopped | → stopped | → stopped | → stopped | → stopped |
| retry_fresh | fresh | fresh | fresh | fresh | fresh |
| recheck ([AUT-21](autonomy.md)) | – | → design | → plan | → review | – |
| resume | merge (held) → again; else – | – | – | – | – |

- again = re-enter the step; cool = wait for the model's cooldown (LOOP-9); backoff = LOOP-10;
  recover = `unclean + 1`, 3 → `crashed at <stage>`; fresh = this mission `stopped` (why `replaced by
  attempt <n>`) and a new one at `pick`; continue = back to `from_stage` when it was pick, design or
  plan, else `build` with the answer in the prompt.
- Every move out of a wait adds 1 to `continued`, so the next wait sends a new message.

**Waits** (`waiting:` text → stage; the ask is line 1 of the message and the UI's card). The keys
are stored in intent files and never change; each ask says plainly what the owner decides or does
([PIP-110](pipeline.md)).

| `waiting:` | Stage | The ask |
|---|---|---|
| `approve spec` | approval:spec | Decide if this is the right change to build: merge the spec PR to go ahead, or comment what to change. |
| `approve plan` | approval:plan | Decide if it should be built this way, with the access it asks for: merge the plan PR to start, or comment what to change. |
| `review and merge PR` | approval:merge | Decide if this change can go live: merge the PR to ship it, or comment what to fix. |
| `answer the question` | blocked | Answer a question so the work can go on: pick an option or write your own. |
| `checks red` | blocked | The tests can't pass without your help. Reply with what to change, or start over. |
| `allow check writes` | blocked | Decide if the tests may write to this machine's shared build cache: reply allow or no. |
| `tests don't prove the change` | blocked | No test shows the change works. Reply with what a test should check, or say go on to continue without one. |
| `CI red` | blocked | GitHub's checks still fail after two fix attempts. Reply with a hint on what to change, or start over. |
| `CI stuck` | blocked | GitHub's checks didn't finish in time. Make sure they run, then reply so Towercab looks again. |
| `worker timeout` | blocked | The agent ran out of time before finishing. Reply to let it carry on, or start over. |
| `worker budget` | blocked | The agent used up its budget before finishing. Reply to let it carry on, or start over. |
| `no result` | blocked | The agent stopped without a usable answer. Reply to let it carry on, or start over. |
| `no changes` | blocked | The agent finished without changing anything. Reply with what it should do, or drop the intent if nothing is needed. |
| `crashed at <stage>` | blocked | Towercab failed three times at the same step. Reply to try again once the cause is fixed, or start over. |
| `spec conflict` | blocked | The spec clashes with other changes and Towercab couldn't combine them. Resolve it in the spec PR, then reply. |
| `merge failed` | blocked | GitHub refused to merge the change. Fix what GitHub objects to, then reply to try again. |
| `add CLAUDE.md verifying block` | blocked | Towercab doesn't know how to test this repo yet. Add a verifying section to its CLAUDE.md, then reply. |
| `fix repo files` | blocked | One of the repo's files for Towercab can't be read. Fix it, then reply. |
| `unknown repo` | (intent only) | Tell Towercab which repo this is for: add the repo, or fix the repo name in the intent. |
| `bad after:` | (intent only) | Fix what this intent waits for: Towercab can't find one of the intents it names, or it was dropped. |
| `rolled back, revise` | blocked | The change broke the live app, two fixes didn't hold, and it was taken back out. Revise the intent, then start over (/retry). |
| `rollback failed` | blocked | Taking the broken change back out failed, so nothing more goes live in this repo until you fix it. |

Every blocked wait continues on a reply on the intent's current PR, `towercab answer`, or removing
`waiting:` from the intent; `/retry` starts over; closing the PR drops the intent.

**Unit**

```ini
[Unit]
Description=Towercab

[Service]
ExecStart=<checkout>/bin/towercab run --watch
Environment=PATH=<node dir>:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

**Code** (`src/`; tests in `tests/`, helpers in `tests/helpers/`)

| File | What |
|---|---|
| `cli.ts` | Commands (`node:util` `parseArgs`). |
| `config.ts`, `home.ts`, `db.ts`, `log.ts` | LOOP-1, 21, 37. |
| `tools.ts` | `Tools`: `run(cmd, args, opts)` (bounded, own group) and `spawn(spec)` (children); `realTools()`; tests pass fakes. |
| `child.ts` | Children, timeouts, killing groups. |
| `machine.ts` | `Stage`, `Event`, `next`, `Waiting`, `continueTo`, `apply`, `enter`. |
| `mission.ts`, `loop.ts`, `handlers.ts` | Mission rows; the pass; `Handler { step, finish }`, `Ctx`, `Progress`, `Outcome`. |
| `pick.ts`, `limits.ts`, `faults.ts`, `awake.ts`, `service.ts`, `status.ts`, `commands.ts`, `outbox.ts`, `telegram.ts`, `update.ts`, `doctor.ts` | One requirement each, as named. |
| `github/app.ts`, `github/gh.ts`, `github/prs.ts`, `github/events.ts`, `github/owner.ts` | LOOP-19, 20, 18, 38. |
| `checkout.ts` | LOOP-8, 34. |

## Out of scope

- Running on more than one machine.
- Telegram commands (v1 had them; no one used them: the owner acts on GitHub or in the UI).

## Decisions

- TypeScript on Node instead of Rust (the owner's call, 2026-10-26): the program mostly waits on
  `git`, `gh` and `claude`, so Rust's speed bought little, while its compile times slowed every
  change; one language now serves the loop and the UI.
- No build step for the program: Node strips types at load, so the service runs the checkout and an
  edit is live after a restart.
- One SQLite file, five tables plus `meta` (the owner's call; `repos` joined later, LOOP-65): crash recovery needs a mission's step
  and its message written together; everything else is derived from GitHub and the intents repo.
- Repos in the database, not the config (the owner's call, 2026-10-30): adding a repo takes only
  `owner/name`, from the page or the CLI, and needs no restart. Config tables are imported once, so the
  database is the one record; a table imported once is never read again, so a removal sticks.
- The running loop re-reads the `repos` table every pass rather than being told: `repo add` from the CLI
  is another process, and one small read every 5 s is simpler than a signal.
- Code drives, Claude judges: limits, restarts and polling need code; Claude runs only design, plan,
  build and review.
- Single process, one pass at a time: children run detached and are reaped by events, so polls keep
  their cadence during an hour-long build.
- PR events are level-triggered: re-read every minute, nothing queued to persist.
- Telegram only notifies: v1's Telegram commands were never used, and acting on GitHub keeps one
  record.
- Self-update exits and lets systemd restart: no in-process reload to get wrong.
