# Public repo

**Status:** Draft · **Prefix:** PUB

## Purpose

What Towercab's public repo shows a visitor: a license, a security policy, a README that explains
what it is and how to run it, and no personal names in what ships.

## Requirements

### PUB-1 · License and security policy

The repo is MIT-licensed and says how to report a vulnerability privately.

- `LICENSE` is the MIT text (first line `MIT License`, a `Copyright (c)` line); `package.json` has
  `"license": "MIT"`. `SECURITY.md` says to report through GitHub's private reporting, not a public
  issue, and names the supported version (the latest release or `main`).
- Verified by: `public: license and security policy`

### PUB-2 · README sections

The README explains what Towercab is, what it needs and how to start, in that order.

- `## ` sections, in order: what Towercab is (intents in, reviewed PRs out; an orchestrator for
  Claude Code), **How it works** (spec, plan and code PRs, linking [pipeline.md](pipeline.md)),
  **Requirements** (Linux, systemd, Node ≥ 22.18, `bwrap`, `gh` ≥ 2.46, the Claude Code CLI, a GitHub
  App), **Quickstart** (clone, `npm ci`, the App, config, `towercab up`, `towercab ui`), **Safety**
  (sandbox, guard, gates, autonomy), **Status** (early, single user), **Docs**. Every `towercab`
  subcommand the Quickstart names exists.
- Verified by: `public: README sections`

### PUB-3 · Not affiliated

The README says Towercab is not affiliated with or endorsed by Anthropic.

- It names Claude Code and the playbook as plain text, with no logo or image of either (no `<img>` or
  `![` in the README).
- Verified by: `public: README says not affiliated`

### PUB-4 · Docs index

The README's Docs section links every spec that isn't removed.

- One relative link per `specs/*.md` not marked `Removed` in `specs/README.md`, plus
  `specs/README.md`; no link points at a missing file.
- Verified by: `public: README docs index`

### PUB-5 · No personal names

Nothing that ships names the owner; prompts and messages say "the owner".

- The owner's first name (the literal lives only in the test) occurs in none of `README.md`,
  `package.json`, `CLAUDE.md`, `TOWERCAB.md`, `prompts/**`, `skills/**`, `src/**`, `ui/src/**`,
  `ops/**`, `specs/**` (`LICENSE`, `tests/**` and the repo URL are exempt). The guard says
  `changes here go through the owner`.
- Verified by: `public: no personal names`

### PUB-6 · No GitHub settings changed

The code never changes a GitHub setting or visibility.

- No `gh repo edit` and no settings API call in `src/`; `ops/github-app.json` stays `public: false`.
  Topics the owner sets: `claude-code`, `ai-agents`, `agentic-coding`, `sdlc`, `orchestrator`,
  `autonomous-coding`, `typescript`.
- Verified by: `public: the App manifest stays private`

## Out of scope

- Changing the repo's visibility or settings (the owner's).

## Decisions

- The public README is for a visitor deciding whether to try Towercab; specs are linked, not copied.
