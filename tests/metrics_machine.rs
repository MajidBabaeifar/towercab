//! What `machine::apply`'s transitions say (MET-14, 15, 17, 24, 25, 26): missions driven
//! through the machine on a temp database, the records read back from this thread's buffer.

mod common;

use std::time::Duration;

use chrono::{DateTime, TimeDelta};
use serde_json::json;
use tempfile::TempDir;
use towercab::config::{Config, IntentsConfig};
use towercab::db::Db;
use towercab::env::Fault;
use towercab::handler::Outcome;
use towercab::indicators;
use towercab::intents::Listing;
use towercab::limits::Limit;
use towercab::machine::{self, Apply, Door, Event, Stage, Waiting};
use towercab::metrics::{self, Metric, Record};
use towercab::mission::{self, Mission, NewMission};
use towercab::runloop::Tick;

const STARTED: &str = "2026-10-15T12:00:00+02:00";

struct M {
    _tmp: TempDir,
    db: Db,
    config: Config,
    listing: Listing,
    t: Tick,
}

impl M {
    /// Intents `261001-090<n>` (`extra` front matter each) on repo `web`; the clock at
    /// 2026-10-15 13:30 +02:00.
    fn new(extras: &[&str]) -> M {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("towercab.db")).unwrap();
        let config = Config::new(
            tmp.path().join("config.toml"),
            IntentsConfig {
                remote: None,
                path: tmp.path().join("intents"),
                cutoff: 7,
            },
        );
        let open = extras
            .iter()
            .enumerate()
            .map(|(n, extra)| {
                common::intent(
                    &format!("intents/261001-090{n}-x{n}"),
                    &common::intent_md("web", extra, &format!("X{n}")),
                )
            })
            .collect();
        metrics::take();
        M {
            _tmp: tmp,
            db,
            config,
            listing: Listing {
                open,
                done: Vec::new(),
                unreadable: Vec::new(),
                legacy: String::new(),
            },
            t: Tick {
                wall: DateTime::parse_from_rfc3339("2026-10-15T13:30:00+02:00").unwrap(),
                mono: Duration::from_secs(1000),
            },
        }
    }

    /// Intent `n`'s mission, picked now.
    fn pick(&self, n: usize) -> Mission {
        let new = NewMission {
            intent: format!("261001-090{n}"),
            slug: format!("x{n}"),
            repo: "web".into(),
            model: "opus".into(),
            a: None,
            min_attempt: 1,
        };
        let t = self.t;
        self.db.tx(|tx| mission::insert(tx, &new, t)).unwrap()
    }

    /// `secs` later, `o` applied to `m`.
    fn apply(&mut self, m: &Mission, o: Outcome, secs: u64) -> Mission {
        self.t = self.t.after(Duration::from_secs(secs));
        let ax = Apply {
            db: &self.db,
            config: &self.config,
            listing: Some(&self.listing),
            tick: self.t,
        };
        let out = machine::apply(&ax, m, &o).unwrap();
        // The loop runs the entry effects; their metrics need git (tests/metrics_pipe.rs).
        self.db
            .conn()
            .execute("UPDATE missions SET step = '' WHERE id = ?1", [out.id])
            .unwrap();
        mission::get(self.db.conn(), out.id).unwrap()
    }

    /// `ok` every `secs` until `m` is at `stage`.
    fn ok_to(&mut self, mut m: Mission, stage: Stage, secs: u64) -> Mission {
        while m.stage != stage {
            m = self.apply(&m, Outcome::ok(), secs);
        }
        m
    }

    fn unix(&self) -> f64 {
        self.t.unix()
    }
}

/// The records of `metric` whose labels include `labels`.
fn find<'a>(recs: &'a [Record], metric: Metric, labels: &[(&str, &str)]) -> Vec<&'a Record> {
    recs.iter()
        .filter(|r| r.metric == metric && labels.iter().all(|(k, v)| r.label(k) == Some(*v)))
        .collect()
}

/// Their values.
fn values(recs: &[Record], metric: Metric, labels: &[(&str, &str)]) -> Vec<f64> {
    find(recs, metric, labels).iter().map(|r| r.value).collect()
}

