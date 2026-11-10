# Loop

**Status:** Live: LOOP-1..42, LOOP-60..75, LOOP-83..84, LOOP-92..93, LOOP-100..104, LOOP-105..109, LOOP-110..112, LOOP-113..121, LOOP-126..132, LOOP-133..135, LOOP-159..162, LOOP-122, LOOP-140..141 · **Prefix:** LOOP

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
- Not built yet: the unit will set `TimeoutStopSec=60`, so systemd waits a minute for a stop before killing the service; the loop's own stop budget stays far below it (LOOP-136). The **Unit** block below still shows the built value (30), because `service: unit file` compares it with the file `up` writes. The code PR changes the block and the unit to 60 together.
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
  (LOOP-13); `add` ([INT-2](intents.md)); `answer <id> <text>` (LOOP-38); `start <id>` (LOOP-63); `step <id> <n…|all>` ([SHIP-22](ship.md)); `retry <id>` (a fresh
  attempt); `drop <id>` ([PRI-9](priority.md)); `approve <id>` (merges the PR the intent waits on, as
  the owner, LOOP-38); `pause [id]`, `resume [id]` (one intent, SHD-22; the command line refuses `resume <id>` on an a0 intent, AUT-33); `repo add | remove | set | list` (LOOP-66, LOOP-67, LOOP-69); `ui` (opens
  the page); `doctor`; `update` (LOOP-35);
  `hook guard <rules>` (internal, [PIP-29](pipeline.md)); `--version`.
- One loop per home: a lock file; a second `run` → `towercab is running (pid N): towercab down
  first`. `answer`, `retry`, `drop`, `start`, `pause` and `resume` insert a `commands` row the loop applies on
  its next pass; with no loop running the CLI applies it itself.
- Errors print `towercab: <reason>` and exit 1; bad arguments exit 2.
- Verified by: `cli: commands`, `cli: second run is refused`, `commands: applied by the loop`, `commands: applied without a loop`

### LOOP-16 · Telegram

Telegram delivers Towercab's messages; the owner acts on GitHub, in the UI, or in the chat itself with
buttons, replies and commands ([telegram.md](telegram.md), LOOP-126..128), or, with the shadow on, talks to it
([LOOP-129](loop.md), [shadow.md](shadow.md)).

- `POST <api_base>/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview: true}` (≤ 4000
  characters, 10 s timeout). Unsent rows go oldest first, stop at the first failure and retry with
  LOOP-10's backoff. Failures are logged once per outage without the token. No `[telegram]` → rows
  are written and never sent. Webhooks can be added alongside it (LOOP-146).
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
  A mission waiting in its repo's merge queue gets no conflict until it is the head (LOOP-160).
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
  `[repos.<r>].env` when it passes [PIP-159](pipeline.md); `[agent].env` is ignored. With one worker per repo (LOOP-4) two missions never share it
  at once.
- Verified by: `cache: one cache per repo across missions`

### LOOP-35 · Self-update

When Towercab's own `main` moves, the running Towercab updates itself and restarts within a minute.

- Every 60 s, when the checkout Towercab runs from is clean, on `main`, and `[update].auto` is true
  (default): `git fetch`; if `origin/main` is ahead, wait until no child runs, then `git merge
  --ff-only` (the wait is a drain, LOOP-108..109), `npm ci` when `package-lock.json` changed, `npm run build:ui` when `ui/` changed, and
  check the new tree with `bin/towercab doctor --quick`, which reads only the config, the tools and the
  modules: it never opens the database, so new code that is then rejected has migrated or imported
  nothing. Pass → exit 75 and systemd starts the new code. Fail → `git reset --hard <previous>`, keep running, one message `self-update failed: <why>`.
- `towercab update` does the same now. `status` and the UI show the running commit and whether it is
  behind `main`. Never moves to an older commit.
- Verified by: `update: pulls and restarts when idle`, `update: a failed check rolls back`, `update: a dirty checkout is left alone`, `cli: doctor --quick leaves the database alone`

### LOOP-105 · One code version at a time

The loop restarts itself, before starting any new work, when the checkout it runs from has moved to a different commit than the one it started from.

- At start the loop records `git rev-parse HEAD` of its checkout. In every pass, before it starts a
  Claude run or any other child that carries the guard hook (PIP-29) or reads files the loop wrote, it
  compares that commit with the checkout's HEAD. Different → it starts nothing new, waits for running
  steps to finish, then exits 75 so systemd starts the current code (as LOOP-35 does). A HEAD that
  moves mid-pass is caught by the next comparison, before the next run.
- A run in progress keeps its result and the loop applies it, unless the guard refused a write in that
  run because of version skew (LOOP-106). Then the result is thrown away: the mission stays at its step
  and the step is redone after the restart.
- This covers any move of the checkout (self-update between `git merge` and the restart, a manual
  `git pull`). It sends no message and records the restart in the log with both commits.
- Verified by: `update: a moved checkout restarts before the next run`, `update: a HEAD that moves mid-pass restarts before the next run`, `update: a run in progress keeps its result across the restart`

### LOOP-106 · Versioned guard rules

The guard hook refuses a rules file written by a different version of the loop, and the build step is retried after the restart rather than ending blocked.

- `guard.json` (PIP-29) carries a number `version`; the loop writes the current one and the hook knows
  the same one. A file whose `version` is missing or different makes the hook exit 2 with `guard rules
  are from another version of Towercab; the loop is restarting, try again`, and the hook records its
  own commit and checkout path where the loop can read them. A file of the right version
  that is unreadable or malformed (a missing `existing`, a wrong type) still fails closed with exit 2
  and its own reason, and is not treated as skew.
- A build run whose only refusals are version skew is not a block: the mission stays at its step, the
  loop restarts (LOOP-105), and the step runs again with newly written rules. A rules file without
  `existing` from an "old" loop is skew (no `version`), never an owner wait.
- At most 3 skew retries per mission within one hour. After that the mission goes to the normal
  blocked wait ([LOOP-3](loop.md)), and its question names the loop's commit, the hook's commit and the
  hook's checkout path, so a hook running from another checkout is visible.
- Verified by: `guard: a rules file of another version is refused as skew`, `guard: a malformed rules file of the current version fails closed`, `build: version skew restarts and retries the build`, `build: a run refused by skew is redone after the restart`, `build: a fourth skew in an hour blocks naming both commits and the checkout`

### LOOP-107 · One automatic retry for Towercab's own setup

A step that is blocked by Towercab's own setup is retried once automatically before the owner is asked.

- A setup fault is a block that matches an entry of a fixed list of known setup errors, kept in the
  code: the guard refusing its rules file, the sandbox failing to start, a rules file the loop wrote
  that cannot be read. Each entry names the exact log text or exit code that identifies it. Towercab
  decides from its own logs and exit codes (the guard's, the sandbox's and the loop's), never from the
  agent's account of why it was blocked. A block that matches no entry is not a setup fault, and a new
  kind of setup fault becomes a new entry when it is seen.
- The first time a setup fault happens for a mission step, the loop restarts that step once (a fresh
  setup, no wait, no message). The retry is recorded in the mission's move log with the entry that
  matched.
- If the retry is blocked by a setup fault again, the mission goes to the normal blocked wait
  ([LOOP-3](loop.md)) and asks the owner, with the cause in plain words. Version skew (LOOP-106) does not use up this retry.
- Blocks caused by the work (a protected path not granted, a failing test, an access request) are
  unchanged and are not retried.
- Verified by: `loop: a setup block is retried once`, `loop: a second setup block waits for the owner`, `loop: a block caused by the work is not retried`, `loop: only a listed setup error is retried`, `loop: the agent's account of a block does not make it a setup fault`

### LOOP-108 · Drain for update

When `origin/main` is ahead, Towercab stops starting new work, lets running work finish, then updates, so a busy queue cannot hold back an update.

- The self-update check (LOOP-35) that finds `origin/main` ahead sets a drain, recorded with the target
  commit and the time it began. While a drain is set, a pass starts no child: no pick, no step, no
  Claude run and no other child. Children already running are not touched and their results are applied
  as usual. Steps that need no child (waiting, outbox, PR reads) go on.
- When no child runs, the update of LOOP-35 happens at once (merge, install, check, exit 75), and work
  resumes on the new code (LOOP-105).
- A failed update (LOOP-35) clears the drain and the loop remembers the commit that failed. It does not
  drain for that commit again: the next drain starts only when `origin/main` has moved past it. One
  message names the failed commit and the reason (`self-update to <short commit> failed: <why>`). Work
  that was held back starts again in the same process. The memory is kept while the loop runs.
- If `origin/main` stops being ahead, or the checkout is no longer clean or on `main`, or `[update].auto`
  turns false, the drain is cleared and work starts again. The drain does not survive a restart.
- `status` and the UI show `draining for update to <short commit>` while a drain is set.
- Verified by: `update: no child starts while main is ahead`, `update: updates once the running child ends`, `update: a drain is cleared when main is no longer ahead`, `update: status says draining for update`, `update: a failed commit is not drained for again`, `update: a failed update sends one message naming the commit`

### LOOP-109 · Drain limit

A drain waits for the limit (`[update].drain_minutes`, default 60); after that Towercab updates anyway, and the runs it cut off continue their session without counting as crashes.

- `[update].drain_minutes` is a whole number of minutes ≥ 1, default 60.
- Once a drain has lasted `drain_minutes` (by the loop's clock), any running child that is not a review
  or a build is cut off. A review or build still running gets up to `drain_minutes` more to finish; if
  it is still running when the drain has lasted twice `drain_minutes`, it is cut off too. So a drain
  lasts at most twice `drain_minutes` (two hours with the default). Cutting off is as for SIGTERM
  (LOOP-7): SIGTERM to each child's group, SIGKILL after 10 s, `interrupted` for each mission (not
  counted as `unclean`). Then the update of LOOP-35 runs and, if it passes, the loop exits 75.
- After the restart each cut-off Claude run resumes its own session with `Continue where you stopped.`
  (LOOP-7), and the mission continues from its recorded step. It is never counted toward the three
  crashes of LOOP-7 and sends no message to the owner.
- If the update fails (LOOP-108), the loop keeps running: each mission it cut off continues in the same
  process, from its recorded step in its own session, as if no drain had happened, and is not counted
  as a crash or a repair.
- The log records that the limit was reached and which missions were interrupted.
- Verified by: `update: a drain past the limit updates anyway`, `update: drain_minutes sets the limit`, `update: a review or build gets one more drain_minutes to finish`, `update: other children are cut off at the limit`, `update: a drain lasts at most twice drain_minutes`, `update: an interrupted mission resumes its session after the update`, `update: an interrupted run is not counted as a crash`, `update: a failed forced update resumes the cut-off missions in the same process`

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
  `approval:merge` and `blocked` in the code phase) that are working; one that only waits holds no slot
  (LOOP-110), and a returning one goes first (LOOP-111). When the plan PR is merged and the repo already
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

- A skipped intent reads as LOOP-102 says (`waiting: repo has <w> intents working ahead (start <id> to go now)`
  or the cap text); a ready mission reads `ready to build, behind <id>`; LOOP-112 adds the cap text and the
  slot counts for the build phase.
- Verified by: `status: ready to build and ahead limit are shown`

### LOOP-100 · Waiting on the owner does not use a place

An intent that waits only for the owner no longer takes one of a repo's `ahead` places, so the next intent can start while the owner is busy.

- An intent ahead (LOOP-60) is *waiting on the owner* when its mission is at `approval:spec` or
  `approval:plan`, or is `blocked` in the spec or plan phase on a question, a missing permission or any
  other wait for the owner. One at `pick`, `design` or `plan` is *working* and still takes a place.
  (`approval:merge` is after build, so it is never ahead, LOOP-60.)
- The `ahead` limit of LOOP-60 counts only working intents. `decide` (LOOP-5) skips an intent of a repo
  with `ahead` working intents ahead, as before; intents waiting on the owner are not counted.
- An intent that stops waiting (the owner merges the spec PR or answers) counts as working again. It
  keeps its mission and is not stopped to make room, so a repo can briefly have more than `ahead`
  working intents; it starts no new pick until the count is below `ahead` again.
- `start` (LOOP-63) is unchanged and still goes over every limit of this section.
- Verified by: `loop: intents waiting on the owner do not count toward ahead`, `loop: with three intents waiting on the owner a fourth starts`, `loop: an intent that stops waiting counts again without being stopped`

### LOOP-101 · Cap on intents before build

An intent that outranks every intent ahead of build starts right away, over the working limit; the cap of `2 × ahead` that also held other intents is replaced by LOOP-132.

- Superseded by LOOP-132: the cap `2 × [repos.<r>].ahead`, which counted every intent ahead of build
  (LOOP-60), working or waiting on the owner (LOOP-100). `owner_waits` (LOOP-132) now bounds the intents
  waiting on the owner, and the outranking rule below does not pass it.
- An intent *outranks* the repo when its priority is higher than that of every intent ahead of build in
  the repo ([PRI-5](priority.md) order; a tie is not higher). With no intent ahead, the rule changes
  nothing. An intent that outranks the repo starts at once: it goes over the working limit of LOOP-100.
  Nothing running or waiting is stopped, paused or dropped for it, so the repo can hold more than `ahead`
  working intents.
- An intent that does not outrank the repo is skipped when the repo has `ahead` working intents
  (LOOP-100) or `owner_waits` intents waiting on the owner (LOOP-132). Other skips of LOOP-5 still apply to
  every intent, whatever its priority.
- `[repos.<r>].workers` (LOOP-61) is unchanged: a ready mission is not ahead and does not count toward
  `ahead`.
- Verified by: `loop: an intent that outranks every intent ahead starts below the cap`, `loop: at the working limit only a higher priority intent starts`, `loop: an equal priority intent does not pass the working limit`, `loop: a ready intent does not count toward ahead`

### LOOP-102 · status names the rule that held an intent back

`towercab status` and `next` say which rule kept an intent from starting: the places taken by working intents or the limit on intents waiting on the owner (an intent that outranks the repo is never held by the first, LOOP-101).

- A skipped intent reads `waiting: repo has <w> intents working ahead (start <id> to go now)` when
  `ahead` working intents hold the places (LOOP-100), and `waiting: repo has <o> intents waiting on you
  (start <id> to go now)` at `owner_waits` (LOOP-132). When both hold, the second text is shown. UI-61
  shows both in plain words.
- Superseded by LOOP-132: the text `waiting: repo is at the cap of <cap> intents before build, <w> working
  and <o> waiting on the owner`, which is no longer produced.
- An intent that went ahead of others by priority (LOOP-101) is not marked as skipped; it
  has a mission and shows its stage as usual.
- This replaces the text `waiting: repo has <n> intents ahead` of LOOP-60 and LOOP-64, which counted
  intents waiting on the owner.
- Verified by: `status: the working limit and the owner-waits limit are told apart`

### LOOP-103 · The default for how much runs at once fits the machine

With no `[agent].parallel` in the config, Towercab runs as many Claude runs at once as the machine can carry, up to four.

- Default `parallel = max(1, min(4, floor(cores / 3), floor(free_memory_gb / 1.5)))`. `cores` is
  `os.availableParallelism()`, `free_memory_gb` is `os.freemem()` in GiB, both read through `Tools`-style
  injected readers so tests pass fake counts.
- Computed once when the loop starts (and again on `restart`), not on every pass; a value that is set in
  `[agent].parallel` is used as it is and never replaced. LOOP-4 uses the result as its limit.
- Examples: 8 cores, 16 GB free → 2; 16 cores, 32 GB free → 4; 2 cores or 1 GB free → 1.
- The config table row for `agent.parallel` reads: int 1–16; default the computed value.
- Verified by: `config: parallel defaults from cores and free memory`, `config: a set parallel is not replaced`, `config: parallel is at least 1 and at most 4 by default`

