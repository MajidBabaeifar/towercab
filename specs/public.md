# Public repo

**Status:** Live: PUB-1..17 · **Prefix:** PUB

## Purpose

What Towercab's public repo shows a visitor: a license, a security policy, a README that explains
what it is and how to run it, a screenshot, contributing and conduct guides, an example config, and no
personal names in what ships.

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

The README says Towercab is not affiliated with or endorsed by Anthropic, and shows only Towercab's
own images.

- It names Claude Code and the playbook as plain text, with no Anthropic or Claude logo or image.
  Every image in the README (`<img src>`, `<source srcset>` or `![]()`) is Towercab's logo
  (`ui/public/favicon.svg`), a screenshot of its own UI in `docs/assets/` (PUB-13), a
  `img.shields.io` badge or this repo's own Actions badge. Every local image exists.
- Verified by: `public: README says not affiliated`

### PUB-4 · Docs index

The README's Docs section links every spec that isn't removed.

- One relative link per `specs/*.md` not marked `Removed` in `specs/README.md`, plus
  `specs/README.md`; no link points at a missing file.
- Verified by: `public: README docs index`

### PUB-5 · No personal names

Nothing that ships names the owner; prompts and messages say "the owner".

- The owner's first name (the literal lives only in the test) occurs in none of `README.md`,
  `package.json`, `CLAUDE.md`, `TOWERCAB.md`, `agents/**`, `prompts/**`, `skills/**`, `src/**`, `ui/src/**`,
  `ops/**`, `specs/**` (`LICENSE`, `tests/**` and the repo URL are exempt). The guard says
  `changes here go through the owner`.
- Verified by: `public: no personal names`

### PUB-6 · No GitHub settings changed

The code never changes a GitHub setting or visibility.

- No `gh repo edit` and no settings API call in `src/`; `ops/github-app.json` stays `public: false`.
  Topics the owner sets: `claude-code`, `ai-agents`, `agentic-coding`, `sdlc`, `orchestrator`,
  `autonomous-coding`, `typescript`.
- Verified by: `public: the App manifest stays private`

### PUB-7 · History scan

Before the repo goes public, every commit on every branch and tag is scanned for secrets, and each
finding is classified.

- gitleaks scans all refs (`git log --all` range, not only new changes). The report lists each
  finding by file, rule and commit, with the secret redacted (`--redact`), and marks it a real secret
  or a false positive (a test fixture, an example value).
- The report is in the PR description; the raw gitleaks output is not committed.
- Verified by: manual: the PR lists every finding with its class; a full-history `gitleaks git --redact` run on the PR branch exits 0.

### PUB-8 · Allowlist by fingerprint

False positives are allowed one finding at a time, so the CI scan stays clean without hiding real ones.

- Each false positive is allowed by its own fingerprint (`commit:file:rule:line`), in `.gitleaksignore`
  next to `.gitleaks.toml` if the toml format has no fingerprint key. No `paths`, `rules` or broad
  `regexes` entry is added for this.
- Each fingerprint has a comment saying why it is a false positive.
- Verified by: `public: gitleaks allowlist is by fingerprint`

### PUB-9 · Real secrets

A real secret found in the history is removed from the current tree, and the PR says what to rotate.

- For each one the PR gives: what it is (kind and where it was used), the commits that contain it, and
  that it must be rotated (revoked and replaced) whether or not the history is rewritten.
- The tree no longer contains it. If the history holds none, the PR says so in one line.
- Verified by: manual: the PR section on real secrets, and a scan of the working tree finds none.

### PUB-10 · History rewrite is the owner's

When a real secret is in the history, the PR gives the commands to remove it, and the build runs none of them.

- The PR gives the exact `git filter-repo` commands (for example `--replace-text` or `--invert-paths`)
  that clean every branch and tag, and the force-push steps, for the owner to run before the repo goes public.
- The build never rewrites history, force-pushes, or rotates a key. Without a real secret, no commands are given.
- Verified by: manual: the PR lists the commands; `git log` of the PR branch only adds commits on top of `main`.

### PUB-11 · Secrets stay out of the output

No secret value appears in the PR, a comment, a log or a commit.

- Findings are shown redacted or by fingerprint and commit only; a fingerprint is `commit:file:rule:line`, not the value.
- Verified by: manual: search the PR text, commits and CI logs for the flagged values.

### PUB-12 · Personal data in the history

The PR lists personal data in commit metadata and files, so the owner can decide on it with the question of whether to keep the history.

- A scan or grep covers author and committer emails and names on all refs, and files for email
  addresses and home paths (`/home/<user>`, `/Users/<user>`). The PR lists them by kind, count and
  example commit or file, without removing anything.
- Verified by: manual: the PR section on personal data.

### PUB-13 · README screenshot and website

The README shows pictures of Towercab's own web page and links to its website in the first section.

