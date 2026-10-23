//! Towercab's own metrics and events (MET-13, MET-18, MET-21): one name list, a per-thread
//! buffer the code records into (no I/O, can't fail), and the [`Sink`] that sends it as
//! OTLP/HTTP JSON once per pass, spooling to `<home>/metrics.jsonl` while the collector is down.
//! Where each metric comes from: `src/indicators.rs`.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::config::Config;
use crate::home::Home;
use crate::mission::Mission;
use crate::runloop::Tick;

/// Duration histograms' bounds, seconds (MET-21).
pub const DURATION: [f64; 17] = [
    5.0, 15.0, 30.0, 60.0, 300.0, 900.0, 1800.0, 3600.0, 7200.0, 14400.0, 28800.0, 86400.0,
    172800.0, 604800.0, 1209600.0, 2592000.0, 7776000.0,
];

/// `towercab.rework.cycles`' bounds (MET-21).
pub const REWORK: [f64; 8] = [0.0, 1.0, 2.0, 3.0, 4.0, 6.0, 9.0, 12.0];

/// `towercab.intent.cost`'s bounds, USD (MET-21).
pub const COST: [f64; 9] = [0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0];

/// Each OTLP POST's timeout.
pub const TIMEOUT: Duration = Duration::from_secs(2);

/// After a failed send, flushes go straight to the spool this long.
pub const RETRY: Duration = Duration::from_secs(60);

/// The spool's bound; an append past it first drops the oldest lines down to half.
pub const SPOOL_MAX: u64 = 4 << 20;

/// How long a spool append or rewrite waits for another process's `flock`, else gives up.
pub const LOCK_WAIT: Duration = Duration::from_millis(500);

/// Spool lines replayed per send.
pub const REPLAY: usize = 5000;

/// Records a thread keeps between flushes; the oldest go first.
pub const BUFFER: usize = 10_000;

/// Replayed points are stamped with the send time; a live point's start is at most this long
/// before it (Prometheus rejects samples older than 10 min).
const MAX_AGE: f64 = 600.0;

/// OTLP's `AGGREGATION_TEMPORALITY_DELTA`.
const DELTA: u8 = 1;

/// The resource's `service.name`: the loop's own data, apart from Claude runs' `towercab`.
pub const SERVICE: &str = "towercab-loop";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Instrument {
    Counter,
    Histogram(&'static [f64]),
    Gauge,
}

macro_rules! metrics {
    ($($v:ident = $name:literal, $inst:expr, $unit:literal;)*) => {
        /// A metric of the one list (MET-13, **Names**).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum Metric { $($v),* }

        impl Metric {
            pub const ALL: &'static [Metric] = &[$(Metric::$v),*];

            /// The OTel name, `towercab.<name>`.
            pub fn name(self) -> &'static str {
                match self { $(Metric::$v => $name),* }
            }

            pub fn instrument(self) -> Instrument {
                match self { $(Metric::$v => $inst),* }
            }

            /// The OTel unit (`s`, `USD`, `1`, or none).
            pub fn unit(self) -> &'static str {
                match self { $(Metric::$v => $unit),* }
            }
        }
    };
}

use Instrument::{Counter, Gauge, Histogram};

