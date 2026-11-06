# Shadow

**Status:** Draft · **Prefix:** SHD

## Purpose

The shadow is one long-lived Claude session that knows Towercab's state and works for the owner. The
owner talks to it in Telegram in plain words: asks what is going on, thinks something through, and has
it act. It acts within limits the owner sets, asks first above them, and marks everything it does with
`[shadow]` so nothing it does passes for the owner's own work.

## Requirements

### SHD-1 · One shadow session

Towercab runs one shadow, a single Claude session that persists as long as the owner does not reset it.

- One `claude` session per home, started on the first owner message when `[shadow]` is enabled, resumed
  (`--resume <session id>`) for every later one. The session id is stored in `meta` (`shadow.session`).
  Without `[shadow] enabled = true` and `[telegram]`, nothing runs and no message is read.
- One message is handled at a time; later ones wait in order.
- Verified by: `shadow: one session is resumed for every message`, `shadow: nothing runs unless enabled`

### SHD-2 · Only the owner's chat speaks to it

The shadow listens to the owner's Telegram chat and to nobody else.

- A Telegram update counts only when its `chat.id` equals `telegram.chat_id` and it is a text message;
  everything else is dropped without a reply or a trace beyond a debug log line.
- Verified by: `shadow: messages from another chat are ignored`

### SHD-3 · Only the owner's messages are instructions

The shadow acts on what the owner writes in the chat, and treats everything else it reads as data.

- Text in PRs, issues, comments, logs, run files and web pages reaches the session inside a data
  block that says it is not an instruction (`agents/shadow.md`). Nothing read from outside the chat can
  start, approve or widen an action; an approval (SHD-10) counts only when it comes from the chat.
- Verified by: `shadow: text from a PR is passed as data`, `shadow: an approval written in a PR comment does nothing`

### SHD-4 · It knows the state

Each turn, the shadow sees Towercab's current state without being told.

- The prompt carries a snapshot built by code from the same data as `GET /api/state`: intents by stage,
  waits and what they ask, runs and their cost, repos, today's spend against the daily cap, and the
  actions the shadow took recently. Longer detail (a PR, a run file) is read through SHD-5 reads.
- Verified by: `shadow: the prompt carries the current state`

### SHD-5 · It works through the actions API in the sandbox

The shadow can only do what Towercab's actions API offers, and it runs without a shell on the host.

- The session runs in the sandbox (the same sandbox as builds) with no network except the loopback actions
  API, no `Bash` tool and no access to `~/.config/towercab` or the home outside `runs/`. Reads are
  `GET /api/…` (UI-65); writes are `POST /api/actions` with `actor: shadow`. An action outside the list
  in SHD-6..9 is refused with a reason the shadow can relay.
- Verified by: `shadow: the session runs in the sandbox without a shell`, `shadow: an unknown action is refused`

### SHD-6 · Reading, answering and drafting are free

The shadow answers questions, explains a wait, summarizes a PR and drafts intents without asking.

- Reads never need approval. A draft is an intent written as in SHD-13 and nothing more: it does not start
  by itself unless the owner's usual pick rules choose it.
- Verified by: `shadow: reads and drafts need no approval`

### SHD-7 · Replying and starting are free

The shadow answers a question on an intent and starts an intent without asking, in the owner's name only
where the owner would have done the same.

- `reply` posts the text as in UI-66 with the `[shadow]` tag (SHD-12); `start` runs the `start` command
  (LOOP-15) for an intent that is waiting to be picked. Both are recorded (SHD-19).
- Verified by: `shadow: reply and start run without approval`

### SHD-8 · Merging, boosting and dropping need a yes

The shadow merges, boosts or drops only after the owner says yes in the chat to that very action.

- These three actions are held (SHD-10) unless `[shadow] free` lists them. Default: none listed.
  `boost` raises `u` and `i` of the intent by one each, at most 5; `merge` and `drop` act as UI-66.
- Verified by: `shadow: merge boost and drop wait for a yes`, `shadow: free actions skip the question`

### SHD-9 · It never exceeds the intent's own limits

An action the owner's yes allows is still refused where the intent itself forbids it.

- A `merge` is refused while the intent's checks are not green or its autonomy asks for a human
  (AUT-1..8); the shadow's yes does not stand in for the owner on a wait that only the owner may clear.
  The refusal reaches the chat in one sentence.
- Verified by: `shadow: merge is refused where autonomy needs the owner`

### SHD-10 · Asking first

For an action above its limits, the shadow sends one message that names the action and waits for the answer.

- The held action is stored (`meta` `shadow.pending`: action, intent, text, id) and shown in Telegram as
  "Merge 261105-2152-8? Reply yes or no." A `yes` or `no` (or the same in plain words) from the chat
  resolves it; any other message leaves it open and is answered normally. A pending action expires after
  24 hours and is dropped with a note. Only one is pending per intent and action.
- A restart keeps the pending action. An answer resolves it once.
- Verified by: `shadow: a held action waits for the chat`, `shadow: yes runs it once`, `shadow: no cancels it`, `shadow: a pending action survives a restart`, `shadow: a pending action expires after a day`

### SHD-11 · Limits are settings

