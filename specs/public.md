# Public repo

**Status:** Live: PUB-1..6 · **Prefix:** PUB

## Purpose

What a stranger finds when the repo turns public: a license, a security contact, a README for users and
no one person's name in what Towercab ships. Checked by plain file reads in `tests/public.rs`.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| PUB-1 | `LICENSE` is the MIT text (first line `MIT License`, a `Copyright (c)` line with year and holder); `Cargo.toml` has `license = "MIT"`; `SECURITY.md` says to report privately through GitHub (Security → Report a vulnerability), not in a public issue, and names the supported version (the latest release or `main`). | test_license_and_security |
| PUB-2 | `README.md` has, in order, these `## ` sections (titles case-insensitive): what Towercab is (intents in, reviewed PRs out; an orchestrator for Claude Code), **Playbook** (a table mapping each stage of Anthropic's AI-Native SDLC Playbook to a Towercab stage, linking [pipeline.md](pipeline.md) rows), **Requirements** (Linux, systemd, `bwrap`, `gh` ≥ 2.46, the Claude Code CLI, a GitHub App), **Quickstart** (install, the App from `ops/github-app.json`, config, `towercab migrate`, `up`, `ui`), **Safety** (sandbox, guard, gates, autonomy), **Status** (early, single user), **Docs**. Every `towercab` subcommand the Quickstart names exists in the CLI. | test_readme_sections |
| PUB-3 | The README says it is not affiliated with or endorsed by Anthropic; it names the playbook and Claude Code as plain text, with no logo or image of either (no `<img>` or `![` in the README, no image files besides the repo's own). | test_readme_not_affiliated |
| PUB-4 | `## Docs` in the README lists every `specs/*.md` that is not marked `Removed` in `specs/README.md`'s table, one relative link each, and links `specs/README.md`; no link in the README points at a missing file. | test_readme_docs_index |
| PUB-5 | No personal name in what ships: the owner's first name (the literal lives in the test, as a whole word) occurs in none of `README.md`, `Cargo.toml`, `CLAUDE.md`, `TOWERCAB.md`, `prompts/**`, `skills/**`, `src/**`, `ops/**`, `specs/**` (`LICENSE`, `tests/**` and the repo URL `github.com/<login>/towercab` are exempt). The owner is "the owner" in prompts, the guard and publish messages ([PIP-29](pipeline.md)), the `/intent` skill, the CLI `about` and the App manifest `description`; the exact strings are `changes here go through the owner` and `These paths go through the owner`. | test_no_personal_names, test_guard_messages_say_owner |
| PUB-6 | The PR changes no GitHub setting and no visibility: no `gh repo edit` or `gh api` call, no `public: true` in `ops/github-app.json` (it stays `public: false`, [LOOP](loop.md) row for the manifest). The PR body lists the GitHub description and topics the owner sets: `claude-code`, `anthropic`, `ai-agents`, `agentic-coding`, `sdlc`, `orchestrator`, `autonomous-coding`, `rust`. | test_manifest_stays_private, manual (the PR body lists description and topics; visibility is the owner's after merge) |

## Out of scope

- Flipping visibility, setting description and topics (the owner, after merge).
- Rewriting history (see Decisions).
- A code of conduct, contribution guide, issue templates, a logo.
- Renaming `[github].me` or reading it into static messages.

## Decisions

- One new area, not rows in `repo.md` or `loop.md`: these are file-content checks of Towercab's own repo, with no runtime behaviour.
- "the owner" is a literal in the messages, not read from `[github].me`: the guard and publish strings are constants today and need no config in the hook; `me` is a login, not a name. The owner's login stays in the repo URL, which a public repo must show.
- `LICENSE` is exempt from PUB-5: an MIT notice must carry a copyright holder; its holder is the owner's call.
- README is checked by structure (sections, links, subcommands), not prose, so wording can improve without a spec change; "not affiliated" and the playbook table are the claims that must stay.
- Wording about the playbook is factual (stage names, page numbers already used in the specs); no claim of endorsement, certification or compatibility beyond what the specs verify.
- Tests live in `tests/public.rs` with plain string reads from the crate root (no `set_var`, no network).
