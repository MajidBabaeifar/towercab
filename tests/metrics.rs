//! The emitter (MET-13, MET-18, MET-21): records into this thread's buffer, OTLP/HTTP JSON to a
//! fake collector on 127.0.0.1, the spool while it is down, and the buckets.

mod common;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Local;
use common::http::{FakeHttp, Request, dead_url};
use serde_json::{Value, json};
use towercab::db::Db;
use towercab::metrics::{
    self, COST, DURATION, Ev, Instrument, METRICS, Metric, RETRY, REWORK, Record, SPOOL_MAX, Sink,
    spool_append, spool_read,
};
use towercab::runloop::Tick;

/// A collector answering `code`; its requests.
fn collector(code: Arc<Mutex<u16>>) -> FakeHttp {
    FakeHttp::start(move |_| (*code.lock().unwrap(), "{\"partialSuccess\":{}}".into()))
}

fn sink(endpoint: &str, dir: &std::path::Path) -> Sink {
    Sink {
        endpoint: endpoint.into(),
        spool: dir.join("metrics.jsonl"),
        down_until: None,
    }
}

fn now() -> Tick {
    Tick {
        wall: Local::now().fixed_offset(),
        mono: Duration::from_secs(1000),
    }
}

fn body(r: &Request) -> Value {
    serde_json::from_str(&r.body).unwrap()
}

/// The request to `path`, the last one.
fn last(http: &FakeHttp, path: &str) -> Value {
    let reqs = http.requests.lock().unwrap();
    body(reqs.iter().rev().find(|r| r.path == path).expect(path))
}

