# Runner

**Status:** Removed: superseded by [loop.md](loop.md) (Rust rewrite); Python version on branch `python` · **Prefix:** RUN

## Purpose

Work down the task list alone: pick a task, hand it to an agent with tight access,
wait out limits, publish the result, take the next one.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| RUN-1 | Removed → LOOP-1. Was: Config `~/.config/towercab/config.toml` (or `--config`, `TOWERCAB_CONFIG`): `[tasks]` remote/path/cutoff, `[agent]` provider/reviewer/model/timeout/max_repairs/ci_poll/ci_grace/ci_wait, `[repos.<name>]` path, verify argv, bash allowlist, base; optional `[telegram]` bot_token + chat_id (both strings, or `ConfigError`). | — |
| RUN-2 | Removed → LOOP-1. Was: Towercab works in its own clone of the task repo (default `~/.local/share/towercab/gradient-tasks`); state in `~/.local/share/towercab` (`--home`, `TOWERCAB_HOME`). | — |
| RUN-3 | Removed → LOOP-5. Was: A task whose repo isn't configured is marked `[!]`, `note: unknown repo`, question in `tasks/<id>.md`; the loop moves on. | — |
| RUN-4 | Removed → LOOP-15. Was: `towercab next` prints the task it would run and why (priority, order, what was skipped). | — |
| RUN-5 | Removed → LOOP-5, PIP-1, PIP-17. Was: Starting: task gets ID/scores, marker `[~]`; mission brief = title + `done when` + `tasks/<id>.md`; checkout cloned from the repo's remote at `base` (a retry: its open PR's branch, [PIP-17](pipeline.md)), with no remote left for the agent. Blocked → `[!]`, `note: <reason>` (or `blocked at <stage>`), the details as a question. | — |
| RUN-6 | Removed → PIP-24, PIP-23. Was: Access: review = Read, Glob, Grep + read-only git; build adds Edit, Write and only the repo's bash patterns. `dontAsk`, never bypass. Bash sandboxed (workspace writes only, no network, `failIfUnavailable`). Secrets (`~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.gnupg`, credential files, `.env*`) and `git commit/push/remote/config`, `gh`, `curl`, `wget`, `ssh`, `sudo` denied. A denied secret read or publish attempt fails the stage. | — |
| RUN-7 | Removed → LOOP-9. Was: Usage limits: reset time parsed from the message (clock time with zone, date, epoch, retry-after, "in N min"), else backoff 1→60 min; wait until reset + 30 s, resume the same stage, no repair counted, event logged with the time. | — |
| RUN-8 | Removed → PIP-2, PIP-14, PIP-21. Was: After each build Towercab commits in the checkout and pushes `towercab/<id>-<slug>`; the first push opens a PR with a placeholder text, replaced once ready ([PIP-2, PIP-14](pipeline.md)). Ready → task `[!]` with `pr:` and `note: review PR`. Publish failure → `[!]`, `note: publish failed`, question. Merged → line to DONE.md with PR, cost, time, attempts. Closed → `note: PR closed without merge`. | — |
| RUN-9 | Removed → LOOP-15, LOOP-17. Was: `towercab run` takes the next task whenever none is in flight, one at a time, skips `[!]`; `--watch` keeps polling; `--max-tasks N`; Ctrl-C leaves the task `[!]`, never half-running. | — |
| RUN-10 | Removed → LOOP-15. Was: `towercab --version` prints `towercab <__version__>` and exits 0. | — |
| RUN-11 | Removed → LOOP-15. Was: `towercab run --task <id or suffix>` runs only that task, even if `[!]`, then stops; refuses if another task is in flight. For testing. | — |
| RUN-12 | Removed → LOOP-16. Was: With `[telegram]`, Towercab sends plain-text messages via the Bot API `sendMessage` (stdlib `urllib`, 10 s timeout, no retries). Without it, nothing is sent. | — |
| RUN-13 | Removed → LOOP-16. Was: A failed send (HTTP error, refused, timeout) returns False, logs once without the token, never raises; the loop continues. | — |
| RUN-14 | Removed → LOOP-14. Was: Events: PR ready (task, PR URL); task stuck (its reason, or blocked at stage); task asking (unknown repo, publish failure, never published, PR state unknown); CI gave up (task, PR, repairs, last log lines). | — |
| RUN-15 | Removed → LOOP-14 (limits send nothing). Was: Waiting out a limit: message names provider and reset time (local, with zone); sent on the first hit only, not on retries. | — |
| RUN-16 | Removed → LOOP-14 (merges send nothing). Was: Task merged (moved to DONE.md): message with task and PR. | — |
| RUN-17 | Removed → LOOP-1, LOOP-2. Was: `./install.sh` symlinks `bin/towercab` into `${XDG_BIN_HOME:-~/.local/bin}`; `towercab` then works from any folder (launcher resolves its symlink, no dependencies). | — |
| RUN-18 | Removed → LOOP-2, LOOP-11. Was: `towercab up [--max-tasks N] [--task ID]` execs `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=Towercab --mode=block` around `python -m towercab --home H [--config C] run --watch …`. Inhibit lasts until it exits. | — |
| RUN-19 | Removed → LOOP-10. Was: `up` without `systemd-inhibit` exits 1 with an error and starts nothing. `doctor` lists `systemd-inhibit`. | — |
| RUN-20 | Removed → LOOP-16. Was: With `[telegram]`, each loop iteration calls `getUpdates` (`offset` = last `update_id`+1, `timeout` 0). Every update is consumed once, ignored or not. | — |
| RUN-21 | Removed → LOOP-16. Was: Messages whose `chat.id` isn't the configured `chat_id` (compared as strings) are ignored: no reply, no change. A failed poll returns nothing, logs once without the token, never raises. | — |
| RUN-22 | Removed → LOOP-13. Was: `status` replies: running task, tasks waiting on me (`[!]` + note or PR), next runnable task, limit cooldowns. | — |
| RUN-23 | Removed → LOOP-15. Was: `next` replies with the same text as `towercab next`. | — |
| RUN-24 | Removed → LOOP-15. Was: `approve <id>` turns a `[!]` task into `[ ]` (clears `note`, keeps `pr:`), committed and pushed; replies `approved`. Unknown/ambiguous ID or non-`[!]` task: error reply, no change. | — |
| RUN-25 | Removed → LOOP-15. Was: `run <id>` starts that task as `run --task` does (RUN-11), forcing `[!]`; replies with the mission ID. Refused while a task is in flight. The loop keeps going. | — |
| RUN-26 | Removed → LOOP-16. Was: Leading `/` and `@bot` suffix accepted. Unknown command or missing ID: one-line help. | — |

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
