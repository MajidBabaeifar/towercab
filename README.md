# Towercab

Towercab is an orchestrator for Claude Code: intents in, reviewed PRs out. You write down what you want as
an intent, a Markdown file in one repo you own. The `towercab` loop picks the most important one, has Claude Code
design, plan and build it, checks the result in code (sandboxed checks, red→green proof, CI, review), opens the
pull request, merges when the intent's autonomy level allows it, then deploys, runs e2e and reverts on red.

It follows the structure of Anthropic's AI-Native SDLC Playbook. Towercab is not affiliated with or endorsed by
Anthropic.

## Playbook

How the playbook's stages map to what Towercab does. The rows that define each step are in
[specs/pipeline.md](specs/pipeline.md).

| Playbook stage | In Towercab |
|---|---|
| 1 Plan | An intent is captured once as a file in the intents repo ([specs/intents.md](specs/intents.md)); scores decide the order ([specs/priority.md](specs/priority.md)) |
| 2 Design | The `design` stage adds the requirement rows to `specs/`; the spec is approved before any code |
| 3 Build | The `build` stage: a plan you can review, then Claude Code in a sandbox behind a guard hook |
| 4 Verify and review | Checks in code, red→green proof, CI, a PR review pass, then the gate |
| 5 Ship | Merge by autonomy level, deploy, e2e, release gate, revert on red |
| 6 Maintain | Bands on Towercab's own metrics open new intents ([specs/maintain.md](specs/maintain.md)) |

## Requirements

- Linux with systemd (for `towercab up`, the user service)
- `bwrap` (bubblewrap), the sandbox for every Claude Code run
- `git` and `gh` ≥ 2.46
- the Claude Code CLI (`claude`), logged in
- a GitHub App you create from the manifest in `ops/github-app.json`
- Rust, to build it

## Quickstart

1. Install, then check what is missing:

   ```bash
   cargo install --path . --locked   # → ~/.cargo/bin/towercab
   ./install.sh                      # the /intent skill into ~/.claude/skills
   towercab doctor                   # config, programs, GitHub App, rulesets, Telegram
   ```

2. Create the GitHub App from `ops/github-app.json` (GitHub → Settings → Developer settings → GitHub Apps,
   or the manifest flow), install it on your repos, and save its private key as `app.pem` next to the config.
3. Write `~/.config/towercab/config.toml` (see **Config** below).
4. Move old `TODO.md` lines into intent folders, once: `towercab migrate`. Protect each repo's base branch:
   `towercab protect <repo>`.
5. Start the loop with `towercab up`, and open the web page with `towercab ui`.

Add an intent with `towercab add "<repo>: <title>" u3 i4`, or with `/intent` in Claude Code.

## Safety

- **Sandbox:** Claude Code runs inside `bwrap`; protected paths (CI, `CLAUDE.md`, deploy files) are read-only to it.
- **Guard:** a `PreToolUse` hook refuses writes to protected paths and to tests already pushed; those go through the owner.
- **Gates:** code, not a model, decides whether a PR may merge: green CI, the PR review, the red→green proof, the release gate.
- **Autonomy:** each intent has a level `a1`–`a5`, capped per repo. At a1–a3 the owner approves the spec and the plan and merges;
  `towercab pause` stops all picks.

Details: [specs/autonomy.md](specs/autonomy.md), [specs/repo.md](specs/repo.md), [specs/pipeline.md](specs/pipeline.md).

## Config

`~/.config/towercab/config.toml` (`--config`, `TOWERCAB_CONFIG`; every key: [specs/loop.md](specs/loop.md) **Config**):

```toml
[intents]
remote = "https://github.com/<login>/intents.git"
cutoff = 7

[agent]
model = "opus"        # parallel, timeouts, budget, ci_poll … have defaults

[github]
app_id = 123456       # your GitHub App (ops/github-app.json); key: app.pem next to this file
me = "<login>"        # the owner: whose merge and approval count

[repos.myrepo]
github = "<login>/myrepo"
path = "~/.local/share/towercab/repos/myrepo"   # Towercab's own clone, not your checkout
base = "main"

[policies]            # optional: a repo of policy skills
github = "<login>/agent-instructions"

[telegram]            # optional
bot_token = "123456:ABC..."
chat_id = "123456789"
```

