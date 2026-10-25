# UI

**Status:** Live: UI-1..11 · **Prefix:** UI

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

**State** (`/api/state`)

```
version, pid (the loop's | null), running, paused, env_blocked, actions (= running and not `towercab ui`'s own), now
on_me     [{intent, repo, title, action (message line 1), pr_url}]
missions  [{id, intent, repo, title, kind, stage, step, waiting, why, pr_url}]
next      the intent the picker would take | null;  skipped [{intent, reason}]
log       [{text, error}]
html      {top, onme, now, next, attention, activity, log}: each section rendered (escaped) in Rust
```

## Out of scope

- Access from another machine (Tailscale, a reverse proxy), logins, TLS.
- New powers: editing intents, config or the database other than through `commands`.

## Decisions

- The loop serves it (always there while `towercab up`); `towercab ui` covers a stopped loop with the same page, actions off.
- Hand-rolled HTTP over `tiny_http`: two methods, `Connection: close`, no chunked bodies: ~200 lines with no new crate, and the limits and checks above are needed either way.
- Rendered once, in Rust: `/api/state` carries each section's HTML; the script only swaps it in. One escaper, no second template in JS.
- Actions need a running loop: a row queued for a loop that isn't coming would apply days later, surprising.
- Polling, not push: 3 s is fast enough to watch, and stays within `Connection: close`.
