//! Telegram (LOOP-16): the outbox sent oldest first with retries, survived restarts, my chat
//! only, failures that never raise; its commands (LOOP-15).

mod common;

use std::time::Duration;

use common::http::{CHAT, FakeTelegram, TOKEN, dead_url};
use common::world::{Act, Scripted, World, intent_file};
use common::{loop_config, output, towercab};
use rusqlite::params;
use towercab::commands::{Cmd, PAUSED, RESUMED};
use towercab::config::TelegramConfig;
use towercab::db::{Db, OutboxRow};
use towercab::handler::Handlers;
use towercab::machine::{Stage, Waiting};
use towercab::outbox::{self, Notice};
use towercab::telegram::{self, HELP, Telegram, TgCommand};

/// Every driven stage polls once a day: missions stay where events put them.
fn idle() -> Handlers {
    let mut h = Handlers::stubs();
    for s in Stage::ALL.into_iter().filter(|s| s.driven()) {
        h.set(s, Scripted::all(Act::Poll(Duration::from_secs(86_400))));
    }
    h
}

/// The design waits for my approval; every other stage is a stub.
fn spec_waits() -> Handlers {
    let mut h = Handlers::stubs();
    h.set(
        Stage::Design,
        Scripted::all(Act::Wait(Waiting::ApproveSpec)),
    );
    h
}

fn rows(db: &Db) -> Vec<OutboxRow> {
    let mut q = db
        .conn()
        .prepare("SELECT * FROM outbox ORDER BY created, rowid")
        .unwrap();
    q.query_map([], OutboxRow::from_row)
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// A mission row for `intent` in `repo` at `stage`, waiting with `waiting`.
fn mission(db: &Db, intent: &str, repo: &str, stage: Stage, waiting: Option<&str>) -> i64 {
    db.conn()
        .execute(
            "INSERT INTO missions (kind, intent, repo, stage, step, model, session, checkout,
               branch, waiting, from_stage, created, updated)
             VALUES ('intent', ?1, ?2, ?3, '', 'opus', 's', ?4, 'b', ?5, 'ci', 0, 0)",
            params![
                intent,
                repo,
                stage.as_str(),
                format!("work/{intent}-1"),
                waiting
            ],
        )
        .unwrap();
    db.conn().last_insert_rowid()
}

#[test]
fn test_outbox_retries_until_sent() {
    let tg = FakeTelegram::start();
    let mut w = World::new(
        &[intent_file("261001-0900-spec", "web", "", "Spec it")],
        &["web"],
    );
    w.config.telegram = Some(tg.config());
    tg.fail_sends(3);
    let mut lp = w.open(spec_waits());
    w.until(&mut lp, 10, |w| {
        w.stage("261001-0900") == Some(Stage::ApprovalSpec)
    });
    let db = w.db();
    // The pass that wrote it tried once: 500 → retried after 30 s.
    let at = w.clock.unix();
    let r = &rows(&db)[0];
    assert_eq!(
        (r.event.as_str(), r.tries, r.sent_at),
        ("approve_spec", 1, None)
    );
    assert_eq!(r.next_try, at + 30.0);
    // A later row waits behind it: oldest first.
    outbox::notify(db.conn(), &Notice::Reply("later".into()), "1", at).unwrap();

    w.pass(&mut lp); // +61 s: 2nd try fails → +60 s
    w.pass(&mut lp); // 3rd fails → +120 s
    let r = &rows(&db)[0];
    assert_eq!((r.tries, r.sent_at), (3, None));
    assert_eq!(r.next_try, w.clock.unix() + 120.0);
    assert_eq!(tg.calls("sendMessage").len(), 3);
    w.pass(&mut lp); // 61 s later: not due, nothing sent
    assert_eq!(tg.calls("sendMessage").len(), 3, "the held row isn't sent");
    assert!(tg.sent().is_empty());
    w.pass(&mut lp); // 122 s: sent, then the one behind it
    let sent = tg.sent();
    assert_eq!(sent.len(), 2);
    assert!(sent[0].starts_with("approve spec: approve 261001-0900\n261001-0900 web: Spec it"));
    assert_eq!(sent[1], "later");
    let rs = rows(&db);
    assert!(rs.iter().all(|r| r.sent_at == Some(w.clock.unix())));
    let body = &tg.calls("sendMessage")[3];
    assert_eq!(body["chat_id"], CHAT);
    assert_eq!(body["disable_web_page_preview"], true);
    assert_eq!(body["text"].as_str(), Some(sent[0].as_str()));
    // Sent once: later passes send nothing.
    w.pass(&mut lp);
    w.pass(&mut lp);
    assert_eq!(tg.sent().len(), 2);
    lp.shutdown().unwrap();

    // Each call carries the 10 s timeout's peers: getUpdates every pass, `message` only.
    let gu = tg.calls("getUpdates");
    assert!(gu.len() >= 6);
    assert_eq!(gu[0]["timeout"], 0);
    assert_eq!(gu[0]["allowed_updates"], serde_json::json!(["message"]));
    assert!(
        gu[0].get("offset").is_none(),
        "no offset before the first update"
    );
}

