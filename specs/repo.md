# Repo contract

**Status:** Draft · **Prefix:** REPO

## Purpose

What each target repo tells Towercab about itself: how to check it, where it runs, and
what must never break. Lives in the repo, so it changes with the code it describes.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| REPO-1 | Each target repo has `TOWERCAB.md` at its root: optional front matter `max_autonomy: <1-5>` (default 5), fenced blocks ` ```setup `, ` ```checks `, ` ```live `, and a `## Red lines` section. Towercab always reads it from the base branch (`git show origin/<base>:TOWERCAB.md`), never from the PR. | test_parse_towercab_md, test_read_from_base |
| REPO-2 | ` ```checks `: one command per line, run in order by verify ([PIP-23](pipeline.md)), sandboxed, no network; the worker runs them too ([PIP-1](pipeline.md)). ` ```setup `: one command per line, run with network after each clone and before each checks run (dependency fetch, e.g. `cargo fetch`, `npm ci --ignore-scripts`). Both optional; no checks → verify passes, CI is the only test. | test_checks_block, test_setup_block |
| REPO-3 | ` ```live `: `deploy: env:<name>` or `deploy: url:<url>` (body shows the deployed sha), `timeout: <minutes>` (default 15), `e2e: <command>`. Missing → merged means done ([PIP-8](pipeline.md)). | test_live_block |
| REPO-4 | `## Red lines`: bullets naming paths, systems or behaviours whose change makes a PR high blast radius (e.g. `migrations/**`, auth, billing, public API, data deletion). Read by the review model for tasks without `a` and by e2e triage ([PIP-5](pipeline.md), [PIP-20](pipeline.md)). | test_red_lines_in_review_prompt |
| REPO-5 | Task for a repo without `TOWERCAB.md` on its base → `[!]`, `note: no TOWERCAB.md`, message ([LOOP-14](loop.md)). | test_missing_towercab_md |
| REPO-6 | Towercab's own `TOWERCAB.md`: setup `cargo fetch --locked`; checks `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`; no `live`; red lines: `.claude/**`, `TOWERCAB.md`, `ops/**`, `src/machine.rs`, `.github/**`. | test_own_towercab_md |
| REPO-7 | `towercab protect <repo>`: `POST repos/<r>/rulesets` (or `PUT rulesets/<id>` if one named `towercab` exists) with `{name: towercab, target: branch, enforcement: active, bypass_actors: [], conditions: {ref_name: {include: [refs/heads/<base>], exclude: []}}, rules: [{type: pull_request, parameters: {required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false}}, {type: required_status_checks, parameters: {strict_required_status_checks_policy: false, required_status_checks: [{context: <name>} for each check of the last green run on <base>]}}, {type: non_fast_forward}, {type: deletion}]}`; no green run → the status-checks rule is left out. Task repo (`gradient-tasks`): `non_fast_forward` and `deletion` only, since Towercab pushes there directly ([TSK-5](tasks.md)). Prints what it set; `doctor` warns for repos without it. | test_protect_payload, test_protect_task_repo, manual |

## Out of scope

- Secrets in `TOWERCAB.md`. e2e secrets live in `~/.config/towercab/secrets/<repo>.env` ([PIP-9](pipeline.md)).
- A code check of red-line paths before the review (offered, not chosen): red lines are judged by the review model.

## Decisions

- Fenced blocks for what code runs, prose for what a model judges.
- Read from base: a PR can't change the rules it is judged by.
- Rulesets apply to Towercab and me alike; I merge in the UI the same way (PR + green CI).
- Status checks not strict: a PR needn't be up to date with base to merge, so busy repos don't loop
  through update → CI → review; post-merge CI and e2e catch the rest.
