# Frame

**Status:** Live: FRAME-1..6 · **Prefix:** FRAME

## Purpose

The page is laid out like a chat app: open intents down the left, the chosen one in the middle.
The owner finds what waits on them at a glance and goes from one intent to the next without
changing pages. It replaces the tab bar and makes the intent chat ([chat.md](chat.md)) the main view.

## Requirements

### FRAME-1 · A sidebar and a main pane

Every page shows the sidebar of intents on the left and the page itself beside it.

- `ui/src/Frame.tsx` wraps every route: `.sidebar` (280 px) and `.frame-main`. The tab bar of
  UI-266 is gone; the top bar of UI-57 (health, counts, spend, Pause) sits over the main pane.
- `/` stays the list of what needs the owner (the Inbox of UI-259), `/i/<id>` is the intent's chat
  (CHAT-1), `/overview`, `/repos`, `/board` and `/activity` keep their addresses; every old link still
  opens.
- Verified by: `frame: the sidebar lists open intents by repo with stage and state`

### FRAME-2 · Intents by repo, with stage and state

The sidebar lists every open intent under its repo, with its stage and one word for its state.

- `GET /api/sidebar` → `SidebarView {version, needs, repos: [{repo, items: SideItem[]}]}`, built from the
  Board (UI-133) so the two never disagree: done intents are left out, repos in the Board's order.
  `SideItem {intent, title, repo, stage, state, needsYou}`; `stage` is the Board column folded to
  `queue | spec | plan | code | ship` (gate→queue; spec-review→spec; plan-review→plan; ci, code-review→code;
  deploy, e2e→ship).
- The state word is one of `waiting on you`, `working`, `blocked`, `done`, `live`, else the state's
  own label in lower case; a coloured dot repeats it. The row is a link with the full title as its
  tooltip and `aria-current="page"` on the open intent.
- Verified by: `frame: the sidebar lists open intents by repo with stage and state`

### FRAME-3 · Needs you, Overview, Repos and New intent at the top

The top of the sidebar has New intent, Needs you with its count, Overview and Repos.

- `+ New intent` opens the form of UI-213 (hidden for a read-only page or a viewer). `Needs you (n)`
  goes to `/` and filters the list to intents that wait on the owner (`aria-pressed`); a second press
  shows them all again. `Overview` and `Repos` open those pages.
- An empty list says so: "Nothing waits on you." when filtered, else "No open intents. Write one with
  + New intent."
- Verified by: `frame: Needs you filters the list to what waits on the owner`

### FRAME-4 · Overview holds the Board and the airspace

The Board and the airspace move to the Overview; Activity is linked from it.

- `/overview` shows UI-246's Overview (headline, Problems, Working, Up next, airspace), then the Board
  (UI-133) under a `Board` heading, then links to `Activity` and the Board on its own page (`/board`).
  The shadow and observer pages stay reached from the Overview's sections, as before.
- Verified by: `frame: the sidebar lists open intents by repo with stage and state`

### FRAME-5 · The top bar over the main pane

The bar over the main pane says whether Towercab is healthy and what it costs, as UI-57 does.

- It keeps UI-57's health, counts, freshness, spend and Pause/Resume (UI-282); New intent moves to the
  sidebar. It shrinks to fit beside the menu button and wraps on a phone.
- Verified by: `frame: on a phone the sidebar is a drawer`

### FRAME-6 · On a phone the sidebar is a drawer

Below 860 px the sidebar slides in over the page from a menu button and closes again on its own.

- `☰` (`Open the intents menu`, `aria-expanded`) opens it; `×`, the dimmed backdrop, `Escape` or picking
  a row closes it. The page never scrolls sideways at 375 px. Motion is off with
  `prefers-reduced-motion`.
- Verified by: `frame: on a phone the sidebar is a drawer`

## Out of scope

- A terminal tab that takes over an intent's session (`claude --resume` in xterm.js): a later intent.
- Herdr (a Rust terminal multiplexer for agents, AGPL-3.0-or-later) was considered as a base and
  rejected; only its idea of each agent's state at a glance is used (FRAME-2).

## Decisions

- The sidebar reads the Board's data instead of a new query, so a card's column and a row's stage
  can't disagree.
- The Inbox stays at `/`: its keyboard flow and snoozes (UI-259..265) keep working, and Needs you only
  adds the filter on the left.
- This is a breaking change of the page's layout, so it ships as a major version.
