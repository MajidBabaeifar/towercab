# Repo contract

**Status:** Draft · **Prefix:** REPO

## Purpose

What each target repo tells Towercab about itself, in the playbook's files: how to verify work
(`CLAUDE.md`), how to review it (`REVIEW.md`), and the Towercab-only rest (`TOWERCAB.md`).
Lives in the repo, so it changes with the code it describes.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| REPO-1 | Three files at the target repo's root, always read from the base branch (`git show origin/<base>:<file>`), never from the PR: `CLAUDE.md` with a `## Verifying your work` section (REPO-2), `REVIEW.md` (REPO-4), `TOWERCAB.md` (front matter `max_autonomy: <1-5>` (default 5), `protected: [globs]`, `tests: [globs]` ([PIP-30](pipeline.md)); a ` ```live ` block, REPO-3). | test_parse_repo_files, test_read_from_base |
| REPO-2 | `CLAUDE.md` `## Verifying your work`: fenced ` ```checks ` (one command per line, run in order by verify, [PIP-23](pipeline.md), sandboxed, no network; the worker runs them too, [PIP-1](pipeline.md)) and optional ` ```setup ` (one command per line, with network, after each clone and before each checks run: dependency fetch, e.g. `cargo fetch`, `npm ci --ignore-scripts`). Optional ` ```run ` (start command, `url:`, `ui:`) opts the repo into the verifier ([PIP-32](pipeline.md)). Prose around them is for the agent, as in the playbook. | test_checks_block, test_setup_block |
| REPO-3 | `TOWERCAB.md` ` ```live `: `deploy: env:<name>` or `deploy: url:<url>` (body shows the deployed sha), `timeout: <minutes>` (default 15), `e2e: <command>`. Missing → merged means done ([PIP-8](pipeline.md)). Optional ` ```release ` (production gate, [PIP-34](pipeline.md)) and ` ```rollback ` (`command:`, `rehearse:`, [PIP-35](pipeline.md)). | test_live_block |
| REPO-4 | `REVIEW.md` (playbook p.38–39): `## Passes` (one bullet per pass: name and what to look for; missing → Bugs, Security, Compliance with the spec rows and `plan.md`), `## What Important means here`, `## Cap the nits` (its first number = nits shown per review, default 5), `## Do not report`, `## Red lines` (Towercab's addition: bullets naming paths, systems or behaviours whose change makes a PR high blast radius, e.g. `migrations/**`, auth, billing, public API, data deletion). Used by the review ([PIP-4, 5](pipeline.md)) and e2e triage ([PIP-20](pipeline.md)). | test_review_md, test_red_lines_in_review_prompt |
| REPO-5 | No `## Verifying your work` with a ` ```checks ` block on the base → `waiting: add CLAUDE.md verifying block` (the playbook's feedback loop comes first). `REVIEW.md` and `TOWERCAB.md` are optional (defaults as above). | test_missing_verifying_block |
| REPO-6 | Towercab's own files: `CLAUDE.md` verifying block: setup `cargo fetch --locked`; checks `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`. `REVIEW.md` red lines: `src/machine.rs`, `ops/**`. `TOWERCAB.md`: no `live`, `protected: [src/machine.rs, ops/bands.yaml]`, `tests: [tests/**]`. Code in `src/lib.rs` (`src/main.rs` only calls it) and tests in `tests/`, so the red→green proof can lay them over base ([PIP-30](pipeline.md)). | test_own_repo_files |
| REPO-7 | `towercab protect <repo>` (run by me, with my `gh` login): `POST repos/<r>/rulesets` (or `PUT rulesets/<id>` if one named `towercab` exists) with `{name: towercab, target: branch, enforcement: active, bypass_actors: [], conditions: {ref_name: {include: [refs/heads/<base>], exclude: []}}, rules: [{type: pull_request, parameters: {required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false}}, {type: required_status_checks, parameters: {strict_required_status_checks_policy: false, required_status_checks: [{context: <name>} for each check of the last green run on <base>]}}, {type: non_fast_forward}, {type: deletion}]}`; no green run → the status-checks rule is left out. Intent home (`intents`): `non_fast_forward` and `deletion` only, since Towercab pushes there directly ([INT-10](intents.md)). On the Towercab repo the required checks also include `towercab/evals` ([PIP-33](pipeline.md)). Prints what it set; `doctor` warns for repos without it. | test_protect_payload, test_protect_intents_repo, manual |
| REPO-8 | **Protected paths** = control files (`CLAUDE.md`, `REVIEW.md`, `TOWERCAB.md`, `.github/**`, `.claude/**`) + `TOWERCAB.md` `protected` globs. The worker can't write them ([PIP-29](pipeline.md)) unless the intent's `unlock` names them. | test_protected_paths |

## Out of scope

- Secrets in `TOWERCAB.md`. e2e secrets live in `~/.config/towercab/secrets/<repo>.env` ([PIP-9](pipeline.md)).
- A code check of red-line paths before the review (offered, not chosen): red lines are judged by the review model.

## Decisions

- The playbook's files (my call): `CLAUDE.md` is given to every session from the base branch ([PIP-24](pipeline.md)), `REVIEW.md` is the review policy;
  only what has no playbook home stays in `TOWERCAB.md`. Fenced blocks for what code runs, prose for what a model judges.
- Read from base: a PR can't change the rules it is judged by.
- Rulesets apply to Towercab and me alike; I merge in the UI the same way (PR + green CI).
- Status checks not strict: a PR needn't be up to date with base to merge, so busy repos don't loop
  through update → CI → review; post-merge CI and e2e catch the rest.
