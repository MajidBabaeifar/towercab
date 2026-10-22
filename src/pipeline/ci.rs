//! CI (PIP-3, PIP-18): Towercab polls the PR's checks (`gh pr view --json
//! headRefOid,mergeable,statusCheckRollup`) every `ci_poll` s and buckets them in code
//! ([`bucket`]). Only checks on `missions.head` count; a moved head is adopted. A red or
//! cancelled Actions run is rerun once (`gh run rerun --failed`), then its failed log goes to
//! the worker as a CI repair (cap 3, then `waiting: CI red`). `towercab/*` checks are
//! Towercab's own and never CI.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use chrono::DateTime;
use regex::Regex;
use serde_json::{Value, json};

use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::{Event, Waiting};
use crate::mission::Mission;

use super::data::Data;
use super::gh;
use super::verify::{TAIL, tail};
use super::{Mode, git as pgit, never_published, wait_note};

/// Which mission's CI: an intent's (`ci`), a revert's (`revert_ci`) or a rehearsal's
/// (`rehearse_ci`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seq {
    Intent,
    /// No repairs: red after the rerun, stuck or no checks → `revert failed` (PIP-19).
    Revert,
    /// No rerun: red or stuck → `red` (PIP-35).
    Rehearsal,
}

/// A check run or a commit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckKind {
    CheckRun,
    Status,
}

/// One entry of `statusCheckRollup`.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    /// A check run's `name`, a status's `context`.
    pub name: String,
    pub kind: CheckKind,
    /// `COMPLETED`, `IN_PROGRESS`, `QUEUED`, …; a status: `COMPLETED` unless its state is
    /// `PENDING` or `EXPECTED` (then `PENDING`).
    pub status: String,
    /// A check run's `conclusion`, a status's `state`.
    pub conclusion: String,
    /// Unix seconds.
    pub started_at: Option<f64>,
    /// The Actions run (`/actions/runs/<run>/` in its `detailsUrl`).
    pub run: Option<u64>,
    /// `detailsUrl` or `targetUrl`.
    pub url: String,
}

/// What the checks say.
#[derive(Debug, Clone, PartialEq)]
pub enum Bucket {
    Pending,
    Green,
    /// The failed checks.
    Red(Vec<Check>),
    /// The cancelled checks (none failed).
    Cancel(Vec<Check>),
    /// No checks counted, the grace over.
    None,
}

static RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/actions/runs/(\d+)(?:/|$)").expect("run regex"));

/// The Actions run of a check's `detailsUrl` (`…/actions/runs/<run>/job/<job>`).
pub fn run_id(details_url: &str) -> Option<u64> {
    RUN.captures(details_url)?.get(1)?.as_str().parse().ok()
}

fn unix(s: &str) -> Option<f64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp() as f64)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `statusCheckRollup`'s entries → [`Check`]s.
pub fn checks(rollup: &Value) -> Vec<Check> {
    let Some(a) = rollup.as_array() else {
        return Vec::new();
    };
    a.iter()
        .map(|c| {
            let started = unix(&s(c, "startedAt")).or_else(|| unix(&s(c, "createdAt")));
            if c.get("__typename").and_then(Value::as_str) == Some("StatusContext")
                || (c.get("context").is_some() && c.get("name").is_none())
            {
                let state = s(c, "state");
                let status = if matches!(state.as_str(), "PENDING" | "EXPECTED" | "") {
                    "PENDING"
                } else {
                    "COMPLETED"
                };
                Check {
                    name: s(c, "context"),
                    kind: CheckKind::Status,
                    status: status.into(),
                    conclusion: state,
                    started_at: started,
                    run: None,
                    url: s(c, "targetUrl"),
                }
            } else {
                let url = s(c, "detailsUrl");
                Check {
                    name: s(c, "name"),
                    kind: CheckKind::CheckRun,
                    status: s(c, "status"),
                    conclusion: s(c, "conclusion"),
                    started_at: started,
                    run: run_id(&url),
                    url,
                }
            }
        })
        .collect()
}

fn passed(c: &Check) -> bool {
    match c.kind {
        CheckKind::CheckRun => {
            c.status == "COMPLETED"
                && matches!(c.conclusion.as_str(), "SUCCESS" | "NEUTRAL" | "SKIPPED")
        }
        CheckKind::Status => c.conclusion == "SUCCESS",
    }
}

fn failed(c: &Check) -> bool {
    match c.kind {
        CheckKind::CheckRun => {
            c.status == "COMPLETED"
                && matches!(
                    c.conclusion.as_str(),
                    "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
                )
        }
        CheckKind::Status => matches!(c.conclusion.as_str(), "FAILURE" | "ERROR"),
    }
}

fn cancelled(c: &Check) -> bool {
    c.kind == CheckKind::CheckRun && c.status == "COMPLETED" && c.conclusion == "CANCELLED"
}

