//! A mission's stage history (UI-23, UI-24): the visits to each stage and the PR each had,
//! derived from `transitions` and the `missions` row. Pure: no database, no files, no clock.

use serde_json::Value;

use super::Transition;
use crate::machine::Kind;
use crate::mission::Mission;
use crate::pipeline::data::Data;

/// A file in the mission's runs dir (UI-10), by name.
#[derive(Debug, Clone, PartialEq)]
pub struct RunFile {
    pub name: String,
}

/// What Towercab recorded about a PR, never GitHub's current word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

impl PrState {
    pub fn as_str(self) -> &'static str {
        match self {
            PrState::Open => "open",
            PrState::Merged => "merged",
            PrState::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrRef {
    pub url: String,
    pub state: PrState,
    pub merged_at: Option<f64>,
}

/// One stay in a stage.
#[derive(Debug, Clone, PartialEq)]
pub struct StageVisit {
    pub stage: String,
    pub attempt: u32,
    pub entered: f64,
    /// `None` while the mission is still in the stage.
    pub left: Option<f64>,
    /// The event and why that ended the visit.
    pub event: Option<String>,
    pub why: Option<String>,
    pub pr: Option<PrRef>,
    /// Run files of the stage's family (`build.txt`, `ci-1.log`, `verify-2.json` …).
    pub files: Vec<String>,
}

impl StageVisit {
    /// Seconds in the stage; `now` ends a visit still going.
    pub fn secs(&self, now: f64) -> f64 {
        (self.left.unwrap_or(now) - self.entered).max(0.0)
    }
}

/// One PR of an intent (UI-26).
#[derive(Debug, Clone, PartialEq)]
pub struct PrRow {
    pub attempt: u32,
    pub mission: i64,
    /// The stage that opened it: `design` (the spec PR), `publish`, `revert`.
    pub stage: String,
    pub url: String,
    pub state: PrState,
    pub opened: Option<f64>,
    pub merged_at: Option<f64>,
}

/// The spec PR a mission merged on its own before building, kept by the loop (`data.spec_pr`).
fn spec_pr(d: &Data) -> Option<(String, Option<f64>, Option<f64>)> {
    let s = d.get("spec_pr")?;
    let url = s.get("url")?.as_str()?.to_string();
    let f = |k: &str| s.get(k).and_then(Value::as_f64);
    Some((url, f("merged_at"), f("pushed_at")))
}

/// A revert mission's PR (`data.revert.url`).
fn revert_pr(d: &Data) -> Option<(String, bool)> {
    let r = d.get("revert")?;
    let url = r.get("url")?.as_str()?.to_string();
    let merged = r.get("merge_sha").is_some_and(|v| !v.is_null());
    Some((url, merged))
}

/// When the mission went on from its merge: the first move out of `merge`, or a merge seen
/// from outside (`pr_merged`).
fn merged_at(m: &Mission, ts: &[Transition]) -> Option<f64> {
    let merge = if m.kind == Kind::Revert {
        "revert_merge"
    } else {
        "merge"
    };
    ts.iter()
        .find(|t| t.from == merge || t.event == "pr_merged")
        .map(|t| t.at)
}

fn state_of(m: &Mission, merged: bool) -> PrState {
    if merged {
        PrState::Merged
    } else if m.finished.is_some() {
        PrState::Closed
    } else {
        PrState::Open
    }
}

fn family(stage: &str, name: &str) -> bool {
    name == format!("{stage}.txt") || name.strip_prefix(stage).is_some_and(|r| r.starts_with('-'))
}

/// Every visit to every stage, in the order they happened.
pub fn history(m: &Mission, ts: &[Transition], files: &[RunFile]) -> Vec<StageVisit> {
    let mut visits: Vec<StageVisit> = Vec::new();
    let mut stage = ts
        .first()
        .map_or_else(|| m.stage.as_str().to_string(), |t| t.from.clone());
    let mut entered = m.created;
    for t in ts {
        visits.push(StageVisit {
            stage: stage.clone(),
            attempt: m.attempt,
            entered,
            left: Some(t.at),
            event: Some(t.event.clone()),
            why: t.why.clone(),
            pr: None,
            files: vec![],
        });
        stage = t.to.clone();
        entered = t.at;
    }
    visits.push(StageVisit {
        stage,
        attempt: m.attempt,
        entered,
        left: None,
        event: None,
        why: None,
        pr: None,
        files: vec![],
    });

    let data = Data::of(m);
    let first_publish = visits
        .iter()
        .find(|v| v.stage == "publish")
        .map(|v| v.entered);
    let merged = merged_at(m, ts);
    for v in &mut visits {
        v.files = files
            .iter()
            .filter(|f| family(&v.stage, &f.name))
            .map(|f| f.name.clone())
            .collect();
        v.pr = match m.kind {
            Kind::Revert => match v.stage.as_str() {
                "revert" | "revert_ci" | "revert_merge" | "revert_deploy" | "revert_e2e"
                | "done" => revert_pr(&data).map(|(url, mg)| PrRef {
                    url,
                    state: state_of(m, mg),
                    merged_at: if mg { merged } else { None },
                }),
                _ => None,
            },
            Kind::Rehearsal => None,
            Kind::Intent => match v.stage.as_str() {
                "pick" => None,
                "design" | "plan" | "approval:spec" => match spec_pr(&data) {
                    Some((url, at, _)) => Some(PrRef {
                        url,
                        state: PrState::Merged,
                        merged_at: at,
                    }),
                    None => row_pr(m, merged),
                },
                _ if first_publish.is_some_and(|p| v.left.is_none_or(|l| l > p)) => {
                    row_pr(m, merged)
                }
                _ => None,
            },
        };
    }
    visits
}

/// The PR in the mission's own `pr_url`.
fn row_pr(m: &Mission, merged_at: Option<f64>) -> Option<PrRef> {
    let url = m.pr_url.clone()?;
    let merged = m.merge_sha.is_some() || m.merged_by.is_some();
    Some(PrRef {
        url,
        state: state_of(m, merged),
        merged_at: if merged { merged_at } else { None },
    })
}

/// Every PR an intent had, one row per mission (attempt) and opening stage, by attempt.
pub fn intent_prs(missions: &[(Mission, Vec<Transition>)]) -> Vec<PrRow> {
    let mut rows = Vec::new();
    for (m, ts) in missions {
        let data = Data::of(m);
        let mut push = |stage: &str, pr: PrRef, opened: Option<f64>| {
            rows.push(PrRow {
                attempt: m.attempt,
                mission: m.id,
                stage: stage.into(),
                url: pr.url,
                state: pr.state,
                opened,
                merged_at: pr.merged_at,
            });
        };
        if m.kind == Kind::Revert {
            if let Some((url, mg)) = revert_pr(&data) {
                let merged = merged_at(m, ts);
                let pr = PrRef {
                    url,
                    state: state_of(m, mg),
                    merged_at: if mg { merged } else { None },
                };
                push("revert", pr, None);
            }
            continue;
        }
        if let Some((url, at, opened)) = spec_pr(&data) {
            let pr = PrRef {
                url,
                state: PrState::Merged,
                merged_at: at,
            };
            push("design", pr, opened);
        }
        if let Some(pr) = row_pr(m, merged_at(m, ts)) {
            push("publish", pr, m.pushed_at);
        }
    }
    rows.sort_by(|a, b| a.attempt.cmp(&b.attempt).then(a.mission.cmp(&b.mission)));
    rows
}
