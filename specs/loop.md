# Loop

**Status:** Draft · **Prefix:** LOOP

## Purpose

Towercab as one long Claude Code session: a skill holds the state machine, subagents do the
work, hooks record metrics. Code only where Claude Code has no feature or order must be exact.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| LOOP-1 | `towercab up` runs `systemd-inhibit --what=sleep:idle:handle-lid-switch --who=Towercab --mode=block claude --model <orchestrator> --permission-mode dontAsk [--continue] "/loop /towercab"` in the Towercab repo; `--continue` when a previous session exists. Exits 1 without `systemd-inhibit`. | test_up_argv |
| LOOP-2 | `.claude/settings.json`: `autoContinueAtUsageLimit: true`; allowlist for `git`, `gh`, `bin/*`, repo check commands; nothing ever prompts (prompts stall auto-continue). | test_settings |
| LOOP-3 | `/towercab` skill does one step per iteration, then `ScheduleWakeup`: 60 s while a stage is moving, 300 s waiting on CI/deploy, 1800 s idle or waiting on me. Never ends the loop. | manual |
| LOOP-4 | State lives in the task line, not the session: marker, `stage:` (`work`, `ci`, `gate`, `human`, `deploy`, `e2e`, `revert`), `pr:`, `worker:` (subagent ID), `ci_repairs:`. A restarted session resumes every task from it. | manual |
| LOOP-5 | **Pick:** `bin/next` (stdlib Python) prints the next task by [PRI-4](priority.md) order, skipping `[!]`, parked and unmet `after:`. One task in flight. Marks `[~] stage: work`. Fills missing ID, `u3 i3`; never `a` (replaces [TSK-3](tasks.md), [PRI-2](priority.md) default `a2`). | test_next |
| LOOP-6 | **Worker:** subagent `.claude/agents/worker.md`, model = task `@model`, else frontmatter `sonnet`. In a `git worktree` of the target repo (`~/.local/share/towercab/worktrees/<id>`, branch `towercab/<id>-<slug>`): plans, writes failing tests first, implements, runs `TOWERCAB.md` checks ([REPO-2](repo.md)), commits, pushes, opens the PR. Never merges. | manual |
| LOOP-7 | **CI:** `gh pr checks`. Red → `SendMessage` to the same `worker:` with `gh run view --log-failed` (last 200 lines per job) → push again. Max 3 repairs, then `[!]` + question. Worker gone (session lost) → fresh worker given the PR and logs. | manual |
| LOOP-8 | **Gate** after green: task has `a` → effective `a = min(a, max_autonomy)` ([REPO-1](repo.md)); ≥ 4 merge, ≤ 3 human. No `a` → risk assessment (LOOP-9). | test_gate |
| LOOP-9 | **Risk:** subagent `.claude/agents/risk.md` (`opus`, read-only: Read, Grep, Glob, `gh pr diff`) gets the diff and `## Red lines`; returns JSON `door` (`one-way`/`two-way`), `red_lines` (touched, with file), `risk` (`low` only if two-way and none touched), `why`. Low → merge; high → human. | manual |
| LOOP-10 | **Human:** `[!] stage: human`, `note: review PR`, notify. Merged by me → deploy. Closed → `note: PR closed`. | manual |
| LOOP-11 | **Merge:** `gh pr merge --squash`, by the orchestrator only; `merged_by: towercab` on the task. | manual |
| LOOP-12 | **Deploy + e2e:** wait for `## Live` deploy (timeout), run its `e2e` once. No `## Live` → done. Green → `DONE.md` line ([TSK-6](tasks.md)). | manual |
| LOOP-13 | e2e red, merged by Towercab → revert PR, merged; notify; task `[!]`, `note: reverted — refine or add a task`. | manual |
| LOOP-14 | e2e red, merged by me → risk agent re-reads the merged diff: two-way + red line touched → revert as LOOP-13; one-way → no revert, notify; otherwise keep, notify, add a task with the failure. Reason in `tasks/<id>.md`. | manual |
| LOOP-15 | Back to `[ ]` (refined by me) → starts again from Pick with a fresh worker; old PR referenced in the brief. | manual |
| LOOP-16 | **Notify:** `bin/notify "<text>"` posts to Telegram (`TOWERCAB_TELEGRAM_TOKEN`, `_CHAT_ID`); missing → no-op. Events: needs review, stuck, reverted, done, usage-limit wait stopped. | test_notify |
| LOOP-17 | `Notification` hook on `quota_auto_resume_stale`/`_disabled` → notify "waiting on usage limit, not auto-resuming". | test_quota_hook |

## Out of scope

- Reviewer agent ([PIP-4](pipeline.md)), plan gates for a1/a2 ([AUT-1, 2](autonomy.md)): a1–a3 all mean "I merge".
- Several tasks at once; the post-deploy watch ([PIP-10](pipeline.md)).

## Decisions

- One long session (my call): least code. Limits: built-in auto-continue; restart: `--continue` + re-run `/loop`.
- State in the task file: compaction or a crash can drop the session's memory, not the work.
- `bin/next` stays code: order must be predictable ([PRI-4](priority.md)).
- Worktree by hand: `isolation: worktree` only works for the session's own repo.
- One-way door → never auto-revert: rolling back may do more harm than the bug.
- Replaces the Python runner, scheduler and pipeline on `main` when built; their rows go `Removed` in that PR. Code kept on branch `python`.
