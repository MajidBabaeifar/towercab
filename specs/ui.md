# UI

**Status:** Live: UI-1..82, UI-100..112, UI-120..128, UI-130..131, UI-133..137, UI-140..163, UI-168, UI-184..197, UI-203..208, UI-211, UI-236..239, UI-242..251, UI-253..275, UI-279, UI-281..283 · **Prefix:** UI

## Purpose

A local web page for the person running Towercab. It answers four questions in this order: what
needs me, what is stuck, what is moving, and what it costs. It shows the few things that matter in
plain words, offers only the action each situation needs, and leaves the full detail one click away.

## Requirements

### UI-1 · Served by the loop

The running loop serves the page on localhost, and the page never stops the loop.

- `run --watch` starts the HTTP server (`src/ui/server.ts`, `node:http`) on `127.0.0.1:<[ui] port>`
  (default 7311; 0 = off). A port in use is logged once and retried every 30 s. The server serves the
  built UI (`ui/dist/`) and the API (UI-65); the loop never waits on it.
- Verified by: `ui: binds localhost only`, `ui: loop serves the page`

### UI-2 · towercab ui

`towercab ui` opens the page in the browser.

- Opens `http://localhost:<port>/` with `xdg-open` (`--no-open` prints the URL). Port 0 → exit 1
  `ui is off: [ui] port = 0`. No loop running → the CLI serves the same page itself, read-only,
  with a banner saying Towercab isn't running.
- Verified by: `ui: the ui command`

### UI-3 · HTTP details

Removed: replaced by UI-1 and UI-65.

### UI-4 · Security

Only the owner's own browser on this machine can read the page or act through it.

- `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (else 421). `POST` also
  needs `Origin` = `http://<Host>` (403) and `X-Towercab-Token` = a per-process random token (32
  bytes, hex, in the page's `<meta name="towercab-token">`; compared in constant time; 403). No CORS.
  Every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY`, a CSP of `default-src 'self'` with no inline script.
- Nothing secret is ever sent: no tokens, no Telegram settings, no key paths; log lines are redacted
  (`ghs_…`, `ghp_…`, `github_pat_…`, bot tokens, `Bearer …`).
- Verified by: `ui: host, origin and token are checked`, `ui: secrets are redacted`

### UI-5 to UI-27 · v1 page

Removed: replaced by the v2 design below (UI-55 to UI-71). UI-1, 2 and 4 are kept and updated.

### UI-55 · Stack

The page is a small Preact app built by Vite and served as static files.

- `ui/` (Vite root): `index.html`, `src/main.tsx`, pages, components and one stylesheet with CSS
  variables. `npm run build:ui` → `ui/dist/`; `npm run dev:ui` serves it with hot reload and proxies
  `/api` to the running loop. No external resources (fonts, scripts, images) at runtime.
- Verified by: `ui: the built page has no external resources`

### UI-56 · One vocabulary for states

Every page uses the same few states, with the same words, colours and icons.

- `Needs you`, `Working`, `Waiting on CI`, `Queued`, `Cooling down` (usage limit, with the reset
  time), `Paused`, `Stalled` (no move for longer than its stage allows: 2 × the stage's timeout, or
  2 hours for CI), `Up next`, `Parked`, `Done`, `Dropped`. Derived once on the server
  (`src/ui/state.ts`, `stateOf(mission, now)`) and sent with each item.
- Steps are named in plain words: "Writing the spec", "Waiting for your spec review", "Planning",
  "Building", "Running checks", "Proving the tests", "Opening the PR", "Waiting for CI", "Reviewing",
  "Merging".
- Verified by: `ui: one state per mission`, `ui: steps in plain words`

### UI-57 · Top bar

The top bar says at a glance whether Towercab is healthy and how much needs the owner.

- Health (`Running`, `Paused`, `Problem`, `Not running`), counts (`2 need you · 1 working · 3
  queued`), spend today (and of `daily_budget_usd` when set, [MET-29](metrics.md)), the running
  version and whether it is behind `main`, and Pause/Resume. The tab title starts `(<n>)` while n
  things need the owner.
- Verified by: `ui: top bar shows health and counts`

### UI-282 · Pause and Resume show they are working

After the owner presses Pause or Resume, the button shows that Towercab is applying it, so nobody presses again.

- The top bar's button turns to `Pausing…` or `Resuming…` with a spinner, disabled and `aria-busy`, from the
  click until the page reports the new state (the loop applies the command on its next pass, LOOP-113). A
  refused action restores the button and shows the reason as its title; after 60 s without the new state it
  restores the button with the title "Towercab has not applied it yet: check that the service is running".
  The airspace's Resume (UI-109) reads `Resuming…` with a spinner the same way until the ground stop clears.
- Verified by: `ui: pause shows it is working until the state changes`

### UI-283 · The page shows an intent's kind and lets the owner set it

An intent's page says what kind of work it is, which stages that kind skips, and lets the owner change the kind.

- The intent page shows the kind (set or inferred, with the inferred one's reason, INT-77) and the skipped stages in plain words ("No spec PR: this is a bugfix"). Board cards show the kind as a small label. Fits 360 px, light and dark.
- A control on the page sets the kind to one of the five values (INT-76) with `POST /api/actions` `{action: "set-kind", id, kind}` (UI-66, `actor: owner`), writing `kind` into the intent's front matter (INT-5). It is offered only for a stage that has not started; a kind that would lighten a mission already past a skipped stage is refused with the reason. For an `a0` intent only the owner can do it (AUT-32); a viewer never sees it (USR).
- Verified by: `ui: the intent page shows the kind and the skipped stages`, `ui: the owner sets the kind from the page`, `ui: a kind change past the skipped stage is refused`, `ui: a viewer cannot set the kind`

### UI-58 · Needs you

Each thing waiting on the owner is one card that says what is asked, why, and offers only the
actions that answer it.

- Card: the intent's title and repo; the ask (LOOP-14 **Waits**); the plain reason and a short plain brief
  (UI-126: at most a few lines, the rest behind "More"; the technical text under "Details"); the PR
  link. Actions by kind: approve spec, plan or code → "Merge spec PR",
  "Merge plan PR" (with the access list visible), "Merge PR"; a question or other blocked wait → a
  reply box ("Send reply"); always, in a menu: "Start over" (`/retry`) and "Drop" (with a confirm).
- Ordered oldest wait first. Empty → "Nothing needs you."
- Verified by: `ui: needs-you card shows only its actions`, `ui: empty states are true`

### UI-59 · Working and queued

Moving intents show their progress through spec, plan and code, the step they are on, and how long
and how much so far.

- A row per unfinished mission not waiting on the owner: title, repo, a three-part progress (Spec,
  Plan, Code; done, current, to do, or skipped when there was no spec change), the step in plain
  words, time in step, cost so far, model. `Queued` rows say what they wait behind.
- Verified by: `ui: working row shows phase and step`

### UI-60 · Problems

Problems appear only when there are some, each with what to do about it.

- Stalled missions; the same check failing in two rounds; a mission costing over 3 × the median of
  the last 20; GitHub or Claude unreachable ([LOOP-10](loop.md)); a self-update that failed; intent
  files that can't be read. Nothing wrong → the section isn't shown.
- Verified by: `ui: problems only when there are some`

### UI-61 · Up next

The overview shows what Towercab will start next and why the others wait.

- The top 5 of the picker's list ([PRI-5](priority.md)) with priority and, for each skipped one, the
  reason in plain words (paused, repo busy with <id>, model cooling down until <time>, parked).
- Verified by: `ui: up next explains skips`

### UI-62 · Intent page

One page per intent shows its whole story: the three PRs, the current state, what happened when,
and the intent itself.

- `/i/<id>`: title, repo, scores; the current state sentence; the three PRs (spec, plan, code) with
  state (open, merged, closed, not needed) and links; the needs-you card when it waits (UI-58); a
  timeline of moves in plain words with times and durations; cost and agent time per attempt; the
  intent's sections and `## Answers`, rendered; links to run files (logs, prompts, results) of each
  step. The stage map (UI-73..77) takes over the time per step and the run files.
- Verified by: `ui: intent page shows the three PRs`, `ui: timeline in plain words`

### UI-63 · Queue per repo

Per repo, Towercab says what runs, what is up next, what waits on something else and why, and what is
parked.