metrics! {
    StageDuration = "towercab.stage.duration", Histogram(&DURATION), "s";
    IntentDuration = "towercab.intent.duration", Histogram(&DURATION), "s";
    IntentCost = "towercab.intent.cost", Histogram(&COST), "USD";
    CostUsd = "towercab.cost.usd", Counter, "USD";
    Tokens = "towercab.tokens", Counter, "";
    CiRepairs = "towercab.ci.repairs", Counter, "";
    CiResult = "towercab.ci.result", Counter, "";
    Reverts = "towercab.reverts", Counter, "";
    UsageLimitWaits = "towercab.usage_limit.waits", Counter, "";
    UsageLimitWaitDuration = "towercab.usage_limit.wait.duration", Counter, "s";
    Backlog = "towercab.backlog", Gauge, "";
    LoopState = "towercab.loop.state", Gauge, "";
    Active = "towercab.active", Gauge, "";
    IntentDrafts = "towercab.intent.drafts", Counter, "";
    TimeToIntent = "towercab.intent.time_to_intent", Histogram(&DURATION), "s";
    EditsAfterSpec = "towercab.intent.edits_after_spec", Counter, "";
    SpecLeadDuration = "towercab.spec.lead.duration", Histogram(&DURATION), "s";
    SpecRework = "towercab.spec.rework", Counter, "";
    FirstPass = "towercab.first_pass", Counter, "";
    PlanToMergeDuration = "towercab.plan_to_merge.duration", Histogram(&DURATION), "s";
    ReworkCycles = "towercab.rework.cycles", Histogram(&REWORK), "";
    PlanResult = "towercab.plan.result", Counter, "";
    FindingsRepeated = "towercab.findings.repeated", Counter, "";
    ClaudeMdUpdates = "towercab.claude_md.updates", Counter, "";
    EvalPassRate = "towercab.eval.pass_rate", Gauge, "1";
    EvalGate = "towercab.eval.gate", Counter, "";
    IncidentToEvalDuration = "towercab.incident_to_eval.duration", Histogram(&DURATION), "s";
    Escapes = "towercab.escapes", Counter, "";
    ReviewFindings = "towercab.review.findings", Counter, "";
    ReviewFirstDuration = "towercab.review.first.duration", Histogram(&DURATION), "s";
    FeedbackRounds = "towercab.feedback.rounds", Counter, "";
    GateWaitDuration = "towercab.gate.wait.duration", Histogram(&DURATION), "s";
    GuardBlocks = "towercab.guard.blocks", Counter, "";
    GateViolations = "towercab.gate.violations", Counter, "";
    CiTriage = "towercab.ci.triage", Counter, "";
    Deploys = "towercab.deploys", Counter, "";
    ChangeLeadDuration = "towercab.change.lead.duration", Histogram(&DURATION), "s";
    RestoreDuration = "towercab.restore.duration", Histogram(&DURATION), "s";
    Breaches = "towercab.breaches", Counter, "";
    BreachToIntentDuration = "towercab.breach_to_intent.duration", Histogram(&DURATION), "s";
}

/// Every metric Towercab emits: the dashboard's queries are checked against it.
pub const METRICS: &[Metric] = Metric::ALL;

impl Metric {
    /// Sent every 60 s by the loop: never spooled (a stale one stamped later would lie; the
    /// next minute has a fresh one).
    pub fn periodic(self) -> bool {
        matches!(self, Metric::Backlog | Metric::LoopState | Metric::Active)
    }

    /// By OTel name.
    pub fn by_name(name: &str) -> Option<Metric> {
        Metric::ALL.iter().copied().find(|m| m.name() == name)
    }
}

/// The event attributes of a record (MET-18): never metric labels.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ev {
    pub intent: Option<String>,
    pub stage: Option<String>,
    pub pr: Option<u64>,
}

impl Ev {
    /// No intent.
    pub fn none() -> Ev {
        Ev::default()
    }

    /// A mission's intent, stage and PR.
    pub fn of(m: &Mission) -> Ev {
        Ev {
            intent: m.intent.clone(),
            stage: Some(m.stage.as_str().to_string()),
            pr: m.pr,
        }
    }
}

/// One recorded value.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub metric: Metric,
    pub value: f64,
    pub labels: BTreeMap<String, String>,
    pub ev: Ev,
    /// When recorded, unix seconds.
    pub at: f64,
    /// Its place in this thread's records ([`mark`]).
    pub seq: u64,
}

impl Record {
    /// A label's value.
    pub fn label(&self, k: &str) -> Option<&str> {
        self.labels.get(k).map(String::as_str)
    }

    /// Its spool line.
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "metric": self.metric.name(),
            "value": self.value,
            "labels": self.labels,
            "at": self.at,
        });
        if let Some(i) = &self.ev.intent {
            v["intent_id"] = json!(i);
        }
        if let Some(s) = &self.ev.stage {
            v["stage"] = json!(s);
        }
        if let Some(p) = self.ev.pr {
            v["pr"] = json!(p);
        }
        v
    }

    /// A spool line back; `None` when it doesn't parse.
    pub fn from_json(v: &Value) -> Option<Record> {
        let metric = Metric::by_name(v.get("metric")?.as_str()?)?;
        let labels = v
            .get("labels")?
            .as_object()?
            .iter()
            .map(|(k, x)| Some((k.clone(), x.as_str()?.to_string())))
            .collect::<Option<BTreeMap<_, _>>>()?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Record {
            metric,
            value: v.get("value")?.as_f64()?,
            labels,
            ev: Ev {
                intent: s("intent_id"),
                stage: s("stage"),
                pr: v.get("pr").and_then(Value::as_u64),
            },
            at: v.get("at")?.as_f64()?,
            seq: 0,
        })
    }
}

