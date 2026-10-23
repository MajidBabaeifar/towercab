//! Picking (LOOP-5): PRI-4 order, parked last, skips, waits written without a mission,
//! orphaned stages, and the `pick` step.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::world::{World, intent_file};
use common::{git, intent, intent_md, write};
use towercab::handler::Handlers;
use towercab::intents::{Listing, Stage as Playbook};
use towercab::machine::{Stage, Waiting};
use towercab::mission::{self, NewMission};
use towercab::pick::{self, Decision, Pick, PickState, Skip, decide};

fn listing(open: &[(&str, &str)], done: &[(&str, &str)]) -> Listing {
    Listing {
        open: open.iter().map(|(d, t)| intent(d, t)).collect(),
        done: done.iter().map(|(d, t)| intent(d, t)).collect(),
        ..Listing::default()
    }
}

fn state(repos: &[&str]) -> PickState {
    PickState {
        cutoff: 7,
        built: true,
        repos: repos.iter().map(|r| r.to_string()).collect(),
        model: "opus".into(),
        ..PickState::default()
    }
}

/// Stubs everywhere but a real `pick`.
fn handlers() -> Handlers {
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h
}

#[test]
fn test_pick_order() {
    // PRI-4: priority (2i + u) descending, then the oldest id; missing scores count as 3.
    let l = listing(
        &[
            ("intents/261001-0900-old", &intent_md("web", "", "Old")),
            (
                "intents/261002-0900-big",
                &intent_md("web", "u: 5\ni: 5\n", "Big"),
            ),
            (
                "intents/261003-0900-mid",
                &intent_md("api", "u: 5\ni: 4\n", "Mid"),
            ),
            (
                "intents/261000-0900-mid2",
                &intent_md("api", "u: 5\ni: 4\n", "Mid2"),
            ),
        ],
        &[],
    );
    let d = decide(&l, &state(&["web", "api"]));
    assert_eq!(d.pick.as_deref(), Some("261002-0900"));
    assert_eq!(d.skipped, vec![]);
    let mut s = state(&["web", "api"]);
    s.frozen.insert("web".into());
    let d = decide(&l, &s);
    assert_eq!(
        d.pick.as_deref(),
        Some("261000-0900"),
        "same priority: oldest id"
    );
    assert_eq!(
        d.skipped,
        vec![("261002-0900".into(), Skip::Frozen("web".into()))]
    );

    // Through the loop: the picked intent gets a mission at `pick` in one transaction.
    let mut w = World::new(
        &[
            intent_file("261001-0900-low", "web", "u: 1\ni: 1\n", "Low"),
            intent_file(
                "261002-0900-high",
                "api",
                "u: 4\ni: 4\na: 2\nmodel: sonnet\n",
                "High",
            ),
        ],
        &["web", "api"],
    );
    let mut lp = w.open(handlers());
    let report = w.pass(&mut lp);
    assert_eq!(report.picked.as_deref(), Some("261002-0900"));
    let m = w.mission("261002-0900");
    assert_eq!(m.attempt, 1);
    assert_eq!(m.repo, "api");
    assert_eq!(m.model, "sonnet", "the intent's model");
    assert_eq!(m.a_at_pick, Some(2));
    assert_eq!(m.checkout, "work/261002-0900-1");
    assert_eq!(m.branch.as_deref(), Some("towercab/261002-0900-high"));
    let uuid = uuid::Uuid::parse_str(&m.session).expect("a uuid");
    assert_eq!(uuid.get_version_num(), 4);
    assert!(!m.session_used);
    // The other one waits: the first mission is still stepping (no slot for a pick).
    assert!(w.missions("261001-0900").is_empty());
    // It runs to done; then the next is picked, on [agent].model.
    w.until(&mut lp, 40, |w| {
        w.mission("261002-0900").stage == Stage::Done
    });
    w.until(&mut lp, 5, |w| !w.missions("261001-0900").is_empty());
    let low = w.mission("261001-0900");
    assert_eq!(low.model, "opus");
    assert_eq!(low.a_at_pick, None, "a is never filled in at pick");
    assert!(!w.intent_md("261001-0900-low").contains("\na:"));

    // A second attempt: `-<attempt>` on the branch and the checkout.
    let db = w.db();
    db.conn()
        .execute(
            "UPDATE missions SET stage = 'stopped' WHERE intent = '261001-0900'",
            [],
        )
        .unwrap();
    let again = mission::insert(
        db.conn(),
        &NewMission {
            intent: "261001-0900".into(),
            slug: "low".into(),
            repo: "web".into(),
            model: "opus".into(),
            a: None,
            min_attempt: 1,
        },
        w.clock,
    )
    .unwrap();
    assert_eq!(again.attempt, 2);
    assert_eq!(again.branch.as_deref(), Some("towercab/261001-0900-low-2"));
    assert_eq!(again.checkout, "work/261001-0900-2");
    assert_ne!(again.session, low.session, "a new session per attempt");
    lp.shutdown().unwrap();
}

