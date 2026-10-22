//! Messages only when I must act (LOOP-14): every wait has a template, the texts, only
//! actionable messages, stale waits dropped.

mod common;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

use common::world::{World, intent_file, open_pr};
use common::{intent, intent_md, read, t};
use rusqlite::params;
use towercab::commands::{self, Cmd};
use towercab::config::{Config, IntentsConfig};
use towercab::db::{Db, OutboxRow};
use towercab::handler::{ChildEnd, Ctx, Handler, Handlers, Outcome, Progress, StepError};
use towercab::intents::Listing;
use towercab::limits::Limit;
use towercab::machine::{Door, Stage, Waiting};
use towercab::mission::Mission;
use towercab::outbox::{self, Notice, Sender, Subject};
use towercab::priority::ReviewDue;

/// loop.md **Messages**' waiting table: `waiting:` text → (stage, line 1 with `<id>`).
fn spec_table() -> BTreeMap<String, (Option<Stage>, Option<String>)> {
    let spec = read("specs/loop.md");
    let at = spec.find("**Messages**").expect("**Messages**");
    let mut out = BTreeMap::new();
    for line in spec[at..]
        .lines()
        .skip_while(|l| !l.starts_with("| `waiting:`"))
        .skip(2)
        .take_while(|l| l.starts_with('|'))
    {
        let cells: Vec<&str> = line.trim_matches('|').split(" | ").map(str::trim).collect();
        let quoted = |s: &str| -> Vec<String> {
            s.split('`')
                .enumerate()
                .filter(|(i, _)| i % 2 == 1)
                .map(|(_, q)| q.to_string())
                .collect()
        };
        let stage = match cells[1].split_whitespace().next().unwrap() {
            "none" => None,
            s => Some(s.parse::<Stage>().unwrap()),
        };
        let line1 = if cells[2].starts_with("none") {
            None
        } else if cells[2] == "the `waiting:` text" {
            Some(String::new())
        } else {
            Some(quoted(cells[2])[0].clone())
        };
        let names = quoted(cells[0]);
        let doors: Vec<&String> = names.iter().filter(|n| !n.contains(' ')).collect();
        for name in names.iter().filter(|n| n.contains(' ') || n.ends_with(':')) {
            let mut texts = vec![name.clone()];
            if name.contains("<door>") {
                texts = doors.iter().map(|d| name.replace("<door>", d)).collect();
            }
            for text in texts {
                let l1 = line1.clone().map(|l| {
                    if l.is_empty() {
                        text.clone()
                    } else if l.contains("<door>") {
                        let door = text.split('(').nth(1).unwrap().trim_end_matches(')');
                        l.replace("<door>", door)
                    } else {
                        l
                    }
                });
                out.insert(text, (stage, l1));
            }
        }
    }
    out
}

fn config(remote: Option<&str>) -> Config {
    Config::new(
        "/c.toml".into(),
        IntentsConfig {
            remote: remote.map(str::to_string),
            path: "/i".into(),
            cutoff: 7,
        },
    )
}

#[test]
fn test_every_waiting_has_template() {
    let table = spec_table();
    let cfg = config(None);
    let s = Subject {
        id: "261001-0900".into(),
        repo: "web".into(),
        title: "T".into(),
        ..Subject::default()
    };
    let mut all: Vec<Waiting> = Waiting::ALL.to_vec();
    all.extend(Door::ALL.map(Waiting::E2eRedAfterYourMerge));
    all.extend(
        Stage::ALL
            .into_iter()
            .filter(|s| s.driven())
            .map(Waiting::CrashedAt),
    );
    let mut seen = std::collections::BTreeSet::new();
    for w in all {
        let key = match w {
            Waiting::CrashedAt(_) => "crashed at <stage>".to_string(),
            w => w.text(),
        };
        let (stage, line1) = table
            .get(&key)
            .unwrap_or_else(|| panic!("{key:?} isn't in loop.md **Messages**"));
        seen.insert(key);
        assert_eq!(w.stage(), *stage, "{w}");
        let text = outbox::render_waiting(&w, &s, &cfg);
        match line1 {
            None => assert_eq!(text, "", "{w} sends nothing"),
            Some(l) => {
                let want = l
                    .replace("<id>", "261001-0900")
                    .replace("<stage>", &w.text().replace("crashed at ", ""));
                assert_eq!(text.lines().next(), Some(want.as_str()), "{w}");
                assert_eq!(text.lines().nth(1), Some("261001-0900 web: T"), "{w}");
                assert_eq!(outbox::first_line(&w, "261001-0900"), Some(want));
            }
        }
        assert_eq!(Waiting::parse(&w.text()), Some(w), "{w} reads back");
    }
    // And the table has nothing without a `Waiting`.
    for k in table.keys() {
        assert!(seen.contains(k), "{k:?} has no Waiting");
    }
    assert!(seen.len() >= 31);
}

