//! PR and intent events in every stage (LOOP-18): derived level-triggered from each PR read
//! and `intents` pull, wired to the transition table.

mod common;

use std::time::Duration;

use common::world::{Act, PublishesPr, Scripted, World, intent_file, open_pr};
use rusqlite::params;
use towercab::events::{Comment, PrState, intent_events, parse_pr, pr_events};
use towercab::handler::Handlers;
use towercab::intents::Listing;
use towercab::machine::{Event, Kind, Next, Stage, Waiting, continue_to, next};
use towercab::mission::Mission;
use towercab::pick::Pick;

/// Every stage: nothing happens (a poll a day), so only events move missions.
fn idle_handlers() -> Handlers {
    let mut h = Handlers::stubs();
    for s in Stage::ALL.into_iter().filter(|s| s.driven()) {
        h.set(s, Scripted::all(Act::Poll(Duration::from_secs(86_400))));
    }
    h
}

/// The `waiting:` a mission in `s` has.
fn waiting_in(s: Stage) -> Option<Waiting> {
    match s {
        Stage::ApprovalSpec => Some(Waiting::ApproveSpec),
        Stage::ApprovalMerge => Some(Waiting::ReviewAndMergePr),
        Stage::ApprovalRelease => Some(Waiting::AuthorizeRelease),
        Stage::Blocked => Some(Waiting::CiRed),
        _ => None,
    }
}

/// Where `next` sends a mission at `s` on `e`, as the loop applies it.
fn expected(s: Stage, e: Event) -> Stage {
    match next(s, e) {
        Next::Go(to) => to,
        Next::Stop => Stage::Stopped,
        Next::Ignore => s,
        Next::Continue => match continue_to(&waiting_in(s).unwrap(), Stage::Ci) {
            Next::Go(to) => to,
            other => panic!("{s} × {e}: {other:?}"),
        },
        other => panic!("{s} × {e}: {other:?} isn't an event's"),
    }
}

/// A PR read that gives `e`.
fn pr_giving(e: Event) -> PrState {
    let mut pr = open_pr("h1");
    match e {
        Event::PrMerged => {
            pr.state = "MERGED".into();
            pr.merged_at = Some("2026-10-15T12:00:00Z".into());
            pr.merge_commit = Some("m1".into());
        }
        Event::PrClosed => pr.state = "CLOSED".into(),
        Event::Feedback => pr.comments.push(Comment {
            author: "me".into(),
            at: "2026-10-15T12:00:00Z".into(),
            body: "rename it".into(),
        }),
        Event::Conflict => pr.mergeable = "CONFLICTING".into(),
        Event::HeadMoved => pr.head = "h2".into(),
        other => panic!("{other} isn't a PR event"),
    }
    pr
}

