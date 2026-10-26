//! UI-12..18: links, the intents list and page, edits through the intent writer, the repos
//! panel, the tab count and the log's scroll.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use towercab::config::{Config, IntentsConfig, RepoConfig};
use towercab::db::Db;
use towercab::exes::Exes;
use towercab::github::Identity;
use towercab::home::Home;
use towercab::intents::edit::{self, Edit, IntentWriter};
use towercab::intents::{Intent, NewIntent};
use towercab::mission::{self, NewMission};
use towercab::runloop::Tick;
use towercab::ui::{self, Ctx};

const RUNNING: &str = "---\nrepo: web\nu: 4\ni: 4\na: 3\n---\n\n# Intent: Log in\n\n## Problem\nPeople <can't> log in.\n\n## Proposed outcome\n- Email login\n- Magic links\n";
const PARKED: &str = "---\nrepo: web\nu: 1\ni: 2\n---\n\n# Intent: Staging first\n";

/// Records edits instead of writing git.
#[derive(Default)]
struct Fake {
    edits: Mutex<Vec<(String, Edit)>>,
    added: Mutex<Vec<NewIntent>>,
}

impl IntentWriter for Fake {
    fn edit(&self, id: &str, e: &Edit) -> Result<String, String> {
        self.edits.lock().unwrap().push((id.into(), e.clone()));
        Ok(format!("{} {id}", e.what()))
    }
    fn add(&self, new: NewIntent) -> Result<String, String> {
        self.added.lock().unwrap().push(new);
        Ok("261025-2100".into())
    }
}

fn world(tmp: &Path) -> (Config, Home, i64) {
    let intents = tmp.join("intents");
    for (dir, text) in [
        ("intents/261025-0901-login", RUNNING),
        ("intents/261025-0902-staging", PARKED),
    ] {
        std::fs::create_dir_all(intents.join(dir)).unwrap();
        std::fs::write(intents.join(dir).join("intent.md"), text).unwrap();
    }
    std::fs::write(intents.join("intents/261025-0901-login/plan.md"), "plan").unwrap();
    let mut config = Config::new(
        tmp.join("config.toml"),
        IntentsConfig {
            remote: Some("https://github.com/me/intents.git".into()),
            path: intents,
            cutoff: 7,
        },
    );
    config.ui.port = 0;
    config.repos.insert(
        "web".into(),
        Ok(RepoConfig {
            name: "web".into(),
            github: "me/web".into(),
            path: tmp.join("clones/web"),
            base: "main".into(),
            workers: 1,
            bash: vec![],
        }),
    );
    let home = Home::resolve(Some(&tmp.join("home"))).unwrap();
    let db = Db::open(&home.db()).unwrap();
    let m = mission::insert(
        db.conn(),
        &NewMission {
            intent: "261025-0901".into(),
            slug: "login".into(),
            repo: "web".into(),
            model: "opus".into(),
            a: Some(3),
            min_attempt: 1,
        },
        Tick::now(),
    )
    .unwrap();
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'approval:spec', from_stage = 'design', waiting = 'approve spec' WHERE id = ?1",
            [m.id],
        )
        .unwrap();
    (config, home, m.id)
}