#[derive(Default)]
struct Buf {
    records: VecDeque<Record>,
    seq: u64,
    /// Live [`EvalScope`]s.
    eval: usize,
}

thread_local! {
    static BUF: RefCell<Buf> = RefCell::new(Buf::default());
}

fn now_unix() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

fn record(metric: Metric, value: f64, labels: &[(&str, &str)], ev: &Ev) {
    if !value.is_finite() {
        return;
    }
    BUF.with(|b| {
        let mut b = b.borrow_mut();
        if b.eval > 0 && !matches!(metric, Metric::CostUsd | Metric::Tokens) {
            return;
        }
        let seq = b.seq;
        b.seq += 1;
        b.records.push_back(Record {
            metric,
            value,
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ev: ev.clone(),
            at: now_unix(),
            seq,
        });
        while b.records.len() > BUFFER {
            b.records.pop_front();
        }
    });
}

/// Adds `value` to a counter.
pub fn add(metric: Metric, value: f64, labels: &[(&str, &str)], ev: &Ev) {
    debug_assert_eq!(metric.instrument(), Counter, "{}", metric.name());
    record(metric, value, labels, ev);
}

/// One histogram sample.
pub fn observe(metric: Metric, value: f64, labels: &[(&str, &str)], ev: &Ev) {
    debug_assert!(
        matches!(metric.instrument(), Histogram(_)),
        "{}",
        metric.name()
    );
    record(metric, value, labels, ev);
}

/// A gauge's current value.
pub fn gauge(metric: Metric, value: f64, labels: &[(&str, &str)]) {
    debug_assert_eq!(metric.instrument(), Gauge, "{}", metric.name());
    record(metric, value, labels, &Ev::none());
}

/// This thread's records so far, oldest first; the buffer is empty after.
pub fn take() -> Vec<Record> {
    BUF.with(|b| b.borrow_mut().records.drain(..).collect())
}

/// The next record's number: [`drop_since`] it drops what was recorded after.
pub fn mark() -> u64 {
    BUF.with(|b| b.borrow().seq)
}

/// Drops the records made since `mark` (a rolled-back transaction's, `Db::tx`).
pub fn drop_since(mark: u64) {
    BUF.with(|b| b.borrow_mut().records.retain(|r| r.seq < mark));
}

/// While one lives, only `cost.usd` and `tokens` are recorded on this thread (PIP-33's
/// replays: their stages are no real intent's).
pub struct EvalScope(());

/// See [`EvalScope`].
pub fn eval_scope() -> EvalScope {
    BUF.with(|b| b.borrow_mut().eval += 1);
    EvalScope(())
}

impl Drop for EvalScope {
    fn drop(&mut self) {
        BUF.with(|b| {
            let mut b = b.borrow_mut();
            b.eval = b.eval.saturating_sub(1);
        });
    }
}

fn nanos(t: f64) -> String {
    ((t.max(0.0) * 1e9) as u64).to_string()
}

fn attrs<'a>(kv: impl IntoIterator<Item = (&'a str, String)>) -> Vec<Value> {
    kv.into_iter()
        .map(|(k, v)| json!({"key": k, "value": {"stringValue": v}}))
        .collect()
}

fn resource() -> Value {
    json!({"attributes": attrs([("service.name", SERVICE.to_string())])})
}

fn scope() -> Value {
    json!({"name": "towercab", "version": env!("CARGO_PKG_VERSION")})
}

/// Records aggregated per (metric, labels).
struct Agg {
    value: f64,
    count: u64,
    buckets: Vec<u64>,
    first: f64,
}

