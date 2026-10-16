# Pipeline

**Status:** Draft · **Prefix:** PIP

## Purpose

What happens to a task from "start" to "running fine in production": one builder,
CI as the test runner, a stronger reviewer, a risk gate, then watching it live.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| PIP-1 | **Build** is one agent session on the task's model (`@model`, else `[agent].model`): plans, implements, writes tests that prove each `done when` item (as many as the repo allows; none only when the repo has no code), updates docs. Stages: task missions build → publish → ci → review; missions without a task (CLI, demo) build → verify → review. No plan stage. | test_build_prompt, test_stage_order, test_publish_before_review |
| PIP-2 | **Publish** right after each build: Towercab commits, pushes `towercab/<id>-<slug>`, opens the PR the first time (`missions.pr`), later only pushes. The agent never pushes. Local verify doesn't run for task missions. | test_publish_before_review, test_ci_repair_loop |
| PIP-3 | **CI:** Towercab polls `gh pr checks <pr> --json name,bucket,link,startedAt` every `[agent].ci_poll` s (default 30). Within `ci_grace` s (default 120) of the push, checks started before it are ignored and none = pending. After that, no checks: repo without `.github/workflows/*.y(a)ml` → pass, recorded as `ci: none`; repo with workflows → pending until `ci_wait` s (default 1800), then blocked, `note: no CI checks appeared for this commit`, question, Telegram. Red → `gh run view <run> --log-failed` (last 16k) go back to the builder in the **same session** (`--resume`) → publish again. Max 3 CI repairs (`missions.ci_repairs`), then `[!]`, `note: CI red`, `pr:`, question in `tasks/<id>.md`, Telegram. Not built yet: a basic GitHub Actions workflow for a repo without CI. | test_ci_green, test_ci_pending_polls, test_no_checks_grace, test_ci_repair_loop, test_ci_cap, test_ci_wait_holds_while_checks_are_late, test_repo_with_workflows_never_reads_missing_checks_as_no_ci |
| PIP-4 | **Review** after green CI, fresh session, read-only, given: task + `done when`, PR diff, CI result. Model: `review:<model>` on the task, else one step stronger than the builder (haiku → sonnet → opus; opus → opus; fable → fable). | test_reviewer_model, test_review_attr |
| PIP-5 | Review returns JSON: `approved`, `risk` (`low`/`high`), one verdict per `done when` item (`met` + why), `changes` (if not approved). | test_review_schema |
| PIP-6 | Not approved → `changes` go to the builder session → CI → review again. Max 3 review rounds, then `[!]` + question. | test_review_rounds_cap |
| PIP-7 | **Risk gate:** Towercab merges itself only if `approved` and `risk: low` and effective `a` ≥ 4 ([AUT-8](autonomy.md)). Otherwise the PR waits for me: `[!]`, `note: review PR`, Telegram. | test_risk_gate |
| PIP-8 | **Go live:** after merge, Towercab waits for the repo's deploy (`[repos.<r>.live]`: GitHub deployment status or URL check, timeout) and runs its `e2e` command once against it. Repo without `live` → merged means done. | test_go_live |
| PIP-9 | Live check fails after a merge Towercab did itself → it reverts (revert PR, merged), tells me on Telegram, adds a task with the failure. After my own merge → it only tells me and adds the task. | test_auto_revert |
| PIP-10 | **Watch:** each repo's `e2e` runs every `[repos.<r>.live].every` (default 30 min) as a plain script, no agent. Failure → an agent investigates (read-only) and writes a task with its findings to `gradient-tasks`, Telegram. Same failure doesn't open a second task. | test_watch_failure_task |
| PIP-11 | **Writing:** PR description and reports by Haiku from the builder's notes and the review verdicts: one-line summary, what changed (≤5 bullets, behaviour not files), checks (CI, review, one line each). | test_pr_writer |
| PIP-12 | **Own CI:** `.github/workflows/ci.yml` runs `python3 -m unittest discover -s tests` on Python 3.12 for every PR and push to `main`; a failing test turns the check red. | manual (open a PR, check the Actions run) |
| PIP-13 | CI failures, local verify failures (missions without a task) and review changes go back to the build session. Towercab stores `session_id` from the build's result JSON on the mission (`missions.session`) and runs `claude -p --resume <session_id>` with a short repair prompt (findings only). Review stays a fresh session. A repair's final message is appended to `build.txt` (`Repair:`), so the first build's summary leads. | test_resume_argv, test_repair_resumes_session, test_build_notes_keep_summary |
| PIP-14 | At publish the PR gets a short placeholder that claims nothing; a retry's first push onto its open PR resets the text to that placeholder. Ready (CI green, review approved) → final text via `gh pr edit`; its CI line says `green` or, when the repo has no checks, `no CI checks on this repo, nothing ran`. Stopped (CI cap, review rounds used up, no CI checks appeared, blocked stage, repair publish failed) → `⛔ Not ready: <why>` pointing to `tasks/<id>.md`. The writer (`towercab/writer.py`) runs `claude -p --model haiku --tools ""` with the prompt on stdin, no tools, 60 s timeout. Order: summary, what changed, checks; then a small `<sub>` footer (🤖 Built by Towercab · task · mission · cost · time), all code except summary and bullets; bullets trimmed to 5. Notes, cost, time and repairs cover every attempt that pushed into the PR; each attempt's notes keep their own start and end. | test_pr_writer, test_no_ci_pr_text_says_nothing_ran, test_blocked_pr_text_says_not_ready, test_review_cap_says_review, test_retry_reviews_and_describes_the_whole_pr, test_head_and_tail_keeps_the_summary |
| PIP-15 | The PR text never blocks a task: writer failure (non-zero exit, timeout, empty output, missing executable) → plain template from the same inputs (title as summary, review feedback as bullets); a failed `gh pr edit` → event logged, task still settles. A task mission waiting at review without a PR (queued before the CI loop) is published first; one that still reaches ready without a PR → `[!]`, `note: never published`, never `review PR`. | test_writer_fallback, test_writer_template, test_writer_failure_falls_back, test_pr_text_edit_failure_never_blocks, test_ready_without_pr_does_not_crash, test_old_review_mission_gets_published |
| PIP-16 | Telegram messages are code templates, no model; tests pin each text. | test_telegram_templates, test_ci_gave_up_text |
| PIP-17 | **Retry:** a task set back to `[ ]` continues on its open PR: the one in `pr:` (same repo, not from a fork), else an open PR on its own branch `towercab/<id>-<slug>` (a `pr:` line lost in a crash or edit). It clones `--branch <head>`, keeps the same PR, never forces, so a fix I pushed there is kept; its baseline is the merge-base with `base`, so review and the patch cover the whole PR. `pr:` closed, missing (gh: "Could not resolve"), from a fork or another repo → fresh attempt from `base`; its first push forces the old branch only if no open PR uses it, and an open PR found then is recorded on the task. gh can't tell → `[!]`, `note: PR state unknown`, Telegram, nothing pushed. | test_retry_continues_on_open_pr, test_fresh_attempt_replaces_stale_branch, test_gh_failure_at_retry_asks_and_never_force_pushes, test_lost_pr_line_never_force_pushes, test_retry_reviews_and_describes_the_whole_pr, test_open_pr_states, test_failed_pr_list_never_forces |