- `lanesOf()` (`GET /api/queue`): one lane per `[repos]` repo, then any other repo a mission names:
  its missions (the build slot's holder first); "up next": queued intents nothing but their turn holds
  (none, a full repo, Pause), numbered in pick order; "waiting": those held by a dependency, a usage
  limit, an unreachable service or another reason, with the reason (UI-61); parked ones; the last 10
  done. The Repos page (UI-140) shows it. Read-only.
- Verified by: `ui: queue lanes by repo`

### UI-64 · Activity page

An activity page lists what happened, newest first, filterable by intent, repo, kind and time.

- `/activity`: moves (from `transitions`) and loop log lines, each naming the intent by title. Kinds:
  moves, waits, errors. Filters live in the URL (`?intent=&repo=&kind=&since=`). 100 at a time, "Show
  more".
- Verified by: `ui: activity filters in the URL`

### UI-65 · API

The page talks to the loop through a small JSON API.

- `GET /api/state` (the overview's data, with a `version` that changes when anything shown changes),
  `GET /api/intents/<id>`, `GET /api/queue`, `GET /api/repos`, `GET /api/activity?…`, `GET /api/runs/<id>/<file>`
  (`<file>` or `<stage>/<file>`, names `[A-Za-z0-9._-]+`, files under `runs/<id>/` only, no symlinks
  out, text, at most 2 MB), `GET /api/events`
  (Server-Sent Events: `version` on each change), `POST /api/actions` `{action, intent, text?}`
  (`addRepo` takes `{action, github, name?}` instead, UI-130).
- Verified by: `ui: API shapes`, `ui: run files stay inside runs`

### UI-66 · Actions

A button in the page does exactly what the owner would do on GitHub or in the CLI.

- `merge` → `gh pr merge --squash` as the owner on the PR the intent waits on ([LOOP-38](loop.md));
  `reply` → a PR comment as the owner (no PR yet → `answer`); `retry` → a `/retry` comment (no PR →
  the `retry` command); `drop` → closes the current PR as the owner (no PR → `drop`); `pause`,
  `resume` → commands. The reply says what happened in one sentence, or the error.
- Verified by: `ui: actions go through GitHub as the owner`, `ui: actions without a PR use commands`

### UI-67 · Live without losing input

The page updates on its own and never throws away what the owner is doing.

- The page listens to `/api/events` and refetches on a new `version` (polling every 5 s when the
  stream drops). Typed text, open menus and expanded sections survive an update; "Updated <n> s ago"
  shows freshness.
- Verified by: `ui: update keeps typed text`

### UI-68 · Look and feel

The page is calm, readable and usable on a phone.

- Light and dark (`prefers-color-scheme`), system font stack, a type scale of 4 sizes, an 8 px
  spacing grid, contrast at least WCAG AA, state colours always paired with an icon or word, visible
  keyboard focus, usable at 360 px wide. No raw commands, field names or IDs as primary text (IDs
  appear small, next to titles).
- Verified by: `ui: screenshots light, dark and mobile`

### UI-69 · Screenshot tests

Every page is rendered in a real browser in tests, and the screenshots are kept.

- `npm run test:ui` (Playwright, Chromium) starts the server on a fixture home with intents in every
  state and saves `ui/screenshots/<page>-<light|dark|mobile>.png` (CI uploads them, PIP-12). The
  same run is Towercab's own ` ```screenshots ` block ([REPO-10](repo.md)).
- Verified by: `ui: screenshots light, dark and mobile`

### UI-70 · Empty states

Every section says something true when it is empty.

- "Nothing needs you." "Nothing is running." "Nothing queued: add an intent to the intents repo."
  "No problems." Never an empty box.
- Verified by: `ui: empty states are true`

### UI-71 · Words

Every text on the page is plain language a person can act on.

- Times are relative ("12 min ago") with the exact time on hover; costs in dollars with 2 decimals;
  durations as `1 h 05 min`. Errors say what failed and what to do.
- Verified by: `ui: times, costs and durations`

### UI-72 · Stage visits

The server works out the path an intent took once, as an ordered list of stage visits, so the page only draws it.

- `GET /api/intents/<id>` returns, in each attempt's `map` (`src/ui/state.ts`), `visits`, `stages`
  (every stage with its outcome, time, rounds and files), `open` and the two totals, from the
  mission's moves and the stage folders (LOOP-39): in order, each visit has `stage`, `round` (1 for the first time
  in that stage), `start`, `end` (none while it runs), `outcome` (`passed`, `red`, `sent back`,
  `waiting on you`, `working now`, `skipped`), `reason` (the plain-words reason it moved on, or why
  it was skipped), `returnTo` and `returnLabel` (the stage it went back to and why, if it did) and `files`.
- The stages, in pipeline order, with their plain names (UI-56): Writing the spec (`design`), Your
  spec review, Planning (`plan`), Your plan review, Building (`build`), Running checks (`verify`),
  Proving the tests (`proof`), Opening the PR (`publish`), CI (`ci`), Reviewing (`review`), Deciding
  (`gate`), Your code review, Merging (`merge`), then the ship stages of UI-123. Waits on the owner (the three reviews and
  questions) are visits too. A stage that was never reached has no visit and is listed as `not reached`.
- Time per stage and the two totals (Towercab working, waiting on you) are sums of the visits.
- Each file has `stage`, `round`, a plain `kind` ("Prompt sent", "Claude's answer", "Check output",
  "Errors", "Screenshots", or "Details" for Claude settings, system prompt and guard file), `name`,
  size and time. Empty files are left out. A folder of screenshots is one entry ("Screenshots", with
  the image count) that is not opened as text.
- Verified by: `ui: visits follow the real path`, `ui: visits count rounds and returns`, `ui: visits skip empty files`

### UI-73 · Stage map

The intent page shows one diagram of the path the intent took through the pipeline, from picked up to merged or to where it is now.

- Placed right under the three PRs and the needs-you card (UI-62). One node per stage in pipeline
  order, in the plain names of UI-72. A node shows its outcome as an icon plus a word (passed, red,
  sent back, waiting on you, working now, not reached, skipped) and its total time (UI-71).
- The current stage has `aria-current="step"`, the state chip and, while working, the spinner. Stages
  not reached are hollow and quiet. A skipped stage says "skipped" and why (for example "no tests
  changed"). Waits on the owner use the "Needs you" colour (UI-56).
- Under the map: time Towercab worked and time spent waiting on you.
- Look and feel follows UI-68 and `ui/DESIGN.md`, which gets the map in the intent page's hierarchy.
  The map is HTML, CSS and inline SVG in Preact, with no new dependency or external resource (UI-55).
- Verified by: `ui: stage map shows every stage and its outcome`, `ui: stage map marks the current and skipped stages`

### UI-74 · Rounds and returns

The map shows the real path: a stage that ran several times shows each round, and every step back is drawn with its reason.

- A stage with more than one visit shows numbered rounds inside its node (round 1, 2, 3).
- Each move back (checks red → building, CI red → building, review asked for changes, the owner
  asked for a new spec) draws a return link between the two nodes, labelled in plain words, for
  example "checks failed: 2 tests red". The link is also text for screen readers: "sent back to
  Building: checks failed".
- Verified by: `ui: map shows rounds and return links`

### UI-75 · Stage files

Choosing a stage opens its files right under the map, grouped by round, and a file opens inline.

- A click, tap or Enter/Space on a node opens the panel; the panel lists the stage's files by round
  with plain kind names, sizes and relative times (UI-71). "Details" (Claude settings, system
  prompt, guard file) is folded.
- Opening a file shows it in a monospace viewer: the last 200 lines first, "Show all" (up to the
  API's 2 MB) and "Open raw" in a new tab; JSON is pretty-printed.
- The panel opens by default on the stage waiting on the owner, else the last red one, else the
  current one, else the last stage. The open stage, round and file are in the URL
  (`/i/<id>?stage=verify&file=…`), so the link can be shared and survives reload.
- Live updates (UI-67) move the map and append files without closing the open stage or file or
  moving the reader's scroll position.
- Verified by: `ui: stage panel opens the stage that matters`, `ui: stage and file are in the URL`, `ui: log viewer shows the last 200 lines`, `ui: update keeps the open log`

### UI-76 · Attempts, and what the map replaces

When an intent had several attempts, the map follows the attempt picked, and it takes the place of the old time and file sections.

- With more than one attempt a switcher above the map picks one (the latest by default); the map,
  totals and files follow it, and the choice is in the URL.
- The map replaces the "Time per step" card and the "Run files" section of UI-62. The timeline stays,
  folded under the map as "All moves", with exact times.
- Verified by: `ui: attempt switcher drives the map`, `ui: intent page has no step-time or run-files section`

### UI-77 · Map on a phone and without sight

The map works at 360 px wide and by keyboard and screen reader, and moves no more than the spinner.

- On desktop it runs left to right and wraps to a second row, never scrolling sideways. At 360 px it
  is a vertical stepper and a stage's files open inline beneath it (accordion).
- It is an ordered list of stages, each a button with `aria-expanded` and its outcome and time in its
  accessible name; arrow keys move between stages; return links are text (UI-74). No motion beyond the
  existing spinner, and none with `prefers-reduced-motion`.
- The UI fixture has an intent with a repair loop, a skipped stage, a wait on the owner and two
  attempts; the screenshot tests (UI-69) capture the map with a log open in light, dark and mobile.
- Verified by: `ui: stage map is keyboard and screen reader friendly`, `ui: screenshots light, dark and mobile`

### UI-78 · Airspace

The overview shows every open intent as a tiny plane on one metro line, at the station it is at now,
so the whole situation fits in one glance.

- A full-width strip under the headline, above the cards. Stations, left to right: parked (a dashed
  siding), queue, `00 gate`, `01 spec`, `you` (spec review), `02 plan`, `you` (plan review),
  `03 code`, `ci`, `you` (code review), `landed` (today). Review stations are diamonds, the others
  squares. A header line reads `twr://airspace` and the counts: in flight, need you, landed today.
- Where a plane sits: a wait for a review at its review station; a question or block at its phase's
  station; CI at `ci`; any other step at its phase's station (spec, plan or code); an intent that
  waits on the owner without a mission at the gate; the picker's list (UI-61) without a skip at the
  gate, with a skip in the queue in pick order, parked on the siding; done intents finished today
  (local date) in the landed block. Dropped intents aren't shown.
- The server builds it once (`airspace` in `GET /api/state`, `src/ui/state.ts`): each plane's
  intent, title, repo, state (UI-56), station, two brief lines and phases; the landed summary
  (count, cost, agent time, the latest titles) and the counts.
- Verified by: `ui: airspace places each intent at its station`

### UI-79 · Motion in place

Planes that are active move a little where they stand, each state in its own way, and every motion
stops for people who ask for less motion.

- Colour is the state's colour (UI-56); the motion tells states apart without it: Working bobs 2 px
  with a square ping; Waiting on CI loops around its station; Needs you blinks a beacon; Cooling
  down is still with a frost mark `*`; Stalled jitters 1 px with `!`; Up next blinks `next`; Queued
  stands still; Parked is dim and drifts a `z`. Light packets flow along the line from gate to
  landed. A plane that changes station glides there (0.6 s) on the next update.
- CSS animations on `transform` and `opacity` only, no script loop. With `prefers-reduced-motion`
  nothing animates and moves are instant. Nothing flashes more than 3 times a second.
- Verified by: `ui: airspace motion stops with reduced motion`

### UI-80 · Plane card

Pointing at a plane opens a small radar-style card under it with a short brief and a way into the
intent.

- Hover, keyboard focus or a tap opens it: ID and repo, the state, the title, two brief lines (step
  and time in step, then cost and model; or the ask and how long it has waited; or the place in
  line, or why it's parked), a spec · plan · code strip, and "Open intent ›" to `/i/<id>`. Corner
  brackets and a stem in the state's colour; one scanline sweep as it unfolds.
- The landed block's card sums today (count, cost, agent time, latest titles) and links to
  `/activity?since=24h`; a `+n` marker's card lists the planes it hides, each a link.
- The card stays open while the pointer is on the plane or the card, closes 0.25 s after it leaves
  both or on Escape, never runs past the strip's sides, and opens upward when it would run off the
  bottom of the screen. A click on a plane whose card is open goes to the intent; on touch the first
  tap opens the card.
- Verified by: `ui: airspace card opens under a plane`

### UI-81 · Show or hide

The owner can hide the strip, and the page remembers it.

- "Hide airspace" in the strip's header collapses it to the header and the counts in one line;
  "Show airspace" brings it back. Kept in this browser (`localStorage` key `towercab.airspace`),
  shown by default; survives reloads and live updates.
- Verified by: `ui: airspace can be hidden`

### UI-82 · Fits the page

The strip reads well in light and dark, on a wide screen and on a phone, and with crowded stations.

- Its own colour tokens for light (a near-white panel) and dark (a near-black panel); minimal
  futuristic look: faint dot grid, hairline track, mono labels; no glow, gradient or shadow.
- Drawn at the strip's real width (1 SVG unit = 1 px, so text stays 11 px): 190 px tall, steps
  spaced evenly. Below 560 px wide it runs top to bottom with planes pointing down.
- A step station shows up to 3 planes (2 and `+n` beyond), the queue and the siding up to 4 and 3,
  the landed block up to 6 (more only in its count).
- Planes are links named "title, state, place"; the strip says its counts in one sentence for
  screen readers.
- Verified by: `ui: airspace caps crowded stations`, `ui: airspace runs top to bottom on a phone`,
  `ui: screenshots light, dark and mobile`

### UI-100 · Ready to build

An intent whose plan is approved but waits for the build slot shows as ready to build, behind the intent that holds the slot.

- State `Queued` with the sentence "Ready to build, behind <title>" (UI-56, UI-59); on a repo's
  page (UI-63, UI-141) "In progress" lists the running intent, then ready intents in build order, then
  the intents ahead of build (with a count `n of <ahead> ahead`), then the queued ones with the reason
  "repo has <n> intents ahead". On the airspace (UI-78) a ready plane sits at `03 code`.
- Verified by: `ui: ready to build shows behind the running intent`, `ui: queue lane shows ahead count`

### UI-101 · Start button

The owner can start an intent's design now from the page.

- "Start now" on the intent page (UI-62), on its Up next row (UI-61) and in the plane card (UI-80),
  only for an intent that has no mission yet and is not parked. It does what `towercab start` does
  (LOOP-63), including going over the limit. The reply says in one sentence that design started, or
  the error.
- Verified by: `ui: start now appears only for an unstarted intent`

### UI-102 · Start action

The API has a `start` action for the button.

- `POST /api/actions` accepts `{action: "start", intent}` (UI-65, UI-66) and inserts the `start`
  command (LOOP-63); an unknown or started intent → the command's error text.
- Verified by: `ui: start action uses the start command`

### UI-103 · Reserved

Reserved for this intent; not used.

- Verified by: manual (nothing to check: no behaviour)

### UI-104 · Reserved

Reserved for this intent; not used.

- Verified by: manual (nothing to check: no behaviour)

### UI-105 · Done by you, shown everywhere

After the owner merges, drops or starts over from the page, every view shows that action as done, with no button for it, until the loop moves the mission on.

- A successful `merge`, `drop` or `retry` action on a PR (UI-66) stores a note on the mission: the
  action, the PR number and the time. The note is display only: it never moves the mission (only
  `machine.apply` does, after GitHub confirms) and it is removed when the mission leaves
  that wait (any move out of the approval stage, or a new attempt).
- While the note exists the needs-you card (UI-58) on the overview and on the intent page (UI-62),
  and the plane card (UI-80), replace the actions with a line: "Merged by you · Towercab moves on
  within a minute", "Dropped by you · …" or "Started over by you · …". The note comes from the API
  (UI-65), so a reload or a second tab shows the same card. The count of things that need you
  (UI-57) still counts the mission until it moves on.
- A reply or an action that failed stores no note.
- Verified by: `ui: merged by you survives a reload`, `ui: drop and start over show as done`, `ui: done note never moves the mission`

### UI-106 · Check the PR at once

A successful merge, drop or start over asks the loop to look at that PR immediately, so the mission usually moves on within seconds.

- After GitHub accepts the action, the action sets the `meta` flag `poll:<mission id>`. On its next
  pass (LOOP-12) the PR poll reads that mission's PRs at once, ignoring the 60 s throttle, and clears
  the flag; a move clears it too. The poll reads GitHub as usual and `machine.apply` moves the mission
  only on what GitHub reports. If the flag is lost, the normal 60 s poll still moves it.
- Verified by: `ui: a successful merge asks for an immediate poll`, `ui: a failed merge asks for no poll`

### UI-107 · Merge checks the PR first

Merging a PR that is already merged does nothing on GitHub and says so, with no error.

- Before `gh pr merge`, the `merge` action reads the PR's state as the owner. `MERGED` → no
  `gh pr merge` call; it stores the note (UI-105), asks for the poll (UI-106) and replies "Already
  merged; Towercab is moving on." `CLOSED` without merge → error "The <label> #<n> is closed, so
  there is nothing to merge." Otherwise it merges as before (UI-66). A second merge request while the
  note exists takes the same already-merged path and never calls `gh pr merge`.
- Verified by: `ui: merging a merged PR does not call gh pr merge`, `ui: merging a closed PR says so`, `ui: a second merge request never calls gh merge`

### UI-108 · Slow to move on

If the mission has not moved on 5 minutes after the action, the card says so and links to the PR.

- The "moves on within a minute" line (UI-105) applies for the first 5 minutes after the note's
  time. After that the card says "Merged by you <n> min ago, but Towercab has not moved on yet" (and
  likewise for drop and start over) with a link to the PR, and still shows no action button for it.
  Times follow UI-71.
- Verified by: `ui: done note turns into a stuck message after 5 minutes`

### UI-109 · Ground stop

While the loop is paused, the airspace says so in its header and on the strip, and offers Resume.

- Owner pause (`meta.paused`, LOOP-15): the `twr://airspace` header reads `GROUND STOP · paused since
  <time> by you` (time per UI-71; `GROUND STOP · paused` when there is no pause time, UI-111). The strip
  gets a calm amber hatched band. A Resume button sits in the header next to that text and does what
  the Resume action does (UI-66, `resume` command); the reply shows as for other actions.
- Health pause (a health block is open, LOOP-10): the header names the service and the reason, such
  as `GROUND STOP · can't reach GitHub`, from the same problem the Problems block shows (UI-60). No
  Resume button, because resuming would not help. If the owner has also paused, the owner's header
  and button show.
- `airspace` in `GET /api/state` (UI-78) carries `stop`: `null`, `{kind: "owner", since}` (`since` is
  null without a pause time) or `{kind: "health", service, reason}`. The text follows `prompts/writing.md`.
- Hiding the airspace (UI-81) keeps the one-line header with `GROUND STOP` in it, and Resume where it applies.
- Verified by: `ui: airspace shows a ground stop when paused`, `ui: airspace names the service when health pauses`

### UI-110 · Held planes

During a ground stop, the stations that feed new work are dimmed and marked held, while planes already flying keep moving.

- Parked, queue and `00 gate` stations are dimmed and carry a small `held` mark. A plane past the gate
  (spec, plan, code, ci and the review stations) is drawn and moves as usual, because pause lets
  running work finish. A plane waiting at merge shows a `held` tag, because merges wait
  until resume (PIP-22: a mission entering `merge` holds while paused); its card (UI-80) says
  "Held until you resume" (owner pause) or "Held until <service> is reachable again" (health pause).
- Marks and the band are static: with `prefers-reduced-motion` nothing new moves (UI-79), and the
  band and marks add no motion in any case. The held marks are also text for screen readers (UI-82),
  and the strip's sentence says the loop is paused or why it is stopped.
- Looks right in light and dark, on a wide screen and on a phone (UI-82).
- Verified by: `ui: airspace dims held stations and tags a plane waiting at merge`, `ui: ground stop adds no motion with reduced motion`, `ui: screenshots light, dark and mobile`

### UI-111 · Pause time

The loop remembers when the owner paused it, so the page can say since when even after a restart.

- Applying the `pause` command also stores `meta.paused_at` (ISO time, the loop's clock) in the same
  transaction that sets `meta.paused`; applying `resume` deletes both. Pausing when already paused
  keeps the first `paused_at`. Nothing else about the commands changes (LOOP-15).
- A pause without `paused_at` (made before this) gives `since: null` in UI-109.
- Verified by: `commands: pause stores the time and resume clears it`, `ui: an older pause shows paused without a time`

### UI-112 · Tab title

While the loop is paused, the browser tab title starts with `⏸`, so the owner notices it from another tab.

- The title is `⏸ ` before the usual title for an owner pause and for a health pause; it goes back
  when the stop ends, on the next live update (UI-67).
- Verified by: `ui: tab title starts with a pause mark while paused`

### UI-120 · Ship stations

The airspace shows a change after its merge, until it is live and tested.

- Two stations sit between the code review's `you` and `landed`: `04 deploy` and `05 e2e` (squares).
  A plane at `deploy` or `rollback`, or waiting after one, sits at `04 deploy`; at `e2e` or `revert`,
  or waiting after one, at `05 e2e`; a plane in a fix round sits at its phase's station as usual. The
  two stations are drawn while a plane sits at one, and for 7 days after any mission entered `deploy`,
  so the line keeps one shape while a repo ships; a Towercab without a live repo sees the line it
  always had.
- Verified by: `ui: ship stations`, `ui: ship stations stay for a week after a deploy`

### UI-121 · Ship states

The intent's state says in words where a shipping change is.

- `deploy`: "waiting for the deploy"; `e2e`: "running e2e"; `rollback`: "rolling back"; `revert`:
  "reverting"; a build round after a rollback: "fixing (n of 2)"; a mission held at the gate by
  [SHIP-14](ship.md): "repo on hold". `rolled back, revise` and `rollback failed` are needs-you cards
  with their asks.
- Verified by: `ui: ship states`

### UI-122 · e2e log on the intent page

The intent page links the last e2e log, so the owner sees why a change was rolled back.

- The intent page (UI-62) shows "e2e log" linking the newest `runs/<intent>/e2e/*.log`, served
  redacted ([SHIP-2](ship.md)), when there is one.
- Verified by: `ui: e2e log link`

### UI-123 · Ship stages in the stage map

The stage map follows a change after its merge, so the owner sees the deploy, the e2e run and any rollback in the path.

- After Merging, the map has Deploying (`deploy`), e2e tests (`e2e`), Rolling back (`rollback`) and
  Reverting (`revert`) ([SHIP-1](ship.md)). They are listed only when the attempt visited them, so a repo
  without a `live` block sees the map it always had. (UI-158 lists them for every attempt once built.)
- Merging → Deploying is a pass, not a step back. A red deploy or e2e run is `red` with a return link to
  Rolling back, labelled with its reason ("e2e tests failed: e2e suite drill failed twice …"). A
  rollback that is back on the last good version is `passed`, with a return link to Building labelled
  "fix round: back on 2d6ad8c; fix 1 of 2".
- e2e logs written while rolling back (the smoke suites) belong to Rolling back; the others to e2e tests.
- Verified by: `ui: stage map shows the ship stages`, `ui: stage map without a live repo has no ship stages`

### UI-124 · Every code PR

The intent page lists every code PR of a shipping change, so the PR that was rolled back stays one click away.

- A fix round ([SHIP-11](ship.md)) remembers the code PR it replaces in the mission's `ship.prs`. The
  page shows the first code PR as "Code", each later one as "Fix 1", "Fix 2", and the revert PR
  ([SHIP-12](ship.md)) as "Revert". Earlier ones are `merged`.
- A code PR is `merged` once the mission is past Merging (deploy, e2e, rollback or revert), not only when
  the intent is done.
- Verified by: `ui: every code PR of a shipping change`

### UI-125 · Rollbacks and fix rounds in the airspace

The airspace tells a plane that is rolling back or fixing a live failure apart from ordinary work.

- A plane at `rollback` or `revert`, or waiting after one, flies backwards in the stalled colour with a
  `↩` mark. Its card's first line says which suite went red and which version it goes back to
  ("drill red · back to 2d6ad8c"); without a red suite it says "Rolling back" or "Reverting".
- A plane in a fix round ([SHIP-11](ship.md)) carries a `fix n/2` mark at its station.
- The marks come from the plane's `ship` field (`{ kind: "rollback" | "revert" | "fix", mark }`), absent
  for every other plane.
- Verified by: `ui: rollback and fix planes are marked`

### UI-126 · Cards lead with the plain brief

A needs-you card says, in plain words, what is asked, why and what the change means for its users;
the technical text stays one click away under "Details".

- Order: the intent's title; the ask (LOOP-14 **Waits**, [PIP-110](pipeline.md)); for an approval,
  the plain reason it waits; the plain brief (`Card.brief`, [PIP-107](pipeline.md): spec → the
  design's, plan → the plan's, code → the review's, else the worker's, question → the asker's; a
  blocked wait without a PR → Towercab's note); the risk block (AUT-20) and the open points with it;
  then the question's options, the access list, the reply box and the actions.
- `Card.details` (Markdown) folds under a "Details" toggle, closed at first and kept open across
  updates: spec → the design's PR text, its concerns and the questions it left open; plan → the
  plan's approach and risks; code → the review's findings; a question with a brief → its context
  (shown in the open otherwise); a blocked wait → the reason Towercab saw (a check's name, an error
  line).
- A mission from before briefs keeps the old card: the review's summary leads, nothing folded. Only
  the card falls back to it; the intent page never shows it as plain (UI-127).
- Verified by: `ui: the card leads with the plain brief, the technical text folded`, `ui: the card shows its brief first and folds the details`

### UI-127 · The intent page leads with the plain brief

The intent page puts the latest plain brief first, with its technical text folded.

- With a needs-you card, the card carries it (UI-126). Without one, `IntentPage.brief` is the latest
  plain brief of the newest attempt (code, else plan, else spec) under "In plain words", with
  `IntentPage.details` folded under "Details" and the risk block beside it.
- Verified by: `ui: the intent page leads with the plain brief`

### UI-128 · Screenshot of the plain card

The screenshots show a needs-you card with its plain brief first and its Details folded.

- `npm run test:ui` saves `card-brief-<mode>.png` of the plan card and checks that the brief comes
  before the "Details" toggle, which is closed, that opening it shows the technical text, and that
  it stays open across a live refetch; it also saves the opened card as `card-brief-open-dark.png`.
- Verified by: `ui: the card shows its brief first and folds the details`

### UI-130 · Add a repo from the page

The owner adds a repo from the page by typing only its `owner/name`.

- The Repos page's All view (UI-142) ends with an "Add repo" form: one field (`owner/name`) and an
  "Add repo" button; not shown when the page is read-only (UI-2). It posts `{action: "addRepo", github, name?}` to
  `/api/actions`, which runs LOOP-66's `repo add` in the loop (`source` `ui`).
- The request ends once LOOP-66's checks pass (the server's 15 s request limit stays; a clone can take
  longer): the reply is `Adding <name> (<owner/name>, base <base>): Towercab is cloning it now. It shows
  on the Repos page when done, and its intents start from then on.`, or the refusal's reason (LOOP-66)
  shown on the form. The clone goes on in the loop; the page's live update shows the new repo when it is
  stored (the page's version covers the `repos` table). A clone or store that fails becomes a problem
  (UI-60), `Towercab couldn't add the repo <name> (<owner/name>)` with the reason, until the repo is
  added again (`meta.repo-add-failed:<name>`). "No repos yet." when there are none.
- Verified by: `ui: add repo action adds the repo and says so`, `ui: add repo goes through the actions API`, `repos: a failed add from the page is reported`

### UI-131 · Add this repo on the unknown-repo card

An intent that waits because its repo is unknown offers to add that repo right on its card.

- The `unknown repo` card (UI-58) says `Its repo “<name>” isn't one Towercab knows yet. Check the
  GitHub repo below and press Add this repo, or change the intent's repo.` and carries
  `addRepo: {name, github}`: the intent's repo as the short name, and `owner/name` prefilled with the
  owner most known repos share (`""` when there are none). The page shows the field and an "Add this
  repo" button, which adds the repo under that short name (UI-130).
- Once the repo is known, the card says `Towercab knows its repo “<name>” now and queues it again
  within a minute.` and offers no button; the loop clears the wait (LOOP-68).
- Verified by: `ui: unknown repo card offers to add the repo`

### UI-133 · Board tab

A Board tab shows every intent as a card on a grid, one column per station and one row per repo, so the
owner sees at a glance where each repo's work stands.

- `/board`, a top tab after Overview. Columns, left to right, in the airspace's words: Queue, Gate,
  Spec, Your spec review, Plan, Your plan review, Code, CI, Your code review, Deploy, e2e, Done. Deploy
  and e2e are there exactly when the airspace draws its ship stations (UI-120). Rows: one per `[repos]`
  repo in config order, then any other repo an intent names or that has spend (UI-137), then "Unknown
  repo" for intents the listing doesn't know; a row without cards says so in one line.
- A card shows the intent's title and its state chip (UI-56), and links to the intent page (UI-62).
- The server builds it (`GET /api/board`, `board()` in `src/ui/board.ts`): `columns` (key, label,
  count), `repos` (repo, GitHub name, open and done counts, spend of UI-137, the cards per column), the
  spend totals and `error`. The page updates live like the others (UI-67).
- When the intents repo can't be read, the page says so above the board (the reason, and that only
  started intents are shown) instead of showing empty rows as if nothing were there.
- Verified by: `ui: board columns follow the airspace`, `ui: board says when the intents repo can't be read`,
  `ui: screenshots light, dark and mobile`

### UI-134 · Where a card sits

A card sits in the column of its plane on the airspace, so the board and the airspace never disagree.

- Open intents take the station of their airspace plane (UI-78, UI-100, UI-120), built by the same
  code; a plane whose intent the listing doesn't know sits in the "Unknown repo" row. Parked intents
  sit in Queue below the queued ones, with their Parked chip. Done holds the intents done in the last
  7 local days (the same days as the spend of UI-137), newest first, saying when; dropped intents
  aren't shown. A row header counts its open intents and those done in the last 7 days.
- Verified by: `ui: board columns follow the airspace`, `ui: board shows what was done in the last 7 days`

### UI-135 · Fold a repo

Each repo row folds to its header with one toggle, and the page remembers it in this browser.

- The toggle is a button on the row header with `aria-expanded`. Folded repos are kept in
  `localStorage` under `towercab.board.folded` (a JSON list of repo names); every read and write is
  wrapped in `try`/`catch`, so without storage a row still folds until the page reloads.
- Verified by: `ui: board folds a repo and remembers it`

### UI-136 · Board fits many repos and a phone

The board stays usable with many repos and intents, and on a phone.

- Only the board scrolls sideways, never the page. Column headers stick to the top of the board and
  repo names to its left while it scrolls. A column with cards is at least 144 px wide and one without
  cards in any repo 64 px, so a board with seven busy columns fits a 1280 px screen without scrolling;
  a wider one scrolls inside the board.
- At 720 px wide or less the board is one column: a section per repo listing its cards under the station
  names, stations without cards left out. Light and dark like the rest of the page (UI-68).
- Verified by: `ui: screenshots light, dark and mobile`, `ui: board folds a repo and remembers it`

### UI-137 · Spend per repo

Towercab keeps what it spent on each repo today, in the last 7 days and in all time, with the totals,
and shows it on each board row.

- Today and 7 days sum the runs' costs by local day, over the same days as MET-29 (`data.runs`); all
  time sums `missions.cost_usd` (MET-28) over every mission of the repo, finished, dropped or open.
  The totals are the sums over all repos, so today's total equals the top bar's spend today.
- The board's repo header reads "$1.20 today · $8.40 7 days · $52.10 all time", and the board's
  heading the totals. Every repo that cost something has a row, so the rows add up to the totals.
- `spendByRepo(db, now)` and `repoSpend(src, repo)` in `src/ui/spend.ts` compute it, for pages to share.
  All time is one `SUM(cost_usd) … GROUP BY repo`; only missions updated in the last 8 days have their
  runs read.
- Verified by: `ui: spend per repo today, 7 days and all time`

### UI-146 · Sort the Board's repos

A sort control above the Board orders its repo rows by what needs the owner, by latest change, by open work, by name, or as configured.

- A labelled select with five options: "Needs you" (the default), "Latest change", "Most to do", "Name",
  "Config order". Only the rows move; the columns, the cards and the "Unknown repo" row stay as UI-133
  has them, and "Unknown repo" stays last.
- Needs you: most intents waiting on the owner first, i.e. those with a Needs you chip (UI-56). Latest
  change: the repo whose intents moved most recently first. Most to do: most open intents first (the
  open count of UI-134). Name: A to Z, ignoring case. Config order: UI-133's order.
- Verified by: `ui: board sorts repos by the chosen order`

### UI-147 · The server provides the sort keys

`GET /api/board` carries what each sort needs, so the page only orders rows.

- Each entry of `repos` gains `waiting` (intents waiting on the owner), `changedAt` (ISO time of the
  latest move of any of its intents, `null` when none) and `index` (its position in config order); `open`
  already exists (UI-133). The page computes none of these from cards.
- `changedAt` is the latest `updated_at` of the repo's missions, finished and dropped ones included.
- Verified by: `ui: board api gives each repo its sort keys`

### UI-148 · Ties keep config order

Repos that tie on the chosen sort keep their config order, so rows never jump between reloads.

- Every sort falls back to `index` (UI-147) on equal keys; repos without `changedAt` sort after those
  with one under Latest change. Live updates (UI-67) reorder rows only when the keys change.
- Verified by: `ui: board sort ties fall back to config order`

### UI-149 · The sort is remembered and accessible

The page remembers the chosen sort in this browser and the control works by keyboard, by screen reader and on a phone.

- Stored in `localStorage` under `towercab.board.sort` (one of `needs`, `latest`, `todo`, `name`,
  `config`); every read and write is wrapped in `try`/`catch` as UI-135 does, so without storage the sort
  still applies until the page reloads. A missing, unknown or unreadable value means `needs`.
- A native `<select>` with a visible `<label>`, reachable by Tab and changed with the arrow keys; the
  rows' new order is announced with a polite live region ("Sorted by Name"). At 360 px wide the control
  fits without sideways scrolling of the page (UI-136).
- Verified by: `ui: board sort is remembered without storage failing`, `ui: board sort works by keyboard and at 360px`

### UI-140 · Repos tab

A Repos tab, where the Queue tab was, shows one repo at a time, picked from a row of chips.

- `/repos`, the third top tab. `/queue` (its old name) shows the same page, so old links work. A chip
  per repo (the queue's lanes, UI-63) with its open intents (in progress, up next, waiting, parked)
  and a dot when one waits on the owner, after an "All" chip with the total. The chosen repo is in
  the URL, `/repos?repo=<name>`, so it can be linked; an unknown name shows All and says so.
- Data: `GET /api/repos[?repo=<name>]`, `repos()` in `src/ui/repos.ts`: `chips`, `selected`, `repo`
  (UI-141) or `all` (UI-142), the spend totals and `error`. The page updates live like the others.
- Verified by: `ui: repos chips and the All view`, `ui: repos API and refresh go through the server`, `ui: screenshots light, dark and mobile`

### UI-141 · A repo's page

A repo's page says what people can do with it, then what Towercab is doing in it and what that
cost, in a few short sections instead of one long list.

- In order: the repo's name, GitHub name and "n of m ahead" (UI-100); "What people can do" (UI-143);
  "In progress" (its missions as work rows, UI-59, owner waits included); "Up next" (numbered, in pick
  order); "Waiting" (each with its reason in words, UI-61; only when there is one); "Parked" (folded
  by default, only when there is one); "Recently done" (UI-63's last 10 done or dropped, folded, only
  when there is one); "Spend" (today, 7 days, all time, UI-137).
- Verified by: `ui: a repo page shows its features, work and spend`, `ui: screenshots light, dark and mobile`

### UI-142 · All repos

With no repo chosen, the page shows one short card per repo, not one long list.

- A card per repo: its name, GitHub name, counts in words (in progress, needing the owner, up next,
  waiting, parked; the zero ones of the last three left out) and its spend; it links to the repo's
  page. The "Add repo" form (UI-130) ends the All view.
- Verified by: `ui: repos chips and the All view`, `ui: screenshots light, dark and mobile`

### UI-143 · Feature list on the page

The repo's page leads with its feature list, grouped as In progress, Live and Planned.

- From `features/<repo>.md` as the local checkout has it (INT-37's `localFeatures`, no pull) and
  INT-40's planned intents. A line Towercab added for an intent links to the intent's page. "Edit the list" links to the file on GitHub when it exists.
  Nothing listed → "No features listed yet."
- Verified by: `ui: a repo page shows its features, work and spend`, `ui: screenshots light, dark and mobile`

### UI-144 · Reading the list from the repo

The first time a repo's page is shown, Towercab asks once for its list to be read from the repo, and
the page offers to read it again.

- `GET /api/repos?repo=<name>` for a configured repo whose run (INT-39) was never asked for and whose
  file has no line of its own asks for it through the `features` action, only while Towercab runs;
  the All view and later looks never ask again. Under the list, one sentence says where it stands:
  asked, reading, `Last read from the repo <when>: <n> live features.`, or the failure and its reason.
- "Refresh from the repo" (shown while Towercab runs, unless a run is asked for or running) posts
  `{action: "features", repo}`; the reply says the list is rewritten within a few minutes, or that a
  run is already on its way.
- The backfill's state is part of the page's version (`dbMark` reads the `features:%` meta rows), so an
  open page shows a run asked for, started, done or failed without anything else moving.
- Verified by: `ui: the first look asks for the backfill once`, `ui: features action asks the loop once`, `ui: repos API and refresh go through the server`, `ui: a backfill's state changes the page's version`

### UI-145 · Repos on a phone

The Repos page works at phone width and in light and dark, like the rest of the page.

- Chips wrap onto more lines; the All view is one column at 720 px or less; nothing scrolls sideways
  (UI-68).
- Verified by: `ui: screenshots light, dark and mobile`

### UI-150 · Settings on the repo page

A repo's page has a Settings section where the owner sees and changes how many missions run at once.

- After "Spend" (UI-141): "Settings" with a field per setting of [REPO-14](repo.md): "Missions building at
  once" (`workers`) and "Intents ahead of build" (`ahead`), each a whole number 1–16 with its current value,
  its default and a one-line explanation in plain words. A line under the form says where the values
  come from: `Saved in TOWERCAB.md in the repo.`, or before the move `Still kept by Towercab; moving
  them into the repo ([UI-154](#ui-154--the-move-on-the-page)).`
- Under the form, `Kept on this machine only:` lists the repo's environment variable names, comma
  separated (`None set.` when there are none). Values are never sent to the page or the API.
- The form is part of `GET /api/repos?repo=<name>` as `limits` (`settings` is the GitHub check of
  REPO-30): `{values, defaults, inFile, pending, moved, envNames, waitHours, fileError, fileUrl, move,
  canSave}`. It is absent in the All view.
- Verified by: `ui: a repo page shows its settings`, `ui: env names show but never values`, `ui: screenshots light, dark and mobile`

### UI-151 · Saving opens a PR

Saving the form opens a pull request with only what changed and says so.

- "Save" posts `{action: "repo-settings", repo, changes}` (UI-66's actions) and is off until a value
  differs from the shown one. A value outside 1–16 is refused in the form and again by the server with
  REPO-14's reason. The reply links the PR: `Opened PR #<n>. The change applies after it is merged.`;
  nothing changed → `Nothing changed.`; a refusal or GitHub failure shows its reason and keeps the typed
  values (UI-67). Only while Towercab runs, as the other actions.
- "Back to default" beside a value that is set in the file sends `null` for it (REPO-16).
- While the 24-hour wait of REPO-19 runs (`waitHours` not null), pressing Save first shows one confirm
  line, `An older Towercab can't read this setting; a rollback in the next day would need a manual fix.`,
  with "Save anyway" and "Cancel"; "Save anyway" posts the action with `confirmed: true`. After the wait
  there is no extra line.
- Verified by: `ui: saving settings posts only the changed keys`, `ui: an invalid setting is refused in the form and by the server`, `ui: a failed save keeps what was typed`, `ui: a save in the first 24 hours asks to confirm`, `ui: no confirm line after the wait`

### UI-152 · Pending in PR

A setting waiting in a pull request shows the new value and the PR until it merges.

- Beside the current value: `pending: <new> in PR #<n>` linking the PR, from REPO-17's `pendingSettings`.
  Typing again while it is pending shows the pending value as the starting point and saves into the same
  PR (REPO-16). When the PR merges or closes the mark goes at the next refresh without a reload, and the
  current value changes once the base branch is fetched (REPO-14). The pending state is part of the
  page's version, so an open page updates.
- Verified by: `ui: a pending setting shows its PR`, `ui: the pending mark clears when the PR merges or closes`

### UI-153 · An invalid file shows its reason

When the repo's `TOWERCAB.md` cannot be read, the repo's page says why, so the owner can fix it.

- A notice at the top of the repo page and on its card in the All view and its Board lane: `TOWERCAB.md
  in <repo> can't be read: <reason>`, with a link to the file on GitHub; the reason is REPO-18's. The
  Settings form still shows the limits in force (REPO-15) and says that they are the last good ones. The
  notice goes when the file is valid.
- Verified by: `ui: an invalid TOWERCAB.md shows its reason`, `ui: the notice goes when the file is valid`

### UI-154 · The move on the page

While a repo's settings are being moved into the repo, the page says where that stands.

- Before the move: `Moving these settings into the repo: PR #<n>` with a link while REPO-19's PR is
  open; nothing once moved. After a close without merging: one line, `The PR that moves these
  settings was closed; Towercab still keeps them.`, with an "Open the move PR again" button that posts
  `{action: "repo-move", repo}`. The reply is `Opened PR #<n>.` or REPO-19's refusal; the button is
  hidden while a move PR is open and once moved, and the line goes with it.
- Until Towercab has run this version for 24 hours (REPO-19), the section shows one line, `Towercab
  moves these settings into the repo by itself in <n> hours, once it has run this version for a day.`;
  the form stays editable (UI-151 adds the confirm line). `limits` in the API carries `waitHours`
  (null once the wait is over).
  The Settings section, like the rest of the Repos page, fits 360 px, works in light and dark and by
  keyboard, with labels on the fields (UI-68, UI-145).
- Verified by: `ui: the move PR shows on the repo page`, `ui: a closed move PR offers to open it again`, `ui: the page says how long until the automatic move`, `ui: settings fit a phone and work by keyboard`, `ui: screenshots light, dark and mobile`

### UI-155 · Not-ready badge on the Repos tab

A repo that is missing required setup shows a "not ready" warning on the Repos tab, on its chip and on its card.

- The badge reads "Not ready" with the count of missing items in its accessible name, and uses the
  warning colour of UI-68, never the "Needs you" colour. A repo that holds work back ([LOOP-70](loop.md))
  says so in the same badge ("Not ready · new work paused"); otherwise it is a warning only. A repo with
  only `unknown` items shows "Could not check" in the same colour. It comes from the stored readiness
  ([REPO-24](repo.md)); `GET /api/repos` adds `ready`, `blocks` and `missing` to each chip and card.
- Verified by: `ui: repos chips and cards show the not-ready badge`, `ui: screenshots light, dark and mobile`

### UI-156 · What a repo is missing

A not-ready repo's page lists each missing item in plain words, above everything else, so the owner knows what to fix.

- A "Set up this repo" section right under the repo's name (before UI-143): one line per missing item
  (REPO-24's words) and per `unknown` item (as a warning), the suggested kind when the kind is
  unconfirmed ([REPO-21](repo.md)) with the lines to add to `TOWERCAB.md` (`kind`, and `readiness:
  block` to start holding work back), and one sentence saying whether new intents wait (LOOP-70) or only
  a warning is shown. Nothing missing or unknown and nothing waived → no section.
- Waived items are listed there too, each with the owner's reason (`Waived: <reason>`).
- It links to the repo's setup intent, and to the open pull request that proposes it (LOOP-71, from the
  proposed pull requests of LOOP-92), so the owner can act without leaving Towercab for another tool to
  find it.
- The new intents of this repo that wait for it read `Waiting: repo not ready` in the Waiting list (UI-61).
- Verified by: `ui: a not-ready repo page lists what is missing`, `ui: a repo page shows waived items with their reason`, `ui: a repo page links the open setup proposal`, `ui: readiness screenshots light, dark and mobile`, `ui: screenshots light, dark and mobile`

### UI-157 · Not-ready badge on the Board

The Board marks the repos that are not ready, so the owner sees it without opening the Repos tab.

- The repo's lane header on the Board (UI-133) shows the same badge as UI-155, linking to the repo's
  page; its missing items are the badge's tooltip. A folded repo (UI-135) keeps the badge.
- Verified by: `ui: board lanes show the not-ready badge`

### UI-158 · The stage map always lists every stage

Every task's stage map shows the same full list of stages, whatever the repo, so maps look alike.

- Changed by [UI-272](#ui-272--the-stage-map-shows-the-path-this-intent-takes): stages that cannot apply are left out and summed up in one line, and unreached ones fold.

- Replaces the "listed only when the attempt visited them" rule of UI-123: the map lists the stages of
  UI-72 and all of the ship stages for every attempt. A stage the attempt never reached is `not reached`
  as before; one that does not apply is `skipped` with its reason (UI-159).
- The ship stages are listed for repos with no `live` block, and for attempts that finished before this
  rule, with the same reasons.
- Verified by: `ui: stage map lists every stage for every repo`

### UI-159 · Why a stage is skipped

A stage that does not apply to the repo's kind says why, in the map itself.

- The `reason` of a `skipped` visit-less stage is REPO-26's text (`a library has nothing to deploy`,
  `kind not set`), shown on the node as for other skipped stages (UI-73). It comes from the repo's
  confirmed kind, or the suggested one while unconfirmed ([REPO-21](repo.md)), at the time the page is built; a stage the attempt did visit keeps its own outcome.
- Changed by [UI-272](#ui-272--the-stage-map-shows-the-path-this-intent-takes): a stage that cannot apply has no node; the reason is the tooltip of the line that names it (`offPath.reason` in the data).
- Verified by: `ui: ship stages are skipped with the kind's reason`, `ui: screenshots light, dark and mobile`

### UI-184 · Proposed cards

The overview shows each proposed intent as a "Proposed" card, so the owner sees what waits for a yes.

- A "Proposed" section on the overview, only when there is one, after the needs-you cards of
  missions and the problems (UI-246; it was before them), shown as UI-247's rows. Each card (INT-52) carries: the title; the repo; `u`, `i`, `a`; the priority it would get or
  "would be parked"; "from <proposer>"; "waiting <duration>" (the PR's age); a "Draft" chip when it is
  one; "Open on GitHub" (the PR); and "Read the intent" (the intent file at the PR's head). It has the
  anchor `#proposed-<PR number>`, which LOOP-93's message links.
- A GitHub-only PR (INT-51) says why it can't be accepted here (`Changes more than one intent` or
  `Changes more than an intent file`) and offers the PR link and Close, not Accept. Plan PRs keep their own cards (UI-58).
- Data: `GET /api/overview` gains `proposed`, a list of the cards; it is part of the page's version
  (UI-67), so the page updates when one arrives or goes.
- Verified by: `ui: the overview lists proposed intents`, `ui: a GitHub-only proposal can be closed but not accepted`, `ui: screenshots light, dark and mobile`

### UI-185 · Accept and Close

The owner accepts or closes a proposed intent from its card, and the page says what happened.

- "Accept" posts `{action: "accept", pr}` and "Close" posts `{action: "close", pr, text?}` to
  `POST /api/actions` (UI-65), with the head SHA the card showed. Close asks for a short reason, with a
  default. The server does what INT-53 says and replies with its one sentence; the card goes when the
  PR does, and a failure stays on the card in the owner's words.
- Accept is disabled with its reason while the loop's last read failed or the PR is GitHub-only. Close
  is offered on every card.
- Verified by: `ui: accept merges the proposal and the card goes`, `ui: close sends the reason`, `ui: a refused accept says why`

### UI-186 · Proposed on a repo's page

Each repo's page lists the proposed intents for that repo, with the same cards and buttons.

- A "Proposed" section on UI-141's page, after "In progress", only when the repo has any: the same
  cards as UI-184, with Accept and Close. The repo is the intent's `repo`, matched like INT-2's.
- A proposal whose repo Towercab doesn't know (LOOP-65), or whose file can't be read, shows on the
  overview only, with the repo name as written.
- Verified by: `ui: a repo page lists its proposed intents`, `ui: a proposal for an unknown repo shows on the overview only`

### UI-187 · Proposed on the Board

The Board counts how many proposed intents wait, overall and per repo.

- The Board's heading says `<n> proposed` when there are any, linking the overview's section. A repo
  row header adds `<n> proposed` (UI-134's counts) for its repo; proposals of unknown repos count in the
  heading and in the "Unknown repo" row. No proposed intents → nothing is shown. They are not cards
  in the grid.
- `GET /api/board` gains `proposed` (total) and a `proposed` count per repo row.
- Verified by: `ui: the board counts proposed intents`

### UI-188 · Proposed intents in priority order

Proposed intents are listed by the priority they would have, and the page says when the list may be out of date.

- Descending by priority (INT-52), ties by oldest PR first; the ones that would be parked come last,
  in the same order. The overview and each repo's page use the same order.
- When the last read failed (LOOP-92), the section says `Couldn't reach GitHub at <time>: this list
  may be out of date.` above the cards it kept.
- Verified by: `ui: proposed intents are sorted by priority`, `ui: a failed read says the list may be out of date`

### UI-189 · Fold a Needs you card

Removed: the Needs you cards are items of the Inbox (UI-259), one shown at a time, so there is nothing to fold; lists fold under their headers (UI-267).

### UI-190 · A folded card's line

Removed: the Needs you cards are items of the Inbox (UI-259), one shown at a time, so there is nothing to fold; lists fold under their headers (UI-267).

### UI-191 · Remember folded cards

Removed: the Needs you cards are items of the Inbox (UI-259), one shown at a time, so there is nothing to fold; lists fold under their headers (UI-267).

### UI-160 · Your steps on the intent page

The intent page shows the owner's steps as a checklist they tick off.

- A "Your steps" block (UI-62) when the plan has steps: before-merge ones first, then after-merge ones,
  each a checkbox with its text and why. Ticking posts `{action: "step", intent, n, done}`
  ([SHIP-22](ship.md)) and shows the time ticked. The block is highlighted while the mission waits
  on `your steps first` or `your steps`. The card shows the same wait as a needs-you card
  ([LOOP-74](loop.md)).
- Verified by: `ui: your steps checklist`, `ui: ticking a step posts the action`

### UI-161 · Your steps in the map and the airspace

A change waiting on the owner's steps is visible where the rest of its path is.

- The stage map (UI-123) has Your steps (`steps`) after Merging, listed only when the attempt visited
  it. In the airspace (UI-120), a plane at `steps` sits at `04 deploy`; a plane held by steps before
  the merge sits at the gate's `you` station.
- State words (UI-121): `steps`: "waiting for your steps"; the hold before the merge: "waiting for your
  steps before merging".
- Verified by: `ui: stage map shows your steps`, `ui: your steps in the airspace`

### UI-162 · Merged, not verified live

A change that ended without a live check looks different from one that works live.

- The card and the intent page say "Merged, not verified live" in the muted style (not the done
  style), with the reason "No live check set up for this repo." ([SHIP-21](ship.md)). A change whose plan
  said there was nothing to check live shows as done, with "Nothing to check live: <why>" on the page. The board
  puts it in the done column with that label; the airspace shows it as landed without the ship stations.
- Verified by: `ui: unverified is shown apart from done`, `ui: nothing to check live shows as done`, `ui: screenshots light, dark and mobile`

### UI-163 · Steps and the unverified end in the views

The generated overview and the command line say what is open for the owner.

- `TODO.md` ([INT-6](intents.md)): an intent waiting on steps is under Waiting on me with "your steps"
  and the count left ("2 of 3"). `DONE.md`: an intent with `verified: no` carries "(merged, not verified
  live)"; one without it has no mark. `towercab status` and `next` show the same words.
- Verified by: `intents: TODO shows steps left`, `intents: DONE marks unverified`, `cli: status shows steps`

### UI-164 · The exits are buttons

Every way out of a wait is a button on the card that does exactly what it says.

- On the needs-you card (UI-58), the intent page (UI-62) and the plane card (UI-80), each option of a
  question is a button labelled with the option and what it does (PIP-114); `continue` posts the
  option as a reply, `steps` switches the delivery (PIP-113), `drop` drops with the confirm of UI-58.
  The reply box stays for `continue`.
- `no changes` shows "Nothing to build: I did it myself" (LOOP-76), which posts the `done` action
  (UI-66 → the `done` command), next to an optional one-line field for what the owner did, which
  becomes a ticked step (LOOP-76). A mission waiting on `your steps` shows the checklist of UI-160 and the
  same button.
- A stuck wait (LOOP-77) shows "Stuck: this came back with nothing new" and only those of the `steps`,
  `done`, start over and drop buttons that the wait offers: no reply box. `GET /api/state` (UI-65)
  carries `exits` per waiting mission (a list of `{do, label}`) and `stuck`.
- When `done`, `steps` or drop would close an open code PR with commits (LOOP-76), the button first
  opens a confirm that names the PR and its commit count and says its branch is deleted and nothing is
  merged; only its OK posts the action. The state carries the PR number and commit count (`openPr:
  {number, commits}`) of such a mission for this. When the PR can't be read the confirm gives the
  general warning of LOOP-76 ("couldn't check the PR; it may have commits") and still asks.
- After a click the card shows the done note of UI-105 ("Done by you · …").
- Verified by: `ui: question options are buttons that do what they say`, `ui: no changes offers I did it myself`, `ui: a stuck wait offers only the other exits`, `ui: exits come from the API`, `ui: an option that asks for something first only fills the reply`, `ui: exits screenshots light, dark and mobile`, `ui: closing an open PR with commits asks to confirm first`, `ui: an unreadable PR gets the general warning and a confirm`, `ui: a stuck card screenshots light, dark and mobile`

### UI-168 · Teammate review on the card and the repo page

The card shows who the change waits for and has a button to pass it on, and a repo's page and the card show a warning when the host asks for more approvals than the reviewers can give.

- A mission at the `teammate review` wait shows `Waiting for teammate review: alice, bob` (or `the code
  owners`) in its card, the intent page and the Working view; it is not under Needs you, because the
  owner has nothing to do. A mission whose Claude review did not approve shows the button **Pass on to teammates**
  (the `pass` action, which comments `/pass` as the owner, PIP-143); the button is not shown otherwise.
- `data.reviewWarning` (PIP-147) shows as a warning line on the card and the intent page. A repo with
  teammate review on shows its reviewers on its page (UI-141) and a warning line when the host's
  required approvals (LOOP-84) exceed the listed reviewers and no code owner is known.
- Verified by: `ui: a card shows the teammate review wait`, `ui: pass on button raises passed_on`, `ui: the warning shows on the card and the repo page`, `ui: the repo page shows the reviewers and the host's extra demand`

### UI-165 · The intent page shows each repo's part

The page of a multi-repo intent lists its parts, each with its state and what it waits on.

- Under the stage map (UI-158) a list with one row per repo, the lead first: the repo, the part's
  stage, a link to its PR, and "waiting for <what>" in plain words: the owner's answer, a check, the
  part it merges after (INT-43), or "the freeze of <repo>" (LOOP-79). Parts that ran into trouble show
  the reason as the stage map does.
- While the freeze is held it shows "Merges frozen in <repos>" with how long and the time limit
  (LOOP-81). A single-repo intent shows no list.
- Verified by: `ui: a multi-repo intent lists a part per repo`, `ui: a part says what it waits on`, `ui: the page shows the freeze and its age`, `ui: a single-repo intent has no parts list`

### UI-166 · The Board shows repos and the freeze

A multi-repo intent's card on the Board says how many repos it spans, and a frozen repo says so.

- The card shows "3 repos" and the state of the part furthest behind; a part that needs the owner
  makes the card a needs-you card (UI-58) naming the repo. A frozen repo's lane shows "Merges frozen for
  <title>"; other intents' cards waiting at their merge show "waiting for the freeze".
- Verified by: `ui: a multi-repo card shows the repo count and the slowest part`, `ui: a frozen repo is marked on the Board`, `ui: an intent held by a freeze says so`

### UI-167 · Freeze exits and the API

A freeze that ran past its limit shows buttons to keep waiting or to lift it, and the API carries the parts.

- The needs-you card, the intent page and the plane card (UI-164) show, for the `freeze` wait (LOOP-81),
  "Keep waiting" (posts `continue`), "Unfreeze" (the `unfreeze` action, UI-66, with a confirm saying
  the intent will end as merged, not verified live, if a part is already merged) and drop.
- After an unfreeze with no part merged, the card shows "Merges are unfrozen" and a "Freeze again"
  button (posts `continue`, LOOP-81) next to drop; nothing refreezes without the click.
- After an unfreeze with merged parts, the card of the unverified end lists each part as "merged" or
  "not merged" with its PR, says nothing was rolled back, and has a "Land the rest" button that posts
  `retry` (LOOP-81).
- `GET /api/state` (UI-65) carries per mission `parts` (a list of `{repo, stage, pr, waitsOn, merged}`)
  and per repo `frozenBy` (mission id or null).
- Verified by: `ui: a freeze past its limit offers keep waiting and unfreeze`, `ui: unfreeze confirms when a part is merged`, `ui: a lifted freeze waits for the freeze again button`, `ui: the unverified card lists merged and unmerged parts with a retry`, `ui: parts and frozen repos come from the API`

### UI-192 · Focus tab

Removed: Focus is replaced by the Inbox (UI-259, UI-266): `/focus` redirects to `/` and `GET /api/focus` is gone.

### UI-193 · The most important wait comes first

The Inbox lists the wait with the highest priority first; between equals, the one waiting longest.

- Every wait counts: approvals (spec, plan, code), questions, blocked waits (UI-58), reached caps (UI-254), and proposed
  intents (UI-184). Priority is the intent's `2i + u` (PRI-3); a proposed intent uses the priority it
  would get (INT-52), and one that would be parked comes after every other wait. A reached cap comes first.
- Ties: oldest wait first (the time the wait began, the PR's age for a proposal), then the intent ID, so
  the order never flips between two reads.
- Verified by: `ui: the inbox lists every wait in priority order`

### UI-194 · What an Inbox item shows

An Inbox item shows enough to act without opening anything else: where the work is, what it is, what happened,
and what is asked now.

- Top to bottom: the repo; the intent in one line (its title and a one-sentence overview, the first
  sentence of its Problem); what has happened so far in plain words, one line per finished phase (spec,
  plan, code) from that phase's plain brief (PIP-107), with no technical text; then the ask, the plain
  reason and the actions of the Needs you card (UI-58, UI-126, UI-164), the risk block (AUT-20)
  and the PR link. A proposed intent shows its fields and Accept/Close (UI-185) in the same place.
- A phase not yet reached is not listed. A mission from before briefs shows the review's summary
  (UI-126's fallback) in place of the history.
- Verified by: `ui: the inbox shows the repo, overview, history and the ask of each item`

### UI-195 · The next one takes its place

Removed: the Inbox moves to the next row when a wait ends (UI-259), without Focus's skip list.

### UI-196 · How many more

Removed: the Inbox lists every wait and its heading counts them (UI-259).

### UI-197 · Same actions, any screen

The Inbox adds no new way to act, and it works on a phone and by keyboard.

- Every action posts to `POST /api/actions` (UI-65), exactly as on the Needs you card; the Inbox has no
  action of its own. The same refusals and errors show in the same words.
- At 360 px wide the item is one column with no sideways scroll; buttons are at least 44 px tall. Every
  action is reachable by Tab in reading order with a visible focus ring; the item has a heading the
  Enter key moves the focus to (UI-261), and the change is announced politely (`aria-live="polite"`).
- Verified by: `ui: the inbox card has the actions of the needs-you card`, `ui: on a phone the inbox is a list that opens the card`, `ui: screenshots light, dark and mobile`

### UI-236 · The shadow's tag shows everywhere

Anything the shadow did shows a `[shadow]` tag in the page, on the intent's timeline and on cards.

- An intent with `source: shadow` shows the tag beside its title in lists, the card and the intent page;
  a timeline entry caused by the shadow (a reply, a start, a draft, a confirmed action) shows it too, from
  `shadow_actions` (SHD-19). The tag has a text label, not colour alone.
- Verified by: `ui: shadow actions are tagged on the timeline and cards`

### UI-237 · The shadow's recent actions

The overview lists the shadow's recent actions, each linked to what it touched.

- A "Shadow" panel shows the last 10 rows of `shadow_actions` via `GET /api/shadow` (`{enabled, actions,
  pending, spentToday, cap}`): the time, a sentence, the outcome (done, refused, held), and a link to the
  intent or PR. Held actions show a "waiting for your yes in Telegram" line. With the shadow off the panel
  is not shown. Today's shadow spend against its cap shows in the same panel.
- Verified by: `ui: shadow panel lists recent actions with links`, `ui: shadow panel is hidden when off`

### UI-238 · Reset from the page

The owner can reset the shadow from the panel.

- A Reset button in the Shadow panel asks to confirm, then posts `{action: "shadowReset"}` to
  `POST /api/actions` (UI-65); the reply says what happened as in SHD-17. At 360 px it is at least 44 px tall.
- Verified by: `ui: shadow reset asks first and resets`

### UI-239 · Owner-only intents say "only you"

Intents set to `a0` show "only you" in the page and in `towercab status`.

- Cards, lists, the intent page and the status output show the label "only you" (text, not colour alone) where they show autonomy, with the line "Only you can answer or approve this." Waits on such an intent read as waiting for you in the needs-you list. The page is where the owner answers and approves such an intent, and it offers Pause and Resume for that intent (SHD-22), and Resume for any intent paused that way. Notes of ignored replies (AUT-32) show on the timeline. The shadow panel (UI-237) lists a refused action on an a0 intent as refused.
- Verified by: `ui: a0 intents show only you`, `ui: an intent can be paused and resumed from the page`, `status: a0 intents show only you`

### UI-244 · One count of what needs you

Every screen shows the same number of things that need the owner, and the parts add up.

- One server-side function defines a wait on the owner: approvals (spec, plan, code), questions, blocked
  waits, owner steps before or after merge (UI-160, UI-162), and proposed intents (UI-184). `GET
  /api/state`, `/api/inbox`, `/api/board` and the repo views (UI-141) all use it; none keeps its own
  rule (`waitsOf` and the working list of `overview()` no longer disagree on the `steps` stage).
- The count is `needs` = `missions + proposed`. The top bar (UI-57), the tab title `(<n>)`, the overview
  headline, the Inbox (its list and `needs`, UI-259) and the Board's "Needs you" chips (plus its `<n> proposed`,
  UI-187) all equal it. The headline may split it ("4 need you · 11 proposed") but the parts sum to `needs`.
- A repo's view counts the same waits for that repo only; the repos' counts sum to the total, unknown
  repos included.
- Verified by: `ui: every screen counts the same things that need you`, `ui: the headline parts add up to the focus and board counts`

### UI-245 · Owner steps are a Needs you card

A mission waiting for the owner's own steps shows as a Needs you card, not as work in progress.

- A mission at the `steps` stage (and any other wait on the owner's steps) leaves the Working list and
  appears among the Needs you cards, with its checklist (UI-160) and its exits (UI-164), ordered by wait
  like other cards (UI-58). The "working" count (UI-57) and pill count only missions Towercab is working on.
- Verified by: `ui: a mission waiting on owner steps is a needs-you card`, `ui: the working count excludes owner waits`

### UI-246 · The overview links to the Inbox first

The overview sends the owner to the Inbox for what waits, and keeps what is moving.

- Order: headline → one line `<n> need you · <p> proposed` linking to the Inbox (UI-266) → Problems → Working (then Up
  next and the rest as today). The airspace keeps its place and starts folded below 640 px wide; the owner can open it.
- Verified by: `ui: the overview links to the inbox instead of listing cards`, `ui: the airspace starts folded on a phone`

### UI-247 · Proposed intents take one line

Each proposed intent is one compact row, so ten fit on a phone screen.

- A row shows: the title (a link that opens the intent file, UI-184's "Read the intent", with "Open on
  GitHub" beside it in the same menu or link target list), the repo, the priority (or "would be parked"),
  the age, and Accept and Close (UI-185; a GitHub-only PR still offers Close only). The `#proposed-<PR
  number>` anchor, the Draft chip and the stale-list note (UI-188) stay.
- Repo pages (UI-186) use the same rows under a header that folds them (UI-267); the first-5 fold and its "Show <n> more proposals" button are gone. In the Inbox a proposal is a list row (UI-259).
- Verified by: `ui: proposed intents are one line each`

### UI-248 · The ask and its button come first on a card

A Needs you card shows what is asked, the brief and the main button before the detail.

- Order in the card: title and repo; the ask; the brief (UI-126); the main action (for example "Merge
  spec PR"); then the risk as one line (`Medium risk · easy to undo · fairly sure it works`, from AUT-20's
  fields) and the open points as `<n> open points for you`, each opening on tap; then the rest
  (access list, menu, reply box). The same card is used in the Inbox (UI-259) and on the
  intent page (UI-62).
- On a 375 px wide screen the ask, the brief and the main button fit in the first 700 px of the card.
- Verified by: `ui: the main button sits under the brief`, `ui: risk and open points are folded to one line each`, `ui: screenshots light, dark and mobile`

### UI-249 · Waiting for a build slot says Queued

A mission that only waits for a build slot shows "Queued", not "Working".

- Its chip is `Queued` (UI-56) with the sentence "waiting for a build slot behind <title>" (UI-59);
  it is not counted as working (UI-57).
- Verified by: `ui: a mission waiting for a build slot shows queued`

### UI-250 · Up next says a shared reason once

When every row of "Up next" has the same reason, the reason is written once above the list.

- If all rows share one reason text (for example the repo's limit before build), it shows once above the
  list and the rows omit it; rows whose reason differs keep their own. One row alone keeps its reason.
- Verified by: `ui: up next states a shared reason once`

### UI-251 · The screenshots show the crowded overview

The screenshot fixture has the cases that made the overview hard to use.

- `ui/fixture.ts` has a crowded scene: at least 5 waits (one on the owner's steps), 18 proposed intents and 36 queued
  intents. The Inbox and Overview screenshots (light, dark, mobile) are taken with it.
- Verified by: `ui: screenshots light, dark and mobile`, `ui: the crowded fixture has the waits, proposals and queue of the live page`

### UI-253 · Budgets are edited in the page

The owner sets the daily and monthly budget, and each repo's caps, in the page.

- Overview: a "Budget" section with two fields, "Per day" and "Per month" (USD, empty = no limit), each
  showing what is spent so far in that period. A repo's page has the same two fields as "Caps" inside
  Settings (UI-150), saved apart from the settings form because they apply at once and open no PR. A
  line under them says `Saved in config.toml on this machine.`
- "Save budget" (on a repo's page "Save caps", so it never reads as the settings form's "Save") posts `{action: "budgets", scope: "all" | <repo>, daily, monthly}` (UI-66's actions); the
  server writes the changed keys to `config.toml` (MET-31); an empty field removes the key. An invalid
  amount is refused in the form and by the server with MET-31's reason; a refusal keeps the typed values
  (UI-67). Reply: `Saved. Applies now.`
- Each change is recorded in the Activity page (UI-64) as kind `settings`, naming the key and the old →
  new value (`daily budget: $80 → $100`, `none` for unset), with the time. A save that changes nothing
  records nothing.
- `GET /api/state` carries `budgets` (`{scope, daily, monthly, spentDay, spentMonth, …}`) and the reached
  caps (`caps`) inside `spend`, so the response's top-level keys stay as they were;
  `GET /api/repos?repo=<name>` carries the repo's own `budgets`. Fits 360 px, works in light and dark and by keyboard.
- Verified by: `ui: the budget section saves daily and monthly amounts`, `ui: a repo page has its own caps`, `ui: an invalid budget is refused in the form and by the server`, `ui: a budget save is written to config.toml`, `ui: a budget change shows in activity as old to new`, `ui: an unchanged save records nothing`, `ui: screenshots light, dark and mobile`

### UI-254 · A reached cap is a card that offers to raise it

When a cap pauses work, a card at the top says which one and lets the owner raise it in one tap.

- A card among the Needs you cards (UI-244: it counts in `needs`, once per reached cap): `Daily budget
  reached: $<spent> of $<cap>`, or `<repo> reached its monthly cap: …`, with the line "Work for <scope>
  is paused until <midnight | the 1st>." and the number of intents waiting behind it.
- Buttons: "Raise to $<cap + 10>" (a rounded step: 10 % of the cap, at least $5, rounded up to whole
  dollars) and "Set a different amount…" (a field; it posts UI-253's action). "Wait" needs no button:
  the card goes when the period ends. Raising to a value above the spend removes the card and work resumes
  (MET-33).
- Verified by: `ui: a reached cap shows a card with the amounts`, `ui: raising the cap from the card resumes work`, `ui: the cap card counts as needing you`, `ui: the cap card goes when the period ends`

### UI-255 · Estimate and spend on an intent

Each intent shows what it is expected to cost, and while it runs, what it has spent against that.

- Before start (proposed, queued, up next, the intent page): `Estimated $<low>–$<high>, about $<median>`
  from MET-34, or `No estimate yet` when there is none. Working rows and the intent page (UI-59, UI-62)
  show `$<spent> of about $<median>` and a bar that turns amber above `high` and says `over the usual
  range`. The bar never blocks work.
- Verified by: `ui: an unstarted intent shows its estimate`, `ui: a running intent shows spent against the estimate`, `ui: no estimate says so`, `ui: the over-estimate bar turns amber`

### UI-256 · The top bar shows spend against the budget

The top bar shows how much of the budget is used and turns amber at 80%.

- Replaces UI-57's spend-today text: `$<spent today> of $<daily>` and, when a monthly budget is set,
  `· $<spent month> of $<monthly> this month`; with no budget, `$<spent today> today`. Amber (a class and
  text `80% used`, not colour alone) at spend ≥ 80% of either budget, red with `Budget reached` at 100%.
  The tightest repo cap (MET-33) shows only on its repo page and card, not in the bar.
- Verified by: `ui: top bar shows spend against the budget`, `ui: top bar turns amber at 80 percent`, `ui: top bar says budget reached`

### UI-257 · One control for an intent's autonomy

Each intent's page and card have one control that shows its autonomy, a0 to a5, and changes it.

- A segmented control with six choices `a0`..`a5`, the current one marked (text and state, not colour alone), on the intent's page and on its card (INT-52, UI-244's cards) in the overview, queue and working rows. Choosing one posts `{action: "autonomy", id, a}` with `actor: owner` (UI-66's actions) and applies AUT-34: one commit, `a` only. The reply is `Saved. Applies from the next gate.`
- Lowering is one click and applies at once (AUT-34). Raising opens a confirm step first: it names the new level (`Raise to a<n>?`) and says in one or two sentences what Towercab may then do without asking (from AUT-3, AUT-4, AUT-13: who merges, which gates it passes alone, what access a worker has), with "Raise" and "Cancel". Nothing is written until "Raise"; "Cancel" and Escape leave the level as it was. The confirm step is the same on the page and on cards. An intent whose repo cap (AUT-8) is lower shows `capped at a<n> by the repo` beside the control.
- A refusal (the intents repo cannot be pushed, an unknown id, a level outside 0–5) keeps the control on the old level and shows the reason (UI-67). Done or dropped intents show the level without the control.
- The change is recorded in the Activity page (UI-64) as kind `settings`, `a: a3 → a4`, with the time. `GET /api/state` and the intent's API carry `a` for the control. Fits 360 px, light and dark, and works by keyboard (arrow keys move between levels).
- Verified by: `ui: the intent page changes autonomy`, `ui: a card changes autonomy`, `ui: raising autonomy asks for a confirmation that names the level`, `ui: lowering autonomy is one click`, `ui: cancelling the confirmation writes nothing`, `ui: autonomy shows the current level and the repo cap`, `ui: a refused autonomy change keeps the old level`, `ui: an autonomy change shows in activity`, `ui: screenshots light, dark and mobile`

### UI-258 · A raise from elsewhere is a Needs-you card

When someone other than the owner raises an intent's autonomy, a card at the top says who, and lets the owner accept it or set it back.

- A card among the Needs you cards (UI-244: it counts in `needs`, once per flagged intent) from AUT-35's flag: `<who> raised <intent> from a<from> to a<to>`, with the line `It still runs at a<from> until you decide.` `<who>` is the GitHub account, or `an unknown account`.
- Buttons: "Accept a<to>" (posts `{action: "autonomy", id, a: <to>}` with `actor: owner`; its confirm step is UI-257's, so it names the level and what it allows) and "Set back to a<from>" (one click, writes `a: <from>` with AUT-34). Either removes the card. The intent's page and card also show the flag beside the control.
- Verified by: `ui: a flagged raise shows a card naming who raised it`, `ui: the flag card counts as needing you`, `ui: accepting a flagged raise asks for a confirmation`, `ui: setting a flagged raise back removes the card`

### UI-259 · An Inbox page lists everything that needs the owner

One Inbox page lists every wait, with the list on the left and the selected card on the right.

- `/` is the Inbox, the page the app lands on, and its top tab comes first and replaces Focus (UI-133, UI-266). The list holds the waits UI-244 counts: approvals, questions, blocked waits, owner steps, proposed intents and reached caps (UI-254); flagged raises (UI-258) join it when they are built. Order is UI-193's (priority, then oldest wait, then intent ID). `GET /api/inbox` returns `{items, needs, lastVisit, readOnly, stale, version}` with `needs` equal to UI-244's count; it is part of the page's version (UI-67), so the page updates without losing typed text.
- A list row is one line (UI-247's compactness): kind chip, title, repo, age. The selected row is marked (`aria-selected`) and its card shows on the right: the Needs you card of UI-248, the proposal view of UI-194 and UI-185, or the cap card. The URL is `/inbox/<item id>`, so a link opens that item. With no item in the URL the first row is selected, so a card is always visible; selecting is not acting: nothing is posted until the owner uses a button or the confirm of UI-261.
- Every action posts to `POST /api/actions` (UI-65) exactly as the Needs you card does; the Inbox has no action of its own (UI-197's rule). When the selected item's wait ends, the selection moves to the next row (a fade of at most 300 ms, none under `prefers-reduced-motion`). With no wait left, the page says "Nothing needs you."
- Verified by: `ui: the inbox lists every wait in priority order`, `ui: the inbox count equals the needs count`, `ui: the inbox card has the actions of the needs-you card`, `ui: the inbox moves on when a wait ends`, `ui: an inbox link opens its item`, `ui: the inbox opens with the first item selected and posts nothing`

### UI-260 · The Inbox on a phone is a list that opens the card

Below 640 px wide the Inbox shows the list, and a tap opens the card full screen.

- Below 640 px: the list alone; a row opens the card on its own screen (`/inbox/<id>`) with a "Back to the inbox" button, and the browser's back button does the same. The list keeps its scroll position on return. No sideways scroll at 360 px; rows and buttons are at least 44 px tall.
- Verified by: `ui: on a phone the inbox is a list that opens the card`, `ui: going back keeps the inbox scroll position`, `ui: screenshots light, dark and mobile`

### UI-261 · Move through the Inbox by keyboard

Single keys move through the Inbox and act on the selected item, and no key acts without a second step.

- `j` selects the next row, `k` the previous (no wrap), `Enter` opens the card and moves focus into it, `Escape` returns focus to the list. `r` focuses the reply box of the card (the answer or the reply for a question), `o` opens the PR in a new tab (the proposal's PR for a proposed intent; nothing for an item with no PR), `s` opens the snooze choices (UI-264), `/` focuses the list's filter (UI-263), `?` opens the shortcuts list.
- `Enter` only opens: it never posts an action, even on the first item the page selected by itself. No other key posts either, except as below.
- `m` offers the merge the card's main action offers (UI-248), only for a merge (spec, plan or code PR); it always opens a confirm that names the PR and the repo (`Merge <PR label>: <title>?`) with "Merge" and "Cancel", with no setting to skip it. Nothing is posted until "Merge" is clicked or Enter is pressed on it inside the confirm; the confirm opens with focus on "Cancel", so the same key press that opened it cannot confirm it. Escape cancels. It posts the card's own merge action (UI-65). On any other item `m` does nothing and says so.
- Keys do nothing while the focus is in a field, a select or a dialog, and ignore combinations with Ctrl, Cmd or Alt. A shortcut that does not apply to the item shows a short polite message (`aria-live="polite"`), not an error.
- Verified by: `ui: j and k move the inbox selection`, `ui: enter opens the card and escape returns to the list`, `ui: enter only opens and never posts an action`, `ui: m asks before merging and posts nothing until confirmed`, `ui: the merge confirm opens on cancel and needs its own click or enter`, `ui: m does nothing on an item that is not a merge`, `ui: r focuses the reply box and o opens the PR`, `ui: shortcuts are ignored while typing`

### UI-262 · A list of the shortcuts

`?` shows every shortcut, and the page says it exists.

- `?` opens a dialog listing UI-261's keys and Cmd-K (UI-265), with Escape to close and focus returned to where it was. A `? shortcuts` button sits in the Inbox heading.
- Verified by: `ui: the question mark shows the shortcuts`, `ui: the shortcuts dialog returns focus`

### UI-263 · Filter the list

A field above the Inbox list narrows it to matching items.

- Case-insensitive match on title, repo, intent ID and PR number (`#203` or `203`); while a filter is set the count reads `<shown> of <n>`. Filtering changes the view only: `needs` (UI-244) is unchanged. The filter is kept in the URL (`?q=`).
- Verified by: `ui: the inbox filter matches title, repo, id and PR number`, `ui: filtering does not change the needs count`

### UI-264 · New since your last visit, and snoozing

The Inbox marks what arrived since the owner last looked, and lets them put an item aside for a while.

- **State is on the server, per owner, not per browser,** so the phone and the laptop agree. It is kept in the database's `meta` table: `inbox:last_visit` (unix seconds) and one `inbox:snooze:<item>` per snoozed item (the wake time). No migration is needed: a database from before the Inbox simply has none of these keys, and an older Towercab ignores them. It touches no mission: the loop and the state machine never read it. `GET /api/inbox` carries `lastVisit` and each item's `new` and `snoozedUntil`, and a change moves the page's version (UI-67), so every open screen updates.
- **New:** a row carries a `New` marker (text, not colour alone) when its wait began after `last_visit`, or a snooze ran out after it. The page posts `{action: "seen"}` (UI-66's actions) once the Inbox has been visible for 3 seconds, and the server sets `last_visit` to its own clock then and forgets snoozes that have run out; a reload closed at once marks nothing as seen. The marker stays on screen until the page is left or reloaded, so rows do not change under the owner's eyes; opening an item clears its own marker at once. The heading says `<n> new`. With no `last_visit` yet (first visit), nothing is marked new.
- **Snooze:** `s` or a "Snooze" button opens the choices "1 hour", "Until tomorrow 08:00" and "Until Monday 08:00" in the browser's time zone; the page sends the chosen instant as `{action: "snooze", item, until}`, and the server refuses a time in the past or more than 30 days away, or an item that is not waiting, with the reason (UI-67). `{action: "unsnooze", item}` clears it. A snoozed item leaves the main list and shows under a "Snoozed <n>" list (UI-267) with its wake time and "Unsnooze". It returns when `until` passes, by the server's clock, with the `New` marker. A snooze whose wait ends is dropped. `s` only opens the choices; it does not pick one (UI-261's second step).
- A snoozed item still counts in `needs` (UI-244), so the top bar and the tab title do not hide it; the Inbox heading reads `<n> need you · <k> snoozed`.
- Verified by: `ui: a wait newer than the last visit is marked new`, `ui: a wait newer than the last visit shows a new marker`, `ui: the last visit is set on the server after the page was visible for 3 seconds`, `ui: the page sends seen only after it was visible for 3 seconds`, `ui: the first visit marks nothing new`, `ui: a snoozed item moves under snoozed and returns when due`, `ui: snoozing from the inbox moves the item under snoozed`, `ui: a snooze is shared between two clients`, `ui: a snooze in the past or beyond 30 days is refused`, `ui: a snoozed item still counts as needing you`, `ui: inbox state survives a restart and an older database gains it`

### UI-265 · Cmd-K search and commands

Cmd-K (Ctrl-K elsewhere) opens one box that finds intents, repos and PRs and runs commands.

- Opens on any page, as a dialog with a labelled field; Escape closes and returns focus. Typing lists matches in groups: **Intents** (ID or title words), **Repos** (name), **PRs** (a number, `#123` or `123`, matching the pull requests of the Inbox's items), and **Commands**. Arrow keys move, Enter runs, results are announced politely. A match opens the intent's page (UI-62), the repo's page (UI-141) or the PR's item in the Inbox.
- Commands: `pause` and `resume` (UI-65's actions for all work; the top bar's button has no confirm, so the box asks once itself: `Pause?` with "Cancel" focused, then the action), `go to inbox | overview | board | repos | activity`, `go to repo <name>`, and `open settings` (the Repos page, where each repo's settings are, UI-150). The box offers a command only when it applies (no `resume` while not paused, none of the actions while Towercab is not running). A command posts through `POST /api/actions` or navigates; it has no action of its own, and a refusal shows in the box in the same words (UI-67).
- The search runs in the page over data it already reads (`/api/state`, `/api/inbox`, `/api/repos`, loaded once when the box opens); it makes no request per keystroke and loads no extra service.
- Verified by: `ui: cmd-k finds an intent, a repo and a PR number`, `ui: cmd-k runs go to repo`, `ui: cmd-k pause asks for the usual confirm`, `ui: cmd-k offers only applicable commands`, `ui: cmd-k opens and closes by keyboard`

### UI-266 · The Inbox is the home page, and the Overview stays one tab away

The Inbox replaces Focus as the page Towercab opens on; the Overview keeps its own address and every old link still works.

- This covers intent 261105-2152-14. `/` is the Inbox (UI-259). The tabs read Inbox, Overview, Board, Repos, Activity; Focus is gone. The Overview moves to `/overview`. `GET /api/focus` goes away. This replaces UI-192, UI-195 and UI-196; UI-193's pick order, UI-194's content and UI-197's actions and phone rules live on for the Inbox.
- Old links keep working: `/focus` redirects to `/`, and an old Overview link with a fragment (`/#proposed-<PR number>`, `/#needs-<id>`) opens the Inbox on that item (or, if the item is no longer a wait, the Overview with the fragment). Repo, intent and Board links are unchanged. The tab bar marks the current page.
- The tab title keeps the needs-you count, `(<n>) Towercab` plus the page's name after the first tab, with `n` equal to UI-244's `needs` on every page (snoozed items included); it is `Towercab` at 0.
- The Overview keeps its headline, Problems, Working, Up next and airspace (UI-246's order, without the Needs you cards and Proposed); in their place one line `<n> need you · <p> proposed` links to the Inbox. The Board's "Needs you" chips and `<n> proposed` (UI-244, UI-187) link to the Inbox. The crowded Overview (UI-251) is no taller than 2,300 px at 1280 px wide (3,334 px with the cards); its rows are still tall, so a shorter page needs the rows themselves redesigned.
- `ui/fixture.ts` carries at least 5 waits, 18 proposals and 36 queued; the Inbox and Overview screenshots (light, dark, mobile) use it.
- Verified by: `ui: the root page is the inbox and the overview has its own address`, `ui: focus redirects to the inbox`, `ui: old overview fragments open the inbox item`, `ui: the tab title keeps the needs count`, `ui: the overview links to the inbox instead of listing cards`, `ui: the crowded overview is shorter than with its cards`, `ui: screenshots light, dark and mobile`

### UI-267 · Long lists fold under a header

Every list that can grow long has a header with a toggle that folds and opens it, and remembers its state.

- This covers intent 261105-2152-12. The lists with a header are: the Inbox's list and its Snoozed list (UI-264), Proposed on a repo's page (UI-247), Working, Up next and Problems on the Overview, and In progress, Up next and Waiting on a repo's page. Each has a header: its name, a count, and a button toggle (`aria-expanded`, `aria-controls`) that works by Enter and Space and is at least 44 px tall on a phone. The Board's repo lanes keep their own fold (UI-135); Parked and Recently done on a repo's page stay native `details` elements.
- A folded list still shows its header with the count (`Working · 12`). The count is the list's real length (the filter of UI-263 applied to the Inbox's list; the Inbox heading keeps UI-244's `needs`).
- Lists start open. The state is remembered per browser (one `localStorage` entry for all lists, like UI-146's sort; a storage failure leaves the list working, and it stays as the owner set it until the page reloads). It survives live updates (UI-67): a refresh of data neither opens a folded list nor folds an open one, and focus stays on the toggle. A link to a proposal (`#proposed-<PR>`) opens a folded Proposed list.
- Verified by: `ui: every long list has a header with a count and a toggle`, `ui: a folded list still shows its count`, `ui: lists start open`, `ui: fold state is remembered per browser`, `ui: fold state survives a live update`, `ui: fold toggle works by keyboard and on a phone`, `ui: fold state works without browser storage`

### UI-268 · Not-ready looks different from needs-you

A repo that lacks setup has its own colour and a badge that fits its text, so it is never mistaken for a wait on the owner.

- This covers intent 261106-0820-1. `--warn` gets a hue distinct from `--needs` in light and dark mode, each at least 4.5:1 against the surface it is drawn on; `ui/DESIGN.md` and the comment above `.ready-badge` say so.
- `.ready-badge` sizes to its text on every card (the Repos "All" view, the Board lane header, UI-155, UI-157), never the card's full width.
- Verified by: `ui: warn and needs colours differ with enough contrast`, `ui: the not-ready badge fits its text`

### UI-269 · A gap shared by most repos is said once

When most repos lack the same setup item, the Repos page and the Board each say so once at the top and drop the badge from each repo.

- Over the repos with a readiness result (UI-155): an item is shared when it is missing on at least 3 repos and on more than half of them (the owner confirmed this rule). The Repos page shows a line at the top, `<n> of <m> repos have <item in plain words>` (for example `9 of 11 repos have no release job`), one line per shared item.
- The Board shows the same shared items as one small line above the columns, in the short form `<n> repos: <item>` (for example `9 repos: no kind set`), one line per item or items joined on one line; it is absent when nothing is shared. It counts the same repos as the Repos page, and lists shared items for all repos, folded ones (UI-135) included.
- A repo whose only missing items are shared ones shows no not-ready badge on the Repos tab or in its Board lane header (UI-157); the badge shows for any other missing item, with only those items in its tooltip. The repo's own page still lists every gap (UI-270).
- Verified by: `ui: a shared gap is summed up once on the repos page`, `ui: the board sums up shared gaps in one line above the columns`, `ui: no badge for a repo missing only shared items`

### UI-270 · Setup gaps in plain words

The "Set up this repo" section says each gap in plain words with what to do, and keeps the raw error under "Details".

- Each missing item shows a sentence and an action (for example `Towercab's GitHub App can't read this repo's workflow settings: give it the Actions permission`). The raw command error (such as `gh api …: HTTP 403`) is inside a folded "Details" and appears once, not again under "GitHub settings". Unknown errors say `Towercab could not check this` with the raw text under "Details".
- The check time is relative and exact on hover (UI-71). The section has the same card padding as the other cards, in the spacing tokens, so text does not touch its border.
- Verified by: `ui: setup gaps are plain words with the error under details`, `ui: setup check time is relative`, `ui: setup section has card padding`

### UI-271 · A readable Board at laptop widths

Empty stations on the Board take little room, so busy ones are wide enough to read every chip.

- A station column with no cards collapses to a narrow strip showing its name and `0`; a column with cards is at least 180 px wide. At 1,280 px wide every chip's text is fully visible (no clipping, no horizontal overflow of a chip).
- A card title is cut after three lines; the full title is its tooltip and its accessible name.
- The Board stays as wide as the top bar and the other pages (1,120 px max), so the edges line up (the top bar does not widen); a Board that needs more room scrolls sideways inside that width.
- Verified by: `ui: empty board stations collapse to a strip`, `ui: busy board stations are at least 180px`, `ui: board chips are not clipped at 1280px`, `ui: board titles cut after three lines with the full title on hover`, `ui: board is as wide as the top bar`

### UI-272 · The stage map shows the path this intent takes

The stage map lists the stages this intent will go through, folds the rest, and names what does not apply.

- Replaces UI-158 and changes UI-159: stages that cannot apply to the repo (deploy, live tests, rollback and revert for a repo with nothing to deploy, REPO-26) are left out and summed up in one line, `Not part of this repo's path: <stages in plain words>`, with the kind's reason as its tooltip. A stage the attempt visited is always listed, with its own outcome.
- A run of two or more stages not reached yet folds into one row, `<n> more stages to go`, that opens to list them. A merged code PR is never shown as `skipped`.
- Verified by: `ui: stage map leaves out stages that cannot apply and says so`, `ui: unreached stages fold into one row`, `ui: a merged change does not show merging as skipped`

### UI-279 · The intent page shows how many plan steps are built

While a long plan builds, the intent page and its card say "step 3 of 6".

- Shown from the mission's `data.build` (PIP-216) as `step <steps_done + 1> of <steps_total>` while the build runs (the step being worked on), and `<steps_done> of <steps_total> steps built` while it waits between runs or on the owner. Absent for a plan with no numbered steps or a single-step plan, and once the review starts.
- `GET /api/state` and the intent's API carry `build: {stepsDone, stepsTotal}` (null when absent). Fits 360 px, light and dark.
- Verified by: `ui: the intent page shows the plan step being built`, `ui: no step count for a one-run plan`

### UI-280 · "Covered by…" closes an intent as done

The owner can pick another intent on an open intent's page and close the first as done, because the second covers it.

- An intent that is not done, dropped or stopped shows a "Covered by…" action next to Drop, at any stage and in the board's card menu. It opens a picker of the other intents of the same repo first, then the others (search by ID or title), without the intent itself, dropped or stopped ones, and any that wait `after:` this one (LOOP-156).
- Choosing one posts `{action: "done", id, by: <other id>}` (UI-66) with `actor: owner`, which runs the `done --by` command of LOOP-156 with its confirm for an open code PR with commits (UI-164). The page shows `Closed as done: covered by <other id>` with the ID as a link, and a refusal shows its reason.
- Both intents' pages show the cover on their timelines ("Covered by 261106-1201" and "Covers 261105-2152-14"), each with the other as a link. A covered intent shows as done, not dropped, with the covering intent named. Fits 360 px, light and dark; hidden for `a0` intents the same way Drop is (AUT-31) and for a viewer (USR).
- A covered intent's page shows a "Reopen" button, which posts `{action: "reopen", id}` (UI-66) and runs LOOP-157. The page then shows the intent back at its old stage, with the PRs reopened and any that could not be, with the reason. The button is hidden on every other intent.
- When the covering intent was dropped or stopped (LOOP-158), the covered intent's page shows `Not delivered: <other id> was <dropped|stopped>` with the Reopen button, and the Inbox shows the `not delivered` item with Reopen and Dismiss (UI-259). Dismiss hides the Inbox item only; the page note stays.
- Verified by: `ui: a not delivered intent shows its note and an Inbox item with Reopen`, `ui: dismissing a not delivered item keeps the page note`, `ui: reopen is offered only on a covered intent`, `ui: reopen puts the intent back and lists PRs it could not reopen`, `ui: covered by is offered at any open stage`, `ui: covered by picker leaves out itself and finished intents`, `ui: covered by closes the intent as done`, `ui: covered by shows on both timelines`, `ui: covered by asks to confirm an open code PR`

### UI-281 · Cards show the people part, the agent part is a link

Cards and lists show only the part for people; the agent part is one tap away on the intent page.

- Board cards, Inbox items, Needs-you cards and the repo page's intent rows show the people part of PIP-220 (at most 5 lines, clipped with `…` after that) and no agent text. Each has an `Agent context` link to the intent page, where the part is folded under a header of that name and opens on a click (UI-267). The link is absent when there is no agent part.
- The intent page and an opened Inbox card lead with the people part and keep the agent part (findings, file lists, logs, handoff notes) folded; PR links open the PR on GitHub, where the same split holds.
- The API carries `people` and `agent` as separate fields on a stage; the cards read only `people`. Fits 360 px, light and dark.
- Verified by: `ui: a card shows the people part and not the agent part`, `ui: the agent context is a link on a card and folded on the intent page`, `ui: no agent link when there is no agent part`

### UI-200 · Your own open pull requests are read

Towercab reads the open pull requests the owner opened by hand in each registered repo.

- Per repo, each loop pass (rate-limited like the other PR reads, through the `Forge` of `src/forge.ts`) lists open PRs whose author is the owner's GitHub login. It leaves out Towercab's own PRs (head `towercab/*`), drafts marked as such stay in the list, and PRs from forks of other people are not read.
- Per PR it keeps number, title, URL, head branch, opened-at, draft flag, the check status (`passing`, `failing`, `pending`, `none`) and the changed file paths. Nothing is written to the intent files or the mission table; the list is read-only and is not a mission.
- A failed read keeps the last good list and shows the error as a problem on the repo (no crash, no empty list). Repos on GitLab are skipped until GL has the same read.
- Verified by: `github: owner pull requests are listed without Towercab's own`, `github: a failed owner PR read keeps the last list`

### UI-201 · "Yours" on the repo page and the Board

The repo page and the Board show the owner's open pull requests as "Yours", with age and check status.

- `GET /api/state` carries `yours: [{repo, number, title, url, ageSeconds, checks, draft}]`, oldest first. They do not count in "Needs you" (UI-244) and carry no stage or Approve buttons: a click opens the PR on GitHub.
- The repo page lists them under `Yours`; the Board shows them in a separate `Yours` group per repo, away from Towercab's planes. The age reads `3 d` (exact on hover); the check status is a word and a colour, not colour alone. Hidden when empty. Fits 360 px, light and dark.
- Visible to everyone who can see the repo in Towercab, whatever their role (USR-1, USR-5: a per-repo role never hides a repo's list). The PRs are already visible on GitHub to the same people, so hiding them would only make the page disagree with GitHub. A read-only role sees them and the links, and has no action to take on them.
- Verified by: `ui: a fake owner pull request is listed as Yours on the repo page and the Board`, `ui: Yours is not counted in Needs you`, `ui: Yours is shown to a viewer and to a maintainer with a lower role on that repo`

### UI-202 · A warning when your pull request touches the same spec

When one of the owner's open pull requests changes a spec file that Towercab's own spec PR also changes, Towercab says so on its PR.

- Overlap = a path under `specs/` changed by both an owner PR (UI-200) and the spec PR of a mission in the same repo. Checked each pass for missions with an open spec PR.
- Towercab's stage comment on its PR gets one line per owner PR: `Your PR #<n> also changes specs/<file>.md; requirement IDs may clash.` The line names the IDs both PRs add when they share any. The same line shows on the intent page. The line is dropped when the overlap ends (owner PR closed or merged, or files no longer shared); it is never posted twice for the same pair.
- Only a warning: nothing is blocked, and the owner's PR is never commented on.
- Verified by: `ui: an owner pull request touching the same spec file adds the warning`, `ui: no warning when the owner's PR touches other files`

### UI-273 · An owner wait stage says what the owner did

Opening a stage that was a wait on the owner shows the owner's answer, not "it wrote no files".

- For a wait stage (plan review, code review and the like) the detail shows who decided, what (approved, changes requested, answered, closed) and when (relative, exact on hover), taken from the recorded event; while still waiting it says what it waits for. Without a recorded event it says `The owner decided on GitHub`. `This was a wait for you; it wrote no files.` is removed.
- Verified by: `ui: a wait stage shows the owner's decision`, `ui: a wait stage still open says what it waits for`

### UI-274 · A phone top bar that leaves room

On a phone the top bar is short and the airspace starts folded.

- At 375 px wide the sticky top bar is at most 100 px tall: `Updated <time>` joins the counts line instead of its own line.
- On a phone the airspace starts folded to its one-line summary; the owner opens it (the state is remembered like UI-267's). On wider screens it starts open as before.
- Verified by: `ui: phone top bar is at most 100px`, `ui: phone airspace starts folded`

### UI-275 · Airspace badges never overlap

The airspace's count badges (such as "+21") never cover a label or a plane, and the screenshots show these cases.

- The boxes of the count badges do not intersect the stage labels or the planes at 360, 768 and 1,280 px wide.
- `ui/fixture.ts` carries more than 8 repos, several of them not ready (some missing the same item, UI-269), and a CLI repo with a finished intent; the Repos, Board, intent and airspace screenshots (light, dark, mobile) use it.
- Verified by: `ui: airspace count badges do not overlap at 360, 768 and 1280px`, `ui: clarity screenshots light, dark and mobile`

### UI-276 · The repo page shows where each setting comes from

The repo's page says for each setting whether it came from the repo, the overlay or the default.

- Each of `max_autonomy`, `protected`, the checks and the other keys in effect ([REPO-44](repo.md)) carries a small
  label `repo`, `overlay` or `default`. An overlay-sourced value has no edit control; it says `Set in
  <path to the overlay file>` ([REPO-48](repo.md)). A refused overlay key shows REPO-46's one line, a notice card shows REPO-49's replaced-checks notice naming both sets of checks, and an invalid
  overlay shows its reason like an invalid `TOWERCAB.md` (UI-153). A repo without an overlay shows `repo` and `default` labels only.
- The labels come from the API's repo view, not from the page's own guess.
- Verified by: `ui: settings show repo, overlay or default`, `ui: an overlay setting has no edit control`, `ui: a refused overlay key shows its line`, `ui: replaced overlay checks show a notice`

### UI-277 · Problems show loose secrets files

The Overview's Problems block names each secrets file that others can read and the command that fixes it.

- One Problems row (UI-60) per file found by the check of LOOP-143: `<path> is readable by others: chmod 600 <path>`. The row is a failure here even though the self-update check only warns (LOOP-145); nothing is shown when all such files are mode 600.
- The rows come from the same check as `doctor`, through the API's problems list, not from the page's own guess.
- Verified by: `ui: problems show a loose secrets file with its chmod`, `ui: no loose secrets file shows no row`

### UI-278 · Running version and waiting release

The top bar shows which version of Towercab is running and, when the owner updates on releases, whether a newer release is waiting.

- The top bar's version is the running version of LOOP-152. On the release channel it adds `<tag> available` when a newer release waits (LOOP-152) and nothing when up to date. On the `"main"` channel it still says whether the checkout is behind `main`.
- The values come from the same API field as `status`, not from the page.
- Verified by: `ui: top bar shows the running version`, `ui: top bar shows a waiting release`, `ui: top bar shows no release note when up to date`

### UI-219 · Sign in with GitHub

When people are set up, the page opens on a sign-in screen with one button, "Sign in with GitHub".

- With `[auth]` set ([USR-3](users.md)) every route except the sign-in ones shows it until a session exists; after sign-in the person lands on the page they asked for. With no `[auth]` there is no sign-in and the page opens as before.
- A refused account sees "This Towercab doesn't know your GitHub account. Ask an admin to add you." with the login shown and a sign-out link; an expired or revoked session returns here with "You were signed out".
- Verified by: `ui: signed-out visitors see the sign-in screen`, `ui: an unknown account sees why it was refused`, `ui: without auth config there is no sign-in`

### UI-220 · The page offers only what the role can do

Buttons the signed-in person's role does not allow are not shown, or are disabled and say why.

- Per intent and repo (USR-5): a viewer has no action buttons; a contributor sees Create, and Answer only on a question they were asked (USR-9); a maintainer sees Approve, Merge, Reply, Start, Boost, Drop, Edit, Confirm (on an intent waiting for confirmation, AUT-23) and autonomy; the admin page link shows for admins only. A disabled button's tooltip reads "Needs maintainer on <repo> (you are viewer)".
- A 403 from the API (USR-7) shows its reason in the page's error line, never a blank failure.
- Verified by: `ui: a viewer sees no action buttons`, `ui: a contributor sees only answer and create`, `ui: a disabled action says which role it needs`, `ui: the admin link shows for admins only`

### UI-221 · Cards and timeline show who did it

Every card's last action and every timeline entry names the person and the channel.

- "Approved by Ana · page", "Answered by Ben · Telegram", "Merged by Cy · GitHub" (USR-8); Towercab's own steps read "Towercab". Names come from GitHub's display name or the login.
- The Needs-you card shows who else can decide it (maintainers of that repo) and whether another person has already handled it.
- Verified by: `ui: a card shows who acted and how`, `ui: the timeline names every actor`, `ui: a handled card shows who handled it`

### UI-222 · Admin page: people, roles and repos

Admins get a page that lists people with their roles and repo access, and adds or removes people.

- A table: login and name, default role, repo roles, source (added or team), last seen, open sessions. Add person (GitHub login, role, repo roles), change role or repos, disable, remove with a confirmation, name or clear the GitHub team and its role (USR-2, USR-14; the team role list stops at contributor). A Settings section lets an admin change the non-security settings, and shows the security ones read-only with "Edit the config file" (USR-14). Changes show at once; the history of changes (`user_events`) is listed below.
- A removal that would leave no admin is refused with the reason (USR-6).
- Verified by: `ui: the admin page lists people with roles and repos`, `ui: an admin adds a person and sets repo roles`, `ui: removing the last admin is refused in the page`, `ui: the admin page lists the change history`, `ui: the team role list stops at contributor`, `ui: security settings are read-only in the page`

### UI-223 · My account

The account menu shows who I am, my role, and lets me link Telegram or sign out.

- Top-right menu: name, login, role (with repo roles), Link Telegram (shows the one-time code and the bot to send it to, USR-11; or "Linked" with Unlink), Sign out. Reads only the person's own data.
- Verified by: `ui: the account menu shows my role and signs out`, `ui: linking telegram shows a one-time code`

### UI-224 · Admins end sessions

Admins can see each person's open sessions and end one or all of them.

- On the admin page (UI-222): per person, each session with its created and last-seen time and a Revoke button, plus "Revoke all" (USR-4). The next request of a revoked session returns to sign-in (UI-219).
- Verified by: `ui: an admin revokes a session`, `ui: a revoked person returns to sign-in`

### UI-242 · The observer panel

The overview shows what the observer did lately: its last run, this week's proposals and what it spent today.

- An "Observer" panel via `GET /api/observer` (`{enabled, lastRun, proposalsThisWeek, maxPerWeek, spentToday, cap, lastReport}`): the last run's time, trigger (daily or the event), outcome and proposal count, the proposals made in the last 7 days against `[observer].max_proposals_per_week` (OBV-7), today's observer spend against its cap (OBV-10) and when the last weekly report went out (OBV-8). With the observer off, or before its first run, the panel is not shown. A reached cap says so in words.
- Verified by: `ui: the observer panel shows its last run, proposals and spend`, `ui: the observer panel is hidden when off`

### UI-243 · Observer proposals are tagged and show their evidence

An intent the observer proposed shows an `[observer]` tag, and its evidence is one click away.

- An intent with `source: observer` shows the tag (a text label, not colour alone) beside its title on proposed cards (UI-184), lists, the intent page and the timeline. On the card and the intent page, the evidence links and the expected gain (OBV-5) appear above the rest of the text. A run link opens that run in the page.
- Verified by: `ui: an observer proposal is tagged and shows its evidence`

### UI-203 · Change urgency and importance on the intent page

The intent page shows urgency and importance as two controls from 1 to 5 that change them, and the priority and parked state update at once.

- Two segmented controls `u` and `i` (choices 1..5, the current one marked in text and state, not colour alone), next to the autonomy control of UI-257 and built like it. Choosing a value posts `{action: "scores", id, u?, i?}` (UI-204). No confirm step: LOOP-133 says scores set order only.
- After the reply the page shows the new priority (PRI-3), `parked` with `raise u or i to run it` or not (PRI-5), and the intent's place in the queue (UI-61) without a reload; the reply is `Saved. The queue is reordered.` A refusal keeps the old values and shows the reason (UI-67). Done or dropped intents show the scores without the controls.
- Fits 360 px, light and dark, works by keyboard (arrow keys).
- Verified by: `ui: the intent page changes urgency and importance`, `ui: a score change shows the new priority and parked state`, `ui: a refused score change keeps the old values`, `ui: scores show without controls on a done intent`

### UI-204 · Scores action

The API has a `scores` action that changes urgency and importance.

- `POST /api/actions` accepts `{action: "scores", id, u?, i?}` (UI-65, UI-66) with `actor: owner`, at least one of `u`, `i`; it applies LOOP-133 and returns the new `priority`, `parked` and the reply text. A missing value, one outside 1–5, a non-integer or an unknown id → the error text and nothing written. With `[auth]` it needs the maintainer role on the repo (UI-220, USR-5).
- `GET /api/state`, the intent's API and the plane cards carry `u`, `i`, `priority` and `parked` for the controls.
- Verified by: `ui: scores action writes u and i`, `ui: scores action refuses a bad value`, `ui: scores action needs the maintainer role`, `ui: API shapes`

### UI-205 · Boost button on the plane card

A plane's card in the airspace has a "Boost" button that gives the intent full autonomy and starts it now if it has not started.

- "Boost" on the plane card (UI-80) posts `{action: "boost", id}` with `actor: owner` and applies LOOP-134. Its confirm step is UI-257's raise confirm: `Boost?` / `Raise to a5?`, naming that Towercab may then pass the spec and plan gates and merge on its own unless the change is high risk, the repo's cap or access rules stop it, with "Boost" and "Cancel"; nothing is written until "Boost". For an intent not yet started the confirm also says it starts now.
- Shown only when the intent is not done or dropped, `source` is `me` (AUT-13; with `[auth]` when the person may set a5, AUT-23, AUT-24) and its level is below a5 or it has no mission yet; hidden otherwise, never disabled. A parked intent without a mission is started by Boost as well (LOOP-134). "Start now" (UI-101) stays beside the button where it is shown and does not change autonomy. The reply says in one sentence what happened: `Boosted: a5 and design started.` or `Boosted: a5. It runs from the next gate.` or the error.
- Verified by: `ui: boost appears on the plane card for an own intent below a5`, `ui: boost asks for a confirmation that names a5`, `ui: boost on an unstarted intent starts it`, `ui: boost is not shown for another source`, `ui: boost is not shown at a5 for a started intent`

### UI-206 · The highest level offered depends on the source

For intents that are not the owner's own, the autonomy control stops at a4 and no Boost is shown.

- The autonomy control of UI-257 on the page and on cards offers `a0`..`a5` for an intent with `source: me` (or missing), and `a0`..`a4` for any other source (AUT-13; with `[auth]` a5 is offered when the person may set it, AUT-23, AUT-24). The a5 choice is omitted, not disabled, and the control says `a5 is only for your own intents` as a tooltip on the a4 choice's group. The API refuses `a: 5` for such an intent with the same text (a defence, not the only guard).
- Verified by: `ui: another source gets a0 to a4 only`, `ui: an own intent gets a0 to a5`, `ui: the api refuses a5 for another source`

### UI-207 · The card says why a boosted plane stopped

A boosted plane that waits for the owner says in the card which rule held it, in plain words.

- On the plane card and the intent page, when the effective level is a5 (the intent's `a` is 5) and the mission waits on the owner, the card's wait sentence (UI-56, UI-59) adds one reason: `Waiting because this change is high risk (<risk reason>)` (AUT-18); `Waiting because the repo caps autonomy at a<n>` (AUT-8); `Waiting for access beyond the plan` or `Waiting for a decision on access` (AUT-14, AUT-15, AUT-30); the question or open point already shown (PIP-110) otherwise. The reasons come from the state `GET /api/state` already derives for the wait (`why`); no new decision is made by the page.
- Verified by: `ui: a boosted plane says it waits for high risk`, `ui: a boosted plane says the repo cap holds it`, `ui: a boosted plane says it waits for access`

### UI-208 · The card shows that a worker lowered autonomy

When a worker lowered an intent's `a` after a boost, the card says so and why.

- If the intent's `lower_why` is set (AUT-7, INT-24's front matter) and its level is below a5, the card and the intent page show `Lowered to a<n> by the worker: <lower_why>` (UI-257's control shows the level itself). The line stays until the owner sets `a` again on the page or with a boost, which remove `lower_why` in the same commit; it never hides the level the control shows. Boost clears the note, since the owner raised the level on purpose (LOOP-134). A later lowering by a worker shows its own note.
- Verified by: `ui: a card shows that the worker lowered autonomy and why`, `ui: a boost clears the lowered note`, `ui: a later lowering after a boost shows its own note`

### UI-209 · The add-repo form shows how to install the App

When the add-repo form is refused because the GitHub App isn't installed, a folded "See more" explains the fix under the one-line error.

- The refusal of LOOP-66 stays one line on the form (UI-130). If it carries `help` (LOOP-122), a "See more" toggle follows, closed by default, holding: the App's name, a numbered list of the steps, and the link as a real link (`target="_blank"`, `rel="noopener"`). Without `help`, no toggle shows. The toggle stays as the owner left it while the form is used again.
- Verified by: `ui: a refused add shows the install steps under See more`, `ui: the install steps are folded by default`, `ui: a refusal without help shows no See more`

### UI-210 · The unknown-repo card shows how to install the App

The unknown-repo card shows the same folded install help when adding its repo fails for a missing App install.

- When "Add this repo" (UI-131) is refused with LOOP-122's `help`, the card's error line is followed by the same "See more" block as UI-209, built by the same component.
- Verified by: `ui: the unknown-repo card shows the install steps under See more`

### UI-211 · Any card that hits the missing install shows the help

Every intent or problem card that reports a repo Towercab can't reach because the App isn't installed carries the folded install help.

- A problem from a failed add (UI-60, `meta.repo-add-failed:<name>`) and an intent or problem card whose reason is LOOP-122's text show the "See more" block of UI-209 under their reason line. The state (`GET /api/state`) adds `installHelp: {app, url, steps[]}` to such a card, taken from the same lookup as LOOP-122; a card whose reason is another error has none.
- The card's help is cached for 10 minutes per repo (compared without case), so a page that refetches every few seconds does not ask GitHub each time. The cache is dropped at once when the repo becomes reachable (a token for it is minted, or the repo is added), so the help never outlives the problem, and a failed lookup is not cached.
- Verified by: `ui: a failed add problem shows the install steps`, `ui: an intent card with the missing install shows the steps`, `state: installHelp is set only for a missing install`, `state: install help is cached for 10 minutes per repo`, `state: install help is refreshed when the repo becomes reachable`

### UI-212 · "Try again" adds the repo without retyping

After installing the App, the owner presses "Try again" and the add goes through with what was typed before.

- Next to the error the form and the unknown-repo card show a "Try again" button; the steps end with "then press Try again". It posts the same `addRepo` action (UI-130) with the field's current `github` and `name`, which are kept after a refusal. A problem card (UI-211) offers "Try again" the same way. A new success replaces the error and clears the problem (UI-130).
- Verified by: `ui: try again adds the repo with the same text`, `ui: the field keeps its text after a refusal`, `ui: a problem card offers try again for a failed add`

### UI-213 · A "New intent" form

The dashboard has a "New intent" button that opens a form shaped like the intent template.

- Fields, in order: repo (a picker of Towercab's repos), title, urgency, importance, autonomy (segmented 1–5 and `a0`..`a5` as UI-203 and UI-257 build them, none chosen by default), then the text boxes Problem, Proposed outcome, Affected users and systems, Constraints, Open questions. Only repo and title are required (INT-2); a score left alone is not written (INT-71).
- Next to the title the form shows the naming rule of INT-33 in plain words (`Write it as a user story: the product, then what someone can do or see, 4 to 20 words`) with its example; it does not change what is typed.
- The button is in the top bar and in Cmd-K (UI-265). With `[auth]` a maintainer of the repo writes straight to the intents repo and a contributor proposes (INT-71); this is the Create of UI-220. The repo picker lists the repos where the person is at least a contributor; a viewer has no button. A contributor's form says `A maintainer will accept or close your intent.` under the buttons, and its autonomy choices stop at a4 (UI-206).
- Verified by: `ui: the new intent form has the template's fields`, `ui: the form needs only a repo and a title`, `ui: the form shows the naming rule beside the title`, `ui: the new intent button is in the top bar and in search`, `ui: the repo picker lists only allowed repos`, `ui: a contributor's form says a maintainer will review it`, `ui: a viewer has no new intent button`

### UI-214 · Create runs the overlap check first

Pressing Create makes an agent look for overlaps and shows what it found before anything is written.

- Create posts `{action: "checkIntent", ...draft}` (UI-216) and the form shows `Checking your intent against the existing ones…` with the fields locked and the button disabled. The answer lists each match: its kind in words (`Open intent`, `Parked`, `Done`, `Dropped`, `Intent PR`), its title as a link (intent page, or the PR), and the `how` line (INT-73). A `titleNote` shows under the title field as a note.
- Verified by: `ui: create shows that the check is running`, `ui: matches list kind, link and how`, `ui: a title note shows under the title`

### UI-215 · Decide: create anyway, add to one, or cancel

With matches, the owner chooses; with none, the intent is created at once.

- With matches the form offers `Create anyway` (for a contributor, `Propose anyway`), `Add my text to this one` on each match that `canAddTo` (INT-74) and only to a maintainer, and `Cancel` (back to the form, text kept). Done, dropped and PR matches only link. A match past design shows `Already past design. Write a new intent and link <id>.` with the ID as a link, and no add button. With no match the intent is created without a question, and with only a title note it is too.
- A failed check (INT-73) shows its error with `Create without the check` and `Cancel`; the text says the check was skipped if the owner goes on.
- Verified by: `ui: with no match the intent is created at once`, `ui: matches offer create anyway, add to this one and cancel`, `ui: done and PR matches offer no add`, `ui: a match past design offers no add and says to write a new intent`, `ui: a contributor is offered propose anyway and no add`, `ui: cancel keeps the typed text`, `ui: a failed check offers create without the check`

### UI-216 · Check and create actions

The API has `checkIntent` and `createIntent` actions behind the form.

- `POST /api/actions` (UI-65, UI-66) accepts `{action: "checkIntent", repo, title, u?, i?, a?, problem?, outcome?, affected?, constraints?, questions?}` with `actor: owner` and returns `{matches, titleNote?}` (INT-73); and `{action: "createIntent", ...same, addTo?: <id>}` which applies INT-72 and then INT-71, or INT-74 when `addTo` is set, and returns `{id, path, added: boolean, reply}`. `createIntent` does not run the check itself: the form decides after `checkIntent`.
- A bad value, an unknown repo or id, or an intent that cannot be added to (INT-74, with its text) returns the error text and nothing is written. With `[auth]` both actions need the contributor role on the repo (UI-220, USR-5); `createIntent` uses `mode: "direct"` for a maintainer and `"proposal"` for a contributor, chosen by the server from the role, never by the request, and `addTo` needs the maintainer role. For a proposal the reply carries `proposal: true` and the PR's URL instead of a path. A refusal is a 403 with its reason (USR-7).
- A repeated press cannot make two intents: `createIntent` with the same repo and title as one the same person created in the last 2 minutes (an intent, or an open proposal) is refused with `Already created as <id>`, and nothing is written; the form also disables Create while a request runs.
- Verified by: `ui: checkIntent returns matches`, `ui: createIntent writes the intent and returns its id`, `ui: createIntent with addTo appends to the intent`, `ui: createIntent refuses a bad value and writes nothing`, `ui: createIntent refuses addTo for an intent past design`, `ui: a contributor's createIntent opens a proposal`, `ui: the mode follows the role, not the request`, `ui: addTo needs the maintainer role`, `ui: a repeated create is refused as already created`, `ui: the new intent actions need the contributor role`, `ui: API shapes`

### UI-217 · The page opens the new intent

After the intent is written, the page opens it.

- On success the page goes to the new intent's page (UI-67 updates keep the page live) and shows `Created <id>.` once; after `addTo` it opens the existing intent and shows `Added to <id>.`. A contributor's proposal is not an intent yet: the page shows `Proposed <id>. A maintainer will accept or close it.` with a link to the pull request and opens the Inbox, where it shows as a proposed card (UI-184). The new intent shows in the Inbox and Board as any intent does, at the next state refresh, which the action's reply waits for (at most 5 s) so the page does not open on a missing intent.
- Verified by: `ui: a created intent opens its page`, `ui: adding to an intent opens that intent`, `ui: a proposal shows its pull request and the Inbox`, `ui: the page does not open on a missing intent`

### UI-218 · The form is safe to leave and works everywhere

The form keeps what was typed after a refusal, fits a phone and works by keyboard.

- After a refusal or Cancel the fields keep their text; the text is dropped after a success. The form fits 360 px, light and dark, every field has a label, Tab and Enter work, and the error line is announced. The screenshots (UI-275) include the empty form and the overlap list.
- Verified by: `ui: the form keeps its text after a refusal`, `ui: the new intent form works by keyboard`, `ui: screenshots light, dark and mobile`

## Out of scope

- Editing intents in the page, except their autonomy (UI-257), scores (UI-203) and adding text to an open one (INT-74, UI-215): the owner edits other fields in the intents repo or with `/intent`.
- Remote access: the page is for this machine only.

## Decisions

- Designed from the operator's jobs, not from the data: v1 listed every field it had; v2 shows what
  needs a decision first and hides the rest one click away.
- Actions act on GitHub as the owner, so the PR history stays the one record of who decided what.
- Preact and Vite: a real component model and hot reload make the UI quick to iterate, at a few KB.
- Screenshots in every test run: a UI nobody looks at drifts; the review and CI now see it.