/// The OTLP/HTTP JSON bodies of `records` sent at `now` (unix s): `/v1/metrics` (counters
/// summed, histograms merged, gauges the last value per (metric, labels); every point stamped
/// `now`) and `/v1/logs` (one record per counter or histogram record, at its own time).
pub fn payload(records: &[Record], now: f64) -> (Value, Value) {
    let mut agg: BTreeMap<(Metric, Vec<(String, String)>), Agg> = BTreeMap::new();
    for r in records {
        let key = (
            r.metric,
            r.labels
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        );
        let bounds: &[f64] = match r.metric.instrument() {
            Histogram(b) => b,
            _ => &[],
        };
        let a = agg.entry(key).or_insert_with(|| Agg {
            value: 0.0,
            count: 0,
            buckets: vec![0; bounds.len() + 1],
            first: r.at,
        });
        a.first = a.first.min(r.at);
        a.count += 1;
        match r.metric.instrument() {
            Counter => a.value += r.value,
            Gauge => a.value = r.value,
            Histogram(b) => {
                a.value += r.value;
                let i = b.iter().position(|x| r.value <= *x).unwrap_or(b.len());
                a.buckets[i] += 1;
            }
        }
    }
    let mut by_metric: BTreeMap<Metric, Vec<Value>> = BTreeMap::new();
    for ((metric, labels), a) in &agg {
        let start = match metric.instrument() {
            Gauge => now,
            _ => a.first.max(now - MAX_AGE).min(now - 0.001),
        };
        let mut p = json!({
            "attributes": attrs(labels.iter().map(|(k, v)| (k.as_str(), v.clone()))),
            "startTimeUnixNano": nanos(start),
            "timeUnixNano": nanos(now),
        });
        match metric.instrument() {
            Counter | Gauge => p["asDouble"] = json!(a.value),
            Histogram(b) => {
                p["count"] = json!(a.count.to_string());
                p["sum"] = json!(a.value);
                p["bucketCounts"] =
                    json!(a.buckets.iter().map(|n| n.to_string()).collect::<Vec<_>>());
                p["explicitBounds"] = json!(b);
            }
        }
        by_metric.entry(*metric).or_default().push(p);
    }
    let metrics: Vec<Value> = by_metric
        .into_iter()
        .map(|(m, points)| {
            let mut v = json!({"name": m.name(), "unit": m.unit()});
            match m.instrument() {
                Counter => {
                    v["sum"] = json!({"aggregationTemporality": DELTA, "isMonotonic": true, "dataPoints": points})
                }
                Histogram(_) => {
                    v["histogram"] =
                        json!({"aggregationTemporality": DELTA, "dataPoints": points})
                }
                Gauge => v["gauge"] = json!({"dataPoints": points}),
            }
            v
        })
        .collect();
    let logs: Vec<Value> = records
        .iter()
        .filter(|r| r.metric.instrument() != Gauge)
        .map(|r| {
            let value = r.value.to_string();
            let mut kv: Vec<(&str, String)> = r
                .labels
                .iter()
                .map(|(k, v)| (k.as_str(), v.clone()))
                .collect();
            kv.push(("metric", r.metric.name().to_string()));
            kv.push(("value", value.clone()));
            if let Some(i) = &r.ev.intent {
                kv.push(("intent_id", i.clone()));
            }
            if let Some(s) = &r.ev.stage {
                kv.push(("stage", s.clone()));
            }
            if let Some(p) = r.ev.pr {
                kv.push(("pr", p.to_string()));
            }
            json!({
                "timeUnixNano": nanos(r.at),
                "observedTimeUnixNano": nanos(now),
                "severityNumber": 9,
                "severityText": "INFO",
                "body": {"stringValue": format!("{} {value}", r.metric.name())},
                "attributes": attrs(kv),
            })
        })
        .collect();
    let m = json!({"resourceMetrics": [{"resource": resource(),
        "scopeMetrics": [{"scope": scope(), "metrics": metrics}]}]});
    let l = json!({"resourceLogs": [{"resource": resource(),
        "scopeLogs": [{"scope": scope(), "logRecords": logs}]}]});
    (m, l)
}

fn open_spool(path: &Path) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

/// Waits up to `wait` for `f`'s `flock` (held by others only around file I/O, never the network).
fn lock_within(f: &File, wait: Duration) -> bool {
    let end = Instant::now() + wait;
    loop {
        match f.try_lock() {
            Ok(()) => return true,
            Err(TryLockError::WouldBlock) if Instant::now() < end => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(_) => return false,
        }
    }
}

fn read_all(f: &mut File) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    f.seek(SeekFrom::Start(0))?;
    f.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn rewrite(f: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    f.set_len(0)?;
    f.seek(SeekFrom::Start(0))?;
    f.write_all(bytes)?;
    f.flush()
}

