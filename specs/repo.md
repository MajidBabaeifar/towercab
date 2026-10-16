# Repo contract

**Status:** Draft · **Prefix:** REPO

## Purpose

What each target repo tells Towercab about itself: how to check it, where it runs, and
what must never break. Lives in the repo, so it changes with the code it describes.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| REPO-1 | Each target repo has `TOWERCAB.md` at its root with sections `## Checks`, `## Live`, `## Red lines`, and optional front matter `max_autonomy: <1-5>` (default 5). | manual |
| REPO-2 | `## Checks`: the commands the worker runs locally before pushing (build, test, lint), one per line in a code block. | manual |
| REPO-3 | `## Live`: how to know a merge is deployed (GitHub deployment environment name, or URL + expected version/commit), deploy timeout (default 15 min), and the `e2e` command run against it. Empty → merged means done. | manual |
| REPO-4 | `## Red lines`: bullets naming paths, systems or behaviours whose change makes a PR high blast radius (e.g. `migrations/**`, auth, billing, public API, data deletion). | manual |
| REPO-5 | A task for a repo without `TOWERCAB.md` → `[!]`, `note: no TOWERCAB.md`; the worker's first task there may add one, which a human merges. | manual |
| REPO-6 | Towercab's own `TOWERCAB.md`: checks = its test command; no `## Live`; red lines = `.claude/**`, `TOWERCAB.md`, `bin/**`. | manual |

## Out of scope

- Secrets for e2e. The e2e command reads what it needs from the environment of the session.

## Decisions

- Markdown, not TOML: the risk agent reads red lines as prose; checks and e2e are plain
  code blocks a model copies verbatim.
- Red lines include Towercab's own control files, so an agent can't widen its own gates.
