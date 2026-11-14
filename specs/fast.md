# Fast lane

**Status:** Draft · **Prefix:** FAST

## Purpose

Some intents cannot wait their turn: a broken production page, a fix the owner needs today. The owner
puts such an intent in the fast lane, and Towercab takes it from idea to merged code without queuing
behind other work and without stopping for questions or approvals that carry no real risk. Fast means no
waiting, never fewer safeguards.

## Requirements

### FAST-1 · The owner puts an intent in the fast lane

The owner marks an intent as fast lane from the page, the command line or Telegram, when adding it or later, and can take it out again.

- Stored as `fast: true` in the intent's front matter ([INT-2](intents.md)); written and removed with `setField` / `removeField`, one commit to the intents repo like any intent edit, every other line byte-identical. Setting what is already set writes nothing.
- Command line: `towercab add "<repo>: <title>" [uN] [iN] [aN] --fast`, `towercab fast <id>` and `towercab fast <id> --off`. Page: `POST /api/actions` `{action: "set-fast", id, fast}` (UI-66, `actor: owner`). Telegram: `/fast <id>` and `/fast <id> off`, from the owner's chat only (FAST-9).
- Refused with the reason when the intent is done or dropped (`fast: <id> is done or dropped`) or is an a0 intent from any channel but the page (AUT-31, AUT-33: `fast: <id> is a0, only you decide it on the page`).
- Each change is recorded on the intent's timeline (who, on or off, which channel). A viewer cannot set it (USR).
- Verified by: `fast: the field is written and removed on its own line`, `fast: add --fast writes the field`, `fast: the fast command sets and clears it`, `fast: the page sets it`, `fast: telegram sets it`, `fast: a done intent is refused`, `fast: an a0 intent is refused from the command line`

### FAST-2 · One fast-lane intent per repo at a time

Each repo works on one fast-lane intent at a time; a second one waits as the next fast one.

- The current fast intent of a repo is the open one marked `fast` that has a mission or was started first, until it is finished, dropped or its mark is removed. Of several marked intents, the one with the highest priority (PRI-4) is the next fast one.
- The next fast intent is not started; `status`, `next` and the page say `waiting: <id> is the fast lane of <repo>` (LOOP-64). An intent that already runs normally when it is marked keeps running as a normal one until the lane is free, then takes it.
- A fast intent that waits for the owner's decision (a high-risk gate, FAST-6, FAST-8) gives up the lane while it waits, so the next fast intent of the repo can start and run. When the owner decides, the first intent takes the lane back ahead of any other waiting fast intent. The one that took the lane meanwhile is never stopped: both run until one finishes, and no third fast intent starts in that time.
- Verified by: `fast: a second fast intent waits as the next fast one`, `fast: the lane frees when the first finishes`, `fast: an intent waiting on the owner gives up the lane`, `fast: the owner's decision gives the lane back without stopping the other`, `fast: a running intent that is marked takes the lane when it is free`

### FAST-3 · A fast-lane intent starts at once

On the next loop pass a fast-lane intent starts its design, ignoring its score, the cutoff and the repo's `ahead` limit.

- Picked as `start` does (LOOP-63): over `ahead` and the cutoff (PRI-5), nothing running is stopped. The other skips still apply: paused, unknown repo, `after` not done, cooling down, GitHub or Claude unreachable, a blocking repo (LOOP-70).
- Verified by: `fast: a fast intent starts past the ahead limit and the cutoff`, `fast: a paused repo still holds a fast intent back`

### FAST-4 · A fast-lane mission takes the next free slot

A free run slot or build slot in the repo goes to the fast-lane mission before any other.

- Ahead of returning missions (LOOP-111) and ready ones (LOOP-61), whatever their priority; at the global limit (LOOP-4) it comes first in the line. A running Claude run or build is never stopped for it: it takes the next slot that frees. It counts against `workers` like any build.
- Verified by: `fast: a free run slot goes to the fast mission first`, `fast: the free build slot goes to the fast mission`, `fast: a running build is not stopped`

### FAST-5 · A fast-lane mission goes to the head of the merge queue

When it enters the merge queue, a fast-lane mission is placed before every waiting mission of its repo.

- Changes `queueOf` (LOOP-159): the mission holding `landing` stays first (a landing is never taken over, LOOP-160); then fast missions, then the usual order (`queuedAt`, priority, id).
- Verified by: `fast: a fast mission is head of the merge queue`, `fast: the landing mission stays head`

### FAST-6 · Spec and plan pass without the owner

A fast-lane intent's spec and plan go ahead on their own unless the change is high risk.

- At the spec and plan gates the fast lane applies the a5 row of AUT-18 (only `high` waits), whatever `a` the intent has, within the limits of FAST-9. A high-risk gate waits for the owner as usual (AUT-19: a missing assessment waits too).
- Verified by: `fast: spec and plan pass at medium risk`, `fast: high risk waits at the spec and plan gates`