#[test]
fn test_outbox_survives_restart() {
    let tg = FakeTelegram::start();
    let mut w = World::new(
        &[intent_file("261001-0900-spec", "web", "", "Spec it")],
        &["web"],
    );
    w.config.telegram = Some(tg.config());
    // A message read and answered before the crash.
    let u = tg.message(CHAT, Some("/pause"));
    let mut lp = w.open(spec_waits());
    w.pass(&mut lp);
    assert_eq!(tg.sent(), [PAUSED]);
    let db = w.db();
    assert_eq!(db.meta("tg_offset").unwrap(), Some((u + 1).to_string()));
    tg.message(CHAT, Some("resume"));
    // Telegram goes down; the loop reads nothing, a wait's message stays unsent; crash.
    tg.down(Some(502));
    w.pass(&mut lp); // resume not read: down
    let commands_before: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM commands", [], |r| r.get(0))
        .unwrap();
    assert_eq!(commands_before, 1);
    db.conn()
        .execute("DELETE FROM meta WHERE key = 'paused'", [])
        .unwrap();
    w.until(&mut lp, 10, |w| {
        w.stage("261001-0900") == Some(Stage::ApprovalSpec)
    });
    let unsent: Vec<OutboxRow> = rows(&db)
        .into_iter()
        .filter(|r| r.sent_at.is_none())
        .collect();
    assert_eq!(unsent.len(), 1);
    assert!(unsent[0].tries >= 1);
    drop(lp);

    // Back up, a new loop on the same home: the unsent row goes once, before the new reply
    // (oldest first); the old update isn't read again, the new one is.
    tg.down(None);
    let mut lp = w.open(spec_waits());
    w.pass(&mut lp);
    w.pass(&mut lp);
    let sent = tg.sent();
    assert_eq!(sent.len(), 3, "{sent:?}");
    assert_eq!(sent[0], PAUSED);
    assert!(sent[1].starts_with("approve spec: approve 261001-0900"));
    assert_eq!(sent[2], RESUMED);
    let names: Vec<(String, Option<i64>)> = db
        .conn()
        .prepare("SELECT name, update_id FROM commands ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        names,
        [
            ("pause".to_string(), Some(u)),
            ("resume".to_string(), Some(u + 1))
        ]
    );
    assert!(rows(&db).iter().all(|r| r.sent_at.is_some()));
    lp.shutdown().unwrap();
}

