# Autonomy

**Status:** Draft · **Prefix:** AUT

## Purpose

How far Towercab may take an intent before the owner decides, and what a worker may touch. The
owner sets `a` (1–5) per intent; a repo can cap it. Validation never shrinks with trust: every
intent goes through the same checks, and autonomy only decides who merges and how much access the
worker has without asking.

## Requirements

### AUT-1 · Plan gate for a1

Removed: in v1 already.

### AUT-2 · Plan approval for a2

Removed: in v1 already.

### AUT-3 · a1–a3: the owner merges

At a1 to a3 the owner merges every code PR; Towercab prepares it and waits.

- The gate ([PIP-7](pipeline.md)) sends the mission to `approval:merge` (`waiting: review and merge
  PR`). The review still runs and posts its findings on the PR, never blocking
  ([PIP-4](pipeline.md)).
- Verified by: `autonomy: gate table`

### AUT-4 · a4: Towercab merges when every check passes

At a4 Towercab merges the code PR itself, but only when CI is green, the review approved it, and
nothing in the build went beyond the approved plan.

- Gate → `merge` only with CI green, `review.approved`, and no unplanned access (AUT-15); otherwise
  `approval:merge` with the reason.
- Verified by: `autonomy: gate table`

### AUT-5 · a5: deploy and e2e

Removed: the ship stage is parked (intent 261026-2204-4). a5 now means AUT-13.

### AUT-6 · Validation never shrinks

Every intent runs verify, the red→green proof, CI, the review and the gate, whatever its autonomy.

- The stage order ([LOOP-3](loop.md)) has no stage chosen by `a`. The gate merges only with CI green
  and the review approved.
- Verified by: `autonomy: every stage runs at every level`

### AUT-7 · A worker may lower autonomy

A worker that finds the change riskier than the intent says may lower `a`, never raise it.

- From the build result (`lower_a`, `lower_why`, [PIP-1](pipeline.md)): `lower_a` below the current
  `a` (or no `a`: at most 3) → written to the intent with `lower_why`; anything else → nothing written.
- Verified by: `autonomy: a worker only lowers a`

### AUT-8 · Repo cap

A repo can cap the autonomy of every intent in it.

- `max_autonomy` (1–5, default 5) in the base branch's `TOWERCAB.md` ([REPO-1](repo.md)).
  Effective `a` = the minimum of `a` at pick, `a` now, and the cap; no `a` anywhere → none.
- Verified by: `autonomy: repo cap`

### AUT-9 · No autonomy set

An intent without `a` merges on its own only when the repo allows a4 or more and the review judges
the change low-risk.

- Cap ≤ 3 → `approval:merge`. Else merge only when approved and low-risk (the review's `door` is
  `two-way` and no red line of `REVIEW.md` is touched, [PIP-5](pipeline.md)), else `approval:merge`.
- Verified by: `autonomy: no a goes to the owner under the cap`

### AUT-10 · Caps after a revert

Removed: reverts are parked with the ship stage.

### AUT-11 · Spec gate

The owner approves the spec PR at a1–a2, or whenever the design raises a concern; otherwise
Towercab merges it once its checks pass.

- `specGate(a, cap, concerns)`: a concern, effective `a` ≤ 2, or no `a` and cap ≤ 2 → the owner
  merges the spec PR (`approval:spec`). Else Towercab merges it after its CI is green or absent
  ([PIP-50](pipeline.md)).
- Verified by: `autonomy: spec gate`

### AUT-12 · Plan gate

The owner approves the plan PR at a1–a4; at a5 Towercab merges it itself.

- `planGate(a, cap, source)`: effective `a` ≤ 4, or no `a` → the owner merges the plan PR
  (`approval:plan`); merging it also grants the access ticked in it (AUT-14).
- Verified by: `autonomy: plan gate`

### AUT-13 · a5 only for the owner's own intents

Full autonomy applies only to intents the owner wrote; an intent from anywhere else counts as a4.

- Effective `a` = 5 only when the intent's `source` is `me` (or missing: the owner's file);
  any other `source` → at most 4.
- Verified by: `autonomy: a5 needs source me`

### AUT-14 · Access by autonomy

What a worker may reach without asking depends on the effective autonomy.

| | a1–a3 (owner merges) | a4 | a5 |
|---|---|---|---|
| Network | default list + plan + requests | default list + plan | open |
| Protected paths ([REPO-8](repo.md)) | writable, listed in the PR | only those the plan grants | writable |
| Mid-build request | granted, noted in the PR | granted, PR goes to the owner (AUT-15) | not needed |

- Default network list: `[agent].network` (default: `registry.npmjs.org`, `*.npmjs.org`,
  `pypi.org`, `files.pythonhosted.org`, `crates.io`, `*.crates.io`, `proxy.golang.org`,
  `sum.golang.org`, `github.com`, `*.github.com`, `*.githubusercontent.com`, `docs.rs`,
  `nodejs.org`, `developer.mozilla.org`).
- Plan grants: the ticked boxes in the merged plan's Access section ([PIP-47](pipeline.md)), plus
  the intent's own `unlock` and `network` fields.
- Verified by: `autonomy: access by level`

### AUT-15 · Unplanned access

When a worker needs access the plan didn't grant, Towercab grants it and keeps building; at a4 the
code PR then waits for the owner instead of merging.

- The worker returns `status: access` with the domains or paths and why ([PIP-1](pipeline.md)).
  Towercab adds them to the mission's grants, records `data.unplanned` (what and why), and resumes
  the worker. The code PR lists them under "Access beyond the plan". At a4 the gate then goes to
  `approval:merge`, why `access beyond the plan`.
- Verified by: `autonomy: unplanned access at a4 goes to the owner`,
  `autonomy: unplanned access at a1-a3 is granted`

## Out of scope

- Raising autonomy automatically.
- Repo caps after a revert (parked with the ship stage).

## Decisions

- Urgency and importance set the order; autonomy only moves gates and access.
- Access follows who merges: when the owner reads every diff before it lands (a1–a3), asking for
  access mid-build only costs time. The locks matter when Towercab merges on its own.
- Access is asked for in the plan, so the wait happens before the build, when the owner is reviewing
  anyway, not in the middle of it.
- a5 is limited to `source: me` because open network, editable CI and auto-merge together would let a
  planted instruction in an issue change CI and merge itself.
- The decisions are pure functions in `src/autonomy.ts`; the pipeline's handlers do the I/O.
- `effective` takes the minimum of the `a`s present, so removing `a` mid-flight can't loosen a gate.