### FAST-7 · Questions get the recommended answer, and the owner sees it

When a fast-lane worker asks a question, Towercab answers with the worker's recommendation at once and shows the owner what it chose.

- The recommended option (PIP-41) is written as the answer exactly as if the owner had given it, by `towercab` (recorded `by: fast lane`), and the run goes on. The Question comment gets a line `Answered automatically with the recommendation: <option>`; the timeline, the intent page and the card show the question and the chosen answer, and Telegram sends one message with both. The owner can still reply later; the reply is a new answer.
- Not answered automatically, the owner decides as always: a question with no recommendation, a request for access beyond the plan (AUT-15, AUT-27: no mid-build grants), and any question at a gate that waits on high risk.
- Verified by: `fast: a question is answered with the recommendation`, `fast: the answer is shown on the timeline and in telegram`, `fast: a question without a recommendation waits`, `fast: an access request waits for the owner`

### FAST-8 · The code merges on its own, except at high risk

A fast-lane change merges as soon as checks are green and the review approves, and only a high-risk change waits for the owner, who is told at once.

- The merge gate applies the a5 row of AUT-18, with CI green, `review.approved`, the proof and the access rules (AUT-14, AUT-15) holding first (PIP-7), within the limits of FAST-9.
- A high-risk wait goes to Telegram the moment it starts as the one thing to decide, tagged `Fast lane`, with its buttons (TG-3, TG-20). It is sent even when other messages are being held back or grouped.
- Verified by: `fast: a medium risk change merges on its own`, `fast: a high risk change waits and pings telegram at once`, `fast: failing checks or an unapproved review still stop the merge`

### FAST-9 · Fast lane never removes a safeguard

The fast lane changes order, waiting and who decides, never the checks, the review, the proof or the sandbox.

- Every stage and every check of the intent's path runs (AUT-6). The repo's cap (AUT-8) still lowers the level the fast lane applies, an a0 intent stays with the owner (AUT-31), and `source` rules (AUT-13) are unchanged.
- Counts as a raise of autonomy (AUT-35). A mark from the page, the owner's GitHub account or the owner's own Telegram chat (the chat the owner paired, a verified channel) applies FAST-6 to FAST-8 at once. A mark from the command line applies FAST-2 to FAST-5 at once, and the gates follow the intent's own level until the owner confirms on the page (one confirmed click on the card, as in UI-258), because agents can run the command line and must not raise their own gates; the card says `fast lane: waiting for your confirmation`. There is no exception: every command-line mark needs the page click, whatever the intent's `a` (a4 and a5 included). A Telegram message from any other chat is ignored (TG-2).
- Verified by: `fast: every check still runs`, `fast: a repo cap still applies`, `fast: an a0 intent stays with the owner`, `fast: a mark from the command line waits for confirmation to skip approvals`, `fast: a mark from the command line on an a4 intent still waits for confirmation`, `fast: a mark from the page skips approvals at once`, `fast: a mark from the owner's telegram chat skips approvals at once`, `fast: a mark from another telegram chat is ignored`

### FAST-10 · The page and the card show the fast lane and its progress

The page and the intent's card say the intent is in the fast lane and how far it has come.

- A `Fast lane` label on the card, the board and the intent page (360 px, light and dark), and for the next fast intent `next in the fast lane`. Progress is the steps of the intent's path done out of the total (design, plan, build, checks, review, merge; fewer for a lighter kind, PIP-230), e.g. `Fast lane · build, 3 of 6`. Telegram's card shows the same line (TG-16). Each automatic answer (FAST-7) is listed on the page.
- The page's control sets or clears the mark (FAST-1).
- Verified by: `ui: a fast lane card shows the label and progress`, `ui: the next fast intent is labelled`, `ui: the owner sets the fast lane from the page`, `telegram: the card shows the fast lane line`

## Out of scope

- Skipping checks, review, the proof or the sandbox (FAST-9).
- More than one fast-lane intent per repo at a time (FAST-2).
- Fast-lane intents from anyone but the owner.

## Decisions

- The fast lane applies the a5 gate table rather than a new one: one rule for "only high risk waits" (AUT-18), already understood and tested.
- It counts as raising autonomy, so a mark from the command line cannot skip approvals on its own, at any autonomy level (AUT-35; owner's call, 2026-11-14): ordering is harmless, deciding for the owner is not. The owner's own Telegram chat is a verified channel and counts at once (owner's call, 2026-11-14).
- A medium-risk fast-lane change merges and goes live without the owner; only high risk and a repo's cap stop it (owner's call, 2026-11-14).
- An intent waiting on the owner's high-risk decision gives up the lane so the next fast intent can run (owner's call, 2026-11-14).
- Questions are answered only with the worker's own recommendation, and never for access: the owner chose no automatic grants (autonomy.md Decisions).
