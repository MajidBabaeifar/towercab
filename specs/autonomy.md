# Autonomy

**Status:** Draft · **Prefix:** AUT

## Purpose

How far an agent may take a task before it waits for me.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| AUT-1 | a1: marked `[!]`; no code until I write the plan in `tasks/<id>.md` and set `[ ]`; PR waits for my merge. | test_gate_a1 |
| AUT-2 | a2: agent writes a plan (spec rows + 3–7 steps) to `tasks/<id>.md` and marks `[!]`; codes after I set `[ ]` or run `towercab approve <id>`; PR waits. | test_gate_a2 |
| AUT-3 | a3: codes right away; PR waits for my merge. | test_gate_a3 |
| AUT-4 | a4: merges itself once validation passes; notifies me. | test_gate_a4 |
| AUT-5 | a5: as a4, then deploys (repo config), watches post-deploy checks, reverts on failure. | test_gate_a5 |
| AUT-6 | Validation runs in full at every level: repo checks, spec `Verified by` checks, reviewer agent on a fresh context. | test_validation_always |
| AUT-7 | An agent may lower a task's `a` (reason in `tasks/<id>.md`), never raise it. | test_lower_only |
| AUT-8 | Effective `a = min(task a, repos.<name>.max_autonomy)`; default max 5. | test_repo_cap |
| AUT-9 | Loop version: no `a` on the task → a risk agent decides after green CI: low (two-way door, no red line touched) merges, high waits for me ([LOOP-8, 9](loop.md)). Repo `max_autonomy` ≤ 3 still means I merge. | test_gate |

## Out of scope

- Raising autonomy automatically. [Metrics](metrics.md) may suggest it; I change the score.

## Decisions

- Urgency and importance set order; autonomy only moves gates. Validation never shrinks
  with trust.
- rust-policies: `max_autonomy = 3` (I always merge there).