#[test]
fn test_parked_after_important() {
    // p = 2i + u: 9 (u3 i3) is at the cutoff 7; 5 (u1 i2) is parked even when older.
    let l = listing(
        &[
            (
                "intents/260901-0900-parked",
                &intent_md("web", "u: 1\ni: 2\n", "Parked"),
            ),
            ("intents/261005-0900-plain", &intent_md("api", "", "Plain")),
        ],
        &[],
    );
    assert_eq!(
        decide(&l, &state(&["web", "api"])).pick.as_deref(),
        Some("261005-0900")
    );
    // The important one skipped (its repo full): the parked one is next.
    let mut s = state(&["web", "api"]);
    s.full.insert("api".into(), (1, 1));
    let d = decide(&l, &s);
    assert_eq!(d.pick.as_deref(), Some("260901-0900"));
    assert_eq!(
        d.skipped,
        vec![(
            "261005-0900".into(),
            Skip::Full {
                repo: "api".into(),
                n: 1,
                workers: 1
            }
        )]
    );
    // A higher cutoff parks both: PRI-4 order among the parked.
    let mut s = state(&["web", "api"]);
    s.cutoff = 15;
    assert_eq!(decide(&l, &s).pick.as_deref(), Some("261005-0900"));
    // Nothing important, the parked one runs.
    let only = listing(
        &[(
            "intents/260901-0900-parked",
            &intent_md("web", "u: 1\ni: 1\n", "Parked"),
        )],
        &[],
    );
    assert_eq!(
        decide(&only, &state(&["web"])).pick.as_deref(),
        Some("260901-0900")
    );
}