fn sum(recs: &[Record], metric: Metric, labels: &[(&str, &str)]) -> f64 {
    values(recs, metric, labels).iter().sum()
}

/// No record carries the intent as a label (MET-18).
fn no_intent_label(recs: &[Record]) {
    for r in recs {
        assert!(r.label("intent_id").is_none(), "{r:?}");
        assert!(
            !r.labels.values().any(|v| v.starts_with("261001-")),
            "{r:?}"
        );
    }
}

#[test]
fn test_stage_metric() {
    let mut w = M::new(&[""]);
    let m = w.pick(0);
    let m = w.apply(&m, Outcome::ok(), 10);
    let m = w.apply(&m, Outcome::wait(Waiting::ApproveSpec, "concerns"), 20);
    assert_eq!(m.stage, Stage::ApprovalSpec);
    let m = w.apply(&m, Outcome::event(Event::Approve), 100);
    assert_eq!(m.stage, Stage::Plan);
    let limit = Limit {
        model: "opus".into(),
        reset: None,
        text: "limit".into(),
    };
    let m = w.apply(&m, Outcome::limit(limit), 30);
    let m = w.apply(&m, Outcome::ok(), 40);
    let m = w.apply(&m, Outcome::env(Fault::Github, "down"), 5);
    let m = w.apply(&m, Outcome::ok(), 15);
    let m = w.apply(&m, Outcome::red("checks red"), 7);
    assert_eq!(m.stage, Stage::Build);
    let m = w.apply(&m, Outcome::timeout(), 3);
    let m = w.apply(&m, Outcome::bad_result("no JSON"), 2);
    let m = w.apply(&m, Outcome::ok(), 4);
    let m = w.ok_to(m, Stage::Ci, 1);
    let m = w.apply(&m, Outcome::event(Event::Feedback), 9);
    assert_eq!(m.stage, Stage::Build);
    // A red at build is no transition the table has: Unexpected, counted as a crash.
    let m = w.apply(&m, Outcome::red("?"), 2);
    assert_eq!((m.stage, m.unclean), (Stage::Build, 1));
    let m = w.apply(&m, Outcome::event(Event::Interrupted), 6);
    let _ = m;

    let recs = metrics::take();
    let got: Vec<(String, String, f64)> = find(&recs, Metric::StageDuration, &[])
        .iter()
        .map(|r| {
            assert_eq!(r.label("repo"), Some("web"));
            (
                r.label("stage").unwrap().to_string(),
                r.label("result").unwrap().to_string(),
                r.value,
            )
        })
        .collect();
    let want: Vec<(String, String, f64)> = [
        ("pick", "ok", 10.0),
        ("design", "blocked", 20.0),
        // approval:spec isn't driven: its wait is gate.wait.duration.
        ("plan", "limit", 30.0),
        ("plan", "ok", 40.0),
        // env_fail ends no segment: build's runs 5 + 15 s.
        ("build", "ok", 20.0),
        ("verify", "red", 7.0),
        ("build", "timeout", 3.0),
        ("build", "timeout", 2.0),
        ("build", "ok", 4.0),
        ("verify", "ok", 1.0),
        ("proof", "ok", 1.0),
        ("publish", "ok", 1.0),
        ("ci", "interrupted", 9.0),
        ("build", "crash", 2.0),
        ("build", "interrupted", 6.0),
    ]
    .iter()
    .map(|(s, r, v)| (s.to_string(), r.to_string(), *v))
    .collect();
    assert_eq!(got, want);
    assert_eq!(
        values(&recs, Metric::GateWaitDuration, &[("gate", "spec")]),
        [100.0]
    );
    // Events carry the intent (MET-18), labels never.
    let r = find(&recs, Metric::StageDuration, &[])[0];
    assert_eq!(r.ev.intent.as_deref(), Some("261001-0900"));
    assert_eq!(r.ev.stage.as_deref(), Some("pick"));
    no_intent_label(&recs);
}