/// `[{key, value: {stringValue}}]` → (key, value) pairs.
fn kv(attrs: &Value) -> Vec<(String, String)> {
    attrs
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["key"].as_str().unwrap().to_string(),
                a["value"]["stringValue"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// The metric named `name` in a `/v1/metrics` body.
fn metric<'a>(m: &'a Value, name: &str) -> &'a Value {
    m["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == name)
        .unwrap_or_else(|| panic!("no {name} in {m}"))
}

fn ns(t: f64) -> String {
    ((t * 1e9) as u64).to_string()
}

#[test]
fn test_metric_otlp() {
    let tmp = tempfile::tempdir().unwrap();
    let code = Arc::new(Mutex::new(200));
    let http = collector(Arc::clone(&code));
    let mut s = sink(&http.url, tmp.path());
    metrics::take();
    let ev = Ev::none();
    metrics::add(Metric::CiRepairs, 1.0, &[("repo", "web")], &ev);
    metrics::add(Metric::CiRepairs, 2.0, &[("repo", "web")], &ev);
    metrics::add(Metric::CiRepairs, 1.0, &[("repo", "api")], &ev);
    metrics::observe(
        Metric::StageDuration,
        12.0,
        &[("repo", "web"), ("stage", "build"), ("result", "ok")],
        &ev,
    );
    metrics::observe(
        Metric::StageDuration,
        5.0,
        &[("repo", "web"), ("stage", "build"), ("result", "ok")],
        &ev,
    );
    metrics::observe(Metric::IntentCost, 3.0, &[("repo", "web")], &ev);
    metrics::gauge(Metric::Backlog, 4.0, &[("state", "runnable")]);
    metrics::gauge(Metric::Backlog, 2.0, &[("state", "runnable")]);
    metrics::gauge(Metric::EvalPassRate, 0.9, &[("kind", "baseline")]);

    // A transaction that rolls back takes its records with it.
    let db = Db::open(&tmp.path().join("t.db")).unwrap();
    let r: Result<(), String> = db.tx(|_| {
        metrics::add(Metric::Reverts, 1.0, &[("repo", "web")], &ev);
        Err("no".into())
    });
    assert!(r.is_err());
    db.tx(|_| {
        metrics::add(
            Metric::Escapes,
            1.0,
            &[("repo", "web"), ("where", "e2e")],
            &ev,
        );
        Ok(())
    })
    .unwrap();

    let t = now();
    s.flush(t);
    assert!(metrics::take().is_empty(), "flushed");
    let reqs = http.requests.lock().unwrap().clone();
    assert_eq!(
        reqs.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
        ["/v1/logs", "/v1/metrics"]
    );
    for r in &reqs {
        assert_eq!(
            (r.method.as_str(), r.header("content-type")),
            ("POST", Some("application/json"))
        );
    }
    let m = last(&http, "/v1/metrics");
    let rm = &m["resourceMetrics"][0];
    assert_eq!(
        kv(&rm["resource"]["attributes"]),
        [("service.name".to_string(), "towercab-loop".to_string())]
    );
    assert_eq!(rm["scopeMetrics"][0]["scope"]["name"], "towercab");
    let when = ns(t.wall.timestamp_micros() as f64 / 1e6);

    // Counters: delta, monotonic, summed per labels.
    let c = metric(&m, "towercab.ci.repairs");
    assert_eq!(c["sum"]["aggregationTemporality"], 1);
    assert_eq!(c["sum"]["isMonotonic"], true);
    let pts = c["sum"]["dataPoints"].as_array().unwrap();
    assert_eq!(pts.len(), 2);
    let web = pts
        .iter()
        .find(|p| kv(&p["attributes"]) == [("repo".to_string(), "web".to_string())])
        .unwrap();
    assert_eq!(web["asDouble"], 3.0);
    assert_eq!(web["timeUnixNano"], json!(when));
    assert!(web["startTimeUnixNano"].as_str().unwrap() < when.as_str());
    assert!(m.to_string().contains("towercab.escapes"));
    assert!(!m.to_string().contains("towercab.reverts"), "rolled back");

    // Histograms: delta, buckets of MET-21, 64-bit integers as strings.
    let h = metric(&m, "towercab.stage.duration");
    assert_eq!(h["unit"], "s");
    assert_eq!(h["histogram"]["aggregationTemporality"], 1);
    let p = &h["histogram"]["dataPoints"][0];
    assert_eq!(p["count"], "2");
    assert_eq!(p["sum"], 17.0);
    assert_eq!(p["explicitBounds"], json!(DURATION));
    let mut want = vec!["0".to_string(); DURATION.len() + 1];
    want[0] = "1".into(); // 5 ≤ 5
    want[1] = "1".into(); // 12 ≤ 15
    assert_eq!(p["bucketCounts"], json!(want));
    let cost = metric(&m, "towercab.intent.cost");
    assert_eq!(cost["unit"], "USD");
    assert_eq!(
        cost["histogram"]["dataPoints"][0]["explicitBounds"],
        json!(COST)
    );

    // Gauges: the last value; ratio unit for the pass rate.
    let g = metric(&m, "towercab.backlog");
    assert_eq!(g["gauge"]["dataPoints"][0]["asDouble"], 2.0);
    assert_eq!(metric(&m, "towercab.eval.pass_rate")["unit"], "1");

    // Nothing recorded, nothing spooled: no request.
    s.flush(now());
    assert_eq!(http.requests.lock().unwrap().len(), 2);

    // A non-2xx answer is a failure: spooled.
    *code.lock().unwrap() = 500;
    metrics::add(Metric::CiRepairs, 1.0, &[("repo", "web")], &ev);
    s.flush(now());
    assert_eq!(spool_read(&s.spool, 10).len(), 1);
    assert!(s.down_until.is_some());
}

#[test]
fn test_metric_log_event() {
    let tmp = tempfile::tempdir().unwrap();
    let http = collector(Arc::new(Mutex::new(200)));
    let mut s = sink(&http.url, tmp.path());
    metrics::take();
    let ev = Ev {
        intent: Some("261001-0900".into()),
        stage: Some("ci".into()),
        pr: Some(7),
    };
    metrics::add(
        Metric::CiResult,
        1.0,
        &[("repo", "web"), ("result", "green"), ("first", "yes")],
        &ev,
    );
    metrics::observe(
        Metric::GateWaitDuration,
        90.0,
        &[("repo", "web"), ("gate", "merge")],
        &ev,
    );
    metrics::gauge(Metric::Active, 1.0, &[]);
    let recorded: Vec<Record> = metrics::take();
    s.send(recorded.clone(), now());
    let l = last(&http, "/v1/logs");
    let rl = &l["resourceLogs"][0];
    assert_eq!(
        kv(&rl["resource"]["attributes"]),
        [("service.name".to_string(), "towercab-loop".to_string())]
    );
    let logs = rl["scopeLogs"][0]["logRecords"].as_array().unwrap();
    // One per counter and histogram record; gauges write none.
    assert_eq!(logs.len(), 2);
    let ci = &logs[0];
    assert_eq!(ci["body"]["stringValue"], "towercab.ci.result 1");
    assert_eq!(ci["timeUnixNano"], json!(ns(recorded[0].at)));
    assert_eq!(ci["severityText"], "INFO");
    let a = kv(&ci["attributes"]);
    for (k, v) in [
        ("first", "yes"),
        ("repo", "web"),
        ("result", "green"),
        ("metric", "towercab.ci.result"),
        ("value", "1"),
        ("intent_id", "261001-0900"),
        ("stage", "ci"),
        ("pr", "7"),
    ] {
        assert!(a.contains(&(k.into(), v.into())), "{k}: {a:?}");
    }
    assert_eq!(
        logs[1]["body"]["stringValue"],
        "towercab.gate.wait.duration 90"
    );
    // The intent is never a metric label.
    let m = last(&http, "/v1/metrics");
    assert!(!m.to_string().contains("intent_id"), "{m}");
    assert!(!m.to_string().contains("261001-0900"), "{m}");
}

#[test]
fn test_metric_spool() {
    let tmp = tempfile::tempdir().unwrap();
    let mut s = sink(&dead_url(), tmp.path());
    metrics::take();
    let ev = Ev {
        intent: Some("261001-0900".into()),
        stage: Some("ci".into()),
        pr: None,
    };
    metrics::add(Metric::CiRepairs, 1.0, &[("repo", "web")], &ev);
    metrics::gauge(Metric::Active, 1.0, &[]);
    let t = now();
    s.flush(t);
    // Refused: spooled (the gauge isn't: the next minute has a fresh one); no send for 60 s.
    let spooled = spool_read(&s.spool, 100);
    assert_eq!(spooled.len(), 1);
    assert_eq!(spooled[0].metric, Metric::CiRepairs);
    assert_eq!(spooled[0].ev, ev);
    assert_eq!(s.down_until, Some(t.mono + RETRY));

    // Within the minute: straight to the spool, even with a collector up.
    let code = Arc::new(Mutex::new(200));
    let http = collector(Arc::clone(&code));
    s.endpoint = http.url.clone();
    metrics::add(Metric::CiRepairs, 2.0, &[("repo", "web")], &ev);
    s.flush(t.after(Duration::from_secs(30)));
    assert!(http.requests.lock().unwrap().is_empty());
    assert_eq!(spool_read(&s.spool, 100).len(), 2);
    // A line that doesn't parse is dropped on replay.
    let mut text = fs::read_to_string(&s.spool).unwrap();
    text.push_str("not json\n");
    fs::write(&s.spool, text).unwrap();
    let old: Vec<f64> = spool_read(&s.spool, 100).iter().map(|r| r.at).collect();

    // Later, a success: the spool first (oldest first), then the new record; points stamped
    // with the send time, events with their own; the spool is emptied (truncated, not unlinked:
    // another process may hold it open).
    let later = Tick {
        wall: Local::now().fixed_offset() + chrono::TimeDelta::hours(2),
        mono: t.mono + Duration::from_secs(7200),
    };
    metrics::add(Metric::CiRepairs, 4.0, &[("repo", "web")], &ev);
    s.flush(later);
    assert_eq!(fs::metadata(&s.spool).unwrap().len(), 0);
    assert_eq!(s.down_until, None);
    let m = last(&http, "/v1/metrics");
    let p = &metric(&m, "towercab.ci.repairs")["sum"]["dataPoints"][0];
    assert_eq!(p["asDouble"], 7.0);
    let sent = later.wall.timestamp_micros() as f64 / 1e6;
    assert_eq!(p["timeUnixNano"], json!(ns(sent)));
    // Its start is at most 10 min before the send.
    let start: u64 = p["startTimeUnixNano"].as_str().unwrap().parse().unwrap();
    assert!(start >= ((sent - 600.0) * 1e9) as u64 - 1000, "{start}");
    let l = last(&http, "/v1/logs");
    let logs = l["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
        .as_array()
        .unwrap();
    assert_eq!(logs.len(), 3);
    for (log, at) in logs.iter().zip(&old) {
        assert_eq!(
            log["timeUnixNano"],
            json!(ns(*at)),
            "events keep their time"
        );
    }
    assert_eq!(logs[2]["body"]["stringValue"], "towercab.ci.repairs 4");

    // A collector that answers the logs but not the metrics: everything stays spooled (an
    // event may repeat; a point never counts twice).
    let half = FakeHttp::start(|r: &Request| {
        if r.path == "/v1/logs" {
            (200, "{}".into())
        } else {
            (503, "{}".into())
        }
    });
    s.endpoint = half.url.clone();
    metrics::add(Metric::CiRepairs, 1.0, &[("repo", "web")], &ev);
    s.flush(later.after(Duration::from_secs(5)));
    assert_eq!(spool_read(&s.spool, 100).len(), 1);
}

#[test]
fn test_spool_bounded() {
    let tmp = tempfile::tempdir().unwrap();
    let spool = tmp.path().join("metrics.jsonl");
    let rec = |i: usize| Record {
        metric: Metric::CiRepairs,
        value: i as f64,
        labels: [("repo".to_string(), "x".repeat(100))].into(),
        ev: Ev::none(),
        at: 1.0,
        seq: 0,
    };
    let (mut i, mut trims) = (0, 0);
    while i < 60_000 {
        let batch: Vec<Record> = (i..i + 1000).map(rec).collect();
        let before = fs::metadata(&spool).map_or(0, |m| m.len());
        spool_append(&spool, &batch);
        i += 1000;
        let len = fs::metadata(&spool).unwrap().len();
        assert!(len <= SPOOL_MAX);
        if len < before {
            // A trim: the oldest lines dropped down to half the bound, the batch included.
            assert!(len <= SPOOL_MAX / 2, "{len}");
            trims += 1;
        }
    }
    assert!(trims > 0);
    // The oldest went first; the newest are kept, in order.
    let kept = spool_read(&spool, usize::MAX);
    assert!(kept.len() < 60_000 && kept.len() > 1000, "{}", kept.len());
    assert_eq!(kept.last().unwrap().value, 59_999.0);
    assert!(kept.windows(2).all(|w| w[0].value + 1.0 == w[1].value));
    assert!(kept[0].value > 0.0);
}

fn rec(value: f64) -> Record {
    Record {
        metric: Metric::CiRepairs,
        value,
        labels: [("repo".to_string(), "web".to_string())].into(),
        ev: Ev::none(),
        at: 1.0,
        seq: 0,
    }
}

#[test]
fn test_spool_damage_and_locks() {
    let tmp = tempfile::tempdir().unwrap();
    let spool = tmp.path().join("metrics.jsonl");
    let line = |v: f64| rec(v).to_json().to_string() + "\n";

    // Invalid UTF-8 and a torn last line spoil only themselves; an append starts a new line.
    let mut bytes = line(1.0).into_bytes();
    bytes.extend_from_slice(b"\xff\xfe not utf-8\n");
    bytes.extend_from_slice(line(2.0).as_bytes());
    bytes.extend_from_slice(br#"{"metric": "ci.rep"#);
    fs::write(&spool, &bytes).unwrap();
    let values = |n| -> Vec<f64> { spool_read(&spool, n).iter().map(|r| r.value).collect() };
    assert_eq!(values(100), [1.0, 2.0]);
    spool_append(&spool, &[rec(3.0)]);
    assert_eq!(values(100), [1.0, 2.0, 3.0]);

    // Another process holds the lock: an append gives up within LOCK_WAIT, nothing written.
    let held = fs::OpenOptions::new().write(true).open(&spool).unwrap();
    held.lock().unwrap();
    let t = std::time::Instant::now();
    spool_append(&spool, &[rec(4.0)]);
    assert!(t.elapsed() < metrics::LOCK_WAIT + Duration::from_secs(1));
    drop(held);
    assert_eq!(values(100), [1.0, 2.0, 3.0]);

    // A record appended while a replay is in flight stays; the replayed lines (bad ones too) go.
    let path = spool.clone();
    let http = FakeHttp::start(move |r: &Request| {
        if r.path == "/v1/metrics" {
            spool_append(&path, &[rec(5.0)]);
        }
        (200, "{}".into())
    });
    let mut s = sink(&http.url, tmp.path());
    metrics::take();
    s.send(vec![rec(6.0)], now());
    assert_eq!(values(100), [5.0]);
    let sent = last(&http, "/v1/metrics");
    let p = &metric(&sent, "towercab.ci.repairs")["sum"]["dataPoints"][0];
    assert_eq!(p["asDouble"], 12.0);

    // A permanent 4xx drops the batch, replayed lines too; 429 is a failure: spooled.
    let code = Arc::new(Mutex::new(400));
    let http = collector(Arc::clone(&code));
    s.endpoint = http.url.clone();
    s.send(vec![rec(7.0)], now());
    assert_eq!(values(100), Vec::<f64>::new());
    assert_eq!(s.down_until, None);
    *code.lock().unwrap() = 429;
    s.send(vec![rec(8.0)], now());
    assert_eq!(values(100), [8.0]);
    assert!(s.down_until.is_some());
}

#[test]
fn test_eval_scope_defers_flush() {
    // A replay's scratch loop flushes nothing: its runs' cost waits for the `towercab eval`
    // flush into the real home (a scratch home's spool would be deleted with it).
    let tmp = tempfile::tempdir().unwrap();
    let mut scratch = sink(&dead_url(), &tmp.path().join("case"));
    metrics::take();
    let scope = metrics::eval_scope();
    metrics::add(Metric::CostUsd, 0.5, &[("agent", "eval")], &Ev::none());
    metrics::add(Metric::CiRepairs, 1.0, &[("repo", "web")], &Ev::none());
    scratch.flush(now());
    assert!(!scratch.spool.exists());
    drop(scope);
    let mut real = sink(&dead_url(), tmp.path());
    real.flush(now());
    let spooled = spool_read(&real.spool, 100);
    assert_eq!(spooled.len(), 1, "only cost and tokens in a scope");
    assert_eq!(spooled[0].metric, Metric::CostUsd);
}

#[test]
fn test_buckets() {
    assert_eq!(
        DURATION,
        [
            5.0, 15.0, 30.0, 60.0, 300.0, 900.0, 1800.0, 3600.0, 7200.0, 14400.0, 28800.0, 86400.0,
            172800.0, 604800.0, 1209600.0, 2592000.0, 7776000.0
        ]
    );
    assert_eq!(REWORK, [0.0, 1.0, 2.0, 3.0, 4.0, 6.0, 9.0, 12.0]);
    assert_eq!(COST, [0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0]);
    for m in METRICS {
        let want: Option<&[f64]> = match m {
            Metric::ReworkCycles => Some(&REWORK),
            Metric::IntentCost => Some(&COST),
            _ if m.name().ends_with(".duration") && *m != Metric::UsageLimitWaitDuration
                || *m == Metric::TimeToIntent =>
            {
                Some(&DURATION)
            }
            _ => None,
        };
        match (m.instrument(), want) {
            (Instrument::Histogram(b), Some(w)) => assert_eq!(b, w, "{}", m.name()),
            (Instrument::Histogram(_), None) => panic!("{}: unexpected histogram", m.name()),
            (_, Some(_)) => panic!("{}: not a histogram", m.name()),
            _ => {}
        }
        // Durations in seconds.
        if m.name().ends_with(".duration") || *m == Metric::TimeToIntent {
            assert_eq!(m.unit(), "s", "{}", m.name());
        }
    }
    // Rework counts land in their own bucket (a value on a bound goes into it).
    let (m, _) = metrics::payload(
        &[0.0, 1.0, 5.0, 13.0]
            .iter()
            .map(|v| Record {
                metric: Metric::ReworkCycles,
                value: *v,
                labels: Default::default(),
                ev: Ev::none(),
                at: 1.0,
                seq: 0,
            })
            .collect::<Vec<_>>(),
        2.0,
    );
    let p = &metric(&m, "towercab.rework.cycles")["histogram"]["dataPoints"][0];
    assert_eq!(
        p["bucketCounts"],
        json!(["1", "1", "0", "0", "0", "1", "0", "0", "1"])
    );
}