#[test]
fn test_bad_after() {
    let l = listing(
        &[
            (
                "intents/261001-0900-unknown",
                &intent_md("web", "after: [260101-0101]\n", "Unknown"),
            ),
            (
                "intents/261001-0901-dropped",
                &intent_md("web", "after: [260901-0900]\n", "Dropped"),
            ),
            (
                "intents/261001-0902-a",
                &intent_md("web", "after: [261001-0903]\n", "A"),
            ),
            (
                "intents/261001-0903-b",
                &intent_md("web", "after: [261001-0902]\n", "B"),
            ),
            (
                "intents/261001-0904-self",
                &intent_md("web", "after: [261001-0904]\n", "Self"),
            ),
            (
                "intents/261001-0905-fine",
                &intent_md("web", "after: [260902-0900]\n", "Fine"),
            ),
            (
                "intents/261001-0906-waits",
                &intent_md("web", "after: [261001-0905]\n", "Waits"),
            ),
            (
                "intents/261001-0907-two",
                &intent_md(
                    "web",
                    "after: [260101-0102, 260101-0101, 260902-0900]\n",
                    "Two",
                ),
            ),
        ],
        &[
            (
                "done/260901-0900-gone",
                &intent_md("web", "stage: dropped\n", "Gone"),
            ),
            (
                "done/260902-0900-did",
                &intent_md("web", "stage: done\n", "Did"),
            ),
        ],
    );
    let bad = pick::bad_after(&l);
    let want: Vec<(String, Vec<String>)> = [
        ("261001-0900", vec!["260101-0101"]),
        ("261001-0901", vec!["260901-0900"]),
        ("261001-0902", vec!["261001-0903"]),
        ("261001-0903", vec!["261001-0902"]),
        ("261001-0904", vec!["261001-0904"]),
        ("261001-0907", vec!["260101-0101", "260101-0102"]),
    ]
    .iter()
    .map(|(i, v)| (i.to_string(), v.iter().map(|s| s.to_string()).collect()))
    .collect();
    let mut got = bad.clone();
    got.sort();
    assert_eq!(got, want);
    let d = decide(&l, &state(&["web"]));
    assert_eq!(
        d.pick.as_deref(),
        Some("261001-0905"),
        "after: on a done intent is met"
    );
    assert!(d.writes.contains(&(
        "261001-0907".into(),
        Waiting::BadAfter,
        "260101-0101, 260101-0102".into()
    )));
    assert!(d.skipped.contains(&(
        "261001-0907".into(),
        Skip::BadAfter(vec!["260101-0101".into(), "260101-0102".into()])
    )));
    assert_eq!(
        Skip::BadAfter(vec!["260101-0101".into(), "260101-0102".into()]).to_string(),
        "bad after: 260101-0101, 260101-0102"
    );
    // `--intent` and `step` write only their own intent's wait.
    let (d, _) = pick::decide_for(&l, &state(&["web"]), "261001-0905");
    assert!(d.writes.is_empty(), "{:?}", d.writes);
    let (d, r) = pick::decide_for(&l, &state(&["web"]), "261001-0907");
    assert_eq!(
        d.writes
            .iter()
            .map(|(i, _, _)| i.as_str())
            .collect::<Vec<_>>(),
        ["261001-0907"]
    );
    assert_eq!(r, Err("bad after: 260101-0101, 260101-0102".into()));
    // A legacy id is done.
    let mut legacy = listing(
        &[(
            "intents/261001-0900-x",
            &intent_md("web", "after: [250101-0101]\n", "X"),
        )],
        &[],
    );
    legacy.legacy = "- 250101-0101 web: old\n".into();
    assert!(pick::bad_after(&legacy).is_empty());

    // Through the loop: `waiting: bad after:` on the intent, one outbox row keyed by the ids.
    let mut w = World::new(
        &[
            intent_file(
                "261001-0900-unknown",
                "web",
                "after: [260101-0101]\n",
                "Unknown",
            ),
            intent_file("261001-0901-next", "web", "u: 1\ni: 1\n", "Next"),
        ],
        &["web"],
    );
    let mut lp = w.open(handlers());
    w.pass(&mut lp);
    let md = w.intent_md("261001-0900-unknown");
    assert!(
        md.contains("waiting: \"bad after:\"") || md.contains("waiting: 'bad after:'"),
        "{md}"
    );
    assert!(w.missions("261001-0900").is_empty(), "never a mission");
    assert_eq!(
        w.mission("261001-0901").stage,
        Stage::Pick,
        "the next one is picked"
    );
    // (Next is parked and nothing was ever reviewed: PRI-8's message too.)
    let rows: Vec<_> = w
        .outbox()
        .into_iter()
        .filter(|r| r.1 != "review_due")
        .collect();
    assert_eq!(rows.len(), 1);
    let (key, event, n, text) = &rows[0];
    assert_eq!(
        (key.as_str(), event.as_str(), n.as_str()),
        ("intent:261001-0900", "bad_after", "260101-0101")
    );
    assert!(
        text.starts_with("bad after:\n261001-0900 web: Unknown\nbad after: 260101-0101\n"),
        "{text}"
    );
    // I remove `waiting` without a fix: written again, no new message.
    w.intents.push_mine(
        &[(
            "intents/261001-0900-unknown/intent.md",
            Some(&intent_md("web", "after: [260101-0101]\n", "Unknown")),
        )],
        "continue",
    );
    w.pass(&mut lp);
    w.pass(&mut lp);
    assert!(w.intent_md("261001-0900-unknown").contains("bad after:"));
    assert_eq!(w.outbox().len(), 2, "bad after and review due, once each");
    lp.shutdown().unwrap();
}