## Out of scope

- Several builders per task, best-of-N.
- Agents that watch continuously; watching is scripts, agents only on failure.
- Codex resume: it runs `--ephemeral`, so its repairs start a fresh session with the full prompt.

## Decisions

- One builder session from plan to last repair: it keeps its context; no separate plan agent unless a task's `a` ≤ 2 (plan for my approval, [AUT-1, 2](autonomy.md)).
- CI is the test runner: it works where the local sandbox can't, on a clean machine without my secrets.
- The reviewer's risk call never lifts the ceiling I set with `a`: a manipulated file can't talk its way into a merge.
- Cap 3 for CI repairs and for review rounds: after that it costs more than asking me.
- Plan stage removed now (old `plan` missions move to `build` on open); a plan stage for `a` ≤ 2 returns later with AUT-1, 2.
- CI replaced local verify as the gate for task missions (RUN-8); `verify` stays the gate for missions without a task.
- A blocked mission goes back to `build` with a stored `reason` (review rounds used up, no CI checks appeared, …): `towercab retry` re-runs a build, messages name the real cause.
- CI polls aren't stage runs: no `Starting` event, no attempt counted. `towercab run` without `--watch` sleeps through a pending CI instead of exiting.
- Plan stage (RUN-5) and inline PR body (RUN-8) are replaced by PIP-1 and PIP-11, PIP-14, PIP-15.