/// The checks in code (PIP-3): `towercab/*` ignored; within `grace` s of `pushed_at`, checks
/// started before the push are ignored and none counted = pending (after it: `None`). A
/// failed check → `Red`, else a cancelled one → `Cancel`, else any not passed → `Pending`,
/// else `Green`.
pub fn bucket(checks: &[Check], pushed_at: f64, now: f64, grace: f64) -> Bucket {
    let within = now - pushed_at < grace;
    let counted: Vec<&Check> = checks
        .iter()
        .filter(|c| !c.name.starts_with("towercab/"))
        .filter(|c| !(within && c.started_at.is_some_and(|t| t < pushed_at)))
        .collect();
    if counted.is_empty() {
        return if within {
            Bucket::Pending
        } else {
            Bucket::None
        };
    }
    let red: Vec<Check> = counted
        .iter()
        .filter(|c| failed(c))
        .map(|c| (*c).clone())
        .collect();
    if !red.is_empty() {
        return Bucket::Red(red);
    }
    let cancel: Vec<Check> = counted
        .iter()
        .filter(|c| cancelled(c))
        .map(|c| (*c).clone())
        .collect();
    if !cancel.is_empty() {
        return Bucket::Cancel(cancel);
    }
    if counted.iter().all(|c| passed(c)) {
        Bucket::Green
    } else {
        Bucket::Pending
    }
}

/// The fields of `ci`'s `gh pr view`.
pub const CI_FIELDS: &str = "headRefOid,mergeable,statusCheckRollup";

/// `pr view <n> --json headRefOid,mergeable,statusCheckRollup` → (head, mergeable, checks).
pub fn rollup(json: &str) -> Result<(String, String, Vec<Check>), String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("gh pr view: {e}"))?;
    if !v.is_object() {
        return Err("gh pr view: not an object".into());
    }
    Ok((
        s(&v, "headRefOid"),
        s(&v, "mergeable"),
        checks(v.get("statusCheckRollup").unwrap_or(&Value::Null)),
    ))
}

/// The PR whose CI runs: number, head, pushed at; and where they live (the mission's columns,
/// or `data.revert` / `data.rehearsal`).
struct Target {
    pr: u64,
    head: Option<String>,
    pushed_at: Option<f64>,
}

/// The `ci` stage (and, from part 4, `revert_ci`, `rehearse_ci`).
pub struct Ci {
    pub seq: Seq,
    mode: Mode,
}

impl Ci {
    pub fn new(seq: Seq, mode: Mode) -> Ci {
        Ci { seq, mode }
    }

