//! Prometheus range queries (MNT-3) on a helper thread: a pass only takes answers that came,
//! so a slow or dead Prometheus never blocks it.

use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::http;

/// Each query's bound.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// One band's range query.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub band: String,
    pub query: String,
    pub start: f64,
    pub end: f64,
    /// Seconds.
    pub step: u64,
}

/// A band's answer: its points (unix s, value), oldest first, or why not.
pub type Answer = (String, Result<Vec<(f64, f64)>, String>);

/// RFC 3986 unreserved characters kept, every other byte `%XX`.
pub fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `/api/v1/query_range`'s JSON → the one series' points (non-finite values skipped); no
/// series → none; more than one → why.
pub fn parse_matrix(v: &Value) -> Result<Vec<(f64, f64)>, String> {
    if v.get("status").and_then(Value::as_str) != Some("success") {
        let e = v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("no status");
        return Err(format!("prometheus: {e}"));
    }
    let data = v.get("data").ok_or("prometheus: no data")?;
    if data.get("resultType").and_then(Value::as_str) != Some("matrix") {
        return Err("prometheus: not a matrix".into());
    }
    let series = data
        .get("result")
        .and_then(Value::as_array)
        .ok_or("prometheus: no result")?;
    match series.as_slice() {
        [] => Ok(Vec::new()),
        [one] => Ok(one
            .get("values")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let t = p.get(0)?.as_f64()?;
                        let v: f64 = p.get(1)?.as_str()?.parse().ok()?;
                        v.is_finite().then_some((t, v))
                    })
                    .collect()
            })
            .unwrap_or_default()),
        more => Err(format!("{} series: aggregate the query to one", more.len())),
    }
}

/// `GET <base>/api/v1/query_range?query=…&start=…&end=…&step=…` → the points.
pub fn query_range(base: &str, q: &Query, timeout: Duration) -> Result<Vec<(f64, f64)>, String> {
    let url = format!(
        "{}/api/v1/query_range?query={}&start={}&end={}&step={}",
        base.trim_end_matches('/'),
        encode(&q.query),
        q.start,
        q.end,
        q.step
    );
    let (_, v) = http::get_json(&url, &[], timeout).map_err(|e| e.to_string())?;
    parse_matrix(&v)
}

/// Queries running on their own thread.
#[derive(Debug)]
pub struct Fetch {
    rx: Receiver<Vec<Answer>>,
}

impl Fetch {
    /// Each query in turn against `base`, on a new thread.
    pub fn start(base: &str, queries: Vec<Query>, timeout: Duration) -> Fetch {
        let (tx, rx) = mpsc::channel();
        let base = base.to_string();
        thread::spawn(move || {
            let answers: Vec<Answer> = queries
                .iter()
                .map(|q| (q.band.clone(), query_range(&base, q, timeout)))
                .collect();
            let _ = tx.send(answers);
        });
        Fetch { rx }
    }

    /// The answers once they came (never waits); a thread that died → every band failed.
    pub fn poll(&self) -> Option<Result<Vec<Answer>, String>> {
        match self.rx.try_recv() {
            Ok(a) => Some(Ok(a)),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => Some(Err("prometheus: query thread died".into())),
        }
    }
}