#[test]
fn test_events_in_every_stage() {
    let pr_events_ = [
        Event::PrMerged,
        Event::PrClosed,
        Event::Feedback,
        Event::Conflict,
        Event::HeadMoved,
    ];
    let intent_events_ = [Event::IntentRemoved, Event::IntentContinued];
    // One intent and mission per (stage, event): id 2610<dd>-<hhmm>, PR = its number.
    let mut cases: Vec<(String, Stage, Event, u64)> = Vec::new();
    let mut files = Vec::new();
    for (si, s) in Stage::ALL.into_iter().enumerate() {
        for (ei, e) in pr_events_.iter().chain(&intent_events_).enumerate() {
            let n = (si * 10 + ei) as u64 + 1;
            let id = format!("2610{:02}-{:04}", si + 1, 1000 + ei);
            let extra = format!(
                "{}{}",
                s.playbook()
                    .map(|p| format!("stage: {p}\n"))
                    .unwrap_or_default(),
                waiting_in(s)
                    .map(|w| format!("waiting: {w}\n"))
                    .unwrap_or_default()
            );
            files.push(intent_file(&format!("{id}-case"), "web", &extra, &id));
            cases.push((id, s, *e, n));
        }
    }
    // workers 1: web is full, so nothing is picked meanwhile.
    let mut w = World::new(&files, &["web"]);
    let db = w.db();
    let mut mine: Vec<(String, Option<String>)> = Vec::new();
    for (id, s, e, n) in &cases {
        db.conn()
            .execute(
                "INSERT INTO missions (kind, intent, repo, stage, step, model, session, checkout,
                   branch, pr, pr_url, head, waiting, from_stage, created, updated)
                 VALUES (?1, ?2, 'web', ?3, '', 'opus', 's', ?4, 'b', ?5, ?6, 'h1', ?7, ?8, 0, 0)",
                params![
                    s.kind().as_str(),
                    id,
                    s.as_str(),
                    format!("work/{id}-1"),
                    *n as i64,
                    format!("https://github.com/me/web/pull/{n}"),
                    waiting_in(*s).map(|w| w.text()),
                    s.waits().then_some("ci"),
                ],
            )
            .unwrap();
        w.prs.set(
            *n,
            if pr_events_.contains(e) {
                pr_giving(*e)
            } else {
                open_pr("h1")
            },
        );
        let dir = format!("intents/{id}-case/intent.md");
        match e {
            Event::IntentRemoved => mine.push((dir, None)),
            Event::IntentContinued if s.waits() => {
                let extra = s
                    .playbook()
                    .map(|p| format!("stage: {p}\n"))
                    .unwrap_or_default();
                mine.push((dir, Some(common::intent_md("web", &extra, id))));
            }
            _ => {}
        }
    }
    let mine: Vec<(&str, Option<&str>)> = mine
        .iter()
        .map(|(d, t)| (d.as_str(), t.as_deref()))
        .collect();
    w.intents.push_mine(&mine, "my edits");
    let mut lp = w.open(idle_handlers());
    w.pass(&mut lp);
    let mut wrong = Vec::new();
    for (id, s, e, n) in &cases {
        let m = w.mission(id);
        // Finished missions aren't read or derived; revert and rehearsal ones have no PR reads.
        let want = if s.finished() || (pr_events_.contains(e) && s.kind() != Kind::Intent) {
            *s
        } else {
            expected(*s, *e)
        };
        if m.stage != want {
            wrong.push(format!("{s} × {e} (PR {n}): {} not {want}", m.stage));
        }
        if *e == Event::PrMerged && want == Stage::Deploy && *s != Stage::Deploy {
            assert_eq!(m.merged_by.as_deref(), Some("human"), "{s}");
            assert_eq!(m.merge_sha.as_deref(), Some("m1"), "{s}");
        }
        if *e == Event::PrClosed && want == Stage::Stopped && *s != Stage::Stopped {
            assert_eq!(m.waiting.as_deref(), Some("PR closed"), "{s}");
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    // PR closed sends nothing; every other move here sends nothing either.
    assert!(w.outbox().is_empty(), "{:?}", w.outbox());
    lp.shutdown().unwrap();
}

/// design publishes a PR (number 7, head h1); ci runs a child until released.
fn pr_handlers() -> Handlers {
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Design, Box::new(PublishesPr));
    h.set(Stage::Ci, Scripted::all(Act::Child));
    h
}

const ID: &str = "261001-0900";

#[test]
fn test_closed_during_ci() {
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    w.prs.set(7, open_pr("h1"));
    let mut lp = w.open(pr_handlers());
    w.wait_for(&mut lp, 20, |w, lp| {
        w.stage(ID) == Some(Stage::Ci) && !lp.running().is_empty()
    });
    let m = w.mission(ID);
    let pid = m.child_pid.unwrap();
    let checkout = w.home.root.join(&m.checkout);
    // My comment while the child runs: not raised (level-triggered, read again later).
    let mut pr = open_pr("h1");
    pr.comments.push(Comment {
        author: "me".into(),
        at: "2026-10-15T12:00:00Z".into(),
        body: "and the docs".into(),
    });
    w.prs.set(7, pr.clone());
    let reads = w.prs.reads();
    w.pass(&mut lp);
    assert!(w.prs.reads() > reads);
    assert_eq!(w.stage(ID), Some(Stage::Ci));
    assert!(!lp.running().is_empty());
    // I close the PR: stopped at once, the child killed, no message.
    pr.state = "CLOSED".into();
    w.prs.set(7, pr);
    w.pass(&mut lp);
    let m = w.mission(ID);
    assert_eq!(m.stage, Stage::Stopped);
    assert_eq!(m.waiting.as_deref(), Some("PR closed"));
    assert_eq!(m.from_stage, Some(Stage::Ci));
    assert!(lp.running().is_empty());
    let end = std::time::Instant::now() + Duration::from_secs(5);
    while std::path::Path::new(&format!("/proc/{pid}")).exists()
        && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .unwrap_or_default()
            .contains(") Z")
    {
        assert!(std::time::Instant::now() < end, "the ci child is killed");
        std::thread::sleep(Duration::from_millis(20));
        w.pass_after(&mut lp, 1);
    }
    assert!(!checkout.exists());
    let md = w.intent_md("261001-0900-x");
    assert!(md.contains("waiting: PR closed"), "{md}");
    assert!(md.contains("pr: https://github.com/me/web/pull/7"), "{md}");
    assert!(w.outbox().is_empty());
    let reads = w.prs.reads();
    w.pass(&mut lp);
    assert_eq!(w.prs.reads(), reads, "a stopped mission isn't read");
    lp.shutdown().unwrap();
}