/// Through `merge` (Towercab's, gate `a4`) to `deploy`, 10 s a stage.
fn to_deploy(w: &mut M, m: Mission) -> Mission {
    let m = w.ok_to(m, Stage::Ci, 10);
    let m = w.apply(
        &m,
        Outcome::ok().with("data", json!({"ci": {"result": "green"}}).to_string()),
        10,
    );
    let m = w.ok_to(m, Stage::Gate, 10);
    let mut data: serde_json::Value = serde_json::from_str(&m.data).unwrap();
    data["gate"] = json!({"label": "a4"});
    let m = w.apply(&m, Outcome::ok().with("data", data.to_string()), 10);
    let m = w.apply(
        &m,
        Outcome::ok()
            .with("merged_by", "towercab".to_string())
            .with("merge_sha", "m3rg3".to_string())
            .with("cost_usd", 1.5),
        10,
    );
    assert_eq!(m.stage, Stage::Deploy);
    m
}

/// From `e2e` red twice (Towercab's merge) through the revert to `reverted, refine`.
fn reverted(w: &mut M, m: Mission) -> Mission {
    let m = w.apply(&m, Outcome::red("e2e red twice"), 10);
    assert_eq!(m.stage, Stage::Rollback);
    let m = w.ok_to(m, Stage::RevertE2e, 10);
    let m = w.apply(&m, Outcome::wait(Waiting::RevertedRefine, "e2e green"), 10);
    assert_eq!(m.stage, Stage::Blocked);
    m
}

#[test]
fn test_intent_metric() {
    let mut w = M::new(&[
        &format!("source: issue:https://github.com/me/web/issues/3\nstarted: {STARTED}\n"),
        "",
        "source: alert:ci_failure_rate\n",
        "source: review:7,9\n",
    ]);
    // Done: lead from `started`, cycle from the pick.
    let a = w.pick(0);
    let picked = w.unix();
    let a = to_deploy(&mut w, a);
    let a = w.ok_to(a, Stage::Done, 10);
    let done = w.unix();
    let _ = a;
    let recs = metrics::take();
    let started = DateTime::parse_from_rfc3339(STARTED).unwrap().timestamp() as f64;
    let base = [
        ("repo", "web"),
        ("source", "issue"),
        ("outcome", "done"),
        ("merged_by", "towercab"),
        ("gate", "a4"),
    ];
    let with = |kind: &str| {
        let mut l = base.to_vec();
        l.push(("kind", kind));
        values(&recs, Metric::IntentDuration, &l)
    };
    assert_eq!(with("lead"), [done - started]);
    assert_eq!(with("cycle"), [done - picked]);
    assert_eq!(
        values(
            &recs,
            Metric::IntentCost,
            &[("repo", "web"), ("outcome", "done")]
        ),
        [1.5]
    );
    assert_eq!(find(&recs, Metric::IntentDuration, &[]).len(), 2);

    // Closed by `pr_closed`; no `started`: lead from the id's time (`261001-0901`: 09:01).
    let b = w.pick(1);
    let b = w.ok_to(b, Stage::Ci, 10);
    let b = w.apply(&b, Outcome::event(Event::PrClosed), 10);
    assert_eq!(b.stage, Stage::Stopped);
    let recs = metrics::take();
    let id_time = DateTime::parse_from_rfc3339("2026-10-01T09:01:00+02:00")
        .unwrap()
        .timestamp() as f64;
    let l = [
        ("source", "me"),
        ("outcome", "closed"),
        ("merged_by", "none"),
        ("gate", "none"),
        ("kind", "lead"),
    ];
    assert_eq!(
        values(&recs, Metric::IntentDuration, &l),
        [w.unix() - id_time]
    );

    // Reverted: counted entering `reverted, refine`, not again when its fresh attempt
    // replaces it.
    let c = w.pick(2);
    let c = to_deploy(&mut w, c);
    let c = w.ok_to(c, Stage::E2e, 10);
    let c = reverted(&mut w, c);
    let c = w.apply(&c, Outcome::event(Event::Approve), 10);
    assert_eq!(c.stage, Stage::Stopped);
    let recs = metrics::take();
    assert_eq!(
        values(
            &recs,
            Metric::IntentDuration,
            &[
                ("source", "alert"),
                ("outcome", "reverted"),
                ("kind", "cycle")
            ]
        )
        .len(),
        1
    );
    assert_eq!(find(&recs, Metric::IntentDuration, &[]).len(), 2);

    // Stopped: `retry --fresh` replaces it.
    let d = w.pick(3);
    let d = w.ok_to(d, Stage::Build, 10);
    let d = w.apply(&d, Outcome::event(Event::RetryFresh), 10);
    assert_eq!(d.stage, Stage::Stopped);
    let recs = metrics::take();
    assert_eq!(
        values(
            &recs,
            Metric::IntentDuration,
            &[("source", "review"), ("outcome", "stopped")]
        )
        .len(),
        2
    );
    no_intent_label(&recs);
}

