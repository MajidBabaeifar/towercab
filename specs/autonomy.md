# Autonomy

**Status:** Draft · **Prefix:** AUT

## Purpose

How far an agent may take a task before it waits for me.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| AUT-1 | a1: no code until I write the plan in the task body; PR waits for my merge. | test_gate_a1 |
| AUT-2 | a2: agent writes a plan (spec rows + 3–7 steps) to the task body, status `Waiting on you`; codes after I set `Open` or run `baton approve <id>`; PR waits. | test_gate_a2 |
| AUT-3 | a3: codes right away; PR waits for my merge. | test_gate_a3 |
| AUT-4 | a4: merges itself once validation passes; notifies me. | test_gate_a4 |
| AUT-5 | a5: as a4, then deploys (repo config), watches post-deploy checks, reverts on failure. | test_gate_a5 |
| AUT-6 | Validation runs in full at every level: repo checks, spec `Verified by` checks, reviewer agent on a fresh context. | test_validation_always |
| AUT-7 | An agent may lower a task's `a` (reason in the task body), never raise it. | test_lower_only |
| AUT-8 | Effective `a = min(task a, repos.<name>.max_autonomy)`; default max 5. | test_repo_cap |

## Out of scope

- Raising autonomy automatically. [Metrics](metrics.md) may suggest it; I change the score.

## Decisions

- Urgency and importance set order; autonomy only moves gates. Validation never shrinks
  with trust.
- rust-policies: `max_autonomy = 3` (I always merge there).