fn start(tmp: &Path) -> (Arc<Ctx>, Arc<Fake>, ui::wire::Server, Home, i64) {
    let (config, home, id) = world(tmp);
    let fake = Arc::new(Fake::default());
    let journal = tmp.join("journalctl");
    std::fs::write(&journal, "#!/bin/sh\necho line\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o755)).unwrap();
    let exes = Exes {
        journalctl: journal.into_os_string(),
        gh: tmp.join("no-gh").into_os_string(),
        ..Exes::default()
    };
    let ctx = Arc::new(Ctx::with_writer(
        config,
        home.clone(),
        exes,
        true,
        fake.clone(),
        Identity::none(),
    ));
    let server = ui::serve(ctx.clone(), 0).unwrap();
    (ctx, fake, server, home, id)
}

fn http(port: u16, raw: &str) -> (u16, String) {
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
    (status, body.to_string())
}

fn get(port: u16, path: &str) -> (u16, String) {
    http(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    )
}

fn post(port: u16, token: &str, body: &str) -> (u16, String) {
    http(
        port,
        &format!(
            "POST /api/intent HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
             X-Towercab-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    )
}

#[test]
fn test_intent_edits_apply() {
    let mut i = Intent::parse(RUNNING).unwrap();
    edit::apply(
        &mut i,
        &Edit::Scores {
            u: 2,
            i: 5,
            a: None,
        },
    )
    .unwrap();
    edit::apply(&mut i, &Edit::Model(Some("sonnet".into()))).unwrap();
    assert_eq!(
        (i.u(), i.i(), i.a(), i.model()),
        (Some(2), Some(5), None, Some("sonnet"))
    );
    let text = i.render();
    assert!(
        text.contains("## Problem\nPeople <can't> log in."),
        "other lines kept: {text}"
    );
    assert!(
        edit::apply(
            &mut i,
            &Edit::Scores {
                u: 0,
                i: 3,
                a: None
            }
        )
        .is_err()
    );
    assert!(edit::apply(&mut i, &Edit::Model(Some("gpt".into()))).is_err());
    edit::apply(&mut i, &Edit::Model(None)).unwrap();
    assert_eq!(i.model(), None);
    edit::apply(&mut i, &Edit::Drop).unwrap();
    assert_eq!(i.stage().map(|s| s.as_str()), Some("dropped"));
}

#[test]
fn test_links_and_intents_list() {
    let tmp = tempfile::tempdir().unwrap();
    let (_ctx, _fake, server, home, _) = start(tmp.path());
    // Read-only without a loop: no edit forms.
    let (code, page) = get(server.port, "/intents");
    assert_eq!(code, 200);
    assert!(
        page.contains("href=\"https://github.com/me/web\""),
        "repo link: {page}"
    );
    assert!(
        page.contains(
            "href=\"https://github.com/me/intents/blob/main/intents/261025-0901-login/intent.md\""
        ),
        "intent link"
    );
    assert!(page.contains("waiting on you: approve spec"), "{page}");
    assert!(page.contains("parked"), "{page}");
    assert!(
        !page.contains("data-op=\"save\""),
        "no edits without a loop"
    );
    // Pick order: p12 before p5.
    assert!(page.find("Log in").unwrap() < page.find("Staging first").unwrap());
    // With a loop: edit forms and the add form.
    let lock = home.lock().unwrap();
    let (_, page) = get(server.port, "/intents");
    assert!(
        page.contains("data-op=\"save\"") && page.contains("data-op=\"add\""),
        "{page}"
    );
    // The overview links too.
    let (_, page) = get(server.port, "/");
    assert!(
        page.contains("href=\"https://github.com/me/web\""),
        "{page}"
    );
    assert!(page.contains("href=\"/i/261025-0901\""), "{page}");
    drop(lock);
    server.stop();
}

#[test]
fn test_intent_page() {
    let tmp = tempfile::tempdir().unwrap();
    let (_ctx, _fake, server, _home, mid) = start(tmp.path());
    let (code, page) = get(server.port, "/i/261025-0901");
    assert_eq!(code, 200);
    for want in [
        "People &lt;can&#39;t&gt; log in.",
        "<li>Email login</li>",
        "plan.md",
        &format!("href=\"/m/{mid}\""),
        "approval:spec",
    ] {
        assert!(page.contains(want), "{want}: {page}");
    }
    assert_eq!(get(server.port, "/i/nope").0, 404);
    server.stop();
}

#[test]
fn test_intent_api() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, fake, server, home, _) = start(tmp.path());
    let port = server.port;
    let save = r#"{"op":"save","id":"261025-0902","u":"3","i":"3","a":"","model":"haiku"}"#;
    // No loop: refused, nothing written.
    assert_eq!(post(port, &ctx.token, save).0, 409);
    let lock = home.lock().unwrap();
    assert_eq!(post(port, "wrong", save).0, 403);
    let (code, body) = post(port, &ctx.token, save);
    assert_eq!(code, 200, "{body}");
    assert!(body.contains("\"ok\":true"), "{body}");
    for (bad, want) in [
        (r#"{"op":"save","id":"261025-0902","u":"9","i":"3"}"#, 400),
        (r#"{"op":"save","id":"../x","u":"3","i":"3"}"#, 400),
        (r#"{"op":"save","id":"261025-0999","u":"3","i":"3"}"#, 404),
        (
            r#"{"op":"save","id":"261025-0902","u":"3","i":"3","model":"gpt"}"#,
            400,
        ),
        (r#"{"op":"drop","id":"261025-0901"}"#, 409),
        (r#"{"op":"add","repo":"nowhere","title":"x"}"#, 400),
        (r#"{"op":"add","repo":"web","title":""}"#, 400),
        (r#"{"op":"nuke"}"#, 400),
    ] {
        assert_eq!(post(port, &ctx.token, bad).0, want, "{bad}");
    }
    assert_eq!(
        post(port, &ctx.token, r#"{"op":"drop","id":"261025-0902"}"#).0,
        200
    );
    let (code, body) = post(
        port,
        &ctx.token,
        r#"{"op":"add","repo":"web","title":"New thing","u":"2","i":"4"}"#,
    );
    assert_eq!(code, 200, "{body}");
    assert!(body.contains("added 261025-2100"), "{body}");
    assert_eq!(
        *fake.edits.lock().unwrap(),
        vec![
            (
                "261025-0902".to_string(),
                Edit::Scores {
                    u: 3,
                    i: 3,
                    a: None
                }
            ),
            ("261025-0902".to_string(), Edit::Model(Some("haiku".into()))),
            ("261025-0902".to_string(), Edit::Drop),
        ]
    );
    let added = fake.added.lock().unwrap();
    assert_eq!(
        (
            added[0].repo.as_str(),
            added[0].title.as_str(),
            added[0].u,
            added[0].i
        ),
        ("web", "New thing", Some(2), Some(4))
    );
    drop(lock);
    server.stop();
}

#[test]
fn test_repos_panel() {
    let tmp = tempfile::tempdir().unwrap();
    let (_ctx, _fake, server, _home, _) = start(tmp.path());
    let (code, page) = get(server.port, "/repos");
    assert_eq!(code, 200);
    assert!(
        page.contains("href=\"https://github.com/me/web\""),
        "{page}"
    );
    assert!(page.contains("no clone yet"), "{page}");
    assert!(page.contains("no GitHub App configured"), "{page}");
    server.stop();
}

#[test]
fn test_tab_count_and_log_scroll() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, _fake, server, _home, _) = start(tmp.path());
    let s = ui::state(&ctx).unwrap();
    assert_eq!(s["on_me_count"], 1);
    let (_, page) = get(server.port, "/");
    assert!(page.contains("document.title=(s.on_me_count?"), "tab count");
    assert!(
        page.contains("scrollTop=l.scrollHeight") && page.contains("atBottom("),
        "log sticks to the bottom"
    );
    assert!(
        page.contains("<nav>")
            && page.contains("href=\"/intents\"")
            && page.contains("href=\"/repos\"")
    );
    server.stop();
}

#[test]
fn test_recently_finished() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, _fake, server, home, _) = start(tmp.path());
    let s = ui::state(&ctx).unwrap();
    assert!(
        s["html"]["finished"]
            .as_str()
            .unwrap()
            .contains("Nothing has finished yet.")
    );
    let db = Db::open(&home.db()).unwrap();
    let m = mission::insert(
        db.conn(),
        &NewMission {
            intent: "261025-0902".into(),
            slug: "staging".into(),
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
            "UPDATE missions SET stage = 'done', merged_by = 'human', \
             pr_url = 'https://github.com/me/web/pull/9', finished = ?2 WHERE id = ?1",
            rusqlite::params![m.id, Tick::now().unix()],
        )
        .unwrap();
    let s = ui::state(&ctx).unwrap();
    let f = s["html"]["finished"].as_str().unwrap();
    for want in [
        "href=\"/i/261025-0902\"",
        "Staging first",
        "done</span> · merged by human",
        "pull/9",
        &format!("href=\"/m/{}\"", m.id),
    ] {
        assert!(f.contains(want), "{want}: {f}");
    }
    let (_, page) = get(server.port, "/");
    assert!(page.contains("Recently finished"), "{page}");
    server.stop();
}

/// Moves of a mission: (at, from, event, to, why).
fn moves(db: &Db, id: i64, rows: &[(f64, &str, &str, &str, &str)]) {
    for (at, from, event, to, why) in rows {
        db.conn()
            .execute(
                "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, at, from, event, to, why],
            )
            .unwrap();
    }
}

const T0: f64 = 1_700_000_000.0;
const PATH: [&str; 6] = ["pick", "design", "plan", "build", "publish", "ci"];

/// The login mission, at `ci` with a build PR, after the moves of `PATH`.
fn at_ci(db: &Db, home: &Home, id: i64, pr_url: &str) {
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'ci', from_stage = NULL, waiting = NULL, pr = 6, pr_url = ?2, \
             created = ?3 WHERE id = ?1",
            rusqlite::params![id, pr_url, T0],
        )
        .unwrap();
    let rows: Vec<_> = PATH
        .windows(2)
        .enumerate()
        .map(|(i, w)| {
            let why = if w[0] == "design" {
                "a <b>x</b> why"
            } else {
                ""
            };
            (T0 + 100.0 * (i as f64 + 1.0), w[0], "ok", w[1], why)
        })
        .collect();
    moves(db, id, &rows);
    let runs = home.runs("261025-0901");
    std::fs::create_dir_all(&runs).unwrap();
    for f in ["build.txt", "ci-1.log", "unrelated.txt"] {
        std::fs::write(runs.join(f), "x").unwrap();
    }
}

#[test]
fn test_strip_details() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, _fake, server, home, mid) = start(tmp.path());
    let db = Db::open(&home.db()).unwrap();
    at_ci(&db, &home, mid, "https://github.com/me/web/pull/6");
    let s = ui::state(&ctx).unwrap();
    let now = s["html"]["now"].as_str().unwrap().to_string();
    let (_, mpage) = get(server.port, &format!("/m/{mid}"));
    for (what, html) in [("overview", &now), ("mission page", &mpage)] {
        assert_eq!(html.matches("<details").count(), 16, "{what}: {html}");
        for want in [
            "data-stage=\"design\"",
            "data-stage=\"ci\" open",
            "<summary class=\"done\">design</summary>",
            "ended by <code>ok</code>",
            "a &lt;b&gt;x&lt;/b&gt; why",
            "took 1m",
            "pull/6",
            "not reached",
            &format!("href=\"/m/{mid}/runs/build.txt\""),
            &format!("href=\"/m/{mid}/runs/ci-1.log\""),
        ] {
            assert!(html.contains(want), "{what}: {want}: {html}");
        }
        assert!(!html.contains("data-stage=\"build\" open"), "{what}");
        // The mission page's own Run files list shows every file; the strip only a stage's.
        let strip = html.split("<h2>Moves").next().unwrap();
        assert!(!strip.contains("runs/unrelated.txt"), "{what}");
        assert!(!html.contains("onmouseover"), "{what}");
    }
    // A merged mission keeps its PR on the stages it passed.
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'done', finished = ?2, merge_sha = 'abc' WHERE id = ?1",
            rusqlite::params![mid, T0 + 900.0],
        )
        .unwrap();
    moves(
        &db,
        mid,
        &[
            (T0 + 700.0, "ci", "ok", "merge", ""),
            (T0 + 800.0, "merge", "ok", "done", ""),
        ],
    );
    let (_, mpage) = get(server.port, &format!("/m/{mid}"));
    assert!(mpage.contains("· merged "), "{mpage}");
    // Only http(s) PR links.
    db.conn()
        .execute(
            "UPDATE missions SET pr_url = 'javascript:alert(1)' WHERE id = ?1",
            [mid],
        )
        .unwrap();
    let (_, mpage) = get(server.port, &format!("/m/{mid}"));
    assert!(!mpage.contains("javascript:"), "{mpage}");
    // No external script.
    let (_, page) = get(server.port, "/");
    assert!(!page.contains("<script src"));
    server.stop();
}

#[test]
fn test_strip_survives_poll() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, _fake, server, home, mid) = start(tmp.path());
    let db = Db::open(&home.db()).unwrap();
    at_ci(&db, &home, mid, "https://github.com/me/web/pull/6");
    // The section is the same on each poll, and the page script puts back what I opened.
    let a = ui::state(&ctx).unwrap()["html"]["now"].clone();
    let b = ui::state(&ctx).unwrap()["html"]["now"].clone();
    assert_eq!(a, b);
    let (_, page) = get(server.port, "/");
    for want in [
        "summary",
        "dataset.stage",
        "const OPEN={}",
        "function keepOpen(",
        "keepOpen(e)",
    ] {
        assert!(page.contains(want), "{want}");
    }
    server.stop();
}