#[test]
fn test_counters() {
    let mut w = M::new(&["", "", ""]);
    // CI: green the first time → first; a repair; flaky after it → not first.
    let a = w.pick(0);
    let a = w.ok_to(a, Stage::Ci, 10);
    let a = w.apply(&a, Outcome::red("CI red: test"), 10);
    assert_eq!(a.stage, Stage::Build);
    let a = w.ok_to(a, Stage::Ci, 10);
    let a = w.apply(
        &a,
        Outcome::ok().with("data", json!({"ci": {"result": "flaky"}}).to_string()),
        10,
    );
    // Stuck on the next head: timeout; red at the cap: red, mine to fix.
    let b = w.pick(1);
    let b = w.ok_to(b, Stage::Ci, 10);
    let b = w.apply(&b, Outcome::wait(Waiting::CiStuck, "pending 30 min"), 10);
    let b = w.apply(&b, Outcome::event(Event::Approve), 10);
    assert_eq!(b.stage, Stage::Ci);
    let b = w.apply(&b, Outcome::wait(Waiting::CiRed, "3 repairs"), 10);
    let _ = (a, b);
    let recs = metrics::take();
    let ci = |result: &str, first: &str| {
        sum(
            &recs,
            Metric::CiResult,
            &[("repo", "web"), ("result", result), ("first", first)],
        )
    };
    assert_eq!(ci("red", "yes"), 1.0);
    assert_eq!(ci("flaky", "no"), 1.0);
    assert_eq!(ci("timeout", "yes"), 1.0);
    assert_eq!(ci("red", "no"), 1.0);
    assert_eq!(find(&recs, Metric::CiResult, &[]).len(), 4);
    assert_eq!(sum(&recs, Metric::CiRepairs, &[("repo", "web")]), 1.0);
    assert_eq!(sum(&recs, Metric::CiTriage, &[("by", "worker")]), 1.0);
    assert_eq!(sum(&recs, Metric::CiTriage, &[("by", "me")]), 1.0);

    // Reverts: ok, and failed (the repo freezes).
    let c = w.pick(2);
    let c = to_deploy(&mut w, c);
    let c = w.ok_to(c, Stage::E2e, 10);
    let c = reverted(&mut w, c);
    let _ = c;
    let recs = metrics::take();
    assert_eq!(
        sum(
            &recs,
            Metric::Reverts,
            &[("repo", "web"), ("merged_by", "towercab"), ("result", "ok")]
        ),
        1.0
    );
    let mut w = M::new(&[""]);
    let d = w.pick(0);
    let d = to_deploy(&mut w, d);
    let d = w.ok_to(d, Stage::E2e, 10);
    let d = w.apply(&d, Outcome::red("e2e red twice"), 10);
    let d = w.ok_to(d, Stage::RevertCi, 10);
    let d = w.apply(&d, Outcome::wait(Waiting::RevertFailed, "CI red"), 10);
    assert_eq!(d.stage, Stage::Blocked);
    let recs = metrics::take();
    assert_eq!(sum(&recs, Metric::Reverts, &[("result", "failed")]), 1.0);
    assert_eq!(
        values(
            &recs,
            Metric::IntentDuration,
            &[("outcome", "revert_failed")]
        )
        .len(),
        2
    );
    // Continued and reverted after all: the revert counts, the mission's end doesn't again.
    let d = w.apply(&d, Outcome::event(Event::Approve), 10);
    assert_eq!(d.stage, Stage::RevertCi);
    let d = w.ok_to(d, Stage::RevertE2e, 10);
    let d = w.apply(&d, Outcome::wait(Waiting::RevertedRefine, "e2e green"), 10);
    assert_eq!(d.stage, Stage::Blocked);
    let recs = metrics::take();
    assert_eq!(sum(&recs, Metric::Reverts, &[("result", "ok")]), 1.0);
    assert!(find(&recs, Metric::IntentDuration, &[]).is_empty());
    assert!(find(&recs, Metric::IntentCost, &[]).is_empty());

    // Usage limits: a wait starts (reset + 30 s); a later limit while it runs lengthens it.
    let mut w = M::new(&[""]);
    let m = w.pick(0);
    let m = w.ok_to(m, Stage::Build, 10);
    let now = w.t.wall.with_timezone(&chrono::Utc) + TimeDelta::seconds(10);
    let limit = |secs: i64| Limit {
        model: "opus".into(),
        reset: Some(now + TimeDelta::seconds(secs)),
        text: "limit".into(),
    };
    let m = w.apply(&m, Outcome::limit(limit(3600)), 10);
    let m = w.apply(&m, Outcome::limit(limit(4200)), 0);
    let _ = m;
    let recs = metrics::take();
    assert_eq!(
        values(&recs, Metric::UsageLimitWaits, &[("model", "opus")]),
        [1.0]
    );
    assert_eq!(
        values(&recs, Metric::UsageLimitWaitDuration, &[("model", "opus")]),
        [3630.0, 600.0]
    );
    // Labelled by model only.
    for r in find(&recs, Metric::UsageLimitWaits, &[]) {
        assert_eq!(r.labels.len(), 1);
    }
    no_intent_label(&recs);
}

