//! The loop's own metrics (MET-20, MET-24's `active`) and the DONE line's totals (MET-10).

mod common;

use std::sync::{Arc, Mutex};

use common::http::FakeHttp;
use common::world::{World, intent_file};
use serde_json::Value;
use towercab::commands::{self, Cmd};
use towercab::handler::{
    ChildEnd, ChildKind, ChildSpec, Ctx, Handler, Handlers, Outcome, Progress, StepError,
};
use towercab::machine::Stage;
use towercab::mission::Mission;

/// A build that runs `sleep 5` (ends by itself: nothing outlives a failed test for long).
struct Sleeper;

impl Handler for Sleeper {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let runs = cx.runs(m);
        std::fs::create_dir_all(&runs).unwrap();
        Ok(Progress::Spawn(ChildSpec {
            kind: ChildKind::Command,
            argv: vec!["sleep".into(), "5".into()],
            cwd: runs.clone(),
            env: vec![("PATH".into(), std::env::var_os("PATH").unwrap_or_default())],
            stdin: None,
            stdout: runs.join("sleep.out"),
            stderr: runs.join("sleep.err"),
            timeout: None,
            slot: true,
            model: None,
        }))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Ok(Progress::Done(Outcome::ok()))
    }
}

/// The values of gauge `name` in the last `/v1/metrics` the collector got: (state label or
/// "", value).
fn gauge(bodies: &Arc<Mutex<Vec<String>>>, name: &str) -> Vec<(String, f64)> {
    let b = bodies.lock().unwrap();
    let m: Value = b
        .iter()
        .rev()
        .map(|s| serde_json::from_str::<Value>(s).unwrap())
        .find(|v| v.get("resourceMetrics").is_some() && v.to_string().contains(name))
        .unwrap_or_else(|| panic!("no {name}"));
    let metric = m["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == name)
        .unwrap()
        .clone();
    let mut out: Vec<(String, f64)> = metric["gauge"]["dataPoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let state = p["attributes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["key"] == "state")
                .map(|a| a["value"]["stringValue"].as_str().unwrap().to_string())
                .unwrap_or_default();
            (state, p["asDouble"].as_f64().unwrap())
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn pairs(v: &[(&str, f64)]) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = v.iter().map(|(s, n)| (s.to_string(), *n)).collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn test_gauges() {
    let mut w = World::new(
        &[
            intent_file("261001-0900-a", "web", "u: 5\ni: 5\n", "Runnable"),
            intent_file("261001-0901-b", "web", "u: 1\ni: 1\n", "Parked"),
            intent_file("261001-0902-c", "web", "after: [261001-0901]\n", "After"),
            intent_file(
                "261001-0903-d",
                "web",
                "waiting: \"bad after:\"\n",
                "Bad after",
            ),
            intent_file(
                "261001-0904-e",
                "web",
                "stage: deploy\nwaiting: review and merge PR\n",
                "Mine to merge",
            ),
            intent_file("261001-0905-f", "web", "stage: build\n", "Building"),
        ],
        &["web"],
    );
    let db = w.db();
    for (intent, stage, waiting) in [
        ("261001-0904", "approval:merge", Some("review and merge PR")),
        ("261001-0905", "build", None),
    ] {
        db.conn()
            .execute(
                "INSERT INTO missions (intent, repo, stage, step, model, session, checkout,
                   waiting, from_stage, created, updated)
                 VALUES (?1, 'web', ?2, '', 'opus', 's', ?3, ?4, 'gate', 0, 0)",
                rusqlite::params![intent, stage, format!("work/{intent}-1"), waiting],
            )
            .unwrap();
    }
    db.set_meta("paused", "1").unwrap();
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&bodies);
    let http = FakeHttp::start(move |r| {
        seen.lock().unwrap().push(r.body.clone());
        (200, "{}".into())
    });
    // Two workers: the build isn't queued behind the merge wait (LOOP-4).
    w.repo_mut("web").workers = 2;
    let mut h = Handlers::stubs();
    h.set(Stage::Build, Box::new(Sleeper));
    let mut lp = w.open(h);
    lp.metrics.endpoint = http.url.clone();

    // Paused: no pick; the build's child runs.
    let r = w.pass(&mut lp);
    assert!(r.gauges);
    assert_eq!(lp.running().len(), 1);
    assert_eq!(
        gauge(&bodies, "towercab.backlog"),
        pairs(&[
            ("runnable", 1.0),
            ("parked", 1.0),
            ("in_flight", 1.0),
            ("waiting_on_me", 2.0),
            ("blocked", 1.0),
        ])
    );
    let states = |on: &str| -> Vec<(String, f64)> {
        let all = ["running", "idle", "paused", "env_blocked", "limit"];
        pairs(
            &all.iter()
                .map(|s| (*s, if *s == on { 1.0 } else { 0.0 }))
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(gauge(&bodies, "towercab.loop.state"), states("paused"));
    assert_eq!(gauge(&bodies, "towercab.active"), [(String::new(), 1.0)]);

    // Resumed: running (the slot is taken: no pick yet).
    db.del_meta("paused").unwrap();
    let r = w.pass(&mut lp);
    assert!(r.gauges && r.picked.is_none());
    assert_eq!(gauge(&bodies, "towercab.loop.state"), states("running"));
    // Within the minute: no gauges.
    let r = w.pass_after(&mut lp, 5);
    assert!(!r.gauges);
    lp.shutdown().unwrap();
    // Nothing waits, nothing runs: idle.
    let mut w2 = World::new(&[], &["web"]);
    let mut lp2 = w2.open(Handlers::stubs());
    lp2.metrics.endpoint = http.url.clone();
    w2.pass(&mut lp2);
    assert_eq!(gauge(&bodies, "towercab.loop.state"), states("idle"));
    assert_eq!(gauge(&bodies, "towercab.active"), [(String::new(), 0.0)]);
    lp2.shutdown().unwrap();
}

#[test]
fn test_done_line() {
    const ID: &str = "261001-0900";
    let mut w = World::new(
        &[intent_file("261001-0900-a", "web", "", "Totals")],
        &["web"],
    );
    let mut lp = w.open(Handlers::stubs());
    let r = w.pass(&mut lp);
    assert_eq!(r.picked.as_deref(), Some(ID));
    let cost = |w: &World, usd: f64, secs: f64| {
        w.db()
            .conn()
            .execute(
                "UPDATE missions SET cost_usd = ?1, agent_secs = ?2 WHERE id = ?3",
                rusqlite::params![usd, secs, w.mission(ID).id],
            )
            .unwrap();
    };
    // Attempt 1 cost $1.00 and 50 min, then a fresh attempt: $0.50 and 11 min 40 s.
    cost(&w, 1.0, 3000.0);
    commands::queue(&w.db(), &Cmd::RetryFresh(ID.into()), "cli").unwrap();
    w.pass(&mut lp);
    assert_eq!(w.missions(ID).len(), 2);
    cost(&w, 0.5, 700.0);
    w.until(&mut lp, 40, |w| {
        w.missions(ID)
            .last()
            .is_some_and(|m| m.stage == Stage::Done && m.step.is_empty())
    });
    let done = w.intents.remote_file("DONE.md");
    let line = done
        .lines()
        .find(|l| l.contains(ID))
        .unwrap_or_else(|| panic!("{done}"));
    assert!(line.ends_with(" · no PR · $1.50 · 1h01m · 2"), "{line}");
    lp.shutdown().unwrap();
}
