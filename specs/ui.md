# UI

**Status:** Live: UI-1..82, UI-100..112, UI-120..128, UI-130..131, UI-133..137, UI-140..145 · **Prefix:** UI

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
  without a `live` block sees the map it always had.
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

## Out of scope

- Editing intents in the page: the owner edits them in the intents repo or with `/intent`.
- Remote access: the page is for this machine only.

## Decisions

- Designed from the operator's jobs, not from the data: v1 listed every field it had; v2 shows what
  needs a decision first and hides the rest one click away.
- Actions act on GitHub as the owner, so the PR history stays the one record of who decided what.
- Preact and Vite: a real component model and hot reload make the UI quick to iterate, at a few KB.
- Screenshots in every test run: a UI nobody looks at drifts; the review and CI now see it.