#[test]
fn test_build_metrics() {
    let mut w = M::new(&["", ""]);
    // First pass: nothing sent back; plan → merge.
    let a = w.pick(0);
    let a = w.ok_to(a, Stage::Build, 10);
    let plan_done = w.unix();
    let a = to_deploy(&mut w, a);
    let merged = w.unix();
    let _ = a;
    let recs = metrics::take();
    assert_eq!(sum(&recs, Metric::FirstPass, &[("result", "yes")]), 1.0);
    assert_eq!(
        values(&recs, Metric::ReworkCycles, &[("repo", "web")]),
        [0.0]
    );
    assert_eq!(
        values(&recs, Metric::PlanToMergeDuration, &[("repo", "web")]),
        [merged - plan_done]
    );
    assert_eq!(
        sum(&recs, Metric::PlanResult, &[("result", "followed")]),
        1.0
    );

    // Rounds: verify red, CI red, my feedback (resolved by the worker), a conflict, my
    // feedback again with my push (resolved by me); the build rewrote plan.md; I merge.
    let b = w.pick(1);
    let b = w.ok_to(b, Stage::Verify, 10);
    let b = w.apply(&b, Outcome::red("checks red"), 10);
    let b = w.ok_to(b, Stage::Ci, 10);
    let b = w.apply(&b, Outcome::red("CI red"), 10);
    let b = w.ok_to(b, Stage::Review, 10);
    let b = w.apply(&b, Outcome::event(Event::Feedback), 10);
    let b = w.ok_to(b, Stage::Ci, 10);
    let b = w.apply(&b, Outcome::event(Event::Conflict), 10);
    let b = w.ok_to(b, Stage::Gate, 10);
    let b = w.apply(&b, Outcome::wait(Waiting::ReviewAndMergePr, "a3"), 10);
    let b = w.apply(&b, Outcome::event(Event::Feedback), 10);
    let b = w.ok_to(b, Stage::Ci, 10);
    let b = w.apply(&b, Outcome::event(Event::HeadMoved), 10);
    let data =
        json!({"plan_updated": true, "review": {"result": {"plan_followed": {"followed": true}}}});
    let b = w.apply(&b, Outcome::ok().with("data", data.to_string()), 10);
    let b = w.ok_to(b, Stage::Gate, 10);
    let b = w.apply(&b, Outcome::wait(Waiting::ReviewAndMergePr, "a3"), 10);
    let b = w.apply(
        &b,
        Outcome::event(Event::PrMerged).with("merged_by", "human".to_string()),
        10,
    );
    assert_eq!(b.stage, Stage::Deploy);
    let recs = metrics::take();
    assert_eq!(sum(&recs, Metric::FirstPass, &[("result", "no")]), 1.0);
    assert_eq!(values(&recs, Metric::ReworkCycles, &[]), [5.0]);
    assert_eq!(
        sum(&recs, Metric::PlanResult, &[("result", "updated")]),
        1.0
    );
    assert_eq!(
        sum(&recs, Metric::FeedbackRounds, &[("resolved_by", "worker")]),
        1.0
    );
    assert_eq!(
        sum(&recs, Metric::FeedbackRounds, &[("resolved_by", "me")]),
        1.0
    );
    // Two waits for my merge.
    assert_eq!(
        values(&recs, Metric::GateWaitDuration, &[("gate", "merge")]),
        [10.0, 10.0]
    );

    // Plan drift: the review says the plan wasn't followed.
    let mut w = M::new(&[""]);
    let c = w.pick(0);
    let c = w.ok_to(c, Stage::Review, 10);
    let data =
        json!({"review": {"result": {"plan_followed": {"followed": false}}}, "plan_updated": true});
    let c = w.apply(&c, Outcome::ok().with("data", data.to_string()), 10);
    let c = w.ok_to(c, Stage::Merge, 10);
    let c = w.apply(&c, Outcome::ok(), 10);
    assert_eq!(c.stage, Stage::Deploy);
    let recs = metrics::take();
    assert_eq!(
        sum(&recs, Metric::PlanResult, &[("result", "drifted")]),
        1.0
    );
    no_intent_label(&recs);
}

