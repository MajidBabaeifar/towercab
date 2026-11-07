# Telegram

**Status:** Draft · **Prefix:** TG

## Purpose

The owner sees what Towercab needs and acts on it from Telegram, on a phone, without opening the page or
GitHub. Telegram offers the same actions as the page and no others, and a message stops asking once
its wait is handled. How messages are sent and read is in [loop.md](loop.md) (LOOP-16, LOOP-126..128);
the owner's free-text assistant is [shadow.md](shadow.md).

## Requirements

### TG-1 · Only the owner's chat is accepted

Towercab acts on messages and button presses from the owner's chat and ignores everything else.

- An update counts only when its chat id equals `telegram.chat_id`, for text, replies, commands and button
  presses alike. Any other update is dropped with no reply and no change, and logged once per update with the
  chat id and update type, never the text or the token.
- Today there is one accepted chat. Accepting each signed-in person's own chat, by role, is a later intent;
  the check sits in one place so it can grow into a lookup of chat → person.
- Verified by: `telegram: updates from another chat are ignored and logged`, `telegram: a button press from another chat does nothing`

### TG-2 · Same actions as the page, no new powers

Everything the owner does in Telegram goes through the same actions as the page, with the same rules and refusals.

- A button or command calls the code behind `POST /api/actions` (UI-65, UI-66), as the owner (LOOP-38), with
  `actor: telegram`. It gets the same checks: a missing PR, a PR that moved on, and the owner-only rule below.
  A refusal is shown in Telegram in the same words as on the page.
- Telegram adds no action the page lacks: `merge`, `retry`, `drop`, `reply`, `accept` and `close` (a proposed
  intent, UI-185), `pause` and `resume` (global, TG-10) only.
- On an owner-only intent (effective `a` 0, AUT-31) Telegram follows AUT-32 and AUT-33: it never answers,
  merges, drops, starts over, accepts or closes. Its messages carry no action buttons, only the link to the
  card and the line `<id> is only yours: use GitHub or the page`; a reply to its question is not recorded as an
  answer and gets that line; a button pressed anyway (the level may have been lowered after the message was
  sent) is refused with the same line and recorded as in AUT-32. The check runs on the intent's level at the
  time of the press. The global `/pause` and `/resume` are unaffected, as in AUT-33.
- Verified by: `telegram: buttons call the actions API`, `telegram: a refusal reads as on the page`, `telegram: no action the page lacks`, `telegram: an a0 message has no action buttons`, `telegram: a button on an a0 intent is refused`, `telegram: a reply to an a0 question is not an answer`, `telegram: pause and resume work with a0 intents`

### TG-3 · A needs-you message carries buttons

Each message that says something needs the owner has buttons for the actions on that card.

- The buttons are those of the Needs you card for the same wait (UI-58, UI-164): Merge for a PR waiting to
  be merged, Start over for a wait that offers it, Drop; for a proposed intent, Accept and Close (UI-185).
  A question has no button besides Drop; it is answered by replying (TG-6). A wait with no action on its
  card gets no buttons, and an owner-only intent none at all (TG-2).
- Each button is an inline-keyboard button whose `callback_data` is at most 64 bytes and names the action,
  the intent and the wait it was shown for (TG-5). The message is the one LOOP-16 sends; no second message
  carries the buttons.
- Verified by: `telegram: a needs-you message has the card's buttons`, `telegram: a question has no merge button`, `telegram: a proposed intent has accept and close`, `telegram: callback data fits 64 bytes`

### TG-4 · Merge and drop ask for a confirm

Merging or dropping from Telegram needs a second press, so a stray tap cannot do either.

- The Merge button edits the message to `Merge <PR title>?` naming the PR and its target branch, as the page's
  merge confirm does (UI-261), with `Yes, merge` and `Cancel`. The Drop button edits it to `Drop <title>? This
  closes its PR.` with `Yes, drop` and `Cancel`. Only the `Yes` button acts; `Cancel` restores the original
  message and buttons. An unanswered confirm changes nothing.
- The merge acts on the head SHA the message showed (UI-65): if the PR moved on since, the press is refused as
  TG-5 says and nothing is merged. The confirm buttons carry the same wait id as the first press.