#[test]
fn test_my_merge_during_ci() {
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    w.prs.set(7, open_pr("h1"));
    let mut h = pr_handlers();
    h.set(
        Stage::Deploy,
        Scripted::all(Act::Poll(Duration::from_secs(30))),
    );
    let mut lp = w.open(h);
    w.wait_for(&mut lp, 20, |w, lp| {
        w.stage(ID) == Some(Stage::Ci) && !lp.running().is_empty()
    });
    let mut pr = open_pr("h1");
    pr.state = "MERGED".into();
    pr.merged_at = Some("2026-10-15T12:00:00Z".into());
    pr.merge_commit = Some("abc123".into());
    w.prs.set(7, pr);
    w.pass(&mut lp);
    let m = w.mission(ID);
    assert_eq!(m.stage, Stage::Deploy);
    assert_eq!(m.merged_by.as_deref(), Some("human"));
    assert_eq!(m.merge_sha.as_deref(), Some("abc123"));
    assert!(lp.running().is_empty(), "ci's child killed");
    assert!(w.intent_md("261001-0900-x").contains("stage: deploy"));
    let t = w.transitions(ID).pop().unwrap();
    assert_eq!(t, ("ci".into(), "pr_merged".into(), "deploy".into()));
    // Merged: no more PR reads.
    let reads = w.prs.reads();
    w.pass(&mut lp);
    w.pass(&mut lp);
    assert_eq!(w.prs.reads(), reads);
    assert!(w.outbox().is_empty(), "never a message on merges");
    lp.shutdown().unwrap();
}

fn mission(stage: Stage, head: Option<&str>, seen: Option<&str>) -> Mission {
    let tmp = tempfile::tempdir().unwrap();
    let db = towercab::db::Db::open(&tmp.path().join("t.db")).unwrap();
    db.conn()
        .execute(
            "INSERT INTO missions (intent, repo, stage, step, model, session, checkout, head,
               feedback_seen, created, updated)
             VALUES ('261001-0900', 'web', ?1, '', 'opus', 's', 'work/x', ?2, ?3, 0, 0)",
            params![stage.as_str(), head, seen],
        )
        .unwrap();
    towercab::mission::get(db.conn(), 1).unwrap()
}