#[test]
fn test_test_metrics() {
    // Escapes: a Towercab merge red twice, my merge red twice, production red.
    let mut w = M::new(&["", "", ""]);
    let a = w.pick(0);
    let a = to_deploy(&mut w, a);
    let a = w.ok_to(a, Stage::E2e, 10);
    let a = w.apply(&a, Outcome::red("e2e red twice"), 10);
    let b = w.pick(1);
    let b = to_deploy(&mut w, b);
    let b = w.ok_to(b, Stage::E2e, 10);
    let b = w.apply(
        &b,
        Outcome::wait(Waiting::E2eRedAfterYourMerge(Door::TwoWay), "red"),
        10,
    );
    let c = w.pick(2);
    let c = to_deploy(&mut w, c);
    let c = w.ok_to(c, Stage::Release, 10);
    let c = w.apply(&c, Outcome::wait(Waiting::ProductionE2eRed, "red"), 10);
    // My approve keeps them: no second escape.
    let b = w.apply(&b, Outcome::event(Event::Approve), 10);
    let c = w.apply(&c, Outcome::event(Event::Approve), 10);
    assert_eq!(
        (a.stage, b.stage, c.stage),
        (Stage::Rollback, Stage::Done, Stage::Done)
    );
    let recs = metrics::take();
    assert_eq!(
        values(&recs, Metric::Escapes, &[("repo", "web"), ("where", "e2e")]),
        [1.0, 1.0, 1.0]
    );
    // A wait that isn't one (deploy not seen) is no escape.
    let mut w = M::new(&[""]);
    let d = w.pick(0);
    let d = to_deploy(&mut w, d);
    let d = w.apply(&d, Outcome::wait(Waiting::DeployNotSeen, "15 min"), 10);
    let _ = d;
    assert!(find(&metrics::take(), Metric::Escapes, &[]).is_empty());
}

#[test]
fn test_change_failure_rate() {
    // Two merged intents, one found broken: 1 escape ÷ 2 merged = 50 %.
    let mut w = M::new(&["", ""]);
    let a = w.pick(0);
    let a = to_deploy(&mut w, a);
    let _ = w.ok_to(a, Stage::Done, 10);
    let b = w.pick(1);
    let b = to_deploy(&mut w, b);
    let b = w.ok_to(b, Stage::E2e, 10);
    let _ = reverted(&mut w, b);
    let recs = metrics::take();
    // MET-25: e2e escapes only (alert ones, MET-27, are counted apart).
    let escapes = sum(&recs, Metric::Escapes, &[("where", "e2e")]);
    let merged = find(&recs, Metric::IntentDuration, &[("kind", "lead")])
        .iter()
        .filter(|r| ["done", "reverted", "revert_failed"].contains(&r.label("outcome").unwrap()))
        .count() as f64;
    assert_eq!((escapes, merged), (1.0, 2.0));
    assert_eq!(escapes / merged, 0.5);
}

