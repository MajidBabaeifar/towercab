//! UI-1..11: the local web page, its HTTP, its checks and its actions.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use towercab::config::{Config, IntentsConfig};
use towercab::db::Db;
use towercab::exes::Exes;
use towercab::home::Home;
use towercab::mission::{self, NewMission};
use towercab::runloop::Tick;
use towercab::ui::{self, Ctx};

/// A home with one mission waiting for spec approval, an intent for it, a run file.
fn world(tmp: &Path) -> (Config, Home, i64) {
    let intents = tmp.join("intents");
    let dir = intents.join("intents/261025-0901-login");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("intent.md"),
        "---\nrepo: web\nu: 3\ni: 4\n---\n\n# Intent: Log in with <b>email</b>\n",
    )
    .unwrap();
    let mut config = Config::new(
        tmp.join("config.toml"),
        IntentsConfig {
            remote: None,
            path: intents,
            cutoff: 7,
        },
    );
    config.ui.port = 0;
    let home = Home::resolve(Some(&tmp.join("home"))).unwrap();
    let db = Db::open(&home.db()).unwrap();
    let m = mission::insert(
        db.conn(),
        &NewMission {
            intent: "261025-0901".into(),
            slug: "login".into(),
            repo: "web".into(),
            model: "opus".into(),
            a: None,
            min_attempt: 1,
        },
        Tick::now(),
    )
    .unwrap();
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'approval:spec', from_stage = 'design', \
             waiting = 'approve spec', why = 'concern: <script>', \
             pr_url = 'https://github.com/me/web/pull/7' WHERE id = ?1",
            [m.id],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why) \
             VALUES (?1, 1, 'design', 'wait', 'approval:spec', 'a concern')",
            [m.id],
        )
        .unwrap();
    let runs = home.runs(&m.label());
    std::fs::create_dir_all(&runs).unwrap();
    std::fs::write(
        runs.join("build.txt"),
        "built it; token ghp_abcdefghijklmnopqrstuvwx",
    )
    .unwrap();
    std::fs::write(tmp.join("secret.txt"), "secret").unwrap();
    std::os::unix::fs::symlink(tmp.join("secret.txt"), runs.join("link.txt")).unwrap();
    (config, home, m.id)
}

fn exes(tmp: &Path) -> Exes {
    // A journalctl that prints two lines, one an error.
    let bin = tmp.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let j = bin.join("journalctl");
    std::fs::write(
        &j,
        "#!/bin/sh\necho 'Oct 25 towercab: started'\necho 'Oct 25 towercab: 0901: push failed'\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&j, std::fs::Permissions::from_mode(0o755)).unwrap();
    Exes {
        journalctl: j.into_os_string(),
        ..Exes::default()
    }
}

struct Got {
    status: u16,
    head: String,
    body: String,
}

fn http(port: u16, raw: &str) -> Got {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    let (head, body) = out.split_once("\r\n\r\n").unwrap_or((&out, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    Got {
        status,
        head: head.to_string(),
        body: body.to_string(),
    }
}

fn get(port: u16, path: &str) -> Got {
    http(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    )
}

fn post(port: u16, origin: &str, token: &str, body: &str) -> Got {
    http(
        port,
        &format!(
            "POST /api/cmd HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\n\
             X-Towercab-Token: {token}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    )
}

fn start(config: Config, home: Home, exes: Exes) -> (Arc<Ctx>, ui::wire::Server) {
    let mut ctx = Ctx::new(config, home, exes, true);
    ctx.reply_wait = Duration::from_millis(100);
    let ctx = Arc::new(ctx);
    let server = ui::serve(ctx.clone(), 0).unwrap();
    (ctx, server)
}

#[test]
fn test_ui_config() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("config.toml");
    std::fs::write(&file, "[intents]\npath = \"/x\"\n").unwrap();
    assert_eq!(Config::load(Some(&file)).unwrap().ui.port, 7311);
    std::fs::write(&file, "[intents]\npath = \"/x\"\n\n[ui]\nport = 0\n").unwrap();
    assert_eq!(Config::load(Some(&file)).unwrap().ui.port, 0);
    std::fs::write(&file, "[intents]\npath = \"/x\"\n\n[ui]\nport = 70000\n").unwrap();
    assert!(Config::load(Some(&file)).unwrap_err().contains("ui.port"));
}

#[test]
fn test_ui_binds_localhost_only() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, _) = world(tmp.path());
    let (_ctx, server) = start(config, home, exes(tmp.path()));
    let port = server.port;
    assert!(ui::answers(port));
    let ping = get(port, "/api/ping");
    assert_eq!(ping.status, 200);
    assert!(ping.body.starts_with("towercab "), "{}", ping.body);
    // Only 127.0.0.1: nothing listens on the other addresses.
    let other = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([0, 0, 0, 0], port)),
        Duration::from_millis(300),
    );
    let lan = local_ip().map(|ip| {
        std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::new(ip, port),
            Duration::from_millis(300),
        )
        .is_ok()
    });
    assert_ne!(lan, Some(true));
    let _ = other;
    server.stop();
    assert!(!ui::answers(port));
}