#[test]
fn test_pr_and_intent_event_derivation() {
    let m = mission(Stage::Ci, Some("h1"), Some("2026-10-15T10:00:00Z"));
    let at = |t: &str, who: &str| Comment {
        author: who.into(),
        at: t.into(),
        body: "x".into(),
    };
    // At most one, by priority: merged > closed > feedback > conflict > head moved.
    let mut pr = open_pr("h2");
    pr.mergeable = "CONFLICTING".into();
    pr.comments.push(at("2026-10-15T11:00:00Z", "me"));
    assert_eq!(pr_events(&m, &pr, "me"), Some(Event::Feedback));
    pr.state = "CLOSED".into();
    assert_eq!(pr_events(&m, &pr, "me"), Some(Event::PrClosed));
    pr.merged_at = Some("2026-10-15T12:00:00Z".into());
    assert_eq!(pr_events(&m, &pr, "me"), Some(Event::PrMerged));
    let mut pr = open_pr("h2");
    pr.mergeable = "CONFLICTING".into();
    assert_eq!(pr_events(&m, &pr, "me"), Some(Event::Conflict));
    pr.mergeable = "UNKNOWN".into();
    assert_eq!(pr_events(&m, &pr, "me"), Some(Event::HeadMoved));
    assert_eq!(pr_events(&m, &open_pr("h1"), "me"), None);
    // Feedback: mine only (any case), newer than feedback_seen; the bot's and others' never.
    let mut pr = open_pr("h1");
    pr.comments = vec![
        at("2026-10-15T09:00:00Z", "me"),
        at("2026-10-15T11:00:00Z", "towercab[bot]"),
        at("2026-10-15T11:00:00Z", "someone"),
    ];
    assert_eq!(pr_events(&m, &pr, "me"), None);
    // An approval without text on GitHub isn't feedback.
    pr.comments.push(Comment {
        body: " \n".into(),
        ..at("2026-10-15T11:00:00Z", "me")
    });
    assert_eq!(pr_events(&m, &pr, "me"), None);
    pr.comments.push(at("2026-10-15T10:30:00+00:00", "Me"));
    assert_eq!(pr_events(&m, &pr, "me"), Some(Event::Feedback));
    // No head yet: no head_moved.
    let fresh = mission(Stage::Design, None, None);
    assert_eq!(pr_events(&fresh, &open_pr("h9"), "me"), None);

    // gh's JSON.
    let view = r#"{"state":"OPEN","mergedAt":null,"mergeCommit":null,"headRefOid":"h1",
      "mergeable":"MERGEABLE","comments":[{"author":{"login":"me"},"createdAt":"2026-10-15T11:00:00Z","body":"a"}],
      "reviews":[{"author":{"login":"me"},"submittedAt":"2026-10-15T11:05:00Z","body":"b"}]}"#;
    let rc = r#"[{"user":{"login":"me"},"created_at":"2026-10-15T11:10:00Z","body":"c"}]"#;
    let pr = parse_pr(view, rc).unwrap();
    assert_eq!(pr.head, "h1");
    assert_eq!(
        pr.comments
            .iter()
            .map(|c| c.body.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "c"]
    );
    // Review comments `--paginate --slurp`: one array per page.
    let pages = r#"[[{"user":{"login":"me"},"created_at":"2026-10-15T11:10:00Z","body":"c"}],
      [{"user":{"login":"me"},"created_at":"2026-10-15T11:20:00Z","body":"d"}]]"#;
    let pr = parse_pr(view, pages).unwrap();
    assert_eq!(
        pr.comments
            .iter()
            .map(|c| c.body.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "c", "d"]
    );
    let merged = parse_pr(
        r#"{"state":"MERGED","mergedAt":"2026-10-15T12:00:00Z","mergeCommit":{"oid":"m1"},"headRefOid":"h1","mergeable":"UNKNOWN"}"#,
        "",
    )
    .unwrap();
    assert_eq!(merged.merge_commit.as_deref(), Some("m1"));

    // Intent events: gone (not unreadable) → removed; retry: fresh; waiting removed.
    let text = |extra: &str| common::intent_md("web", extra, "X");
    let dir = "intents/261001-0900-x";
    let with = |extra: &str| Listing {
        open: vec![common::intent(dir, &text(extra))],
        ..Listing::default()
    };
    let mut m = mission(Stage::ApprovalSpec, None, None);
    assert_eq!(intent_events(&m, &with("waiting: approve spec\n")), None);
    assert_eq!(intent_events(&m, &with("")), Some(Event::IntentContinued));
    assert_eq!(
        intent_events(&m, &with("retry: fresh\n")),
        Some(Event::RetryFresh)
    );
    assert_eq!(
        intent_events(&m, &Listing::default()),
        Some(Event::IntentRemoved)
    );
    let unreadable = Listing {
        unreadable: vec![towercab::intents::Unreadable {
            path: format!("{dir}/intent.md"),
            reason: "u must be an integer 1-5".into(),
        }],
        ..Listing::default()
    };
    assert_eq!(
        intent_events(&m, &unreadable),
        None,
        "a typo isn't a removal"
    );
    m.step = "enter".into();
    assert_eq!(
        intent_events(&m, &with("")),
        None,
        "not while the entry write is due"
    );
    let build = mission(Stage::Build, None, None);
    assert_eq!(intent_events(&build, &with("")), None);
}

