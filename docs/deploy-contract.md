# The deploy contract

Towercab can follow a change after it merges: it waits until your platform says the change is live,
runs your end-to-end tests against it, and when they fail, asks your platform for the last good version
and sends its worker back to fix the cause. Towercab never deploys anything itself and never connects to
a server. It reads what is live and asks for an older version, and your platform does the rest.

This page says what your platform has to do so Towercab can ship to it. The rules behind it are in
[specs/ship.md](../specs/ship.md).

## Turn it on for a repo

Add a `live` block to the repo's `TOWERCAB.md` front matter:

```yaml
---
live:
  url: https://app.example.com        # where the e2e tests point (BASE_URL)
  environment: production             # the deploy environment to watch
  adapter: github                     # github (default), gitlab (default on GitLab) or command
  timeout: 20                         # minutes to wait for a deploy
  suites:
    - name: smoke
      command: sh e2e/smoke.sh
      tests: [e2e/smoke.sh]
      smoke: true                     # also runs right after a rollback
    - name: browser
      command: npx playwright test
      tests: [e2e/**]
      paths: [web/**]                 # run it first when these files change
---
```

A suite is any shell command. Towercab doesn't know whether it drives a browser or calls an API; it
runs the command in its sandbox, with network, in a checkout of the commit that is live, and reads the
exit code. The command gets:

| Variable | Value |
|---|---|
| `BASE_URL` | the block's `url` |
| `TOWERCAB_SHA` | the commit under test |
| `TOWERCAB_ENVIRONMENT` | the block's `environment` |
| your secrets | every `KEY=VALUE` line of `~/.config/towercab/secrets/<repo>.env` |

The secrets file must be readable only by you (`chmod 600`). Towercab removes every secret value from
the logs it keeps, but a suite should still not print secrets.

In a repo with a `live` block, every change Towercab builds brings e2e tests for what it adds, under
one of the suites' `tests` globs, unless its plan says why none is needed.

## The github adapter (default)

Towercab talks to your platform only through GitHub Deployments on the app's repo, as its GitHub App.
Your platform has to do two things.

1. **Record every deploy as a Deployment.** One Deployment per deploy, in the environment the `live`
   block names, with `ref` set to the 40-character commit and a final status: `success` when the
   commit is live and healthy, `failure` (with a short description) when it isn't. Towercab treats the
   newest `success` as what is live, and a newer live commit that contains the one it waits for also
   counts.
2. **Deploy the commit a `deploy:rollback` Deployment asks for.** To roll back, Towercab creates a
   Deployment with `ref` = the last good commit, `task: deploy:rollback`, `auto_merge: false`,
   `required_contexts: []` and a payload `{intent, from, reason}`. GitHub sends a `deployment` event;
   your platform deploys that commit and posts its statuses on that same Deployment.

Towercab's GitHub App needs **read and write** access to Deployments for the rollback request.

### Worked example: one VPS, deployed from GitHub Actions

This is the setup Towercab is used with: Docker Compose apps on one VPS that is reachable only over
Tailscale.

- After CI builds and signs the image on `main`, a deploy job runs in the same workflow. It creates the
  Deployment with `GITHUB_TOKEN`, joins the tailnet as an ephemeral node tagged `tag:ci-deploy`, and
  runs `ssh deploy@<vps> <app> <sha>` with a key whose `authorized_keys` line forces one command. The
  server checks the image's signature, swaps it, checks health and puts the old version back on red.
  The job posts `in_progress`, then `success` or `failure`.
- A second workflow in the app's repo runs `on: deployment` for `production` and calls the same deploy
  job with the event's Deployment id, so a rollback request deploys like any other commit.
- The tailnet policy lets `tag:ci-deploy` reach only port 22 on the server, and the key can only run
  the deploy command, so the CI credential can do nothing else.
- Deployments created with `GITHUB_TOKEN` don't start workflows, which is why the automatic deploy runs
  inside the image workflow and only Towercab's or a person's requests go through the `deployment`
  event. GitHub runs the `on: deployment` workflow file of the requested commit, so a rollback can only
  go back to a commit that already has that file.