#[test]
fn test_other_chat_ignored() {
    let tg = FakeTelegram::start();
    let mut w = World::new(&[], &["web"]);
    w.config.telegram = Some(tg.config());
    // The first start skips Telegram's backlog: my `resume` of yesterday isn't applied.
    tg.state.lock().unwrap().updates.push(serde_json::json!({
        "update_id": 99,
        "message": {"message_id": 99, "chat": {"id": 4242}, "text": "/resume",
                    "date": w.clock.wall.timestamp() - 86_000},
    }));
    let ids = [
        tg.message("999", Some("pause")),
        tg.message(CHAT, None),
        tg.message("-4242", Some("/status")),
        tg.message(CHAT, Some("/PAUSE@towercab_bot")),
        tg.message("999", Some("resume")),
    ];
    let mut lp = w.open(idle());
    let report = w.pass(&mut lp);
    let db = w.db();
    assert_eq!(report.commands.len(), 1, "{:?}", report.commands);
    let (name, source, update): (String, String, i64) = db
        .conn()
        .query_row("SELECT name, source, update_id FROM commands", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(
        (name.as_str(), source.as_str(), update),
        ("pause", "telegram", ids[3])
    );
    assert_eq!(tg.sent(), [PAUSED], "one reply, to my chat");
    assert_eq!(tg.calls("sendMessage")[0]["chat_id"], CHAT);
    let r = rows(&db);
    assert_eq!(
        (r[0].mission.as_str(), r[0].event.as_str(), r[0].n.clone()),
        ("loop", "reply", ids[3].to_string())
    );
    // Every update consumed, others' too.
    assert_eq!(
        db.meta("tg_offset").unwrap(),
        Some((ids[4] + 1).to_string())
    );
    w.pass(&mut lp);
    let gu = tg.calls("getUpdates");
    assert_eq!(gu.last().unwrap()["offset"], ids[4] + 1);
    assert_eq!(tg.sent().len(), 1);
    lp.shutdown().unwrap();
}

#[test]
fn test_failures_never_raise() {
    // 5xx, then `ok: false`: each pass goes on; logged once per outage, token masked.
    let tg = FakeTelegram::start();
    let mut w = World::new(
        &[intent_file("261001-0900-spec", "web", "", "Spec it")],
        &["web"],
    );
    w.config.telegram = Some(tg.config());
    tg.down(Some(502));
    let mut lp = w.open(spec_waits());
    w.until(&mut lp, 10, |w| {
        w.stage("261001-0900") == Some(Stage::ApprovalSpec)
    });
    w.pass(&mut lp);
    let logged = lp.telegram.as_ref().unwrap().logged.clone();
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(
        logged[0].starts_with("telegram getUpdates: HTTP 502"),
        "{logged:?}"
    );
    tg.down(None);
    w.pass(&mut lp);
    assert_eq!(tg.sent().len(), 1, "sent once it's back");
    tg.down(Some(200));
    tg.message(CHAT, Some("status"));
    w.pass(&mut lp);
    w.pass(&mut lp);
    let logged = lp.telegram.as_ref().unwrap().logged.clone();
    assert_eq!(logged.len(), 2, "a new outage: {logged:?}");
    assert_eq!(logged[1], "telegram getUpdates: HTTP 200: down");
    lp.shutdown().unwrap();

    // Unreachable: an error naming the URL with `<token>`, never the token.
    let cfg = TelegramConfig {
        bot_token: TOKEN.into(),
        chat_id: CHAT.into(),
        api_base: dead_url(),
    };
    let mut dead = Telegram::new(&cfg);
    let e = dead.send("hi").unwrap_err();
    assert!(
        e.starts_with("telegram sendMessage: POST http://127.0.0.1:"),
        "{e}"
    );
    assert!(e.contains("/bot<token>/sendMessage"), "{e}");
    assert!(!e.contains("SECRET") && !e.contains(TOKEN), "{e}");
    assert!(dead.updates(Some(5)).is_err());
    assert_eq!(dead.logged.len(), 1, "one outage");
    assert!(
        towercab::env::classify(&e).is_some(),
        "a network failure: {e}"
    );

    // The binary: `run` with Telegram unreachable exits 0; one stderr line, token masked.
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let file = loop_config(
        tmp.path(),
        &format!(
            "[telegram]\nbot_token = \"{TOKEN}\"\nchat_id = {CHAT}\napi_base = \"{}\"\n",
            dead_url()
        ),
    );
    let (_, stderr, code) = output(&mut towercab(
        &user,
        &[
            "--config",
            file.to_str().unwrap(),
            "--home",
            tmp.path().join("home").to_str().unwrap(),
            "run",
        ],
    ));
    assert_eq!(code, Some(0), "{stderr}");
    assert_eq!(stderr.matches("telegram").count(), 1, "{stderr}");
    assert!(!stderr.contains("SECRET"), "{stderr}");

    // No [telegram]: rows are written, nothing is sent or read.
    let mut w = World::new(
        &[intent_file("261001-0900-spec", "web", "", "Spec it")],
        &["web"],
    );
    let mut lp = w.open(spec_waits());
    assert!(lp.telegram.is_none());
    w.until(&mut lp, 10, |w| {
        w.stage("261001-0900") == Some(Stage::ApprovalSpec)
    });
    w.pass(&mut lp);
    let r = rows(&w.db());
    assert_eq!(r.len(), 1);
    assert_eq!((r[0].tries, r[0].sent_at), (0, None));
    lp.shutdown().unwrap();
}

#[test]
fn test_telegram_commands() {
    // `[/]command[@bot] args`, case-insensitive, runs of spaces one.
    let cmd = |c: Cmd| Ok(TgCommand::Cmd(c));
    let cases: Vec<(&str, Result<TgCommand, ()>)> = vec![
        ("status", Ok(TgCommand::Status)),
        ("/status", Ok(TgCommand::Status)),
        ("/STATUS@towercab_bot", Ok(TgCommand::Status)),
        ("  next  ", Ok(TgCommand::Next)),
        ("help", Ok(TgCommand::Help)),
        ("/start", Ok(TgCommand::Help)),
        ("pause", cmd(Cmd::Pause)),
        ("Resume", cmd(Cmd::Resume)),
        ("approve 0900", cmd(Cmd::Approve("0900".into()))),
        (
            "/approve@towercab_bot   0900",
            cmd(Cmd::Approve("0900".into())),
        ),
        (
            "release 261001-0900",
            cmd(Cmd::Release("261001-0900".into())),
        ),
        ("retry 0900", cmd(Cmd::RetryFresh("0900".into()))),
        ("/retry --fresh 0900", cmd(Cmd::RetryFresh("0900".into()))),
        ("approve", Err(())),
        ("approve 1 2", Err(())),
        ("retry --fresh", Err(())),
        ("status now", Err(())),
        ("merge 0900", Err(())),
        ("", Err(())),
    ];
    for (text, want) in cases {
        assert_eq!(telegram::parse(text).map_err(drop), want, "{text:?}");
    }

    // Through the loop: each command's reply, in the order I sent them.
    let tg = FakeTelegram::start();
    let mut w = World::new(
        &[
            intent_file(
                "261001-0900-spec",
                "web",
                "stage: design\nwaiting: approve spec\n",
                "Spec",
            ),
            intent_file(
                "261001-0901-ship",
                "api",
                "stage: deploy\nwaiting: authorize release\n",
                "Ship",
            ),
            intent_file(
                "261001-0902-red",
                "api",
                "stage: test\nwaiting: CI red\n",
                "Red",
            ),
            intent_file("261001-0903-held", "ops", "stage: deploy\n", "Held"),
        ],
        &["web", "api", "ops"],
    );
    w.config.telegram = Some(tg.config());
    let db = w.db();
    let spec = mission(
        &db,
        "261001-0900",
        "web",
        Stage::ApprovalSpec,
        Some("approve spec"),
    );
    let ship = mission(
        &db,
        "261001-0901",
        "api",
        Stage::ApprovalRelease,
        Some("authorize release"),
    );
    let red = mission(&db, "261001-0902", "api", Stage::Blocked, Some("CI red"));
    // Held at merge by an earlier pause: `resume` lets it go on.
    let held = mission(&db, "261001-0903", "ops", Stage::Merge, None);
    db.conn()
        .execute("UPDATE missions SET held = 1 WHERE id = ?1", [held])
        .unwrap();
    for text in [
        "release 0900",
        "approve 0900",
        "/release@towercab_bot 0901",
        "retry 0902",
        "approve 0902",
        "pause",
        "resume",
        "status",
        "next",
        "merge it",
        "approve 7777",
    ] {
        tg.message(CHAT, Some(text));
    }
    let mut lp = w.open(idle());
    let report = w.pass(&mut lp);
    assert_eq!(report.commands.len(), 8);
    let sent = tg.sent();
    assert_eq!(sent.len(), 11, "{sent:?}");
    assert_eq!(sent[0], "release: 261001-0900 isn't waiting for release");
    assert_eq!(sent[1], "approved 261001-0900");
    assert_eq!(sent[2], "releasing 261001-0901");
    assert_eq!(sent[3], "fresh attempt 2 for 261001-0902");
    assert_eq!(sent[4], "approve: 261001-0902 isn't waiting on you");
    assert_eq!(sent[5], PAUSED);
    assert_eq!(sent[6], RESUMED);
    assert!(sent[7].starts_with("towercab "), "{}", sent[7]);
    assert!(sent[7].contains("running (pid "), "{}", sent[7]);
    assert!(sent[8].starts_with("next: "), "{}", sent[8]);
    assert_eq!(sent[9], HELP);
    assert_eq!(sent[10], "approve: no open intent matches 7777");
    let stage = |id: i64| -> String {
        db.conn()
            .query_row("SELECT stage FROM missions WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
    };
    assert_eq!(stage(spec), "plan");
    assert_eq!(stage(ship), "release");
    assert_eq!(stage(red), "stopped");
    let held_now: bool = db
        .conn()
        .query_row("SELECT held FROM missions WHERE id = ?1", [held], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!held_now, "resume let it go");
    assert!(w.transitions("261001-0903").contains(&(
        "merge".into(),
        "resume".into(),
        "merge".into()
    )));
    let fresh = w.mission("261001-0902");
    assert_eq!((fresh.attempt, fresh.stage), (2, Stage::Pick));
    // The entry effects ran: my intent files say so.
    assert!(!w.intent_md("261001-0900-spec").contains("waiting:"));
    lp.shutdown().unwrap();
}

#[test]
fn test_telegram_answer_unlock_drop() {
    use towercab::commands::Cmd;
    use towercab::telegram::{TgCommand, parse};
    assert_eq!(
        parse("answer 0901 Use GitHub, not Google.").unwrap(),
        TgCommand::Cmd(Cmd::Answer("0901".into(), "Use GitHub, not Google.".into()))
    );
    assert_eq!(
        parse("/unlock 0901 .github/workflows/** CLAUDE.md").unwrap(),
        TgCommand::Cmd(Cmd::Unlock(
            "0901".into(),
            vec![".github/workflows/**".into(), "CLAUDE.md".into()]
        ))
    );
    assert_eq!(
        parse("allow 0901 registry.npmjs.org").unwrap(),
        TgCommand::Cmd(Cmd::Allow("0901".into(), vec!["registry.npmjs.org".into()]))
    );
    assert_eq!(
        parse("drop 0901").unwrap(),
        TgCommand::Cmd(Cmd::Drop("0901".into()))
    );
    assert!(parse("answer 0901").is_err());
    assert!(parse("unlock 0901").is_err());
    assert!(parse("allow 0901").is_err());
    assert!(towercab::telegram::HELP.contains("answer <id> <text>"));
}