#[test]
fn test_attempts_on_strip() {
    let tmp = tempfile::tempdir().unwrap();
    let (_ctx, _fake, server, home, old) = start(tmp.path());
    let db = Db::open(&home.db()).unwrap();
    moves(
        &db,
        old,
        &[(T0, "design", "stop", "stopped", "why-of-attempt-one")],
    );
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'stopped', finished = ?2 WHERE id = ?1",
            rusqlite::params![old, T0],
        )
        .unwrap();
    let new = mission::insert(
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
    assert_eq!(new.attempt, 2);
    let (_, p_new) = get(server.port, &format!("/m/{}", new.id));
    assert!(
        p_new.contains(&format!("href=\"/m/{old}\">attempt 1")),
        "{p_new}"
    );
    assert!(p_new.contains("<b>attempt 2</b>"), "{p_new}");
    assert!(!p_new.contains("why-of-attempt-one"), "its own moves only");
    let (_, p_old) = get(server.port, &format!("/m/{old}"));
    assert!(
        p_old.contains(&format!("href=\"/m/{}\">attempt 2", new.id)),
        "{p_old}"
    );
    assert!(p_old.contains("<b>attempt 1</b>"), "{p_old}");
    assert!(p_old.contains("why-of-attempt-one"), "{p_old}");
    assert!(p_old.matches("<details").count() >= 16);
    server.stop();
}