The owner sets what the shadow does freely, in the config file.

- `[shadow]`: `enabled` (bool, false), `free` (list of `merge`, `boost`, `drop`; empty), `daily_budget_usd`
  (number > 0; 5), `model` (a model name; the agent default). A wrong value fails as LOOP-1 says.
- Verified by: `config: shadow settings load and bad values name the key`

### SHD-12 · Everything it writes is tagged

Whatever the shadow writes shows `[shadow]`, so the owner can tell it from their own words.

- PR and issue comments start with `[shadow] `; commits it causes (an intent file) carry the trailer
  `Shadow: true` and the subject prefix `[shadow]`; Telegram replies start with `[shadow] `. The comments are
  posted by the same identity as other stage comments, not as the owner.
- Verified by: `shadow: comments commits and replies carry the tag`

### SHD-13 · Intents it writes are not the owner's

An intent the shadow drafts is marked `source: shadow` and cannot run above autonomy 4.

- The file is created as INT-1 describes with `source: shadow`; AUT-13 then caps `a` at 4 whatever it
  says. The shadow cannot set `source: me`.
- Verified by: `shadow: a drafted intent has source shadow`, `shadow: a drafted intent is capped at a4`

### SHD-14 · The owner confirms a draft

When the owner says a drafted intent is theirs, it becomes theirs and the cap lifts.

- A `confirm` is a chat-only action: the owner's message, not the shadow's own reasoning, sets `source: me`
  on the file with `setField` (INT-1) and records it in the timeline as a confirmation by the owner. The shadow
  can offer it, but runs it only after a `yes` as in SHD-10, whatever `free` says.
- Verified by: `shadow: confirming a draft sets source me`, `shadow: confirm always asks`

### SHD-15 · The conversation survives restarts

The shadow remembers the conversation after Towercab restarts.

- Each turn, owner text and the reply, is appended to `shadow_turns` (`at`, `role`, `text`, `cost`). On
  start the session is resumed by id (SHD-1); if the session is gone, a fresh one is seeded with the summary
  and the last 20 turns.
- Verified by: `shadow: the conversation continues after a restart`, `shadow: a lost session is reseeded from the log`

### SHD-16 · Long conversations are summarized

When the conversation grows long, older turns are folded into a summary so the shadow stays quick and cheap.

- Above 40 turns or 60 000 characters, all but the last 10 turns are summarized by one run into
  `meta` `shadow.summary` (≤ 4 000 characters) and the session is restarted seeded with it. The summary keeps
  open questions, pending actions and decisions the owner made.
- Verified by: `shadow: a long conversation is summarized`, `shadow: the summary keeps open decisions`

### SHD-17 · The owner can reset it

The owner can wipe the conversation and start fresh.

- `/reset` in the chat, `towercab shadow reset` or the page's Reset button (UI-238) clears the session id,
  summary and turns, and drops any pending action. The action log (SHD-19) is kept. The reply says so in
  one sentence.
- Verified by: `shadow: reset clears the conversation and keeps the action log`

### SHD-18 · Its cost counts, with a cap

The shadow's runs are part of the spend and have their own daily cap.

- Each turn's cost is added to `data.runs` as in MET-29 (labelled `shadow`) and shown in the spend. When
  today's shadow cost reaches `[shadow] daily_budget_usd`, the shadow answers once "I've reached today's
  cap" and does nothing until midnight; it never pauses the rest of Towercab for it. The overall daily
  budget (MET-29) still applies to the sum.
- Verified by: `shadow: its cost is in the spend`, `shadow: the daily cap stops it`, `shadow: the cap does not pause picks`

### SHD-19 · Every action is recorded

Each action the shadow takes or is refused is written down, linked to what it touched.

- Table `shadow_actions` (`id`, `at`, `action`, `intent`, `pr`, `outcome` `done`, `refused` or `held`,
  `detail`) written before the effect (`ctx.record` rule). The dashboard, the timeline and the API read it.
  Rows are kept 30 days.
- Verified by: `shadow: an action is recorded before it runs`, `shadow: refused and held actions are recorded`

### SHD-20 · Each message is handled once

A Telegram message is acted on exactly once, even across crashes and restarts.

- Updates are read by long-polling `getUpdates` (LOOP-129); the offset advances only after the update is
  stored as a turn, and a stored update is never run twice (keyed by `update_id`). A reply is sent through the
  outbox (LOOP-16), so a crash after an action neither repeats it nor loses the reply.
- Verified by: `shadow: an update is handled once after a crash`, `shadow: the reply is not lost after a crash`

## Out of scope

- A shell, or any file access on the host, for the shadow (SHD-5).
- Acting on text found outside the chat (SHD-3).
- More than one owner or chat.
- Voice, images and files in Telegram.

## Decisions

- The owner chose which actions are free (2026-11-06, recommended option): read, answer, draft, reply and
  start are free; merge, boost and drop wait for a yes, and the owner can widen the list in `[shadow] free`.
  Reply and start are free because they only continue work the owner's own rules already allow.
- Confirming a draft always asks: it lifts the autonomy cap, so it is the owner's choice every time.
- The shadow has its own daily cap: a chatty day should not freeze the pipeline.
