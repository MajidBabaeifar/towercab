# GitLab

**Status:** Live: GL-1, GL-10, GL-11, GL-12 · **Prefix:** GL

## Purpose

Towercab can work on code hosted on GitLab, gitlab.com or a self-managed server, as it does on GitHub:
the same pipeline, with merge requests in place of pull requests. This area covers only what is
specific to GitLab: the configuration, the identity, the repo names, how a merge request is read and
changed, and how the owner's and teammates' actions map onto GitLab. The host-neutral parts are the
forge interface (intent #128), which this area implements. Reading GitLab CI results is covered here;
issues and deployments are out of scope.

## Requirements

GL-4 to GL-9 are part of the work that makes the pipeline run on GitLab ([GL-13](#gl-13--the-loop-picks-intents-on-gitlab-repos) to
[GL-17](#gl-17--the-owner-is-told-once-when-the-token-is-about-to-expire)). Each is added to the Status line only when it is built and its
tests exist; the build may be split over several runs.

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
  names there. An approval counts only if it came after the last push ([GL-15](#gl-15--an-approval-counts-only-if-it-came-after-the-last-push)), whatever the
  project's setting for dropping approvals on a new commit; an older one is stale and Towercab asks again. Code owners are read from `CODEOWNERS` on the base branch (root, `docs/` or
  `.gitlab/`), by the same stricter rules; a group owner (`@group`) counts for nobody.
- **Request changes** has no equivalent on every GitLab tier, so it is an unresolved thread: a reviewer's
  findings are resolvable diff threads, and a teammate's or owner's unresolved thread or note after their last
  approval is feedback ([PIP-145](pipeline.md)). Towercab's own findings ([PIP-4](pipeline.md)) are one summary note plus one resolvable diff thread
  per finding that has a file and line; Towercab resolves its own thread when a later round fixes the finding.
- **Comment** = a note. Towercab never approves or resolves a human's thread.
- A project where approvals are not available (a tier without them, `404` on `…/approvals`) cannot
  satisfy `teammate_review=on`: the mission asks the owner as in PIP-142 and `towercab doctor` says
  `<name>: GitLab approvals are not available on this project, so teammate review cannot be met`.
- Verified by: `gitlab: an approval is the approved_by list`, `gitlab: a teammate approval counts only for a listed reviewer or code owner`, `gitlab: an approval before the last push is stale`, `gitlab: review findings become resolvable threads`, `gitlab: a fixed finding's thread is resolved by Towercab`, `gitlab: an unresolved human thread is feedback`, `gitlab: no approvals on the project cannot meet teammate review`

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

### GL-11 · Build results from merge request pipelines

On a GitLab repo, Towercab judges a merge request's build from the jobs of the pipelines that ran on the pushed head commit.

- Every `ci_poll` s ([PIP-3](pipeline.md)): `GET …/merge_requests/:iid/pipelines`, keeping only pipelines whose `sha` is the
  pushed head; pipelines for other commits never count. Each kept pipeline's jobs come from
  `GET …/pipelines/:id/jobs` (with `include_retried=false`, paginated as in [GL-5](#gl-5--merge-request-actions)). Several pipelines for one head all count.
- Job `status` maps to the buckets of PIP-3: `success` → pass; `failed` → fail; `canceled` → cancelled;
  `skipped` → left out; `created`, `pending`, `running`, `waiting_for_resource`, `preparing`, `scheduled` → pending.
- A `failed` job with `allow_failure: true` is neutral: it passes, as GitHub's `NEUTRAL` does.
- A `manual` job that is not `allow_failure` keeps its pipeline pending until `ci_wait` runs out, then
  `waiting: CI stuck` with the reason `job <name> is waiting for a manual start`. A manual job with
  `allow_failure: true` (GitLab's default for manual jobs) does not block.
- The grace window and the head rule are PIP-3's: within `ci_grace` s of a push, pipelines created before it
  are ignored, and no pipeline or job after `ci_grace` → green with `no CI on this repo`, as on a GitHub repo with no checks.
- GitHub repos are read as before.
- Verified by: `gitlab ci: only pipelines of the pushed head count`, `gitlab ci: job statuses map to the CI buckets`, `gitlab ci: an allowed failure is neutral`, `gitlab ci: a manual job keeps the pipeline pending and is named`, `gitlab ci: several pipelines for one head all count`, `gitlab ci: no pipelines is green after the grace window`

### GL-12 · A first red GitLab pipeline is retried, then repaired from log tails

A first red or cancelled GitLab pipeline is retried once before it counts, and a red that stays gives the repair round the failing jobs' logs.

- Same rule as [PIP-18](pipeline.md): the first red or cancelled pipeline of a head is retried once with `POST …/pipelines/:id/retry`, with no repair counted; a second red or cancel counts. A job in a pipeline
  that is not a retryable GitLab pipeline is never retried.
- A red after that → a repair round in `build` ([PIP-3](pipeline.md), at most `ci_repairs`) with the tails of the failing jobs' logs
  (`GET …/jobs/:id/trace`), cut to the same limit and redacted by the same rules as GitHub's ([PIP-83](pipeline.md)); allowed failures are not included.
- A retry that GitLab refuses → `waiting: CI red` with GitLab's reason.
- Verified by: `gitlab ci: a first red pipeline is retried once`, `gitlab ci: a first cancelled pipeline is retried once`, `gitlab ci: a failing job's log tail goes to the repair round`, `gitlab ci: log tails are cut and redacted`, `gitlab ci: a refused retry waits with the reason`

### GL-13 · The loop picks intents on GitLab repos

An intent on a GitLab repo is picked and goes through every stage like one on a GitHub repo.

- The hold-back of GitLab repos in `pick` is removed: a GitLab repo's intents follow the same order, limits and
  `after` rules as GitHub's ([LOOP-1](loop.md)). Each stage reaches the host only through the `Forge` of the
  mission's repo, which is a `GitLabForge` ([GL-5](#gl-5--merge-request-actions)) for a `gitlab:` repo, so no stage branches on the host.
- Spec, plan and code each open as a merge request, draft first ([GL-5](#gl-5--merge-request-actions)), and the CI stage reads
  its pipelines ([GL-11](#gl-11--build-results-from-merge-request-pipelines), [GL-12](#gl-12--a-first-red-gitlab-pipeline-is-retried-then-repaired-from-log-tails)).
- A GitLab repo's readiness has only the `verifying` item ([REPO-22](repo.md)..[REPO-33](repo.md) stay GitHub-only).
- Verified by: `gitlab: intents on a GitLab repo are picked`, `gitlab: a mission on a GitLab repo reaches the merged state`

### GL-14 · The loop reads merge requests and acts on them

Every minute the loop reads the merge request of each waiting GitLab mission and moves it as it does for a pull request.

- The loop's read of open pull requests ([PIP-21](pipeline.md)) also reads each GitLab mission's merge request
  as [GL-6](#gl-6--merge-request-events) lists, through `Forge`, never by branching on the host in `loop.ts`.
- The events of GL-6 reach `machine.apply` like GitHub's: `merged` → `*_merged`, `closed` → `closed`, an owner note →
  `feedback` with its file and line for a diff note, `/retry` → `retry`, a conflict, a moved head. Notes by the bot and system notes are not feedback.
- The owner's approval on a merge request that waits for it merges it with `sha=<gated head>` ([GL-5](#gl-5--merge-request-actions)), as in [PIP-43](pipeline.md),
  only once [GL-15](#gl-15--an-approval-counts-only-for-the-commit-it-was-given-on) holds.
- A merge request that GitLab can't read (404, 401) is a failure of the kind [GL-2](#gl-2--the-token-is-towercabs-identity) names, not a closed merge request.
- Verified by: `gitlab: the loop reads the merge request of a waiting mission`, `gitlab: a merged merge request moves the mission to merged`, `gitlab: a closed merge request moves the mission to closed`, `gitlab: an owner note in the loop becomes feedback`, `gitlab: /retry in the loop retries the mission`, `gitlab: the owner's approval in the loop merges`, `gitlab: an unreadable merge request is not a closed one`

### GL-15 · An approval counts only if it came after the last push

An approval merges only if it was given after the newest push to the branch: an older approval does not count, and Towercab asks again.

- Applies to the owner's approval ([GL-14](#gl-14--the-loop-reads-merge-requests-and-acts-on-them)) and to teammates' ([GL-7](#gl-7--approvals-notes-and-threads)), and it does not depend on any project setting
  (GitLab's "remove approvals on new commits" may be on or off).
- Before every merge, and before an approval satisfies `teammate_review`, Towercab compares two times. The approval time
  is `approved_at` of the person in `approved_by` on `…/approvals`; when GitLab omits it, the `created_at` of that person's
  system note "approved this merge request". The push time is `created_at` of the newest entry of `GET …/merge_requests/:iid/versions`
  (the time GitLab received the newest commit; a commit's own date can be rewritten, so it is not used).
- The approval counts only if its time is strictly later than the push time. An equal time, or a time that cannot be read, does not count.
- A stale approval is not merged: the mission waits for a new approval, and the stage comment says
  `approval was given at <time>, before the last push at <time>`. This replaces the patch-id rule of [PIP-142](pipeline.md) for GitLab ([GL-7](#gl-7--approvals-notes-and-threads)): an unchanged diff does not rescue an older approval.
- The merge still carries `sha=<gated head>`, so a head that moves between the check and the merge is refused ([PIP-22](pipeline.md)).
- Verified by: `gitlab: an approval after the last push merges`, `gitlab: an approval before the last push does not merge`, `gitlab: an approval at the same time as the push does not merge`, `gitlab: an approval time falls back to the system note`, `gitlab: an unreadable time does not count`, `gitlab: a stale approval is said in the stage comment`

### GL-16 · The intents repo on GitLab runs end to end

With the intents repo on GitLab, its plan merge requests are opened, read and merged by the loop.

- Completes [GL-4](#gl-4--the-intents-repo-on-gitlab): the store pulls, commits and pushes with the GitLab identity, and the plan merge
  request ([PIP-46](pipeline.md)) is read by the loop as GL-14 says and merged on the intents project.
- Code on GitHub with intents on GitLab, and the reverse, work: each repo uses its own host's `Forge`.
- Intents from issues are not read from a GitLab intents repo (GL-4); the loop does not fail on it.
- Verified by: `gitlab: a plan merge request on the intents project is merged by the loop`, `gitlab: code on GitHub with intents on GitLab`, `gitlab: code on GitLab with intents on GitHub`

### GL-17 · The owner is told once when the token is about to expire

Towercab tells the owner once when the GitLab token has 14 days or less left.

- Once per loop start the loop reads `GET <api_base>/personal_access_tokens/self` ([GL-9](#gl-9--doctor-checks-the-token)). On the first read where
  `expires_at` is within 14 days, it sends the owner one message ([LOOP-14](loop.md)): `GitLab token expires in <n> days
  (<date>): create a new one before then`. It is not repeated for the same `expires_at`, also after a restart; a new token with a new date can notify again.
- `expires_at: null` and a failed read send nothing; a token that already expired is the auth failure of [GL-2](#gl-2--the-token-is-towercabs-identity).
- Verified by: `gitlab: the owner is told once when the token is within 14 days of expiring`, `gitlab: the token notice is not repeated after a restart`, `gitlab: a token without expiry sends no notice`

## Out of scope

- GitLab issues, and deployments or environments; each is tracked separately. GitLab CI is read as GL-11 and GL-12 say; a GitLab repo with no pipelines has no CI stage and counts as a GitHub repo with no CI ([REPO-9](repo.md)).
- Repository settings and readiness checks that call GitHub ([REPO-22](repo.md)..[REPO-33](repo.md)): a GitLab repo has only the
  `verifying` item.
- SSH authentication and OAuth device flow.

## Decisions

- One token per installation, not per project: GitLab bot users come from project or group access tokens, and
  one group token covers its projects. Several groups would each need their own; that is a later extension.
- `oauth2` with the token over HTTPS for git, because it needs no SSH key and mirrors the GitHub credential helper.
- Approval freshness is decided by time (approval after the newest push), not by project settings or patch-id: it works on every tier and setting, at the price of asking again after a push that changed nothing.
- Request changes is an unresolved thread, because the native "request changes" exists only on paid tiers.