#[test]
fn test_intent_prs() {
    let tmp = tempfile::tempdir().unwrap();
    let (_ctx, _fake, server, home, a1) = start(tmp.path());
    let db = Db::open(&home.db()).unwrap();
    let spec = r#"{"spec_pr": {"pr": 5, "url": "https://github.com/me/web/pull/5", "merged_at": 1700000250.0}}"#;
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'stopped', finished = 1, data = ?2 WHERE id = ?1",
            rusqlite::params![a1, spec],
        )
        .unwrap();
    let add = |set: &str| -> i64 {
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
            .execute(&format!("UPDATE missions SET {set} WHERE id = ?1"), [m.id])
            .unwrap();
        m.id
    };
    let a2 = add(
        "stage = 'done', finished = 2, pr_url = 'https://github.com/me/web/pull/6', merge_sha = 'abc'",
    );
    moves(&db, a2, &[(T0 + 800.0, "merge", "ok", "deploy", "")]);
    add(
        "kind = 'revert', stage = 'revert_ci', data = '{\"revert\": {\"pr\": 9, \"url\": \"https://github.com/me/web/pull/9\"}}'",
    );
    let (code, page) = get(server.port, "/i/261025-0901");
    assert_eq!(code, 200);
    let pos = |s: &str| page.find(s).unwrap_or_else(|| panic!("{s}: {page}"));
    assert!(page.contains("Pull requests"));
    let (p5, p6, p9) = (pos("pull/5\""), pos("pull/6\""), pos("pull/9\""));
    assert!(p5 < p6 && p6 < p9, "by attempt");
    let table = &page[page.find("Pull requests").unwrap()..];
    for want in [
        "<td>design</td>",
        "<td>publish</td>",
        "<td>revert</td>",
        "<td>merged</td>",
        "<td>open</td>",
    ] {
        assert!(table.contains(want), "{want}: {table}");
    }
    let shown = towercab::runloop::shown_time(T0 + 800.0, chrono::Local::now().fixed_offset());
    assert!(table.contains(&shown), "merge time {shown}: {table}");
    server.stop();
}