#[test]
fn test_unknown_repo() {
    let mut w = World::new(
        &[
            intent_file("261001-0900-lost", "nowhere", "u: 5\ni: 5\n", "Lost"),
            intent_file("261001-0901-found", "web", "", "Found"),
        ],
        &["web"],
    );
    let mut lp = w.open(handlers());
    w.pass(&mut lp);
    assert!(
        w.intent_md("261001-0900-lost")
            .contains("waiting: unknown repo")
    );
    assert!(w.missions("261001-0900").is_empty());
    assert_eq!(w.mission("261001-0901").stage, Stage::Pick);
    let rows = w.outbox();
    assert_eq!(rows.len(), 1);
    let (key, event, n, text) = &rows[0];
    assert_eq!(
        (key.as_str(), event.as_str(), n.as_str()),
        ("intent:261001-0900", "unknown_repo", "nowhere")
    );
    assert_eq!(
        text.lines().take(3).collect::<Vec<_>>(),
        [
            "unknown repo",
            "261001-0900 nowhere: Lost",
            "unknown repo nowhere"
        ]
    );
    assert!(
        text.ends_with("\nintent intents/261001-0900-lost/intent.md"),
        "a remote off GitHub: the path. {text}"
    );
    lp.shutdown().unwrap();
}

#[test]
fn test_orphan_staged_intent() {
    let mut w = World::new(
        &[
            intent_file("261001-0900-orphan", "web", "stage: build\n", "Orphan"),
            intent_file(
                "261001-0901-retry",
                "web",
                "u: 1\ni: 1\nstage: test\nwaiting: CI red\nretry: fresh\n",
                "Retry",
            ),
            intent_file(
                "261001-0902-asks",
                "web",
                "u: 1\ni: 1\nstage: test\nwaiting: call me\n",
                "Asks",
            ),
            intent_file(
                "261001-0903-later",
                "web",
                "u: 1\ni: 1\nstage: test\nwaiting: call me\nretry: later\n",
                "Later",
            ),
        ],
        &["web"],
    );
    let mut lp = w.open(handlers());
    w.pass(&mut lp);
    // No mission: `stage` removed (accepted again), then picked.
    let log = w.intents.log();
    assert!(
        log.contains(&"towercab: unstage 261001-0900".to_string()),
        "{log:?}"
    );
    assert!(log.contains(&"towercab: unstage 261001-0901".to_string()));
    let md = w.intent_md("261001-0901-retry");
    assert!(
        !md.contains("stage:") && !md.contains("retry:") && !md.contains("waiting:"),
        "{md}"
    );
    // A waiting intent keeps its stage until I answer; only `retry: fresh` unstages one.
    assert!(w.intent_md("261001-0902-asks").contains("stage: test"));
    assert!(w.intent_md("261001-0903-later").contains("stage: test"));
    assert_eq!(w.mission("261001-0900").stage, Stage::Pick);

    // `retry: fresh` with an unfinished mission: retry_fresh → this attempt stopped, attempt 2
    // at pick on `-2`, `retry` removed.
    w.until(&mut lp, 10, |w| {
        w.mission("261001-0900").stage == Stage::Build
    });
    let first = w.mission("261001-0900");
    w.intents.push_mine(
        &[(
            "intents/261001-0900-orphan/intent.md",
            Some(&intent_md("web", "stage: build\nretry: fresh\n", "Orphan")),
        )],
        "retry",
    );
    w.pass(&mut lp);
    let ms = w.missions("261001-0900");
    assert_eq!(ms.len(), 2);
    assert_eq!(ms[0].stage, Stage::Stopped);
    assert_eq!(ms[0].why.as_deref(), Some("replaced by attempt 2"));
    assert!(
        !w.home.root.join(&first.checkout).exists(),
        "old checkout deleted"
    );
    assert_eq!(ms[1].attempt, 2);
    assert_eq!(
        ms[1].branch.as_deref(),
        Some("towercab/261001-0900-orphan-2")
    );
    assert_ne!(ms[1].session, ms[0].session);
    let md = w.intent_md("261001-0900-orphan");
    assert!(!md.contains("retry:"), "{md}");
    assert!(md.contains("stage: design"), "{md}");
    let fresh = w
        .transitions("261001-0900")
        .into_iter()
        .filter(|(_, e, _)| e == "retry_fresh")
        .count();
    assert_eq!(fresh, 1, "raised once");
    w.pass(&mut lp);
    assert_eq!(w.missions("261001-0900").len(), 2);
    lp.shutdown().unwrap();
}

