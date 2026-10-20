# Autonomy

**Status:** Draft (Rust rewrite) · **Prefix:** AUT

## Purpose

How far an agent may take an intent before it waits for me.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| AUT-1 | Removed: plan gate for a1. a1–a3 all mean "I merge" (AUT-3). | — |
| AUT-2 | Removed: plan approval for a2. a1–a3 all mean "I merge" (AUT-3). | — |
| AUT-3 | a1–a3: the PR waits for my merge; the PR review still runs and its findings reach me as one PR comment, never blocking ([PIP-4, 7](pipeline.md)). a1–a2 first stop at the spec ([AUT-11](autonomy.md)). | test_gate_table, test_review_on_every_pr |
| AUT-4 | a4: merges itself after green CI and an approving review ([PIP-4, 7](pipeline.md)); no message ([LOOP-14](loop.md)). | test_gate_table |
| AUT-5 | a5: as a4. Every merge into a repo with `live` gets deploy and e2e ([PIP-8, 9](pipeline.md)); red twice → revert ([PIP-19](pipeline.md)) or triage ([PIP-20](pipeline.md)). | test_gate_table |
| AUT-6 | Validation never shrinks with trust: verify ([PIP-23](pipeline.md)) and CI at every level; a PR review on every intent PR ([PIP-4](pipeline.md)); revert PRs ([PIP-19](pipeline.md)) merge on green CI without one. | test_validation_always |
| AUT-7 | The worker may lower an intent's `a` via `lower_a` + `lower_why` in its result ([PIP-1](pipeline.md)): Towercab writes `a = min(a, lower_a)` to `intent.md` and `lower_why` to `intent.md`; a higher value is ignored; on an intent without `a`, a `lower_a` ≤ 3 is written. Never raised. | test_lower_only |
| AUT-8 | Repo cap = `min(max_autonomy` from the base branch's `TOWERCAB.md` ([REPO-1](repo.md)), default 5; 3 while capped after a revert (AUT-10)`)`. Effective `a = min(a at pick, a now, cap)`; no `a` stays none. | test_repo_cap, test_max_autonomy_from_base |
| AUT-9 | No `a` on the intent: cap ≤ 3 → I merge (review findings as a comment, [PIP-7](pipeline.md)); otherwise the review also judges risk: approved and risk low (two-way door, no red line touched) merges, else it waits for me ([PIP-5, 7](pipeline.md)). | test_gate_table, test_no_a_under_cap_goes_to_me |
| AUT-10 | After any revert Towercab makes ([PIP-19, 20](pipeline.md)) the repo's autonomy cap is 3 until `towercab trust <repo>`; a frozen repo (failed revert) takes no picks or merges until then. Stored in SQLite, shown in `status`. | test_cap_after_revert, test_trust_clears |
| AUT-11 | a1–a2 (or no `a` in a repo capped at ≤ 2): design stops for my approval of the spec ([PIP-26](pipeline.md)), then as a3. Any level: a design that flags a Concern stops too. | test_spec_gate |

## Out of scope

- Raising autonomy automatically. The dashboard's change failure rate and auto-merged share inform it; I change the score.

## Decisions

- Urgency and importance set order; autonomy only moves gates. Validation never shrinks
  with trust.
- rust-policies: `max_autonomy: 3` in its `TOWERCAB.md` (I always merge there).
- a1–a3: I merge. a1–a2 also approve the spec (playbook: design is approved before build); a3+ only when the design flags a Concern.
