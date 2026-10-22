# Loop

**Status:** Live: LOOP-1..10, LOOP-17, LOOP-18 · Draft (Rust rewrite): rest · **Prefix:** LOOP

## Purpose

Towercab as one Rust program that never stops: code owns the state machine, every wait,
poll and recovery; Claude Code (`claude -p`) runs only for steps that need judgment
([pipeline.md](pipeline.md)).

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| LOOP-1 | Binary `towercab` (Rust, `cargo install --path . --locked` → `~/.cargo/bin/towercab`). Home (`Home::resolve`: `--home` > `TOWERCAB_HOME` > `~/.local/share/towercab`; created 0700; **Home**): SQLite `towercab.db` (`db::open`: WAL, **Schema**: missions, transitions, cooldowns, outbox, commands, repo_caps, faults, drafts, meta), `towercab.lock`, checkouts `work/`, run files `runs/<id>/` (`build.txt`, `ci-<n>.log`, `verify-<n>.log`, `e2e-<n>.log`, …). Config `~/.config/towercab/config.toml` (`--config`, `TOWERCAB_CONFIG`; **Config**): `[intents]` remote, path, cutoff (7); `[agent]` model (`opus`), parallel (1), drafter (`sonnet`), build_timeout (60 min), review_timeout (15 min), check_timeout (10 min), max_budget_usd (5), ci_poll (30 s), ci_grace (120 s), ci_wait (1800 s), path (the loop's `PATH`), toolchain (`~/.cargo`, `~/.rustup`, `~/.local/bin`); `[repos.<name>]` github (`owner/name`), path (Towercab's own clone, LOOP-8), base, workers (1), bash (extra worker Bash patterns, [PIP-24](pipeline.md)); `[github]` app_id, me, api_base; `[telegram]` bot_token, chat_id, api_base; `[metrics]` endpoint, prometheus (`http://localhost:9090`, [MNT-1](maintain.md)); `[policies]` github (`owner/agent-instructions`), base (`main`). Unknown keys ignored (the Python version shares the file). A wrong type or range → exit 1 `config: <file>: <section>.<key> …` for every command; `run`, `step`, `up` and `doctor` also need `[github]` app_id and me and every `[repos]` table valid (`Config::check_loop`). The Python package leaves `main` at the pipeline intent's switch-over, not here. | test_config_loads, test_bad_config, test_home_layout, test_schema_matches_spec |
| LOOP-2 | **Service** (`src/service.rs`): `towercab up` refuses without `~/.cargo/bin/towercab` (`~/.cargo/bin/towercab is missing: cargo install --path . --locked`), writes `$XDG_CONFIG_HOME/systemd/user/towercab.service` (default `~/.config/systemd/user/`; text embedded as `service::UNIT`, **Unit**: `ExecStart=%h/.cargo/bin/towercab run --watch`, `Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, `Restart=always`, `RestartSec=30`, `WantedBy=graphical-session.target`), runs `systemctl --user daemon-reload` and `systemctl --user enable --now towercab.service`; `down` = `systemctl --user disable --now towercab.service` (SIGTERM, LOOP-7; missions stay); `logs` execs `journalctl --user -u towercab -f`. `systemctl` non-zero → exit 1 with its stderr. | test_unit_file, test_up_down_logs, manual (reboot, log in, `towercab status`) |
| LOOP-3 | **State machine** (`src/machine.rs`, **Machine**): `enum Stage` = the order `pick → design → plan → build → verify → proof → publish → ci → verifier → review → gate → merge → deploy → e2e → release → done`, revert missions ([PIP-19](pipeline.md)) `rollback → revert → revert_ci → revert_merge → revert_deploy → revert_e2e → done`, rehearsals ([PIP-35](pipeline.md)) `rehearse → rehearse_ci → rehearse_close → done`, plus `approval:spec`, `approval:merge`, `approval:release` (waiting on my yes: `approve spec`, `review and merge PR`, `authorize release`), `blocked` (any other `waiting`), `stopped`. `enum Event` (`ok`, `red`, `timeout`, `limit`, `blocked`, `bad_result`, `env_fail`, `crash`, `interrupted`, `pr_merged`, `pr_closed`, `feedback`, `conflict`, `head_moved`, `intent_removed`, `intent_continued`, `retry_fresh`, `approve`, `release`, `pause`, `resume`) and one transition table `machine::next(Stage, Event) -> Next`, a `match` without a catch-all arm (**Transitions**); `done` and `stopped` ignore every event. Every repair (verify, proof, CI, feedback, conflict) resumes the worker in `build` and re-enters the order at `verify`. Handlers (**Handlers**) do a stage's work and return an `Outcome`; only `machine::apply` moves a mission. A test fails if any stage × event pair differs from **Transitions**. | test_every_transition_defined, test_stage_order, test_continue_to |
| LOOP-4 | **Concurrency:** at most `[agent].parallel` (default 1) active children with `ChildSpec.slot` (a Claude run, setup, checks, e2e, a verifier app; not the git and gh calls, which run inline, nor the inhibitor) at a time, each for a different intent in its own checkout; any number of missions waiting (ci, approval, deploy, limit). At most `workers` unfinished missions per repo, all kinds (`blocked` doesn't count, `approval:*` does). An intent has at most one unfinished mission (unique index `missions_one_per_intent`). A free slot goes first to unfinished missions (their intents' PRI-4 order), then to the picker, so a PR waiting on me never stops other repos. | test_pick_while_others_wait, test_repo_slot, test_one_mission_per_intent |
| LOOP-5 | **Pick** (`pick::decide(&Listing, &PickState) -> Decision`, pure, also behind `next`): [PRI-4](priority.md) order over `priority::pick_order` (accepted intents on `main`, no `stage`, no `waiting`, `after:` all done, [PRI-5](priority.md)): at or above the cutoff first, then parked ones. Skipped (`Skip`): picks off (paused, `env_blocked`, a stage handler not built), repo frozen, repo full (`workers`), model cooling down (LOOP-9). Written without a mission (outbox key `intent:<id>`, `n` = the repo, or the sorted `after` ids): repo not in `[repos]` → `waiting: unknown repo`; a queued intent with an `after:` id that is unknown (not open, done or legacy), dropped, or on a cycle of open intents → `waiting: bad after:`. Picked → one transaction inserts the mission: `stage` `pick`, `attempt` = the intent's last + 1, `session` = a new uuid v4, `model` = the intent's `model` else `[agent].model`, `a_at_pick` = `a`, `checkout` `work/<id>-<attempt>`, `branch` `towercab/<id>-<slug>` (attempt ≥ 2: `…-<attempt>`). The `pick` step (`pick::Pick`, built here) fetches Towercab's clone (LOOP-8), loads the repo files ([REPO-1](repo.md): `NoVerifyingBlock` → `waiting: add CLAUDE.md verifying block`, `Invalid` → `waiting: fix repo files` with the error as why, `Git` → `env_fail`), makes the checkout (LOOP-8) → `design` ([PIP-25](pipeline.md)). Missing `u`/`i` count as 3; `a` is never filled in at pick; only a worker's `lower_a` can add one, ≤ 3 ([AUT-7](autonomy.md)). On start and after each `intents` pull, an intent with a `stage` other than `done`/`dropped`, no `waiting` and no unfinished mission loses its `stage` (accepted again; commit `towercab: unstage <id>`); `retry: fresh` on an intent is removed and raises `retry_fresh` (no unfinished mission: unstaged). | test_pick_order, test_parked_after_important, test_bad_after, test_unknown_repo, test_orphan_staged_intent, test_pick_skips, test_pick_step_repo_files |
| LOOP-6 | **Durable steps:** `machine::apply` writes a transition in one SQLite transaction: the mission's `stage`, `step = 'enter'`, `Outcome::set` columns, counters, `waiting`, `why`, a `transitions` row and its outbox rows (LOOP-14). The loop then does the entry effects (**Machine**; idempotent) and sets `step = ''`. Before any other side effect (Claude run, push, PR, merge, revert, intent write, message) a handler calls `Ctx::record(m, step, set)`: one transaction storing the step and the ids it will use (session uuid, branch, head, revert branch). Every step is idempotent; re-entering it first checks: `gh pr list --head <branch> --state open --json number,headRefOid` (counts only if `headRefOid` = `missions.head`), PR `mergedAt`/`mergeCommit`, rerun done (`gh api repos/<r>/actions/runs/<run> --jq .run_attempt` > 1), revert branch; a checkout without a valid `HEAD` (`git rev-parse --verify HEAD` fails) is re-cloned. | test_crash_at_every_step (stub handlers, a spec approval on the way; the `Loop` crashed (`Probe::crash_after(k)`) after its k-th durable write (`record`, transition, entry effect, pick, intent write) for every k, reopened on the same home: reaches `done` with each intent write, outbox row and checkout made once) |
| LOOP-7 | **Crash or restart:** `meta.running` = `<pid> <unix s>` from start until a clean exit; present at start → the last exit was unclean: leftover children are killed (process group `child_pid`, when `/proc/<pid>/stat` start time = `child_start`), then each mission with `busy = 1` (inside a handler call or with a child) gets `unclean + 1`, committed before re-entry; `unclean` ≥ 3 → `waiting: crashed at <stage>`; `unclean` resets on a new step or stage. A caught handler panic counts the same. On start every unfinished mission re-enters its recorded step. A cut-off Claude run resumes its session: Towercab picks the uuid at pick (LOOP-5) and stores it; the `record` before a session's first run sets `session_used = 1`, that run gets `--session-id <uuid>`, every later one `--resume <uuid>` from the same checkout, after a cut-off with the prompt `Continue where you stopped.`; never `--session-id` twice. Session gone (`No conversation found with session ID`) → a new uuid with `--session-id` and a prompt naming branch, PR, `intent.md`, spec IDs and `plan.md` (`Ctx::session(m, step)` → `Session::{New, Resume}`, `Ctx::new_session`, `claude::{CONTINUE, session_gone, fresh_context}`; the worker handlers choose the prompt: `CONTINUE` when re-entered at their recorded run step). SIGTERM or SIGINT (`down`, logout, shutdown, Ctrl-C), acted on between steps: SIGTERM to each child's process group, SIGKILL after 10 s, `interrupted` for its mission (not counted), `meta.running` removed, exit 0. | test_resume_after_kill, test_unresumable_session, test_sigterm_not_counted, test_crash_loop_capped |
| LOOP-8 | Towercab's own clone of a repo = `[repos.<r>].path` (`git clone --quiet -- https://github.com/<github>.git <path>` when missing; only fetched into and pushed from, its working tree never touched). Checkouts `work/<id>-<attempt>` (`checkout::create`): `git clone --quiet --no-checkout -- <clone> <checkout>`, `git remote remove origin`, `git fetch --quiet <clone> +refs/remotes/origin/<base>:refs/remotes/origin/<base>` (by path, never a remote; also how base is refreshed), `git checkout --quiet -B <branch> refs/remotes/origin/<base>`: no git remote (Towercab pushes from its clone, fetching the checkout's commits by path). A mission keeps its checkout and session until it is done, stopped or replaced by `retry --fresh` (entry effect: checkout deleted). | test_checkout_kept, test_checkout_has_no_remote, test_checkout_recloned |
| LOOP-9 | **Usage limits** (`src/limits.rs`, **Limits**): a `claude -p` run with `is_error` or a non-zero exit whose result or stderr matches `limits::detect` (`limits::of_run`; its handler returns `Outcome::limit`) → reset time from `limits::parse_reset(text, now)` (epoch, retry-after, "in N unit", clock time with optional IANA zone, date + time, RFC 3339); none → backoff 1, 2, 4, … 60 min (`cooldowns.backoffs`). Cooldown row keyed (provider `claude`, model = the run's `--model`), `until` = reset + 30 s; the mission stays in its stage, step kept (`limit_model`), until `until`, then re-enters the step: `--resume <uuid>` with `Continue where you stopped.` A limit wait is never a recovery (LOOP-7), a repair (PIP-3, PIP-23) or a timeout continue (PIP-1); timeouts count only the children's run time (`step_secs`, monotonic). Intents on other models keep going (picks skip a cooling model, LOOP-5); any wait length (weekly) just waits; the first success on a model (a child with that `ChildSpec.model` whose `finish` isn't a limit or `env_fail`) resets its `backoffs`. The writer never waits ([PIP-15](pipeline.md)). | test_limit_formats, test_limit_resumes_same_step, test_other_model_runs, test_limit_never_counts_as_crash |
| LOOP-10 | **Network and auth** (`src/env.rs`): a failed git, gh, GitHub API, Telegram, OTLP or `claude` call (`env::classify(stderr)` = network: DNS, refused, reset, timeout, TLS, HTTP 5xx; auth: HTTP 401, `Bad credentials`, claude `/login`) retries with backoff 30 s, 60 s, 120 s, 240 s, 300 s (`missions.retries`, `retry_at`; a retried Claude run resumes per LOOP-7); the loop never exits on them. **Faults** (`faults` row per kind: `github`, `claude`, `tool:<exe>`, `sandbox`, `secrets:<repo>`; Telegram and OTLP never open one) open on the first failure (`StepError::Env`/`Outcome::env` in `machine::apply`'s transaction; a child that can't spawn → `tool:<argv[0]>`; the loop's PR reads (`GhError::Env`) and `intents` polls → `github`) and close on the first success of that kind: a step's fault is held (`missions.fault`) until that step succeeds (any handler result but `env_fail`, a `Poll`, or a spawned child; for `claude` and `sandbox` the child's own result); a fault no mission holds is rechecked (`env::check`, the preflight's check of its kind) 5 min after its last failure and closes when that passes. A fault open for 15 min → `env_blocked` (`meta.env_episode` = its start, unix s, while open): no picks, `Ctx::timeouts` false (no wait timeout fires), one message per episode naming the fix (**Messages**, `env::episode`); a step's retry while blocked waits 5 min; the last fault closing ends it. Preflight on the unit's PATH (`env::preflight`, the first pass): with the App identity a GitHub App token per repo ([LOOP-19](loop.md)), `git ls-remote <url> HEAD` per repo (its clone's `origin`, else `https://github.com/<github>.git`) and `[intents].remote` (`github`; the first failure ends them), `claude --version` (`claude`), `cargo --version`, `bwrap --version` (`sandbox`), `systemd-inhibit --version`; a missing program → `tool:<name>`; each check killed after 20 s; a failure opens its fault, a passed kind no mission holds closes. | test_classify, test_network_blip_keeps_looping, test_env_blocked_once, test_preflight |
| LOOP-11 | **Stay awake** (`src/awake.rs`) while any mission is driven: a stage of the order, revert or rehearsal sequence (not `approval:*`, `blocked`, `done`, `stopped`) and not in a limit wait: one child `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=Towercab --why=<id> <stage> --mode=block sleep infinity` (`--why` from the first driven mission when started; not restarted on stage changes; not a slot), killed when none is driven. A wall-clock gap between passes > 3 × pass → woke: `Ctx::timeouts` is false until every wait has polled once, so no wait timeout fires before its poll. | test_inhibit_while_driving, test_wake_repolls_before_timeout |
| LOOP-12 | **Pass** (`Loop::pass(Tick)`) every 5 s, single-threaded, in this order: signals; wake check; Telegram updates → `commands`; apply `commands`; reap children (`try_wait`) → `Handler::finish`; entry effects due (LOOP-6); child timeouts; due polls (`intents`, PRs, issues); step due missions; pick; faults and preflight; review due; outbox; inhibitor; gauges. Children (`src/child.rs`): `process_group(0)`, env cleared then set, stdin from a file or `/dev/null`, stdout and stderr to files in `runs/<id>/`; a timeout (`ChildSpec.timeout` less the step's `step_secs`: run time, monotonic) sends SIGTERM to the group, SIGKILL after 10 s; `finish` gets `ChildEnd.timed_out`. A new step (`Ctx::record`) resets `step_secs`. Cadence: Telegram every pass; CI `ci_poll` (30 s) and deploy 30 s (the handler's `Progress::Poll { after }`); PR reads 60 s (kind `intent`, `missions.pr` set, `merge_sha` not, PIP-21); issues and draft intent PRs 300 s ([INT-7](intents.md)); gauges 60 s; `intents` pulled only when `git ls-remote origin refs/heads/main` differs from the checkout's `origin/main`, at most every 60 s ([INT-10](intents.md)). Every wait timeout re-checks its condition once before firing. | test_polls_while_child_runs, test_cadence, test_timeout_kills_group |
| LOOP-13 | `towercab status` and Telegram `status` (`status::render(&Snapshot) -> String`, **Status**): active children (intent, stage, model, since), waiting on me (each with its action), waiting on CI or deploy, cooling models with reset time (local, with offset), paused, `env_blocked`, repos capped at a3 or frozen, failed drafts, next intent, review due ([PRI-8](priority.md), `priority::review_due`). Reads SQLite and the store; works without a running loop. | test_status |
| LOOP-14 | **Messages only when I must act** (`src/outbox.rs`, **Messages**). Every `waiting:` Towercab writes is a `machine::Waiting` (approve spec, review and merge PR, authorize release, answer the question, CI red, checks red, tests don't prove the change, no CI checks appeared, CI stuck, worker timeout, worker budget, no result, no changes, crashed at <stage>, bad after:, unknown repo, PR state unknown, merge failed, never published, add CLAUDE.md verifying block, fix repo files, protected path changed, reverted, refine, e2e red after your merge, deploy not seen, revert failed, release failed, production e2e red, PR closed), written only by `machine::apply` and `pick`; each but `PR closed` sends one. Also: repo frozen; env blocked; review due ([PRI-8](priority.md), at most once per 30 days: the last `review_due` row); `rollback rehearsal failed: <repo>` ([PIP-35](pipeline.md)); `triage: <band> at 3σ` ([MNT-6](maintain.md)); `evals dropped <n> points: <change>` ([PIP-33](pipeline.md)). Never on: done, merges, limits, a PR I closed, my own edits. Each message is an `outbox` row keyed (mission, event, n), `INSERT OR IGNORE` in the transition's transaction (`n` = `missions.continued`, or the PR head for `review and merge PR`); text = line 1 (the action), `<id> <repo>: <title>`, why, `PR <url>`, `intent <url>`. A waiting row whose mission no longer waits for that reason when due is dropped (`sent_at = 0`). A test fails if a `Waiting` has no template. | test_only_actionable, test_every_waiting_has_template, test_templates, test_obsolete_message_dropped |
| LOOP-15 | **Commands** (`src/cli.rs`; T = also from Telegram, **Telegram**): `up`, `down`, `logs` (LOOP-2); `run [--watch] [--intent ID]` (the pass loop; without `--watch` it exits 0 once nothing is runnable and no mission is driven but by a limit wait; `--watch` exits only on SIGTERM or SIGINT; `--intent` steps only that intent's mission, picking it first regardless of order and cutoff, not of skips, and exits once it is `done`, `stopped`, `approval:*` or `blocked`, printing `<id>: <stage>[ · <waiting>]`); `status` T; `next` T (**Next**: the intent LOOP-5 would pick and why: priority, order, each skipped intent with its reason); `add "<repo>: <title>" [uN iN aN]` (writes a thin `intent.md` to `main`, [INT-2](intents.md)); `approve <id>` T (same as removing `waiting` by hand, [PIP-17](pipeline.md): removed through the store, `intent_continued` raised; else `<id> isn't waiting on you`); `retry --fresh <id>` T (`retry_fresh` on its unfinished mission; none → its `waiting` and `stage` removed, so the picker takes it as attempt n+1; done or dropped → refused); `release <id>` T ([PIP-34](pipeline.md); not in `approval:release` → `<id> isn't waiting for release`); `pause` / `resume` T (`meta.paused`; pause: no picks; a mission entering `merge`, `revert_merge` or `rollback` holds (`held = 1`); the active child and all waits go on; resume raises `resume` for every held mission); `step <id>` (one step of the intent's unfinished mission in the foreground, waiting for its child, prints `<id>: <stage> → <stage>`; none → picks it as `--intent` does); `protect <repo>` ([REPO-7](repo.md)); `trust <repo>` ([AUT-10](autonomy.md): deletes its `repo_caps` row; the gate logic is the autonomy intent's); `review` ([PRI-7](priority.md); like `add`, writes through the intent store, not a `commands` row); `telemetry on\|off\|status` ([MET-12](metrics.md)), `eval` ([PIP-33](pipeline.md)), `hook guard` (internal, [PIP-29](pipeline.md)): stubs until their intents, exit 1 `not built yet: <ID>` (`hook guard` exit 2, blocking the tool); `migrate` ([INT-13](intents.md)); `doctor` (**Doctor**; warns per `[repos]` repo without a `towercab` ruleset, `repo::protect::find_ruleset`, [REPO-7](repo.md)); `--version`. One loop per home: `flock` on `<home>/towercab.lock` (content `<pid>`); `run`/`step` while held → exit 1, `towercab is running (pid N); towercab down first`. `approve`, `retry --fresh`, `release`, `pause`, `resume`, `trust` (and their Telegram forms) insert a `commands` row the loop applies at the next pass (`commands::apply`, reply in `commands.result`); the CLI applies it itself when the lock is free, else waits up to 10 s for `result` and prints it, then `queued: applied on the loop's next pass`. IDs: any unique suffix ([INT-3](intents.md)). | test_cli, test_telegram_commands, test_second_run_refused, test_commands_row_applied, test_next, test_doctor |
| LOOP-16 | **Telegram transport** (`src/telegram.rs`): Bot API `POST <api_base>/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview: true}` (text ≤ 4000 chars) / `getUpdates` `{offset, timeout: 0, allowed_updates: ["message"]}` (`offset` = last `update_id` + 1, `meta.tg_offset`, stored in the transaction that inserts the commands), 10 s timeout, success = HTTP 200 and `ok: true`. Unsent `outbox` rows go oldest first, stopping at the first failure, and retry with LOOP-10 backoff (`tries`, `next_try`) until `ok: true`, then `sent_at` is set; only a crash between the two can repeat one. Messages from a chat other than `chat_id`, or without `text`, ignored; leading `/` and `@<bot>` accepted; unknown command → one-line help. Failures log once per outage to stderr without the token (`<token>`), never raise. No `[telegram]` → rows are written, nothing is sent or read. | test_outbox_retries_until_sent, test_outbox_survives_restart, test_other_chat_ignored, test_failures_never_raise |
| LOOP-17 | Nothing runnable and nothing driven: idle; passes go on (Telegram, `intents` ls-remote, PR reads); with `--watch` no exit, no message. | test_idle |
| LOOP-18 | **PR and intent events in every stage**, not only `approval` (`src/events.rs`): while `missions.pr` is set and `merge_sha` isn't (kind `intent`, from the design's draft PR on, `blocked` included), each PR read (`PrSource::read`, PIP-21) gives at most one event, `events::pr_events(&Mission, &PrState, me)`: `pr_merged` (→ `deploy`, `merged_by = human`) > `pr_closed` (→ `stopped`, `waiting: PR closed`, no message) > `feedback` > `conflict` > `head_moved`. They are level-triggered (re-derived from the PR against `head` and `feedback_seen`), so `feedback`, `conflict` and `head_moved` are not raised while a child runs and come back at the next read after it ends. On each `intents` poll (every 60 s, pulled when `main` moved, LOOP-12) `events::intent_events(&Mission, &Listing)`: intent file gone (an unreadable one isn't) → `intent_removed` (→ `stopped`, PR left alone); `retry: fresh` → `retry_fresh` (LOOP-5); mission in `approval:*`/`blocked` and `waiting` removed by me → `intent_continued` (PIP-17); not derived while `step = 'enter'`. A transition out of a stage kills that stage's child (`pr_closed`, `pr_merged`, `intent_removed`). No merge while feedback is unhandled: the merge step reads the PR first (PIP-22). | test_events_in_every_stage, test_closed_during_ci, test_my_merge_during_ci, test_pr_and_intent_event_derivation |
| LOOP-19 | **Identity** (playbook: the agent acts under its own identity; `src/github.rs`): Towercab acts on GitHub as the GitHub App `towercab`, registered by me from `ops/github-app.json` (manifest; permissions: contents, pull requests, issues, checks, commit statuses (`statuses`), workflows: write; actions: write (reruns, `gh workflow run`); deployments, metadata: read) and installed on `intents`, `[policies].github` and each repo in `[repos]`. Private key `~/.config/towercab/app.pem` (PKCS#1 or PKCS#8 PEM, mode 0600 else refused; `[github]` app_id, me). RS256 JWT (`iat` = now − 60 s, `exp` = now + 540 s, `iss` = app_id) → `GET <api_base>/repos/<o>/<n>/installation` → `POST /app/installations/<id>/access_tokens` `{repositories: [<n>]}`: a 1-hour token per repo, cached in memory, re-minted when < 10 min remain. Passed as `GH_TOKEN` to its own `gh` calls and to `git` over HTTPS via `-c credential.helper= -c credential.helper='!gh auth git-credential'` (git ignores `GH_TOKEN`), never to Claude runs. Commits are authored and committed as `towercab[bot] <<bot id>+towercab[bot]@users.noreply.github.com>` (`GET /app` → slug, `GET /users/<slug>[bot]` → id, cached in `meta.bot`); PRs, comments and merges show as `towercab[bot]`. The loop's `intents` writes use the same token and identity (`intents::git::GitAuth`). My own `gh` login is used only by commands I run (`protect`, `doctor`'s ruleset check). | test_installation_token_per_repo, test_git_uses_app_token, test_commit_author_is_bot, test_token_never_in_claude_env, test_app_manifest, manual (PR shows towercab[bot]) |

**Home** (`<home>`, LOOP-1)

```
towercab.db (+ -wal, -shm)   SQLite, **Schema**
towercab.lock                flock while a loop or step runs; content "<pid>\n"
work/<id>-<attempt>/         mission checkouts (LOOP-8); rehearsals work/rehearse-<repo>-<yymmdd>/
runs/<id>/                   per intent, across attempts: build.txt, ci-<n>.log, verify-<n>.log, e2e-<n>.log,
                             CLAUDE.md (base copy, PIP-24), policies/ (PIP-27), settings-<kind>.json,
                             <kind>-<n>.prompt / .json (stdout) / .err (stderr);
                             rehearsals runs/rehearse-<repo>-<yymmdd>/, drafts runs/draft-<n>/
drafts/                      clone of [intents].remote for draft intent branches (INT-8), never on main
metrics.jsonl                OTLP spool (MET-13, metrics intent)
```

**Config** (`src/config.rs`; `Config` gains `agent: AgentConfig`, `github: Option<GithubConfig>`, `telegram: Option<TelegramConfig>`, `metrics: MetricsConfig`, `policies: PoliciesConfig`)

| Key | Type, range | Default |
|---|---|---|
| `agent.model`, `agent.drafter` | non-empty string without whitespace | `opus`, `sonnet` |
| `agent.parallel` | int 1–16 | 1 |
| `agent.build_timeout`, `review_timeout`, `check_timeout` | int minutes 1–1440 | 60, 15, 10 |
| `agent.max_budget_usd` | number > 0, ≤ 1000 | 5 |
| `agent.ci_poll`, `ci_grace`, `ci_wait` | int seconds 5–3600, 0–3600, 60–86400 | 30, 120, 1800 |
| `agent.path` | non-empty string (`PATH` of checks and Claude runs) | the loop's `PATH` |
| `agent.toolchain` | list of strings, `~/` expanded, absolute | `["~/.cargo", "~/.rustup", "~/.local/bin"]` |
| `github.app_id` | int ≥ 1 | — (`check_loop`: `github.app_id is required`) |
| `github.me` | GitHub login `[A-Za-z0-9-]+` | — (`check_loop`) |
| `github.api_base`, `telegram.api_base` | `http://` or `https://` URL, trailing `/` dropped | `https://api.github.com`, `https://api.telegram.org` |
| `telegram.bot_token` | non-empty string | — (section absent → no Telegram) |
| `telegram.chat_id` | string or int, kept as string | — |
| `metrics.endpoint`, `metrics.prometheus` | URL | `http://localhost:4318`, `http://localhost:9090` |
| `policies.github`, `policies.base` | `<owner>/<name>` (`is_github`), `is_branch` | none (no shared policies), `main` |

**Schema** (`src/db.rs`; `db::open`: `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`; `db::MIGRATIONS: &[&str]`, migration i takes `PRAGMA user_version` from i to i+1 in one transaction (a newer `user_version` → refused); later intents append; times are unix seconds `REAL`)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- running "<pid> <unix>", paused "1", tg_offset, env_episode "<unix>" (while env_blocked), bot "<slug> <user id>", last_pass

CREATE TABLE missions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'intent' CHECK (kind IN ('intent','revert','rehearsal')),  -- Stage::kind of its stage
  intent TEXT,                          -- intent id; NULL for a rehearsal
  repo TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  stage TEXT NOT NULL,                  -- Stage::as_str
  step TEXT NOT NULL DEFAULT 'enter',   -- 'enter': entry effects due; '': the handler's turn; else its recorded step
  busy INTEGER NOT NULL DEFAULT 0,      -- inside a handler call or with a child (LOOP-7)
  unclean INTEGER NOT NULL DEFAULT 0,   -- unclean re-entries of this step
  from_stage TEXT,                      -- the stage left for approval/blocked/stopped
  waiting TEXT, why TEXT,               -- Waiting::text; one-line detail for status and messages
  continued INTEGER NOT NULL DEFAULT 0, -- times continued (outbox n)
  held INTEGER NOT NULL DEFAULT 0,      -- paused at merge, revert_merge or rollback entry
  model TEXT NOT NULL, a_at_pick INTEGER,
  session TEXT NOT NULL, session_used INTEGER NOT NULL DEFAULT 0, run_session TEXT,
  checkout TEXT NOT NULL,               -- relative to the home
  branch TEXT, base_sha TEXT, head TEXT,
  pr INTEGER, pr_url TEXT, pushed_at REAL, feedback_seen TEXT,  -- feedback_seen: RFC 3339
  merged_by TEXT CHECK (merged_by IN ('towercab','human')), merge_sha TEXT, revert_branch TEXT,
  verify_repairs INTEGER NOT NULL DEFAULT 0, ci_repairs INTEGER NOT NULL DEFAULT 0,
  sync_rounds INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0, retry_at REAL,              -- LOOP-10 backoff of this step
  fault TEXT,                           -- its last env_fail's fault kind: the step's next success closes it
  limit_model TEXT,                     -- the step waits for this model's cooldown (LOOP-9)
  step_secs REAL NOT NULL DEFAULT 0,    -- children run time of this step (timeouts)
  child_pid INTEGER, child_start INTEGER, child_kind TEXT, child_since REAL,
  cost_usd REAL NOT NULL DEFAULT 0, agent_secs REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',      -- JSON: stage results the pipeline keeps
  created REAL NOT NULL, updated REAL NOT NULL, finished REAL
);
CREATE UNIQUE INDEX missions_one_per_intent ON missions(intent)
  WHERE intent IS NOT NULL AND stage NOT IN ('done','stopped');

CREATE TABLE transitions (id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  at REAL NOT NULL, from_stage TEXT NOT NULL, event TEXT NOT NULL, to_stage TEXT NOT NULL, why TEXT);

CREATE TABLE cooldowns (provider TEXT NOT NULL, model TEXT NOT NULL, until REAL NOT NULL,
  parsed INTEGER NOT NULL, backoffs INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, since REAL NOT NULL,
  PRIMARY KEY (provider, model));

CREATE TABLE outbox (mission TEXT NOT NULL,   -- mission id, 'intent:<id>', 'repo:<name>' or 'loop'
  event TEXT NOT NULL, n TEXT NOT NULL, text TEXT NOT NULL, created REAL NOT NULL,
  sent_at REAL, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (mission, event, n));

CREATE TABLE commands (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('approve','retry_fresh','release','pause','resume','trust')),
  arg TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,  -- 'cli' or 'telegram'
  created REAL NOT NULL, applied_at REAL, result TEXT);

CREATE TABLE repo_caps (repo TEXT PRIMARY KEY, capped INTEGER NOT NULL DEFAULT 0,  -- cap 3 (AUT-10, MNT-6)
  frozen INTEGER NOT NULL DEFAULT 0, why TEXT NOT NULL, since REAL NOT NULL);

CREATE TABLE faults (kind TEXT PRIMARY KEY, since REAL NOT NULL, last REAL NOT NULL,
  error TEXT NOT NULL, next_try REAL NOT NULL);

CREATE TABLE drafts (key TEXT PRIMARY KEY,   -- 'issue:<url>', 'alert:<band>', 'review:<rule>'
  repo TEXT NOT NULL, source TEXT NOT NULL, intent TEXT, slug TEXT, pr INTEGER, pr_url TEXT,
  step TEXT NOT NULL,                        -- draft, push, pr, link, open, accepted, rejected, failed
  tries INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL);
```

**Machine** (`src/machine.rs`)

- `Stage::ALL` (30), `as_str`/`FromStr` (the names above, `approval:spec` etc.), `kind()` (`revert` for rollback … revert_e2e, `rehearsal` for rehearse … rehearse_close, else `intent`), `driven()` (order, revert and rehearsal stages but `done`), `playbook() -> Option<intents::Stage>`: pick, design, approval:spec → `design`; plan, build → `build`; verify, proof, publish, ci, verifier → `test`; review, gate, merge, approval:merge, deploy, e2e, release, approval:release → `deploy`; revert stages → `maintain`; done → `done`; blocked, stopped, rehearsal stages → unchanged.
- `Next::{Go(Stage), Wait, Again, Cool, Backoff, Recover, Stop, Continue, Fresh, Ignore, Unexpected}`. `Wait` → the stage of `outcome.waiting` (`Waiting::stage`), `from_stage` = the stage left (kept when already waiting). `Again` → re-enter the step, nothing counted. `Cool` → cooldown upsert, `limit_model` set, step kept. `Backoff` → `retries + 1`, `retry_at` (LOOP-10). `Recover` → `unclean + 1`; ≥ 3 → `Wait` with `crashed at <stage>`; else `Again`. `Stop` → `stopped` (`waiting: PR closed` for `pr_closed`). `Continue` → `continue_to`, then `continued + 1` and `verify_repairs`, `ci_repairs`, `sync_rounds`, `unclean` = 0. `Fresh` → this mission `stopped` (why `replaced by attempt <n>`) and a new one at `pick`, attempt + 1, in the same transaction. `Unexpected` → logged `unexpected <event> at <stage>`, then as `Recover`.
- `continue_to(&Waiting, from: Stage) -> Next`: approve spec → `plan`; review and merge PR → `gate`; authorize release → `release`; e2e red after your merge → `done`; deploy not seen, revert failed, add CLAUDE.md verifying block, fix repo files → `Go(from)`; crashed at `<s>` → `Go(<s>)`; reverted, refine, PR closed → `Fresh`; any other → `build` (the worker resumes, PIP-17).
- `apply` also, in its transaction: `revert failed` → `repo_caps.frozen = 1` + `repo frozen` message; `reverted, refine` → `repo_caps.capped = 1` ([AUT-10](autonomy.md)); `red` at rehearse or rehearse_ci → `rollback rehearsal failed` message.
- Entry effects (`step = 'enter'`, idempotent, in order; `machine::enter`, run by the loop for every `step = 'enter'` row, finished ones included): the left stage's child is killed by the loop at the transition (SIGTERM, SIGKILL 10 s later; after a crash, recovery kills it); intent (kinds `intent`, `revert`; skipped when the file is gone or already in `done/`): one `Store::update(id, <stage>, …)` (commit `towercab: <stage> <id>`) setting `stage` (`playbook()`), `waiting` (approval, blocked, `PR closed`) or removing it, `pr` (= `pr_url`), at `pick` removing `retry`, at `done` also `cost`, `agent_time`, `attempts` (over the intent's missions); `done`/`stopped`: checkout deleted, `finished` set; `merge`, `revert_merge`, `rollback` while paused → `held = 1`; then `step = ''`. The intent commit (`Store::update_marked`) ends with the trailer `Towercab-Entry: <session> <transition id>`; a re-run that finds it in the last 200 commits (`Store::has_mark`) skips the write, so my edits since stay. A finished mission whose entry is due still owns its intent (no unstage). A failed entry (the store refused or unreachable) is logged and retried next pass.

**Transitions** (`next(stage, event)`; `done` and `stopped`: `Ignore` for every event; `→ x` = `Go(x)`; "next" = the next stage of its sequence)

| Event | pick … release | revert stages | rehearsal stages | approval:spec | approval:merge | approval:release | blocked |
|---|---|---|---|---|---|---|---|
| ok | next | next | next | Unexpected | Unexpected | Unexpected | Unexpected |
| red | verify, proof, ci → build; e2e → rollback; else Unexpected | Unexpected | rehearse, rehearse_ci → rehearse_close; rehearse_close Unexpected | Unexpected | Unexpected | Unexpected | Unexpected |
| timeout, bad_result | Again | Again | Again | Unexpected | Unexpected | Unexpected | Unexpected |
| limit | Cool | Cool | Cool | Unexpected | Unexpected | Unexpected | Unexpected |
| blocked | Wait | Wait | Wait | Wait | Wait | Wait | Wait |
| env_fail | Backoff | Backoff | Backoff | Backoff | Backoff | Backoff | Backoff |
| crash | Recover | Recover | Recover | Ignore | Ignore | Ignore | Ignore |
| interrupted | Again | Again | Again | Ignore | Ignore | Ignore | Ignore |
| pr_merged | design … merge → deploy; pick, deploy, e2e, release Ignore | Ignore | Ignore | → deploy | → deploy | Ignore | → deploy |
| pr_closed | design … merge Stop; pick, deploy, e2e, release Ignore | Ignore | Ignore | Stop | Stop | Ignore | Stop |
| feedback | build … merge → build; else Ignore | Ignore | Ignore | → design | → build | Ignore | → build |
| conflict | ci … merge → build; else Ignore | Ignore | Ignore | Ignore | → build | Ignore | → build |
| head_moved | ci … merge → ci; else Ignore | Ignore | Ignore | Ignore | → ci | Ignore | → ci |
| intent_removed | Stop | Ignore | Ignore | Stop | Stop | Stop | Stop |
| intent_continued, approve | Ignore | Ignore | Ignore | Continue | Continue | Continue | Continue |
| retry_fresh | Fresh | Ignore | Ignore | Fresh | Fresh | Fresh | Fresh |
| release | Ignore | Ignore | Ignore | Ignore | Ignore | → release | Ignore |
| pause | Ignore | Ignore | Ignore | Ignore | Ignore | Ignore | Ignore |
| resume | merge Again; else Ignore | rollback, revert_merge Again; else Ignore | Ignore | Ignore | Ignore | Ignore | Ignore |

Handlers decide what the table can't: caps (3 repairs, 3 sync rounds, one continue), the spec gate, the gate, a release block, a revert's green end and a red that gets no repair all return `blocked` with their `Waiting`.

**Handlers** (`src/handler.rs`; the pipeline intent implements one per stage; this intent builds `pick::Pick` and stubs)

```rust
pub trait Handler {
    /// Do or redo the step of `m.stage` from `m.step` (LOOP-6): `cx.record` before each side effect;
    /// on re-entry check what the recorded step already did. Never blocks beyond one git/gh call.
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError>;
    /// The child `step` spawned has ended.
    fn finish(&mut self, cx: &mut Ctx<'_>, m: &Mission, end: ChildEnd) -> Result<Progress, StepError>;
    fn built(&self) -> bool { true }  // false only for NotBuilt
}
pub enum Progress { Done(Outcome), Spawn(ChildSpec), Poll { after: Duration } }
pub enum StepError { Env(Fault, String) /* → env_fail */, Bug(String) /* → Unexpected */ }
pub struct Outcome { pub event: Event, pub waiting: Option<Waiting>, pub why: Option<String>,
    pub limit: Option<Limit>, pub fault: Option<(Fault, String)>, pub set: Vec<(&'static str, rusqlite::types::Value)> }
// Outcome::ok(), red(why), wait(Waiting, why), limit(Limit), env(Fault, why), timeout(), bad_result(why), with(col, v)
pub struct ChildSpec { pub kind: ChildKind, pub argv: Vec<OsString>, pub cwd: PathBuf, pub env: Vec<(OsString, OsString)>,
    pub stdin: Option<PathBuf>, pub stdout: PathBuf, pub stderr: PathBuf, pub timeout: Option<Duration>,
    pub slot: bool, pub model: Option<String> }
pub struct ChildEnd { pub status: Option<ExitStatus>, pub timed_out: bool, pub run: Duration, pub stdout: PathBuf, pub stderr: PathBuf }
pub struct Ctx<'a> { pub config: &'a Config, pub home: &'a Home, pub db: &'a Db, pub store: &'a Store,
    pub exes: &'a Exes, pub identity: &'a mut Identity, pub tick: Tick, pub timeouts: bool, pub probe: &'a Probe }
// Ctx::record(&self, &Mission, step, set: &[(&str, Value)]) -> Result<Mission, String> (a new step resets unclean, retries);
// session(&Mission, step) -> (Mission, Session::{New, Resume}(uuid)) (LOOP-7: records step + session_used = 1; New only for
// the session's first run); new_session(&Mission) (session gone: new uuid, unused, step ''); checkout(&Mission); runs(&Mission);
// repo(&Mission). update(&Connection, id, cols) checks each column against mission::COLUMNS.
pub struct Probe;     // crash injection: point() after each durable write (record, apply, entry effect, pick, intent write);
                      // crash_after(Some(k)) panics with Crashed at the k-th, which the loop never catches (LOOP-6's test)
pub struct Handlers;  // stubs(): every driven stage → Stub (records step "stub", then Done(ok)); production(): Pick + NotBuilt
                      // (picks off); set(Stage, Box<dyn Handler>); built() = every handler built(); get_mut(Stage)
```

**Messages** (`machine::Waiting`: `text()`, `parse(&str)`, `stage()`, `key()` = the text before any parameter, lowercased, each run of other characters → `_`; `outbox::render_waiting`)

| `waiting:` | Stage | Line 1 |
|---|---|---|
| `approve spec` | approval:spec | `approve spec: approve <id>` |
| `review and merge PR` | approval:merge | `review and merge PR` |
| `authorize release` | approval:release | `authorize release: release <id>` |
| `answer the question`, `CI red`, `checks red`, `tests don't prove the change`, `no CI checks appeared`, `CI stuck`, `worker timeout`, `worker budget`, `no result`, `no changes`, `crashed at <stage>`, `PR state unknown`, `merge failed`, `never published`, `add CLAUDE.md verifying block`, `fix repo files`, `protected path changed`, `reverted, refine`, `deploy not seen`, `revert failed`, `release failed`, `production e2e red` | blocked | the `waiting:` text |
| `bad after:`, `unknown repo` | none (intent only, LOOP-5) | the `waiting:` text |
| `e2e red after your merge (<door>)` (`one-way`, `two-way`, `unknown`) | blocked | `e2e red after your merge (<door>): approve <id> to keep it, or retry --fresh <id> to fix forward` |
| `PR closed` | stopped | none: no message |

Body after line 1, each line `one_line`, empty ones left out, ≤ 4000 chars: `<id> <repo>: <title>` (title ≤ 200), why (≤ 300, cut with `…`), `PR <url>`, `intent https://github.com/<intents owner/name>/blob/main/intents/<id>-<slug>/intent.md` (`[intents].remote` not on GitHub → `intent intents/<id>-<slug>/intent.md`). Other messages (`outbox::Notice`):

| Message | Key (mission, event, n) | Line 1 | Line 2 |
|---|---|---|---|
| repo frozen | `repo:<r>`, `frozen`, since | `repo frozen: <repo>: trust <repo> when fixed` | why |
| env blocked | `loop`, `env_blocked`, episode | `env blocked: <kind>: <error>` | `fix: <fix>`: github `check the network and the GitHub App (ops/github-app.json, ~/.config/towercab/app.pem)`; claude `run claude and /login, or check the network`; `tool:<exe>` `install <exe> on the unit's PATH`; sandbox `check bwrap (unprivileged user namespaces)`; `secrets:<repo>` `chmod 600 ~/.config/towercab/secrets/<repo>.env` |
| review due | `loop`, `review_due`, `YYYY-MM-DD` | `review the backlog: towercab review` | `last review <YYYY-MM-DD>` / `never reviewed` / `nothing at or above the cutoff` |
| rehearsal failed | `repo:<r>`, `rehearsal_failed`, `yymmdd` | `rollback rehearsal failed: <repo>` | why, `PR <url>` |
| triage | `loop`, `triage:<band>`, point time | `triage: <band> at 3σ` | value, mean, σ; `PR <url>` |
| evals dropped | `loop`, `evals_dropped`, run | `evals dropped <n> points: <change>` | — |
| reply | `loop`, `reply`, update_id | the reply | — |

**Limits** (`src/limits.rs`; `detect(text) -> bool`, `parse_reset(text, now: DateTime<FixedOffset>) -> Option<DateTime<Utc>>`, `of_run(model, failed, result, stderr, now) -> Option<Limit>` (failed and the result, else stderr, detected; text one line ≤ 300), `backoff(n) -> Duration` = min(2ⁿ⁻¹, 60) min; "local" = `now`'s offset)

- Detect (ASCII case-insensitive): `rate.?limit|usage.?limit|hit your limit|limit reached|limit will reset|quota|too many requests|\b429\b|overloaded|rate_limit_error|overloaded_error`.
- Reset, first rule that matches wins (within the clock rule, its first valid match): epoch `\|(\d{10})\b`; `retry[- ]after[\s:=]+(\d+)` seconds; `(?:try again|retry|resets?|available again) in <N>[ ]<unit>( <N>[ ]<unit>)?` (units `s`, `sec(s)`, `second(s)`, `m`, `min(s)`, `minute(s)`, `h`, `hr(s)`, `hour(s)`, `d`, `day(s)`); RFC 3339 or `YYYY-MM-DD[T ]HH:MM[:SS][Z|±HH[:]MM]` (no zone → local); `resets? [at |on ]` + optional `<Mon>[a-z]*\.? <day>[st|nd|rd|th][,] [at ]` + `<h>[:<mm>] [am|pm]` + optional `(<IANA zone or UTC>)` (`chrono-tz`; unknown zone → local), needing am/pm, minutes or a date (a bare number is not a time), hour ≤ 23 (1–12 with am/pm); a clock time already past → tomorrow, a date already past (or invalid this year) → next year; a time a DST change skips → an hour later.
- Cases (`test_limit_formats`, now 2026-10-15 13:30 Europe/Berlin): `You've hit your limit · resets 3pm (Europe/Berlin)` → 15:00 that day; `limit reached ∙ resets 11am (Europe/Berlin)` → the 16th 11:00; `weekly limit · resets Oct 17, 9:30am (Europe/Berlin)` → the 17th 09:30; `Claude AI usage limit reached|1760540400` → that epoch; `429 rate limit retry-after: 120` → +120 s; `rate limited, try again in 5 minutes` → +300 s; `resets in 2h 30m` → +9000 s; `resets 15:00 (UTC)` → 15:00 UTC; `limit resets at 2026-10-16T09:00:00Z` → that time; `429 Too Many Requests`, `resets 3 things` → none; plus each rule's variants, zones, DST and the invalid times in the test.

**Telegram** (`telegram::parse(text) -> Result<TgCommand, String>`; the reply to any `Err` is `HELP`)

```
message  = ["/"] command ["@" bot] { " " arg }        command ASCII case-insensitive; runs of spaces = one
status | next | pause | resume | help | start          no argument
approve <id> | release <id>                            one id, any unique suffix (INT-3)
retry [--fresh] <id>                                   = retry --fresh <id>
HELP     = "commands: status · next · approve <id> · retry <id> · release <id> · pause · resume"
```

Replies (the CLI prints the same): `status`/`next` text; `approved <id>`, `fresh attempt <n> for <id>`, `releasing <id>`, `paused: no picks; merges and reverts hold`, `resumed`, `trusted <repo>`; errors `<command>: <reason>` (e.g. `approve: no open intent matches 99`); `help`, `start` → `HELP`.

**Status** (`<time>` = `HH:MM` today, else `YYYY-MM-DD HH:MM`, local; values through `review::shown`; empty sections left out)

```
towercab <version> · running (pid <n>)|not running[ · paused][ · env blocked]
active: <id> <repo>: <title> · <stage> · <model|-> · since <time>         (one per child; none → "active: none")
waiting on you:
- <id> <repo>: <title> · <waiting>[ · <pr url>]                         (missions and intent-level waits)
waiting on CI or deploy:
- <id> <repo>: <title> · <stage> · since <time>                         (ci, deploy, revert_ci, revert_deploy, rehearse_ci)
cooling: <model> until <YYYY-MM-DD HH:MM ±HH:MM>
env blocked: <kind>: <error> · since <time>
repos: <repo> capped at a3, <repo> frozen
drafts failed: <key>, …
intents: <error>                                                       (the store couldn't be read)
next: <id> <repo>: <title>|next: nothing runnable
review due: towercab review
```

**Next** (`next` and Telegram `next`)

```
next: <id> <repo>: <title> · p<p> u<u> i<i>[ a<a>][ · parked]       (or "next: nothing runnable")
skipped:
- <id> <repo>: <title> · <reason>
```

Reasons: `paused`, `env blocked`, `picks off: pipeline not built`, `repo <r> frozen`, `repo <r> full (<n>/<workers>)`, `<model> cooling until <time>`, `unknown repo <r>`, `bad after: <ids>`.

**Doctor** (stdout; exit 0 unless the config can't load)

```
config: <file>                       (or "config: <error>", exit 1)
home: <home>
<exe>: <path>|missing                git, gh, claude, cargo, bwrap, systemd-inhibit, systemctl
github app: towercab[bot] <id>|<error>
<repo>: no towercab ruleset: towercab protect <repo>
<repo>: origin isn't https://github.com/…: the App token isn't used
telegram: chat <chat_id>|not configured
```

**Unit** (`service::UNIT`)

```ini
[Unit]
Description=Towercab

[Service]
ExecStart=%h/.cargo/bin/towercab run --watch
Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=30
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=graphical-session.target
```

**Code** (all `pub`; tests only in `tests/`; part = build order: 1 home, config, service; 2 machine, pick; 3 limits, network, awake; 4 status, messages, commands; 5 identity, Claude runs)

| Part | File | Interface |
|---|---|---|
| 1 | `src/config.rs` | **Config** sections; `Config::check_loop(&self) -> Result<(), String>`. |
| 1 | `src/home.rs` | `Home { root }`: `resolve(Option<&Path>)`, `db()`, `lock_path()`, `lock() -> Result<LoopLock, String>` (`try_lock`; held, but by no `LoopLock` of this process and not by another pid → retried up to 5 s: a fork of this process holds a copy of the fd until its `exec`), `holder() -> Option<u32>`, `work(id, attempt)`, `runs(dir)`. |
| 1 | `src/db.rs` | `Db`: `open(&Path)`, `MIGRATIONS`, `version()`, `tx(FnOnce(&Transaction) -> Result<T, String>)` (`BEGIN IMMEDIATE`), `meta`/`set_meta`/`del_meta` (also free fns `get_meta`/`set_meta`/`del_meta(&Connection, …)` for use inside `tx`); row types (`from_row`) `CommandRow`, `OutboxRow`, `Cooldown`, `RepoCap`, `FaultRow`, `DraftRow`. |
| 1 | `src/exes.rs` | `Exes { git, gh, claude, cargo, bwrap, systemd_inhibit, systemctl, journalctl: OsString }` (`Default` = the names on `PATH`; tests point them at fakes). |
| 1 | `src/service.rs` | `UNIT`, `unit_path() -> Result<PathBuf, String>`, `up(&Exes)`, `down(&Exes)` (`-> Result<String, String>`: the line printed), `logs(&Exes) -> Result<Infallible, String>` (exec). |
| 1, 2 | `src/runloop.rs` | `Tick { wall: DateTime<FixedOffset>, mono: Duration }` (`now()`, `unix()`, `after(d)`); `shown_time(unix, now)` (**Status** `<time>`); `LoopOpts { watch, intent: Option<String>, pass: Duration (5 s), kill_after: Duration (10 s) }`; `Loop::open(Config, Home, Handlers, Exes, LoopOpts) -> Result<Loop, String>` (lock, db, `meta.running` (a leftover one → `Loop.unclean`), recovery; the preflight runs in the first pass); `pass(&mut self, Tick) -> Result<PassReport { commands: Vec<(i64, String)>, idle, stop, picked: Option<String> }, String>`; part 2: pub `prs: Box<dyn PrSource>`, `identity`, `probe`; `listing()`, `running()`, `queued()`, `slots_used()`, `pick_state(Tick)`; slot children wait in PRI-4 order for a free slot; a pick needs a free slot and no mission still stepping; `run(self) -> Result<(), String>` (passes, sleep woken by a SIGTERM/SIGINT self-pipe, a second signal exits at once); `stop_flag()`; `shutdown(&mut self) -> Result<(), String>` (children: SIGTERM, SIGKILL after `kill_after`, `interrupted`; `meta.running` removed). |
| 1, 4 | `src/commands.rs` | `Cmd::{Approve(String), RetryFresh(String), Release(String), Pause, Resume, Trust(String)}` (`name`, `word`, `failed(reply)`: an error reply `<word>: …`); `queue(&Db, &Cmd, source) -> Result<i64, String>`; `CmdCx { config, db, tick }`; `apply(&CmdCx, &CommandRow) -> Result<String, String>` (effect, `applied_at`, `result` in one transaction; an applied row returns its result), `apply_pending`; `wait_result(&Db, id, Duration) -> Option<String>`; `submit(&Config, &Home, &Db, &Cmd, wait) -> Result<Option<String>, String>` (the CLI's way; `None` = queued). |
| 2 | `src/machine.rs` | `Stage` (`ALL`, `as_str`, `kind`, `driven`, `waits`, `finished`, `next`, `playbook`), `Event` (`ALL`, `as_str`), `Kind`, `Next`, `next`, `ORDER`, `REVERT`, `REHEARSAL`, `Waiting` (`ALL` = one sample per variant, `Door`), `continue_to`; `Apply { db, config, listing: Option<&Listing>, tick }` (the listing gives messages the title and slug, a fresh attempt its `model` and `a`); `apply(&Apply, &Mission, &Outcome) -> Result<Mission, String>`, `apply_as(…, Option<Next>)`, `apply_tx(&Connection, …)` (a mission no longer at `m.stage` → nothing written); `enter(&mut Ctx, &Mission)` (entry effects); `paused`. |
| 2 | `src/mission.rs` | `Mission` (a typed `missions` row; `label`, `waiting()`), `Kind`, `COLUMNS`, `ENTER`; `get`, `unfinished`, `entering` (`step = 'enter'`, finished ones too), `for_intent`, `unfinished_for` (`&Connection`); `NewMission { intent, slug, repo, model, a, min_attempt }` (`of(&Intent, &Config)`), `insert(&Connection, &NewMission, Tick) -> Result<Mission, String>` (attempt = max(last + 1, `min_attempt`)), `insert_pick`, `branch(id, slug, attempt)`. |
| 2 | `src/handler.rs` | **Handlers**. |
| 2 | `src/pick.rs` | `PickState { cutoff, paused, env_blocked, built, repos, model, frozen, full: repo → (n, workers), cooling: model → until, active }` (`active`: intents with an unfinished mission, never picked), `decide`, `Decision { pick, skipped: Vec<(String, Skip)>, writes: Vec<(String, Waiting, String)> }`, `Skip` (`Display` = the **Next** reason), `bad_after(&Listing) -> Vec<(String, Vec<String>)>`, `orphans(&Listing, &[Mission]) -> Vec<String>`, `Pick` (handler). |
| 2 | `src/checkout.rs` | Each takes the `git` executable (`Exes::git`) first: `git(exe, dir, args, Option<&GitAuth>)` (`GIT_CEILING_DIRECTORIES` = the parent), `ensure_clone(exe, &RepoConfig, Option<&GitAuth>)` (clone when missing, then `git fetch --quiet --prune origin`), `create(exe, clone, checkout, base, branch)`, `valid(exe, &Path) -> bool`, `ensure(exe, clone, checkout, base, branch) -> Result<bool, String>` (valid → kept; else removed and created), `refresh_base(exe, clone, checkout, base)`, `remove`, `rev`. |
| 2 | `src/events.rs` | `PrState { state, merged_at, merge_commit, head, mergeable, comments: Vec<Comment { author, at, body }> }`; `trait PrSource { fn read(&mut self, github: &str, pr: u64) -> Result<PrState, GhError>; }` (`GhPrs { gh, identity }`: `gh pr view` + `gh api …/comments`, `parse_pr(view, comments)`; tests use a fake); `new_feedback`, `pr_events`, `intent_events`. |
| 2, 3 | `src/child.rs` | `spawn(&ChildSpec, mono) -> Result<Child, String>` (`process_group(0)`, env cleared then set, stdin file or `/dev/null`, stdout/stderr files), `Child::poll(&mut self, mono) -> Option<ChildEnd>`, `term(mono)`, `kill_if_due(mono, after)`, `kill_group(pid)`, `term_group(pid)`, `kill_leftover(pid, start) -> bool`, `start_time(pid) -> Option<u64>` (`/proc/<pid>/stat` field 22), `KILL_AFTER` (10 s); `Child.budget` (the loop sets `ChildSpec.timeout` − the step's `step_secs`), `enforce(mono, after)` (run time ≥ budget → `timed_out`, SIGTERM to the group; SIGKILL `after` later). |
| 2, 3 | `src/limits.rs` | `Limit { model, reset: Option<DateTime<Utc>>, text }`, `CLAUDE`, `backoff(n)`, `cool(&Connection, &Limit, now) -> until`, `success(&Connection, model)` (backoffs → 0), `until(&Connection, model) -> Option<f64>`, `cooling(&Db, now) -> Vec<Cooldown>`; **Limits** (`detect`, `parse_reset`, `of_run`). |
| 2, 3 | `src/env.rs` | `Fault` (`Display`/`FromStr` = kind, `fix()`), `FaultClass::{Network, Auth}`, `classify(&str) -> Option<FaultClass>`, `backoff(retries) -> Duration`, `BLOCK_AFTER` (900 s), `RECHECK` (300 s), `CHECK_TIMEOUT` (20 s); on a `&Connection`: `open(fault, error, now) -> bool` (new), `close(kind)`, `settle(mission)` (closes its held fault), `faults`, `held`, `blocked`, `episode(now) -> bool` (starts/ends the episode, its message); `run_check(exe, args) -> Result<(), CheckError::{Missing, Failed}>`, `github_urls(&Config, &Exes)`, `check(&Fault, &Config, &Exes, &mut Identity)`, `preflight(&Config, &Exes, &mut Identity) -> Vec<(Fault, Result<(), String>)>`, `record(&Connection, results, now) -> opened`. |
| 3 | `src/awake.rs` | `Inhibitor::update(&mut self, driving: Option<(String, Stage)>, &Exes)`; `woke(last, now, pass) -> bool`. |
| 4 | `src/status.rs` | `Snapshot::read(&Db, &Store, &Config, now)`, `render(&Snapshot) -> String`, `next_text(&Decision, &Listing) -> String`. |
| 2, 4 | `src/outbox.rs` | Parts 2, 3 (what `apply`, `pick` and `env::episode` write): `Subject`, `Notice::{RepoFrozen, EnvBlocked { kind, error, fix }, RehearsalFailed}`, `first_line`, `render_waiting`, `render_notice`, `enqueue(&Connection, mission, event, n, text, now) -> bool`, `one_line`, `cut`; part 4 the rest: `Subject { id, repo, title, slug, pr_url, why }`; `Notice::{RepoFrozen, EnvBlocked, ReviewDue, RehearsalFailed, Triage, EvalsDropped, Reply}`; `render_waiting(&Waiting, &Subject, &Config) -> String`, `render_notice(&Notice) -> String`, `enqueue(&Transaction, mission, event, n, text)`, `send_due(&Db, &mut Telegram, now)`. |
| 4 | `src/http.rs` | `get_json`/`post_json(url, headers, body, 10 s) -> Result<(u16, Value), HttpError>` (`ureq`); `HttpError::{Net(String), Status(u16, String)}`; `/bot<token>/` masked in errors. |
| 4 | `src/telegram.rs` | `Telegram::new(&TelegramConfig)`, `send(text) -> Result<(), String>`, `updates(offset) -> Result<Vec<Update { id, chat, text }>, String>`, `parse`, `HELP`. |
| 4 | `src/doctor.rs` | `doctor(&Config, &Home, &Exes) -> String` (**Doctor**). |
| 2, 5 | `src/github.rs` | `Identity::none()` (part 2: my `gh` auth, no token; `gh(&mut self, gh, args)`, `is_env_failure(stderr)`); part 5: `App::load(&GithubConfig)`, `App::jwt(now) -> String`, `Identity::app(App, api_base)`: `token(&mut self, github, now) -> Result<String, GhError>`, `bot() -> Result<Bot { login, id, email }, GhError>`, `gh(&Exes, github, args) -> Result<String, GhError>`, `git_auth(github) -> Result<GitAuth, GhError>`; `GhError::{Env(String), Failed(String)}`. |
| 2, 5 | `src/intents/git.rs` | Part 2: `git_command_for(exe)`, `GitAuth { args: Vec<String>, env: Vec<(String, String)> }` (empty); part 5 fills it (credential helper, `GH_TOKEN`, bot `user.name`/`user.email`); `Checkout::with_auth(Box<dyn FnMut() -> Result<GitAuth, String>>)`; `Store::open_as(&Config, auth)`. |
| 5 | `ops/github-app.json` | `{name: towercab, url: https://github.com/MajidBabaeifar/towercab, public: false, hook_attributes: {url: <same>, active: false}, default_permissions: {contents, pull_requests, issues, checks, statuses, workflows, actions: write; deployments, metadata: read}, default_events: []}`. |
| 2, 5 | `src/claude.rs`, `src/drafts.rs` | Part 2: `CONTINUE`, `SESSION_GONE`, `session_gone(text)`, `fresh_context` (LOOP-7); part 5: [PIP-24](pipeline.md) **Claude runs**; [INT-7, INT-8](intents.md) **Code**. |
| all | `src/cli.rs` | `towercab [--config <file>] [--home <dir>] <command>`, LOOP-15; errors `towercab: <reason>`, exit 1; bad arguments exit 2. |

## Out of scope

- Claims across machines (laptop + VPS).
- Periodic e2e watch of live services ([PIP-10](pipeline.md)).
- Stage handlers other than `pick` (the pipeline intent); the gate's use of `repo_caps` (autonomy); `telemetry`, `eval`, `hook guard` and gauges beyond stubs (metrics and pipeline intents).

## Decisions

- Code drives (my call, after comparing with one long Claude session): weekly limits, restarts,
  "every step runs" and zero tokens while waiting all need code. Claude only where judgment is needed.
- Rust (my call): compiler-checked state machine, one binary. Cost: rewrite from zero.
- Single-threaded, no async runtime: children run detached and are polled with `try_wait`, so polls,
  Telegram and gauges keep their cadence during a 60-minute build.
- `parallel` defaults to 1 (my call): the subscription's usage limit is the bottleneck today; raise it when it isn't.
- Towercab picks the session uuid: a crash mid-run still knows which session to resume.
- Only actionable messages (my call); everything else lives in `status` and Grafana.
- A GitHub App, not my account (my call): short-lived per-repo tokens, its actions separable from mine, and I can review its PRs.
- Stay awake through CI and deploy waits, not through waits on me or on limits: those can take days.
- Supersedes [runner.md](runner.md) and [scheduler.md](scheduler.md); their behaviour that stays is restated here.
- `approval` is three stages (`approval:spec`, `approval:merge`, `approval:release`) so the one table, not a lookup on the reason, says what `feedback` or `release` does there. Revert missions and rehearsals get their own stages for the same reason; a revert keeps the mission row (`kind` follows the stage), so an intent still has one unfinished mission.
- Caps, gates and "the continue was used" live in handlers, which return `blocked` with a `Waiting`; the table stays per (stage, event). Events a stage never produces are `Unexpected`, counted like a crash: a bug ends at `crashed at <stage>`, not in a silent loop.
- PR events are level-triggered (re-read every 60 s) instead of queued: nothing to persist, and one not raised while a child runs comes back. A revert in flight ignores `retry_fresh` and `intent_removed`: half a revert is worse than either.
- Entry effects run after the transaction, not inside it: intent writes are git pushes that can't join a SQLite transaction; `step = 'enter'` re-runs them (idempotently) after a crash, and intent events wait for them.
- Unclean exits count only missions that were `busy`: a crash elsewhere in the loop doesn't strand every mission in CI at `crashed at ci`.
- Picks stay off until every stage has a handler (`Handlers::production()`): a loop built before the pipeline polls and answers commands but never marks an intent done without work.
- `[repos.<r>].path` is Towercab's own clone (the key existed; it works like `[intents].path`): point it at a dedicated directory, not my working checkout.
- `down` disables as well as stops (symmetric with `up`); `KillMode=mixed` so only the loop gets SIGTERM and kills its children's groups itself, recording `interrupted`.
- One `commands` path for the CLI and Telegram; with no loop running the CLI applies its own row, so `approve` never waits for a `run` that isn't coming.
- Outbox `n` for pick-time waits is the condition (repo, `after` ids): a re-detection after a crash, or my continue without a fix, sends nothing new. A queued waiting message whose wait is over is dropped: stale asks aren't actionable.
- Telegram and OTLP never open a fault: a dead chat can't carry its own alarm, and metrics never block (MET-13).
- `[agent].model` defaults to `opus` (the worker writes code; the review steps up from it, PIP-4); `[telegram].api_base` keeps the Python name; `[github].api_base` exists for the tests' fake server.
- `fix repo files` added to the waits: REPO-1's `Invalid` needs one (repo.md Decisions), and a typo there must stop the intent, not default.
- Crates: `rusqlite` (`bundled`), `ureq` (blocking HTTP, rustls), `rsa` + `sha2` + `base64` (RS256 JWT, pure Rust), `chrono-tz` (zones in limit texts), `uuid` (v4), `libc` (`killpg`), `signal-hook` (SIGTERM flag); dev `rand` for a test key generated at test time. No async.
