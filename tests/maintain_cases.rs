//! Maintain's incident eval cases (MNT-8) and its metrics (MET-27) on a merged pipeline
//! mission: an alert intent's case and a broken merge's case are `incident: true`, always
//! replayed; breach → intent, incident → eval, alert escapes.

mod common;

use std::fs;

use chrono::DateTime;
use common::pipe::{LOGIN_DIR, LOGIN_ID as ID, Pipe};
use serde_json::Value;
use towercab::maintain::bands::{self, Tier};
use towercab::maintain::detect::Verdict;
use towercab::maintain::{self, diagnose};
use towercab::metrics::{self, Metric, Record};
use towercab::pipeline::evals::{self, CASES, Case};

const BAND: &str = "bands:\n  ci_failure_rate:\n    metric: ci.result\n    query: sum(x)\n    side: high\n    repo: web\n";

fn case_of(p: &Pipe) -> Case {
    let text = p
        .intents_file(&format!("evals/{ID}.json"))
        .expect("evals/<id>.json on intents main");
    Case::from_json(&serde_json::from_str::<Value>(&text).unwrap()).unwrap()
}

fn of(recs: &[Record], metric: Metric) -> Vec<Record> {
    recs.iter()
        .filter(|r| r.metric == metric)
        .cloned()
        .collect()
}

/// The login intent's mission had a `red` out of `e2e` at `at`.
fn e2e_red(p: &Pipe, at: f64) {
    let m = p.mission(ID);
    p.w.db()
        .conn()
        .execute(
            "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why)
             VALUES (?1, ?2, 'e2e', 'red', 'rollback', 'e2e red')",
            rusqlite::params![m.id, at],
        )
        .unwrap();
}

#[test]
fn test_incident_eval_always_replayed() {
    let (p, merge) = Pipe::merged("# Towercab\n", "towercab");
    metrics::take();
    // No incident yet: the drafts poll writes nothing.
    p.cx(maintain::settle).unwrap();
    assert!(p.intents_file(&format!("evals/{ID}.json")).is_none());

    // A merged change found broken: its case is written as an incident, once.
    let red = chrono::Utc::now().timestamp() as f64 - 600.0;
    e2e_red(&p, red);
    p.cx(maintain::settle).unwrap();
    let c = case_of(&p);
    assert!(c.incident);
    assert_eq!(c.merge_sha, merge);
    let recs = metrics::take();
    let i2e = of(&recs, Metric::IncidentToEvalDuration);
    assert_eq!(i2e.len(), 1, "{recs:?}");
    assert_eq!(i2e[0].label("repo"), Some("web"));
    assert!(
        (600.0..700.0).contains(&i2e[0].value),
        "since the first e2e red: {}",
        i2e[0].value
    );
    p.cx(maintain::settle).unwrap();
    let m = p.mission(ID);
    // The done intent's case (release) keeps the mark; no second sample.
    p.cx(|cx| evals::write_case(cx, &m)).unwrap();
    assert!(case_of(&p).incident);
    assert!(of(&metrics::take(), Metric::IncidentToEvalDuration).is_empty());
    let commits = p
        .intents_log()
        .iter()
        .filter(|l| l.as_str() == format!("towercab: eval {ID}"))
        .count();
    assert_eq!(commits, 1);

    // 20 newer cases: the incident case is still replayed.
    let newer: Vec<(String, String)> = (0..CASES)
        .map(|i| {
            let id = format!("2611{:02}-0900", i + 1);
            let c = Case {
                id: id.clone(),
                incident: false,
                added: format!("2099-11-{:02}T09:00:00+02:00", i + 1),
                ..case_of(&p)
            };
            (format!("evals/{id}.json"), c.to_json().to_string())
        })
        .collect();
    let files: Vec<(&str, Option<&str>)> = newer
        .iter()
        .map(|(r, t)| (r.as_str(), Some(t.as_str())))
        .collect();
    p.w.intents.push_mine(&files, "newer cases");
    let store = towercab::intents::Store::open(&p.w.config).unwrap();
    store.list().unwrap();
    let replayed = evals::cases(&store);
    assert_eq!(replayed.len(), CASES + 1);
    assert!(replayed.iter().any(|c| c.id == ID && c.incident));
}