#[test]
fn test_pick_skips() {
    let l = listing(
        &[
            (
                "intents/261001-0900-web",
                &intent_md("web", "u: 5\ni: 5\n", "Web"),
            ),
            (
                "intents/261001-0901-api",
                &intent_md("api", "u: 4\ni: 4\nmodel: sonnet\n", "Api"),
            ),
            ("intents/261001-0902-cli", &intent_md("cli", "", "Cli")),
        ],
        &[],
    );
    let all = ["web", "api", "cli"];
    let ids = ["261001-0900", "261001-0901", "261001-0902"];
    let every = |skip: Skip| -> Vec<(String, Skip)> {
        ids.iter().map(|i| (i.to_string(), skip.clone())).collect()
    };
    for (s, skip, text) in [
        (
            PickState {
                paused: true,
                ..state(&all)
            },
            Skip::Paused,
            "paused",
        ),
        (
            PickState {
                env_blocked: true,
                ..state(&all)
            },
            Skip::EnvBlocked,
            "env blocked",
        ),
        (
            PickState {
                built: false,
                ..state(&all)
            },
            Skip::NotBuilt,
            "picks off: pipeline not built",
        ),
    ] {
        let d = decide(&l, &s);
        assert_eq!(d.pick, None);
        assert_eq!(d.skipped, every(skip.clone()));
        assert_eq!(skip.to_string(), text);
    }
    let mut s = state(&all);
    s.frozen = BTreeSet::from(["web".to_string()]);
    s.full = BTreeMap::from([("api".to_string(), (2, 2))]);
    let d = decide(&l, &s);
    assert_eq!(d.pick.as_deref(), Some("261001-0902"));
    assert_eq!(
        d.skipped
            .iter()
            .map(|(i, s)| format!("{i} {s}"))
            .collect::<Vec<_>>(),
        [
            "261001-0900 repo web frozen",
            "261001-0901 repo api full (2/2)"
        ]
    );
    // A model cooling down: its intents wait, others run.
    let mut s = state(&all);
    s.cooling = BTreeMap::from([("opus".to_string(), "15:30".to_string())]);
    let d = decide(&l, &s);
    assert_eq!(
        d.pick.as_deref(),
        Some("261001-0901"),
        "sonnet isn't cooling"
    );
    assert_eq!(
        d.skipped,
        vec![(
            "261001-0900".into(),
            Skip::Cooling {
                model: "opus".into(),
                until: "15:30".into()
            }
        )]
    );
    assert_eq!(d.skipped[0].1.to_string(), "opus cooling until 15:30");
    assert_eq!(
        decide(&listing(&[], &[]), &state(&all)),
        Decision::default()
    );

    // The loop's state: paused (meta), frozen (repo_caps), full (unfinished per repo, blocked
    // not counted), cooling (cooldowns), built (Handlers).
    let w = World::new(
        &[intent_file("261001-0900-web", "web", "", "Web")],
        &["web", "api"],
    );
    let lp = w.open(Handlers::picks_off());
    let db = w.db();
    db.set_meta("paused", "1").unwrap();
    db.conn()
        .execute_batch(
            "INSERT INTO repo_caps (repo, frozen, why, since) VALUES ('api', 1, 'revert failed', 0);
             INSERT INTO cooldowns (provider, model, until, parsed, text, since)
               VALUES ('claude', 'opus', 9999999999, 1, 'limit', 0), ('claude', 'haiku', 1, 1, 'old', 0);
             INSERT INTO missions (intent, repo, stage, model, session, checkout, created, updated)
               VALUES ('261001-0901', 'web', 'ci', 'opus', 's', 'work/x', 0, 0),
                      ('261001-0902', 'api', 'blocked', 'opus', 's', 'work/y', 0, 0);",
        )
        .unwrap();
    let s = lp.pick_state(w.clock).unwrap();
    assert!(s.paused);
    assert!(!s.built, "production handlers: picks off");
    assert_eq!(s.frozen, BTreeSet::from(["api".to_string()]));
    assert_eq!(s.full, BTreeMap::from([("web".to_string(), (1, 1))]));
    assert_eq!(s.cooling.keys().collect::<Vec<_>>(), ["opus"]);
    assert_eq!(
        s.repos,
        BTreeSet::from(["api".to_string(), "web".to_string()])
    );
    assert!(Handlers::stubs().built());
}

