# Runner

**Status:** Live · **Prefix:** RUN

## Purpose

Work down the task list alone: pick a task, hand it to an agent with tight access,
wait out limits, publish the result, take the next one.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| RUN-1 | Config `~/.config/towercab/config.toml` (or `--config`, `TOWERCAB_CONFIG`): `[tasks]` remote/path/cutoff, `[agent]` provider/reviewer/model/timeout/max_repairs, `[repos.<name>]` path, verify argv, bash allowlist, base. | test_example_loads, test_bad_repo |
| RUN-2 | Towercab works in its own clone of the task repo (default `~/.local/share/towercab/gradient-tasks`); state in `~/.local/share/towercab` (`--home`, `TOWERCAB_HOME`). | test_clones_and_reads |
| RUN-3 | A task whose repo isn't configured is marked `[!]`, `note: unknown repo`, question in `tasks/<id>.md`; the loop moves on. | test_unknown_repo_asks_instead_of_crashing |
| RUN-4 | `towercab next` prints the task it would run and why (priority, order, what was skipped). | test_next_explains, test_order_and_reason |
| RUN-5 | Starting: task gets ID/scores, marker `[~]`; mission brief = title + `done when` + `tasks/<id>.md`; checkout cloned from the repo's remote at `base`, with no remote left for the agent. Blocked → `[!]`, `note: blocked at <stage>`, reason as a question. | test_three_tasks_back_to_back_then_merged, test_forbidden_access_blocks_and_asks |
| RUN-6 | Access: plan/review = Read, Glob, Grep + read-only git; build adds Edit, Write and only the repo's bash patterns. `dontAsk`, never bypass. Bash sandboxed (workspace writes only, no network, `failIfUnavailable`). Secrets (`~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.gnupg`, credential files, `.env*`) and `git commit/push/remote/config`, `gh`, `curl`, `wget`, `ssh`, `sudo` denied. A denied secret read or publish attempt fails the stage. | test_access, test_forbidden_access_blocks_and_asks |
| RUN-7 | Usage limits: reset time parsed from the message (clock time with zone, date, epoch, retry-after, "in N min"), else backoff 1→60 min; wait until reset + 30 s, resume the same stage, no repair counted, event logged with the time. | test_limits, test_rate_limit_waits_for_reset_and_resumes |
| RUN-8 | Ready → Towercab commits in the checkout, pushes `towercab/<id>-<slug>`, opens a PR (body: task, mission, repairs, cost, time, review), task `[!]` with `pr:` and `note: review PR`. Merged → line to DONE.md with PR, cost, time, attempts. Closed → `note: PR closed without merge`. | test_three_tasks_back_to_back_then_merged |
| RUN-9 | `towercab run` takes the next task whenever none is in flight, one at a time, skips `[!]`; `--watch` keeps polling; `--max-tasks N`; Ctrl-C leaves the task `[!]`, never half-running. | test_three_tasks_back_to_back_then_merged, test_ctrl_c_leaves_task_waiting |

## Out of scope

- Several tasks at once, autonomy gates, model routing, metrics database: see `gradient-tasks` "later".

## Decisions

- Every task currently behaves as a3 (PR waits for me); gates come later.
- PR state is read with `gh pr view` at most once a minute.
- The checkout clones the pushed `base`, not my working copy, so uncommitted local work never leaks in.
