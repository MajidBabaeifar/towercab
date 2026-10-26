# Loop

**Status:** Live: LOOP-1..21 · **Prefix:** LOOP

## Purpose

Towercab as one Rust program that never stops: code owns the state machine, every wait,
poll and recovery; Claude Code (`claude -p`) runs only for steps that need judgment
([pipeline.md](pipeline.md)).

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| LOOP-1 | Binary `towercab` (Rust, `cargo install --path . --locked` → `~/.cargo/bin/towercab`). Home (`Home::resolve`: `--home` > `TOWERCAB_HOME` > `~/.local/share/towercab`; created 0700; **Home**): SQLite `towercab.db` (`db::open`: WAL, **Schema**: missions, transitions, cooldowns, outbox, commands, repo_caps, faults, drafts, meta, findings, breaches, episodes, triage, lessons), `towercab.lock`, checkouts `work/`, run files `runs/<id>/` (`build.txt`, `ci-<n>.log`, `verify-<n>.log`, `e2e-<n>.log`, …). Config `~/.config/towercab/config.toml` (`--config`, `TOWERCAB_CONFIG`; **Config**): `[intents]` remote, path, cutoff (7); `[agent]` model (`opus`), parallel (1), drafter (`sonnet`), build_timeout (60 min), review_timeout (15 min), check_timeout (10 min), max_budget_usd (5), ci_poll (30 s), ci_grace (120 s), ci_wait (1800 s), path (the loop's `PATH`), toolchain (`~/.cargo`, `~/.rustup`, `~/.local/bin`), sandbox_unix_sockets (false, [PIP-24](pipeline.md)); `[repos.<name>]` github (`owner/name`), path (Towercab's own clone, LOOP-8), base, workers (1), bash (extra worker Bash patterns, [PIP-24](pipeline.md)); `[github]` app_id, me, api_base; `[telegram]` bot_token, chat_id, api_base; `[metrics]` endpoint, prometheus (`http://localhost:9090`, [MNT-1](maintain.md)); `[policies]` github (`owner/agent-instructions`), base (`main`); `[ui]` port (7311, 0 = off; [UI-1](ui.md)). Unknown keys ignored (the Python version on branch `python` shared the file). A wrong type or range → exit 1 `config: <file>: <section>.<key> …` for every command; `run`, `step`, `up` and `doctor` also need `[github]` app_id and me and every `[repos]` table valid (`Config::check_loop`). The Python package leaves `main` at the pipeline intent's switch-over ([pipeline.md](pipeline.md) **Switch-over**); from then `run` drives the pipeline (`Handlers::production()`, picks on). | test_config_loads, test_bad_config, test_home_layout, test_schema_matches_spec, test_production_handlers_built, test_python_package_gone |
| LOOP-2 | **Service** (`src/service.rs`): `towercab up` refuses without `~/.cargo/bin/towercab` (`~/.cargo/bin/towercab is missing: cargo install --path . --locked`), writes `$XDG_CONFIG_HOME/systemd/user/towercab.service` (default `~/.config/systemd/user/`; text embedded as `service::UNIT`, **Unit**: `ExecStart=%h/.cargo/bin/towercab run --watch`, `Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, `Restart=always`, `RestartSec=30`, `WantedBy=graphical-session.target`), runs `systemctl --user daemon-reload` and `systemctl --user enable --now towercab.service`; `down` = `systemctl --user disable --now towercab.service` (SIGTERM, LOOP-7; missions stay); `logs` execs `journalctl --user -u towercab -f`. `systemctl` non-zero → exit 1 with its stderr. | test_unit_file, test_up_down_logs, manual (reboot, log in, `towercab status`) |
| LOOP-3 | **State machine** (`src/machine.rs`, **Machine**): `enum Stage` = the order `pick → design → plan → build → verify → proof → publish → ci → verifier → review → gate → merge → deploy → e2e → release → done`, revert missions ([PIP-19](pipeline.md)) `rollback → revert → revert_ci → revert_merge → revert_deploy → revert_e2e → done`, rehearsals ([PIP-35](pipeline.md)) `rehearse → rehearse_ci → rehearse_close → done`, plus `approval:spec`, `approval:merge`, `approval:release` (waiting on my yes: `approve spec`, `review and merge PR`, `authorize release`), `blocked` (any other `waiting`), `stopped`. `enum Event` (`ok`, `red`, `timeout`, `limit`, `blocked`, `bad_result`, `env_fail`, `crash`, `interrupted`, `pr_merged`, `pr_closed`, `feedback`, `conflict`, `head_moved`, `intent_removed`, `intent_continued`, `retry_fresh`, `approve`, `release`, `pause`, `resume`) and one transition table `machine::next(Stage, Event) -> Next`, a `match` without a catch-all arm (**Transitions**); `done` and `stopped` ignore every event. Every repair (verify, proof, CI, feedback, conflict) resumes the worker in `build` and re-enters the order at `verify`. Handlers (**Handlers**) do a stage's work and return an `Outcome`; only `machine::apply` moves a mission. A test fails if any stage × event pair differs from **Transitions**. | test_every_transition_defined, test_stage_order, test_continue_to, test_bad_outcome_counted |
| LOOP-4 | **Concurrency:** at most `[agent].parallel` (default 1) active children with `ChildSpec.slot` (a Claude run, setup, checks, e2e, a verifier app; not the git and gh calls, which run inline, nor the inhibitor) at a time, each for a different intent in its own checkout; any number of missions waiting (ci, approval, deploy, limit). At most `workers` unfinished missions per repo, all kinds (`blocked` doesn't count, `approval:*` does). An intent has at most one unfinished mission (unique index `missions_one_per_intent`). A free slot goes first to unfinished missions (their intents' PRI-4 order; every slot child queues, so a later step or a finish chaining a child never overtakes one waiting), then to the picker, so a PR waiting on me never stops other repos. | test_pick_while_others_wait, test_repo_slot, test_one_mission_per_intent |
| LOOP-5 | **Pick** (`pick::decide(&Listing, &PickState) -> Decision`, pure, also behind `next`): [PRI-4](priority.md) order over `priority::pick_order` (accepted intents on `main`, no `stage`, no `waiting`, `after:` all done, [PRI-5](priority.md)): only intents at or above the cutoff; parked ones are listed, never picked (`Skip::Parked`, nothing written). Skipped (`Skip`): parked, picks off (paused, `env_blocked`, a stage handler not built), repo frozen, repo full (`workers`), model cooling down (LOOP-9). Written without a mission (outbox key `intent:<id>`, `n` = the repo, or the sorted bad `after` ids): repo not in `[repos]` → `waiting: unknown repo`; a queued intent with an `after:` id that is unknown (not open, done or legacy), dropped, or on a cycle of open intents → `waiting: bad after:`. Picked → one transaction inserts the mission: `stage` `pick`, `attempt` = the intent's last + 1, `session` = a new uuid v4, `model` = the intent's `model` else `[agent].model`, `a_at_pick` = `a`, `checkout` `work/<id>-<attempt>`, `branch` `towercab/<id>-<slug>` (attempt ≥ 2: `…-<attempt>`). The `pick` step (`pick::Pick`, built here) fetches Towercab's clone (LOOP-8), loads the repo files ([REPO-1](repo.md): `NoVerifyingBlock` → `waiting: add CLAUDE.md verifying block`, `Invalid` → `waiting: fix repo files` with the error as why, `Git`: network or auth (`env::classify`) → `env_fail`, else `Unexpected`; the same for the clone's fetch: a `path` that isn't a clone is no outage), makes the checkout (LOOP-8) → `design` ([PIP-25](pipeline.md)). Missing `u`/`i` count as 3; `a` is never filled in at pick; only a worker's `lower_a` can add one, ≤ 3 ([AUT-7](autonomy.md)). On start and after each `intents` pull, an intent with a `stage` other than `done`/`dropped`, no `waiting` and no unfinished mission loses its `stage` (accepted again; commit `towercab: unstage <id>`); `retry: fresh` on an intent is removed and raises `retry_fresh` (no unfinished mission: unstaged). | test_pick_order, test_parked_waits, test_bad_after, test_unknown_repo, test_orphan_staged_intent, test_pick_skips, test_pick_step_repo_files |
| LOOP-6 | **Durable steps:** `machine::apply` writes a transition in one SQLite transaction: the mission's `stage`, `step = 'enter'`, `Outcome::set` columns, counters, `waiting`, `why`, a `transitions` row and its outbox rows (LOOP-14). The loop then does the entry effects (**Machine**; idempotent) and sets `step = ''`. Before any other side effect (Claude run, push, PR, merge, revert, intent write, message) a handler calls `Ctx::record(m, step, set)`: one transaction storing the step and the ids it will use (session uuid, branch, head, revert branch). Every step is idempotent; re-entering it first checks: `gh pr list --head <branch> --state open --json number,headRefOid` (counts only if `headRefOid` = `missions.head`), PR `mergedAt`/`mergeCommit`, rerun done (`gh api repos/<r>/actions/runs/<run> --jq .run_attempt` > 1), revert branch; a checkout without a valid `HEAD` (`git rev-parse --verify HEAD` fails) is re-cloned. | test_crash_at_every_step (stub handlers, a spec approval on the way; the `Loop` crashed (`Probe::crash_after(k)`) after its k-th durable write (`record`, transition, entry effect, pick, intent write) for every k, reopened on the same home: reaches `done` with each intent write, outbox row and checkout made once) |
| LOOP-7 | **Crash or restart:** `meta.running` = `<pid> <unix s>` from start until a clean exit; present at start → the last exit was unclean: leftover children are killed (process group `child_pid`, and each child a transition left running until the loop reaped it, `meta.dying`; when `/proc/<pid>/stat` start time = `child_start`), then each mission with `busy = 1` (inside a handler call or with a child) gets `unclean + 1` and its killed child's run time up to `meta.last_pass` in `step_secs`, committed before re-entry; `unclean` ≥ 3 → `waiting: crashed at <stage>`; `unclean` resets on a new step or stage. A caught handler panic counts the same. On start every unfinished mission re-enters its recorded step. A cut-off Claude run resumes its session: Towercab picks the uuid at pick (LOOP-5) and stores it; the `record` before a session's first run sets `session_used = 1`, that run gets `--session-id <uuid>`, every later one `--resume <uuid>` from the same checkout, after a cut-off with the prompt `Continue where you stopped.`; never `--session-id` twice. Session gone (`No conversation found with session ID`) → a new uuid with `--session-id` and a prompt naming branch, PR, `intent.md`, spec IDs and `plan.md` (`Ctx::session(m, step)` → `Session::{New, Resume}`, `Ctx::new_session`, `claude::{CONTINUE, session_gone, fresh_context}`; the worker handlers choose the prompt: `CONTINUE` when re-entered at their recorded run step). SIGTERM or SIGINT (`down`, logout, shutdown, Ctrl-C), acted on between steps: SIGTERM to each child's process group, SIGKILL after 10 s, `interrupted` for its mission (not counted; its run time added to `step_secs`), `meta.running` removed, exit 0. | test_resume_after_kill, test_unresumable_session, test_sigterm_not_counted, test_crash_loop_capped, test_dying_child_killed_after_crash, test_step_interrupted |
| LOOP-8 | Towercab's own clone of a repo = `[repos.<r>].path` (`git clone --quiet -- https://github.com/<github>.git <path>` when missing; only fetched into and pushed from, its working tree never touched). Checkouts `work/<id>-<attempt>` (`checkout::create`, made in `<checkout>.tmp` and renamed into place: a crash leaves no half-made one): `git clone --quiet --no-checkout -- <clone> <checkout>`, `git remote remove origin`, `git fetch --quiet <clone> +refs/remotes/origin/<base>:refs/remotes/origin/<base>` (by path, never a remote; also how base is refreshed), `git checkout --quiet -B <branch> refs/remotes/origin/<base>`: no git remote (Towercab pushes from its clone, fetching the checkout's commits by path). Every git call in a clone or checkout (`checkout::git`) has `-c core.hooksPath=/dev/null -c core.fsmonitor=false`; a checkout's `.git` is read-only to every run (PIP-23's sandbox, PIP-24's `denyWrite`), and Towercab's own git there (commit, merge, revert, checkout, diff) first runs `checkout::sane`: `.git` a directory without `commondir`, its config only `core.{repositoryformatversion, filemode, bare, logallrefupdates, ignorecase, precomposeunicode, symlinks}`, `extensions.{objectformat, refstorage}`, `remote.<n>.{url, fetch}`, `branch.<n>.{remote, merge}` (listed by `git config --file … --no-includes --list --name-only`), else refused; diffs `--no-ext-diff --no-textconv`: nothing a run writes into `.git` runs as Towercab. A mission keeps its checkout and session until it is done, stopped or replaced by `retry --fresh` (entry effect: checkout deleted). | test_checkout_kept, test_checkout_has_no_remote, test_checkout_recloned, test_planted_git_config_refused |
| LOOP-9 | **Usage limits** (`src/limits.rs`, **Limits**): a `claude -p` run with `is_error` or a non-zero exit whose result or stderr matches `limits::detect` (`limits::of_run`; its handler returns `Outcome::limit`) → reset time from `limits::parse_reset(text, now)` (epoch, retry-after, "in N unit", clock time with optional IANA zone, date + time, RFC 3339); none, or one already past → backoff 1, 2, 4, … 60 min (`cooldowns.backoffs`). Cooldown row keyed (provider `claude`, model = the run's `--model`), `until` = reset + 30 s, `since` = when it began (kept while it runs; `limits::cool`, also the drafter's); the mission stays in its stage, step kept (`limit_model`), until `until`, then re-enters the step: `--resume <uuid>` with `Continue where you stopped.` A limit wait is never a recovery (LOOP-7), a repair (PIP-3, PIP-23) or a timeout continue (PIP-1); timeouts count only the children's run time (`step_secs`, monotonic). Intents on other models keep going (picks skip a cooling model, LOOP-5); any wait length (weekly) just waits; the first success on a model (a child with that `ChildSpec.model` whose `finish` returns an outcome other than a limit or `env_fail`; a bug or panic in `finish` leaves them) resets its `backoffs`. The writer never waits ([PIP-15](pipeline.md)). | test_limit_formats, test_limit_resumes_same_step, test_other_model_runs, test_limit_never_counts_as_crash, test_past_reset_backs_off |
| LOOP-10 | **Network and auth** (`src/env.rs`): a failed git, gh, GitHub API, Telegram, OTLP or `claude` call (`env::classify(stderr)` = network: DNS, refused, reset, timeout, TLS errors (handshake, certificate problem, `SSL_*`; not a bare `TLS`/`SSL`), HTTP 5xx; auth: HTTP 401, `Bad credentials`, claude `/login`) retries with backoff 30 s, 60 s, 120 s, 240 s, 300 s (`missions.retries`, `retry_at`; a retried Claude run resumes per LOOP-7); the loop never exits on them. Towercab's own calls block, bounded (`child::output`: own process group, killed with it, stdout and stderr read as it runs): `gh` after 120 s (`GH_TIMEOUT`), `git` after 300 s (`GIT_TIMEOUT`; and `GIT_HTTP_LOW_SPEED_LIMIT=1000`, `GIT_HTTP_LOW_SPEED_TIME=60`); `timed out after <n> s` is network. **Faults** (`faults` row per kind: `github`, `claude`, `tool:<exe>`, `sandbox`, `secrets:<repo>`; Telegram and OTLP never open one) open on the first failure (`StepError::Env`/`Outcome::env` in `machine::apply`'s transaction; a child whose program can't start → `tool:<argv[0]>` (a missing `cwd`, `stdin` or run file: `Unexpected`); the loop's PR reads (`GhError::Env`) and `intents` polls → `github`) and close on the first success of that kind: a step's fault is held (`missions.fault`) until that step succeeds (any handler result but `env_fail`, a `Poll`, or a spawned child; for `claude` and `sandbox` the child's own result); a fault no mission holds is rechecked (`env::check`, the preflight's check of its kind) 5 min after its last failure and closes when that passes. A fault open for 15 min → `env_blocked` (`meta.env_episode` = its start, unix s, while open): no picks, `Ctx::timeouts` false (no wait timeout fires), one message per episode naming the fix (**Messages**, `env::episode`); a step's retry while blocked waits 5 min; the last fault closing ends it. Preflight on the unit's PATH (`env::preflight`, the first pass): with the App identity a GitHub App token per `https://github.com/` URL ([LOOP-19](loop.md); ssh and path remotes keep my setup), `git ls-remote <url> HEAD` per repo (its clone's `origin`, else `https://github.com/<github>.git`) and `[intents].remote` (`github`; the first failure ends them), `claude --version` (`claude`), `cargo --version`, `bwrap --version` (`sandbox`), `systemd-inhibit --version`; a missing program → `tool:<name>`; each check killed after 20 s; a failure opens its fault, a passed kind no mission holds closes. | test_classify, test_network_blip_keeps_looping, test_env_blocked_once, test_preflight, test_hanging_call_times_out |
| LOOP-11 | **Stay awake** (`src/awake.rs`) while any mission is driven: a stage of the order, revert or rehearsal sequence (not `approval:*`, `blocked`, `done`, `stopped`), not held (waits for my `resume`) and not in a limit wait: one child `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=Towercab --why=<id> <stage> --mode=block sleep infinity` (`--why` from the first driven mission in PRI-4 order when started; not restarted on stage changes; not a slot; own process group, `PR_SET_PDEATHSIG` SIGKILL so it dies with the loop; failed to start or exited → logged, retried after 60 s), its group killed when none is driven and at shutdown. Woke (`awake::woke(last, now, pass)`): the wall clock ran ahead of the monotonic one (which stops in suspend) by more than 3 × pass since the last pass, or, at a loop's first pass, more than 3 × pass passed since `meta.last_pass` (written each pass); then every driven mission's poll, the PR reads and the `intents` poll are due at once, and each mission's next handler call gets `Ctx::timeouts` false, so no wait timeout fires before its poll (`PassReport.woke`). | test_inhibit_while_driving, test_wake_repolls_before_timeout |
| LOOP-12 | **Pass** (`Loop::pass(Tick)`) every 5 s, single-threaded, in this order: signals; wake check; Telegram updates → `commands`; apply `commands`; reap children (`try_wait`) → `Handler::finish` (the drafter's → `drafts::finish_run`, [INT-7](intents.md)); entry effects due (LOOP-6); child timeouts; due polls (`intents`, PRs, issues, repeated findings and draft PRs, then `maintain::settle`: `PassReport.drafts`, then the evals' poll, [PIP-33, 36](pipeline.md), [MNT-5, 8](maintain.md)); bands (`maintain::Watch::round`, [MNT-3](maintain.md)); step due missions; pick; the drafter (a slot child, one at a time); faults and preflight; review due; outbox; inhibitor; gauges (`PassReport.gauges`, [MET-20](metrics.md)); then the pass's metrics flushed, also when a step failed ([MET-13](metrics.md)). Children (`src/child.rs`): `process_group(0)`, env cleared then set, stdin from a file or `/dev/null`, stdout and stderr to files in `runs/<id>/`; a timeout (`ChildSpec.timeout` less the step's `step_secs`: run time, monotonic) sends SIGTERM to the group, SIGKILL after 10 s; `finish` gets `ChildEnd.timed_out`. A new step (`Ctx::record`) resets `step_secs`. Cadence: Telegram every pass; CI `ci_poll` (30 s) and deploy 30 s (the handler's `Progress::Poll { after }`); PR reads 60 s (kind `intent`, `missions.pr` set, `merge_sha` not, PIP-21); issues and draft intent PRs 300 s ([INT-7](intents.md); not with `run --intent`); bands 300 s (not with `run --intent`; Prometheus on a helper thread); gauges 60 s; `intents` pulled only when `git ls-remote origin refs/heads/main` differs from the checkout's `origin/main`, at most every 60 s ([INT-10](intents.md)). Every wait timeout re-checks its condition once before firing. | test_polls_while_child_runs, test_cadence, test_timeout_kills_group |
| LOOP-13 | `towercab status` and Telegram `status` (`status::render(&Snapshot) -> String`, **Status**): active children (intent, stage, the Claude run's model, since; missions' only, not the drafter), waiting on me (each with its action: a Towercab wait's message line 1), waiting on CI or deploy, cooling models with reset time (local, with offset), paused, `env_blocked`, repos capped at a3 or frozen, failed drafts, alert dismissals per band ([MNT-7](maintain.md)), next intent, review due ([PRI-8](priority.md), `priority::review_due`). Reads SQLite and the store (the CLI pulls; a failed pull → the checkout as it is and `intents: <error>`); works without a running loop. | test_status |
| LOOP-14 | **Messages only when I must act** (`src/outbox.rs`, **Messages**). Every `waiting:` Towercab writes is a `machine::Waiting` (approve spec, approve plan, review and merge PR, authorize release, answer the question, CI red, checks red, tests don't prove the change, no CI checks appeared, CI stuck, worker timeout, worker budget, no result, no changes, crashed at <stage>, bad after:, unknown repo, PR state unknown, merge failed, never published, add CLAUDE.md verifying block, fix repo files, protected path changed, reverted, refine, e2e red after your merge, deploy not seen, revert failed, release failed, production e2e red, PR closed), written only by `machine::apply` and `pick`; each but `PR closed` sends one. Also: repo frozen; env blocked; review due ([PRI-8](priority.md), at most once per 30 days: the last `review_due` row); `rollback rehearsal failed: <repo>` ([PIP-35](pipeline.md)); `triage: <band> at 3σ` ([MNT-6](maintain.md)); `evals dropped <n> points: <change>` ([PIP-33](pipeline.md)). Never on: done, merges, limits, a PR I closed, my own edits. Each message is an `outbox` row keyed (mission, event, n), `INSERT OR IGNORE` in the transition's transaction (`n` = `missions.continued`, + 1 on every transition out of a wait, so each new wait is a new message; or the PR head for `review and merge PR`); text = line 1 (the action), `<id> <repo>: <title>`, why, `PR <url>`, `intent <url>`. A waiting row whose wait is over when due is dropped (`sent_at = 0`, `outbox::obsolete`): its mission no longer waits for that reason with that `n`; an intent-level one (`intent:<id>`): the intent isn't open, has an unfinished mission or another `waiting` (none yet: its write follows the row). A test fails if a `Waiting` has no template. | test_only_actionable, test_every_waiting_has_template, test_templates, test_obsolete_message_dropped, test_wait_again_sends_again |
| LOOP-15 | **Commands** (`src/cli.rs`; T = also from Telegram, **Telegram**): `up`, `down`, `logs` (LOOP-2); `run [--watch] [--intent ID]` (the pass loop; without `--watch` it exits 0 once nothing is runnable and no mission is driven but by a limit wait; `--watch` exits only on SIGTERM or SIGINT; `--intent` steps only that intent's mission, picking it first regardless of order and cutoff, not of skips (one → exit 1 `<id>: not picked: <reason>`, `<id>` resolved; picks off stop only a pick, not its unfinished mission), and exits once it is `done`, `stopped`, `approval:*` or `blocked`, printing `<id>: <stage>[ · <waiting>]`); `status` T; `next` T (**Next**: the intent LOOP-5 would pick and why: priority, order, each skipped intent with its reason); `add "<repo>: <title>" [uN iN aN]` (writes a thin `intent.md` to `main`, [INT-2](intents.md)); `approve <id>` T (same as removing `waiting` by hand, [PIP-17](pipeline.md): a mission in `approval:*` or `blocked` gets `approve`, its entry effect removes `waiting`; an intent-level wait (no unfinished mission) is removed through the store; else `<id> isn't waiting on you`); `retry --fresh <id>` T (`retry_fresh` on its unfinished mission, a revert's ignored (`<id> is reverting`); none → its `waiting`, `stage` and `retry` removed, so the picker takes it as attempt n+1; done or dropped → refused, `<id> is done\|dropped`); `release <id>` T ([PIP-34](pipeline.md); not in `approval:release` → `<id> isn't waiting for release`); `pause` / `resume` T (`meta.paused`; pause: no picks; a mission entering `merge`, `revert_merge` or `rollback` holds (`held = 1`); the active child and all waits go on; resume raises `resume` for every held mission); `step <id>` (`Loop::step_intent`: one handler call of the intent's unfinished mission in the foreground, each child it spawns waited for and `finish`ed, then its entry effects; prints `<id>: <stage> → <stage>[ · <waiting>]`; none → picked as `--intent` does, then that step; a stage without its handler → exit 1 `<id>: <stage> handler not built`; it doesn't wait: entry effects that failed → exit 1 with their error, a cooling model → `<id>: <model> cooling until <time>`, a backoff → `<id>: retry at <time>`; SIGTERM or SIGINT while its child runs → stopped as at shutdown (`interrupted`, not counted), exit 1 `<id>: interrupted`); `protect <repo>` ([REPO-7](repo.md)); `trust <repo>` ([AUT-10](autonomy.md): deletes its `repo_caps` row; the gate logic is the autonomy intent's); `review` ([PRI-7](priority.md); like `add`, writes through the intent store, not a `commands` row); `telemetry on\|off\|status` ([MET-12](metrics.md): my own sessions' Claude Code telemetry); `eval [--reason <change>] \| --pr <n> \| --cases <dir> --out <file>` ([PIP-33](pipeline.md)); `hook guard` (internal, [PIP-29](pipeline.md); exit 2 blocks the tool); `ui [--no-open]` (the web page, [UI-2](ui.md)); `migrate` ([INT-13](intents.md)); `doctor` (**Doctor**; warns per `[repos]` repo without a `towercab` ruleset, `repo::protect::find_ruleset`, [REPO-7](repo.md)); `--version`. One loop per home: `flock` on `<home>/towercab.lock` (content `<pid>`); `run`/`step` while held → exit 1, `towercab is running (pid N); towercab down first`. `approve`, `retry --fresh`, `release`, `pause`, `resume`, `trust` (and their Telegram forms) insert a `commands` row the loop applies at the next pass (`commands::apply`, reply in `commands.result`); the CLI applies it itself when the lock is free (then the entry effects it made due), else waits up to 10 s for `result` and prints it, then `queued: applied on the loop's next pass`. A command's own intent write (an intent-level `approve`, `retry --fresh` without a mission) ends with the trailer `Towercab-Command: <row id> <created>`: re-applied after a crash before its `applied_at`, it answers as the first time. IDs: any unique suffix ([INT-3](intents.md)). | test_cli, test_telegram_commands, test_second_run_refused, test_commands_row_applied, test_next, test_doctor, test_step_refuses_waits, test_command_reapplied_after_crash |
| LOOP-16 | **Telegram transport** (`src/telegram.rs`): Bot API `POST <api_base>/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview: true}` (text ≤ 4000 chars) / `getUpdates` `{offset, timeout: 0, allowed_updates: ["message"]}` (`offset` = last `update_id` + 1, `meta.tg_offset`; none yet (first start): messages older than 10 min (`message.date`) are skipped, neither applied nor answered; each update in one transaction with its offset: a command → a `commands` row (`update_id`) applied at once, its reply an outbox row `loop`, `reply`, update_id; `status`, `next`, `help`, anything else → that reply), 10 s timeout (`src/http.rs`), success = HTTP 200 and `ok: true`. Unsent `outbox` rows go oldest first, stopping at the first failure, and retry with LOOP-10 backoff (`tries`, `next_try`) until `ok: true`, then `sent_at` is set; only a crash between the two can repeat one. Messages from a chat other than `chat_id`, or without `text`, ignored; leading `/` and `@<bot>` accepted; unknown command → one-line help. Failures log once per outage to stderr without the token (`<token>`), never raise. No `[telegram]` → rows are written, nothing is sent or read. | test_outbox_retries_until_sent, test_outbox_survives_restart, test_other_chat_ignored, test_failures_never_raise |
| LOOP-17 | Nothing runnable and nothing driven: idle; passes go on (Telegram, `intents` ls-remote, PR reads); with `--watch` no exit, no message. | test_idle |
| LOOP-18 | **PR and intent events in every stage**, not only `approval` (`src/events.rs`): while `missions.pr` is set and `merge_sha` isn't (kind `intent`, from the design's draft PR on, `blocked` included), each PR read (`PrSource::read`, PIP-21; not while `merge` has a recorded step: its re-entry checks `mergedAt`, so a crash after my merge isn't a human one) gives at most one event, `events::pr_events(&Mission, &PrState, me)`: `pr_merged` (→ `deploy`, `merged_by = human`) > `pr_closed` (→ `stopped`, `waiting: PR closed`, no message) > `feedback` (my comments and reviews with text) > `conflict` > `head_moved`; one that would send a mission to its own stage (`feedback` at build, `head_moved` at ci) isn't raised: it comes back at the next stage. They are level-triggered (re-derived from the PR against `head` and `feedback_seen`), so `feedback`, `conflict` and `head_moved` are not raised while a child runs and come back at the next read after it ends. On each `intents` poll (every 60 s, pulled when `main` moved, LOOP-12) `events::intent_events(&Mission, &Listing)`: intent file gone (an unreadable one isn't) → `intent_removed` (→ `stopped`, PR left alone); `retry: fresh` → `retry_fresh` (LOOP-5); mission in `approval:*`/`blocked` and `waiting` removed by me → `intent_continued` (PIP-17); not derived while `step = 'enter'`. A transition out of a stage kills that stage's child (`pr_closed`, `pr_merged`, `intent_removed`). No merge while feedback is unhandled: the merge step reads the PR first (PIP-22). | test_events_in_every_stage, test_closed_during_ci, test_my_merge_during_ci, test_pr_and_intent_event_derivation, test_pr_reads_skipped |
| LOOP-19 | **Identity** (playbook: the agent acts under its own identity; `src/github.rs`): Towercab acts on GitHub as the GitHub App `towercab`, registered by me from `ops/github-app.json` (manifest; permissions: contents, pull requests, issues, checks, commit statuses (`statuses`), workflows: write; actions: write (reruns, `gh workflow run`); deployments, metadata: read) and installed on `intents`, `[policies].github` and each repo in `[repos]`. Private key `app.pem` next to the config file (`~/.config/towercab/app.pem`, `Config::app_key`; PKCS#1 or PKCS#8 PEM; readable by group or others → refused; missing or refused → every GitHub call fails `Env`: a `github` fault, LOOP-10); `[github]` app_id, me; no app_id → `Identity::none` (my login; only in tests, the loop's commands refuse it). RS256 JWT (`iat` = now − 60 s, `exp` = now + 540 s, `iss` = app_id) → `GET <api_base>/repos/<o>/<n>/installation` → `POST /app/installations/<id>/access_tokens` `{repositories: [<n>]}`: a 1-hour token per repo, cached in memory (installation ids too: one GitHub then refuses, e.g. after a reinstall, is looked up again once), re-minted when < 10 min remain; 404 → `the GitHub App isn't installed on <o>/<n>`; network, 401, 5xx → `Env`. Passed as `GH_TOKEN` to its own `gh` calls (PR reads, issues, drafts) and to `git` for a `https://github.com/<o>/<n>` remote (`github_of`; the intents store, Towercab's clones, the drafts clone, the preflight's `ls-remote`; ssh and path remotes keep my setup, `doctor` warns) via `-c credential.helper= -c credential.helper=!'<gh>' auth git-credential` (git ignores `GH_TOKEN`), never to Claude runs. Commits are authored and committed as `towercab[bot] <<bot id>+towercab[bot]@users.noreply.github.com>` (`GET /app` → slug, `GET /users/<slug>[bot]` → id, cached in `meta.bot`); PRs, comments and merges show as `towercab[bot]`. The loop's `intents` writes use the same token and identity (`intents::git::GitAuth`). My own `gh` login is used only by commands I run (`protect`, `doctor`'s ruleset check). | test_installation_token_per_repo, test_git_uses_app_token, test_commit_author_is_bot, test_token_never_in_claude_env, test_app_manifest, manual (PR shows towercab[bot]) |
| LOOP-20 | **gh ≥ 2.46** (Ubuntu 26.04's): every `gh` call uses only subcommands and flags gh 2.46.0 has (not `api --slurp`, `pr checks --json`, `pr update-branch`, `run view --json attempt`); the tests' fake `gh` refuses any other, as gh 2.46 does (`tests/common/gh246.rs`). `doctor` prints `gh version: <v>`, below 2.46 with `: Towercab needs 2.46 or newer`. | test_doctor, test_pr_read_on_gh_246 |
| LOOP-21 | **Log lines** (`src/log.rs`, `tlog!`): every line the loop writes to stderr (the journal, `towercab logs`) is one line: the message's first line that says something (blank lines and gh's `Usage:`/`Flags:` skipped), control characters as spaces, at most 300 characters, `(+<n> lines)` when it had more; such a message also goes whole, after `--- <local time>`, to `<home>/towercab.log` (moved to `towercab.log.1` past 5 MiB), and the line ends `· full: <path>`. A warning repeating every pass is logged once until it changes (`Loop::warn`). Every move to another stage is one line, `towercab: <mission> <from> → <to> (<event>[: <why>])` (`machine::move_line`, after its transaction). | test_log_one_line, test_log_full_text_in_file, test_move_logged |
| LOOP-22 | **`answer <id> <text>`** (CLI, Telegram T, UI [UI-21](ui.md); a `commands` row `name = answer`, `arg` = the id, `text` = the answer, ≤ 2000 chars, else `answer is empty\|too long (max 2000)`; migration 4 recreates `commands` with `'answer'` in the name CHECK and a `text TEXT NOT NULL DEFAULT ''` column, the Schema above plus these). Applied by the loop (LOOP-15) in one transaction with the intent write: the mission must be `blocked` with `waiting: answer the question` (any other blocked wait is not a question: `<id> isn't waiting for an answer`; none → `<id> isn't waiting`) → the answer is added to the intent (INT-14, `Store::update_marked`, mark `Towercab-Command: <row id> <created>` as LOOP-15), then `approve` is raised, so the worker resumes with it ([PIP-37](pipeline.md)); a repeat of the same row after a crash adds it once. `towercab answer` without a loop applies it itself when the lock is free, as `approve`. Telegram: `answer <id> <text>` (text = the rest of the message). The `answer the question` message's line 1 becomes `answer the question: answer <id> <text>` ([LOOP-14](loop.md) templates). | test_answer_command, test_answer_wrong_wait, test_answer_reapplied_after_crash, test_telegram_answer, test_answer_migration |

**Home** (`<home>`, LOOP-1)

```
towercab.db (+ -wal, -shm)   SQLite, **Schema**
towercab.lock                flock while a loop or step runs; content "<pid>\n"
towercab.log                 full text of multi-line log messages (LOOP-21; .1 past 5 MiB)
work/<id>-<attempt>/         mission checkouts (LOOP-8); rehearsals work/rehearse-<repo>-<yymmdd>/
runs/<id>/                   per intent, across attempts: build.txt, ci-<n>.log, verify-<n>.log, e2e-<n>.log,
                             CLAUDE.md (base copy, PIP-24), policies/ (PIP-27), settings-<kind>.json,
                             <kind>-<n>.prompt / .json (stdout) / .err (stderr);
                             rehearsals runs/rehearse-<repo>-<yymmdd>/, drafts runs/draft-<rowid>/
                             (issue.json, intent.md, pr.md, title, drafter-<try>.*)
drafts/                      clone of [intents].remote for draft intent branches (INT-8), never on main
metrics.jsonl                OTLP spool while the collector is down (MET-13)
```

**Config** (`src/config.rs`; `Config` gains `agent: AgentConfig`, `github: Option<GithubConfig>`, `telegram: Option<TelegramConfig>`, `metrics: MetricsConfig`, `policies: PoliciesConfig`, `ui: UiConfig`)

| Key | Type, range | Default |
|---|---|---|
| `agent.model`, `agent.drafter` | non-empty string without whitespace | `opus`, `sonnet` |
| `agent.parallel` | int 1–16 | 1 |
| `agent.build_timeout`, `review_timeout`, `check_timeout` | int minutes 1–1440 | 60, 15, 10 |
| `agent.max_budget_usd` | number > 0, ≤ 1000 | 5 |
| `agent.ci_poll`, `ci_grace`, `ci_wait` | int seconds 5–3600, 0–3600, 60–86400 | 30, 120, 1800 |
| `agent.path` | non-empty string (`PATH` of checks and Claude runs) | the loop's `PATH` |
| `agent.toolchain` | list of strings, `~/` expanded, absolute | `["~/.cargo/bin", "~/.rustup", "~/.local/bin"]` (read-only in sandboxes; never all of `~/.cargo`: its `credentials.toml`) |
| `github.app_id` | int ≥ 1 | — (`check_loop`: `github.app_id is required`) |
| `github.me` | GitHub login `[A-Za-z0-9-]+` | — (`check_loop`) |
| `github.api_base`, `telegram.api_base` | `http://` or `https://` URL, trailing `/` dropped | `https://api.github.com`, `https://api.telegram.org` |
| `telegram.bot_token` | non-empty string | — (section absent → no Telegram) |
| `telegram.chat_id` | string or int, kept as string | — |
| `metrics.endpoint`, `metrics.prometheus` | URL | `http://localhost:4318`, `http://localhost:9090` |
| `policies.github`, `policies.base` | `<owner>/<name>` (`is_github`), `is_branch` | none (no shared policies), `main` |
| `ui.port` | int 0–65535 (0 = off, [UI-1](ui.md)) | 7311 |

**Schema** (`src/db.rs`; `db::open`: `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`; `db::MIGRATIONS: &[&str]`, migration i takes `PRAGMA user_version` from i to i+1 in one transaction (a newer `user_version` → refused); later intents append; times are unix seconds `REAL`)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- running "<pid> <unix>", paused "1", tg_offset, env_episode "<unix>" (while env_blocked), bot "<slug> <user id>", last_pass "<unix>", dying "<pid>:<start> …", rehearse_checked "<unix>" (PIP-35), eval_baseline "<run>", eval_at "<unix>", eval_policies "<tree sha|none>", eval_model (PIP-33)

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
  child_model TEXT,                     -- a Claude child's --model (status)
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
  arg TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,  -- 'cli', 'telegram' or 'ui' (UI-6)
  update_id INTEGER,                                    -- a Telegram one's update: its reply's outbox n
  created REAL NOT NULL, applied_at REAL, result TEXT);

CREATE TABLE repo_caps (repo TEXT PRIMARY KEY, capped INTEGER NOT NULL DEFAULT 0,  -- cap 3 (AUT-10, MNT-6)
  frozen INTEGER NOT NULL DEFAULT 0, why TEXT NOT NULL, since REAL NOT NULL);

CREATE TABLE faults (kind TEXT PRIMARY KEY, since REAL NOT NULL, last REAL NOT NULL,
  error TEXT NOT NULL, next_try REAL NOT NULL);

CREATE TABLE drafts (key TEXT PRIMARY KEY,   -- 'issue:<url>', 'alert:<band>', 'review:<rule>'
  repo TEXT NOT NULL, source TEXT NOT NULL, intent TEXT, slug TEXT, pr INTEGER, pr_url TEXT,
  step TEXT NOT NULL,                        -- draft, drafted, push, pr, link, open, accepted, rejected, failed
  tries INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL);

-- migration 2 (the pipeline, PIP-36)
CREATE TABLE findings (repo TEXT NOT NULL, rule TEXT NOT NULL /* lowercased */, pr INTEGER NOT NULL,
  mission INTEGER NOT NULL REFERENCES missions(id), at REAL NOT NULL, PRIMARY KEY (repo, rule, pr));

-- migration 3 (maintain, MNT-3..8)
CREATE TABLE breaches (band TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('1sigma','2sigma','3sigma')),
  point REAL NOT NULL /* the newest point's time */, value REAL NOT NULL, mean REAL NOT NULL, sigma REAL NOT NULL,
  at REAL NOT NULL, step TEXT NOT NULL /* diagnose, comment, done */, PRIMARY KEY (band, tier, point));
CREATE TABLE episodes (band TEXT PRIMARY KEY, since REAL NOT NULL /* its first breach's point */,
  drafted INTEGER NOT NULL DEFAULT 0, proposed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE triage (band TEXT PRIMARY KEY, accepted INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE lessons (intent TEXT PRIMARY KEY, band TEXT NOT NULL, pr TEXT, fixed REAL NOT NULL,
  point REAL, value REAL, within INTEGER, step TEXT NOT NULL /* wait, write, written */);

-- migration 4 (LOOP-22): commands recreated with name IN (…, 'answer') and text TEXT NOT NULL DEFAULT ''
```

**Machine** (`src/machine.rs`)

- `Stage::ALL` (30), `as_str`/`FromStr` (the names above, `approval:spec` etc.), `kind()` (`revert` for rollback … revert_e2e, `rehearsal` for rehearse … rehearse_close, else `intent`), `driven()` (order, revert and rehearsal stages but `done`), `playbook() -> Option<intents::Stage>`: pick, design, approval:spec → `design`; plan, build → `build`; verify, proof, publish, ci, verifier → `test`; review, gate, merge, approval:merge, deploy, e2e, release, approval:release → `deploy`; revert stages → `maintain`; done → `done`; blocked, stopped, rehearsal stages → unchanged.
- `Next::{Go(Stage), Wait, Again, Cool, Backoff, Recover, Stop, Continue, Fresh, Ignore, Unexpected}`. `Wait` → the stage of `outcome.waiting` (`Waiting::stage`), `from_stage` = the stage left (kept when already waiting). `Again` → re-enter the step, nothing counted. `Cool` → cooldown upsert, `limit_model` set, step kept. `Backoff` → `retries + 1`, `retry_at` (LOOP-10). `Recover` → `unclean + 1`; ≥ 3 → `Wait` with `crashed at <stage>`; else `Again`. `Stop` → `stopped` (`waiting: PR closed` for `pr_closed`). `Continue` → `continue_to`, then `verify_repairs`, `ci_repairs`, `sync_rounds`, `unclean` = 0. Every transition out of a wait (`approval:*`, `blocked`: my continue, feedback, a conflict, a push) adds 1 to `continued` (outbox `n`). `Fresh` → this mission `stopped` (why `replaced by attempt <n>`) and a new one at `pick`, attempt + 1, in the same transaction. `Unexpected` → logged `unexpected <event> at <stage>`, then as `Recover`; also for what `apply` can't carry out (`blocked` without a mission's `Waiting`, `limit` without a `Limit`, a fresh attempt without an intent: why `bug: …`), a handler outcome whose event its stage ignores, `StepError::Bug`, and a child whose `cwd`, `stdin` or run files are missing.
- `continue_to(&Waiting, from: Stage) -> Next`: approve spec → `plan`; approve plan → `build` (its first round, [AUT-12](autonomy.md)); review and merge PR → `gate`; authorize release → `release`; e2e red after your merge, production e2e red → `done` (kept: merged, nothing rebuilt); deploy not seen, revert failed, add CLAUDE.md verifying block, fix repo files, release failed, CI stuck, no CI checks appeared → `Go(from)`; crashed at `<s>` → `Go(<s>)`; reverted, refine, PR closed → `Fresh`; any other → `build` (the worker resumes, PIP-17), from `design` or `plan` `Go(from)` (no build before its spec and plan), for a revert or rehearsal `Go(from)` (no worker).
- `apply` also, in its transaction: `revert failed` → `repo_caps.frozen = 1` + `repo frozen` message; `reverted, refine` → `repo_caps.capped = 1` ([AUT-10](autonomy.md)); `red` at rehearse or rehearse_ci → `rollback rehearsal failed` message.
- Entry effects (`step = 'enter'`, idempotent, in order; `machine::enter`, run by the loop for every `step = 'enter'` row, finished ones included): the left stage's child is killed by the loop at the transition (SIGTERM, SIGKILL 10 s later; after a crash, recovery kills it); intent (kinds `intent`, `revert`; skipped when the file is gone or already in `done/`, or the mission is finished and a newer one has its intent (`retry --fresh`)): one `Store::update(id, <stage>, …)` (commit `towercab: <stage> <id>`) setting `stage` (`playbook()`), `waiting` (approval, blocked, `PR closed`) or removing it, `pr` (= `pr_url`), at `pick` removing `retry`, at `done` also `cost`, `agent_time`, `attempts` (over the intent's missions); `done`/`stopped`: checkout (and its `-proof` overlay, PIP-30) and raw e2e output (`runs/<id>/*.raw`, PIP-9) deleted, `finished` set; `merge`, `revert_merge`, `rollback` while paused → `held = 1`; then `step = ''`. The intent commit (`Store::update_marked`) ends with the trailer `Towercab-Entry: <session> <transition id>`; a re-run that finds it in the last 200 commits (`Store::has_mark`) skips the write, so my edits since stay. A finished mission whose entry is due still owns its intent (no unstage). A failed entry (the store refused or unreachable) is logged and retried next pass.

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

A PR read of a merged PR in `approval:spec` raises `approve`, not `pr_merged` (my merge of the spec PR approves it, [PIP-21](pipeline.md)).

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
// the session's first run); new_session(&Mission) (session gone: new uuid, unused, step ''); run_session(&Mission, step)
// (PIP-13: review, triage, verifier: a new uuid per run, Resume when re-entered at step); checkout(&Mission); runs(&Mission);
// repo(&Mission). update(&Connection, id, cols) checks each column against mission::COLUMNS.
pub struct Probe;     // crash injection: point() after each durable write (record, apply, entry effect, pick, intent write);
                      // crash_after(Some(k)) panics with Crashed at the k-th, which the loop never catches (LOOP-6's test)
pub struct Handlers;  // stubs(): every driven stage → Stub (records step "stub", then Done(ok)); picks_off(): Pick + NotBuilt;
                      // production(): pipeline::handlers(Mode::Live), every stage built (picks on);
                      // set(Stage, Box<dyn Handler>); built() = every handler built(); get_mut(Stage)
```

**Messages** (`machine::Waiting`: `text()`, `parse(&str)`, `stage()`, `key()` = the text before any parameter, lowercased, each run of other characters → `_`; `outbox::render_waiting`)

| `waiting:` | Stage | Line 1 |
|---|---|---|
| `approve spec` | approval:spec | `approve spec: approve <id>` |
| `approve plan` | blocked | `approve plan: approve <id>` |
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
| triage | `loop`, `triage:<band>`, point time | `triage: <band> at 3σ` | `value <v> · mean <m> · σ <s>` (≤ 2 decimals); `PR <url>` |
| evals dropped | `loop`, `evals_dropped`, run | `evals dropped <n> points: <change>` | — |
| reply | `loop`, `reply`, update_id | the reply (≤ 4000 chars) | — |

**Limits** (`src/limits.rs`; `detect(text) -> bool`, `parse_reset(text, now: DateTime<FixedOffset>) -> Option<DateTime<Utc>>`, `of_run(model, failed, result, stderr, now) -> Option<Limit>` (failed and the result, else stderr, detected; text one line ≤ 300), `backoff(n) -> Duration` = min(2ⁿ⁻¹, 60) min; "local" = `now`'s offset)

- Detect (ASCII case-insensitive): `rate.?limit|usage.?limit|hit your limit|limit reached|limit will reset|quota|too many requests|\b429\b|overloaded|rate_limit_error|overloaded_error`.
- Reset, first rule that matches wins (within the clock rule, its first valid match): epoch `\|(\d{10})\b`; `retry[- ]after[\s:=]+(\d+)` seconds; `(?:try again|retry|resets?|available again) in <N>\s*<unit>(\s+<N>\s*<unit>)?` (too far to be a time: none) (units `s`, `sec(s)`, `second(s)`, `m`, `min(s)`, `minute(s)`, `h`, `hr(s)`, `hour(s)`, `d`, `day(s)`); RFC 3339 or `YYYY-MM-DD[T ]HH:MM[:SS][Z|±HH[:]MM]` (no zone → local); `resets? [at |on ]` + optional `<Mon>[a-z]*\.? <day>[st|nd|rd|th][,] [at ]` + `<h>[:<mm>] [am|pm]` + optional `(<IANA zone or UTC>)` (`chrono-tz`; unknown zone → local), needing am/pm, minutes or a date (a bare number is not a time), hour ≤ 23 (1–12 with am/pm); a clock time already past → tomorrow, a date already past (or invalid this year) → next year; a time a DST change skips → an hour later.
- Cases (`test_limit_formats`, now 2026-10-15 13:30 Europe/Berlin): `You've hit your limit · resets 3pm (Europe/Berlin)` → 15:00 that day; `limit reached ∙ resets 11am (Europe/Berlin)` → the 16th 11:00; `weekly limit · resets Oct 17, 9:30am (Europe/Berlin)` → the 17th 09:30; `Claude AI usage limit reached|1760540400` → that epoch; `429 rate limit retry-after: 120` → +120 s; `rate limited, try again in 5 minutes` → +300 s; `resets in 2h 30m` → +9000 s; `resets 15:00 (UTC)` → 15:00 UTC; `limit resets at 2026-10-16T09:00:00Z` → that time; `429 Too Many Requests`, `resets 3 things` → none; plus each rule's variants, zones, DST and the invalid times in the test.

**Telegram** (`telegram::parse(text) -> Result<TgCommand, String>`; the reply to any `Err` is `HELP`)

```
message  = ["/"] command ["@" bot] { " " arg }        command ASCII case-insensitive; runs of spaces = one
status | next | pause | resume | help | start          no argument
approve <id> | release <id>                            one id, any unique suffix (INT-3)
retry [--fresh] <id>                                   = retry --fresh <id>
HELP     = "commands: status · next · approve <id> · retry <id> · release <id> · pause · resume"
```

Replies (the CLI prints the same): `status`/`next` text; `approved <id>`, `fresh attempt <n> for <id>`, `releasing <id>`, `paused: no picks; merges and reverts hold`, `resumed`, `trusted <repo>`; errors `<command>: <reason>` (`approve: no open intent matches 99`, `approve: <id> isn't waiting on you`, `release: <id> isn't waiting for release`, `retry: <id> is reverting`, `retry: <id> is done`, `trust: unknown repo <r>`; the CLI exits 1 on them); `help`, `start` → `HELP`.

**Status** (`<time>` = `HH:MM` today, else `YYYY-MM-DD HH:MM`, local; values through `review::shown`; empty sections left out)

```
towercab <version> · running (pid <n>)|not running[ · paused][ · env blocked]
active: <id> <repo>: <title> · <stage> · <model|-> · since <time>         (one per mission child, `child_model`: a Claude run's --model; the drafter isn't listed; none → "active: none")
waiting on you:
- <id> <repo>: <title> · <action>[ · <pr url>]                          (missions, then intent-level waits; action = line 1)
waiting on CI or deploy:
- <id> <repo>: <title> · <stage> · since <time>                         (ci, deploy, revert_ci, revert_deploy, rehearse_ci)
cooling: <model> until <YYYY-MM-DD HH:MM ±HH:MM>                         (each model still cooling)
env blocked: <kind>: <error> · since <time>                              (each open fault, while env_blocked)
repos: <repo> capped at a3, <repo> frozen
drafts failed: <key>, …
alerts dismissed: <band> <n>, …                                         (triage.dismissed > 0, MNT-7)
intents: <error>                                                       (the store couldn't be read)
next: <id> <repo>: <title>|next: nothing runnable
review due: towercab review
```

**Next** (`next` and Telegram `next`)

```
next: <id> <repo>: <title> · p<p> u<u> i<i>[ a<a>][ · parked]       (missing u, i: 3; or "next: nothing runnable")
skipped:
- <id> <repo>: <title> · <reason>
```

Reasons: `paused`, `env blocked`, `picks off: pipeline not built`, `repo <r> frozen`, `repo <r> full (<n>/<workers>)`, `<model> cooling until <time>`, `unknown repo <r>`, `bad after: <ids>`, `parked (p<p> < <cutoff>): raise u or i to run it`.

**Doctor** (stdout; exit 0 unless the config can't load)

```
config: <file>                       (or "config: <error>", exit 1)
home: <home>
<exe>: <path>|missing                git, gh, claude, cargo, bwrap, systemd-inhibit, systemctl
gh version: <v>[: Towercab needs 2.46 or newer]   (gh --version, LOOP-20)
sandbox: user namespaces are restricted (Ubuntu): … set [agent] sandbox_unix_sockets = true   (when off)
github app: towercab[bot] <id>|<error>         (the App's key and its bot, LOOP-19)
<repo>: no towercab ruleset: towercab protect <repo>      (my gh; a failed check: "<repo>: ruleset: <error>")
<repo>: origin isn't https://github.com/…: the App token isn't used   (its clone exists, origin elsewhere)
<repo>: release block without live: ignored             (its base TOWERCAB.md, PIP-34)
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

**Code** (all `pub`; tests only in `tests/`; part = build order: 1 home, config, service; 2 machine, pick; 3 limits, network, awake; 4 status, messages, commands; 5 identity, Claude runs; 6 autonomy, [AUT](autonomy.md))

| Part | File | Interface |
|---|---|---|
| 1 | `src/config.rs` | **Config** sections; `Config::check_loop(&self) -> Result<(), String>`. |
| 1 | `src/home.rs` | `Home { root }`: `resolve(Option<&Path>)`, `db()`, `lock_path()`, `lock() -> Result<LoopLock, String>` (`try_lock`; held, but by no `LoopLock` of this process and not by another pid → retried up to 5 s: a fork of this process holds a copy of the fd until its `exec`), `holder() -> Option<u32>`, `work(id, attempt)`, `runs(dir)`. |
| fix | `src/log.rs` | `line(&str) -> String`, `emit(&str)`, `init(&Path)` (`Loop::open`), `tlog!` (the loop's `eprintln!`), `MAX`, `ROTATE` (LOOP-21). |
| 1 | `src/db.rs` | `Db`: `open(&Path)`, `MIGRATIONS`, `version()`, `tx(FnOnce(&Transaction) -> Result<T, String>)` (`BEGIN IMMEDIATE`), `meta`/`set_meta`/`del_meta` (also free fns `get_meta`/`set_meta`/`del_meta(&Connection, …)` for use inside `tx`); row types (`from_row`) `CommandRow`, `OutboxRow`, `Cooldown`, `RepoCap`, `FaultRow`, `DraftRow`. |
| 1, 4 | `src/exes.rs` | `Exes { git, gh, claude, cargo, bwrap, systemd_inhibit, systemctl, journalctl, xdg_open, towercab: OsString }` (`Default` = the names on `PATH`, `towercab` empty; tests point them at fakes); `which(exe) -> Option<PathBuf>` (doctor); `towercab(&Exes) -> Result<PathBuf, String>` (`towercab`, empty: the running executable via `claude::live_exe`; the pipeline's `hook verifier` child, PIP-32). |
| 1 | `src/service.rs` | `UNIT`, `unit_path() -> Result<PathBuf, String>`, `up(&Exes)`, `down(&Exes)` (`-> Result<String, String>`: the line printed), `logs(&Exes) -> Result<Infallible, String>` (exec). |
| 1, 2, 4 | `src/runloop.rs` | `Tick { wall: DateTime<FixedOffset>, mono: Duration }` (`now()`, `unix()`, `after(d)`); `shown_time(unix, now)` (**Status** `<time>`); `LoopOpts { watch, intent: Option<String>, pass: Duration (5 s), kill_after: Duration (10 s), ui: bool }` (`ui`: `run` serves [ui.md](ui.md) on `[ui] port`; the CLI sets it for `run --watch`); `Loop::open(Config, Home, Handlers, Exes, LoopOpts) -> Result<Loop, String>` (lock, db, `meta.running` (a leftover one → `Loop.unclean`), recovery; the preflight runs in the first pass); `pass(&mut self, Tick) -> Result<PassReport { commands: Vec<(i64, String)>, idle, stop, picked: Option<String>, woke }, String>`; part 3: `inhibitor() -> Option<(pid, why)>`; part 2: pub `prs: Box<dyn PrSource>`, `identity`, `probe`; `listing()`, `running()`, `queued()`, `slots_used()`, `pick_state(Tick)`; slot children wait in PRI-4 order for a free slot; a pick needs a free slot and no mission still stepping; `run(self) -> Result<(), String>` (passes, sleep woken by a SIGTERM/SIGINT self-pipe, a second signal exits at once); `stop_flag()`; `shutdown(&mut self) -> Result<(), String>` (children: SIGTERM, SIGKILL after `kill_after`, `interrupted`; `meta.running` removed); part 4: pub `telegram: Option<Telegram>`, `PassReport.target: Option<Result<String, String>>` (`run --intent`'s end), `set_target(q) -> Result<id, String>`, `step_intent(q) -> Result<String, String>`, `status_text(Tick)`, `next_text(Tick)`; part 5: `identity` = `Identity::from_config` (its bot seeded from and saved to `meta.bot`), the store opened as the App (`Store::open_as`), `PassReport.drafts`/`gauges`, pub `metrics: metrics::Sink` (flushed at the end of `pass`, `shutdown`, `step_intent`; [MET-13](metrics.md)), `drafting() -> Option<&str>` (the drafter's key; its slot counts in `slots_used`, it keeps `run` from idling, `shutdown` stops it uncounted). |
| 1, 4 | `src/commands.rs` | `Cmd::{Approve(String), RetryFresh(String), Release(String), Pause, Resume, Trust(String)}` (`name`, `word`, `failed(reply)`: an error reply `<word>: …`); `insert(&Connection, &Cmd, source, update_id, now) -> Result<i64, String>`, `queue(&Db, &Cmd, source)`; `CmdCx { config, db, tick, store: Option<&Store>, listing: Option<&Listing> }`; `apply(&CmdCx, &CommandRow) -> Result<String, String>` (an intent write it needs first, then effect (`machine::apply_tx` for a mission's), `applied_at`, `result` and a Telegram row's reply in one transaction; an applied row returns its result), `apply_pending`; `wait_result(&Db, id, Duration) -> Option<String>`; `submit(&Config, &Home, &Db, &Cmd, wait) -> Result<Option<String>, String>` (the CLI's way; `None` = queued). |
| 2 | `src/machine.rs` | `Stage` (`ALL`, `as_str`, `kind`, `driven`, `waits`, `finished`, `next`, `playbook`), `Event` (`ALL`, `as_str`), `Kind`, `Next`, `next`, `ORDER`, `REVERT`, `REHEARSAL`, `Waiting` (`ALL` = one sample per variant, `Door`), `continue_to`; `Apply { db, config, listing: Option<&Listing>, tick }` (the listing gives messages the title and slug, a fresh attempt its `model` and `a`); `apply(&Apply, &Mission, &Outcome) -> Result<Mission, String>`, `apply_as(…, Option<Next>)`, `apply_tx(&Connection, …)` (a mission no longer at `m.stage` → nothing written); `enter(&mut Ctx, &Mission)` (entry effects); `paused`; `dying`/`set_dying` (`meta.dying`). |
| 2 | `src/mission.rs` | `Mission` (a typed `missions` row; `label`, `waiting()`), `Kind`, `COLUMNS`, `ENTER`, `CHILD` (the child columns); `get`, `unfinished`, `entering` (`step = 'enter'`, finished ones too), `for_intent`, `unfinished_for` (`&Connection`); `NewMission { intent, slug, repo, model, a, min_attempt }` (`of(&Intent, &Config)`), `insert(&Connection, &NewMission, Tick) -> Result<Mission, String>` (attempt = max(last + 1, `min_attempt`)), `insert_pick`, `branch(id, slug, attempt)`. |
| 2 | `src/handler.rs` | **Handlers**. |
| 2, 4 | `src/pick.rs` | `PickState { cutoff, paused, env_blocked, built, repos, model, frozen, full: repo → (n, workers), cooling: model → until, active }` (`active`: intents with an unfinished mission, never picked), `decide`, `Decision { pick, skipped: Vec<(String, Skip)>, writes: Vec<(String, Waiting, String)> }`, `Skip` (`Display` = the **Next** reason), `bad_after(&Listing) -> Vec<(String, Vec<String>)>`, `orphans(&Listing, &[Mission]) -> Vec<String>`, `Pick` (handler); part 4: `state(&Db, &Config, built, Tick) -> PickState` (also `status`, `next`), `decide_for(&Listing, &PickState, id) -> (Decision, Result<(), String>)` (`--intent`, `step`: every other open intent counted active; only `id`'s `writes`). |
| 2 | `src/checkout.rs` | Each takes the `git` executable (`Exes::git`) first: `git(exe, dir, args, Option<&GitAuth>)` (`GIT_CEILING_DIRECTORIES` = the parent; `NO_HOOKS`), `sane(exe, dir)` / `allowed_key(key)` / `git_sane` (LOOP-8's config check, then `git`), `origin_url(exe, &RepoConfig)` (the clone's `remote.origin.url` as written, else `https://github.com/<github>.git`: what the App's auth is chosen by; `pick` passes it to `ensure_clone`), `ensure_clone(exe, &RepoConfig, Option<&GitAuth>)` (clone when missing, then `git fetch --quiet --prune origin`), `create(exe, clone, checkout, base, branch)`, `valid(exe, &Path) -> bool`, `ensure(exe, clone, checkout, base, branch) -> Result<bool, String>` (valid → kept; else removed and created), `refresh_base(exe, clone, checkout, base)`, `remove`, `rev`. |
| 2 | `src/events.rs` | `PrState { state, merged_at, merge_commit, head, mergeable, comments: Vec<Comment { author, at, body }> }`; `trait PrSource { fn read(&mut self, github: &str, pr: u64) -> Result<PrState, GhError>; }` (`GhPrs { gh, identity }`: `gh pr view` + `gh api …/comments`, `parse_pr(view, comments)`; tests use a fake); `new_feedback`, `pr_events`, `intent_events`. |
| 2, 3 | `src/child.rs` | `spawn(&ChildSpec, mono) -> Result<Child, String>` (`process_group(0)`, env cleared then set, stdin file or `/dev/null`, stdout/stderr files, removed again when it can't start), `Child::poll(&mut self, mono) -> Option<ChildEnd>`, `term(mono)`, `kill_if_due(mono, after)`, `kill_group(pid)`, `term_group(pid)`, `kill_leftover(pid, start) -> bool`, `start_time(pid) -> Option<u64>` (`/proc/<pid>/stat` field 22), `KILL_AFTER` (10 s), `output(&mut Command, timeout) -> io::Result<Output>` (LOOP-10's bound: `TimedOut` → `timed out after <n> s`), `GH_TIMEOUT` (120 s), `GIT_TIMEOUT` (300 s); `Child.budget` (the loop sets `ChildSpec.timeout` − the step's `step_secs`), `enforce(mono, after)` (run time ≥ budget → `timed_out`, SIGTERM to the group; SIGKILL `after` later). |
| 2, 3 | `src/limits.rs` | `Limit { model, reset: Option<DateTime<Utc>>, text }`, `CLAUDE`, `backoff(n)`, `cool(&Connection, &Limit, now) -> until`, `success(&Connection, model)` (backoffs → 0), `until(&Connection, model) -> Option<f64>`, `cooling(&Db, now) -> Vec<Cooldown>`; **Limits** (`detect`, `parse_reset`, `of_run`). |
| 2, 3 | `src/env.rs` | `Fault` (`Display`/`FromStr` = kind, `fix()`), `FaultClass::{Network, Auth}`, `classify(&str) -> Option<FaultClass>`, `backoff(retries) -> Duration`, `BLOCK_AFTER` (900 s), `RECHECK` (300 s), `CHECK_TIMEOUT` (20 s); on a `&Connection`: `open(fault, error, now) -> bool` (new), `close(kind)`, `settle(mission)` (closes its held fault), `faults`, `held`, `blocked`, `episode(now) -> bool` (starts/ends the episode, its message); `run_check(exe, args) -> Result<(), CheckError::{Missing, Failed}>` (`run_check_as(exe, args, &GitAuth)`: an `ls-remote` as the App), `github_urls(&Config, &Exes)`, `check(&Fault, &Config, &Exes, &mut Identity)`, `preflight(&Config, &Exes, &mut Identity) -> Vec<(Fault, Result<(), String>)>`, `record(&Connection, results, now) -> opened`. |
| 3 | `src/awake.rs` | `Inhibitor` (`new`, `update(&mut self, driving: Option<(String, Stage)>, &Exes, mono)`, `stop`, `pid`, `why`; killed on drop), `args(why)`, `RETRY` (60 s); `woke(last: Tick, now: Tick, pass) -> bool`. |
| 4 | `src/status.rs` | `Snapshot::read(&Db, Option<&Listing>, intents_error: Option<&str>, &Config, running: Option<u32>, built: bool, Tick) -> Result<Snapshot, String>` (`Item`, `Active`, `OnMe`, `OnCi`, `ON_CI`), `render(&Snapshot) -> String`, `next_text(&Decision, &Listing, cutoff) -> String`. |
| 2, 4 | `src/outbox.rs` | `Subject { id, repo, title, slug, pr_url, why }`; `Notice::{RepoFrozen, EnvBlocked, ReviewDue(ReviewDue), RehearsalFailed, Triage, EvalsDropped, Reply}` (`key() -> (mission, event)`); `first_line`, `render_waiting(&Waiting, &Subject, &Config) -> String`, `render_notice(&Notice) -> String`, `one_line`, `cut`, `num`; `enqueue(&Connection, mission, event, n, text, now) -> bool`, `notify(&Connection, &Notice, n, now)`, `review_due(&Connection, Option<ReviewDue>, now)` (`REVIEW_EVERY` 30 days); `trait Sender { send(&mut self, text) }`, `obsolete(&Connection, &OutboxRow, Option<&Listing>) -> bool`, `send_due(&Db, &mut dyn Sender, Option<&Listing>, now) -> Result<Sent { sent, dropped, failed }, String>`. |
| 4 | `src/http.rs` | `get_json`/`post_json(url, headers, body, timeout) -> Result<(u16, Value), HttpError>` (`ureq`, rustls; `TIMEOUT` 10 s; a 2xx with a JSON body, else `Status`); `post_any(url, body, timeout) -> Result<u16, HttpError>` (any 2xx body; MET-13's OTLP); `HttpError::{Net(String), Status(u16, String)}` (`Display` `HTTP <code>: …`); `mask`: `/bot<token>` in errors. |
| 4 | `src/telegram.rs` | `Telegram::new(&TelegramConfig)`, `send(text) -> Result<(), String>`, `updates(Option<offset>) -> Result<Vec<Update { id, chat, text, date }>, String>`, `chat_id()`, `logged` (once per outage), `impl outbox::Sender`; `parse(text) -> Result<TgCommand::{Status, Next, Help, Cmd(Cmd)}, String>`, `HELP`. |
| 4 | `src/doctor.rs` | `doctor(&Config, &Home, &Exes) -> String` (**Doctor**). |
| 2, 5 | `src/github.rs` | `Identity` (a handle: clones share one token cache): `none()` (my `gh` login), `app(Result<App, String>, api_base)`, `from_config(&Config, &Exes)` (`[github].app_id` → the App, key `Config::app_key()`), `with_gh(exe)`, `with_timeout(d)` (its `gh` calls' bound, default `GH_TIMEOUT`), `token(github, now) -> Result<String, GhError>`, `bot() -> Result<Bot { login, id, email }, GhError>` (`cached_bot`, `seed_bot`: `meta.bot`, `Bot::{meta, from_meta}`), `gh(github, args) -> Result<String, GhError>` (`GH_TOKEN`), `git_auth(github) -> Result<GitAuth, GhError>`, `auth_for_url(url)` (`github_of(url) -> Option<String>`: only `https://github.com/<o>/<n>[.git]`); `App::load(&Path, app_id)`, `App::jwt(now) -> String`; `GhError::{Env(String), Failed(String)}`, `is_env_failure(stderr)`. |
| 2, 5 | `src/intents/git.rs` | `git_command_for(exe)`, `GitAuth { args: Vec<String>, env: Vec<(String, String)> }` (`apply(&mut Command)`; `-c` args after Towercab's own, so the bot's `user.name`/`user.email` win); part 5: `AuthFn = Box<dyn FnMut() -> Result<GitAuth, String> + Send>`, `Checkout::with_auth(AuthFn)` (fetch, pull, rebase, commit, push and `git_as` use it; other calls stay local), `Checkout::clone_as(remote, path, &GitAuth)`; `Store::open_as(&Config, Option<AuthFn>)` (the loop's: `Identity::auth_for_url([intents].remote)`). |
| 5 | `ops/github-app.json` | `{name: towercab, url: https://github.com/<login>/towercab, description: <one line>, public: false, hook_attributes: {url: <same>, active: false}, default_permissions: {contents, pull_requests, issues, checks, statuses, workflows, actions: write; deployments, metadata: read}, default_events: []}`. |
| 2, 5 | `src/claude.rs`, `src/drafts.rs` | Part 2: `CONTINUE`, `SESSION_GONE`, `session_gone(text)`, `fresh_context` (LOOP-7); part 5: [PIP-24](pipeline.md) **Claude runs** (`env` has no GitHub token: LOOP-19); [INT-7, INT-8](intents.md) **Code**. |
| 6 | `src/autonomy.rs` | [AUT](autonomy.md) **Gate**: `RepoState` (`read`, `cap`), `effective`, `spec_gate`, `gate(&GateIn) -> Gate`, `GateIn`, `PrKind`, `Ci`, `Review` (`risk_low`), `Gate`, `Hold`, `CAPPED` (3), `lowered`, `lower`. Pure but `RepoState::read`; the pipeline's handlers call it. |
| 4 | `src/ui/` | [ui.md](ui.md): `serve`, `Server`, `App`, `handle`, `state`, `page`, `redact`; `wire.rs` (HTTP). |
| all | `src/cli.rs` | `towercab [--config <file>] [--home <dir>] <command>`, LOOP-15; errors `towercab: <reason>`, exit 1; bad arguments exit 2. |

## Out of scope

- Claims across machines (laptop + VPS).
- Periodic e2e watch of live services ([PIP-10](pipeline.md)).
- Stage handlers other than `pick` (the pipeline intent); their use of `src/autonomy.rs` (cap, gate, spec gate, `lower_a`).

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
- Picks stay off until every stage has a handler (`built()`): a loop built before the pipeline polled and answered commands but never marked an intent done without work. The pipeline's switch-over made `Handlers::production()` the pipeline (picks on); `Handlers::picks_off()` keeps the old loop for tests.
- `[repos.<r>].path` is Towercab's own clone (the key existed; it works like `[intents].path`): point it at a dedicated directory, not my working checkout.
- `down` disables as well as stops (symmetric with `up`); `KillMode=mixed` so only the loop gets SIGTERM and kills its children's groups itself, recording `interrupted`.
- One `commands` path for the CLI and Telegram; with no loop running the CLI applies its own row, so `approve` never waits for a `run` that isn't coming.
- Outbox `n` for pick-time waits is the condition (repo, `after` ids): a re-detection after a crash, or my continue without a fix, sends nothing new. A queued waiting message whose wait is over is dropped: stale asks aren't actionable.
- Telegram and OTLP never open a fault: a dead chat can't carry its own alarm, and metrics never block (MET-13).
- A step's fault is held (`missions.fault`) and closes only when that step succeeds; others' successes close only unheld faults (by their recheck): a repo whose token fails can't be reset every minute by another repo's reads and never reach `env_blocked`.
- The preflight runs in the first pass, not in `Loop::open`: its faults carry the pass's clock, and a slow network check never delays taking the lock.
- Woke = the wall clock ran ahead of the monotonic one (suspend stops only the latter): a pass slowed by a long call isn't a wake. A held mission (paused, waiting for my `resume`) doesn't keep the laptop awake.
- A limit-hit run's run time counts toward its step's timeout (`step_secs`), the wait doesn't: the resumed run gets the rest.
- `[agent].model` defaults to `opus` (the worker writes code; the review steps up from it, PIP-4); `[telegram].api_base` keeps the Python name; `[github].api_base` exists for the tests' fake server.
- `fix repo files` added to the waits: REPO-1's `Invalid` needs one (repo.md Decisions), and a typo there must stop the intent, not default.
- Telegram updates are handled one at a time, each in its own transaction with the next offset, a command applied at once: replies go out in the order I sent them; `commands.update_id` keys a command's reply, written with its effect.
- `approve` on a mission's wait goes through the machine (its entry effect removes `waiting`); only an intent-level wait is written to the store directly. A mission not waiting refuses it, even while `intent.md` still shows an old `waiting` (its entry write is due).
- A command the CLI applies runs the entry effects it made due: `approve` without a loop updates `intent.md` at once.
- `run --intent` and `step` exit 1 on a skip (paused, frozen, full, cooling, env blocked) rather than wait: they are foreground commands.
- An intent-level waiting row is kept while the intent has no `waiting` yet: the row is written first (LOOP-5), so dropping it then would lose the message.
- `app.pem` lives next to the config file, as `secrets/` does: the default is still `~/.config/towercab/app.pem`, and tests never touch my `~/.config`.
- The App token and bot author go only to `https://github.com/` remotes (`github_of`): git asks credential helpers only over HTTPS, and a path or ssh remote (tests, my own clone) keeps working without the App. Towercab's own clones are cloned from `https://github.com/`, so in production every remote qualifies; `doctor` warns about one that doesn't.
- A key that doesn't load is a `github` fault, not a refusal to start: the loop keeps answering `status` and Telegram, and `env blocked` names the fix (ops/github-app.json, app.pem).
- The bot (`GET /app` → slug, `GET /users/<slug>[bot]` → id) is looked up once and kept in `meta.bot`; the user lookup is a public read (no JWT: GitHub refuses App JWTs outside `/app` endpoints).
- Crates: `rusqlite` (`bundled`), `ureq` (blocking HTTP, rustls), `rsa` 0.9 + `sha2` (`oid`) + `base64` (RS256 JWT, pure Rust), `chrono-tz` (zones in limit texts), `uuid` (v4), `libc` (`killpg`), `signal-hook` (SIGTERM flag); dev `rand` for a test key generated at test time (`num-bigint-dig` built optimized in dev: an unoptimized 2048-bit key takes seconds). No async.
- The drafter is a loop child outside the missions (`Loop.drafter`), not a mission: a draft has no stage, PR events or intent. One at a time, after the missions' children and the pick, so a labelled issue never delays work already picked; its try is counted before it starts (a crash re-runs it as the next try), a `shutdown` uncounts it. Its process isn't recorded for LOOP-7's leftover kill: an orphan drafter only writes its own `drafter-<n>.json`.
- Gauges are the pass's last step but the flush (`PassReport.gauges`), every 60 s; the metrics intent filled them.