#[test]
fn test_templates() {
    let gh = config(Some("https://github.com/me/intents.git"));
    let local = config(Some("/srv/intents.git"));
    let s = Subject {
        id: "261001-0900".into(),
        repo: "web".into(),
        title: "Ship\nthe thing".into(),
        slug: "ship".into(),
        pr_url: Some("https://github.com/me/web/pull/7".into()),
        why: Some("checks red:\n  test_x failed".into()),
    };
    assert_eq!(
        outbox::render_waiting(&Waiting::ApproveSpec, &s, &gh),
        "approve spec: approve 261001-0900\n261001-0900 web: Ship the thing\n\
         checks red:   test_x failed\nPR https://github.com/me/web/pull/7\n\
         intent https://github.com/me/intents/blob/main/intents/261001-0900-ship/intent.md"
    );
    assert_eq!(
        outbox::render_waiting(&Waiting::E2eRedAfterYourMerge(Door::OneWay), &s, &local),
        "e2e red after your merge (one-way): approve 261001-0900 to keep it, or retry --fresh \
         261001-0900 to fix forward\n261001-0900 web: Ship the thing\nchecks red:   test_x failed\n\
         PR https://github.com/me/web/pull/7\nintent intents/261001-0900-ship/intent.md"
    );
    // No why, PR or slug: left out; long title and why cut with `…`.
    let bare = Subject {
        title: "x".repeat(250),
        why: Some(format!("{}\u{7}", "y".repeat(400))),
        ..Subject {
            id: "261001-0900".into(),
            repo: "web".into(),
            ..Subject::default()
        }
    };
    let text = outbox::render_waiting(&Waiting::CiStuck, &bare, &gh);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0], "CI stuck");
    assert_eq!(lines[1], format!("261001-0900 web: {}…", "x".repeat(199)));
    assert_eq!(lines[2], format!("{}…", "y".repeat(299)));
    assert_eq!(
        outbox::render_waiting(&Waiting::PrClosed, &s, &gh),
        "",
        "PR closed: none"
    );
    // At most 4000 characters in all.
    assert!(
        outbox::render_notice(&Notice::Reply("z".repeat(5000)))
            .chars()
            .count()
            == 4000
    );

    // The other messages.
    let cases = [
        (
            Notice::RepoFrozen {
                repo: "web".into(),
                why: "revert failed: conflict".into(),
            },
            ("repo:web", "frozen"),
            "repo frozen: web: trust web when fixed\nrevert failed: conflict",
        ),
        (
            Notice::EnvBlocked {
                kind: "github".into(),
                error: "Could not resolve host: github.com".into(),
                fix: "check the network".into(),
            },
            ("loop", "env_blocked"),
            "env blocked: github: Could not resolve host: github.com\nfix: check the network",
        ),
        (
            Notice::ReviewDue(ReviewDue::Monthly {
                last: Some(t("2026-09-01T10:00:00+02:00")),
            }),
            ("loop", "review_due"),
            "review the backlog: towercab review\nlast review 2026-09-01",
        ),
        (
            Notice::ReviewDue(ReviewDue::Monthly { last: None }),
            ("loop", "review_due"),
            "review the backlog: towercab review\nnever reviewed",
        ),
        (
            Notice::ReviewDue(ReviewDue::NothingAtCutoff),
            ("loop", "review_due"),
            "review the backlog: towercab review\nnothing at or above the cutoff",
        ),
        (
            Notice::RehearsalFailed {
                repo: "web".into(),
                why: "rollback exited 1".into(),
                pr_url: Some("https://github.com/me/web/pull/9".into()),
            },
            ("repo:web", "rehearsal_failed"),
            "rollback rehearsal failed: web\nrollback exited 1\nPR https://github.com/me/web/pull/9",
        ),
        (
            Notice::Triage {
                band: "lead_time".into(),
                value: 12.5,
                mean: 3.0,
                sigma: 2.25,
                pr_url: None,
            },
            ("loop", "triage:lead_time"),
            "triage: lead_time at 3σ\nvalue 12.5 · mean 3 · σ 2.25",
        ),
        (
            Notice::EvalsDropped {
                points: 4.0,
                change: "skills/intent.md".into(),
            },
            ("loop", "evals_dropped"),
            "evals dropped 4 points: skills/intent.md",
        ),
        (
            Notice::Reply("approved 261001-0900".into()),
            ("loop", "reply"),
            "approved 261001-0900",
        ),
    ];
    for (n, (mission, event), text) in cases {
        assert_eq!(outbox::render_notice(&n), text, "{n:?}");
        assert_eq!(n.key(), (mission.to_string(), event.to_string()));
    }

    // PRI-8: review due at most once per 30 days, keyed by the day; never when not due.
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("t.db")).unwrap();
    let day0 = t("2026-10-15T13:30:00+02:00");
    let due = Some(ReviewDue::Monthly { last: None });
    assert!(!outbox::review_due(db.conn(), None, day0).unwrap());
    assert!(outbox::review_due(db.conn(), due, day0).unwrap());
    assert!(!outbox::review_due(db.conn(), due, day0 + chrono::Duration::days(29)).unwrap());
    assert!(outbox::review_due(db.conn(), due, day0 + chrono::Duration::days(30)).unwrap());
    let keys: Vec<(String, String, String)> = db
        .conn()
        .prepare("SELECT mission, event, n FROM outbox ORDER BY created")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        keys,
        [
            ("loop".into(), "review_due".into(), "2026-10-15".into()),
            ("loop".into(), "review_due".into(), "2026-11-14".into())
        ]
    );

    // Through the loop: a parked intent never reviewed → one message, not again.
    let mut w = World::new(
        &[intent_file("261001-0900-low", "web", "u: 1\ni: 1\n", "Low")],
        &["web"],
    );
    let mut lp = w.open(idle());
    for _ in 0..3 {
        w.pass(&mut lp);
    }
    let rows: Vec<_> = w
        .outbox()
        .into_iter()
        .filter(|r| r.1 == "review_due")
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].3,
        "review the backlog: towercab review\nnever reviewed"
    );
    lp.shutdown().unwrap();
}