#[test]
fn test_deploy_metrics() {
    // review.findings' `pass` and `policy` are model-written: kept to the known names.
    let passes = ["Bugs", "Security"];
    assert_eq!(indicators::bounded(Some("bugs"), &passes), "Bugs");
    assert_eq!(indicators::bounded(Some("Security"), &passes), "Security");
    assert_eq!(
        indicators::bounded(Some("a long free text pass"), &passes),
        "other"
    );
    assert_eq!(indicators::bounded(None, &passes), "none");
    assert_eq!(indicators::bounded(Some(" "), &passes), "none");
    assert_eq!(indicators::bounded::<&str>(Some("secrets"), &[]), "other");

    let mut w = M::new(&["", ""]);
    // Time to first review: the PR ready (first exit from publish) → the first review.
    let a = w.pick(0);
    let a = w.ok_to(a, Stage::Ci, 10);
    let ready = w.unix();
    let a = w.ok_to(a, Stage::Review, 30);
    let a = w.apply(&a, Outcome::ok(), 20);
    let first_review = w.unix();
    let a = w.apply(&a, Outcome::wait(Waiting::ReviewAndMergePr, "a3"), 10);
    let a = w.apply(&a, Outcome::event(Event::Feedback), 3600);
    let a = w.ok_to(a, Stage::Review, 10);
    let a = w.apply(&a, Outcome::ok(), 10);
    let _ = a;
    // Waits on me by kind: an answer, a protected path, another.
    let b = w.pick(1);
    let b = w.ok_to(b, Stage::Build, 10);
    let b = w.apply(&b, Outcome::wait(Waiting::AnswerTheQuestion, "?"), 10);
    let b = w.apply(&b, Outcome::event(Event::Approve), 60);
    let b = w.ok_to(b, Stage::Publish, 10);
    let b = w.apply(&b, Outcome::wait(Waiting::ProtectedPathChanged, "ops/"), 10);
    let b = w.apply(&b, Outcome::event(Event::Approve), 120);
    let b = w.ok_to(b, Stage::Verify, 10);
    let b = w.apply(&b, Outcome::wait(Waiting::ChecksRed, "3 repairs"), 10);
    let b = w.apply(&b, Outcome::event(Event::Approve), 180);
    let _ = b;
    let recs = metrics::take();
    assert_eq!(
        values(&recs, Metric::ReviewFirstDuration, &[("repo", "web")]),
        [first_review - ready]
    );
    assert_eq!(
        values(&recs, Metric::GateWaitDuration, &[("gate", "merge")]),
        [3600.0]
    );
    assert_eq!(
        values(&recs, Metric::GateWaitDuration, &[("gate", "answer")]),
        [60.0]
    );
    assert_eq!(
        values(&recs, Metric::GateWaitDuration, &[("gate", "protected")]),
        [120.0]
    );
    assert_eq!(
        values(&recs, Metric::GateWaitDuration, &[("gate", "other")]),
        [180.0]
    );

    // Time to restore: e2e red → the revert's e2e green.
    let mut w = M::new(&[""]);
    let c = w.pick(0);
    let c = to_deploy(&mut w, c);
    let c = w.ok_to(c, Stage::E2e, 10);
    let c = w.apply(&c, Outcome::red("e2e red twice"), 10);
    let red = w.unix();
    let c = w.ok_to(c, Stage::RevertE2e, 300);
    let _ = w.apply(&c, Outcome::wait(Waiting::RevertedRefine, "green"), 300);
    let recs = metrics::take();
    assert_eq!(
        values(&recs, Metric::RestoreDuration, &[("repo", "web")]),
        [w.unix() - red]
    );
    no_intent_label(&recs);
}
