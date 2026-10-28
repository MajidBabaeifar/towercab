# UI

**Status:** Live: UI-1..82, UI-100..104 · **Prefix:** UI

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

- Card: the intent's title and repo; the ask (LOOP-14 **Waits**); a short brief (the question's
  context and recommendation, the gate's reason, or the review's summary, at most a few lines, the
  rest behind "More"); the PR link. Actions by kind: approve spec, plan or code → "Merge spec PR",
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
  step.
- Verified by: `ui: intent page shows the three PRs`, `ui: timeline in plain words`

### UI-63 · Queue page

A queue page shows, per repo, what runs, what waits behind it, and what is parked.

- `/queue`: one lane per `[repos]` repo: the running intent, then the waiting ones in pick order with
  position and reason; then parked intents; then the last 10 done. Read-only.
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
  `GET /api/intents/<id>`, `GET /api/queue`, `GET /api/activity?…`, `GET /api/runs/<id>/<file>`
  (names `[A-Za-z0-9._-]+`, files under `runs/<id>/` only, text, at most 2 MB), `GET /api/events`
  (Server-Sent Events: `version` on each change), `POST /api/actions` `{action, intent, text?}`.
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

### UI-72 to UI-77

Reserved for the stage map on the intent page (intent 261027-1147).

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

- State `Queued` with the sentence "Ready to build, behind <title>" (UI-56, UI-59); on the queue
  page (UI-63) each repo lane lists the running intent, then ready intents in build order, then the
  intents ahead of build (with a count `n of <ahead> ahead`), then waiting ones with the reason
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

## Out of scope

- Editing intents in the page: the owner edits them in the intents repo or with `/intent`.
- Remote access: the page is for this machine only.

## Decisions

- Designed from the operator's jobs, not from the data: v1 listed every field it had; v2 shows what
  needs a decision first and hides the rest one click away.
- Actions act on GitHub as the owner, so the PR history stays the one record of who decided what.
- Preact and Vite: a real component model and hot reload make the UI quick to iterate, at a few KB.
- Screenshots in every test run: a UI nobody looks at drifts; the review and CI now see it.
