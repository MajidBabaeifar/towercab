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
| PIP-3 | **CI:** Towercab polls `gh pr checks <pr> --json name,bucket,link,startedAt` every `[agent].ci_poll` s (default 30). Within `ci_grace` s (default 120) of the push, checks started before it are ignored and none = pending; after that, none = green. Red → `gh run view <run> --log-failed` (last 16k) go back to the builder in the **same session** (`--resume`) → publish again. Max 3 CI repairs (`missions.ci_repairs`), then `[!]`, `note: CI red`, `pr:`, question in `tasks/<id>.md`, Telegram. Not built yet: a basic GitHub Actions workflow for a repo without CI. | test_ci_green, test_ci_pending_polls, test_no_checks_grace, test_ci_repair_loop, test_ci_cap |
| PIP-4 | **Review** after green CI, fresh session, read-only, given: task + `done when`, PR diff, CI result. Model: `review:<model>` on the task, else one step stronger than the builder (haiku → sonnet → opus; opus → opus; fable → fable). | test_reviewer_model, test_review_attr |
| PIP-5 | Review returns JSON: `approved`, `risk` (`low`/`high`), one verdict per `done when` item (`met` + why), `changes` (if not approved). | test_review_schema |
| PIP-6 | Not approved → `changes` go to the builder session → CI → review again. Max 3 review rounds, then `[!]` + question. | test_review_rounds_cap |
| PIP-7 | **Risk gate:** Towercab merges itself only if `approved` and `risk: low` and effective `a` ≥ 4 ([AUT-8](autonomy.md)). Otherwise the PR waits for me: `[!]`, `note: review PR`, Telegram. | test_risk_gate |
| PIP-8 | **Go live:** after merge, Towercab waits for the repo's deploy (`[repos.<r>.live]`: GitHub deployment status or URL check, timeout) and runs its `e2e` command once against it. Repo without `live` → merged means done. | test_go_live |
| PIP-9 | Live check fails after a merge Towercab did itself → it reverts (revert PR, merged), tells me on Telegram, adds a task with the failure. After my own merge → it only tells me and adds the task. | test_auto_revert |
| PIP-10 | **Watch:** each repo's `e2e` runs every `[repos.<r>.live].every` (default 30 min) as a plain script, no agent. Failure → an agent investigates (read-only) and writes a task with its findings to `gradient-tasks`, Telegram. Same failure doesn't open a second task. | test_watch_failure_task |
| PIP-11 | **Writing:** PR description and reports by Haiku from the builder's notes and the review verdicts: one-line summary, what changed (≤5 bullets, behaviour not files), checks (CI, review, one line each). Telegram messages are code templates, no model. | test_pr_writer |
| PIP-12 | **Own CI:** `.github/workflows/ci.yml` runs `python3 -m unittest discover -s tests` on Python 3.12 for every PR and push to `main`; a failing test turns the check red. | manual (open a PR, check the Actions run) |
| PIP-13 | CI failures, local verify failures (missions without a task) and review changes go back to the build session. Towercab stores `session_id` from the build's result JSON on the mission (`missions.session`) and runs `claude -p --resume <session_id>` with a short repair prompt (findings only). Review stays a fresh session. | test_resume_argv, test_repair_resumes_session |

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
- CI replaced local verify as the gate for task missions (RUN-8); `verify` stays the gate for missions without a task. Still to replace: PR body (RUN-27).
- CI polls aren't stage runs: no `Starting` event, no attempt counted. `towercab run` without `--watch` sleeps through a pending CI instead of exiting.
