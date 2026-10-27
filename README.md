# Towercab

Intents in, reviewed pull requests out.

## What it is

Towercab is an orchestrator for Claude Code that runs on your own machine. You describe a change as
an *intent*: a short Markdown file saying what the problem is, what outcome you want, and how urgent
and important it is. Towercab picks the most important one, has Claude Code turn it into a spec, a
plan and the code, checks the result in code (sandboxed checks, a red→green test proof, CI and a
review), and opens pull requests you review on GitHub. How much it does without you depends on the
autonomy level you give each intent.

It follows the structure of Anthropic's AI-Native SDLC Playbook. Towercab is not affiliated with or
endorsed by Anthropic.

## How it works

Every intent becomes three pull requests, and merging each one is your approval
([specs/pipeline.md](specs/pipeline.md)):

1. **Spec PR** in the target repo: the requirements the change adds or alters, in plain sentences.
2. **Plan PR** in your intents repo: the approach and why, the steps, the risks, and a checklist of
   the access the worker expects to need (network domains, protected files). Untick what you refuse.
3. **Code PR** in the target repo: written test-first, checked locally and in CI, reviewed by a
   separate Claude session, with a description that says what it does, why, and what to check.

You steer with ordinary GitHub actions. Merge to approve, close to drop, comment or request changes
to send it back with your notes, and reply to a question to answer it. `/retry` starts over. A local
web page shows what needs you, what is stuck, what is moving and what it costs
([specs/ui.md](specs/ui.md)), and Telegram tells you when something waits on you.

## Requirements

- Linux with systemd (`towercab up` installs a user service)
- Node.js 22.18 or newer
- `bwrap` (bubblewrap), the sandbox for checks and Claude Code runs
- `git`, and `gh` 2.46 or newer, logged in as you
- the Claude Code CLI (`claude`), logged in
- a GitHub App for Towercab, made from [ops/github-app.json](ops/github-app.json)

## Quickstart

1. Clone and install:

   ```bash
   git clone https://github.com/MajidBabaeifar/towercab.git && cd towercab && npm ci && npm run build:ui
   ```

2. Register the GitHub App from `ops/github-app.json`, install it on your intents repo and every
   repo Towercab should work in, and save its private key as `~/.config/towercab/app.pem` (mode 600).
3. Write `~/.config/towercab/config.toml`:

   ```toml
   [intents]
   remote = "https://github.com/<you>/intents.git"

   [github]
   app_id = 123456
   me = "<your login>"

   [repos.web]
   github = "<you>/web"
   ```

4. Check the setup with `bin/towercab doctor`, then start the service with `bin/towercab up` and open
   the page with `bin/towercab ui`.
5. Add an intent with `bin/towercab add "web: Log in with a magic link" u3 i4`, or with the `/intent`
   Claude Code skill (`./install.sh` links it).

## Safety

- **Sandbox:** every check and every Claude Code run is sandboxed: no access to your keys, tokens or
  other repos; a worker reaches only the network domains it is granted.
- **Guard:** a hook stops the worker from writing protected files (CI, `CLAUDE.md`, `REVIEW.md`,
  `TOWERCAB.md`, and paths you list) unless its plan grants them, and from editing tests it already
  pushed during repairs.
- **Gates:** code, not a model, decides whether a PR may merge: green CI, an approving review, and a
  test that fails without the change.
- **Autonomy:** a1–a3, you merge everything; a4, Towercab merges after every check passes and the
  build stayed within the plan; a5 (only for intents you wrote) also approves its own plan
  ([specs/autonomy.md](specs/autonomy.md)).

## Status

Early, and built for one person: it runs on one machine, for one owner, and is used daily by its
author. Version 1 (Rust) is on branch `rust`.

## Docs

- [specs/README.md](specs/README.md): how the specs work
- [specs/intents.md](specs/intents.md): intent files and the intents repo
- [specs/priority.md](specs/priority.md): scores and order
- [specs/autonomy.md](specs/autonomy.md): gates and access
- [specs/loop.md](specs/loop.md): the program
- [specs/pipeline.md](specs/pipeline.md): from intent to merged PR
- [specs/repo.md](specs/repo.md): what Towercab reads from a target repo
- [specs/ui.md](specs/ui.md): the local web page
- [specs/metrics.md](specs/metrics.md): cost and time
- [specs/public.md](specs/public.md): what this repo shows
