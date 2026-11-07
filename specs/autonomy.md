# Autonomy

**Status:** Live: AUT-1..21, AUT-31..33 · **Prefix:** AUT

## Purpose

How far Towercab may take an intent before the owner decides, and what a worker may touch. The
owner sets `a` (0–5) per intent; a repo can cap it. Validation never shrinks with trust: every
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

- From the build result (`lower_a`, `lower_why`, [PIP-1](pipeline.md)): `lower_a` (0–5) below the current
  `a` (no `a` counts as 5, AUT-9) → written to the intent with `lower_why`; anything else → nothing
  written.
- Verified by: `autonomy: a worker only lowers a`

### AUT-8 · Repo cap

A repo can cap the autonomy of every intent in it.

- `max_autonomy` (1–5, default 5) in the base branch's `TOWERCAB.md` ([REPO-1](repo.md)).
  Effective `a` = the minimum of `a` now (the intent's current level, AUT-34) and the cap; no `a` → 5
  (AUT-9), then the cap. While a raise is flagged (AUT-35), `a` now means the level before that raise.
  A raise therefore applies from the mission's next gate, and a lowering applies at once. It no longer
  looks at `a` at pick.
- Verified by: `autonomy: repo cap`

### AUT-9 · No autonomy set

An intent without `a` counts as a5: full autonomy, still limited by the repo's cap and, for intents
the owner didn't write, by AUT-13.

- `effectiveA`: no `a` at pick and none now → `DEFAULT_A` = 5, then the minimum with the repo cap
  (AUT-8), then at most 4 when `source` isn't `me` (AUT-13). Removing `a` mid-flight is a raise to
  that default (AUT-35): it counts when the owner does it and is flagged otherwise, so a stranger deleting
  the line can't loosen a gate. The risk gate (AUT-18) protects the change either way.
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
- With `[auth]` set, [AUT-23](autonomy.md) decides instead.
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
- Draft change: AUT-26 and AUT-27 replace the "open" network of a5 and the granted mid-build requests
  of this table. The code PR switches this row in the same commit as the code.
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
- Draft change: AUT-27 replaces the automatic grant with a question to the owner. The code PR switches
  this row in the same commit as the code.
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

### AUT-22 · A gate waits for a maintainer of that repo

When users are set up, a gate that waits for "the owner" waits for any maintainer or admin of the intent's repo, and the first valid decision wins.

- With `[auth]` set ([users.md](users.md)), "the owner" in AUT-12, AUT-18 and AUT-20 means a person for whom `can(user, "approve", repo)` holds (USR-1, USR-5); their approval on the page, GitHub (USR-9) or Telegram (USR-11) moves the mission through `machine.apply`, and a second decision on the same gate finds it already handled and changes nothing.
- A contributor or viewer cannot clear a gate; with no such person for the repo, the card says so and names the admins.
- Verified by: `autonomy: any maintainer of the repo can decide a gate`, `autonomy: a second decision on a handled gate changes nothing`, `autonomy: a contributor cannot clear a gate`

### AUT-23 · Full autonomy for intents an admin or maintainer wrote or confirmed

Full autonomy (a5) applies only to intents written or confirmed by an admin or a maintainer of that repo.

- Replaces AUT-13's "source is `me`" when `[auth]` is set. Effective `a` = 5 only when the intent's author, or the person who confirmed it on the page, GitHub or Telegram, is an admin or has the maintainer role on the intent's repo at the time of the gate; an intent from a contributor or from any other source stays at most a4 until one of them confirms it. The confirmation is recorded on the timeline (USR-8).
- Without `[auth]`, AUT-13 is unchanged.
- Verified by: `autonomy: a5 needs an admin or maintainer author or confirmer`, `autonomy: a contributor's intent is at most a4`, `autonomy: a confirmation by a maintainer lifts it to a5`, `autonomy: a5 follows the role at the gate`

### AUT-24 · Raising autonomy needs a maintainer of that repo

A raise of an intent's autonomy counts only from an admin or a maintainer of that repo.

- Replaces "the owner's login" in AUT-35 when `[auth]` is set: a raise from the page counts when the signed-in person can `raise` (maintainer on the repo, or admin); a push to the intents repo counts when its verified GitHub account is such a user (the same verified-account rule as AUT-35). Any other raise is flagged, naming the account, and does not take effect; accepting a flag needs the same role.
- Lowering stays open to the same people and applies at once (AUT-34). Contributors and viewers can't raise or lower.
- Verified by: `autonomy: a maintainer's raise counts`, `autonomy: a contributor's raise is flagged`, `autonomy: a push is judged by the user's role`

### AUT-25 · a0 stays with admins

An a0 intent can be decided only by an admin.

- With `[auth]` set, AUT-31's "only the owner decides" means admins: a maintainer's approval, answer or autonomy change on an a0 intent is refused with "only an admin can decide an a0 intent"; the shadow and the command line follow the same rule as in AUT-31.
- Verified by: `autonomy: a maintainer cannot decide an a0 intent`, `autonomy: an admin decides an a0 intent`

### AUT-26 · The network is never fully open

At no autonomy level can a worker reach the whole internet; it reaches the domains it is granted and no others.

- The code PR removes the "open" network of a5 in AUT-14: a5 gets the default list and the plan's grants, like every level, all through the allowlist proxy ([PIP-158](pipeline.md)). Every domain beyond the default list comes from an approved plan, the intent's own `network` field or an owner's answer (AUT-15); no level grants a mid-build request on its own. `WebFetch(domain:*)` is no longer written to a Claude run's settings (PIP-24).
- The default list is a constant in code, no longer `[agent].network`; a config that still sets it loads, and `towercab doctor` names the key as ignored ([PIP-157](pipeline.md)). With no grant at all, the network is off.
- Verified by: `autonomy: a5 has no open network`, `autonomy: the default network list is fixed in code`, `claude: settings never allow every domain`

### AUT-27 · A grant can only name a domain

Every grant of network access, from a plan, a request or an intent, is a domain name and nothing wider.

- A grant that fails the rule of [PIP-164](pipeline.md) is not added to the mission's grants. A plan with one waits at the plan gate with the reason; a mid-build request with one is refused without asking the owner, and the worker continues without it, noted in the PR.
- At a4 and a5 an invalid grant never merges on its own: the gate waits for the owner.
- A valid mid-build request is never granted by Towercab itself, at every level, a5 included. Like an unplanned test change (PIP-116), the mission waits with a question (PIP-110) that names each domain or path and why, with the options `Allow this access` and `No, finish without it` and a recommendation. The answer is read as a choice (PIP-138, PIP-139): allow → the grants join the mission's (`by: owner`) and the worker resumes with them; refusal → they are recorded in `data.refusedAccess`, the worker resumes told to finish without them, and asking again for a refused one is refused at once.
- Allowed requests are recorded in `data.unplanned` and listed under "Access beyond the plan". At a4 the gate still goes to `approval:merge` with AUT-15's reason, even though the owner allowed it: the plan the owner approved is not the plan that was built.
- The code PR switches AUT-14 and AUT-15 (and replaces the a1–a3 test `autonomy: unplanned access at a1-a3 is granted`), PIP-24 (no `WebFetch(domain:*)`, repo variables), PIP-95 and PIP-116 (wording), LOOP-34 (cache env), LOOP-69 (the `env` refusal) and the config table of loop.md (ignored keys), each in the same commit as the code.
- Verified by: `autonomy: an invalid grant in a plan waits for the owner`, `autonomy: an invalid mid-build request is refused`, `autonomy: unplanned access asks the owner at every level`, `autonomy: allowing unplanned access grants it`, `autonomy: a refused access stays refused`

### AUT-31 · a0: only the owner decides

An intent set to `a0` is decided by the owner alone: every wait goes to them and nothing goes ahead without them.

- `a: 0` is valid in the intent's front matter like any other level (the range is 0–5). At a0 every wait goes to the owner: a question (PIP-110), the spec gate (AUT-11), the plan gate (AUT-12), a test change or unplanned access (PIP-116, AUT-15), the merge (AUT-3) and the owner's steps (SHIP-17). Towercab never merges, approves or answers on its own at a0, whatever the risk level or the repo's cap (AUT-8).
- a0 is a rule that Towercab's own shadow, agents and CLI follow, not a security boundary: see Decisions.
- Validation does not shrink (AUT-6): the checks, the proof, CI and the review all run at a0, as at a1.
- `effective` still takes the lowest `a` present (AUT-7), so nothing can raise an a0 intent; a worker may still lower to a0, never out of it. An `a` of 0 is not "unset": AUT-9 applies only when `a` is missing.
- Access (AUT-14) at a0 is that of a1–a3.
- The repo cap (AUT-8) stays 1–5: a repo cannot set a0 for others. The field list in `intents.md` still says `a` is 1–5; it is switched to 0–5 in a later spec commit, and the code already reads 0.
- Verified by: `autonomy: a0 waits at every gate`, `autonomy: a0 is never raised`, `autonomy: a0 ignores risk and cap`, `intents: a is 0 to 5`

### AUT-32 · At a0 only the owner's own replies count

On an a0 intent only the owner's own replies and actions count; the shadow, other agents and other accounts cannot answer or approve.

- Two channels count: the owner's GitHub login as in PIP-44, and the local page (`POST /api/actions` with `actor: owner`, UI-65). Telegram never counts, because it goes through the shadow: a message there, a `yes` included (SHD-10), is not an answer, an approval, a merge, a drop, a start or a boost of an a0 intent. The command line never counts either (AUT-33). The shadow may tell the owner where to answer and link the intent's page or PR (SHD-21).
- A shadow action (SHD-19) aimed at an a0 intent is refused with the reason "this intent is only yours" and recorded as refused (SHD-12, UI-237), except the pause of SHD-22. It is never held for a `yes`.
- A comment, review or reply from any other account, the App's bot or an agent is ignored as in PIP-44 and, at a0, also noted once on the intent's timeline (who, where, that it was ignored). Notes are not repeated for the same comment.
- Nothing the shadow or an agent says is read as an answer to a question, an approval of a spec or plan, a choice for test or network access, or a merge.
- Verified by: `autonomy: a0 ignores replies from other accounts and notes them`, `autonomy: telegram never answers an a0 intent`, `shadow: an a0 intent is refused`, `events: only the owner's comments count`

### AUT-33 · The command line cannot decide for an a0 intent

The command line refuses to answer, approve, start, drop or tick steps on an a0 intent, because it cannot tell the owner from an agent using it.

- On an intent whose effective `a` is 0 (AUT-31), these commands (LOOP-15) print one line and change nothing: `answer`, `approve`, `start`, `drop`, `step`, plus `done`, `retry` and the per-intent `resume` (SHD-22). The line is `towercab: <id> is only yours: use GitHub or the page`, exit 1 (LOOP-15). The check runs before any `commands` row is written, with a loop running or not.
- The loop applies a `commands` row for an a0 intent only when it came from the page (`by: page`); a row from the CLI is dropped and noted on the intent's timeline (AUT-32), so a row written straight into the database does not get around the check.
- Still allowed on an a0 intent: `status`, `next`, `logs`, `ui`, `doctor` and `towercab pause` (global, or for the intent as in SHD-22), since none of them answers, approves or advances anything.
- Verified by: `cli: an a0 intent refuses answer approve start drop and step`, `cli: pause and status work on an a0 intent`, `commands: an a0 command row from the cli is dropped`

### AUT-34 · The owner changes an intent's autonomy

An intent's autonomy can be moved to any level from a0 to a5 and back, and the running mission follows from its next gate.

- The change sets `a` in the intent file with `setField` (INT-24's front matter; every other line stays byte-identical) and is one commit to the intents repo, pushed like any intent edit. Setting the level it already has writes nothing.
- Any level 0–5 is valid, including from and to a0 (AUT-31). The repo cap (AUT-8) still applies at the gate, so a5 on a repo capped lower behaves as the cap says.
- The effective level (AUT-8) is the intent's current `a`, read when a gate decides (the spec, plan and merge gates), never a copy taken at start or pick. A raise applies from the mission's next gate; a lowering applies at once. A gate already waiting is decided again on the next loop pass: lowering to a1 keeps it waiting for the owner, raising to a4 or a5 lets it go on if AUT-4 or AUT-13 would. Work already done is not redone.
- A worker's `lower_a` (AUT-7) and the owner's change write the same field; the last one written wins.
- Each change is recorded on the intent's timeline (who, from → to, through which channel).
- Verified by: `autonomy: changing a writes only the a line in one commit`, `autonomy: a running mission uses the new level at its next gate`, `autonomy: a lowering applies at once`, `autonomy: a waiting gate is decided again after a change`, `autonomy: setting the same level writes nothing`

### AUT-35 · Raising autonomy counts only from the page or the owner's GitHub account

A raise of an intent's autonomy counts only when the owner makes it on the web page or pushes it to the intents repo from their own GitHub account; any other raise is flagged and does not take effect.

- The channels for raising are the local page (`POST /api/actions` with `actor: owner`, UI-65, as in AUT-32) and GitHub. There is no command for it on the command line and no shadow action: the shadow (SHD-19) refuses a request to raise with the reason "only you can raise autonomy", recorded as refused (SHD-12, UI-237). A `commands` row that raises and did not come from the page (`by: page`) is dropped and noted on the timeline (AUT-32). Raising from a0 is no different from any other raise.
- A push to the intents repo counts as the owner's raise when the pushing GitHub account is the owner's login (PIP-44), wherever the push was made. Towercab checks the account, from the verified login of the commit's author or pusher as GitHub reports it, never the local `user.name` or e-mail in the commit, which anyone can set. A commit whose account cannot be verified does not count.
- When the loop syncs the intents repo and finds `a` higher than the last level it accepted, and the commit that raised it does not count, it flags the raise and writes no commit back. The flag keeps who raised it (account, or `unknown`), from → to, and the commit. A first value on a new intent, and an `a` that was missing and is set, are not raises.
- Deleting the `a:` line from an intent that had one is a raise to the level the intent then gets (a5, or a4 when `source` isn't `me`, AUT-9, AUT-13), and is judged like any other raise: from the owner's account it counts, from any other it is flagged and the mission keeps the level it had. Deleting the line when the intent already runs at that default, or a level above it, raises nothing. The page never deletes the line: it always writes a level (UI-257).
- While a raise is flagged the mission uses the lower level (the one before the raise, AUT-8). Flagging is noted once on the intent's timeline (AUT-32) and shows a Needs-you card naming who raised it (UI-258).
- A flag ends when the owner accepts the raise or sets the level back on the page (UI-257, UI-258), or when `a` is lowered to or below the accepted level by any channel. Accepting makes the raise count from the next gate.
- Lowering is done by the owner on the page or on GitHub, like a raise, and applies at once (AUT-34); it is not held for a confirmation or a `yes`. A worker's `lower_a` (AUT-7) stays as it is. No new command-line command or shadow action lowers.
- Like a0, this is a rule Towercab's own shadow, agents and CLI follow, not a security boundary (see Decisions): the owner's `gh` login on this machine cannot be told from the owner.
- Verified by: `autonomy: the page raises a`, `autonomy: a shadow raise is refused`, `autonomy: a raising command row from the cli is dropped`, `autonomy: a raise by the owner on github counts`, `autonomy: a push is judged by the verified github account`, `autonomy: a raise by another account is flagged and not written back`, `autonomy: deleting the a line by another account is flagged as a raise to the default`, `autonomy: deleting the a line by the owner counts`, `autonomy: a flagged raise runs at the lower level`, `autonomy: accepting a flagged raise lifts the flag`

## Out of scope

- Raising autonomy automatically.
- Repo caps after a revert (not built; the ship stage itself is live, [SHIP-12](ship.md)).
- Tracking how often the owner overrides the risk gate (parked for a later batch).

## Decisions

- Urgency and importance set the order; autonomy only moves gates and access.
- No automatic mid-build grants (the owner's call, 2026-11-06): a worker cannot widen its own network
  or path access. Every domain beyond the registry list comes from an approved plan, the intent or an
  owner's answer. Conservative defaults taken: the same holds for paths, not only domains; an access
  the owner allowed mid-build still sends an a4 PR to the owner; a refused request stays refused for
  the mission; and an invalid domain is refused without asking.
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
- Owner-only means GitHub or the page (the owner's calls, 2026-11-06): Telegram goes through the
  shadow and the CLI is used by agents acting for the owner, so neither can tell the owner from an
  agent. Conservative defaults taken: `done`, `retry` and per-intent `resume` are refused on the CLI
  like `answer` (they clear a wait the owner should clear); `status`, `next`, `logs`, `ui`, `doctor` and
  `pause` stay open because they only read or stop things; a `commands` row from the CLI is dropped by
  the loop, not only refused up front, so the database is not a back door. A pause is the only thing
  the shadow may do on an a0 intent, and only when the owner asks.
- a0 is a rule, not a security boundary (the owner's call, 2026-11-06): Towercab's own shadow, agents
  and CLI follow it and are refused. Any agent on this machine can also act on GitHub through the
  owner's `gh` login, which Towercab cannot tell from the owner, and a confirmation step on GitHub
  would be no stronger. So the page and GitHub count, and no extra proof of identity is built for
  them. a0 does not stop a process that deliberately uses that login or edits the intents repo or the
  database by hand.
- Changing autonomy (the owner's calls, 2026-11-07): a raise applies from the next gate and a lowering
  at once; a raise by another account is flagged, not written back, and the mission keeps the lower
  level; the pushing GitHub account is checked, not the commit's local name; no command-line command
  for either direction; raising is confirmed on the page, lowering is one click; deleting the `a` line
  is a raise to the default. Conservative defaults taken: a worker's `lower_a` stays; a commit whose
  account can't be verified doesn't count as the owner's; the page never deletes the line; and a
  deletion that doesn't raise the level (the intent already runs at the default or above) is not flagged.
- a3 counts like a4 at the spec gate: a lower `a` must never be looser than a higher one, and a3's
  spec used to merge on its own whenever nothing stopped it.
