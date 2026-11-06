# Autonomy

**Status:** Live: AUT-1..21 · **Prefix:** AUT

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
  PR`). The review still runs and posts its findings on the PR; one that doesn't approve first gets
  its fix rounds ([PIP-98](pipeline.md)).
- Verified by: `autonomy: gate table`

### AUT-4 · a4: Towercab merges when every check passes

At a4 Towercab merges the code PR itself, but only when CI is green, the review approved it, nothing
in the build went beyond the approved plan, and its risk is low.

- Gate → `merge` only with CI green, `review.approved`, no unplanned access (AUT-15) and a `low` risk
  (AUT-18); otherwise `approval:merge` with the reason.
- Verified by: `autonomy: gate table`, `autonomy: risk decides the gates at a4 and a5`

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
  `a` (no `a` counts as 5, AUT-9) → written to the intent with `lower_why`; anything else → nothing
  written.
- Verified by: `autonomy: a worker only lowers a`

### AUT-8 · Repo cap

A repo can cap the autonomy of every intent in it.

- `max_autonomy` (1–5, default 5) in the base branch's `TOWERCAB.md` ([REPO-1](repo.md)).
  Effective `a` = the minimum of `a` at pick, `a` now, and the cap; no `a` anywhere → 5 (AUT-9),
  then the cap.
- Verified by: `autonomy: repo cap`

### AUT-9 · No autonomy set

An intent without `a` counts as a5: full autonomy, still limited by the repo's cap and, for intents
the owner didn't write, by AUT-13.

- `effectiveA`: no `a` at pick and none now → `DEFAULT_A` = 5, then the minimum with the repo cap
  (AUT-8), then at most 4 when `source` isn't `me` (AUT-13). An `a` present at pick or now still counts,
  so removing it mid-flight can't loosen a gate.
- Verified by: `autonomy: no a counts as a5`, `pipeline: an intent without a runs as a5`

### AUT-10 · Caps after a revert

Removed: reverts are parked with the ship stage.

### AUT-11 · Spec gate

The owner approves the spec PR at a1–a2, when the second reviewer leaves open points for the owner,
or when its risk is too high for the intent's autonomy; otherwise Towercab merges it once its checks
pass.

- `specGate(a, openPoints, risk)`: effective `a` ≤ 2, any open point ([PIP-97](pipeline.md)), or
  `riskWaits(a, risk)` (AUT-18, with a3 counting like a4) → the owner merges the spec PR
  (`approval:spec`, why: `The spec leaves <n> questions for you to settle before it is built.`, or
  the risk's reason; PIP-110). Else Towercab
  merges it after its CI is green or absent ([PIP-50](pipeline.md)). The design's own concerns no
  longer stop the spec on their own: the second reviewer reads them and keeps the ones the owner must
  decide as open points.
- Verified by: `autonomy: spec gate`, `pipeline: open points send the spec to the owner`

### AUT-12 · Plan gate

The owner approves the plan PR at a1–a3; at a4 and a5 Towercab merges it itself unless its risk is
too high for the intent's autonomy.

- `planGate(a, risk)`: effective `a` ≤ 3, or `riskWaits(a, risk)` (AUT-18) → the owner merges the plan
  PR (`approval:plan`, why: the risk's reason at a4 and a5); merging it also grants the access ticked
  in it (AUT-14). The access rules of AUT-14 and AUT-15 apply to a plan Towercab merged as to one the
  owner merged.
- Verified by: `autonomy: plan gate`, `autonomy: a4 medium risk waits at spec, plan and merge`

### AUT-13 · a5 only for the owner's own intents

Full autonomy applies only to intents the owner wrote; an intent from anywhere else counts as a4.

- Effective `a` = 5 only when the intent's `source` is `me` (or missing: the owner's file);
  any other `source` → at most 4.
- Verified by: `autonomy: a5 needs source me`

### AUT-14 · Access by autonomy

What a worker may reach without asking depends on the effective autonomy.

| | a1–a3 (owner merges) | a4 | a5 |
|---|---|---|---|
| Network | default list + plan + requests | default list + plan | default list + plan + requests (never open, AUT-26) |
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
  `approval:merge`, why `The agent needed access the approved plan didn't grant.`