    fn key(&self) -> Option<&'static str> {
        match self.seq {
            Seq::Intent => None,
            Seq::Revert => Some("revert"),
            Seq::Rehearsal => Some("rehearsal"),
        }
    }

    fn target(&self, m: &Mission) -> Option<Target> {
        match self.key() {
            None => Some(Target {
                pr: m.pr?,
                head: m.head.clone(),
                pushed_at: m.pushed_at,
            }),
            Some(k) => {
                let data = Data::of(m);
                let d = data.get(k)?;
                Some(Target {
                    pr: d.get("pr")?.as_u64()?,
                    head: d.get("head").and_then(Value::as_str).map(str::to_string),
                    pushed_at: d.get("pushed_at").and_then(Value::as_f64),
                })
            }
        }
    }

    /// A wait of a revert or rehearsal, or an intent's (with its note for PIP-14's waits).
    fn give_up(
        &self,
        cx: &Ctx<'_>,
        m: &Mission,
        data: &Data,
        w: Waiting,
        why: &str,
        note: &str,
    ) -> Result<Progress, StepError> {
        let m = cx.record(m, &m.step, &[("data", data.text().into())])?;
        match self.seq {
            Seq::Intent => wait_note(cx, &m, w, why, note),
            Seq::Revert => Ok(Progress::Done(Outcome::wait(
                Waiting::RevertFailed,
                format!("revert CI: {why}"),
            ))),
            Seq::Rehearsal => Ok(Progress::Done(Outcome::red(format!("rehearsal CI: {why}")))),
        }
    }

    /// One poll (PIP-3, PIP-18).
    fn poll(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let Some(t) = self.target(m) else {
            return Ok(never_published(m).unwrap_or_else(|| {
                Progress::Done(Outcome::bad_result(format!("{}: no PR for CI", m.label())))
            }));
        };
        let github = gh::github(cx, m)?;
        let n = t.pr.to_string();
        let out = gh::gh(
            cx,
            m,
            &["pr", "view", &n, "-R", &github, "--json", CI_FIELDS],
        )?;
        let (head, mergeable, all) = rollup(&out).map_err(StepError::Bug)?;
        let now = cx.tick.unix();
        let mut data = Data::of(m);
        let mut ci = data.get("ci").cloned().unwrap_or(Value::Null);
        let mut m = m.clone();
        let mut pushed_at = t.pushed_at.unwrap_or(now);
        let mut current = t.head.clone();
        // Checks count only for the head of this read (PIP-18): another one is adopted.
        if !head.is_empty() && t.head.as_deref() != Some(head.as_str()) {
            pushed_at = now;
            current = Some(head.clone());
            let mut set: Vec<(&str, rusqlite::types::Value)> = Vec::new();
            match self.key() {
                None => {
                    set.push(("head", head.clone().into()));
                    set.push(("pushed_at", now.into()));
                }
                Some(k) => {
                    let mut d = data.get(k).cloned().unwrap_or(json!({}));
                    d["head"] = json!(head);
                    d["pushed_at"] = json!(now);
                    data.set(k, d);
                }
            }
            ci = Value::Null;
            data.set("ci", Value::Null);
            set.push(("data", data.text().into()));
            m = cx.record(&m, "poll", &set)?;
        }
        let current = current.unwrap_or_default();
        if ci.get("head").and_then(Value::as_str) != Some(current.as_str()) {
            ci = json!({"head": current, "reruns": [], "cancels": 0, "since": pushed_at});
        }
        if self.seq == Seq::Intent && mergeable == "CONFLICTING" {
            data.set("ci", ci);
            let m = cx.record(&m, "poll", &[("data", data.text().into())])?;
            let _ = m;
            return Ok(Progress::Done(Outcome::event(Event::Conflict)));
        }
        let config = &cx.config.agent;
        let waited = now - pushed_at >= config.ci_wait.as_secs_f64() && cx.timeouts;
        let mins = config.ci_wait.as_secs().div_ceil(60);
        let b = bucket(&all, pushed_at, now, config.ci_grace.as_secs_f64());
        let reruns: BTreeSet<u64> = ci["reruns"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default();
        let poll = |cx: &Ctx<'_>, m: &Mission, data: &mut Data, ci: Value| {
            data.set("ci", ci);
            cx.record(m, "poll", &[("data", data.text().into())])?;
            Ok(Progress::Poll {
                after: cx.config.agent.ci_poll,
            })
        };
        match b {
            Bucket::Pending if waited => {
                data.set("ci", ci);
                let why = format!("checks still pending {mins} min after the push");
                let note = format!(
                    "CI stuck: {why}. Look at the PR's checks, then remove `waiting` to wait again."
                );
                self.give_up(cx, &m, &data, Waiting::CiStuck, &why, &note)
            }
            Bucket::Pending => poll(cx, &m, &mut data, ci),
            Bucket::None => {
                if !pgit::has_workflows(cx, &cx.checkout(&m)) {
                    ci["result"] = json!("none");
                    data.set("ci", ci);
                    return Ok(Progress::Done(Outcome::ok().with("data", data.text())));
                }
                if waited {
                    data.set("ci", ci);
                    let why = format!("no checks {mins} min after the push");
                    let note = format!(
                        "No CI checks appeared: {why}, though the repo has .github/workflows. Make them run on PRs, then remove `waiting`."
                    );
                    return self.give_up(cx, &m, &data, Waiting::NoCiChecks, &why, &note);
                }
                poll(cx, &m, &mut data, ci)
            }
            Bucket::Green => {
                ci["result"] = json!(if reruns.is_empty() { "green" } else { "flaky" });
                data.set("ci", ci);
                Ok(Progress::Done(Outcome::ok().with("data", data.text())))
            }
            Bucket::Red(bad) | Bucket::Cancel(bad) => {
                let cancel = bad.iter().all(cancelled);
                let again: BTreeSet<u64> = bad
                    .iter()
                    .filter_map(|c| c.run)
                    .filter(|r| !reruns.contains(r))
                    .collect();
                if self.seq != Seq::Rehearsal && !again.is_empty() {
                    let mut all_reruns: Vec<u64> = reruns.iter().copied().collect();
                    let mut m = m;
                    for run in again {
                        all_reruns.push(run);
                        ci["reruns"] = json!(all_reruns);
                        if cancel {
                            ci["cancels"] = json!(ci["cancels"].as_u64().unwrap_or(0) + 1);
                        }
                        data.set("ci", ci.clone());
                        m = cx.record(
                            &m,
                            &format!("rerun:{run}"),
                            &[("data", data.text().into())],
                        )?;
                        self.rerun(cx, &m, run, false)?;
                    }
                    let _ = cx.record(&m, "poll", &[])?;
                    return Ok(Progress::Poll {
                        after: cx.config.agent.ci_poll,
                    });
                }
                ci["red"] = json!(
                    bad.iter()
                        .map(|c| json!({"name": c.name, "run": c.run, "url": c.url,
                                         "conclusion": c.conclusion}))
                        .collect::<Vec<_>>()
                );
                data.set("ci", ci);
                let m = cx.record(&m, "log", &[("data", data.text().into())])?;
                self.red(cx, &m)
            }
        }
    }

    /// `gh run rerun <run> --failed` once; a re-entry first asks whether it ran
    /// (`run_attempt` > 1, LOOP-6).
    fn rerun(&self, cx: &Ctx<'_>, m: &Mission, run: u64, reentry: bool) -> Result<(), StepError> {
        let github = gh::github(cx, m)?;
        let id = run.to_string();
        if reentry {
            let path = format!("repos/{github}/actions/runs/{run}");
            if let Ok(out) = gh::try_gh(cx, m, &["api", &path, "--jq", ".run_attempt"])?
                && out.trim().parse::<u64>().is_ok_and(|a| a > 1)
            {
                return Ok(());
            }
        }
        if let Err(e) = gh::try_gh(cx, m, &["run", "rerun", &id, "--failed", "-R", &github])? {
            eprintln!(
                "towercab: {}: gh run rerun {run}: {}",
                m.label(),
                crate::outbox::one_line(&e)
            );
        }
        Ok(())
    }

    /// Red after the rerun (PIP-3): the failed logs (`gh run view <run> --log-failed`, last
    /// 16k) in `ci-<n>.log`, then a CI repair (`ci_repairs` + 1), or `CI red` after 3.
    fn red(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        let red: Vec<Value> = data
            .get("ci")
            .and_then(|c| c.get("red"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let names: Vec<String> = red
            .iter()
            .map(|c| s(c, "name"))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let names = names.join(", ");
        let what = format!("CI red: {names}");
        if self.seq != Seq::Intent {
            let mut ci = data.get("ci").cloned().unwrap_or(json!({}));
            ci["result"] = json!("red");
            data.set("ci", ci);
            return self.give_up(cx, m, &data, Waiting::CiRed, &what, "");
        }
        let github = gh::github(cx, m)?;
        let n = data.next_n("ci");
        let log = cx.runs(m).join(format!("ci-{n}.log"));
        let mut text = String::new();
        let mut seen = BTreeSet::new();
        for c in &red {
            match c.get("run").and_then(Value::as_u64) {
                Some(run) if seen.insert(run) => {
                    let id = run.to_string();
                    let out = match gh::try_gh(
                        cx,
                        m,
                        &["run", "view", &id, "--log-failed", "-R", &github],
                    )? {
                        Ok(o) => o,
                        Err(e) => format!("(no log: {})", crate::outbox::one_line(&e)),
                    };
                    text.push_str(&format!("== run {run} ({}) ==\n{out}\n", s(c, "name")));
                }
                Some(_) => {}
                None => text.push_str(&format!(
                    "== {}: {} {} ==\n",
                    s(c, "name"),
                    s(c, "conclusion"),
                    s(c, "url")
                )),
            }
        }
        // The last 16k: the end of a failed log is where it failed.
        let cut = text.len().saturating_sub(TAIL);
        let cut = (cut..=text.len())
            .find(|i| text.is_char_boundary(*i))
            .unwrap_or(0);
        std::fs::create_dir_all(cx.runs(m))
            .and_then(|()| std::fs::write(&log, &text.as_bytes()[cut..]))
            .map_err(|e| StepError::Bug(format!("{}: {e}", log.display())))?;
        let findings = tail(&log, TAIL);
        let mut ci = data.get("ci").cloned().unwrap_or(json!({}));
        ci["result"] = json!("red");
        data.set("ci", ci);
        if m.ci_repairs >= 3 {
            let note = format!(
                "{what} after 3 CI repairs. The failed log: {}. Fix it on the branch or say how in intent.md, then remove `waiting`.",
                log.display()
            );
            return self.give_up(cx, m, &data, Waiting::CiRed, &what, &note);
        }
        let log = std::path::absolute(&log).unwrap_or(log);
        data.set(
            "repair",
            json!({"what": what, "findings": findings, "log": log.to_string_lossy()}),
        );
        Ok(Progress::Done(
            Outcome::red(what)
                .with("ci_repairs", i64::from(m.ci_repairs) + 1)
                .with("data", data.text()),
        ))
    }
}

impl Handler for Ci {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if let Some(run) = m.step.strip_prefix("rerun:") {
            let run: u64 = run
                .parse()
                .map_err(|_| StepError::Bug(format!("ci: bad step {}", m.step)))?;
            self.rerun(cx, m, run, true)?;
            cx.record(m, "poll", &[])?;
            return Ok(Progress::Poll {
                after: cx.config.agent.ci_poll,
            });
        }
        if m.step == "log" {
            return self.red(cx, m);
        }
        self.poll(cx, m)
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!("{}: ci runs no child", m.label())))
    }
}