e2e secrets per repo: `~/.config/towercab/secrets/<repo>.env` (`KEY=VALUE`, mode 0600).

## Commands

| Command | Does |
|---|---|
| `towercab migrate` | once: the old `TODO.md` lines become intent folders |
| `towercab up` · `down` · `logs` | the systemd user service running `run --watch` |
| `towercab run [--watch] [--intent ID]` | the loop; without `--watch` it exits when nothing is runnable |
| `towercab step <id>` | one step of an intent's mission in the foreground |
| `towercab status` · `next` | what runs, what waits on you, what it would pick and why |
| `towercab ui` | the web page at http://127.0.0.1:7311/ while `up` (`[ui] port`, 0 = off): what runs and waits on you, every intent (edit u/i/a, model, drop, add), the repos' readiness |
| `towercab add "<repo>: <title>" [uN iN aN]` | a thin intent on `main` (or `/intent` in Claude Code) |
| `towercab approve <id>` · `retry --fresh <id>` · `release <id>` | go on after a wait, start over, authorize a release |
| `towercab pause` · `resume` · `trust <repo>` | no picks; lift a repo's cap and freeze |
| `towercab review` | walk parked and stale intents |
| `towercab protect <repo>` | the `towercab` ruleset on a repo's base branch (your `gh` login) |
| `towercab eval [--reason <change>]` · `eval --pr <n>` | replay the eval cases; post `towercab/evals` on a Towercab PR |

Telegram (from the configured chat): `status`, `next`, `approve <id>`, `retry <id>`, `release <id>`,
`pause`, `resume`. Messages come only when you must act.

## Metrics (Grafana)

```bash
docker compose -f ops/docker-compose.yml up -d   # Grafana on http://localhost:3000
towercab telemetry on                            # your Claude Code sessions export to it
```

The loop sends its own metrics and events (`service.name=towercab-loop`, [specs/metrics.md](specs/metrics.md)) to
`[metrics].endpoint`; while that is down they wait in `<home>/metrics.jsonl`.

## CI

`.github/workflows/ci.yml` on every PR and push to `main`: job `rust` (`cargo fmt --check`, `cargo clippy
--all-targets --locked -- -D warnings`, `cargo test --locked`).
The Python version of Towercab lives on branch `python`.

## Status

Early, and built for a single user: one person's machine, one intents repo. Expect rough edges and changes to
the specs. It is not tested on other setups, so run `towercab doctor` first and read the specs before you
give it `a4` or `a5`, which merge without you.

## Docs

Everything Towercab does is a requirement row in `specs/`:

- [specs/README.md](specs/README.md): how specs are written and the index
- [specs/priority.md](specs/priority.md): scores, order, cutoff, review
- [specs/autonomy.md](specs/autonomy.md): where an intent waits for the owner
- [specs/maintain.md](specs/maintain.md): bands on Towercab's own metrics, diagnosis, lessons
- [specs/intents.md](specs/intents.md): intent files, routes in, acceptance, lifecycle
- [specs/metrics.md](specs/metrics.md): indicators, OTLP metrics and events, Grafana dashboard
- [specs/ui.md](specs/ui.md): the local web page
- [specs/pipeline.md](specs/pipeline.md): design to revert, one stage per row
- [specs/public.md](specs/public.md): what a public repo shows
- [specs/loop.md](specs/loop.md): the runner, state machine, limits, Telegram, commands
- [specs/repo.md](specs/repo.md): `CLAUDE.md`, `REVIEW.md`, `TOWERCAB.md`, protected paths

Working on Towercab itself: [CLAUDE.md](CLAUDE.md). Licensed under MIT ([LICENSE](LICENSE));
security reports: [SECURITY.md](SECURITY.md).