- Verified by: `autonomy: unplanned access at a4 goes to the owner`, `autonomy: unplanned access at a1-a3 is granted`

### AUT-16 · Every change gets a risk level

Every spec, plan and code change is judged on three questions, and the answers give it a risk level of
low, medium or high.

- The questions: **blast radius** (who or what is affected if it goes wrong: `small`, `medium`,
  `large`), **door** (`one-way` when it is hard to undo: data, migrations, public interfaces,
  deletions; else `two-way`) and **certainty** (how sure we are it behaves as expected after
  deployment: `high`, `medium`, `low`, from what is tested and what depends on the environment). Each
  answer carries a plain sentence.
- The risk agent answers them at the spec, plan and code gates ([PIP-96](pipeline.md)) and proposes
  the `level`; code applies the floor (AUT-17). Kept per gate in `missions.data.risk.<spec|plan|code>`
  (`level`, `said`, `raised`, `blast`, `door`, `certainty`, `summary`, `openPoints`, `of`).
- Verified by: `risk: three answers give a level`, `pipeline: risk is assessed at each gate`

### AUT-17 · The level has a floor

The answers set a lowest level that the agent's own judgment can raise but never lower.

- `riskFloor` (`src/risk.ts`): each of a one-way door, a large blast radius and low certainty makes
  the level at least medium; two or more of them make it high. At the code gate the review's verdict
  ([PIP-5](pipeline.md)) counts too: its `door: one-way` is a one-way door, and a touched red line of
  `REVIEW.md` makes the level high. The kept level is the higher of the agent's and the floor;
  `raised` says why when the floor won (`Raised from low to medium: it is hard to undo.`).
- A plan that asks for access beyond the defaults is at least medium: any protected path, or any
  domain not in `[agent].network`. Merging a plan grants its ticked access (AUT-14), so at a4 a person
  sees every grant before it is made; at a5 medium still goes ahead, as before. This raises the level
  without counting toward the "two or more" rule.
- Verified by: `risk: the floor raises the level`, `autonomy: a4 plan asking for protected paths waits`

### AUT-18 · Risk decides the gates at a4 and a5

At a4 only a low-risk change goes ahead without the owner; at a5 low and medium risk go ahead and only
high risk waits. This holds at the spec, plan and merge gates alike.

| | spec | plan | merge |
|---|---|---|---|
| a1–a2 | owner | owner | owner |
| a3 | owner on medium and high | owner | owner |
| a4 | owner on medium and high | owner on medium and high | owner on medium and high |
| a5 | owner on high | owner on high | owner on high |

- `riskWaits(a, level)`: a5 → `high`; below → `medium` or `high`. The wait's why says it:
  `It is medium risk, and at autonomy a4 only low-risk changes go ahead without you.`, `It is high
  risk, and at autonomy a5 low- and medium-risk changes go ahead without you.` CI, the review, the proof and the access rules (AUT-14, AUT-15) still hold first
  at the merge gate ([PIP-7](pipeline.md)).
- Verified by: `autonomy: risk decides the gates at a4 and a5`, `autonomy: a4 medium risk waits at spec, plan and merge`, `autonomy: a5 high risk waits for the owner`

### AUT-19 · No assessment, no going ahead alone

When the risk check can't give an answer, the owner decides.

- A risk run that fails after its one continue ([PIP-1](pipeline.md)) is kept as `null` for the
  thing it was to assess; the gate then waits for the owner at every level (why: `The risk check
  didn't finish, so you decide whether it goes ahead.`). An assessment of an older spec head, plan or diff counts as none.
- Verified by: `autonomy: no risk assessment goes to the owner`, `pipeline: a risk check that doesn't finish leaves the gate to the owner`

### AUT-20 · The owner sees the risk

The level and the three answers, in plain words, are in each PR Towercab opens and on the page.