#[test]
fn test_pick_step_repo_files() {
    let mut w = World::new(
        &[
            intent_file("261001-0900-a", "web", "u: 5\ni: 5\n", "A"),
            intent_file("261001-0901-b", "api", "", "B"),
            intent_file("261001-0902-c", "cli", "u: 1\ni: 1\n", "C"),
            intent_file("261001-0903-d", "docs", "u: 1\ni: 1\n", "D"),
        ],
        &["web", "api", "cli", "docs"],
    );
    // web: no verifying block; api: a bad TOWERCAB.md; cli: its origin refuses connections;
    // docs: its path isn't a clone.
    let web = w.mine("web");
    write(&web, "CLAUDE.md", "# Web\n");
    git(&web, &["commit", "--quiet", "-am", "no block"]);
    git(&web, &["push", "--quiet", "origin", "HEAD:main"]);
    let api = w.mine("api");
    write(&api, "TOWERCAB.md", "---\nmax_autonomy: 9\n---\n");
    git(&api, &["add", "-A"]);
    git(&api, &["commit", "--quiet", "-m", "bad"]);
    git(&api, &["push", "--quiet", "origin", "HEAD:main"]);
    git(
        &w.clone_path("cli"),
        &["remote", "set-url", "origin", "http://127.0.0.1:1/cli.git"],
    );
    let docs = w.clone_path("docs");
    std::fs::remove_dir_all(&docs).unwrap();
    write(&docs, "README.md", "not a clone\n");
    let mut lp = w.open(handlers());
    w.until(&mut lp, 6, |w| {
        w.stage("261001-0900") == Some(Stage::Blocked)
    });
    let a = w.mission("261001-0900");
    assert_eq!(a.waiting.as_deref(), Some("add CLAUDE.md verifying block"));
    assert_eq!(a.from_stage, Some(Stage::Pick));
    assert!(
        w.intent_md("261001-0900-a")
            .contains("waiting: add CLAUDE.md verifying block")
    );
    w.until(&mut lp, 6, |w| {
        w.stage("261001-0901") == Some(Stage::Blocked)
    });
    let b = w.mission("261001-0901");
    assert_eq!(b.waiting.as_deref(), Some("fix repo files"));
    assert!(
        b.why.as_deref().unwrap().starts_with("TOWERCAB.md: "),
        "{:?}",
        b.why
    );
    // A network failure: backoff, the mission stays at pick.
    w.until(&mut lp, 6, |w| {
        w.missions("261001-0902")
            .last()
            .is_some_and(|m| m.retries > 0)
    });
    let c = w.mission("261001-0902");
    assert_eq!(c.stage, Stage::Pick);
    assert!(c.retry_at.unwrap() > w.clock.unix());
    let events: Vec<String> = w
        .transitions("261001-0902")
        .into_iter()
        .map(|t| t.1)
        .collect();
    assert_eq!(events, ["env_fail"]);
    // Not a clone: no outage but a bug, counted; the third → crashed at pick.
    w.until(&mut lp, 12, |w| {
        w.stage("261001-0903") == Some(Stage::Blocked)
    });
    let d = w.mission("261001-0903");
    assert_eq!(d.waiting.as_deref(), Some("crashed at pick"));
    assert_eq!(d.retries, 0);
    // Continuing from `add CLAUDE.md verifying block` goes back to pick, which passes once fixed.
    write(&web, "CLAUDE.md", common::world::CLAUDE);
    git(&web, &["commit", "--quiet", "-am", "block"]);
    git(&web, &["push", "--quiet", "origin", "HEAD:main"]);
    w.intents.push_mine(
        &[(
            "intents/261001-0900-a/intent.md",
            Some(&intent_md("web", "u: 5\ni: 5\nstage: design\n", "A")),
        )],
        "fixed",
    );
    w.until(&mut lp, 8, |w| w.stage("261001-0900") == Some(Stage::Plan));
    assert_eq!(
        w.mission("261001-0900").intent.as_deref(),
        Some("261001-0900")
    );
    let _ = Playbook::Design;
    lp.shutdown().unwrap();
}