/// design: publishes PR 7 (head h1), `feedback_seen` = now, then waits for `approve spec`.
struct SpecWait;

impl towercab::handler::Handler for SpecWait {
    fn step(
        &mut self,
        cx: &mut towercab::handler::Ctx<'_>,
        _: &Mission,
    ) -> Result<towercab::handler::Progress, towercab::handler::StepError> {
        Ok(towercab::handler::Progress::Done(
            towercab::handler::Outcome::wait(Waiting::ApproveSpec, "")
                .with("pr", 7)
                .with("pr_url", "https://github.com/me/web/pull/7".to_string())
                .with("head", "h1".to_string())
                .with("feedback_seen", cx.tick.wall.to_rfc3339()),
        ))
    }
    fn finish(
        &mut self,
        _: &mut towercab::handler::Ctx<'_>,
        _: &Mission,
        _: towercab::handler::ChildEnd,
    ) -> Result<towercab::handler::Progress, towercab::handler::StepError> {
        unreachable!()
    }
}

#[test]
fn test_wait_again_sends_again() {
    // My comment on the spec PR sends it back to design; the next `approve spec` is a new
    // message: every way out of a wait counts (outbox n = continued).
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    w.prs.set(7, open_pr("h1"));
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Design, Box::new(SpecWait));
    let mut lp = w.open(h);
    w.until(&mut lp, 5, |w| w.stage(ID) == Some(Stage::ApprovalSpec));
    let mut pr = open_pr("h1");
    pr.comments.push(Comment {
        author: "me".into(),
        at: (w.clock.wall + chrono::TimeDelta::seconds(10)).to_rfc3339(),
        body: "split the table".into(),
    });
    w.prs.set(7, pr);
    w.pass(&mut lp);
    let m = w.mission(ID);
    assert_eq!((m.stage, m.continued), (Stage::ApprovalSpec, 1));
    let sent: Vec<(String, String)> = w.outbox().into_iter().map(|(_, e, n, _)| (e, n)).collect();
    assert_eq!(
        sent,
        [
            ("approve_spec".to_string(), "0".to_string()),
            ("approve_spec".to_string(), "1".to_string())
        ]
    );
    lp.shutdown().unwrap();
}

#[test]
fn test_pr_reads_skipped() {
    // At merge with its step recorded, the PR isn't read: the step's re-entry checks
    // `mergedAt` (a crash after my merge isn't a human one). An event back to the mission's
    // own stage (feedback at build) isn't raised: it comes back at the next stage.
    let mut w = World::new(
        &[
            intent_file("261001-0900-x", "web", "stage: deploy\n", "X"),
            intent_file("261001-0901-y", "web", "stage: build\n", "Y"),
        ],
        &["web"],
    );
    let db = w.db();
    for (id, stage, step, n) in [
        ("261001-0900", "merge", "merge", 7),
        ("261001-0901", "build", "run", 8),
    ] {
        db.conn()
            .execute(
                "INSERT INTO missions (intent, repo, stage, step, model, session, checkout, branch,
                   pr, pr_url, head, retry_at, created, updated)
                 VALUES (?1, 'web', ?2, ?3, 'opus', 's', ?4, 'b', ?5, 'u', 'h1', 9e12, 0, 0)",
                params![id, stage, step, format!("work/{id}-1"), n],
            )
            .unwrap();
    }
    let mut merged = open_pr("h1");
    merged.state = "MERGED".into();
    merged.merged_at = Some("2026-10-15T12:00:00Z".into());
    w.prs.set(7, merged);
    w.prs.set(8, pr_giving(Event::Feedback));
    let mut lp = w.open(idle_handlers());
    w.pass(&mut lp);
    w.pass(&mut lp);
    assert_eq!(w.prs.reads(), 2, "only Y's PR, once per 60 s");
    let (x, y) = (w.mission("261001-0900"), w.mission("261001-0901"));
    assert_eq!((x.stage, x.merged_by), (Stage::Merge, None));
    assert_eq!((y.stage, y.step.as_str()), (Stage::Build, "run"));
    assert!(w.transitions("261001-0901").is_empty());
    lp.shutdown().unwrap();
}