/// Every driven stage polls once a day.
fn idle() -> Handlers {
    let mut h = Handlers::stubs();
    for s in Stage::ALL.into_iter().filter(|s| s.driven()) {
        h.set(
            s,
            common::world::Scripted::all(common::world::Act::Poll(Duration::from_secs(86_400))),
        );
    }
    h
}

/// A stage's handler from a closure over the mission.
struct F(Box<dyn FnMut(&Mission) -> Outcome>);

impl Handler for F {
    fn step(&mut self, _: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        Ok(Progress::Done((self.0)(m)))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        unreachable!()
    }
}

fn pr(n: u64, repo: &str) -> Outcome {
    Outcome::ok()
        .with("pr", n as i64)
        .with("pr_url", format!("https://github.com/me/{repo}/pull/{n}"))
        .with("head", "h1".to_string())
        .with("feedback_seen", "2026-10-15T10:00:00Z".to_string())
}

#[test]
fn test_only_actionable() {
    // a: done. b: a usage limit. c: a PR I closed. d: a PR I merged. e: waits on me, I
    // continue by hand (no message), then waits twice more.
    let mut w = World::new(
        &[
            intent_file("261001-0900-a", "a", "", "A"),
            intent_file("261001-0901-b", "b", "", "B"),
            intent_file("261001-0902-c", "c", "", "C"),
            intent_file("261001-0903-d", "d", "", "D"),
            intent_file("261001-0904-e", "e", "", "E"),
        ],
        &["a", "b", "c", "d", "e"],
    );
    let mut closed = open_pr("h1");
    closed.state = "CLOSED".into();
    w.prs.set(7, closed);
    let mut merged = open_pr("h1");
    merged.state = "MERGED".into();
    merged.merged_at = Some("2026-10-15T12:00:00Z".into());
    merged.merge_commit = Some("m1".into());
    w.prs.set(8, merged);
    let mut h = Handlers::stubs();
    h.set(
        Stage::Design,
        Box::new(F(Box::new(|m: &Mission| match m.repo.as_str() {
            "c" => pr(7, "c"),
            "d" => pr(8, "d"),
            "e" if m.continued == 0 => Outcome::wait(Waiting::ApproveSpec, ""),
            _ => Outcome::ok(),
        }))),
    );
    let limited = Rc::new(Cell::new(false));
    let l = Rc::clone(&limited);
    h.set(
        Stage::Build,
        Box::new(F(Box::new(move |m: &Mission| match m.repo.as_str() {
            "b" if !l.get() => {
                l.set(true);
                Outcome::limit(Limit {
                    model: m.model.clone(),
                    reset: None,
                    text: "usage limit reached".into(),
                })
            }
            "e" => Outcome::wait(Waiting::CiRed, "test_x"),
            _ => Outcome::ok(),
        }))),
    );
    let mut lp = w.open(h);
    w.until(&mut lp, 150, |w| {
        ["261001-0900", "261001-0901", "261001-0903"]
            .iter()
            .all(|i| w.stage(i) == Some(Stage::Done))
            && w.stage("261001-0902") == Some(Stage::Stopped)
            && w.stage("261001-0904") == Some(Stage::ApprovalSpec)
    });
    assert!(limited.get(), "b hit its limit");
    assert_eq!(
        w.mission("261001-0902").waiting.as_deref(),
        Some("PR closed")
    );
    assert_eq!(w.mission("261001-0903").merged_by.as_deref(), Some("human"));
    let e = w.mission("261001-0904").id.to_string();
    let rows = w.outbox();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(
        (rows[0].0.as_str(), rows[0].1.as_str(), rows[0].2.as_str()),
        (e.as_str(), "approve_spec", "0")
    );

    // I remove `waiting` myself: it goes on, no message for my edit; the next wait is new.
    w.intents.push_mine(
        &[(
            "intents/261001-0904-e/intent.md",
            Some(&intent_md("e", "stage: design\n", "E")),
        )],
        "go on",
    );
    w.until(&mut lp, 10, |w| {
        w.stage("261001-0904") == Some(Stage::Blocked)
    });
    // approve: continued again, the same wait → its own message (n = continued).
    commands::queue(&w.db(), &Cmd::Approve("0904".into()), "cli").unwrap();
    w.pass(&mut lp);
    w.until(&mut lp, 10, |w| {
        w.mission("261001-0904").continued == 2 && w.stage("261001-0904") == Some(Stage::Blocked)
    });
    let keys: Vec<(String, String, String)> = w
        .outbox()
        .into_iter()
        .map(|(m, e, n, _)| (m, e, n))
        .collect();
    assert_eq!(
        keys,
        [
            (e.clone(), "approve_spec".into(), "0".into()),
            (e.clone(), "ci_red".into(), "1".into()),
            (e.clone(), "ci_red".into(), "2".into()),
        ]
    );
    lp.shutdown().unwrap();
}

