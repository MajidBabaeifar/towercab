# Users

**Status:** Draft · **Prefix:** USR

## Purpose

One Towercab, hosted inside one company, used by a team. People sign in with their own GitHub
account, each with a role that limits what they can do, optionally on some repos only. Every action
shows who did it. A Towercab with no users set up behaves as before: one owner, no sign-in.

## Requirements

### USR-1 · Four roles

Every person has one of four roles: admin, maintainer, contributor or viewer, and the role decides what they may do.

- Actions, each allowed from the role named and every role above it (admin > maintainer > contributor > viewer):
  - viewer: read everything (board, cards, intent pages, timelines, costs); change nothing.
  - contributor: create intents, and answer the questions they were asked (USR-9: a question is asked of the person who wrote the intent, and of the repo's maintainers and admins).
  - maintainer: approve and merge, reply, start, boost, drop and edit intents, confirm an intent whose writer has a lower role or no role (AUT-23), change an intent's autonomy within AUT-24, retry, pause and resume.
  - admin: manage users, roles, repo access and settings (USR-14), plus everything a maintainer can do.
- One pure function `can(user, action, repo)` in `src/users.ts` answers it; the page, the API, the GitHub events and Telegram all call it, so no channel has rules of its own.
- Verified by: `users: each role may do exactly its actions`, `users: a viewer changes nothing`

### USR-2 · Only added people get in

Only people an admin added, or members of a GitHub team the admin names, can sign in.

- People are rows in the database (`users`: GitHub login, role, repo scope, added by, added at, disabled at), keyed by lower-cased GitHub login.
- An admin may name one GitHub team (`org/team`) and the role its members get: viewer by default, at most contributor. Maintainer and admin are never given by a team; an admin grants them to a person by name (USR-14), and a team role above contributor is refused when set. A person who is in the team and has no row gets that role while a membership check (at sign-in and at most every 10 minutes while signed in) finds them in the team; a row always wins over the team. A person who leaves the team loses access at the next check.
- Anyone else who signs in with GitHub sees "This Towercab doesn't know your GitHub account. Ask an admin to add you." and gets no session.
- Verified by: `users: an added person can sign in`, `users: a team member gets the team role`, `users: a row wins over the team`, `users: a team role above contributor is refused`, `users: a team member is a viewer by default`, `users: a person who left the team loses access`, `users: an unknown account is refused`

### USR-3 · GitHub sign-in, no passwords

People prove who they are with their GitHub account; Towercab stores no passwords.

- Sign-in uses GitHub's OAuth web flow with a GitHub App's client id and secret (`[auth] client_id`, `client_secret_env`, `public_url`) and the `state` parameter checked on return. Towercab asks for no more than the login and, for a named team, the team membership.
- The identity is the verified GitHub login from the API, never a name sent by the browser.
- Sign-in is on when `[auth]` is configured (USR-6); there is no other way in: no local accounts, no password reset.
- Verified by: `users: sign-in checks the state parameter`, `users: the login comes from the github api`, `users: no password is stored`

### USR-4 · Sessions expire and can be ended

A session ends by itself after a while, and an admin can end any session at once.

- A session is a random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only its hash is stored (`sessions`: user, created, last seen, expires, revoked at).
- Expires after 12 hours without use and 7 days at most (`[auth].session_hours`, `[auth].session_days`). A change to a person's role or repo scope, or removing them, applies at their next request.
- Revoking one session, or all of a person's sessions, makes the next request fail with 401 and the page return to sign-in. Removing a person revokes all their sessions.
- Changes with a cookie (`POST` actions) also need a CSRF check: the `Origin` must be `public_url`.
- Verified by: `users: a session expires when idle`, `users: a session expires after seven days`, `users: a revoked session fails at once`, `users: removing a person revokes their sessions`, `users: a role change applies to the open session`, `users: a post from another origin is refused`

### USR-5 · A role can be limited to some repos

A person's role can apply to some repos only, so they can be a maintainer on one project and a viewer on another.

- A user has a default role and optional per-repo roles: `{ role: "viewer", repos: { "acme/api": "maintainer" } }`. For repo R the role is the per-repo role if there is one, else the default. A per-repo role may be lower than the default.
- Actions that belong to a repo (an intent, its PRs, a card) are checked with that repo; actions with no repo (listing, creating nothing) use the default role. Admin is global: a per-repo role never makes someone admin of one repo.
- A viewer's lists and cards show every repo (viewers see everything, USR-1) even where their role is lower.
- Verified by: `users: a repo role overrides the default`, `users: maintainer on one repo and viewer on another`, `users: admin is never per repo`

### USR-6 · The owner is the first admin; no config change

A Towercab with one owner keeps working with no config change, and the owner is the first admin.

- When `[auth]` is absent, nothing changes: no sign-in, the page stays on localhost (UI-1), every action is the owner's (PIP-44, AUT-13), and the actor is `[github].me`.
- When `[auth]` is set, `[github].me` is created as admin on first start if no user exists, so an admin can always sign in. The last enabled admin cannot be removed, demoted or disabled (USR-14).
- The command line and the `gh` login on this machine stay the owner's, as in AUT-35's decisions: they are not a security boundary.
- Verified by: `users: without auth config the owner acts as before`, `users: the owner becomes the first admin`, `users: the last admin cannot be removed`

### USR-7 · The API checks the role on every request

The dashboard's API refuses what a role does not allow, whatever the page shows.

- With `[auth]` set, every `/api` request needs a valid session (401 otherwise, except the sign-in routes) and passes `can` (USR-1) with the repo of the intent it touches (403 with the reason "your role (viewer) can't <action> on <repo>").
- The page also hides or disables an action the role can't do (UI-220), but the check is the API's.
- The server binds to the address `[auth].listen` names (default `127.0.0.1`), so a team can reach it behind the company's proxy.
- Verified by: `users: the api needs a session`, `users: the api refuses an action the role does not allow`, `users: a viewer gets 403 on every action route`

### USR-8 · Every action names who did it

Each action Towercab takes for a person records their GitHub login and role, and shows the name.

- The action record gains `actor` (login) and `via` (`page`, `github`, `telegram`, `cli`); the timeline entries, the cards and the intent page show "<name> · <via>". With no `[auth]` the actor is `[github].me`.
- A person's display name is their GitHub name, falling back to the login.
- The actor of a new intent is its writer (AUT-23): the verified account of the push, the person behind a Telegram chat, the signed-in person, or the owner for the command line. An account that maps to no person is shown by its GitHub login as "unknown".
- Actions Towercab takes by itself are recorded as `towercab`.
- Verified by: `users: an action records its actor and channel`, `users: the timeline names who acted`, `users: an action by towercab is recorded as towercab`

### USR-9 · A teammate's GitHub actions count by role

A teammate's merge, review or comment on GitHub moves an intent when their role allows it on that repo, and anyone else's is ignored.

- Replaces PIP-44 when `[auth]` is set: the author's login is looked up in the users (USR-2, including the named team) and `can(user, action, repo)` decides: an approving review or merge needs maintainer; a comment or a review's text that gives feedback needs maintainer; `/retry` (PIP-45) needs maintainer. One maintainer's approval is enough: there is no count of approvals.
- A contributor's comment counts only as the answer to a question Towercab asked them (they wrote the intent, USR-1) while that intent waits on it. Any other comment of a contributor is shown on the timeline with their name (USR-8) but moves nothing: no event, no reply.
- A login that is no user, a disabled user, a viewer's comment, the App's bot: ignored, as non-owners are today. No event, no reply.
- `feedback_seen` moves forward only when an event is taken.
- Verified by: `users: a maintainer's approval on github counts`, `users: a contributor's comment answers a question they were asked`, `users: a contributor's other comment is shown but moves nothing`, `users: one maintainer's approval is enough`, `users: a viewer's github comment is ignored`, `users: an unknown account's github review is ignored`, `users: a maintainer on another repo is ignored`

### USR-10 · Towercab's PR comments say who decided

When a person acts through Towercab, the comment or merge on the PR says who did it.

- Towercab posts the comment as itself: "approved by <name> in Towercab" (and "answered by", "dropped by", "boosted by"), with `via`. It does not post as that person.
- Merges Towercab makes for a person's approval state it in the merge commit body (`Approved-by: <login>`).
- Verified by: `users: a pr comment names who approved`, `users: the merge records who approved`

### USR-11 · Each person links their own Telegram chat

Each person can link their own Telegram chat, and only a linked chat gets messages or can act.

- A person starts linking on their account menu (UI-223) and gets a short one-time code (10 minutes, single use) to send to the bot; the bot ties that chat id to their user. One chat per person; linking again replaces it. An unlinked chat gets no messages and its commands are refused.
- With `[auth]` unset, `[telegram].chat_id` stays the owner's chat as before.
- What a chat may do is what the person's role allows (USR-1), and its actions record `via: telegram` and the person (USR-8).
- Verified by: `users: a code links a chat to its person`, `users: a code works once and expires`, `users: an unlinked chat is ignored`, `users: a telegram action follows the role`

### USR-12 · Telegram sends a person only what waits on them

A person's Telegram chat gets only the messages for things that wait on them.

- A card that waits for a decision goes to every linked maintainer and admin of that repo; a question goes to the person who wrote the intent (whatever their role, unless viewer) and to the linked maintainers and admins of that repo. A viewer gets nothing, and a contributor gets only questions on intents they wrote.
- When one person decides, the other copies are edited as handled, naming who ([telegram.md](telegram.md)).
- Verified by: `users: a decision card goes to maintainers of that repo`, `users: a viewer gets no telegram message`, `users: other copies are edited when one person decides`

### USR-13 · Viewers see everything and change nothing

A viewer can look at every board, card, timeline and cost, and every action is absent or refused for them.

- Covers the whole read API; no read is hidden by repo scope (USR-5). Secrets, tokens and config values are not part of any read for any role below admin.
- Verified by: `users: a viewer can read every repo`, `users: config secrets are never in a read`

### USR-14 · An admin manages people

An admin adds, changes and removes people, sets repo access, names the team and ends sessions.

- Actions (API under `/api/users`): add a login with a role and optional repo roles, change role or repos, disable and remove, name or clear the team and its role, list sessions, revoke. Adding checks the login exists on GitHub.
- Each change is recorded: who, what, when (`user_events`), and shown on the admin page (UI-222).
- The last enabled admin can't be changed away from admin or removed (USR-6). "Revoke all sessions" on one's own account keeps the current session, so an admin can't lock themselves out by mistake.
- Settings: an admin may change settings from the page, except security ones. The config file stays the source of truth and the page writes to it (only the changed keys, other lines byte-identical, as the repo settings and budgets of UI-150 already do), recorded like any change. Security settings are changed only by editing the file and refused from the page and the API with "this is a security setting: edit the config file": the sandbox and its access rules, the autonomy defaults and caps, and any budget above the cap the file sets for it (a budget may be changed up to its cap). Users and the named team live in the database, not in the file.
- Maintainers and contributors never change settings.
- Verified by: `users: an admin adds a person with repo roles`, `users: only an admin manages users`, `users: every user change is recorded`, `users: adding an unknown github login fails`, `users: an admin changes a setting and writes only that key to the config file`, `users: a security setting is refused from the page`, `users: a budget above its cap is refused`

### USR-15 · One company, one Towercab

All users share one set of repos, intents and one cost view; there are no separate workspaces.

- No user, role or repo scope creates a second tenant; the intents repo, the database and the config are the single one.
- Verified by: manual: there is no field or screen for a workspace or customer.

## Out of scope

- More than one approval before a merge: one maintainer is enough for now; several is a later intent.
- Several companies or customers on one Towercab, and intents in a database (a parked intent).
- Passwords, SSO providers other than GitHub, API keys for scripts.
- A person's own settings beyond linking Telegram.

## Decisions

- The writer of an intent comes from the channel, not the file (the owner's call, 2026-11-07), because `source: me` is a line anyone can type. Conservative defaults taken: an unverifiable push has no writer and is treated like an unmapped account; the writer is kept with the mission, so no intent file is rewritten; a later edit never changes the writer; intents from before sign-in count as the owner's, so turning it on changes nothing for work in flight; a viewer or unmapped writer's intent waits as a card and nothing runs, and dropping it needs the same role as confirming.
- Towercab comments as itself with the person's name, instead of posting as them: it has no token of theirs and the comment must be traceable to the Towercab action.
- Roles are ordered, not a set of ticks: four levels are easy to explain and check; the repo scope adds the only other dimension.
- The team can lift people no higher than contributor (the owner's call, 2026-11-07), so a large GitHub team can't grant approval rights by membership alone.
- A row beats the team, so an admin can lower or disable one member of a trusted team.
- Without `[auth]` nothing changes, so one-owner installs need no migration.