/// A non-loopback address of this machine, if it has one.
fn local_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

#[test]
fn test_http_limits() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, _) = world(tmp.path());
    let (_ctx, server) = start(config, home, exes(tmp.path()));
    let port = server.port;
    let big = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX: {}\r\n\r\n",
        "a".repeat(9000)
    );
    assert_eq!(http(port, &big).status, 431);
    let put = format!("PUT / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    assert_eq!(http(port, &put).status, 405);
    let chunked = format!(
        "POST /api/cmd HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nTransfer-Encoding: chunked\r\n\r\n"
    );
    assert_eq!(http(port, &chunked).status, 411);
    let huge =
        format!("POST /api/cmd HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 5000\r\n\r\n");
    assert_eq!(http(port, &huge).status, 413);
    let got = get(port, "/api/state");
    for h in [
        "Cache-Control: no-store",
        "X-Content-Type-Options: nosniff",
        "X-Frame-Options: DENY",
        "Referrer-Policy: no-referrer",
    ] {
        assert!(got.head.contains(h), "{h}: {}", got.head);
    }
    assert!(!got.head.contains("Access-Control"), "{}", got.head);
    server.stop();
}

#[test]
fn test_slow_client_doesnt_block() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, _) = world(tmp.path());
    let (_ctx, server) = start(config, home, exes(tmp.path()));
    let port = server.port;
    // A client that connects and says nothing holds one worker at most.
    let _slow = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let t = std::time::Instant::now();
    assert_eq!(get(port, "/api/ping").status, 200);
    assert!(t.elapsed() < Duration::from_secs(3));
    server.stop();
}

#[test]
fn test_host_origin_token_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, _) = world(tmp.path());
    let (ctx, server) = start(config, home, exes(tmp.path()));
    let port = server.port;
    let rebind = http(
        port,
        &format!("GET / HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n"),
    );
    assert_eq!(rebind.status, 421);
    let me = format!("http://127.0.0.1:{port}");
    let body = r#"{"cmd":"pause"}"#;
    assert_eq!(
        post(port, "http://evil.example", &ctx.token, body).status,
        403
    );
    assert_eq!(post(port, &me, "nope", body).status, 403);
    // Right Origin and token, but no loop holds the home.
    let no_loop = post(port, &me, &ctx.token, body);
    assert_eq!(no_loop.status, 409);
    assert!(no_loop.body.contains("towercab up"), "{}", no_loop.body);
    server.stop();
}

#[test]
fn test_actions_queue_commands() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, _) = world(tmp.path());
    let lock = home.lock().unwrap();
    let (ctx, server) = start(config, home.clone(), exes(tmp.path()));
    let port = server.port;
    let me = format!("http://127.0.0.1:{port}");
    let ok = post(
        port,
        &me,
        &ctx.token,
        r#"{"cmd":"approve","arg":"261025-0901"}"#,
    );
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert!(ok.body.contains("\"result\":null"), "{}", ok.body);
    for bad in [
        r#"{"cmd":"approve","arg":"../x"}"#,
        r#"{"cmd":"approve"}"#,
        r#"{"cmd":"pause","arg":"x"}"#,
        r#"{"cmd":"drop","arg":"261025-0901"}"#,
        "not json",
    ] {
        assert_eq!(post(port, &me, &ctx.token, bad).status, 400, "{bad}");
    }
    assert_eq!(
        post(port, &me, &ctx.token, r#"{"cmd":"pause"}"#).status,
        200
    );
    let db = Db::open(&home.db()).unwrap();
    let rows: Vec<(String, String, String)> = db
        .conn()
        .prepare("SELECT name, arg, source FROM commands ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            ("approve".into(), "261025-0901".into(), "ui".into()),
            ("pause".into(), String::new(), "ui".into()),
        ]
    );
    drop(lock);
    server.stop();
}