### Other platforms that react to GitHub Deployments

- **Argo CD:** a Notifications trigger can post Deployment statuses for each sync, and a small
  receiver for the `deployment` webhook can set the Application's target revision to the requested
  commit.
- **Your own deployer:** anything that receives GitHub's `deployment` webhook and can post Deployment
  statuses fits.

## The gitlab adapter (default for GitLab repos)

A repo hosted on GitLab uses this adapter when the `live` block names none. Towercab reads the
deployments GitLab records for the environment, as its GitLab token, and never deploys itself.

- **Name the environment.** The deploy job needs `environment:` with the same name as the `live`
  block's `environment` (`production` if the block names none). GitLab records one deployment per run of
  that job, with the commit it ran for.
- **Deploy `CI_COMMIT_SHA`.** The job deploys the commit it was started for, not "latest". Towercab
  treats the newest `success` deployment as what is live, and a newer live commit that contains the one it
  waits for also counts. A failed deployment turns red with the job's failure reason.
- **Rollback re-runs an older job.** To go back, Towercab retries the job of the newest successful
  deployment of the last good commit, so that job must be able to deploy that commit again.
- **Approval.** A protected environment can require a person to approve the deploy. Towercab shows
  that as waiting, not as a failure, tells you after 5 minutes that a person has to approve it in GitLab,
  and never approves itself. Unapproved after `timeout` minutes it turns red with the same reason.
- **Allow older jobs to run again.** Turn the project setting "Prevent outdated deployment jobs" off for
  the environment Towercab rolls back; with it on, GitLab refuses the retry and the rollback fails.
- **Token role.** Towercab's token must be allowed to run that environment's jobs; for a protected
  environment, add its user to the environment's allowed deployers.

```yaml
# .gitlab-ci.yml
deploy:
  stage: deploy
  environment:
    name: production            # the live block's environment
    url: https://app.example.com
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - ./ops/deploy.sh "$CI_COMMIT_SHA"
```

## The command adapter

For a platform that doesn't speak GitHub Deployments, name two commands in the `live` block:

```yaml
live:
  url: https://app.example.com
  adapter: command
  live_command: fly releases --json | jq -r '.[0].ImageRef' | sed 's/.*sha-//'
  rollback_command: ./ops/rollback.sh "$TOWERCAB_ROLLBACK_SHA"
  suites: [...]
```

- `live_command` prints the commit that is live now; Towercab reads the first 40-character hex word of
  its output. It runs every poll until the merged commit (or a newer one containing it) shows up, or
  the timeout passes.
- `rollback_command` gets `TOWERCAB_ROLLBACK_SHA` and `TOWERCAB_REASON`. Exit 0 means the request was
  taken; Towercab then waits for `live_command` to print that commit.
- Both run in the sandbox with network and the repo's secrets, 5 minutes each. A platform without a
  failure state can only turn red by the timeout.

Vercel (`vercel rollback`, `vercel promote`) and Fly (`fly releases`, `fly deploy --image`) fit this
shape with a short script each.

## What Towercab does with it

1. After it merges a code PR, the mission waits at `deploy` until the commit is live. A failed deploy
   or the timeout counts as red.
2. At `e2e` it runs the suites: those whose tests the change touched first, then those whose `paths`
   match, then the rest. A red suite runs once more; red twice is red.
3. Green: the intent is done, and this commit becomes the repo's last good version.
4. Red: Towercab asks for the last good version (or does nothing when your platform already put it
   back), waits for it, runs the smoke suites, and sends the worker back to fix the cause in a new PR.
   That PR goes through every check and ships the same way.
5. After two fixes that didn't hold, Towercab opens and merges a PR that reverts the intent's merges,
   checks that it is live, and hands the intent back to you.
6. While a change ships or is being fixed, nothing else merges in that repo. When a rollback fails,
   the repo stays frozen until you look.
