# Intent chat

**Status:** Live: CHAT-1..10 · **Prefix:** CHAT

## Purpose

Each intent is a conversation the owner can read and join. The thread shows what each worker
actually did, turn by turn, with Towercab's moves between the runs and the decision that waits on the
owner at the bottom. The owner writes into it, and Towercab hands the message to the intent the same
way a reply on its PR goes in, so a message never races a running worker.

## Requirements

### CHAT-1 · An intent opens as a chat

Opening an intent shows its conversation, with the old intent page one click away.

- `/i/<id>` renders `ui/src/pages/Chat.tsx`: the header (CHAT-2), the thread (CHAT-3), the card of what
  waits on the owner (UI-58, with its buttons) and the composer (CHAT-9). `Details` opens the rest of
  UI-62's page (PRs, stage map, timeline, steps, files, settings) in a side panel (`aria-expanded`,
  `aria-controls`); on a phone it opens below.
- Verified by: `chat: an intent opens as a chat with its header, card and composer`

### CHAT-2 · The header

The header says what the intent is and where it stands.

- Title (`h1`), repo, the state chip (UI-56), the autonomy level (`a0`..`a5`) and a link to each PR that
  has one (Spec, Plan, Code, Fix n, Revert), opening on GitHub.
- Verified by: `chat: an intent opens as a chat with its header, card and composer`

### CHAT-3 · The thread

The thread lists every run of the intent, oldest first, each opened by a divider.

- `GET /api/intents/<id>/chat[?before=<n>]` → `ChatPage {intent, items, before, total, missing, composer}`.
  Items are sorted by time: a `divider` per run (`<Stage> · <kind> <n>`), the run's messages
  (CHAT-5), Towercab's moves (`event`: `<from> → <to>: <why>`, from `transitions`; blocked, failed or
  red ones in the warning tone) and the owner's messages (CHAT-8).
- Runs are the result files `runs/<id>/<stage>/<kind>-<n>.json` that name a `session_id`. A session
  resumed by later runs is read once.
- Verified by: `chat: a run's transcript becomes messages with tool calls folded`

### CHAT-4 · Full history from Claude's own transcripts

The thread reads each run's own conversation, also for intents that finished before this change.

- A run's transcript is `<run>.transcript.jsonl` next to its result when Towercab kept one, else Claude
  Code's `~/.claude/projects/<workspace>/<session_id>.jsonl` (any workspace folder). Claude Code removes
  its files after 30 days by default, so when a pipeline run ends (`ended` in `src/pipeline/common.ts`)
  Towercab copies the transcript next to the run's result, and the thread prefers that copy.
- Verified by: `chat: Towercab's own copy of a transcript is preferred and kept at run end`

### CHAT-5 · Messages and folded tool calls

Each turn shows as a message; tool calls are folded under it.

- The run's first user turn is Towercab's prompt, folded under "Towercab's instructions for this run".
  An agent turn shows its text as Markdown and `n tool calls: <names>` folded; each call shows its input
  and its result (each cut to 2,000 characters), an error result marked. Meta lines and other entry
  types are skipped.
- Verified by: `chat: a run's transcript becomes messages with tool calls folded`

### CHAT-6 · Long threads load the latest first

A long thread opens on its latest page, and older turns load on request.

- A page holds 200 items; `before` is the index of the page's first item when older ones exist (null
  at the start). `Show earlier` fetches `?before=<n>` and puts it above. The view stays at the bottom
  while the owner is there, and doesn't jump when they have scrolled up.
- Verified by: `chat: a long thread loads the latest page first and pages back`

### CHAT-7 · A missing transcript

A run whose conversation is gone says so instead of failing.

- No copy and no Claude file → an `event` "This run's conversation is no longer on this machine; only
  its result is kept." and `missing` counts it; the page says how many runs are missing above the
  thread.
- Verified by: `chat: a gone transcript leaves a note, not an error`

### CHAT-8 · A message goes in only when the intent waits on the owner

The owner's message is queued and goes in when the intent next waits on them, never during a run.

- `POST /api/actions {action: "chat", intent, text}` (at most 4,000 characters) appends
  `{id, at, by, text, status: "queued"}` to `meta["chat:<intent>"]` and tries delivery at once. The loop
  checks queued messages every 10 s.
- Delivery happens only while the intent's open attempt is at `approval:spec`, `approval:plan`,
  `approval:merge` or `blocked` with no child running. All queued messages go in together as one reply
  (UI's `reply` action): a comment on the PR it waits on, else an `answer` command. The pipeline reads
  that reply as it reads one the owner writes on GitHub, resumes the worker's own Claude session with
  it, and moves the mission only through `machine.apply`. The message then shows `sent`, or `failed`
  with the reason.
- A message to an intent that has no attempt yet waits for its first one. An intent whose attempts
  have all ended (done, stopped, merged not verified) takes no message, and a message still queued
  then is marked failed ("The intent ended first.").
- Who may send follows the roles of the page: a read-only page or a viewer gets no composer; the
  team sign-in of USR (towercab#335) gives the same right as replying on the intent's card.
- Verified by: `chat: a message waits while a worker runs and goes in as a reply once the intent waits on the owner`, `chat: an ended intent takes no message, and a queued one is marked failed`

### CHAT-9 · The composer

The composer says whether the message goes in now or waits, and keeps what is typed.

- A labelled textarea (`Message to this intent`) and `Send`; the line under it says "It waits on you:
  your message goes to it now.", "A worker is busy: your message waits …" or "It hasn't started …".
  An ended intent shows "This intent has ended. Write a new intent to change it further." instead.
  The text is the composer's own state, so live updates don't clear it. On a chat page the phone's
  floating New intent button is hidden so it can't cover Send.
- Verified by: `chat: the composer says whether a message goes in now or waits`, `chat: typed text survives a live update`

### CHAT-10 · Keyboard and screen readers

The chat can be read and used without a mouse.

- The thread is an ordered list (`aria-label="Conversation"`, `aria-live="polite"`); times are `time`
  elements; folds are `details`. `Ctrl/⌘+Enter` sends, `Enter` makes a new line.
- Verified by: `chat: an intent opens as a chat with its header, card and composer`

## Out of scope

- A message that starts a Claude turn outside the pipeline (`claude -p --resume` from the page while
  the intent isn't waiting): it would race the pipeline's own runs, so messages go in through the reply
  path the pipeline already has (CHAT-8).
- Taking over a session in a terminal tab: a later intent.

## Decisions

- Transcripts are read from Claude Code's own files instead of logging every turn again, so intents
  that finished before this change show their full history.
- Messages are kept in `meta` (one JSON list per intent) instead of a new table: no migration, and an
  older Towercab ignores them.
- Wait reasons (towercab#317) show on the card at the bottom of the thread; the team sign-in pages of
  towercab#335 open from the frame like any other page.
