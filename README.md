# Towercab

Majid's software factory. Intents live in one repo ([gradient-tasks](https://github.com/MajidBabaeifar/gradient-tasks));
the `towercab` loop picks the top one, has Claude Code design, plan and build it, checks it in code
(sandboxed checks, red→green proof, CI, review), opens the PR, merges when its autonomy allows, then
deploys, runs e2e and reverts on red. What it does exactly: [specs/](specs/README.md). Working here: [CLAUDE.md](CLAUDE.md).

## Install

```bash
cargo install --path . --locked   # → ~/.cargo/bin/towercab
./install.sh                      # the /intent skill into ~/.claude/skills
towercab doctor                   # config, programs, GitHub App, rulesets, Telegram
```

Needs `git`, `gh`, `claude`, `bwrap` and, for `up`, systemd.

## Config

`~/.config/towercab/config.toml` (`--config`, `TOWERCAB_CONFIG`; every key: [loop.md](specs/loop.md) **Config**):

```toml
[intents]
remote = "https://github.com/MajidBabaeifar/gradient-tasks.git"
cutoff = 7

[agent]
model = "opus"        # parallel, timeouts, budget, ci_poll … have defaults

[github]
app_id = 123456       # the towercab GitHub App (ops/github-app.json); key: app.pem next to this file
me = "MajidBabaeifar"

[repos.towercab]
github = "MajidBabaeifar/towercab"
path = "~/.local/share/towercab/repos/towercab"   # Towercab's own clone, not your checkout
base = "main"

[policies]
github = "MajidBabaeifar/agent-instructions"

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
| `towercab ui` | the web page: http://127.0.0.1:7311/ while `up` (`[ui] port`, 0 = off) |
| `towercab add "<repo>: <title>" [uN iN aN]` | a thin intent on `main` (or `/intent` in Claude Code) |
| `towercab approve <id>` · `retry --fresh <id>` · `release <id>` | go on after a wait, start over, authorize a release |
| `towercab pause` · `resume` · `trust <repo>` | no picks; lift a repo's cap and freeze |
| `towercab review` | walk parked and stale intents |
| `towercab protect <repo>` | the `towercab` ruleset on a repo's base branch (your `gh` login) |
| `towercab eval [--reason <change>]` · `eval --pr <n>` | replay the eval cases; post `towercab/evals` on a Towercab PR |

Telegram (from the configured chat): `status`, `next`, `approve <id>`, `retry <id>`, `release <id>`,
`pause`, `resume`. Messages come only when you must act.

First start: `towercab migrate` on the `intents` repo, `towercab protect <repo>` per repo, `towercab up`.

## Metrics (Grafana)

```bash
docker compose -f ops/docker-compose.yml up -d   # Grafana on http://localhost:3000
towercab telemetry on                            # your Claude Code sessions export to it
```

The loop sends its own metrics and events (`service.name=towercab-loop`, `specs/metrics.md`) to
`[metrics].endpoint`; while that is down they wait in `<home>/metrics.jsonl`.

## CI

`.github/workflows/ci.yml` on every PR and push to `main`: job `rust` (`cargo fmt --check`, `cargo clippy
--all-targets --locked -- -D warnings`, `cargo test --locked`).
The Python version of Towercab lives on branch `python`.
