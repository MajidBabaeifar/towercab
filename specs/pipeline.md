# Pipeline

**Status:** Draft · **Prefix:** PIP

## Purpose

What happens to a task from "start" to "running fine in production": one builder,
CI as the test runner, a stronger reviewer, a risk gate, then watching it live.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| PIP-1 | **Build** is one agent session on the task's model (`@model`, else `[agent].model`): plans, implements, writes tests that prove each `done when` item (as many as the repo allows; none only when the repo has no code), updates docs. | test_build_prompt |
| PIP-2 | **Publish:** Towercab commits, pushes `towercab/<id>-<slug>`, opens or updates the PR. The agent never pushes. | test_publish |
| PIP-3 | **CI:** Towercab polls the PR's checks (`gh pr checks`). Red → failing job logs go back to the builder in the **same session** (`--resume`) → push again. Max 3 CI repairs, then `[!]` + question. A repo without CI gets a basic GitHub Actions workflow running its `verify` command, as part of the first task there. | test_ci_repair_loop, test_ci_cap |
| PIP-4 | **Review** after green CI, fresh session, read-only, given: task + `done when`, PR diff, CI result. Model: `review:<model>` on the task, else one step stronger than the builder (haiku → sonnet → opus; opus → opus; fable → fable). | test_reviewer_model |
| PIP-5 | Review returns JSON: `approved`, `risk` (`low`/`high`), one verdict per `done when` item (`met` + why), `changes` (if not approved). | test_review_schema |
| PIP-6 | Not approved → `changes` go to the builder session → CI → review again. Max 3 review rounds, then `[!]` + question. | test_review_rounds_cap |
| PIP-7 | **Risk gate:** Towercab merges itself only if `approved` and `risk: low` and effective `a` ≥ 4 ([AUT-8](autonomy.md)). Otherwise the PR waits for me: `[!]`, `note: review PR`, Telegram. | test_risk_gate |
| PIP-8 | **Go live:** after merge, Towercab waits for the repo's deploy (`[repos.<r>.live]`: GitHub deployment status or URL check, timeout) and runs its `e2e` command once against it. Repo without `live` → merged means done. | test_go_live |
| PIP-9 | Live check fails after a merge Towercab did itself → it reverts (revert PR, merged), tells me on Telegram, adds a task with the failure. After my own merge → it only tells me and adds the task. | test_auto_revert |
| PIP-10 | **Watch:** each repo's `e2e` runs every `[repos.<r>.live].every` (default 30 min) as a plain script, no agent. Failure → an agent investigates (read-only) and writes a task with its findings to `gradient-tasks`, Telegram. Same failure doesn't open a second task. | test_watch_failure_task |
| PIP-11 | **Writing:** PR description and reports by Haiku from the builder's notes and the review verdicts: one-line summary, what changed (≤5 bullets, behaviour not files), checks (CI, review, one line each). | test_pr_writer |
| PIP-12 | The writer (`towercab/writer.py`) runs `claude -p --model haiku --tools ""` with the prompt on stdin, no tools, 60 s timeout. Header (task, mission) and footer (`🤖 Built by Towercab`) are code; bullets are trimmed to 5. | test_pr_writer |
| PIP-13 | Writer failure (non-zero exit, timeout, empty output, missing executable) → plain template from the same inputs (review feedback as bullets). Publishing never fails because of the writer. | test_writer_fallback, test_writer_template |
| PIP-14 | Telegram messages are code templates, no model; tests pin each text. | test_telegram_templates |

## Out of scope

- Several builders per task, best-of-N.
- Agents that watch continuously; watching is scripts, agents only on failure.

## Decisions

- One builder session from plan to last repair: it keeps its context; no separate plan agent unless a task's `a` ≤ 2 (plan for my approval, [AUT-1, 2](autonomy.md)).
- CI is the test runner: it works where the local sandbox can't, on a clean machine without my secrets.
- The reviewer's risk call never lifts the ceiling I set with `a`: a manipulated file can't talk its way into a merge.
- Cap 3 for CI repairs and for review rounds: after that it costs more than asking me.
- Replaces when built: plan stage (RUN-5), local verify as the gate (RUN-5, RUN-8), inline PR body (RUN-8) → PIP-11..13.