#[test]
fn test_wait_inputs_and_context() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, _fake, server, home, mid) = start(tmp.path());
    let lock = home.lock().unwrap();
    let port = server.port;
    // approve spec, no PR: said so; the inputs.
    let (_, page) = get(port, "/");
    for want in [
        "No spec change, so no PR",
        "data-cmd=\"answer\"",
        "id=\"ans-261025-0901\"",
        "data-cmd=\"unlock\"",
        "data-cmd=\"allow\"",
        "data-cmd=\"drop\"",
        "data-cmd=\"approve\"",
    ] {
        assert!(page.contains(want), "{want}: {page}");
    }
    // approve plan: plan.md shown next to the button; blocked paths prefill the unlock field.
    let db = Db::open(&home.db()).unwrap();
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'blocked', waiting = 'approve plan', why = 'a3', \
             checkout = 'work/261025-0901-1' WHERE id = ?1",
            [mid],
        )
        .unwrap();
    let runs = home.runs("261025-0901");
    std::fs::create_dir_all(&runs).unwrap();
    std::fs::write(
        runs.join("guard-blocks.jsonl"),
        format!(
            "{{\"path\":\"{}/work/261025-0901-1/.github/workflows/ci.yml\",\"kind\":\"protected\"}}\n",
            home.root.display()
        ),
    )
    .unwrap();
    let (_, page) = get(port, "/");
    assert!(page.contains("<summary>plan.md</summary>"), "{page}");
    assert!(
        page.contains("value=\".github/workflows/ci.yml\""),
        "{page}"
    );
    // The same on the mission and intent pages.
    for path in [format!("/m/{mid}"), "/i/261025-0901".to_string()] {
        let (_, p) = get(port, &path);
        assert!(
            p.contains("waiting on you: approve plan") && p.contains("data-cmd=\"answer\""),
            "{path}: {p}"
        );
    }
    // The inputs post as commands.
    let send = |body: &str| {
        http(
            port,
            &format!(
                "POST /api/cmd HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n\
                 X-Towercab-Token: {}\r\nContent-Length: {}\r\n\r\n{body}",
                ctx.token,
                body.len()
            ),
        )
        .0
    };
    assert_eq!(
        send(r#"{"cmd":"answer","arg":"261025-0901","text":"Use GitHub."}"#),
        200
    );
    assert_eq!(
        send(r#"{"cmd":"unlock","arg":"261025-0901","text":".github/workflows/** CLAUDE.md"}"#),
        200
    );
    assert_eq!(
        send(r#"{"cmd":"allow","arg":"261025-0901","text":"registry.npmjs.org"}"#),
        200
    );
    assert_eq!(send(r#"{"cmd":"drop","arg":"261025-0902"}"#), 200);
    assert_eq!(
        send(r#"{"cmd":"allow","arg":"261025-0901","text":"https://evil.example/x"}"#),
        400
    );
    assert_eq!(
        send(r#"{"cmd":"answer","arg":"261025-0901","text":"  "}"#),
        400
    );
    assert_eq!(
        send(r#"{"cmd":"unlock","arg":"261025-0901","text":"../secrets"}"#),
        400
    );
    let rows: Vec<(String, String, String)> = db
        .conn()
        .prepare("SELECT name, arg, text FROM commands ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            ("answer".into(), "261025-0901".into(), "Use GitHub.".into()),
            (
                "unlock".into(),
                "261025-0901".into(),
                ".github/workflows/**\nCLAUDE.md".into()
            ),
            (
                "allow".into(),
                "261025-0901".into(),
                "registry.npmjs.org".into()
            ),
            ("drop".into(), "261025-0902".into(), String::new()),
        ]
    );
    drop(lock);
    server.stop();
}