- Every other action (Start over, Accept, Close) acts on the first press, as on the page.
- Verified by: `telegram: merge asks to confirm`, `telegram: drop asks to confirm`, `telegram: cancel restores the buttons`, `telegram: an unconfirmed merge or drop changes nothing`, `telegram: a merge confirm for a moved head is refused`, `telegram: other actions act on the first press`

### TG-5 · A stale button does nothing harmful

A button pressed after its wait has ended or changed is refused and the message is brought up to date.

- `callback_data` carries the wait's id (the wait's start time, so a new wait on the same intent has a new
  id). A press whose wait is no longer the intent's current one acts on nothing: the press is answered
  (`answerCallbackQuery`) with `That is already handled.` or `That has changed.`, and the message is edited as
  TG-11 says. A press is answered within the same update in every case, so the button stops spinning.
- Verified by: `telegram: a stale button is refused and answered`, `telegram: a button for an ended wait edits the message`

### TG-6 · A reply to a question answers it

Replying to a question's message in Telegram answers that question.

- A text message that replies (`reply_to_message`) to a message Towercab sent about an intent's question or
  open point is an answer to that intent, as `reply` in the page (UI-66): a PR comment as the owner, or the
  `answer` command with no PR. The message answered is edited as TG-11 says, and the answer is confirmed in
  one line.
- A reply to a message that asks nothing (a status, a finished notice) is not an answer: it goes to the
  shadow when enabled (LOOP-129), else gets the help line (TG-15). Text that does not reply to anything is
  never taken as an answer.
- Verified by: `telegram: replying to a question answers it`, `telegram: a reply to a notice is not an answer`, `telegram: plain text is never an answer`

### TG-7 · /status

`/status` says what is running and what needs the owner, in a few lines.

- Lines: paused or not (LOOP-113); running intents, each as a short title and its step; waits, each as a short
  title and what is asked (UI-58); with the shadow on, a last line with its state (LOOP-131). Each intent
  line ends with a link to its card (TG-14). At most 10 intents are listed, then `and <n> more`. Nothing
  running and nothing waiting → `Nothing is running and nothing needs you.`
- It is read-only and carries no buttons.
- Verified by: `telegram: status lists what runs and what needs you`, `telegram: status is capped and says how many more`, `telegram: status when idle`

### TG-8 · /focus

`/focus` sends the one most important wait, with the buttons of its card.

- The pick is the Focus tab's (UI-193): highest priority, then oldest wait, then intent ID, proposed
  intents included. The message is built like a needs-you message (TG-3): title, one-line ask, plain
  reason, buttons, link. Proposed intents get Accept and Close (UI-185). A line `<n> more waiting` follows
  when there are others (UI-196). With none: `Nothing needs you.`
- The message is tracked like any other (TG-11), so it is edited when the wait is handled.
- Verified by: `telegram: focus sends the top wait with buttons`, `telegram: focus picks as the focus tab does`, `telegram: focus offers accept and close for a proposal`, `telegram: focus says nothing needs you`

### TG-9 · /queue

`/queue` lists the intents in the order Towercab will take them.