/// The spool's non-empty lines, as bytes (a torn or invalid UTF-8 line only spoils itself).
fn raw_lines(bytes: &[u8]) -> impl DoubleEndedIterator<Item = &[u8]> {
    bytes
        .split(|b| *b == b'\n')
        .filter(|l| !l.iter().all(u8::is_ascii_whitespace))
}

fn parse_line(line: &[u8]) -> Option<Record> {
    let text = std::str::from_utf8(line).ok()?;
    Record::from_json(&serde_json::from_str(text).ok()?)
}

/// Appends `records` but periodic gauges to the spool (under `flock`, waited for at most
/// [`LOCK_WAIT`], else they are dropped); one that would pass [`SPOOL_MAX`] first drops the
/// oldest lines down to half of it. Errors are logged, never raised: metrics never fail the loop.
pub fn spool_append(path: &Path, records: &[Record]) {
    let new: String = records
        .iter()
        .filter(|r| !r.metric.periodic())
        .map(|r| r.to_json().to_string() + "\n")
        .collect();
    if new.is_empty() {
        return;
    }
    let r = (|| -> std::io::Result<bool> {
        let mut f = open_spool(path)?;
        if !lock_within(&f, LOCK_WAIT) {
            return Ok(false);
        }
        let len = f.metadata()?.len();
        if len + new.len() as u64 > SPOOL_MAX {
            let bytes = read_all(&mut f)?;
            let mut keep: Vec<&[u8]> = Vec::new();
            let mut size = new.len() as u64;
            for l in raw_lines(&bytes).rev() {
                size += l.len() as u64 + 1;
                if size > SPOOL_MAX / 2 {
                    break;
                }
                keep.push(l);
            }
            let mut all: Vec<u8> = Vec::with_capacity(size as usize);
            for l in keep.into_iter().rev() {
                all.extend_from_slice(l);
                all.push(b'\n');
            }
            all.extend_from_slice(new.as_bytes());
            rewrite(&mut f, &all)?;
        } else {
            // A torn last line (a crash mid-write) stays alone, not glued to the first new one.
            let mut last = *b"\n";
            if len > 0 {
                f.seek(SeekFrom::End(-1))?;
                f.read_exact(&mut last)?;
            }
            f.seek(SeekFrom::End(0))?;
            if last[0] != b'\n' {
                f.write_all(b"\n")?;
            }
            f.write_all(new.as_bytes())?;
        }
        f.flush()?;
        Ok(true)
    })();
    match r {
        Ok(true) => {}
        Ok(false) => eprintln!(
            "towercab: metrics spool {}: locked past {} ms: dropped {} records",
            path.display(),
            LOCK_WAIT.as_millis(),
            new.lines().count()
        ),
        Err(e) => eprintln!("towercab: metrics spool {}: {e}", path.display()),
    }
}

/// The spool's records, oldest first (at most `max`; lines that don't parse are skipped).
pub fn spool_read(path: &Path, max: usize) -> Vec<Record> {
    let bytes = fs::read(path).unwrap_or_default();
    raw_lines(&bytes).filter_map(parse_line).take(max).collect()
}

/// Up to [`REPLAY`] records from the spool's head, and the head's bytes they came from (lines
/// that don't parse included: they leave with it).
fn spool_head(path: &Path) -> (Vec<Record>, Vec<u8>) {
    let none = (Vec::new(), Vec::new());
    if fs::metadata(path).map_or(true, |m| m.len() == 0) {
        return none;
    }
    let Ok(mut f) = open_spool(path) else {
        return none;
    };
    if !lock_within(&f, LOCK_WAIT) {
        return none;
    }
    let Ok(bytes) = read_all(&mut f) else {
        return none;
    };
    drop(f);
    let (mut old, mut pos) = (Vec::new(), 0);
    while pos < bytes.len() && old.len() < REPLAY {
        let end = bytes[pos..]
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| pos + i + 1);
        old.extend(parse_line(bytes[pos..end].trim_ascii()));
        pos = end;
    }
    (old, bytes[..pos].to_vec())
}