### LOOP-104 · status, the overview and doctor show whether slots are the bottleneck

`towercab status` and the overview show how many runs are going against the limit and how long the oldest intent has waited only for a free slot, and `doctor` suggests a higher limit when that wait is long and the machine has room.

- A run that is asked for while every slot is taken (LOOP-4) stamps `data.slot_wait_since` on its mission
  once, as a data stamp (`patchData`, not a move through `machine.apply`) next to `data.slot_wait_step`, the
  stage and step it was set at; the stamp is cleared when the run starts, and a stamp whose step is no longer
  the mission's, or on a mission that has a child, is ignored. Waiting for anything else (the owner, CI, a repo's `ahead` or `workers` limits, a cooling model) does not set it.
- `status` prints `running: <n> of <limit> runs` in the active-work section (LOOP-13) and, when any mission
  has the stamp, `oldest wait for a free slot: <intent> <duration>`; with none, the second line is absent.
  The overview shows the same two facts in plain words (UI view model reads the same data as `status`).
- `doctor` prints `slots: <intent> waited <duration> for a free run; the machine has room for <k>, raise
  [agent].parallel from <limit>` while the oldest slot wait is over 30 minutes and the LOOP-103 formula,
  recomputed now, gives more than the current limit. The line is absent when the wait is 30 minutes or
  less, when no mission waits for a slot, or when the formula gives no more than the limit; it disappears
  once the limit is raised or the wait ends. It is a hint: `doctor` changes nothing and its exit code does not change.
- Verified by: `status: runs going against the limit`, `status: the oldest wait for a free slot`, `doctor: suggests raising parallel after 30 minutes with room`, `doctor: the slot line disappears when the wait ends or the limit is raised`, `loop: only waiting for a slot stamps the wait`

### LOOP-110 · Waiting does not hold a build slot

A mission that has its checks green and only waits for a person's review, the gate or the owner does not hold one of its repo's build slots, so the next ready intent can start building. Waiting for GitHub checks still holds the slot (LOOP-115).

- Refines LOOP-61: of the missions from `build` through `merge`, only those *working* count toward
  `[repos.<r>].workers`. A mission is *waiting outside slots* when it has no Claude run or check going or
  asked for, and is `blocked` in the code phase on a question, a missing permission, steps, no repair
  rounds left or any other wait for the owner (also before CI is green, LOOP-115), or its CI is green on the
  current head (LOOP-115) and it is at `review` waiting for a person's review or at `approval:merge`. Every
  other mission from `build` through `merge` (including `ci` while it waits for GitHub checks and while a
  repair runs) is working.
- Changed by LOOP-115: until CI is green on the current head, only a wait for the owner frees the slot;
  waiting for GitHub checks holds it.
- Cap: a repo has at most `3 × workers` missions between `build` and `merge`, working and waiting
  together (6 with the default). At the cap a ready mission does not start `build` even with a free slot.
  The cap is not a new setting. `start` (LOOP-63) does not skip it.
- A slot is free when fewer than `workers` missions are working. The free slot goes to the ready mission
  with the highest priority, as in LOOP-61, unless a returning mission wants it (LOOP-111).
- `[agent].parallel` (LOOP-4) is unchanged and still caps every Claude run and check.
- Verified by: `loop: missions with green CI waiting on review do not hold build slots`, `loop: missions waiting on the owner do not hold build slots`, `loop: at the cap of three times workers nothing new builds`, `loop: a repair at ci holds a slot`

### LOOP-111 · A returning mission goes before a new build

When a waiting mission moves on and every slot is taken, it waits for the next free slot before its next Claude run, ahead of any new build.

- A mission *returns* when what it waited for ends (checks finish, a review or comment arrives, the owner
  answers or replies) and its next step needs a Claude run or check. If fewer than `workers` missions are
  working, it takes a slot at once and counts as working. Otherwise it keeps its stage and waits, without
  a message to the owner; the run is not started and not recorded as launched (LOOP-4).
- A free slot goes first to returning missions, the highest priority first (ties: the one that returned
  first), then to ready missions (LOOP-110). A ready mission never takes a slot while a mission is
  returning. A running build or repair is never stopped for a returning mission; the returning mission
  waits, so working missions never exceed `workers`.
- A returning mission needs no new place under the cap: it is already counted.
- Verified by: `loop: a returning mission takes the next free slot before a new build`, `loop: a returning mission with every slot taken waits without starting`, `loop: returning missions take slots by priority`

### LOOP-112 · status shows slots, waiting missions and why an intent is held

`towercab status` and `next` show how many build slots are in use, how many missions wait outside slots, and the reason an intent is held.

- `status` prints `build slots: <repo> <working> of <workers> used, <waiting> waiting outside slots (cap
  <3 × workers>)` per repo that has a mission from `build` through `merge`, in the active-work section
  (LOOP-13).
- A ready mission (LOOP-64) reads `ready to build, behind <id>` when a slot or a returning mission holds
  it, and `waiting: repo is at the cap of <cap> missions between build and merge, <w> working and <o>
  waiting` at the cap (LOOP-110). When both hold, the cap text is shown.
- A returning mission reads `waiting for a build slot, behind <id>` while it waits (LOOP-111), where
  `<id>` is the mission holding the slot's turn or the returning mission ahead of it.
- The overview ([UI](ui.md) view model) reads the same data as `status`.
- Verified by: `status: build slots used and missions waiting outside slots`, `status: a ready mission at the cap names the cap`, `status: a returning mission names the one ahead`

### LOOP-115 · A repo builds one change at a time until its checks pass

A change keeps its repo's build slot from the start of its build until GitHub checks have passed on its latest push, so the next change never starts on a base that is about to move.

- A mission holds a slot (LOOP-61) from `build` through `verify`, `proof`, `publish` and `ci`, including
  the wait for GitHub checks and repair rounds that go back to `build`. It frees the slot when CI is green
  on the current head; from then its waits for review, the gate, the owner or the merge hold none
  (LOOP-110).
- A mission that becomes `blocked` on the owner before CI is green (a question, a missing permission,
  steps, or no repair rounds left) gives up the slot at once, so one stuck change never stops a repo. The
  next returning or ready mission takes the slot as LOOP-111 and LOOP-110 say.
- When the owner answers, the mission is *returning* and goes first in line for the slot: ahead of other
  returning missions and of ready ones, whatever their priority (ties: the one answered first). A running
  build or repair is never stopped for it. Its next step is to merge the base branch (`main`) into the
  change, as the conflict round does (PIP-31); only then does the build start. From that run it holds the
  slot until CI is green on the current head.
- A mission that comes back to `build` (a review fix round, a conflict round, owner feedback) is
  *returning*: it waits for a slot ahead of new builds (LOOP-111). A new push makes the head new, so it
  holds the slot again until CI is green on that head.
- `[repos.<r>].workers` (default 1, [repo.md](repo.md)) is unchanged and still raises the number of
  missions that hold slots at once. The cap of LOOP-110 and `[agent].parallel` (LOOP-4) are unchanged.
- Supersedes the part of LOOP-110 that freed the slot while waiting for GitHub checks, and puts an
  answered mission ahead of the priority order of LOOP-111.
- Verified by: `loop: a second ready intent does not start while the first waits for CI`, `loop: a second ready intent starts once CI is green`, `loop: a review fix round takes the slot before a new build`, `loop: a new push holds the slot until CI is green on it`, `loop: a change blocked on the owner before CI gives up the slot`, `loop: an answered change takes the next free slot before other returning missions`, `loop: an answered change merges main before it builds and keeps the slot until CI is green`

### LOOP-116 · status shows who holds the slot and that it waits for CI

`towercab status` and `next` name the mission that holds a repo's build slot and say when it is waiting for GitHub checks.

- The `build slots:` line of LOOP-112 is followed, per mission holding a slot, by `holds the slot: <id>
  (<stage>)`, with `, waiting for CI` when it is at `ci` with checks pending and no run going.
- A ready mission held by a slot reads `ready to build, behind <id>` (LOOP-112) where `<id>` is the holder;
  when that holder waits for CI the text adds `, waiting for CI`. The overview reads the same data.
- Verified by: `status: the slot holder is named and shown waiting for CI`, `status: a ready mission behind a mission waiting for CI says so`

### LOOP-117 · A mission re-reads `after:` before it builds

A mission whose intent gains an unfinished `after:` while it runs waits before its next build, instead of building on a base that is missing.

- Applies only to a mission that has not opened a code PR yet. Before it starts `build` or re-enters it
  (after a question, a retry, a spec or plan round), the step re-reads the intent file's current `after`
  (not the value at pick, LOOP-5) and checks each listed intent as LOOP-75 does. Nothing is cached from
  the pick.
- A mission with an open code PR is never held: its CI repairs, review and conflict rounds (PIP-31) go on
  as today, whatever `after:` says. A mission whose code PR was opened and later closed is held again
  only if it has no open code PR when it re-enters `build`.
- While any listed intent is not done (or ended unverified), the mission stays at `build` and starts no
  Claude run: nothing is recorded as launched (LOOP-4), no slot is taken (LOOP-111), no retry or repair
  round is counted, and the owner is not asked anything. The wait is Towercab's own, not the owner's, so
  it is not a blocked wait for the owner and frees the slot as LOOP-110 says. The owner is told only in
  the cases of LOOP-119.
- A list that names an unknown or cyclic intent gives `waiting: bad after:` as in LOOP-5 (a dropped one
  is LOOP-119).
- The check is read again every pass, so an `after:` added or removed in the intent file takes effect
  without a restart. The existing exits of LOOP-76 (`retry`, `drop`) still apply.
- When every listed intent is done or unverified, the mission continues by itself on the next pass as a
  returning mission (LOOP-111), with no reply from the owner. Its next build runs as it would have.
- Does not change picking: an intent with an unfinished `after:` before its pick is still not picked
  (LOOP-75).
- Verified by: `loop: a mission whose intent gains an unfinished after waits at build and goes on when that intent finishes`, `loop: a build is not started while after is unfinished`, `loop: a returning mission re-reads after before building`, `loop: a bad after at build waits with bad after`, `loop: a mission with an open code PR is not held by after`

### LOOP-118 · status says which intent a mission waits for

`towercab status`, `next` and the overview say "waiting for <id>" for a mission held by `after:` at build.

- The reason reads `waiting for <id>: <its stage>` as in LOOP-75, naming the first unfinished intent of the
  `after:` list and adding `(+<n> more)` when several are unfinished. It disappears when the last one is
  done.
- Such a mission is not listed as needing the owner and sends no message, until LOOP-119 applies.
- Verified by: `status: a mission held by after names the intent it waits for`, `status: a mission held by after is not listed as needing the owner`

### LOOP-119 · The owner is told once when a dependency will not finish soon

A mission held by `after:` (LOOP-117) tells the owner once, with one "Needs you" card naming the intent, when that intent is rolled back or dropped, or is still unfinished after 3 days; until then it waits quietly.

- Triggers, checked every pass for a held mission: a listed intent whose last mission ended `rolled back`
  or whose intent was dropped (LOOP-75, LOOP-5), or the mission has been held for 3 days. The 3 days count
  from when the mission was first held for this `after:` list (stored with the wait, so a restart does not
  restart them); a change to the list that adds an intent starts them again.
- The mission then becomes a blocked wait (LOOP-14 **Waits**) whose ask names the intent and why:
  `<id> was rolled back`, `<id> was dropped` or `<id> is still <stage> after 3 days`. It is one card
  (UI-58), written once: later passes, a restart and a further trigger on the same hold add no second
  card, comment or message. A replay after a crash writes nothing twice.
- The mission keeps waiting for the dependency while the card stands: a reply does not start a build. When
  the last listed intent is done the wait ends by itself, the card goes, and the mission continues as in
  LOOP-117. The owner may instead remove the intent from `after:` (the same effect), `retry` or `drop`
  (LOOP-76).
- Verified by: `loop: a rolled back dependency shows one needs-you card`, `loop: a dropped dependency shows one needs-you card`, `loop: a dependency unfinished after 3 days shows one needs-you card`, `loop: a held mission asks nothing before 3 days`, `loop: the card of a held mission goes when the dependency is done`

### LOOP-129 · Telegram messages from the owner reach the shadow

When the shadow is enabled, the loop reads the owner's Telegram messages and hands each to the shadow once.

- `GET <api_base>/bot<token>/getUpdates?offset=<next>&timeout=0` once per pass (10 s timeout), only
  with `[shadow] enabled` and `[telegram]`. The offset is kept in `meta` (`telegram.offset`) and advances
  as SHD-20 says. Failures are logged once per outage without the token and retried with LOOP-10's backoff.
  Updates from other chats are dropped (SHD-2). Reading without the shadow, and the chat's own commands, are
  LOOP-126 and [telegram.md](telegram.md); the one-per-pass poll here becomes the long poll of LOOP-127.
- Verified by: `telegram: owner messages reach the shadow once`, `telegram: update failures never raise`, `telegram: no shadow no polling`

### LOOP-130 · The shadow runs between passes, not inside them

A shadow turn runs as a detached child, so a long answer never delays the loop's polling.

- The turn is started like a build (LOOP-3 children): the loop records it, spawns `claude` in the sandbox
  and reaps it on exit; a crash mid-turn re-runs the turn from its stored message (SHD-20). A turn that takes
  more than 10 minutes is stopped and the owner is told so in one message.
- Verified by: `loop: a shadow turn does not block a pass`, `loop: a shadow turn is re-run after a crash`, `loop: a shadow turn over 10 minutes is stopped`

### LOOP-131 · Shadow commands

The owner can reset the shadow and see its state from the command line and from the chat.