- The order and the cutoff are the queue's (PRI-4, `GET /api/queue`, UI-65): up to 10 lines `<n>. <title>
  (<repo>) · <state>` where the state is running, waiting on you, or held back with the plain reason of
  LOOP-102; then `and <n> more`. Empty → `The queue is empty.` Read-only, no buttons.
- Verified by: `telegram: queue lists the order with states`, `telegram: queue is capped`, `telegram: empty queue`

### TG-10 · /pause and /resume

`/pause` and `/resume` pause and resume Towercab as the commands do.

- They insert the same `commands` rows as `towercab pause` and `towercab resume` without an intent (LOOP-15,
  LOOP-113) and reply in one line with the state after (`Paused. 2 steps are finishing.` or `Resumed.`).
  Pausing when paused, or resuming when not, says so and changes nothing. There is no `--now` and no
  per-intent form from Telegram.
- Verified by: `telegram: pause and resume insert the commands`, `telegram: pausing twice says so`

### TG-11 · A handled wait edits its message

When a wait is handled, from anywhere, the message about it is edited to say how, and no new message is sent.

- Every message that asks something is recorded with its Telegram message id and the wait it was sent for
  (LOOP-128). When that wait ends, the loop edits it (`editMessageText`) to the first line of the original
  followed by the outcome, and removes the buttons: `✅ merged by you`, `✅ answered by you`,
  `🗑 dropped by you`, `↩️ started over by you`, `✅ merged` when the loop saw the PR merged by someone else
  on GitHub. The outcome names the place only when it is not Telegram: `merged by you on GitHub`.
- A wait that ends by itself (the mission moved on, the PR closed, the question went away) is edited to
  `✅ no longer needed`. No outcome sends a new message; the messages LOOP-16 sends for new events are
  unaffected.
- An edit that fails because the message is gone or too old (Telegram refuses) is dropped and logged once; it
  never blocks other messages.
- Verified by: `telegram: a merge on GitHub edits the message`, `telegram: a button press edits the message`, `telegram: an answer in the page edits the message`, `telegram: an ended wait is edited not resent`, `telegram: an edit that Telegram refuses is dropped`

### TG-12 · One message per wait

A wait has one message that changes, so the chat does not pile up.

- When a wait's text changes while it stands (a new question from the same intent, a new PR head), the
  existing message is edited instead of sending another; a new wait on the same intent is a new message.
  A message about something that is not a wait (a finished run, a rollback notice) is sent once and never
  edited.
- Verified by: `telegram: a changed wait edits its message`, `telegram: a new wait on the same intent is a new message`

### TG-13 · Short and plain, with a link

Every message is short, written for a person, and links to its card.

- At most 600 characters outside the link, in the style of `prompts/writing.md`: what happened or what is
  asked, then why it matters, in plain words. No step names, field names or IDs as text. The link is the
  card on the page (TG-14), or the PR for a message about a PR when no page address is configured.
  Without either, the message has no link.
- Verified by: `telegram: messages are short and have a link`, `telegram: no link without a page address or PR`

### TG-14 · Links to cards

A message links to the card of the intent it is about.

- The card address is `<telegram.ui_url>/?intent=<id>`, where `telegram.ui_url` is an optional setting: the
  address at which the owner reaches the page from the phone (the page itself listens on `127.0.0.1`,
  UI-1, so this is a tunnel or VPN address). Without it, the link is the intent's current PR URL, and with
  no PR there is no link. Previews stay off (LOOP-16). The page opens the intent's card for `?intent=<id>`.
- Verified by: `telegram: a message links to its card`, `telegram: the link falls back to the PR`, `config: telegram ui_url is optional`, `ui: the card opens for an intent in the address`

### TG-15 · Unknown input gets the help line

Text Towercab cannot use gets a short help line, never silence and never a guess.

- An unknown `/command`, or text that is not a reply to a question, goes to the shadow when it is enabled
  (LOOP-129, LOOP-131); otherwise the answer is one line listing `/status`, `/focus`, `/queue`, `/pause`,
  `/resume` and `reply to a question to answer it`. A leading `/` and an `@bot` suffix are accepted.
- Verified by: `telegram: unknown command gets the help line`, `telegram: unknown text goes to the shadow when enabled`, `telegram: slash commands accept the bot suffix`

## Out of scope

- Each signed-in person's own chat, by role: a later intent (see TG-1).
- Webhooks and any inbound port: Towercab runs on a laptop, so it only polls (LOOP-127).
- Actions the page lacks (start, boost, edit intents, pause now): use the page or the shadow.

## Decisions

- Buttons call the page's actions rather than their own code, so a new rule (AUT-33) holds in both places
  without being written twice.
- A confirm for Merge and Drop, as the page asks before a merge: a thumb can hit the wrong button on a
  phone, and both are hard to undo. Everything else is one tap.
- On owner-only intents Telegram gives no buttons, because AUT-32 says Telegram never counts there; the
  message still links to the card so the owner can act on the page.
- Edit instead of send: the point of the chat is what needs the owner now; a stale message that still
  shows buttons is the thing to avoid.