#[test]
fn test_state_json() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, id) = world(tmp.path());
    let ctx = Ctx::new(config, home, exes(tmp.path()), true);
    let s = ui::state(&ctx).unwrap();
    assert_eq!(s["running"], false);
    assert_eq!(s["actions"], false);
    assert_eq!(s["missions"][0]["id"], id);
    assert_eq!(s["missions"][0]["stage"], "approval:spec");
    assert_eq!(s["missions"][0]["title"], "Log in with <b>email</b>");
    assert_eq!(s["on_me"][0]["pr_url"], "https://github.com/me/web/pull/7");
    for k in ["top", "onme", "now", "next", "attention", "activity", "log"] {
        assert!(s["html"][k].is_string(), "{k}");
    }
    let onme = s["html"]["onme"].as_str().unwrap();
    // Escaped, and no buttons without a running loop.
    assert!(
        onme.contains("Log in with &lt;b&gt;email&lt;/b&gt;"),
        "{onme}"
    );
    assert!(onme.contains("concern: &lt;script&gt;"), "{onme}");
    assert!(!onme.contains("<button"), "{onme}");
}

#[test]
fn test_page_has_key_facts() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, _) = world(tmp.path());
    let lock = home.lock().unwrap();
    let (ctx, server) = start(config, home, exes(tmp.path()));
    let page = get(server.port, "/");
    assert_eq!(page.status, 200);
    for want in [
        "Waiting on you",
        "Now",
        "Next",
        "Attention",
        "Activity",
        "Log",
        "running",
        "approve spec",
        "data-cmd=\"approve\"",
        "data-cmd=\"retry_fresh\"",
        "approval:spec",
        &format!("content=\"{}\"", ctx.token),
    ] {
        assert!(page.body.contains(want), "{want}");
    }
    let csp = page
        .head
        .lines()
        .find(|l| l.starts_with("Content-Security-Policy:"))
        .unwrap();
    assert!(
        csp.contains("default-src 'none'") && csp.contains("'sha256-"),
        "{csp}"
    );
    assert!(!page.body.contains("<script src"), "no external scripts");
    drop(lock);
    server.stop();
}

#[test]
fn test_mission_page() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, id) = world(tmp.path());
    let (_ctx, server) = start(config, home, exes(tmp.path()));
    let page = get(server.port, &format!("/m/{id}"));
    assert_eq!(page.status, 200);
    for want in [
        "261025-0901",
        "approval:spec",
        "a concern",
        "build.txt",
        "pull/7",
    ] {
        assert!(page.body.contains(want), "{want}: {}", page.body);
    }
    assert!(!page.body.contains("link.txt"), "symlinks aren't listed");
    assert_eq!(get(server.port, "/m/999").status, 404);
    server.stop();
}

#[test]
fn test_run_files_path_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, id) = world(tmp.path());
    let (_ctx, server) = start(config, home, exes(tmp.path()));
    let port = server.port;
    let ok = get(port, &format!("/m/{id}/runs/build.txt"));
    assert_eq!(ok.status, 200);
    assert!(ok.body.contains("built it; token <token>"), "{}", ok.body);
    assert!(
        ok.head.contains("Content-Security-Policy: sandbox"),
        "{}",
        ok.head
    );
    for bad in [
        "link.txt",
        "..%2Fsecret.txt",
        "../secret.txt",
        ".hidden",
        "nope.txt",
    ] {
        assert_eq!(
            get(port, &format!("/m/{id}/runs/{bad}")).status,
            404,
            "{bad}"
        );
    }
    server.stop();
}

#[test]
fn test_log_and_redaction() {
    let tmp = tempfile::tempdir().unwrap();
    let (mut config, home, _) = world(tmp.path());
    config.telegram = Some(towercab::config::TelegramConfig {
        bot_token: "123456:SECRETbot".into(),
        chat_id: "1".into(),
        api_base: "http://127.0.0.1:1".into(),
    });
    let ctx = Ctx::new(config, home, exes(tmp.path()), true);
    let lines = ui::log_lines(&ctx);
    assert_eq!(lines.len(), 2);
    assert!(
        !lines[0].1 && lines[1].1,
        "the failed line is flagged: {lines:?}"
    );
    let text = "bot123456:SECRETbot ghp_abcdefghijklmnopqrstuvwx\n-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----";
    let r = ui::redact(&ctx, text);
    assert!(
        !r.contains("SECRET") && !r.contains("ghp_") && !r.contains("xyz"),
        "{r}"
    );
    assert!(r.contains("<private key>"), "{r}");
}

/// `UI_SAMPLE=<file>`: the page of the seeded home, script removed, for a look (no check).
#[test]
fn ui_sample_page() {
    let Some(out) = std::env::var_os("UI_SAMPLE") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let (config, home, _) = world(tmp.path());
    let lock = home.lock().unwrap();
    let (_ctx, server) = start(config, home, exes(tmp.path()));
    let page = get(server.port, "/").body;
    let page = match (page.find("<script>"), page.find("</script>")) {
        (Some(a), Some(b)) => format!("{}{}", &page[..a], &page[b + 9..]),
        _ => page,
    };
    std::fs::write(out, page).unwrap();
    drop(lock);
    server.stop();
}
