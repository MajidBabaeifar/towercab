# Towercab page: design

## Who and when

One person runs Towercab: a solo developer who glances at the page between other work, often on a
phone. They want to know in three seconds whether anything needs them, and to act on it in one or
two taps. They never want to read a table to find that out.

## The four questions, in order

1. **What needs me?** Cards, oldest wait first, each with only the buttons that answer it.
2. **What is stuck?** Problems, shown only when there are some, each with what to do.
3. **What is moving?** Working and queued rows: phase, step, time in step, cost.
4. **What does it cost?** Spend today, the last 7 days, the budget.

The headline of the overview answers question 1 in words: "2 things need you" or "Nothing needs
you." Everything else is one click away (the intent page), never on the overview.

## Hierarchy per page

- **Top bar** (every page): logo, health pill, counts, spend today, Pause/Resume. Nav tabs below.
- **Overview**: headline and stat pills → airspace strip (full width, hideable) → needs-you cards →
  problems → working → (side) up next (the queue, each with why it waits), spend, version. Phone:
  one column in that order, the strip running top to bottom.
- **Intent**: title + state sentence → the three PRs → needs-you card (when waiting) → stage map (the
  path taken, rounds and steps back, totals, the open stage's files and log, then "All moves" folded)
  → cost per attempt → the intent's own text. Phone: the map is a vertical stepper and a stage's files
  open inside it.
- **Queue**: one lane per repo: running, waiting (numbered, with reason), parked, recently done.
- **Activity**: filter bar (intent, repo, kind, since; in the URL) → list grouped by day.

## State vocabulary

One chip per item: icon + word, colour never alone.

| State         | Tone   | Icon      | Meaning                                       |
| ------------- | ------ | --------- | --------------------------------------------- |
| Needs you     | amber  | bell      | A wait on the owner                           |
| Working       | blue   | spinner   | A working stage                               |
| Waiting on CI | teal   | hourglass | `ci`                                          |
| Queued        | slate  | list      | Waits for a repo or a slot                    |
| Cooling down  | violet | snowflake | Usage limit, with the reset time              |
| Paused        | slate  | pause     | Held by Pause                                 |
| Stalled       | red    | triangle  | No move for 2 × the stage's timeout (CI: 2 h) |
| Up next       | indigo | arrow     | Top of the picker's list                      |
| Parked        | grey   | moon      | Below the cutoff                              |
| Done          | green  | check     | Merged                                        |
| Dropped       | grey   | x         | Stopped by a closed PR or drop                |

Steps in plain words: Starting, Writing the spec, Waiting for your spec review, Planning, Waiting for
your plan review, Building, Running checks, Proving the tests, Opening the PR, Waiting for CI,
Reviewing, Deciding, Merging, Waiting for your code review, Waiting for your answer.

## Type and space

- System font stack; numbers tabular. Four sizes: 12 (meta), 14 (body), 16 (titles), 24 (headline).
  Weights 400, 500, 600.
- 8 px grid: 8, 16, 24, 32, 48 (4 only inside chips and icon gaps). Cards: 16 px padding (24 on
  desktop), 12 px radius, 1 px border, no heavy shadows.
- Content max 1120 px; overview is 2 columns (main 1fr, side 320 px) above 960 px, else one.
- Colours as CSS variables, light and dark (`prefers-color-scheme`), text ≥ 4.5:1, chips ≥ 4.5:1.
- Focus: 2 px accent ring with offset on every control. Motion: only the spinner and inside the
  airspace strip, all of it off with `prefers-reduced-motion`.

## Airspace

The overview's one playful element: a metro line where every open intent is a tiny plane at its
station, so the whole situation reads in one glance. It is a glance, not a list: the cards and rows
below still carry the detail.

```
twr://airspace                                     6 in flight · 3 need you · 1 landed today
                       ✈        ✈·       ✈!      ✈·       ✈        ⟲        ✈·      ✈✈
  ✈ ✈ ✈ ✈ ─ ✈next ── □ ─ ◇ ─ □ ─ ◇ ─ □ ─ ci ─ ◇ ─ ■
 ⋯✈⋯✈⋯     00 gate   01 spec  you  02 plan  you  03 code  ci   you   landed
```

| State         | Motion (in place)              | Mark     |
| ------------- | ------------------------------ | -------- |
| Working       | bobs 2 px, square ping         |          |
| Waiting on CI | loops around the `ci` station  |          |
| Needs you     | beacon blinks above it         | beacon   |
| Cooling down  | still                          | `*`      |
| Stalled       | jitters 1 px                   | `!`      |
| Up next       | label blinks                   | `next`   |
| Queued        | still                          |          |
| Parked        | dim, a `z` drifts up           | `z`      |
| Landed        | still, stacked in the block    |          |

- Look: minimal futurism. Faint dot grid, hairline track, mono labels with numbered stops, light
  packets flowing gate → landed. No glow, gradients, blur or shadows. Own tokens (`--air-*`) for a
  near-white panel in light and a near-black one in dark; planes use the state colours.
- Card: under the plane, corner brackets and a stem in the state colour, one scanline as it opens;
  ID · repo · state, title, two brief lines, spec · plan · code, "Open intent ›".
- Drawn at real pixels (11 px mono labels at any width); 190 px tall; below 560 px vertical.
- "Hide airspace" collapses it to one line; remembered per browser.

## Words

Times relative ("12 min ago"), exact on hover; `$1.23`; `1 h 05 min`. IDs small and mono next to
titles, never alone. Buttons say what they do: "Merge plan PR", "Send reply", "Start over", "Drop".

## Wireframes

Overview, desktop:

```
+--------------------------------------------------------------------------------------+
| [◎] Towercab   ● Running    2 need you · 1 working · 3 queued     $4.12 today  [Pause] |
|  Overview   Queue   Activity                                                         |
+--------------------------------------------------------------------------------------+
| 2 things need you                                    | UP NEXT                       |
| Updated 3 s ago                                      | 1 Add dark mode      web  11  |
| +--------------------------------------------------+ | 2 Fix login          api  9   |
| | [bell Plan review]   waiting since 20:46   [⋯]  | |   ↳ waits: repo busy with …   |
| | Rate-limit the API          api · 261026-1200-1  | |                               |
| | Review the plan and its access list, then merge… | | SPEND                         |
| | brief text … More                                | | $4.12 today · $18.40 7 days   |
| | Access: registry.npmjs.org — install deps        | | ▁▃▂▅▁▇▄ (7 bars)              |
| | [Merge plan PR]  Plan PR #12 ↗                  | |                               |
| +--------------------------------------------------+ | Running abc1234 · up to date  |
| PROBLEMS (only when any)                             |                               |
| ▲ Stalled: Fix login — no move for 3 h. Start over… |                               |
| WORKING                                              |                               |
| Fix login  web  ●Spec ●Plan ◐Code  Building 12 min $1.20 opus                         |
+--------------------------------------------------------------------------------------+
```

Overview, phone (375 px):

```
+-----------------------------+
| [◎] Towercab  ● Running [⏸] |
| 2 need you · $4.12 today    |
| Overview  Queue  Activity   |
+-----------------------------+
| 2 things need you           |
| [card, full width]          |
| [Merge plan PR] (full width)|
| PROBLEMS / WORKING          |
| UP NEXT / SPEND             |
+-----------------------------+
```

Intent page:

```
‹ Overview
Rate-limit the API                               [Needs you]
api · 261026-1200-1 · priority 11 (urgency 3, importance 4)
Waiting for your plan review for 2 h.
[needs-you card]
[ Spec  merged #11 ↗ ] [ Plan  open #12 ↗ ] [ Code  not yet ]
HOW IT WENT      [Attempt 1] [Attempt 2]
[Spec ✓ 12 min] [Spec review ✓ 2 h] [Planning ✓] [Building ✓ r1 r2] [Checks ✓ r1 red · r2 ✓]
   ↩ sent back to Building: checks failed: 2 tests red       (wraps to a second row)
[Proof skipped: no proof needed] [PR ✓] [CI ✓] [Review ✓] [Your code review: waiting on you]
Towercab working 3 h · Waiting on you 2 h
+ Running checks: files by round (Prompt sent, Claude's answer, Check output, Errors) ------+
| ROUND 1  Check output  6 KB       Details ▸ (settings, system prompt, guard)              |
| last 200 lines in a monospace viewer · Show all · Open raw                                |
+-------------------------------------------------------------------------------------------+
▸ All moves (the timeline, exact times)
COST  attempt 1  $2.10 · 18 min                  THE INTENT (rendered sections, Answers)
```

The stage map: one node per stage in pipeline order, a 4 px left edge and an icon plus word for the
outcome (passed, red, sent back, waiting on you, working now, skipped, not reached; waits on the owner
in the "Needs you" amber, unreached stages dashed). The open stage and file live in the URL. No motion
beyond the spinner.

Queue and Activity: one card per repo lane / one list grouped by day, same chips and rows.