- `docs/assets/` holds screenshots of Towercab's own page in light and dark, cropped from the UI tests'
  fixture shots (`npm run test:ui`), so they show the real page and no real data. The README shows the
  overview before `## How it works`, as a `<picture>` that follows the reader's colour scheme, with alt
  text on every image, and every file it points to exists.
- The README's first section links to `https://towercab.com`. The link is not checked online: it may
  go live before the site does.
- Verified by: `public: README shows the screenshot and website`

### PUB-14 · Contributing guide

`CONTRIBUTING.md` tells a newcomer how to propose a change the way Towercab's own work is done.

- It says: change the specs first (links `specs/README.md`), run `npm ci` and `npm run check`, use
  Conventional Commits, keep PRs small, keep tests hermetic (no network, no real GitHub), and report
  security issues through `SECURITY.md`, not issues (links it). The README links `CONTRIBUTING.md`.
- Verified by: `public: contributing guide`

### PUB-15 · Code of conduct

The repo has a code of conduct, the Contributor Covenant 2.1, and reports go to a private channel.

- `CODE_OF_CONDUCT.md` is the Contributor Covenant 2.1 text (it names version 2.1). The enforcement
  section sends reports to GitHub's private reporting (the repo's Security tab) and contains no
  email address. The README or `CONTRIBUTING.md` links it.
- Verified by: `public: code of conduct`

### PUB-16 · Example config

`config.example.toml` at the root shows every setting with a placeholder, and the Quickstart points to it.

- It replaces a `.env.example`, which does not exist: Towercab reads `~/.config/towercab/config.toml`
  (or `TOWERCAB_CONFIG`), and the only environment variables are `TOWERCAB_HOME` and `TOWERCAB_CONFIG`.
- It parses with `parseConfig` without error, sets every key `src/config.ts` reads (each with a
  one-line `#` comment), and holds only placeholders (such as `your-login`, `owner/repo`), no real
  login, id, key or path of the owner. The README Quickstart names `config.example.toml`.
- Verified by: `public: example config`

### PUB-17 · New files carry no personal names

The new public files obey the no-personal-names rule.

- PUB-5's file list also covers `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `config.example.toml` and
  `docs/**` (text files).
- Verified by: `public: no personal names`

### PUB-18 · Bug report form

A stranger who reports a bug is asked for what we need to act on it: what happened, what was expected, the versions and the log lines.

- `.github/ISSUE_TEMPLATE/bug_report.yml` is a GitHub issue form (`name`, `description`, `body`).
  Required fields: what happened, what was expected, the Towercab commit or version, OS, Node,
  `gh` and Claude Code versions. Optional: the relevant log lines, in a `render: shell` textarea
  that says to remove secrets (tokens, keys, private repo names) first.
- "What happened" and "what was expected" are the fields that become the intent's Problem and
  Proposed outcome ([INT-22](intents.md)). The form's `labels` do not include `towercab`: only the
  owner decides which issues Towercab reads ([INT-20](intents.md)).
- Verified by: `public: bug report form asks for the versions and logs`

### PUB-19 · Feature request form

A stranger who asks for a feature is asked for the problem and the outcome wanted, the same two parts an intent has.

- `.github/ISSUE_TEMPLATE/feature_request.yml` is an issue form with two required textareas labelled
  `Problem` and `Proposed outcome`, matching the intent sections ([INT-2](intents.md)). It adds no
  `towercab` label.
- Verified by: `public: feature request form has problem and outcome`

### PUB-20 · Issue chooser

Blank issues are off, and security reports are sent to the security policy.

- `.github/ISSUE_TEMPLATE/config.yml` has `blank_issues_enabled: false` and one `contact_links`
  entry whose `url` points at `SECURITY.md` of this repo ([PUB-1](#pub-1--license-and-security-policy)),
  with a name that says it is for vulnerabilities.
- Verified by: `public: issue chooser blocks blank issues and points to the security policy`

### PUB-21 · Pull request template

A stranger's pull request says what changes and why, which spec rows it touches and how it was checked.

- `.github/pull_request_template.md` has `## ` sections, in order: what changes and why, spec rows
  touched (IDs, or "none" for a change with no behaviour), how it was checked (`npm run check`), and
  screenshots for UI changes.
- Towercab's own PR bodies keep the sections of `prompts/writing.md`; no check requires the template's
  sections in them, and no code reads the template.
- Verified by: `public: pull request template sections`

## Out of scope

- Changing CI; bringing it to the shared template is a separate intent.

- Changing the repo's visibility or settings (the owner's).
- Rewriting history, force-pushing, or rotating keys (the owner's).

## Decisions

- The public README is for a visitor deciding whether to try Towercab; specs are linked, not copied.
- The README keeps Towercab's logo and its light and dark screenshots (the owner's call, 2026-10-30):
  PUB-3 and PUB-13 first allowed a single `![` screenshot, then were widened to the README the owner
  built by hand.