- `towercab shadow reset` (SHD-17) and `towercab shadow status` (enabled or not, session age, turns, pending
  action, today's cost against the cap). In the chat, `/reset` resets the shadow; `/status` is TG-7's, whose
  last line is the shadow's state as above (pending actions included). Any other `/…` text that TG-7..10
  do not take goes to the shadow as ordinary text.
- Verified by: `cli: shadow reset and status`, `telegram: slash reset and status`

### LOOP-132 · Waiting on the owner has its own limit

A repo holds at most `owner_waits` (default 4) specs and plans waiting on the owner, and those waits no longer count toward `ahead`, so a third intent starts even when two others wait on the owner.

- Replaces the cap of `2 × ahead` of LOOP-101, which counted intents waiting on the owner (LOOP-100) with the
  working ones and held a repo back while nothing was being designed or planned.
- New setting `[intents].owner_waits`, int 1–16, default 4, the same for every repo. An intent is *waiting on
  the owner* as LOOP-100 defines it (`approval:spec`, `approval:plan`, or `blocked` in the spec or plan phase
  on a question, an open point, an a0 decision or a missing permission).
- `heldBack` (LOOP-5) skips an intent of a repo when it has `ahead` *working* intents ahead (LOOP-100), or
  `owner_waits` intents waiting on the owner. An intent that outranks every intent ahead (LOOP-101, kept) goes
  over the working limit, not over `owner_waits`: that limit bounds the owner's review queue and the spend.
  When both hold, the owner-waits text is shown.
- `start` (LOOP-63) still goes over every limit. Nothing running or waiting is stopped or dropped; an intent
  that stops waiting counts as working again (LOOP-100), so a repo can briefly exceed either limit.
- Texts (replacing the cap text of LOOP-102): `waiting: repo has <o> intents waiting on you (start <id> to go
  now)` at the owner-waits limit. `status` and `next` never say `repo is at the cap`. Below the limit, intents
  waiting on the owner show as `waiting on you` (UI-61) with no mention of any repo limit.
- Verified by: `loop: with ahead 2 and two intents waiting on the owner at spec a third is picked`, `loop: owner waits at plan do not count toward ahead`, `loop: a repo at owner_waits waiting intents starts no new one`, `loop: an outranking intent does not pass owner_waits`, `loop: the cap of twice ahead no longer holds a repo back`, `config: owner_waits default and range`, `loop: at the working limit only a higher priority intent starts`, `loop: an equal priority intent does not pass the working limit`, `loop: a ready intent does not count toward ahead`, `status: the working limit and the owner-waits limit are told apart`, `status: intents waiting on the owner show without the cap`

### LOOP-133 · Changing an intent's urgency and importance

The owner can change an intent's urgency and importance, and the new priority and order apply on the next pass.

- A change sets `u` and/or `i` (integers 1–5) in the intent file with `setField` (INT-24's front matter; every other line stays byte-identical) in one commit to the intents repo, pushed like any intent edit; changing both is still one commit. Setting the values an intent already has writes nothing. A value outside 1–5, an unknown id, or an intent that is done or dropped is refused with the reason and writes nothing.
- A missing `u` or `i` counts as 3 (PRI-2) and writing it is a change only when the value differs from 3.
- Priority, the parked state (PRI-5) and the order (PRI-4, PRI-6) are computed from the file, so the next pass uses them. An intent that becomes parked and has no mission is not picked; one that rises above the cutoff can be picked (LOOP-5).
- A running mission is never restarted, stopped or undone by a score change; only picks and ordering that have not happened yet change. A change is recorded on the intent's timeline (who, `u: 3 → 4`, through which channel) and in the Activity page as kind `settings` (UI-257).
- Raising or lowering scores needs no confirmation and no proof of channel: they set order, not gates (AUT-35 concerns `a` only). Any channel of the owner may do it: the page, the command line (LOOP-135) and GitHub.
- Verified by: `scores: changing u and i writes only those lines in one commit`, `scores: setting the same values writes nothing`, `scores: a value outside 1 to 5 is refused`, `scores: a done intent is refused`, `scores: the new priority reorders the queue on the next pass`, `scores: a score that parks an intent stops it being picked`, `scores: a running mission is not restarted by a change`, `scores: a change is on the timeline`

### LOOP-134 · Boost: full autonomy and start now in one step

Boosting an intent sets its autonomy to a5 and, when it has not started, starts its design now.

- A `boost` row in `commands` (LOOP-15), applied by the loop only when it comes from the page (`by: page`, as AUT-35 says for a raise); a row from the command line or any other channel is dropped and noted on the timeline (AUT-32). The shadow has no boost of this kind (SHD-8's `boost` raises `u` and `i` and is unchanged; the page names this one "Boost" too, see UI-205).
- Steps, in one `machine`/command application: (1) `a` is set to 5 as AUT-34 describes (one commit), and the worker's `lower_why` (AUT-7; `lower_a` is applied to `a` and never kept in the file) is removed with `removeField` in the same commit; when `a` is already 5 and there is no lowering note, nothing is written; (2) when the intent has no mission and is not done, dropped or paused, it is started as `start` does (LOOP-63), including over the limits and including a parked intent (PRI-5), since the owner named it by boosting it. A paused intent keeps its pause: only `a` is set, and it starts when it is resumed. Step 1 is written before step 2 is recorded. An intent that already has a mission is not restarted and not moved: it only gets `a: 5` from its next gate (AUT-34).
- Refused with a reason, writing nothing: the intent is unknown, done or dropped; its `source` is not `me` (AUT-13), or, with `[auth]`, the person is not allowed a5 for that repo (AUT-23, AUT-24: `boost: a5 is only for the owner's own intents`); an `a0` intent is not refused (the page is an owner channel, AUT-32). A raise flagged by someone else (AUT-35) is accepted by the boost, as "Accept a5" does.
- A boost is a raise: the page asks for the confirmation of UI-257 before posting it (UI-205). Boosting does not change the repo's cap, risk gates, access rules or the worker's right to lower `a` (AUT-7, AUT-8, AUT-14, AUT-18): effective `a` stays the minimum of `a` and the cap, and a high-risk spec, plan or merge still waits for the owner.
- Verified by: `boost: sets a5 and starts an unstarted intent`, `boost: an intent already at a5 is only started`, `boost: a started intent only gets a5`, `boost: removes the lowered note in the same commit`, `boost: a command from the cli is dropped`, `boost: another source is refused`, `boost: a parked intent is started`, `boost: a paused intent only gets a5`, `boost: the cap and the risk gate still hold`

### LOOP-135 · Command line: score

`towercab score <id> [u=<1-5>] [i=<1-5>]` changes an intent's urgency and importance from the command line.

- Inserts a `score` row in `commands` (LOOP-15; applied by the loop, or by the CLI with no loop) and applies LOOP-133. At least one of `u=`, `i=` is required; no argument or a bad value is a usage error (exit 2); a refusal prints `towercab: <reason>` and exits 1. It prints the new priority and whether the intent is parked.
- There is no command-line command for `a` or for boost: raising autonomy stays on the page and GitHub (AUT-35) and `boost` rows from the command line are dropped (LOOP-134). An a0 intent refuses `score` like `start` (AUT-33), because the command line cannot tell the owner from an agent: only the page and GitHub change it.
- Verified by: `cli: score changes u and i`, `cli: score needs a value`, `cli: score refuses a bad value`, `cli: score is refused on an a0 intent`, `commands: score applied without a loop`

### LOOP-136 · A hanging `gh` or `git` call does not hold up stopping

When Towercab is told to stop, it gives running `gh` and `git` calls 10 seconds to finish, then kills them and exits.

- On SIGTERM or SIGINT the loop starts no new pass, poll, check or Claude run, and waits for the `gh` and `git` processes it started (through `Tools`) for at most 10 seconds (fixed, not a setting). Then it sends SIGTERM to each one's process group and SIGKILL 2 s later. A call cut off this way fails with `stopped: <command> was cut off at shutdown`. Its mission is not counted as a failure: the step is re-entered at the next start (LOOP-6).
- The idle waits of `shutdown` (issues, features, readiness, settings, setup checks, limits, shadow) share this one deadline instead of waiting without limit; whatever is still running at the deadline is cut off the same way.
- Claude runs keep their treatment: SIGTERM to the group, SIGKILL after 10 s, `interrupted` (LOOP-7); their sessions resume at the next start. All children are signalled at the same moment and waited for together, not one after another.
- The whole stop therefore takes at most about 15 s (10 s grace + 2 s kill wait + a few seconds to write state), well under the `TimeoutStopSec=60` the unit will get (LOOP-2).
- Verified by: `shutdown: a gh call that never exits is killed after the grace period`, `shutdown: children are stopped together`, `shutdown: a git call that never exits is killed after the grace period`, `shutdown: no new work starts once stopping`, `shutdown: a cut-off call does not count as a failure`

### LOOP-137 · A stop that cut off a hanging call is a clean exit

After a stop that had to kill a hanging `gh` or `git` call, the next start finds nothing to recover.

- `shutdown` ends by removing `meta.running` and exiting 0 (LOOP-7), whether or not LOOP-136 had to kill a child. The next start does not log "the last run didn't exit cleanly; recovering" and does not add to any mission's `unclean` count.
- The loop logs one line at the stop naming each call it cut off: `stop: cut off <command> after <n>s`.
- Verified by: `shutdown: the next start after a cut-off call reports a clean exit`, `shutdown: the stop logs the calls it cut off`

### LOOP-138 · Stale git locks are removed at start

At start, Towercab removes git lock files left in its own clones and checkouts by a process that no longer exists.

- After crash recovery (LOOP-7) and before the first pass, the loop looks for `index.lock` and every other `*.lock` file inside the git directories of `repos/<name>/`, `work/*/` (including a checkout's `.git/worktrees/<name>/` entry in its clone) and the intents clone (`intents/`). Files outside git directories, and `towercab.lock` in the home, are never touched.
- A lock is removed only when both hold: it is older than 2 minutes (by its modification time against the loop's clock), and no lock-holding `git` process is around. A lock fails the second test when any running `git` process (found through `Tools`) has its working directory anywhere inside the lock's checkout, in any other checkout that shares the same clone (the clone itself and all its worktrees), or in a subfolder of any of them. A process whose working directory cannot be read counts as inside.
- A lock that fails either test stays, and the log says which: `start: kept lock <path> (younger than 2 minutes)` or `start: kept lock <path> (git process <pid> running in <dir>)`. A kept lock is not retried at start; the step that meets it fails and is retried as for any other git error.
- Only regular files named `*.lock` are removed; symbolic links are left alone.
- Each removal is logged on its own line: `start: removed stale lock <path>`. A start with no lock found logs nothing. A removal that fails is logged and does not stop the start.
- Verified by: `start: a stale index.lock in a clone is removed and logged`, `start: stale locks in a checkout and its worktree entry are removed`, `start: a lock younger than 2 minutes is kept`, `start: a lock is kept while a git process runs in a subfolder of its checkout`, `start: a lock is kept while a git process runs in another worktree of the same clone`, `start: a lock is kept when a process directory cannot be read`, `start: files outside git directories are never removed`, `start: a symbolic link named like a lock is kept`

### LOOP-139 · The intents repo is synced before the first pass

Before the first pass, Towercab re-syncs the intents repo, so a write cut off by a killed stop is repaired or redone.

- The sync runs after LOOP-138 and before any pass, on every start: fetch, then reconcile with the remote as the normal sync does. A sync failure is logged, retried in the first pass and does not stop the start.
- Verified by: `start: the intents repo is synced before the first pass`, `start: a failed intents sync does not stop the start`

### LOOP-140 · Entering an end state does not need the intent file to be open

When a mission enters an end state (`done`, `unverified` or `stopped`) and its intent file has already been moved to `done/` or is gone, the move completes in one pass without writing the intent file again.

- Only these three mission stages are covered (they are the ones that end an intent: finished, merged but unchecked, and stopped or dropped). Entering any other stage with no open intent file stays an error and is retried next pass (LOOP-6), as today.
- For an end-state entry, the entry effect that writes the intent file (stage, waiting, links, cost) looks the intent up in the intents clone at that moment, not in the listing taken at the start of the pass. An intent found in `done/` or not found at all is skipped, as LOOP-6 already skips one it knows to be closed; the remaining entry effects (feature list, PRs, branches, checkout) still run.
- For an end-state entry, `store.update` refusing with `no open intent matches <id>` is not a failure of the entry: the write is skipped and the entry carries on to its other effects. Any other error (a sync failure, a push rejected) still retries the entry next pass.
- No `entering <stage> failed, retrying next pass` line is logged for the skipped write.
- Verified by: `loop: done on a blocked mission whose intent file was already moved settles in one pass`, `loop: a sync failure still retries the entry of a finished mission`, `loop: entering an active stage with the intent file missing is still retried`

### LOOP-141 · Dropping an intent whose file is already gone settles the mission

When the owner drops an intent by hand and the mission then enters `stopped`, the move completes in one pass with no retry.

- Applies LOOP-140 to `towercab drop`, whether the file is in `done/` (stage `dropped`) or gone: the entry writes nothing to it and still closes the mission's open PRs and retires its branches (PIP-87).
- Verified by: `loop: drop on a blocked mission whose intent file was already moved settles in one pass`

### LOOP-142 · Stay awake under WSL

On Windows through WSL2, Towercab keeps Windows from sleeping while missions are in a working stage.

- WSL is detected when the kernel release (`/proc/sys/kernel/osrelease`) contains `microsoft`, case-insensitively. The check goes through `Tools`, so tests fake it.
- In WSL the inhibitor of LOOP-11 is a `powershell.exe` child instead of `systemd-inhibit`: it calls `SetThreadExecutionState` from `kernel32.dll` with `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` (`0x80000001`) and then sleeps until killed. The child is started, killed and restarted under the same rules as in LOOP-11 (working stage, nothing driven, shutdown), and the wake check applies unchanged.
- The execution state belongs to the PowerShell process's thread, so Windows drops it when the child ends, however it ends.
- Outside WSL the inhibitor stays `systemd-inhibit` as in LOOP-11.
- A missing `powershell.exe` is not fatal: the loop runs without the inhibitor and `doctor` warns (LOOP-143).
- Verified by: `awake: wsl uses a powershell child with ES_SYSTEM_REQUIRED`, `awake: wsl child is killed when nothing is driven`, `awake: outside wsl keeps systemd-inhibit`, `awake: wsl without powershell runs unprotected`

### LOOP-143 · doctor checks WSL

Under WSL, `towercab doctor` checks the things that commonly break there and says how to fix each.

- On every platform: a key or secrets file (the GitHub App key, token files, `config.toml` when it holds a secret) whose mode allows any access to group or others is a failure (exit code 1), except in the self-update check (LOOP-145), where it is a warning. The line names the file and gives the exact fix: `chmod 600 <path>`. Under WSL, a path under `/mnt/` cannot hold the mode, so its `/mnt/` failure (below) is printed first and the line says to move the file rather than to `chmod`.
- The rest runs only when WSL is detected (LOOP-142); elsewhere `doctor` prints none of these lines. `doctor` prints `wsl: <kernel release>` first.
- Failures (exit code 1), each on one line with the fix:
  - systemd is not PID 1 (`/proc/1/comm` is not `systemd`): `enable it with [boot] systemd=true in /etc/wsl.conf, then run wsl --shutdown`.
  - bwrap cannot start a sandbox: the sandbox probe of PIP-163 failed. The line gives the probe's reason and the existing fix pointer of PIP-161/PIP-162 (the AppArmor profile fix where user namespaces are restricted, else "check bwrap"). Nothing WSL-specific is added, and `sandbox_unix_sockets` is not involved.
  - The config directory, the home directory of Towercab or any repo's clone path is under `/mnt/`: `keep it in the Linux file system (for example under ~)`.
- Warnings (exit code unchanged):
  - `powershell.exe` is not on `PATH`, so Windows may sleep while missions run.
  - No keep-alive: systemd is PID 1 but `vmIdleTimeout` is not set under `[wsl2]` in the Windows user's `.wslconfig` (read through `powershell.exe`), so WSL may stop its VM and the service with it. The line gives the fix: `set vmIdleTimeout=-1 under [wsl2] in %UserProfile%\.wslconfig, then run wsl --shutdown`. If `.wslconfig` cannot be read, the line says so and gives the same fix.
- `doctor --quick` runs the file, path and `.wslconfig` checks and skips the bwrap probe.
- Verified by: `doctor: wsl prints the kernel release`, `doctor: wsl without systemd as pid 1 fails`, `doctor: wsl failed sandbox probe fails`, `doctor: wsl paths under /mnt fail`, `doctor: a secrets file not mode 600 fails with the chmod`, `doctor: a loose secrets file fails outside wsl`, `doctor: wsl without powershell warns`, `doctor: wsl without vmIdleTimeout warns`, `doctor: wsl with vmIdleTimeout is quiet`, `doctor: outside wsl prints no wsl lines`

### LOOP-145 · Loose permissions never block a self-update

The self-update check only warns about a secrets file that others can read, so a permissions slip can't keep Towercab from updating.

- The check of LOOP-35 runs `bin/towercab doctor --quick --for-update`. With that flag the loose-secrets line of LOOP-143 prints as a warning (`warning: <path> is readable by others: chmod 600 <path>`) and does not change the exit code. Every other failure of `doctor --quick` still fails the update and rolls it back.
- A warning in that check does not stop the update and sends no `self-update failed` message. The full `doctor` (without the flag) and the Problems block (UI-277) still show it as a failure with the `chmod 600` fix, on every platform.
- Verified by: `update: a loose secrets file only warns`, `update: another doctor failure still rolls back`, `doctor: --for-update turns a loose secrets file into a warning`, `doctor: a loose secrets file fails without the flag`

### LOOP-144 · A guide for Windows through WSL2

A written guide takes someone on a fresh Windows machine to a running Towercab, and the README claims Windows support only after the guide has been tried end to end.

- `docs/windows-wsl.md` covers, in order: installing Ubuntu in WSL2; enabling systemd; keeping everything in the Linux file system; installing and logging in to `claude` and `gh` inside WSL; installing bwrap and what to do if user namespaces are restricted (it follows PIP-162, not turning the restriction off); keeping the WSL VM running while Windows is idle (`vmIdleTimeout=-1` under `[wsl2]` in `.wslconfig`, which `doctor` warns about, LOOP-143); running `towercab doctor`; opening the UI at `http://localhost:7311` from Windows.
- The guide says what is not supported: config, clones or the build cache under `/mnt/`.
- The README's Requirements say Windows works through WSL2 only once the guide's steps have been run end to end on a Windows machine and the result is noted in the pull request. Until then the README does not mention Windows.
- Verified by: `manual: follow docs/windows-wsl.md on a fresh Windows machine to a mission opened from the UI`, `public: README claims Windows only with the guide present`

### LOOP-146 · Several places for waiting-on-you messages

Towercab's messages go to every place the owner set up, Telegram and any number of webhooks together, and a setup with only Telegram keeps working untouched.

- The destinations are `[telegram]` (when set) and each `[[notify.webhook]]` table (LOOP-147). With neither, rows are written and never sent (LOOP-16). There is no channel switch: removing a section turns that destination off.
- Every destination gets every outbox row (LOOP-14), independently. The outbox keeps, per row and destination, whether it was sent (`outbox_sent`, keyed by row key and destination: `telegram` or `webhook:<name>`). A row leaves the queue when every destination has it or its wait is over. Each destination sends oldest first, stops at its own first failure and backs off on its own (LOOP-10), so a failing webhook never delays Telegram or another webhook. The loop's pass and the rows are unchanged.
- A webhook added later sends only rows written after it was added, so a new webhook does not replay old waits: its first appearance is stored in `meta` (`notify.added.webhook:<name>`, the time of the first pass that sees it) and older rows are skipped for it. Removing a webhook and adding it again under the same name keeps the first time.
- On upgrade, the `outbox_sent` table is created and seeded once from the outbox as it was: every row whose `sent_at` is set gets a `telegram` entry with that `sent_at`, and the Telegram backoff state (`tries`, `next_try`) of unsent rows is copied too. Telegram's rows keep their old meaning, so nothing Telegram already sent is sent again, and a row still waiting for Telegram is still sent. The seed runs in the same transaction as the migration and is a no-op when repeated. Telegram has no "added" time: its unsent rows stay eligible as today.
- Reading the owner's chat (LOOP-129, LOOP-130), buttons, replies and the shadow stay tied to `[telegram]`; `shadow.enabled` still needs `[telegram]`. Rows that only edit a Telegram message (TG-5) are sent to Telegram only.
- Telegram's text is unchanged (the full text of LOOP-14); it has no detail setting.
- Verified by: `notify: telegram only keeps working unchanged`, `notify: no destination sends nothing`, `notify: telegram and two webhooks each get every row`, `notify: a failing webhook does not delay the others`, `notify: a row stays queued until every destination has it`, `notify: a new webhook skips older rows`, `notify: a re-added webhook keeps its first time`, `notify: upgrade marks rows telegram sent as sent`, `notify: upgrade keeps rows telegram has not sent`, `notify: the seed is run once`, `notify: edit rows go to telegram only`, `notify: a webhook keeps the telegram reading`

### LOOP-147 · Webhook delivery

Each webhook the owner sets up gets every message as JSON, posted to a secret URL kept in a file only the owner can read, and failures retry quietly without ever printing the URL.

- `[[notify.webhook]]` is a list of tables with `name` (required, unique, `[a-z0-9_-]+`; it names the webhook in logs, `doctor` and LOOP-146), `url_file`, `template` (LOOP-148) and `detail` (LOOP-149). A duplicate or missing name fails the config load with `config: <file>: notify.webhook name …`.
- `url_file` is an absolute path or starts with `~/`; the file is a regular file, mode 600, holding one line with a URL (the same file checks as `gitlab.token_file`, [gitlab.md](gitlab.md)).
- The URL is `https://`, except that `http://` is allowed when the host is written as a local address: `localhost`, an IPv4 address in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`, `[::1]`, or a name ending in `.local`, for a self-hosted Mattermost. The host is judged as written; no name is looked up, so a public name that resolves to a private address still needs `https://`. Any other scheme, a URL with no host, or a plain `http://` to another host is refused with `url_file: http is only allowed for local addresses` (or `url_file: not an https url`), without the URL in the message. The URL is read from the file at each send and never kept in memory between sends, in `meta`, in the outbox or in the UI.
- `POST <url>` with `Content-Type: application/json` and the body of LOOP-148, 10 s timeout. A 2xx answer marks the row sent. Anything else (other status, timeout, network error) is a failure; redirects are not followed.
- Unsent rows go oldest first, stop at the first failure and retry with LOOP-10's backoff, exactly like Telegram (LOOP-16). A failure is logged once per outage as `webhook <name>: <reason>` and once again when it recovers; the reason is a status code, `timeout` or an error class, and never contains the URL, the response body or a text from the URL's host. Failures never raise out of the pass.
- A url file that is missing, loose or malformed counts as a failure with the reason `url_file <why>` (the path, not the URL) and is retried at the next backoff; a loose or missing file at config load fails with `config: <file>: notify.webhook.<name>.url_file <why>`. `doctor` checks every webhook's file like the other secrets files (LOOP-143).
- Verified by: `webhook: names must be unique`, `webhook: posts json with the default body`, `webhook: retries until sent`, `webhook: failures never raise`, `webhook: oldest first and stops at the first failure`, `webhook: one log line per outage`, `webhook: the url never appears in a log line`, `webhook: a redirect is a failure`, `webhook: a loose url file is refused`, `webhook: https is accepted`, `webhook: http is accepted for localhost and private addresses`, `webhook: http to a public host is refused`, `webhook: a name that resolves privately still needs https`, `webhook: other schemes are refused`, `webhook: a refusal never shows the url`, `webhook: the url is read at each send`, `doctor: a loose webhook url file fails with the chmod`

### LOOP-148 · Webhook body template

The owner can change the shape of the webhook body for chat services that expect something other than `{"text": "…"}`.

- A webhook's `template` is a TOML string holding a JSON document; the default is `{"text": "{text}"}`. Two placeholders are replaced wherever they appear inside a JSON string: `{text}` (the whole message, as LOOP-149 builds it for that webhook) and `{link}` (the link alone, or an empty string). The value is inserted JSON-escaped, so quotes, newlines and non-ASCII characters in a title cannot break the document. Written in TOML: `template = '{"channel": "ops", "content": "{text}"}'`.
- No other placeholder exists; any other `{…}` text stays as written. A placeholder outside a JSON string, or a template that is not valid JSON once both placeholders are replaced with a sample, fails the config load with `config: <file>: notify.webhook.<name>.template <why>`.
- The message is capped at 4000 characters before it is inserted (LOOP-16).
- Verified by: `webhook: the default body is {"text": …}`, `webhook: a template fills text and link`, `webhook: a title with quotes and newlines stays valid json`, `webhook: an unknown placeholder stays as written`, `webhook: an invalid template fails the config`

### LOOP-149 · Webhook detail: full or minimal

Each webhook says only how many things wait for the owner, with a link, unless the owner turns on the full text for that webhook.

- A webhook's `detail` is `"minimal"` (the default) or `"full"`, set per webhook. `minimal` is `<N> things wait for you in Towercab: <link>`, or `1 thing waits for you in Towercab: <link>` when N is 1. N is the number of missions waiting on the owner when the message is sent (LOOP-14's **Waits**), so a queued message always shows the current count. When N is 0 (a row about GitHub, Claude or a failed update) the text is `Towercab needs a look: <link>`. The link is the address of Towercab's local page (UI-1). The text has no intent title, repo, reason, PR link or intent id. `{link}` (LOOP-148) is that same address.
- `full` is the text of LOOP-14, as Telegram gets it.
- An unknown `detail` fails the config load with `config: <file>: notify.webhook.<name>.detail …`.
- Telegram is unchanged and has no `detail` setting.
- Verified by: `webhook: detail defaults to minimal`, `webhook: minimal counts the waits at send time`, `webhook: minimal with one wait is singular`, `webhook: minimal with no waits says Towercab needs a look`, `webhook: minimal has no title, repo, reason or id`, `webhook: full detail sends the usual text`, `webhook: each webhook uses its own detail`, `webhook: an unknown detail fails the config`

### LOOP-150 · Update channel

The owner chooses whether Towercab updates on every change to `main` or only on a new release.

- `[update].channel` is `"main"` (the default) or `"release"`. Anything else fails the config load with `config: <file>: update.channel must be "main" or "release"`.
- `"main"` is LOOP-35 as it is: nothing changes for a config without the key.
- `[update].auto = false` still turns every update off, whatever the channel.
- On `"main"`, a clean checkout sitting on a release tag (a detached HEAD at a `v` tag, for example after the owner left the release channel) moves back to `main` at the next update check, so an owner is never left on a version that no longer updates. It goes through the same drain (LOOP-108..109), `git checkout main` then `git merge --ff-only origin/main`, install, `bin/towercab doctor --quick --for-update` and exit 75, and the same rollback and `self-update to <short commit> failed: <why>` message (LOOP-35, LOOP-108). A failure puts the checkout back on the tag. A dirty checkout is left alone.
- Verified by: `update: channel defaults to main`, `update: an unknown channel fails the config`, `update: auto false stops updates on the release channel`, `update: the main channel moves a checkout on a tag back to main`, `update: moving back to main drains first`, `update: a failed move back to main returns to the tag`, `update: a dirty checkout on a tag is left alone on the main channel`

### LOOP-151 · Update to the newest release

On the release channel, Towercab moves only to a newer release tag, never to a new commit on `main`.

- A release tag is `v<major>.<minor>.<patch>` (for example `v1.1.0`), with no prefix before the `v` and no suffix after the patch. Any other tag is ignored, so pre-release tags such as `v1.2.0-rc1` are never installed: the channel is for final versions only. Tags are compared as numbers, so `v1.10.0` is newer than `v1.9.0`.
- A release tag counts only when its commit is an ancestor of `origin/main` (`git merge-base --is-ancestor <tag> origin/main`). Any other release tag is skipped, and the log says why (`release <tag> skipped: its commit is not on main`), once per tag while the loop runs. The check then takes the newest tag that counts.
- The check of LOOP-35 runs `git fetch --tags` and takes the newest release tag that counts. It acts only when that tag is newer than the running version (LOOP-152). A tag equal to or older than it does nothing, so the checkout never moves to an older release, and a new commit on `main` alone does nothing.
- With no release tag that counts, the check does nothing and the running version stays; it is not an error and sends no message.
- The checkout may be clean and on `main`, or clean and on a release tag (a detached HEAD at a `v` tag); either is acceptable for updating.
- The update then goes as LOOP-35 and LOOP-108..109 describe, with the tag as the target: drain, `git checkout --detach <tag>`, `npm ci` when `package-lock.json` changed, `npm run build:ui` when `ui/` changed, `bin/towercab doctor --quick --for-update` (LOOP-145), exit 75. A failure puts the checkout back where it was (the previous commit, on its branch when it was on one, or the previous tag), keeps running and sends one message `self-update to <tag> failed: <why>`. The loop does not drain for that tag again while it runs (LOOP-108), but does for a newer one.
- `towercab update` does the same now on this channel.
- Verified by: `update: release channel ignores a new commit on main`, `update: release channel moves to a newer tag`, `update: release channel never moves to an older tag`, `update: tags compare as numbers`, `update: tags that are not vMAJOR.MINOR.PATCH are ignored`, `update: a pre-release tag is never installed`, `update: a tag not on main is skipped and logged`, `update: the newest tag on main is chosen over a newer tag off main`, `update: no release tags keeps the running version`, `update: a checkout on a release tag is updated`, `update: a failed check on a tag rolls back to the previous position`, `update: a failed tag is not drained for again`

### LOOP-152 · Running version and waiting release

`status` shows which version is running and, on the release channel, whether a newer release is waiting.

- The running version is the release tag the checkout sits on (`v1.1.0`), or `git describe --tags --match 'v[0-9]*'` of HEAD when it is past a tag (`v1.1.0-3-g<short commit>`), with the short commit as well. With no release tag in the history it is the short commit alone.
- On the release channel, `status` adds `update: <tag> is available` when the newest release tag (LOOP-151) is newer than the highest release tag reachable from HEAD, and `up to date` otherwise. On the `"main"` channel the line of LOOP-35 (behind `main` or not) is unchanged and the version is shown beside it.
- The newest tag is the one found by the last check (LOOP-151); `status` runs no fetch of its own.
- Verified by: `status: shows the running version on a tag`, `status: shows the version past a tag with the commit`, `status: shows the commit when there are no tags`, `status: release channel says a newer release is available`, `status: release channel says up to date`

### LOOP-120 · Telegram message when a reply is posted

When Towercab has answered the owner's comment and the PR waits for the owner again, the owner gets a short Telegram message with a link to the reply.

- One message per posted reply (PIP-204): the mission keeps the reply's gist and link (`replyNote`), and the message of its next wait for the owner on that PR (an `approval:*` wait: the spec, plan or code PR) carries them, once. It names the intent, the PR and the gist (first sentence) of the reply, and links to the general reply comment (PIP-204), not to the pointers in line threads; ≤ 4000 characters (LOOP-16). A move that is not such a wait sends nothing for the reply. It replaces no other message for the same wait: the usual "ready for you" message, if any, is not sent twice (one message covers both).
- Buttons and reply-to-answer follow [telegram.md](telegram.md). With no `[telegram]`, the row is written and never sent (LOOP-16).
- Verified by: `telegram: a posted reply sends one message with a link`, `telegram: the message names the intent, the PR and the gist`, `telegram: a reply and the ready message are sent once`

### LOOP-121 · No message for a revision Towercab started itself

Telegram stays quiet for revisions the owner did not ask for, so it only goes out when the owner has something to do.

- A revision started by red checks, a conflict or a review or gate fix writes no reply (PIP-203) and no LOOP-120 message. If such a revision ends with the PR waiting for the owner, the existing messages of LOOP-16 apply unchanged. Replies by Towercab never count as feedback (PIP-206), so they send nothing on their own.
- Verified by: `telegram: a revision Towercab started sends no reply message`, `telegram: a reply that leaves the PR not waiting sends nothing`

### LOOP-122 · A missing App install comes with the steps to fix it

When the GitHub App isn't installed on a repo, the error stays one short line and carries plain steps with a direct link to fix it.

- The 404 of `GET /repos/<owner/name>/installation` (LOOP-19) still throws `the GitHub App isn't installed on <owner/name>`, now as an `AppNotInstalled` error (an `Error`, so LOOP-66's text is unchanged) that carries `help: {app, url, steps[]}`. The help is looked up when the error is made, never before: `GET /app` (JWT) gives the App's `name` and `slug`; `GET /users/<owner>/installation` (JWT; works for users and organisations) says whether the App is installed on that account.
- Not installed on the account: `url` is `https://github.com/apps/<slug>/installations/new`; steps: `Open <url>`, `Choose <owner> and pick <repo>`, `Install`, then `Try again`. Installed on the account with `repository_selection: selected`: `url` is the installation's settings page, `https://github.com/settings/installations/<id>` (an organisation: `https://github.com/organizations/<owner>/settings/installations/<id>`); steps: `Open <url>`, `Under Repository access, add <repo>`, `Save`, then `Try again`. Installed on all repos (the 404 is then odd): the settings link with `Check that <repo> isn't excluded`. Each step names the App as `<name>`, as GitHub shows it.
- Stored install URL: whenever `GET /app` answers, Towercab stores the App's public install URL `https://github.com/apps/<slug>/installations/new` and its `name` in `meta` (`app-install-url`, `app-name`), replacing older values. Nothing else is configured.
- Fallback: if either lookup fails (network, GitHub's refusal, no key), the help uses the stored name and install URL (the steps of a new install). Only if none was ever stored, it names the steps without the App's name and `url` is `https://github.com/settings/installations`. The lookup never changes the error's first line and never makes `repo add` fail differently.
- The links and steps hold no token, key or JWT. The 404 itself is not cached, so the next try asks GitHub again and succeeds once the App is installed.
- Verified by: `app: a missing install says how to install the App`, `app: a selected-repos install links to its settings`, `app: help falls back to the stored install URL`, `app: help falls back to the general settings link when nothing was stored`, `app: install help holds no token`

### LOOP-123 · `repo add` prints the install steps and works again after them

On the command line, the install steps print under the error, and running the same command after installing the App adds the repo.

- `repo add` for a repo that fails with LOOP-122 prints `towercab: Towercab can't reach <owner/name>: the GitHub App isn't installed on <owner/name>` (LOOP-66, exit 1), then one line per step, indented two spaces, then `Then run the same command again.`. Any other refusal prints as before.
- The steps travel with the error in the repo-add result (`help`), so the page (UI-209..212) and the problems built from a failed add (UI-60) read them from the same place; no copy of the text lives in the page.
- Running `repo add <owner/name>` again after the install adds the repo with nothing else typed or changed.
- Verified by: `cli: repo add prints the install steps after the error`, `cli: repo add works again once the App is installed`, `repos: add carries the install help in its refusal`

### LOOP-124 · `towercab add` checks for overlap and asks

`towercab add` at a terminal reports intents that overlap the new one and asks before writing; in a script it writes as before and runs the paid check only when asked.

- **At a terminal** (stdin and stdout are a TTY): `add` runs the overlap check (INT-73) and, with no match, writes straight away as INT-71 says. With matches it prints one line each: `<kind> <ref> <title>`, then `  <how>`, and a `Title: <titleNote>` line if there is one, then asks `Create anyway (y), add to one of them (its number), or cancel (n)? [y/n/<number>]`. Only matches that `canAddTo` (INT-74) are numbered; a match past design is printed with `already past design: write a new intent and link <id>` and has no number. `y` writes a new intent; a number applies INT-74 with the text given (the command line has only the title, so the title is added as a line under `## Proposed outcome`); anything else, or an end of input, cancels: exit 1, nothing written, `towercab: cancelled`. `--no-check` skips the check and the question; it is also accepted outside a terminal, where it changes nothing.
- **Not at a terminal** (a script, a pipe): `add` does not run the check, writes the intent at once and prints what INT-2 says, exactly as before, so no script changes. `--check` runs the check anyway; matches are then printed to stderr as a warning (`towercab: warning: this may overlap <kind> <ref> <title>`, one line each, `  <how>` under it) and the intent is written regardless, exit 0. There is no question and no refusal.
- A failed check (INT-73) prints `towercab: the overlap check failed: <reason> (skipped)` on stderr; at a terminal it asks whether to create anyway the same way, and with `--check` in a script it writes anyway. With `--no-check` the check never runs.
- Verified by: `cli: add with no overlap writes straight away`, `cli: add lists overlaps and asks`, `cli: add creates anyway on y`, `cli: add adds to the chosen intent`, `cli: add offers no number for an intent past design`, `cli: add cancels on n or end of input`, `cli: add without a terminal writes and runs no check`, `cli: add --check without a terminal warns and writes`, `cli: add --no-check skips the check`, `cli: add says the check failed and asks`

### LOOP-125 · The overlap check is a side run, outside any mission

An overlap check runs when the owner asks for it, takes no slot, and its cost shows in the spend.

- It runs in the process that serves the request (the page's server or the command), not in a pass, and takes no build slot (LOOP-110); at most 2 run at once, a third waits. Pause (LOOP-113) does not stop it, because the owner asked for it, but a draining service (LOOP-108) refuses it with `Towercab is restarting; try again in a minute`.
- Its cost is stored as a run with no mission and kind `overlap`, and counts in the day's spend and in the caps' totals (MET-29, MET-33); the Spend view lists it as `Overlap checks`.
- Verified by: `overlap: a check takes no build slot`, `overlap: a check runs while paused`, `overlap: a draining service refuses a check`, `overlap: its cost counts in the day's spend`, `overlap: two checks at most run at once`

### LOOP-113 · Pause stops all new work

While Towercab is paused, no mission starts anything new, but steps already running finish and are applied.

- Owner pause (`meta.paused`, LOOP-15) now holds every mission, not only picks and merges (LOOP-5, PIP-22). While
  paused, no new child process starts for any mission: no Claude run, check, setup or screenshot, and no fix round.
  A mission due for its next step stays at its recorded step, not counted as a crash, repair or timeout.
- A child already running is left alone: it finishes, and its result is applied through `machine.apply` as usual.
  The mission then holds at the next step. A health pause (LOOP-10) is unchanged.
- Nothing that changes GitHub happens while paused: no push, no pull request opened or updated, no comment, no
  review, no merge (PIP-22 already holds merges). A finished step's result is recorded and applied, and the
  mission then waits at the step that would write, with nothing lost or repeated (LOOP-6: the handler records
  before any side effect). On resume the write happens as it would have.
- Reading continues while paused: PR and CI state and owner events are polled (read-only), so the page stays current
  and an owner's reply is recorded. Replies and other effects that need a write wait for resume. Telegram
  messages (LOOP-16) are not GitHub and still go out.
- `status` and the page (UI-109) say `paused: <n> running steps finishing` while `n > 0` children run, and
  `paused` once none do. `n` counts running children, whichever mission they belong to.
- `resume` lifts the hold; every mission continues from the step where it stopped, with no change to its counters.
- How it is held: the loop's forge, `git push` and intents store refuse changes while `meta.paused` is set
  (`held while paused: <what>`, never a failure or a health fault); a stage's entry effects, the settings and
  release polls and the ticked steps wait for resume. A result whose write was held is kept and applied again after
  resume. The owner's own commands still apply, but `towercab approve` and `towercab reply` answer
  `paused: resume first`.
- This is the global pause only. The per-intent pause (SHD-22, UI-239) keeps its meaning: it holds only that
  intent's next step and never stops running work.
- Verified by: `loop: a paused loop does not start the next step of a mission`, `loop: a running step finishes and is applied while paused`, `loop: a paused loop makes no GitHub writes`, `loop: held git pushes`, `loop: polling continues while paused`, `status: paused counts running steps finishing`, `loop: resume continues missions where they stopped`

### LOOP-114 · Pause now stops running children

`towercab pause --now` also stops the children that are running, cleanly, and `resume` continues them from their session.

- `pause --now` is `pause` (LOOP-113) plus: the loop sends SIGTERM to each running child's process group, then
  SIGKILL after 10 s, as for a shutdown (LOOP-7). Each cut-off mission gets `interrupted`, which is not counted as
  a crash (LOOP-7), a repair or a timeout, and no message goes to the owner.
- It is a `pause` row in `commands` (LOOP-15) with a `now` flag, applied by the loop on its next pass; with no loop
  running there is nothing to stop and it is a plain `pause`. The flag is not kept: a later plain `pause` stops
  nothing.
- On `resume`, a cut-off Claude run continues its own session (`--resume <uuid>`, prompt `Continue where you
  stopped.`, LOOP-7); a cut-off check or other non-Claude step runs again from its start.
- `status` shows `paused: stopping <n> running steps` until they have exited, then `paused`.
- `--now` exists only for the global pause. `pause <id> --now` is refused with `--now stops everything: use it
  without an intent`; a per-intent stop is a later intent.
- Verified by: `cli: pause now is a command with the now flag`, `cli: pause now is refused for one intent`, `loop: pause now stops running children`, `loop: a child stopped by pause now is not counted as a crash`, `loop: resume continues the sessions stopped by pause now`

### LOOP-126 · The loop reads Telegram with or without the shadow

With `[telegram]` set, the loop reads the owner's chat for buttons, replies and commands, whether or not the shadow is enabled.

- Replaces the condition of LOOP-129 (`[shadow] enabled`): updates are read whenever `[telegram]` is set. Without
  `[telegram]` nothing is read. Each update is stored once (keyed by `update_id`, `meta` `telegram.offset` as
  SHD-20 says) before the offset moves past it, then handled in a pass: a button press (TG-3..5, TG-10), a reply
  to a question (TG-6), a command (TG-7..10) or text for the shadow (TG-15, LOOP-129). `allowed_updates` is
  `message` and `callback_query`.
- Updates from other chats are dropped and logged (TG-1). A failed read is logged once per outage without the
  token and retried with LOOP-10's backoff; it never raises and never stops the pass.
- A handled update's effect (an action, a reply, an edit) is recorded before it is applied (LOOP-6), so a
  crash neither repeats an action nor loses its answer.
- Verified by: `telegram: updates are read without the shadow`, `telegram: an update is stored once before the offset moves`, `telegram: no telegram config no polling`, `telegram: a crash after a button press does not repeat the action`

### LOOP-127 · Telegram is long-polled beside the loop

Towercab waits for Telegram on an open request, with no inbound port, and never slows the loop to do it.

- The read of LOOP-126 is `getUpdates` with `timeout=25` (HTTP timeout 35 s), run beside the 5 s pass, not inside
  it: the pass only handles updates already stored. A press or a command is therefore answered within about one
  pass (5 s), not after a poll. Towercab opens no listening port for Telegram (no webhook): it runs on the
  owner's laptop.
- The poll stops when the loop stops (LOOP-7) and restarts from the stored offset; while paused (LOOP-113) it
  continues, since reading is not a write. Tests use the injected clock and a fake Telegram API, never real
  waiting.
- Verified by: `telegram: a long poll does not delay a pass`, `telegram: the poll stops on shutdown and resumes from the offset`, `telegram: polling continues while paused`

### LOOP-128 · Sent messages are remembered so they can be edited

Each message Towercab sends is kept with its Telegram id, so it can be edited later instead of replaced.

- An outbox row (LOOP-16) gets `kind` (`wait`, `info`), `intent`, `wait` (the id TG-5 names), `tg_message_id`
  (set once `sendMessage` returns) and `ended` (outcome text or null). An edit is its own outbox row
  (`editMessageText`, ≤ 4000 characters) sent in order, oldest first, retried with LOOP-10's backoff, and
  skipped when Telegram refuses it (message gone or too old; logged once).
- `answerCallbackQuery` for a press is sent first, ahead of other rows, so the button stops spinning at once.
- Rows keep for 30 days after their wait ends, then are removed with the rest of the outbox's old rows. An
  edit for a message whose id was never recorded (the send failed for good) is dropped.
- Verified by: `telegram: a sent message records its id`, `telegram: edits are sent in order and retried`, `telegram: a press is answered before other rows`, `telegram: old rows are removed`

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
  `<home>/repos/<name>`), `ship_network` (`ship_network=a.com,*.b.com` sets the platform domains the repo's ship commands may reach, [PIP-158](pipeline.md); empty clears them), `env` (`env=NAME=value` sets one variable, `env=NAME=` sets it empty;
  `env={"NAME":"value",…}`, a JSON object of strings, replaces them all). Several pairs at once; one bad
  pair changes nothing. Prints the repo's `repo list` line after `set `. The running loop uses the new
  values from its next pass (LOOP-68).
- `workers` and `ahead` are read from the repo's `TOWERCAB.md` once it has one ([REPO-14](repo.md),
  [REPO-15](repo.md)): `repo list` and the loop use the value in force, and after the repo has moved,
  `set` refuses both with `workers and ahead for <name> now live in TOWERCAB.md; change them on the
  repo's page or in the file.`
- `base` and `path` change only while no mission needs the repo (as for `repo remove`): `<name> has
  unfinished intents (<ids>): change base or path once they are done`.
- Other refusals: `<key> must be an integer 1-16`; `base: <value> is not a branch name`; `path must be
  absolute or start with ~/`; `env must be NAME=value or a JSON object of strings`; `env <NAME>: <reason>` for a name or value the sandbox leaves out ([PIP-159](pipeline.md)); `unknown setting
  <key>: use workers, ahead, base, path or env`; `<pair> isn't key=value`; `<name> isn't a repo Towercab
  knows (towercab repo list)`.
- Verified by: `repos: set changes a repo's settings`, `cli: repo commands`

### LOOP-83 · A repo can require a reviewer other than the owner

`towercab repo set <name> teammate_review=on` marks a repo whose changes need a teammate's approval, and `reviewers=` lists who may give it.

- Keys: `teammate_review` (`on` or `off`, default `off`) and `reviewers` (comma-separated host logins,
  e.g. `reviewers=alice,bob`; `reviewers=` empties the list). Both live in Towercab's `repos` table
  (LOOP-65), never in the shared repo. Migration 6 adds the columns `teammate_review INTEGER NOT NULL
  DEFAULT 0` and `reviewers TEXT NOT NULL DEFAULT ''` (additive, LOOP-37); the **Schema** block shows them. `repo list`
  shows `· teammate review: alice, bob` (or `· teammate review: CODEOWNERS`) for an `on` repo.
- Refusals, in addition to LOOP-69's: `teammate_review must be on or off`; `reviewers: <login> is not a
  login` (logins are `[A-Za-z0-9-]`, up to 39 characters); `reviewers: <login> is you: the owner cannot
  review their own change` (the owner is `[github].me`, case-insensitive; the App's bot is refused the
  same way). A listed login is stored lowercase, once.
- `reviewers` set while `teammate_review=off` is kept and does nothing. The running loop uses the new
  values from its next pass (LOOP-68), including for missions already in flight.
- Verified by: `repos: set teammate_review and reviewers`, `repos: reviewers refuses the owner and the bot`, `cli: repo list shows teammate review`

### LOOP-84 · doctor warns when the host requires approvals and the setting is off

`towercab doctor` tells the owner when a repo's host demands approvals that Towercab is not waiting for.

- For each repo with `teammate_review=off`, `doctor` reads the base branch's protection (GitHub:
  `gh api repos/<r>/branches/<base>/protection`, `required_pull_request_reviews.required_approving_review_count`,
  and rulesets with a pull-request rule) and, when it requires 1 or more approvals, prints `<name>:
  GitHub requires <n> approval(s) but teammate review is off: run towercab repo set <name>
  teammate_review=on reviewers=<logins>`. It is a warning: the exit code does not change.
- For each repo with `teammate_review=on` and a non-empty list, when the host requires `n` approvals
  and fewer than `n` reviewers are listed (the owner never counts), it prints `<name>: GitHub requires
  <n> approvals but only <k> reviewers are listed: run towercab repo set <name> reviewers=…`. An empty
  list is not warned here: code owners may supply them (PIP-142); the PR's card warns when they don't
  (PIP-147).
- A repo whose protection cannot be read (no permission, 404) prints nothing for it and `doctor --quick`
  (LOOP-35) skips the check; it never fails because of it.
- Verified by: `doctor: a required approval with teammate review off is a warning`, `doctor: an unreadable branch protection is not a warning`, `doctor: fewer listed reviewers than required approvals is a warning`

### LOOP-153 · A repo has a merge method

`towercab repo set <name> merge_method=<method>` chooses how Towercab merges that repo's pull requests: `squash` (the default), `merge`, `auto`, or `rebase` for a repo whose rules allow nothing else.

- Keys: `merge_method` is `squash`, `merge`, `rebase` or `auto`, default `squash`. It lives in Towercab's `repos` table (LOOP-65), never in the shared repo. Migration adds `merge_method TEXT NOT NULL DEFAULT 'squash'` (additive, LOOP-37); the **Schema** block shows it. `repo list` shows `· merge: <method>` for a repo that is not `squash`.
- `auto` is opt-in and follows what the host allows: when Towercab merges, it reads the repo's allowed methods and takes the first allowed of `squash`, `merge`. It takes `rebase` only when neither is allowed. If the settings cannot be read, or no method is allowed, it uses `squash`.
- Rebase is a last resort. `repo set merge_method=rebase` is accepted only when the host allows rebase merges and neither squash nor merge; otherwise it refuses with `merge_method: rebase is only for repos that allow nothing else (<allowed>): use squash, merge or auto`, and when the settings cannot be read, with `merge_method: can't read <owner/name>'s merge settings to check that rebase is the only method allowed`.
- The allowed methods come from a new `Forge` read, `allowedMergeMethods(repo)` (GitHub: `allow_squash_merge`, `allow_merge_commit`, `allow_rebase_merge` of `gh api repos/<r>`). `Forge.mergePr` takes the resolved method in its `method` option, which grows from `"squash"` to `"squash" | "merge" | "rebase"`; callers pass the repo's resolved method instead of the `MERGE_METHOD` constant.
- Other refusals, in addition to LOOP-69's: `merge_method must be squash, merge, rebase or auto`. The unknown-key refusal of LOOP-69 lists `merge_method`. The running loop uses the new value from its next pass (LOOP-68), including for missions already in flight.
- Only GitHub repos use it. A GitLab repo keeps squashing (GL-5) and `repo set` on it refuses `merge_method` with `merge_method is only for GitHub repos`.
- Verified by: `repos: set merge_method`, `repos: merge_method refuses an unknown value`, `repos: merge_method auto takes the first allowed method`, `repos: merge_method auto takes rebase only when nothing else is allowed`, `repos: merge_method auto falls back to squash`, `repos: merge_method rebase is refused when squash or merge is allowed`, `repos: merge_method rebase is refused when the settings can't be read`, `cli: repo list shows a merge method other than squash`, `repos: merge_method is refused on a GitLab repo`

### LOOP-154 · Every merge uses the repo's method

Each merge Towercab or the owner's page makes uses the repo's merge method instead of a fixed squash.

- The `Forge` merge call (`mergePr`, src/forge.ts) takes the method from LOOP-153 (`auto` resolved first) as its `method` option and `GitHubForge` maps it to `--squash`, `--merge` or `--rebase`. This covers the pipeline's merge (PIP-22), the spec and plan merges (PIP-50, PIP-51), release PRs (SHIP), the owner's `approve` (LOOP-38) and the page's merge and accept buttons (UI-107, INT-53), with the head check unchanged. Wherever another spec says "squash-merge" or `--squash` for a GitHub repo, it now means the repo's method.
- With `squash` or `merge`, the commit title is the PR's Conventional Commit title (PIP-111), passed as the subject, so release tooling that reads history sees it. With `rebase` the host keeps each commit's own message and Towercab sets no title.
- When the host refuses the method (`Merge commits are not allowed on this repository`, `Squash merges are not allowed…`, `Rebase merges are not allowed…`), the mission records `merge failed: <method> merges are not allowed on <repo>: run towercab repo set <name> merge_method=<other>` instead of the host's text alone. It does not retry with another method.
- Verified by: `merge: uses the repo's method`, `merge: squash keeps the PR title as the commit title`, `merge: merge commit keeps the PR title as the subject`, `merge: rebase sets no title`, `merge: a refused method names the setting to change`, `merge: auto uses the method the repo allows`, `owner: approve merges with the repo's method`

### LOOP-155 · repo add and doctor warn about a method the repo forbids

`towercab repo add` and `towercab doctor` warn when the chosen merge method is not allowed on that repo.

- After the checks of LOOP-66, `repo add` reads the repo's allowed methods (LOOP-153). When the repo's method (`squash` for a new repo) is not allowed it prints `warning: <owner/name> does not allow <method> merges (allowed: <list>): run towercab repo set <name> merge_method=auto`, still adds the repo and exits 0. The line always names `auto` as the fix; `auto` is never refused.
- When the method in force (a set one, or what `auto` resolves to) is `rebase`, `repo add` and `doctor` print `warning: <name> merges by rebase: release notes rely on the repo's own commits following Conventional Commits`. It does not change the exit code.
- `doctor` prints the not-allowed line for each GitHub repo whose method is not allowed, and says which methods are allowed. `auto` is never warned unless no method is allowed at all. It is a warning: the exit code does not change.
- A repo whose settings cannot be read prints nothing for it, and `doctor --quick` (LOOP-35) skips the check; it never fails because of it.
- Verified by: `cli: repo add warns when squash is not allowed`, `cli: repo add is quiet when the method is allowed`, `cli: repo add names auto as the fix`, `cli: repo add warns about rebase`, `doctor: rebase warns about conventional commits`, `doctor: a method the repo forbids is a warning`, `doctor: unreadable merge settings are not a warning`, `doctor: auto with no allowed method is a warning`

### LOOP-156 · Close an intent as done because another one covered it

The owner can close an intent at any stage as done when another intent already covers it, and both intents' timelines say so.

- `towercab done <id> --by <other id>` (a `commands` row applied by the loop or by the CLI itself, LOOP-15) ends the mission `done` through `machine.apply` with the event `covered_by` at any stage, including `pick`, `design`, queued, a wait and a running build. The mission's `why` reads `covered by <other id>`. Plain `done <id> [note]` (LOOP-76) is unchanged and still only for a wait with the `done` exit. With `--by` a note is refused: `towercab: done --by takes no note`.
- Refused with a reason, changing nothing: `<id>` is unknown, already `done`, `dropped` or `stopped`; `<other id>` is unknown, is `<id>` itself, or is `dropped` or `stopped` (a dropped intent covers nothing); and, for an `a0` intent, the line of AUT-31. The other intent may be open, waiting or done. When the other intent itself waits on this one with `after:` (LOOP-75), the refusal says so: it would never start.
- Stops the work: a running child of the mission (agent session, checks, LOOP-114) is stopped without counting as a crash, queued work is removed, and an open spec, plan or code PR of the mission is closed with a comment naming the covering intent. Unlike `drop`, no branch is deleted, so `reopen` (LOOP-157) can bring the work back. Nothing is merged. The confirmation for an open code PR with commits (LOOP-76) applies with its text changed to "This closes PR #12 (3 commits). Its branch stays; `towercab reopen` brings it back. Nothing is merged." (`--yes`).
- Records what reopen needs, in the mission's `data` and the intent file's `covered_from: <stage>` (plus the wait key when it was waiting): the stage the intent was in, and the PRs it closed with their branch names.
- The intent file gets `stage: done`, `finished: <now>` and `covered_by: <other id>` (edited with `setField`, INT-24), and moves to `done/`; `DONE.md` lists it as done, with "covered by <other id>". The feature line of a covered intent stays (INT-75): it is marked `covered by <other id>` with a link to that intent, and `DONE.md` shows the same link. The request was delivered, only by another intent.
- Both timelines get an event: `covered by <other id>` on the closed intent and `covers <id>` on the other (also when that one is already done). The covering intent's own work is not touched. A repeat of the same `--by` pair is a no-op that prints the same result.
- Counts as done for `after:` (LOOP-75): an intent that waits `after:` the covered one starts. It does not count as cost-free: the spend so far stays on the intent (MET).
- Verified by: `cli: done --by closes an intent at any stage as done`, `cli: done --by refuses an unknown, finished or same intent`, `cli: done --by refuses a covering intent that waits on this one`, `cli: done --by takes no note`, `machine: covered_by ends any stage done and stops its work`, `loop: done --by stops a running child without a crash`, `loop: done --by closes the open PR with a comment naming the covering intent`, `loop: done --by keeps the branches and records the old stage`, `cli: done --by confirms an open code PR and says the branch stays`, `store: covered_by is written with setField and the file moves to done`, `timeline: both intents show the cover`, `pick: after accepts a covered intent`

### LOOP-157 · Reopen an intent closed as covered

`towercab reopen <id>` puts an intent that was closed as covered back where it was, so a wrong pick costs one command.

- Only for an intent closed by `done --by` (LOOP-156). Refused with a reason, changing nothing: `<id>` is unknown, `reopen: <id> was not closed as covered` for any other intent (open, done by the owner or by a merge, dropped, stopped), or `reopen: <id> was already reopened`. A `commands` row applied by the loop or the CLI itself (LOOP-15); for an `a0` intent the line of AUT-31 applies.
- The `reopen` event moves the mission from `done` back to the stage in `covered_from` (LOOP-156): a wait comes back as the same wait, any other stage is entered again (as `again`, LOOP-9) and queues like any intent, so the limits of LOOP-60 apply. It is one `machine.apply`, and the only way a `done` mission moves again.
- The intent file loses `stage: done`'s `finished`, `covered_by` and `covered_from` (`setField`/`removeField`, INT-24) and moves back out of `done/`; `DONE.md` no longer lists it. Its feature line goes back to the status it had before the cover (INT-75), without the "covered by" mark.
- Each PR LOOP-156 closed is reopened when it is still closed (not merged) and its branch still exists with the head it had; a reopened PR gets a comment saying why. A PR that cannot be reopened (branch gone, PR merged, the host refuses) is named in the output and in the timeline (`<n> PRs reopened, #12 could not be: branch deleted`), and the mission then re-enters the stage that makes a new PR when it needs one. A stage that has no PR needs none.
- Both timelines get `reopened (was covered by <other id>)` on this intent and `no longer covers <id>` on the other. The covering intent's work is not touched. An `after:` intent that already started because of the cover keeps running.
- Verified by: `cli: reopen puts a covered intent back at its old stage`, `cli: reopen refuses an intent that was not covered`, `machine: reopen moves a covered done mission to its old stage and wait`, `loop: reopen reopens closed PRs whose branches still exist`, `loop: reopen names a PR it could not reopen`, `store: reopen removes covered_by and the file leaves done`, `features: reopen restores the feature line`, `timeline: reopen shows on both intents`

### LOOP-158 · A covering intent that ends unfinished is flagged

When the intent that covered another is dropped or stopped, the owner is told once and can reopen the covered intent in one click, and nothing is reopened for them.

- Trigger: a mission enters `dropped` or `stopped` (LOOP-6 entry effects) for an intent that others were closed as covered by (`covered_by`, LOOP-156). A `stopped` that is only a replaced attempt (`replaced by attempt <n>`, LOOP-9 `fresh`) does not trigger it. For each covered intent still `done`, the covered intent stays done: no event moves it.
- One outbox row per covering intent (key: the covering intent and its end), in the move's transaction like LOOP-14: `<covering title> was <dropped|stopped>, so <n> intent(s) it covered are not delivered: <titles>`, with the page link, and one button `Reopen` per covered intent (`towercab reopen <id>`, LOOP-157), through the same confirm-free path as the CLI. It is sent once; a second end of the same covering intent (after a reopen and drop) sends a new one.
- The Inbox (UI-259) gets one item of kind `not delivered` per covered intent, with the text above and a `Reopen` button (UI-280's action) and `Dismiss`. It stays until the owner reopens, dismisses, or the covering intent is reopened and ends done. It counts as an Inbox item but no wait: no mission is blocked and `status` (LOOP-13) lists it under Notices.
- The covered intent's timeline gets `covering intent <other id> was <dropped|stopped>` and its feature line is marked not delivered (INT-75). Nothing is reopened, dropped or started by this: the owner may have dropped the covering intent because the request is no longer wanted.
- Verified by: `loop: a dropped covering intent flags the covered one once`, `loop: a replaced attempt of the covering intent flags nothing`, `loop: the covered intent stays done when its covering intent is dropped`, `outbox: the not delivered message has a reopen button per covered intent`, `status: not delivered intents are listed as notices`, `timeline: the covered intent shows its covering intent ended`

### LOOP-159 · One merge queue per repo

Changes that are ready to land in the same repo wait in a line and land one at a time, first come first served, so parallel builds never merge over each other.

- A mission joins its repo's queue when it enters `merge`: `apply` stamps `data.queuedAt` (the move's time) if it has none. The queue (`src/queue.ts`, `queueOf`) is every unfinished mission of the repo at `merge` or holding `data.landing`, ordered: the one holding `landing` first, then by `queuedAt`, then priority, then id.
- Only the head (`headOf`) steps at `merge`. When it first steps, the loop stamps `data.landing = { since }` on it; a mission at `merge` that is not the head does not step.
- `status` prints `queued to merge: <id> (#<n> of <m>)` for each mission behind the head, under its repo's slot lines (LOOP-112); the overview shows such a mission as queued, `queued to merge` (UI view model).
- No new column: `queuedAt` and `landing` live in the mission's `data`.
- Verified by: `queue: missions land first in first out`, `queue: the landing mission stays head`, `queue: entering merge stamps the time`, `loop: three missions on one repo land in order`, `status: a mission behind the merge queue head shows its place`

### LOOP-160 · Conflicts are repaired only at the head of the queue

Only the change whose turn it is to land repairs a clash with the base branch; the others wait, so one fix never breaks another.

- `prEvents` (LOOP-18) raises no `conflict` for a mission that `conflictHeld` says waits: at `merge` but not the head, or at `approval:merge` while another mission of the repo holds `landing`. Missions earlier in the pipeline (`ci`, `review`, `gate`) still get the conflict round of PIP-134.
- The head turns `DIRTY` into a conflict round (PIP-134) from its merge step. It keeps `landing` through `build` → `verify` → … → `merge`, so it stays head while it repairs, and the re-checks run as usual.
- Verified by: `queue: a conflict waits unless the mission is head`, `events: a held conflict raises nothing`, `loop: three missions on one repo land in order`

### LOOP-161 · The head yields when it waits on the owner

When the change at the head of the queue needs the owner or stops, the next one in line takes its turn.

- A move into a wait stage, a wait at a working stage, or a finished stage clears `queuedAt` and `landing` (`apply`). The next mission in the queue becomes head. A mission that comes back from the owner rejoins at the back, with a new `queuedAt`.
- Verified by: `queue: a wait leaves the queue`

### LOOP-162 · Missions queued to merge hold no build slot

A change waiting its turn to land does no work, so it leaves its build slot to the next change.

- Extends LOOP-110: a mission at `merge` without `landing` is idle (`isIdle`). The head, once landing, counts as working until it merges or waits.
- Verified by: `slots: a mission queued to merge is idle`

### LOOP-70 · A repo set to block starts no new intent

Towercab holds back new intents only in a repo whose kind the owner confirmed, that is missing required setup and that is set to `readiness: block`; every other repo keeps starting intents and only warns.

- `decide` skips an intent whose repo's stored readiness ([REPO-24](repo.md)) `blocks`, with `waiting:
  repo not ready: <n> missing (<items>)`, except a setup intent (LOOP-71). Checked after the unknown-repo
  rule and before the `ahead` limit (LOOP-60). An unconfirmed kind, the default `readiness: warn`, an
  `unknown` item, a waived item or a repo not checked yet never skips anything.
- `start` (LOOP-63) is refused with `start: <repo> is not ready: <items>` when the repo blocks, unless
  the intent is a setup intent.
- A mission that already exists keeps going through every stage, including when a later check finds the
  repo blocking; only the pick is held. When the check next finds the repo ready, or the owner waives the
  item or sets `warn`, the waiting intents are picked on that pass.
- Verified by: `loop: a blocking repo starts no new intent`, `loop: an unconfirmed or warn repo keeps starting intents`, `loop: running intents finish in a blocking repo`, `loop: start is refused in a blocking repo`, `loop: a repo that becomes ready is picked on the same pass`

### LOOP-71 · The setup intent

The one kind of work allowed in a blocking repo is the intent that sets it up, and Towercab proposes that intent itself.

- An intent is a setup intent when its front matter has `setup: true` (an unknown key, kept verbatim,
  INT-2). It is picked in a blocking repo as in a ready one, in the picker's order (PRI-5), so a repo
  never blocks itself out of the intent that fixes it.
- At most one setup intent per repo runs at a time; a second waits with `waiting: <id> is already setting
  up <repo>`. A setup intent in a repo that does not block is an ordinary intent.
- Proposing: when a repo's readiness has a `missing` item (blocking or not) and no open setup intent
  exists for it, Towercab opens one pull request in the intents repo with a new intent file for it
  (`repo`, `setup: true`, `source: towercab`, a title and a `## Problem` listing the missing items in the
  words of REPO-24), as other proposed intents arrive. The owner accepts it by merging (INT-4). Open
  means: an intent of that repo with `setup: true` that is on `main` and not done or dropped, or has a
  pull request still open; the standards review may open one first, and then Towercab opens none.
- Never a second one while one is open. Open also counts a setup PR from anywhere: the proposed pull
  requests of LOOP-92 whose intent is a setup intent for the repo (the standards review's, the owner's);
  while that list is unknown nothing is proposed. The PR body starts with the mark
  `<!-- towercab:setup repo=<repo> -->`, and the branch is `setup/<repo>`, so a crash cannot open two.
- A closed proposal is a no: a proposal is tried only when the set of missing items differs from the set
  last tried (the items, never the stored time), and at most once a day per repo. Nothing missing forgets
  the set, so a later gap is new.
- The readiness check (REPO-24) runs as a background job beside the pass, one repo at a time, like the
  feature backfill of INT-39. Its fetch of the repo's clone (and of the `ci` and `infra` clones it reads,
  each at most every 10 minutes) holds the loop's clone lock, which every mission step also holds, so two
  fetches of one clone never overlap; the reads, the stored result and the proposal that follow only read.
  One 60 s limit, counted from when the lock is taken, covers the fetch and every read: each child process
  gets only the time left and is killed with it, and at the limit no further call starts. A pass never
  waits for the job, a repo whose first check failed waits 10 minutes before the next try, and a drain
  waits for a running job to end (LOOP-108).
- Verified by: `loop: a setup intent is picked in a blocking repo`, `loop: only one setup intent per repo at a time`, `loop: a missing item proposes one setup intent`, `loop: no second setup intent while one is open`, `loop: an existing setup intent from the standards review stops the proposal`, `readiness: a closed proposal is not proposed again until the missing items change`, `readiness: at most one proposal per repo per day`, `readiness: a setup PR from the proposed list counts as open`, `readiness: nothing is proposed while the proposed intents are unknown`, `readiness: the check has one deadline for the fetch and the reads`, `readiness: a hung read ends at the limit and the pass does not wait for it`, `readiness: the clone is fetched under the clone lock, never beside a mission step`, `readiness: the clone lock runs calls one at a time, in order`, `readiness: a hung fetch ends at the limit in the background, then waits ten minutes`

### LOOP-72 · Readiness in the commands

`status`, `next`, `repo list` and `doctor` say when a repo is not ready, and whether that holds work back.

- `status` and `next` show the wait of LOOP-70 in plain words. `repo list` (LOOP-67) ends a line with `·
  not ready (<n> missing, blocking)` or `· not ready (<n> missing, warning)`; `doctor` names each repo
  with a missing or unknown item and the items, one line per item, with the waived ones and their reasons.
- Verified by: `status: a not-ready repo is shown`, `cli: repo list shows not ready`, `doctor: not-ready repos are named`
### LOOP-92 · Reading the proposed intents

The loop looks at the open pull requests on the intents repo every minute, so a proposed intent is seen within a minute of being opened.

- Like the PR reads of LOOP-18, once per minute of the loop's clock (also on start): one
  `gh pr list --state open` on the intents repo as the App, with drafts, and the files of each PR. The result is
  kept in memory for the UI (UI-184) and the messages (LOOP-93); nothing is written to the intents repo.
- A GitHub failure is a `github` fault (LOOP-10): the last good list stays, the read is retried on the
  next pass, and the UI says the list may be out of date (UI-188). Reading never moves a mission.
- Verified by: `proposed: the intents PRs are read every minute`, `proposed: a gh failure is a github fault and keeps the last list`

### LOOP-93 · One message per proposed intent

Towercab sends one Telegram message when a proposed intent first appears, and never another for the same pull request.

- Each new proposed intent (INT-51, drafts too) writes one outbox row with the key `proposed:<PR number>`
  in the transaction that first sees it, so the primary key makes it once. Text: `Proposed intent: <title>
  (<repo>), priority <n>` (`would be parked` instead of the priority when below the cutoff), then the link
  to its card in the UI (UI-184). GitHub-only PRs get the message too, linking the PR.
- A PR closed or merged before the row is sent drops the row (LOOP-14). A PR that changes after the
  message, or leaves draft, sends nothing more.
- The first read after this feature is first run marks every proposed PR already open as seen, with no
  message: it records them in `meta` (`proposed:seeded`, and `proposed:seen:<PR number>`) in one
  transaction. Only a PR that appears in a later read sends one. A restart repeats nothing, because
  the seen PRs are kept in `meta` and the outbox.
- Extends LOOP-14: a proposed intent is something the owner has to decide.
- Verified by: `proposed: a new proposal sends one message`, `proposed: the same PR never sends twice`, `proposed: a proposal closed before sending is dropped`, `proposed: proposals already open on the first read send nothing`

### LOOP-73 · Stages for the owner's steps and the unverified end

The state machine gets a stage where a merged change waits for the owner's steps, and an end for changes
that can't be checked live.

- The order becomes `… gate → merge → steps → deploy → e2e → done`. `steps` ([SHIP-19](ship.md)) is phase
  `code`. `unverified` ([SHIP-21](ship.md)) is a final stage outside the order, phase `done`, that ignores
  every event, like `done` and `stopped`.
- `code_merged` → `steps` when an `after` step is unticked, else `deploy`; at `steps`: `ok` → `deploy`.
  At `deploy`: `skip` → `unverified` (was `done`), or `done` when the plan says there is nothing to check live (SHIP-21). The before-merge hold (SHIP-18) is a `blocked` wait
  from the gate that keeps the phase, so it adds no stage.
- Verified by: `machine: every stage and event pair is defined`, `machine: order`, `machine: steps and unverified transitions`

### LOOP-74 · Waits for the owner's steps

Two new waits tell the owner which steps are open.

- `your steps first` (blocked, from the gate): "Do these before this change merges: tick them off in
  Towercab, or reply to change the plan." `your steps` (stage `steps`): "Do these so the change works
  live: tick them off in Towercab." Both add their rows to **Waits** and carry the checklist in their
  why ([PIP-110](pipeline.md)).
- Ticks continue the wait (SHIP-22); a reply, `/retry` and closing the PR act as for any blocked wait.
  `steps` is not a blocked wait: a reply there is added to the intent page and does not move it.
- Verified by: `loop: waits for owner steps ask for the checklist`, `loop: a reply at your steps does not move it`

### LOOP-75 · `after:` waits for done

An intent that names another with `after:` starts only when that one is done or ended unverified.

- Done means the stage `done` ([LOOP-73](loop.md)): a merged change whose steps are not ticked or whose
  deploy and e2e run haven't passed doesn't count. An intent that ended `unverified` counts, because
  it can never be checked (SHIP-21). A rolled-back, dropped or still running intent doesn't count;
  `bad after:` ([LOOP-5](loop.md)) is unchanged.
- The unmet `after` shows as waiting on the other intent, with its stage ("waiting for 261031-1714-1:
  your steps").
- Verified by: `pick: after waits for steps and live checks`, `pick: after accepts an unverified end`

### LOOP-76 · Every wait has a way out

Whatever Towercab waits on the owner for, the owner can end or move the intent from Towercab itself.

- Each wait in **Waits** has a set of exits, from this list: `continue` (a reply, `towercab answer`, or
  an option, LOOP-38, PIP-114), `retry` (start over), `steps` (switch the delivery to steps, PIP-113),
  `drop` (PRI-9), `done` (the owner did it: the mission ends `done`, event `owner_done`; only for the
  waits below), ticking steps (SHIP-22) and the PR gestures of the approval waits. Every wait has at
  least one exit that ends the intent or moves it to another stage; `continue` alone does not count when
  the wait comes straight back (LOOP-77).
- `no changes` gets the exit `done`, named "Nothing to build: I did it myself". It ends the intent as
  done, with the mission's `why` saying the owner did it. The ask in **Waits** says so. `done` is a
  command like `drop` (`towercab done <id> [note]`, a `commands` row, applied by the loop or by the CLI
  itself, LOOP-15) and the page's button (UI-164). The owner's one-line note (what they did) becomes a
  step in the plan's `## Your steps` that is already ticked, with the time (SHIP-17, SHIP-22), so the
  plan records the work; without a note the step reads "Done by the owner". `your steps` (LOOP-74) ends by ticking the last step
  (SHIP-22), or with `done`, `retry` or `drop`. `your steps first` offers `done` too, as both steps waits
  do: the owner may have done the steps and the change itself, and the open code PR is closed as for any
  `done` with the confirmation below.
- An exit that would close an open code PR that has commits (`done`, `steps` and `drop`) asks for one
  confirmation first, naming the PR and its commit count ("This closes PR #12 (3 commits) and deletes its
  branch. Nothing is merged."). This includes `no changes` after a repair round, where the PR still
  holds the repair commits. The page asks it in a confirm (UI-164); the CLI prints it and needs `--yes`
  (`towercab done <id> --yes`) or refuses with the same text; the Telegram message answers the exit with
  the warning and the buttons "Close PR with N commits? Yes / Cancel" (the confirm of TG-4
  for drop and merge), and only Yes applies the exit; an API call without the confirmation is refused
  with the warning. A mission with no open code PR, or a PR with no commits beyond its base, needs none.
- The PR and commit count come from the forge when the confirmation is asked. When they cannot be read
  (a GitHub outage), the exit is not blocked: the warning is general ("Couldn't check the PR; it may
  have commits. It will be closed and its branch deleted.") and the same explicit confirm follows.
  `done` at `your steps first` is offered behind this warning.
- The ask, the Telegram message (LOOP-14) and `towercab status` (LOOP-13) name the exits of the wait in
  plain words.
- A test walks every row of **Waits**, including the ones LOOP-74 adds, applies every exit from each
  wait through `machine.apply`, and fails when a wait has no exit that leaves it for `done`, `stopped`
  or another stage, or when a wait in the code is missing from the table.
- Verified by: `machine: every wait has an exit that ends or moves the intent`, `machine: no changes can end as done`, `cli: done ends an intent the owner did`, `cli: done turns the note into a ticked step`, `outbox: the message names the exits`, `status: waits list their exits`, `machine: every wait has an exit besides a reply that ends or moves the intent`, `db: the commands rebuild keeps existing rows and accepts done and steps`, `cli: done at no changes after a repair round asks to confirm the open PR`, `cli: steps and drop confirm an open PR with commits`, `cli: done without a PR needs no confirmation`, `cli: an unreadable PR gets a general warning and a confirm`, `telegram: an exit that closes an open PR asks Yes or Cancel`, `machine: done is offered at your steps first`

### LOOP-77 · The same wait again is stuck

A mission that lands on the same wait again with nothing new is marked stuck and offered only the exits that can still help.

- On entering a blocked wait, Towercab compares it with the wait the mission was in last (the wait key,
  the head commit and the count of owner answers). Equal → the mission is `stuck`: the flag is kept in
  the mission's `data`, shown as "Stuck: this came back with nothing new" with the reason, and cleared on
  any move out of the wait to a different one or when something new arrives (a changed head, an owner
  answer that was not yet used).
- A stuck wait offers only the exits that change something: `steps`, `done`, `retry` and `drop`, each
  only if that wait has it in its exits (LOOP-76). `continue` and the reply box are left out of the page,
  the Telegram message and `status`, and a bare `answer` for a stuck mission is refused with `<id> is
  stuck at <wait>: a reply would land here again; use <exits>`, where `<exits>` lists exactly the
  offered ones in plain words, joined with commas and "or" (`retry or drop` at a wait that has only those).
- Nothing about the mission's state changes: stuck is a display and an offer, and `machine.apply` still
  moves it only on events.
- Verified by: `machine: the same wait again with nothing new is stuck`, `machine: something new clears stuck`, `cli: answer on a stuck mission is refused`, `outbox: a stuck wait offers only the other exits`, `machine: an answer without words still counts as new`, `cli: the stuck refusal lists only the exits the wait offers`

### LOOP-78 · A part per repo, built in parallel

The code phase of a multi-repo intent builds one pull request per repo, side by side, each checked on its own.

- Still one mission (LOOP-3) moved only by `machine.apply`. The mission's `data.parts` holds one part
  per repo of the plan (INT-43): repo, stage, PR, head, and what it waits on. A part runs `build →
  verify → proof → publish → ci → review → gate` like a single-repo mission; events carry the repo, and
  one part's wait or failure does not stop the others. The mission leaves the parallel stages when every
  part has passed `gate`.
- Each part takes its repo's slots: it counts as one build in that repo's `workers` and one of the
  `ahead` (LOOP-4, LOOP-60, LOOP-61) and takes a slot for each run. Parts of one intent in different
  repos run at the same time within `[agent].parallel`.
- A part that needs the owner (a question, access, a failed check) waits as a blocked wait of that part
  (LOOP-74); the mission shows the waits of all parts, and each exit acts on the part named. Dropping
  the intent closes every part's PR.
- One spending cap covers the whole intent: `[agent].max_budget_usd` (LOOP-1 config) is the total for
  all parts, not per part, and the parts draw on it as they run. The mission's spend is the sum of all
  parts' runs (MET). When the total reaches the cap, every part stops at its next step, no new run
  starts for any part, and the mission enters the blocked wait `worker budget` for the whole intent,
  asked like a single-repo intent's (**Waits**): the owner replies to let all parts carry on, or starts
  over, or drops. A run already going when the cap is reached finishes its step.
- Verified by: `loop: the cap is one total for all parts`, `loop: reaching the cap stops every part and asks once`, `loop: parts build in parallel, one PR per repo`, `loop: one part waiting does not stop the others`, `loop: parts count in the workers of their repos`, `machine: the mission leaves the parts when all are at the gate`, `loop: dropping a multi-repo intent closes every part's PR`

### LOOP-79 · All the repos freeze together

When every part is ready, Towercab freezes merges in all the intent's repos at once, or in none.

- Freeze = a row per repo holding the mission, kept in the database (LOOP-37) so it survives a restart.
  The freeze is taken for all repos in one `Db.tx`; if any of them is frozen by another mission, none is
  taken and the mission waits at the gate for it ("waiting for the freeze of <repo>"). Only one freeze
  covers a repo, so two multi-repo intents never hold each other's repos.
- While a repo is frozen, other intents there keep working up to the gate; their `merge` stage waits and
  starts when the freeze lifts. Reads, pushes and CI are not stopped.
- Merges the owner makes outside Towercab: warn only. Towercab tells the owner, once when a freeze
  starts and once when it lifts, in the Telegram message (LOOP-14), `towercab status` (LOOP-13) and the
  Board (UI-166), which repos are frozen and why. It writes nothing to GitHub for the freeze: no commit
  status, no required check, no change to branch protection, so it needs no permission beyond those it
  has. A merge the owner makes by hand on GitHub is not stopped; Towercab's own merge buttons for a
  frozen repo ask for a confirmation first.
- Verified by: `loop: all the repos freeze in one step or none`, `loop: a held freeze makes the mission wait at the gate`, `loop: other intents work up to the merge while frozen`, `loop: the owner is told when a freeze starts and lifts`, `loop: a freeze writes nothing to GitHub`, `loop: a freeze survives a restart`

### LOOP-80 · Merge in the plan's order, then check live

The frozen parts merge one after the other in the plan's order, and the freeze lifts only when the whole feature is applied and checked live.

- The merge order is the plan's (INT-43). A part is merged when the one it waits on has merged. A part
  whose merge fails (a conflict, a changed head, a red check) stops the sequence at that part and asks
  the owner as `merge` does for a single PR; nothing after it is merged.
- After the last merge, each part ships (SHIP-6) in the same order: deploy, then e2e of its repo (SHIP-9).
  A repo without a live block (SHIP-15) ships nothing and counts as ok. The mission is `done` only when
  every part is ok and the steps of the plan are ticked (SHIP-20); a part that ends `unverified`
  (SHIP-21) makes the mission end that way.
- The freeze lifts when the mission is `done`, `unverified` (LOOP-81), rolled back (LOOP-82) or dropped; held merges of other intents then continue in their
  priority order.
- Verified by: `loop: parts merge in the plan's order`, `loop: a failed merge stops the ones after it`, `loop: a part without a live block counts as ok`, `loop: the freeze lifts when every part is checked live`, `loop: held merges continue after the freeze`

### LOOP-81 · A freeze has a time limit

If a freeze lasts longer than the limit, Towercab asks the owner whether to keep waiting or to lift it.

- `[agent].freeze_wait`: minutes, 1–1440, default 120, counted from when the freeze was taken. Past it
  the mission enters the blocked wait `freeze` with the repos, what each part is doing and for how long.
  Exits (LOOP-76): `continue` = keep waiting, for another `freeze_wait` and then ask again; `unfreeze`;
  `drop`.
- `unfreeze` lifts the freeze, and Towercab never freezes again on its own. If no part is merged yet,
  the parts stay at the gate and the mission enters the blocked wait `freeze lifted` ("Merges are
  unfrozen; freeze again when you are ready"). Its exits (LOOP-76): `continue` ("Freeze again"), which
  takes the freeze as LOOP-79 says, and `drop`. Other intents' merges continue meanwhile. If some part is already merged, the mission ends `unverified`
  ("merged, not verified live", SHIP-21) and nothing is rolled back. Its card lists each part as merged
  or not merged, and offers `retry`: it takes the freeze again and lands only the parts not yet merged,
  in the plan's order, then ships and checks all parts live (LOOP-80). A retried part whose PR changed
  since is rebuilt first.
- `unfreeze` is a command like `drop` (`towercab unfreeze <id>`, LOOP-15) and a button (UI-167).
- Time comes from the injected clock (`Clock`); the wait is listed in **Waits** with its exits and is
  covered by LOOP-76's walk.
- Verified by: `loop: a freeze past the limit asks the owner`, `loop: continue keeps waiting another period`, `loop: unfreeze before any merge waits for the owner's go-ahead`, `loop: a lifted freeze is never taken again on its own`, `loop: freeze again takes the freeze`, `loop: unfreeze after a merge ends unverified and rolls nothing back`, `loop: the unverified card lists merged and unmerged parts`, `loop: retry lands only the unmerged parts`, `cli: unfreeze lifts the freeze`

### LOOP-82 · A red part rolls back itself and the parts after it

If a part fails after the merges, that part and every part that landed after it are rolled back; the parts that landed before it stay.

- A `red` at `deploy` or `e2e` of a part (SHIP-6) sends that part and every part after it in the landing
  order (INT-43) to `rollback`, last landed first, each by its own rollback (SHIP-10, SHIP-12). Parts
  before it stay merged and live: the plan orders parts so that each works without the later ones
  (INT-43). Parts not yet merged are not merged; their PRs stay open. A rollback that fails freezes that
  repo as SHIP-13 says, and the other repos stay frozen until the owner decides.
- The freeze stays during the rollback and lifts when every rolled-back part is back (LOOP-80). The
  mission then goes back to `build` for the rolled-back parts only, as SHIP-10 says for one repo; their
  new PRs are checked and landed together again with the parts that stayed counted as merged.
- Verified by: `loop: a red part rolls itself and the later parts back, last first`, `loop: parts before the red one stay merged`, `loop: unmerged parts are not merged after a red part`, `loop: the freeze holds during the rollback`, `loop: a failed rollback keeps the other repos frozen`, `loop: only the rolled-back parts are built again`

**Config** (`src/config.ts`)

| Key | Type, range | Default |
|---|---|---|
| `intents.remote`, `intents.path` | URL; path (`~/` expanded) | required; `<home>/intents` |
| `intents.cutoff` | int 1–15 | 7 |
| `intents.issue_a` | int 1–5 | 3 |
| `intents.owner_waits` | int 1–16 (LOOP-132) | 4 |
| `agent.model`, `agent.review_model` | model name | `opus`; one step above the worker's |
| `agent.parallel` | int 1–16 | computed from cores and free memory, at most 4 (LOOP-103) |
| `agent.build_timeout`, `review_timeout`, `check_timeout` | minutes 1–1440 | 60, 15, 10 |
| `agent.max_budget_usd`, `agent.daily_budget_usd` | number > 0 | 10; none |
| `agent.monthly_budget_usd`, `budget.<repo>.daily_usd`, `budget.<repo>.monthly_usd` | number > 0, at most 2 decimals | none |
| `agent.ci_poll`, `ci_grace`, `ci_wait` | seconds | 30, 120, 1800 |
| `agent.freeze_wait` | minutes 1–1440 (LOOP-81) | 120 |
| `agent.path`, `agent.toolchain`, `agent.env`, `agent.network`, `agent.sandbox_unix_sockets` | ignored since PIP-157 and AUT-26: they load, nothing reads them, and `towercab doctor` names each one that is set | none |
| `repos.<r>.github`, `path`, `base`, `workers`, `env` | `owner/name`; path; branch; int 1–16; table | required; `<home>/repos/<r>`; `main`; 1; `{}` |
| `repos.<r>.ahead` | int 1–16 | 3 |
| `github.app_id`, `github.me`, `github.api_base` | int; login; URL | required; required; `https://api.github.com` |
| `telegram.bot_token`, `telegram.chat_id`, `telegram.api_base` | strings; URL | none (no Telegram); `https://api.telegram.org` |
| `telegram.ui_url` | URL (TG-14) | none (messages link to the PR) |
| `observer.enabled` | bool (OBV-2) | true |
| `observer.daily_at` | local time `HH:MM` (OBV-2) | `06:00` |
| `observer.max_proposals_per_week` | int 1–10 (OBV-7) | 3 |
| `observer.daily_budget_usd`, `observer.max_budget_usd` | number > 0 (OBV-10) | 3; 1.5 |
| `observer.bundle_kb`, `observer.model` | int 10–4000 (OBV-3); model name | 400; `[agent].model` |
| `ui.port` | int 0–65535 (0 = off) | 7311 |
| `update.auto` | bool | true |
| `update.channel` | `"main"` or `"release"` (LOOP-150) | `"main"` |

`workers` and `ahead` are the repo's own `TOWERCAB.md` keys too (REPO-14): the file wins, and after the repo has moved the database value is no longer read (REPO-15).

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
CREATE UNIQUE INDEX missions_one_per_intent ON missions(intent) WHERE stage NOT IN ('done','stopped','unverified');
CREATE TABLE transitions (id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  at REAL NOT NULL, from_stage TEXT NOT NULL, event TEXT NOT NULL, to_stage TEXT NOT NULL, why TEXT);
CREATE TABLE commands (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('answer','retry','drop','pause','resume','start','done','steps','score','boost')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created REAL NOT NULL, applied_at REAL, result TEXT);
CREATE TABLE outbox (key TEXT PRIMARY KEY, mission INTEGER, text TEXT NOT NULL, created REAL NOT NULL,
  sent_at REAL, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'info', intent TEXT, wait TEXT, tg_message_id INTEGER, target TEXT, buttons TEXT,
  ended_at REAL);
CREATE TABLE repos (name TEXT PRIMARY KEY, github TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL, workers INTEGER NOT NULL DEFAULT 1, ahead INTEGER NOT NULL DEFAULT 3,
  env TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL, added REAL NOT NULL,
  teammate_review INTEGER NOT NULL DEFAULT 0, reviewers TEXT NOT NULL DEFAULT '');
CREATE TABLE shadow_turns (id INTEGER PRIMARY KEY, update_id INTEGER UNIQUE, at REAL NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'done', cost REAL NOT NULL DEFAULT 0,
  folded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE shadow_actions (id INTEGER PRIMARY KEY, at REAL NOT NULL, turn INTEGER, idx INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL, intent TEXT NOT NULL DEFAULT '', pr INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', UNIQUE (turn, idx));
CREATE TABLE telegram_updates (update_id INTEGER PRIMARY KEY, at REAL NOT NULL, data TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new');
CREATE TABLE tg_cards (mission INTEGER PRIMARY KEY, intent TEXT NOT NULL, message_id INTEGER,
  text TEXT NOT NULL DEFAULT '', buttons TEXT, ping_id INTEGER, ping_wait TEXT,
  final INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0);
CREATE TABLE observer_runs (id INTEGER PRIMARY KEY, trigger TEXT NOT NULL, started REAL NOT NULL,
  ended REAL, cost REAL NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT 'running',
  findings INTEGER NOT NULL DEFAULT 0, proposals INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0,
  dropped TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '{}');
CREATE TABLE observer_proposals (pr INTEGER PRIMARY KEY, intent TEXT NOT NULL, run INTEGER NOT NULL, at REAL NOT NULL,
  title TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]');
```

**Transitions** (`next(stage, event)`; "next" = the next stage of the order; `U` = unexpected, counted
like a crash; `–` = ignored)

| Event | Working stages | approval:spec | approval:plan | approval:merge | blocked |
|---|---|---|---|---|---|
| ok | next (e2e → done; rollback → build; `steps` with steps delivery → done; revert U) | U | U | U | U |
| red | verify, proof, ci, review → build; deploy, e2e → rollback; else U | U | U | U | U |
| skip | deploy → done; else U | U | U | U | U |
| revert | rollback → revert; else U | U | U | U | U |
| timeout, bad_result, interrupted | again | – | – | – | – |
| limit | cool | U | U | U | U |
| wait (a handler's) | to the wait's stage | same | same | same | same |
| env_fail | backoff | backoff | backoff | backoff | backoff |
| crash | recover | – | – | – | – |
| spec_merged | design → plan; else – | → plan | – | – | from design → plan |
| plan_merged | plan → build (steps delivery: `steps`); else – | – | → build (steps delivery: `steps`) | – | from plan → build (steps delivery: `steps`) |
| code_merged | build … merge → deploy; else – | – | – | → deploy | → deploy, unless it came from deploy … revert |
| closed | → stopped | → stopped | → stopped | → stopped | → stopped |
| feedback | build … merge → build; else – | → design | → plan | → build | as answered |
| answered | – | – | – | – | continue |
| conflict | ci … merge → build; else – | – | – | → build | → build |
| head_moved | review … merge → ci; else – | – | – | → ci | – |
| intent_removed | → stopped | → stopped | → stopped | → stopped | → stopped |
| retry_fresh | fresh | fresh | fresh | fresh | fresh |
| recheck ([AUT-21](autonomy.md)) | – | → design | → plan | → review | – |
| reviewed (PIP-142, PIP-143) | – | → design | – | → gate | – |
| resume | merge (held) → again; else – | – | – | – | – |
| owner_done (LOOP-76) | `steps` → done; else – | – | – | – | → done, only at a wait with the `done` exit (`no changes`, `your steps first`, `several repos`) |
| covered_by (LOOP-156) | → done | → done | → done | → done | → done |
| reopen (LOOP-157) | – | – | – | – | – (only a mission `done` by `covered_by` moves: → its `covered_from` stage) |
| to_steps (PIP-113) | –; `steps` – | – | – | – | → `steps` with steps in the plan, else → plan; only at a wait with the `steps` exit |

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
| `teammate review` | approval:merge | Your teammates need to approve this change before it can merge: nothing to do until they have, or comment what to fix. |
| `teammate review of spec` | approval:spec | Your teammates need to approve this spec before it can merge: nothing to do until they have, or comment what to change. |
| `answer the question` | blocked | Answer a question so the work can go on: pick an option or write your own. |
| `checks red` | blocked | The tests can't pass without your help. Reply with what to change, or start over. |
| `allow check writes` | blocked | Decide if the tests may write to this machine's shared build cache: reply allow or no. |
| `fix sandbox` | blocked | Towercab's sandbox can't start, so no Claude run does: fix what the message says (for the AppArmor profile, run the command shown), then retry. |
| `tests don't prove the change` | blocked | No test shows the change works. Reply with what a test should check, or say go on to continue without one. |
| `CI red` | blocked | GitHub's checks still fail after two fix attempts. Reply with a hint on what to change, or start over. |
| `CI stuck` | blocked | GitHub's checks didn't finish in time. Make sure they run, then reply so Towercab looks again. |
| `worker timeout` | blocked | The agent ran out of time before finishing. Reply to let it carry on, or start over. |
| `worker budget` | blocked | The agent used up its budget before finishing. Reply to let it carry on, or start over. |
| `no result` | blocked | The agent stopped without a usable answer. Reply to let it carry on, or start over. |
| `no changes` | blocked | The agent finished without changing anything. Reply with what it should do, say you did it yourself, or drop the intent if nothing is needed. |
| `crashed at <stage>` | blocked | Towercab failed three times at the same step. Reply to try again once the cause is fixed, or start over. |
| `spec conflict` | blocked | The spec clashes with other changes and Towercab couldn't combine them. Resolve it in the spec PR, then reply. |
| `merge failed` | blocked | GitHub refused to merge the change. Fix what GitHub objects to, then reply to try again. |
| `add CLAUDE.md verifying block` | blocked | Towercab couldn't find checks that pass on this repo. Add a verifying section to its CLAUDE.md, then reply. |
| `setting up checks` | blocked | Towercab is adding checks to this repo in a pull request, and this goes on by itself once it is merged. Nothing to do unless you want to start over. |
| `fix repo files` | blocked | One of the repo's files for Towercab can't be read. Fix it, then reply. |
| `unknown repo` | (intent only) | Tell Towercab which repo this is for: add the repo, or fix the repo name in the intent. |
| `bad after:` | (intent only) | Fix what this intent waits for: Towercab can't find one of the intents it names, or it was dropped. |
| `several repos` | blocked | This change spans several repos and Towercab can't build those yet, so nothing was built. Do the change yourself and say so, or drop the intent. |
| `dependency stalled` | blocked | An intent this one waits for was rolled back or dropped, or has not finished in 3 days. Take it out of `after:`, start over or drop this intent; it carries on by itself once the other one is done. |
| `bad repos:` | (intent only) | Fix which repos this intent changes: Towercab doesn't know one of the repos it names. Add the repo, or fix the intent's repos list. |
| `rolled back, revise` | blocked | The change broke the live app, two fixes didn't hold, and it was taken back out. Revise the intent, then start over (/retry). |
| `rollback failed` | blocked | Taking the broken change back out failed, so nothing more goes live in this repo until you fix it. |
| `your steps first` | blocked | Do these before this change merges: tick them off in Towercab, or reply to change the plan. |
| `your steps` | steps | Do these so the change works live: tick them off in Towercab. |

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
- Telegram commands (v1 had them; no one used them: the owner acts on GitHub or in the UI). Talking to the
  shadow in plain words is the exception (LOOP-129).

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