/// Removes `head` (from [`spool_head`]) from the spool, keeping what was appended since. The
/// file is truncated, never unlinked: another process may hold it open. An append that trimmed
/// the spool meanwhile kept only a tail of `head`: that tail goes.
fn spool_drop(path: &Path, head: &[u8]) {
    if head.is_empty() {
        return;
    }
    let r = (|| -> std::io::Result<()> {
        let mut f = open_spool(path)?;
        if !lock_within(&f, LOCK_WAIT) {
            return Err(std::io::Error::other("locked"));
        }
        let bytes = read_all(&mut f)?;
        let starts =
            std::iter::once(0).chain((0..head.len()).filter(|&i| head[i] == b'\n').map(|i| i + 1));
        for at in starts {
            if bytes.starts_with(&head[at..]) {
                return if at == head.len() {
                    Ok(())
                } else {
                    rewrite(&mut f, &bytes[head.len() - at..])
                };
            }
        }
        Ok(())
    })();
    if let Err(e) = r {
        eprintln!(
            "towercab: metrics spool {}: replayed lines kept: {e}",
            path.display()
        );
    }
}

/// Where records go: `[metrics].endpoint`, else the spool.
#[derive(Debug, Clone, PartialEq)]
pub struct Sink {
    /// `[metrics].endpoint` without a trailing `/`.
    pub endpoint: String,
    /// `<home>/metrics.jsonl`.
    pub spool: PathBuf,
    /// Monotonic time until which flushes go straight to the spool (a failed send).
    pub down_until: Option<Duration>,
}

impl Sink {
    pub fn new(config: &Config, home: &Home) -> Sink {
        Sink {
            endpoint: config.metrics.endpoint.trim_end_matches('/').to_string(),
            spool: home.root.join("metrics.jsonl"),
            down_until: None,
        }
    }

    /// Sends this thread's records (see [`Sink::send`]). Not while an [`EvalScope`] lives: a
    /// replay's scratch loop keeps them for the `towercab eval` flush into the real home.
    pub fn flush(&mut self, now: Tick) {
        if BUF.with(|b| b.borrow().eval > 0) {
            return;
        }
        let records = take();
        self.send(records, now);
    }

    /// `records`, after up to [`REPLAY`] spooled ones (when no other process is replaying:
    /// `<spool>.replay` is `flock`ed across the POSTs), as one `/v1/logs` and one `/v1/metrics`
    /// POST, [`TIMEOUT`] each, all stamped `now`; both answered 2xx → the replayed lines leave
    /// the spool. A 4xx but 408/429 → the batch is dropped (replayed lines too), one log line.
    /// Else, or within [`RETRY`] of a failure, `records` go to the spool. Never fails.
    pub fn send(&mut self, records: Vec<Record>, now: Tick) {
        if self.down_until.is_some_and(|d| now.mono < d) {
            spool_append(&self.spool, &records);
            return;
        }
        let replayer = self.replayer();
        let (old, head) = match replayer {
            Some(_) => spool_head(&self.spool),
            None => (Vec::new(), Vec::new()),
        };
        if old.is_empty() && records.is_empty() {
            spool_drop(&self.spool, &head);
            return;
        }
        let mut all = old;
        all.extend(records.iter().cloned());
        let (m, l) = payload(&all, now.wall.timestamp_micros() as f64 / 1e6);
        let has_logs = all.iter().any(|r| r.metric.instrument() != Gauge);
        let sent = if has_logs {
            self.post("/v1/logs", &l)
        } else {
            Ok(())
        }
        .and_then(|()| self.post("/v1/metrics", &m));
        match sent {
            Ok(()) => {
                self.down_until = None;
                spool_drop(&self.spool, &head);
            }
            Err(crate::http::HttpError::Status(code, why))
                if (400..500).contains(&code) && code != 408 && code != 429 =>
            {
                eprintln!(
                    "towercab: metrics {}: HTTP {code}: dropped {} records: {why}",
                    self.endpoint,
                    all.len()
                );
                spool_drop(&self.spool, &head);
            }
            Err(_) => {
                self.down_until = Some(now.mono + RETRY);
                spool_append(&self.spool, &records);
            }
        }
    }

    /// `<spool>.replay`, `flock`ed (not waited for), when there is a spool to replay.
    fn replayer(&self) -> Option<File> {
        if fs::metadata(&self.spool).map_or(true, |m| m.len() == 0) {
            return None;
        }
        let mut name = self.spool.file_name()?.to_os_string();
        name.push(".replay");
        let f = open_spool(&self.spool.with_file_name(name)).ok()?;
        f.try_lock().ok()?;
        Some(f)
    }

    fn post(&self, path: &str, body: &Value) -> Result<(), crate::http::HttpError> {
        let url = format!("{}{path}", self.endpoint);
        crate::http::post_any(&url, body, TIMEOUT).map(drop)
    }
}
