# Autonomy

**Status:** Live: AUT-3..12 · **Prefix:** AUT

## Purpose

How far an agent may take an intent before it waits for me.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| AUT-1 | Removed: plan gate for a1. a1–a3 all mean "I merge" (AUT-3). | — |
| AUT-2 | Removed: plan approval for a2. a1–a3 all mean "I merge" (AUT-3). | — |
| AUT-3 | a1–a3 (effective `a` ≤ 3, or cap ≤ 3): `gate` → `Approval` (`waiting: review and merge PR`); the PR review still runs (AUT-6) and its findings reach me as one PR comment, never blocking ([PIP-7](pipeline.md)). a1–a2 first stop at the spec (AUT-11). | test_gate_table |
| AUT-4 | a4: `gate` → `Merge` only with CI green and `review.approved` ([PIP-4, 5](pipeline.md)); `Merge` carries no `Waiting`, so no message ([LOOP-14](loop.md)). | test_gate_table |
| AUT-5 | a5: as a4 at the gate. After every merge, whoever merged, `deploy` and `e2e` follow (`machine::ORDER`; they act when the repo has `live`, [PIP-8, 9](pipeline.md)); e2e red twice → revert for Towercab's merge ([PIP-19](pipeline.md)) or triage for mine ([PIP-20](pipeline.md)): the pipeline's handlers. | test_gate_table, test_validation_always |
| AUT-6 | Validation never shrinks with trust: `machine::ORDER` runs verify, ci, verifier, review, gate before merge for every intent mission, no stage chosen by `a` (handlers: [PIP-23, 3, 4](pipeline.md)); `gate` merges an intent only with CI green and `review.approved`; a revert PR (`PrKind::Revert`, [PIP-19](pipeline.md)'s `revert_merge`) merges on CI green or none, without a review; CI not green → `waiting: revert failed`. | test_validation_always |
| AUT-7 | `autonomy::lower(&mut Intent, lower_a: Option<u8>, lower_why: Option<&str>) -> Result<bool, String>` (the worker's result, [PIP-1](pipeline.md); `lowered(a, lower_a) -> Option<u8>`, pure): `lower_a` < `a` → `a = lower_a` and `lower_why` (trimmed; empty → removed) via `Intent::set`/`remove`, every other line byte-identical; equal, higher or outside 1–5 → nothing written; no `a` → written only when `lower_a` ≤ 3. Never raised. | test_lower_only |
| AUT-8 | `RepoState { max_autonomy, capped, frozen }`, `read(&Connection, repo, &Towercab)` (the `repo_caps` row; `max_autonomy` from the base branch's `TOWERCAB.md`, [REPO-1](repo.md), default 5); `cap()` = `min(max_autonomy, 3 if capped or frozen else 5)`. `effective(a_at_pick, a_now, cap) -> Option<u8>` = min of the `a`s present and `cap`; neither → `None`. | test_repo_cap, test_max_autonomy_from_base |
| AUT-9 | No `a` (effective `None`): cap ≤ 3 → `Approval`; else `Merge` only when approved and risk low (`Review::risk_low()` = `door` two-way ∧ no red line touched, [PIP-5](pipeline.md)), else `Approval`. | test_gate_table, test_no_a_under_cap_goes_to_me |
| AUT-10 | After any revert Towercab makes, `machine::apply` sets, in its transaction, `repo_caps.capped` (`reverted, refine`) or `frozen` (`revert failed`, + `repo frozen` message): cap 3 until `towercab trust <repo>` deletes the row (`trusted <repo>`; not in `[repos]` → `trust: unknown repo <r>`, exit 1). Frozen: `pick` skips the repo (`repo <r> frozen`), `gate` → `Approval` for intents; a revert still merges. `status`: `repos: <r> capped at a3, <r> frozen`. | test_cap_after_revert, test_trust_clears |
| AUT-11 | `spec_gate(a: Option<u8>, cap, concerns: bool) -> bool` (effective `a`): a concern, `a` ≤ 2, or no `a` and cap ≤ 2 → `waiting: approve spec` ([PIP-26](pipeline.md)), then as a3. | test_spec_gate |
| AUT-12 | **Plan review** (the playbook's plan mode): `plan_gate(a: Option<u8>, cap) -> bool` (effective `a` ≤ 3, or no `a` and cap ≤ 3: where I merge anyway) → after `plan.md` is written, `waiting: approve plan` (stage `blocked`, why `a<n>` or `no a, repo cap <n>`, a `## Towercab` note with the plan's link, one message); `approve` → `build`, its first round (`pipeline::round`: an approve out of a wait that came from `plan` = `Round::First`, the build prompt, not a continue). a4–a5: no stop. | test_plan_review |

**Gate** (`src/autonomy.rs`, pure; first match wins)

```
gate(&GateIn) -> Gate
GateIn { kind: PrKind::{Intent, Revert}, frozen, cap: u8, a: Option<u8> (effective), ci: Ci::{Green, None, NotGreen},
         unlock: bool (PIP-29), evals_red: bool (PIP-33), review: Option<Review { approved, door: Door, red_lines: bool }> }
Gate::{Merge, Approval(Hold)}, waiting(PrKind) -> Option<Waiting>: an intent's Approval = review and merge PR + the findings
         comment (PIP-7); a revert's = revert failed (PIP-19)
Hold (Display = the transition's why): repo frozen · CI not green · ci: none · unlock used · evals red · cap <n> · a<n> · not approved · risk high
Revert: CI not green → Approval; else Merge (frozen too).
Intent: frozen, CI not green, ci: none, unlock, evals red, cap ≤ 3, a ≤ 3 → Approval; a ≥ 4: approved → Merge;
        no a: approved ∧ risk low → Merge; else Approval (no review = not approved).
```

## Out of scope

- Raising autonomy automatically. The dashboard's change failure rate and auto-merged share inform it; I change the score.
- The handlers that call this (design, build, review, gate, merge, revert): the pipeline intent.

## Decisions

- Urgency and importance set order; autonomy only moves gates. Validation never shrinks
  with trust.
- rust-policies: `max_autonomy: 3` in its `TOWERCAB.md` (I always merge there).
- a1–a3: I merge. a1–a2 also approve the spec (playbook: design is approved before build); a3+ only when the design flags a Concern.
- a1–a3 also approve the plan (AUT-12; playbook plan mode: the engineer reviews the plan before code). Earlier: "plan.md, no stop"; changed by me on 2026-10-25.
- Decisions in pure functions (`src/autonomy.rs`), I/O in the pipeline's handlers. `test_gate_table`, `test_spec_gate`,
  `test_no_a_under_cap_goes_to_me` test this layer; the pipeline adds its handler tests (PIP-7, 26). AUT-3's "review
  still runs" is AUT-6's; PIP-4's `test_review_on_every_pr` tests its handler.
- `effective` = min of the `a`s present: deleting `a` mid-flight can't turn a1 into a risk-judged no-`a` intent.
- Frozen counts as capped; `trust` clears both. It holds intent merges, not reverts: my `approve` of `revert failed`
  re-enters the revert at its stage (`continue_to`), which must then merge; `pause` holds reverts.
- `lower_why` is written only with a lowered `a`; it replaces an older one.
- Rehearsal PRs never reach the gate (`rehearse_close` closes them).
