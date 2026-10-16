# Runner

**Status:** Live · **Prefix:** RUN

## Purpose

Work down the task list alone: pick a task, hand it to an agent with tight access,
wait out limits, publish the result, take the next one.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| RUN-1 | Config `~/.config/towercab/config.toml` (or `--config`, `TOWERCAB_CONFIG`): `[tasks]` remote/path/cutoff, `[agent]` provider/reviewer/model/timeout/max_repairs/ci_poll/ci_grace/ci_wait, `[repos.<name>]` path, verify argv, bash allowlist, base; optional `[telegram]` bot_token + chat_id (both strings, or `ConfigError`). | test_example_loads, test_bad_repo, test_telegram_config, test_ci_settings |
| RUN-2 | Towercab works in its own clone of the task repo (default `~/.local/share/towercab/gradient-tasks`); state in `~/.local/share/towercab` (`--home`, `TOWERCAB_HOME`). | test_clones_and_reads |
| RUN-3 | A task whose repo isn't configured is marked `[!]`, `note: unknown repo`, question in `tasks/<id>.md`; the loop moves on. | test_unknown_repo_asks_instead_of_crashing |
| RUN-4 | `towercab next` prints the task it would run and why (priority, order, what was skipped). | test_next_explains, test_order_and_reason |
| RUN-5 | Starting: task gets ID/scores, marker `[~]`; mission brief = title + `done when` + `tasks/<id>.md`; checkout cloned from the repo's remote at `base` (a retry: its open PR's branch, [PIP-17](pipeline.md)), with no remote left for the agent. Blocked → `[!]`, `note: <reason>` (or `blocked at <stage>`), the details as a question. | test_three_tasks_back_to_back_then_merged, test_forbidden_access_blocks_and_asks |
| RUN-6 | Access: review = Read, Glob, Grep + read-only git; build adds Edit, Write and only the repo's bash patterns. `dontAsk`, never bypass. Bash sandboxed (workspace writes only, no network, `failIfUnavailable`). Secrets (`~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.gnupg`, credential files, `.env*`) and `git commit/push/remote/config`, `gh`, `curl`, `wget`, `ssh`, `sudo` denied. A denied secret read or publish attempt fails the stage. | test_access, test_forbidden_access_blocks_and_asks |
| RUN-7 | Usage limits: reset time parsed from the message (clock time with zone, date, epoch, retry-after, "in N min"), else backoff 1→60 min; wait until reset + 30 s, resume the same stage, no repair counted, event logged with the time. | test_limits, test_rate_limit_waits_for_reset_and_resumes |
| RUN-8 | After each build Towercab commits in the checkout and pushes `towercab/<id>-<slug>`; the first push opens a PR with a placeholder text, replaced once ready ([PIP-2, PIP-14](pipeline.md)). Ready → task `[!]` with `pr:` and `note: review PR`. Publish failure → `[!]`, `note: publish failed`, question. Merged → line to DONE.md with PR, cost, time, attempts. Closed → `note: PR closed without merge`. | test_three_tasks_back_to_back_then_merged |
| RUN-9 | `towercab run` takes the next task whenever none is in flight, one at a time, skips `[!]`; `--watch` keeps polling; `--max-tasks N`; Ctrl-C leaves the task `[!]`, never half-running. | test_three_tasks_back_to_back_then_merged, test_ctrl_c_leaves_task_waiting |
| RUN-10 | `towercab --version` prints `towercab <__version__>` and exits 0. | test_version_flag |
| RUN-11 | `towercab run --task <id or suffix>` runs only that task, even if `[!]`, then stops; refuses if another task is in flight. For testing. | test_run_only_one_task |
| RUN-12 | With `[telegram]`, Towercab sends plain-text messages via the Bot API `sendMessage` (stdlib `urllib`, 10 s timeout, no retries). Without it, nothing is sent. | test_send_request, test_disabled_without_config |
| RUN-13 | A failed send (HTTP error, refused, timeout) returns False, logs once without the token, never raises; the loop continues. | test_failures_never_raise, test_dead_telegram_does_not_stop_loop |
| RUN-14 | Events: PR ready (task, PR URL); task stuck (its reason, or blocked at stage); task asking (unknown repo, publish failure, never published, PR state unknown); CI gave up (task, PR, repairs, last log lines). | test_notify_pr_ready, test_notify_stuck, test_notify_asking, test_ready_without_pr_does_not_crash, test_gh_failure_at_retry_asks_and_never_force_pushes, test_ci_cap |
| RUN-15 | Waiting out a limit: message names provider and reset time (local, with zone); sent on the first hit only, not on retries. | test_notify_limit_once |
| RUN-16 | Task merged (moved to DONE.md): message with task and PR. | test_notify_merged |
| RUN-17 | `./install.sh` symlinks `bin/towercab` into `${XDG_BIN_HOME:-~/.local/bin}`; `towercab` then works from any folder (launcher resolves its symlink, no dependencies). | test_launcher_from_other_cwd |
| RUN-18 | `towercab up [--max-tasks N] [--task ID]` execs `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=Towercab --mode=block` around `python -m towercab --home H [--config C] run --watch …`. Inhibit lasts until it exits. | test_up_argv, test_up_argv_passes_options, test_up_execs_inhibit |
| RUN-19 | `up` without `systemd-inhibit` exits 1 with an error and starts nothing. `doctor` lists `systemd-inhibit`. | test_up_without_systemd_inhibit, test_up_cli_missing_binary_exits_1 |
| RUN-20 | With `[telegram]`, each loop iteration calls `getUpdates` (`offset` = last `update_id`+1, `timeout` 0). Every update is consumed once, ignored or not. | test_offset_advances_no_replay, test_loop_runs_approve |
| RUN-21 | Messages whose `chat.id` isn't the configured `chat_id` (compared as strings) are ignored: no reply, no change. A failed poll returns nothing, logs once without the token, never raises. | test_other_chat_ignored, test_updates_failure_is_quiet |
| RUN-22 | `status` replies: running task, tasks waiting on me (`[!]` + note or PR), next runnable task, limit cooldowns. | test_status |
| RUN-23 | `next` replies with the same text as `towercab next`. | test_next |
| RUN-24 | `approve <id>` turns a `[!]` task into `[ ]` (clears `note`, keeps `pr:`), committed and pushed; replies `approved`. Unknown/ambiguous ID or non-`[!]` task: error reply, no change. | test_approve, test_approve_errors |
| RUN-25 | `run <id>` starts that task as `run --task` does (RUN-11), forcing `[!]`; replies with the mission ID. Refused while a task is in flight. The loop keeps going. | test_run, test_run_refused_while_busy |
| RUN-26 | Leading `/` and `@bot` suffix accepted. Unknown command or missing ID: one-line help. | test_parse, test_help |

## Out of scope

- Several tasks at once, autonomy gates, model routing, metrics database: see `gradient-tasks` "later".

## Decisions

- Every task currently behaves as a3 (PR waits for me); gates come later.
- Notifications are fire-and-forget: one message per event, no queue. `[telegram].api_base` (default `https://api.telegram.org`) exists for tests.
- Commands are polled once per loop iteration (`timeout=0`), no thread: a command waits for the running stage step to finish. Fake API in tests: `tests/fake_telegram.py` also serves `getUpdates`.
- PR state is read with `gh pr view` at most once a minute.
- Install is a symlink launcher, not pip/pipx: no packaging, Ubuntu PEP 668 safe, edits stay live.
- Lid inhibit depends on logind/polkit policy; the argv is tested, the effect is not.
- The checkout clones the pushed `base`, not my working copy, so uncommitted local work never leaks in.