#[test]
fn test_maintain_metrics() {
    let (p, _) = Pipe::merged("# Towercab\n", "towercab");
    metrics::take();
    let band = &bands::parse(BAND).unwrap()[0];
    let now = chrono::Utc::now().timestamp() as f64;
    let v = Verdict {
        tier: Tier::Two,
        point: (now - 86_400.0, 2.8),
        mean: 1.5,
        sigma: 0.5,
    };
    // A breach: its counter; its draft opens 120 s later with a cause among the merges.
    let at = p.cx(|cx| {
        assert!(maintain::record(cx.db, cx.config, cx.home, band, &v, &[], cx.tick).unwrap());
        cx.tick.unix()
    });
    let db = p.w.db();
    let rowid: i64 = db
        .conn()
        .query_row(
            "SELECT rowid FROM drafts WHERE key = 'alert:ci_failure_rate'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.conn()
        .execute(
            "UPDATE drafts SET step = 'open', intent = '261020-1000', slug = 'x', pr = 5,
               pr_url = 'https://github.com/me/intents/pull/5', updated = ?1",
            [at + 120.0],
        )
        .unwrap();
    fs::write(
        p.w.home
            .runs(&format!("draft-{rowid}"))
            .join(diagnose::CAUSE),
        "https://github.com/me/web/pull/7",
    )
    .unwrap();
    p.cx(|cx| maintain::opened(cx, "ci_failure_rate")).unwrap();
    p.cx(|cx| maintain::opened(cx, "ci_failure_rate")).unwrap();
    let recs = metrics::take();
    let breaches = of(&recs, Metric::Breaches);
    assert_eq!(breaches.len(), 1);
    assert_eq!(
        (
            breaches[0].label("band"),
            breaches[0].label("tier"),
            breaches[0].value
        ),
        (Some("ci_failure_rate"), Some("2sigma"), 1.0)
    );
    let b2i = of(&recs, Metric::BreachToIntentDuration);
    assert_eq!(b2i.len(), 1, "once");
    assert_eq!(
        (b2i[0].label("band"), b2i[0].value),
        (Some("ci_failure_rate"), 120.0)
    );
    assert_eq!(b2i[0].ev.intent.as_deref(), Some("261020-1000"));
    let esc = of(&recs, Metric::Escapes);
    assert_eq!(esc.len(), 1);
    assert_eq!(
        (esc[0].label("repo"), esc[0].label("where")),
        (Some("web"), Some("alert"))
    );

    // An alert intent's case: an incident since the breach (`started`).
    let started = "2026-10-20T10:00:00+02:00";
    let md = p
        .intents_file(&format!("intents/{LOGIN_DIR}/intent.md"))
        .unwrap();
    let md = md.replacen(
        "---\n",
        &format!("---\nsource: alert:ci_failure_rate\nstarted: {started}\n"),
        1,
    );
    let rel = format!("intents/{LOGIN_DIR}/intent.md");
    p.w.intents
        .push_mine(&[(rel.as_str(), Some(md.as_str()))], "alert");
    let m = p.mission(ID);
    p.cx(|cx| evals::write_case(cx, &m)).unwrap();
    assert!(case_of(&p).incident);
    let i2e = of(&metrics::take(), Metric::IncidentToEvalDuration);
    assert_eq!(i2e.len(), 1);
    let since = DateTime::parse_from_rfc3339(started).unwrap().timestamp() as f64;
    assert!(
        (i2e[0].value - (chrono::Utc::now().timestamp() as f64 - since)).abs() < 60.0,
        "{}",
        i2e[0].value
    );
}
