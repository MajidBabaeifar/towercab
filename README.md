<p align="center">
  <img src="ui/public/favicon.svg" width="96" height="96" alt="Towercab logo: a control tower under a beacon">
</p>

<h1 align="center">Towercab</h1>

<p align="center">
  <strong>Intents in, reviewed pull requests out.</strong><br>
  A local orchestrator for Claude Code that turns short Markdown intents into spec, plan and code
  pull requests you review on GitHub.
</p>

<p align="center">
  <a href="https://github.com/MajidBabaeifar/towercab/actions/workflows/ci.yml"><img src="https://github.com/MajidBabaeifar/towercab/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4338ca" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-4338ca" alt="Node.js 22.18 or newer">
  <img src="https://img.shields.io/badge/TypeScript-no%20build%20step-4338ca" alt="TypeScript, no build step">
  <img src="https://img.shields.io/badge/status-early-f59e0b" alt="Status: early">
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#docs">Docs</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/overview-dark.png">
  <img src="docs/assets/overview-light.png" alt="The Towercab overview: four things need the owner, an airspace strip shows each intent moving from gate through spec, plan and code to landed, and a code review card has a Merge PR button.">
</picture>

## What it is

Towercab is an orchestrator for Claude Code that runs on your own machine. You describe a change as
an *intent*: a short Markdown file saying what the problem is, what outcome you want, and how urgent
and important it is. Towercab picks the most important one, has Claude Code turn it into a spec, a
plan and the code, checks the result in code (sandboxed checks, a red→green test proof, CI and a
review), and opens pull requests you review on GitHub. How much it does without you depends on the
autonomy level you give each intent.

It follows the structure of Anthropic's AI-Native SDLC Playbook. Towercab is not affiliated with or
endorsed by Anthropic.

The website is [towercab.com](https://towercab.com).

## How it works

Every intent becomes three pull requests, and merging each one is your approval
([specs/pipeline.md](specs/pipeline.md)):

```mermaid
flowchart LR
  I["Intent<br/>a short Markdown file"] --> S["Spec PR<br/>in the target repo"]
  S -- "you merge" --> P["Plan PR<br/>in the intents repo"]
  P -- "you merge" --> C["Code PR<br/>in the target repo"]
  C -- "you merge, or Towercab at a4+" --> M(["Merged"])
```

1. **Spec PR** in the target repo: the requirements the change adds or alters, in plain sentences.
2. **Plan PR** in your intents repo: the approach and why, the steps, the risks, and a checklist of
   the access the worker expects to need (network domains, protected files). Untick what you refuse.
3. **Code PR** in the target repo: written test-first, checked locally and in CI, reviewed by a
   separate Claude session, with a description that says what it does, why, and what to check.

After the merge, a repo can opt into the ship stage ([specs/ship.md](specs/ship.md)): Towercab waits
until your platform says the change is live, runs your end-to-end tests against it, and when they
fail, asks for the last good version and fixes forward. It never deploys anything itself; the
[deploy contract](docs/deploy-contract.md) says what your platform needs to do.

You steer with ordinary GitHub actions. Merge to approve, close to drop, comment or request changes
to send it back with your notes, and reply to a question to answer it. `/retry` starts over. A local
web page shows what needs you, what is stuck, what is moving and what it costs
([specs/ui.md](specs/ui.md)), and Telegram tells you when something waits on you.

<table>
  <tr>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/intent-dark.png">
        <img src="docs/assets/intent-light.png" alt="An intent waiting for plan review: its spec PR is merged, its plan PR is open, and the card lists the network domains and files the worker may reach before you merge.">
      </picture>
      <p><strong>Review a plan.</strong> Each intent's page shows its three PRs and what the worker
      wants to reach beyond the repo, so you know what you approve when you merge.</p>
    </td>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/question-dark.png">
        <img src="docs/assets/question-light.png" alt="Towercab asks what the CSV totals row should do with several currencies, offers three options and recommends one totals row per currency.">
      </picture>
      <p><strong>Answer a question.</strong> When the worker is unsure, it asks with options and a
      recommendation, and goes on as soon as you reply here or on GitHub.</p>
    </td>
  </tr>
</table>

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
3. Copy [config.example.toml](config.example.toml) to `~/.config/towercab/config.toml` and replace its
   placeholders (it lists every setting with a comment). The smallest working file is:

   ```toml
   [intents]
   remote = "https://github.com/<you>/intents.git"

   [github]
   app_id = 123456
   me = "<your login>"
   ```

4. Check the setup with `bin/towercab doctor`, add a repo with `bin/towercab repo add <you>/web` (it
   checks the App can reach it, takes its default branch and clones it), then start the service with
   `bin/towercab up` and open the page with `bin/towercab ui`. More repos can be added later from the
   page or with `repo add`, without a restart.
5. Add an intent with `bin/towercab add "web: Log in with a magic link" u3 i4`, or with the `/intent`
   Claude Code skill (`./install.sh` links it).

## Safety

| Layer | What it does |
| --- | --- |
| **Sandbox** | Every check and every Claude Code run is sandboxed: no access to your keys, tokens or other repos, and a worker reaches only the network domains it is granted. |
| **Guard** | A hook stops the worker from writing protected files (CI, `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `TOWERCAB.md`, and paths you list) unless its plan grants them, and from editing tests it already pushed during repairs. |
| **Gates** | Code, not a model, decides whether a PR may merge: green CI, an approving review, and a test that fails without the change. |
| **Autonomy** | At a1–a3 you merge everything. At a4 Towercab merges after every check passes and the build stayed within the plan. At a5 (only for intents you wrote) it also approves its own plan ([specs/autonomy.md](specs/autonomy.md)). |

## Status

Early, and built for one person: it runs on one machine, for one owner, and is used daily by its
author. Version 1 (Rust) is on branch `rust`.

## Docs

| Spec | What it covers |
| --- | --- |
| [specs/README.md](specs/README.md) | How the specs work |
| [specs/intents.md](specs/intents.md) | Intent files and the intents repo |
| [specs/priority.md](specs/priority.md) | Scores and order |
| [specs/autonomy.md](specs/autonomy.md) | Gates and access |
| [specs/loop.md](specs/loop.md) | The program |
| [specs/pipeline.md](specs/pipeline.md) | From intent to merged PR |
| [specs/ship.md](specs/ship.md) | After the merge: deploy, e2e, rollback |
| [specs/repo.md](specs/repo.md) | What Towercab reads from a target repo |
| [specs/ui.md](specs/ui.md) | The local web page |
| [specs/metrics.md](specs/metrics.md) | Cost and time |
| [specs/public.md](specs/public.md) | What this repo shows |

Want to help? Read [CONTRIBUTING.md](CONTRIBUTING.md); everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

<p align="center"><sub>MIT licensed · <a href="SECURITY.md">Report a vulnerability</a></sub></p>
