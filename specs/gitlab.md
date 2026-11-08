# GitLab

**Status:** Live: GL-1, GL-10 · **Prefix:** GL

## Purpose

Towercab can work on code hosted on GitLab, gitlab.com or a self-managed server, as it does on GitHub:
the same pipeline, with merge requests in place of pull requests. This area covers only what is
specific to GitLab: the configuration, the identity, the repo names, how a merge request is read and
changed, and how the owner's and teammates' actions map onto GitLab. The host-neutral parts are the
forge interface (intent #128), which this area implements. GitLab CI, issues and deployments are out
of scope.

## Requirements

### GL-1 · The `[gitlab]` config table

Towercab reads where GitLab is, who the owner is there, and where the token is kept from one config table.

- `[gitlab]`: `api_base` (default `https://gitlab.com/api/v4`; a self-managed server gives its own, for
  example `https://git.example.com/api/v4`), `me` (the owner's GitLab username, required once a GitLab
  repo exists) and `token_file` (path, `~/` allowed). Unknown keys are ignored ([LOOP-1](loop.md)).
- `api_base` must be an `https://` URL ending in `/api/v4` (`http://` only for `localhost` and `127.0.0.1`, for
  tests). Anything else → `config: <file>: gitlab.api_base must be an https URL ending in /api/v4`.
- `token_file` must exist, be a regular file with mode 600 and hold one non-empty line; otherwise
  `config: <file>: gitlab.token_file <why>` (`is readable by group or others`, `is empty`, `does not exist`).
  The token is read when used, never cached on disk, never printed, and never put in a Claude run's environment.
- Without a `[gitlab]` table nothing about GitLab runs, and a GitHub-only installation behaves as before.
- Verified by: `gitlab: config defaults`, `gitlab: config rejects a bad api_base`, `gitlab: config refuses a token file others can read`

### GL-2 · The token is Towercab's identity

The token's bot user is who Towercab is on GitLab, and what it pushes with.

- The token is a project or group access token with the scopes `api` and `write_repository`. Towercab
  asks `GET <api_base>/user` with it once per loop start: `username` is Towercab's login (the bot that
  [GL-5](#gl-5--merge-request-actions) comments as and [GL-6](#gl-6--merge-request-events) ignores as an author), `id` and `name` give the commit author
  `<name> <<id>-<username>@noreply.<host>>`, where `<host>` is the host of `api_base`.
- **Git pushes.** Git over HTTPS authenticates with a credential helper that answers with username
  `oauth2` and the token as password, only for the host of `api_base`, as the GitHub helper does
  ([LOOP-19](loop.md)); the token is never in a remote URL, a log line or a Claude run.
  SSH is not used.
- A 401 from GitLab is an auth failure like GitHub's ([LOOP-10](loop.md)); a self-managed server that is
  down is a network failure.
- Verified by: `gitlab: the token's bot user is the identity`, `gitlab: git uses the token through a credential helper`, `gitlab: commits are authored by the bot`, `gitlab: no token in Claude's environment`

### GL-3 · GitLab project names

`towercab repo add gitlab:group/subgroup/project` adds a GitLab project, nested groups included.

- A repo's host is part of its name: `gitlab:<path>` is GitLab, a bare `owner/name` or a
  `github.com` URL is GitHub ([LOOP-66](loop.md)). `<path>` has two or more segments separated by `/`, each a
  repo name ([INT-2](intents.md)); a `https://<host>/` prefix of the configured `api_base` host and a
  `.git` suffix are dropped. The project is looked up by its URL-encoded path
  (`GET /projects/group%2Fsubgroup%2Fproject`), its `path_with_namespace` is stored as given by
  GitLab, and its `default_branch` as `base`. The short name defaults to the last segment.
- The `repos` table gains `host` (`github` or `gitlab`, default `github`) and the stored name keeps the
  existing `github` column for GitHub only; the build decides the exact columns and updates the
  **Schema** block then. `repo list` shows `gitlab:group/project` for a GitLab repo.
- Refusals, in addition to LOOP-66's: `repo add needs [gitlab] in <file> (me, token_file)`;
  `<text> isn't a GitLab project: write it as gitlab:group/project`; `Towercab can't reach
  gitlab:<path>: <why>` (404, 401, or a token with too few scopes).
- Verified by: `gitlab: repo add accepts nested groups`, `gitlab: repo add stores the path and default branch`, `gitlab: repo add refuses an unreachable project`, `gitlab: repo list names the host`

### GL-4 · The intents repo on GitLab

The intents repo can live on GitLab, with its plan merge requests there.

- `[intents].remote` may be a GitLab project (`gitlab:group/intents` or its clone URL on the
  `api_base` host). The store ([INT-12](intents.md)) pulls, commits and pushes as before, authenticated by [GL-2](#gl-2--the-token-is-towercabs-identity).
  Plan merge requests ([PIP-46](pipeline.md)) are opened and merged on that project by the same forge
  implementation as for code.
- Code in one host and intents on the other works: each repo uses its own host's identity. Syncing
  intents from issues ([INT-10](intents.md)) is GitHub-only; a GitLab intents repo has intents from files only, and its
  `source: issue` is not read.
- Verified by: `gitlab: the intents repo can be a GitLab project`, `gitlab: plan merge requests open on the intents project`

### GL-5 · Merge request actions

The GitLab forge does everything the pipeline does to a pull request, on a merge request.

- Implements the forge interface (#128) over `<api_base>` with the token, so the pipeline code does not branch on the host:
  - open a merge request as a draft: `POST /projects/:id/merge_requests` with the title prefixed
    `Draft: `; mark it ready: `PUT` the title without the prefix; update the description: `PUT` with `description`.
  - comment: `POST …/notes`. Stage comments ([PIP-14](pipeline.md)) carry the same hidden marker (an HTML
    comment) as on GitHub; Towercab edits only a note it wrote, found by marker and author, with
    `PUT …/notes/:id`, and posts a new one when none is found.
  - merge: `PUT …/merge` with `sha=<gated head>` and `squash=true`, which GitLab refuses when the head
    moved ([PIP-22](pipeline.md)); `detailed_merge_status` plays `mergeStateStatus`: `mergeable` → merge, `need_rebase`
    → bring the branch up to date (`PUT …/rebase`), `conflict` → a conflict round, `ci_must_pass`,
    `not_approved`, `discussions_not_resolved`, `checking` → read again as for BLOCKED.
  - close: `PUT` with `state_event=close`.
- Lists are read with `per_page=100` and `Link`/`x-next-page` pagination, to the end.
- Verified by: `gitlab: opens a draft merge request`, `gitlab: marks a merge request ready`, `gitlab: updates the description`, `gitlab: edits its own stage comment by marker`, `gitlab: never edits a note it did not write`, `gitlab: merges on the gated head`, `gitlab: merge status maps to the pipeline's merge rules`, `gitlab: closes a merge request`, `gitlab: paginates notes`

### GL-6 · Merge request events

A merge request moves an intent exactly as a pull request does.

- Read every minute ([PIP-21](pipeline.md)): `GET …/merge_requests/:iid` (state, `merged_at`, `merge_commit_sha`, `sha`,
  `detailed_merge_status`, `has_conflicts`, `diff_refs`), `…/notes` (notes that are not `system`),
  `…/discussions` for diff notes (notes with a `position`) and `…/approvals`.
- Events, in the order of [LOOP-18](loop.md): `merged` → `*_merged`; `closed` → `closed`; a note by the owner
  (`[gitlab].me`) → `feedback`, a diff note of the owner included with its file and line; a note by the owner
  that is `/retry` → `retry`; `has_conflicts` → conflict; `sha` moved → head moved. Notes by the
  bot and system notes (GitLab's own "added 1 commit", label and assignment lines) are never feedback.
- The owner's approval ([GL-7](#gl-7--approvals-notes-and-threads)) on a merge request that waits for it triggers the merge, as on GitHub ([PIP-43](pipeline.md)).
- Verified by: `gitlab: a merged merge request becomes merged`, `gitlab: a closed merge request becomes closed`, `gitlab: an owner note is feedback`, `gitlab: an owner diff note is feedback with its line`, `gitlab: system and bot notes are not feedback`, `gitlab: /retry works`, `gitlab: a conflict is an event`, `gitlab: the owner's approval merges`

### GL-7 · Approvals, notes and threads

GitHub's approve, request changes and comment map onto GitLab approvals, notes and resolvable threads, so each action has one meaning.

- **Approve** = a GitLab approval (`POST …/approve`, listed in `approved_by` on `…/approvals`). The owner's
  approval ([PIP-43](pipeline.md)) is the owner's name in `approved_by`; teammates' approvals ([PIP-142](pipeline.md)) are the listed reviewers' and code owners'
  names there. An approval counts for the head it was given on: GitLab drops approvals on a new commit only if the
  project is set to; where it does not, Towercab treats an approval as stale by the same patch-id rule as
  PIP-142 and asks again. Code owners are read from `CODEOWNERS` on the base branch (root, `docs/` or
  `.gitlab/`), by the same stricter rules; a group owner (`@group`) counts for nobody.
- **Request changes** has no equivalent on every GitLab tier, so it is an unresolved thread: a reviewer's
  findings are resolvable diff threads, and a teammate's or owner's unresolved thread or note after their last
  approval is feedback ([PIP-145](pipeline.md)). Towercab's own findings ([PIP-4](pipeline.md)) are one summary note plus one resolvable diff thread
  per finding that has a file and line; Towercab resolves its own thread when a later round fixes the finding.
- **Comment** = a note. Towercab never approves or resolves a human's thread.
- A project where approvals are not available (a tier without them, `404` on `…/approvals`) cannot
  satisfy `teammate_review=on`: the mission asks the owner as in PIP-142 and `towercab doctor` says
  `<name>: GitLab approvals are not available on this project, so teammate review cannot be met`.
- Verified by: `gitlab: an approval is the approved_by list`, `gitlab: a teammate approval counts only for a listed reviewer or code owner`, `gitlab: an approval of an older head with a changed diff is stale`, `gitlab: review findings become resolvable threads`, `gitlab: a fixed finding's thread is resolved by Towercab`, `gitlab: an unresolved human thread is feedback`, `gitlab: no approvals on the project cannot meet teammate review`

### GL-8 · Acting as the owner on GitLab

Actions the owner starts from the UI or the CLI on a GitLab repo happen under the owner's own `glab` login.

- `ownerGlab(args)` is `glab` without the token, its login (`glab auth status --hostname <host>`) showing
  `[gitlab].me`. `approve` → `glab mr approve` and then `glab mr merge --squash --sha <head>` on the merge
  request the intent waits on; a reply → `glab mr note`; drop → `glab mr close` ([LOOP-38](loop.md)). Both go through `Tools`.
- Not logged in, or logged in as another user → the action is refused with
  `glab is not logged in as <me> on <host>: run glab auth login`. `doctor` prints `glab` version and the same check.
- Verified by: `gitlab: approve merges as the owner`, `gitlab: a reply is a note by the owner`, `gitlab: owner actions refuse another glab login`

### GL-9 · doctor checks the token

`towercab doctor` checks the GitLab token's scopes and expiry, and warns two weeks before it runs out.

- `GET <api_base>/personal_access_tokens/self` (works for personal, project and group tokens) gives `scopes`,
  `expires_at` and `active`. Failures, each printed on one line and failing `doctor`: scopes missing `api` or
  `write_repository` → `GitLab token lacks <scope>: create a project or group access token with api and
  write_repository`; `active` false or `expires_at` passed → `GitLab token expired on <date>: create a new one`.
- A token that expires within 14 days → a warning (exit code unchanged): `GitLab token expires in <n> days
  (<date>): create a new one before then`. `expires_at: null` → no warning. Towercab also tells the owner once
  ([LOOP-14](loop.md)) on the day it crosses 14 days.
- Also checked: the token file's mode ([GL-1](#gl-1--the-gitlab-config-table)) and that `glab` is logged in ([GL-8](#gl-8--acting-as-the-owner-on-gitlab)). `doctor --quick` skips the network reads.
- Verified by: `doctor: GitLab token missing a scope fails`, `doctor: GitLab token expired fails`, `doctor: GitLab token near expiry warns`, `doctor: GitLab token without expiry is quiet`

### GL-10 · Tests use a fake GitLab

Every GitLab test runs against an in-process fake, with no network.

- `tests/helpers/` gains a fake GitLab HTTP server (on `127.0.0.1`, an ephemeral port, `api_base` pointed at
  it) and a fake `glab` in `FakeTools`. The fake keeps projects, merge requests, notes, discussions and
  approvals in memory, enforces the token and the `sha` check on merge, and paginates. No test uses gitlab.com or
  `~/.local/share/towercab`.
- Verified by: `gitlab: the fake enforces the token and the merge sha`, `gitlab: the fake paginates`

## Out of scope

- GitLab CI (pipelines and required jobs), GitLab issues, and deployments or environments as a GitLab feature of
  their own; each is tracked separately. Reading deployments for the ship stage is [SHIP-37](ship.md). Until CI is built, a GitLab repo has no CI stage: checks run locally as for a GitHub repo with no CI ([REPO-9](repo.md)).
- Repository settings and readiness checks that call GitHub ([REPO-22](repo.md)..[REPO-33](repo.md)): a GitLab repo has only the
  `verifying` item.
- SSH authentication and OAuth device flow.

## Decisions

- One token per installation, not per project: GitLab bot users come from project or group access tokens, and
  one group token covers its projects. Several groups would each need their own; that is a later extension.
- `oauth2` with the token over HTTPS for git, because it needs no SSH key and mirrors the GitHub credential helper.
- Request changes is an unresolved thread, because the native "request changes" exists only on paid tiers.