- `riskWords`: the label (`Medium risk`) and one line per answer: `Affects few|some|many: <who>`,
  `Easy to undo: <why>` or `Hard to undo: <why>`, `Sure|Fairly sure|Not very sure it works once
  live: <why>`. PR bodies get a `## Risk: <level>` section ([PIP-99](pipeline.md)). The needs-you
  card shows a risk chip and the three lines for the gate it waits at (spec card → the spec's risk,
  plan → the plan's, code → the code's; other cards the latest), and a spec card lists the open
  points; the intent page shows the latest risk when no card is shown. Only an assessment of the
  current change shows (`currentRisk`: `riskOf.<gate>` equals `riskKey`, [PIP-96](pipeline.md)), so a
  revised spec, plan or diff never shows an older risk or older open points.
- Verified by: `risk: plain words for the owner`, `ui: the card shows the risk`

### AUT-21 · A retry runs a risk check that didn't finish again

When a gate waits only because its risk check didn't finish, the owner's retry runs that check again
in the same attempt instead of starting over.

- `recheck(m)`: at `approval:spec`, `approval:plan` or `approval:merge` whose current assessment is
  `null` (AUT-19), a `/retry` on the waiting PR, Retry on its card (which posts `/retry`) or `towercab
  retry` gives the event `recheck` instead of `retry_fresh`. It clears `risk.<gate>` and
  `riskOf.<gate>` and moves back: spec → `design`, plan → `plan` (both with `data.recheck`, so they
  run the gate's checks and risk check, not a new design or plan), code → `review` (the review
  stands, the risk check runs). Any other retry starts a fresh attempt as before ([LOOP-15](loop.md)).
- Verified by: `pipeline: a retry runs a risk check that didn't finish again`, `machine: every stage and event pair is defined`

### AUT-26 · The network is never fully open

At no autonomy level can a worker reach the whole internet; it reaches the domains it is granted and no others.

- The "open" network of a5 in AUT-14 is removed: a5 gets the default list, the plan's grants and mid-build requests, like a1–a3, all through the allowlist proxy ([PIP-158](pipeline.md)). `WebFetch(domain:*)` is no longer written to a Claude run's settings (PIP-24).
- The default list is a constant in code, no longer `[agent].network`; a config that still sets it loads, and `towercab doctor` names the key as ignored ([PIP-157](pipeline.md)). With no grant at all, the network is off.
- Verified by: `autonomy: a5 has no open network`, `autonomy: the default network list is fixed in code`, `claude: settings never allow every domain`

### AUT-27 · A grant can only name a domain

Every grant of network access, from a plan, a request or an intent, is a domain name and nothing wider.

- A grant that fails the rule of [PIP-164](pipeline.md) is not added to the mission's grants. A plan with one waits at the plan gate with the reason; a mid-build request with one is answered as refused and the worker continues without it, noted in the PR.
- At a4 and a5 an invalid grant never merges on its own: the gate waits for the owner.
- Verified by: `autonomy: an invalid grant in a plan waits for the owner`, `autonomy: an invalid mid-build request is refused`

## Out of scope

- Raising autonomy automatically.
- Repo caps after a revert (not built; the ship stage itself is live, [SHIP-12](ship.md)).
- Tracking how often the owner overrides the risk gate (parked for a later batch).

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
- Risk instead of concerns (the owner's call, 2026-10-30): any design concern used to stop the spec,
  so most specs waited. Now an independent agent judges the risk at every gate, and the level, not the
  existence of a concern, decides at a4 and a5. No `a` means a5 for the same reason: the risk gate is
  what protects a change, not the missing number.
- The risk agent is never the run that wrote the change: a session of its own on the review model,
  read-only, like the review. One run at the spec does both jobs, the risk and the second review,
  since both read the same spec and concerns.
- The level has a floor in code so that a one-way door or a red line can't be talked down to low by
  the agent. A red line is the repo owner's own list of what must not change unseen, so touching one
  is high, which waits even at a5.
- a3 counts like a4 at the spec gate: a lower `a` must never be looser than a higher one, and a3's
  spec used to merge on its own whenever nothing stopped it.
