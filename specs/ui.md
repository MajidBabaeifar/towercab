# UI

**Status:** Live: UI-1..18 · **Prefix:** UI

## Purpose

A local web page that shows what Towercab is doing right now and lets me act on it:
the same facts as `status`, `next` and the logs, and the same commands as the CLI.

## Requirements

| ID | Requirement | Verified by |
|---|---|---|
| UI-1 | **Served by the loop:** `run --watch` (the service, [LOOP-2](loop.md)) starts `ui::Running::start` (→ `ui::serve`) on its own threads at `127.0.0.1:<[ui] port>` (`Config.ui: UiConfig { port }`, int 0–65535, default 7311; 0 = off); never another address. A bind failure is logged `towercab: ui: <error>` and the loop goes on; when `run` returns, dropping `Running` stops and joins it. The loop thread never waits on the UI. | test_ui_config, test_ui_binds_localhost_only, test_loop_serves_ui |
| UI-2 | **`towercab ui [--no-open]`:** port 0 → exit 1 `ui is off: [ui] port = 0`. A Towercab UI answers on the port (`GET /api/ping` → `towercab <version>`, 2 s) → prints `http://127.0.0.1:<port>/` and opens it (`Exes::xdg_open`, failure ignored), exit 0. Else it serves in the foreground (prints the URL, opens it) until SIGTERM/SIGINT, exit 0; the port taken by something else → exit 1 `ui: 127.0.0.1:<port>: <error>`. | test_ui_command |
| UI-3 | **HTTP** (`src/ui/wire.rs`): std `TcpListener`, HTTP/1.1, `GET` and `POST` only (else 405), `Connection: close`; request line + headers ≤ 8 KiB (431), body only by `Content-Length` ≤ 4 KiB (413; `Transfer-Encoding` → 411); 5 s per read and write, 10 s per request (`ServeOpts.timeout`); 4 workers fed by a queue of 16 (full → the connection is dropped); a panic → 500; stop shuts live connections down and joins every thread. | test_http_limits, test_slow_client_doesnt_block |
| UI-4 | **Security:** `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (else 421: DNS rebinding). `POST` also needs `Origin` = `http://<Host>` (403) and `X-Towercab-Token` = the per-process token (32 random bytes, hex; in the page's `<meta name="towercab-token">`; compared in constant time; 403). No CORS headers. Every response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, CSP `default-src 'none'` (+ the page's inline style and script by `sha256-` hash, `connect-src 'self'`). Text shown is HTML-escaped; links only `http(s)://`. | test_host_origin_token_checked |
| UI-5 | **No secrets:** nothing from `[telegram]`, `app.pem`, `secrets/` or tokens is rendered; every log or file text passes `ui::redact` (the bot token and `/bot<token>` → `<token>`, `gh[pousr]_…`/`github_pat_…` → `<token>`, a PEM private key → `<private key>`, each `[repos]` e2e secret value → `[redacted]` as [PIP-9](pipeline.md)). | test_log_and_redaction |
| UI-6 | **Actions** = the CLI's commands, nothing more: `POST /api/cmd` `{cmd: approve\|retry_fresh\|release\|pause\|resume\|trust, arg}` (`arg` `[A-Za-z0-9._-]{1,64}` for approve, retry_fresh, release, trust; none for pause, resume; else 400) → a `commands` row, source `ui` (`commands::queue`), applied by the loop ([LOOP-15](loop.md)); the reply = its `result` within 6 s (`Ctx.reply_wait`), else `null` (`{id, result}`; the page then shows it from `commands` in the state). No loop holds the home (`Home::holder`) → 409 `towercab isn't running: towercab up`, no row. | test_actions_queue_commands |
| UI-7 | **State** `GET /api/state` (`ui::state`, **State**) from SQLite (own connection per worker; WAL) and the intents checkout (`intents::store::scan`, never a pull or write), plus `html`: each section rendered. | test_state_json |
| UI-8 | **Page** `GET /` (`ui::page`): server-rendered, no external resources, readable in light and dark (`prefers-color-scheme`), usable at 360 px. Sections in order: top bar, Waiting on you (with buttons), Now (children, every unfinished mission on its sequence's strip, waits), Next, Attention (cooling models, faults, caps and freezes, failed drafts, dismissed alerts, review due, an unreadable intents checkout), Activity (the last 50 transitions, the last 10 messages: sent, pending or dropped), Log. Pause/Resume in the top bar. One inline script polls `/api/state` every 3 s and swaps each section's `html`; buttons POST `/api/cmd` (retry and release confirm first). | test_page_has_key_facts |
| UI-9 | **Mission** `GET /m/<mission id>` : label, repo, kind, stage, attempt, waiting/why, PR link, cost and agent time, every transition, and its run files (`runs/<label>/`, regular files only, name, size, time; newest first). | test_mission_page |
| UI-10 | **Run files** `GET /m/<id>/runs/<name>`: `name` `[A-Za-z0-9._-]+`, not starting with `.`, not `*.raw`; a regular file directly in the mission's runs dir (no symlink: `symlink_metadata`, canonical parent = the runs dir); text (no NUL); the last 512 KiB, redacted; `text/plain; charset=utf-8`, CSP `sandbox`. Else 404. | test_run_files_path_checked |
| UI-11 | **Log:** the last 200 lines of `journalctl --user -u towercab -n 200 -o short-iso --no-pager` (`Exes::journalctl`, `child::output`, 5 s; cached 10 s), redacted; lines matching `error\|failed\|panic\|unexpected` (any case) flagged. None or a failure → one line saying so. | test_log_and_redaction |
| UI-12 | **Links:** a `[repos]` repo's name links to `https://github.com/<github>`; an intent's ID to its `intent.md` on the `intents` remote's `main` (`https://github.com/<owner>/<repo>/blob/main/<dir>/intent.md`; only for a `https://github.com/` remote); its title to `/i/<id>`. Every page has the nav: Overview, Intents, Repos, Grafana (`http://localhost:3000`). | test_links_and_intents_list |
| UI-13 | **Intents** `GET /intents`: every open intent in PRI-4 order (id, repo, title, p, u i a · model, state: `running: <stage>`, `waiting on you: <waiting>`, `waiting: <waiting>`, `parked`, `queued`), then up to 100 done ones (stage, PR, finished day); unreadable intent files listed with their reason. | test_links_and_intents_list |
| UI-14 | **Edits** `POST /api/intent` (Origin, token and a running loop as UI-4/UI-6): `{op: save, id, u, i, a, model}` (u, i 1–5; a 1–5 or empty = none; model `opus\|sonnet\|haiku` or empty = default), `{op: drop, id}` (refused with a running mission: 409), `{op: add, repo (in [repos]), title (1–200 chars), u, i, a}` → `{ok, reply}`. Every edit goes through `intents::edit::IntentWriter` (`edit(id, &Edit)`, `add(NewIntent)`); today `GitWriter` (`Store::update`/`add` as the App: pull, line-level `Intent::set`/`remove`, commit `towercab: rescore\|model\|drop <id>`, push), so a database store can replace it (intent 261025-1900). `edit::apply(&mut Intent, &Edit)` is pure. | test_intent_edits_apply, test_intent_api |
| UI-15 | **Intent page** `GET /i/<id>` (open or done): title, links (file, repo, PR, `plan.md` when it exists), p and u/i/a/model, `waiting`, the edit form (open ones, with a loop), the Problem, Proposed outcome, Affected, Constraints, Open questions and Towercab sections (escaped; `- ` lines as a list), and every attempt (mission, attempt, stage, cost, updated). | test_intent_page |
| UI-16 | **Repos** `GET /repos`: per `[repos]` repo: GitHub link, base, clone present, `CLAUDE.md` checks (`repo::load` on its clone: `ok: <n> check line(s)` or the error), GitHub App installed (`Identity::token`), `towercab` ruleset (`find_ruleset`, my `gh`), cap or freeze (with `trust <repo>`). The GitHub checks are kept 5 min; `?fresh` reads again. | test_repos_panel |
| UI-17 | **Cost and limits:** the top bar shows `spend today $x · 7 d $y` (Prometheus at `[metrics].prometheus`: `sum(sum_over_time(towercab_cost_usd…[1d|7d]))`, 2 s, kept 60 s; left out when it doesn't answer); a cooling model shows `cooling until <time> (usage limit, in <left>)`. | test_tab_count_and_log_scroll |
| UI-18 | **Tab and log:** the tab title is `(<n>) <page>` while n things wait on me (`on_me_count` in the state); the log shows the newest lines at the bottom and stays there on each poll unless I've scrolled up. | test_tab_count_and_log_scroll |

**State** (`/api/state`)

```
version, pid (the loop's | null), running, paused, env_blocked, actions (= running and not `towercab ui`'s own), on_me_count, now
on_me     [{intent, repo, title, action (message line 1), pr_url}]
missions  [{id, intent, repo, title, kind, stage, step, waiting, why, pr_url}]
next      the intent the picker would take | null;  skipped [{intent, reason}]
log       [{text, error}]
html      {top, onme, now, next, attention, activity, log}: each section rendered (escaped) in Rust
```

## Out of scope

- Access from another machine (Tailscale, a reverse proxy), logins, TLS.
- New powers beyond `commands` and the intent edits of UI-14: editing config or the database directly.
- Playbook indicators: the Grafana dashboard has them (metrics.md); the UI links to it.

## Decisions

- The loop serves it (always there while `towercab up`); `towercab ui` covers a stopped loop with the same page, actions off.
- Hand-rolled HTTP over `tiny_http`: two methods, `Connection: close`, no chunked bodies: ~200 lines with no new crate, and the limits and checks above are needed either way.
- Rendered once, in Rust: `/api/state` carries each section's HTML; the script only swaps it in. One escaper, no second template in JS.
- Actions need a running loop: a row queued for a loop that isn't coming would apply days later, surprising.
- Polling, not push: 3 s is fast enough to watch, and stays within `Connection: close`.