/// Records what it sends.
#[derive(Default)]
struct Sink(Vec<String>);

impl Sender for Sink {
    fn send(&mut self, text: &str) -> Result<(), String> {
        self.0.push(text.to_string());
        Ok(())
    }
}

#[test]
fn test_obsolete_message_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("t.db")).unwrap();
    let add = |intent: &str, stage: Stage, waiting: Option<&str>, continued: i64, head: &str| {
        db.conn()
            .execute(
                "INSERT INTO missions (intent, repo, stage, step, model, session, checkout, waiting,
                   continued, head, created, updated)
                 VALUES (?1, 'web', ?2, '', 'opus', 's', 'work/x', ?3, ?4, ?5, 0, 0)",
                params![intent, stage.as_str(), waiting, continued, head],
            )
            .unwrap();
        db.conn().last_insert_rowid().to_string()
    };
    let spec = add(
        "261001-0900",
        Stage::ApprovalSpec,
        Some("approve spec"),
        0,
        "h1",
    );
    let moved = add("261001-0901", Stage::Build, None, 1, "h1");
    let merge = add(
        "261001-0902",
        Stage::ApprovalMerge,
        Some("review and merge PR"),
        0,
        "h2",
    );
    let crashed = add(
        "261001-0903",
        Stage::Blocked,
        Some("crashed at build"),
        1,
        "h1",
    );
    let stopped = add("261001-0904", Stage::Stopped, Some("PR closed"), 0, "h1");
    let picked = add("261001-0905", Stage::Design, None, 0, "h1");
    let listing = Listing {
        open: vec![
            intent(
                "intents/261001-0905-x",
                &intent_md("web", "after: [260101-0101]\nstage: design\n", "X"),
            ),
            intent(
                "intents/261001-0906-y",
                &intent_md("nowhere", "waiting: unknown repo\n", "Y"),
            ),
            intent("intents/261001-0908-w", &intent_md("nowhere", "", "W")),
            intent(
                "intents/261001-0909-v",
                &intent_md("web", "waiting: answer the question\n", "V"),
            ),
        ],
        done: vec![intent(
            "done/261001-0907-z",
            &intent_md("web", "stage: done\n", "Z"),
        )],
        ..Listing::default()
    };
    let rows = [
        (spec.as_str(), "approve_spec", "0", true),
        (moved.as_str(), "ci_red", "0", false),
        (merge.as_str(), "review_and_merge_pr", "h1", false),
        (merge.as_str(), "review_and_merge_pr", "h2", true),
        (crashed.as_str(), "crashed_at", "0", false),
        (crashed.as_str(), "crashed_at", "1", true),
        (stopped.as_str(), "approve_spec", "0", false),
        ("intent:261001-0905", "bad_after", "260101-0101", false),
        ("intent:261001-0906", "unknown_repo", "nowhere", true),
        ("intent:261001-0907", "bad_after", "x", false),
        // No `waiting` yet: its write may still be due.
        ("intent:261001-0908", "unknown_repo", "nowhere", true),
        ("intent:261001-0909", "unknown_repo", "nowhere", false),
        ("repo:web", "frozen", "1", true),
        ("loop", "env_blocked", "1", true),
        ("99", "approve_spec", "0", false),
    ];
    for (i, (m, e, n, _)) in rows.iter().enumerate() {
        outbox::enqueue(db.conn(), m, e, n, &format!("msg {i}"), i as f64).unwrap();
    }
    let _ = picked;
    let mut sink = Sink::default();
    let got = outbox::send_due(&db, &mut sink, Some(&listing), 100.0).unwrap();
    let want: Vec<String> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.3)
        .map(|(i, _)| format!("msg {i}"))
        .collect();
    assert_eq!(sink.0, want);
    assert_eq!(got.sent, want.len());
    assert_eq!(got.dropped, rows.len() - want.len());
    let stored: Vec<OutboxRow> = db
        .conn()
        .prepare("SELECT * FROM outbox ORDER BY created")
        .unwrap()
        .query_map([], OutboxRow::from_row)
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for (row, (_, _, _, sent)) in stored.iter().zip(rows) {
        assert_eq!(row.sent_at, Some(if sent { 100.0 } else { 0.0 }), "{row:?}");
    }
    assert_eq!(
        outbox::send_due(&db, &mut sink, Some(&listing), 200.0).unwrap(),
        outbox::Sent::default(),
        "dropped rows stay dropped"
    );
}
