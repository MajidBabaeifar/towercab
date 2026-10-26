//! The pipeline's Claude runs (pipeline.md **Code**, `runs.rs`): [`start`] assembles the policy
//! plugin, writes the run's files and records its step and number; [`finish`] adds its cost and
//! time and maps how it ended. Design, plan and worker runs get one result-only continue
//! (`prompts/result.md`) before `worker timeout` / `no result` / `worker budget` (PIP-1).

use std::path::PathBuf;

use rusqlite::params;
use serde_json::{Value, json};

use crate::claude::{self, ClaudeResult, Run, RunEnd, RunKind, SessionArg, VerifierNet};
use crate::db::sql;
use crate::env::Fault;
use crate::handler::{ChildEnd, Ctx, Outcome, Progress, StepError};
use crate::indicators;
use crate::machine::Waiting;
use crate::metrics::Ev;
use crate::mission::Mission;

use super::data::Data;
use super::{files, guard, policies, prompts, schemas};

/// The writer's model (PIP-14).
pub const WRITER_MODEL: &str = "haiku";

/// A Claude run to start.
#[derive(Debug, Clone)]
pub struct Start {
    pub kind: RunKind,
    /// The step it is recorded with (`design:run`, …).
    pub step: String,
    pub prompt: String,
    pub schema: Option<Value>,
    /// Its session; on a re-entry at `step` a `New` becomes `Resume` and the prompt
    /// `claude::CONTINUE`.
    pub session: SessionArg,
    pub model: String,
    /// `Run.eval` (PIP-33).
    pub eval: bool,
    /// Extras; a worker run's are set by [`start`] itself (the base's setup and checks
    /// commands, the guard and its `denyWrite`).
    pub setup_checks: Vec<String>,
    pub deny_write: Vec<PathBuf>,
    pub guard: bool,
    pub verifier: Option<VerifierNet>,
    /// `missions.feedback_seen`, recorded with the run's step: my comments its prompt carries
    /// count as seen only once the run is on its way (PIP-21).
    pub feedback_seen: Option<String>,
    /// The recorded run again ([`restart`]): its number kept, a `New` session too (a run that
    /// never started); otherwise a `New` session is always a new run.
    pub again: bool,
}

impl Start {
    /// A run of `kind` at `step` on `model`, no session, no schema.
    pub fn new(kind: RunKind, step: &str, model: &str, prompt: impl Into<String>) -> Start {
        Start {
            kind,
            step: step.to_string(),
            prompt: prompt.into(),
            schema: None,
            session: SessionArg::None,
            model: model.to_string(),
            eval: false,
            setup_checks: Vec::new(),
            deny_write: Vec::new(),
            guard: false,
            verifier: None,
            feedback_seen: None,
            again: false,
        }
    }
}

/// A design, plan or worker run: in the worker session (PIP-13).
pub fn worker_kind(kind: RunKind) -> bool {
    matches!(kind, RunKind::Design | RunKind::Plan | RunKind::Worker)
}

/// The worker session's flag for its next run: `--session-id` until a run used it (LOOP-7).
pub fn worker_session(m: &Mission) -> SessionArg {
    if m.session_used {
        SessionArg::Resume(m.session.clone())
    } else {
        SessionArg::New(m.session.clone())
    }
}

/// The schema of a run kind's result.
pub fn schema_of(kind: RunKind) -> Option<Value> {
    Some(match kind {
        RunKind::Design => schemas::DESIGN.clone(),
        RunKind::Plan => schemas::PLAN.clone(),
        RunKind::Worker => schemas::WORKER.clone(),
        RunKind::Review => schemas::REVIEW.clone(),
        RunKind::Triage => schemas::TRIAGE.clone(),
        RunKind::Verifier => schemas::VERIFIER.clone(),
        RunKind::Writer => schemas::WRITER.clone(),
        RunKind::Drafter | RunKind::Diagnose => return None,
    })
}

fn kind_of(s: &str) -> Option<RunKind> {
    RunKind::ALL.into_iter().find(|k| k.as_str() == s)
}

/// Records the run's step (its number `n.<kind>` and `data.run` with it), assembles the policy
/// plugin (PIP-27), writes the run's files with the base `CLAUDE.md` (PIP-24) → `Spawn`. A
/// re-entry at `st.step` ([`restart`]) keeps the number; a new one is one no earlier attempt's
/// run used, so its output files exist only once its child started.
pub fn start(cx: &Ctx<'_>, m: &Mission, st: Start) -> Result<Progress, StepError> {
    let reentry = !st.step.is_empty()
        && m.step == st.step
        && (st.again || !matches!(st.session, SessionArg::New(_)));
    let mut data = Data::of(m);
    let keep = reentry && data.n(st.kind.as_str()) > 0;
    let n = if keep {
        data.n(st.kind.as_str())
    } else {
        // A number no earlier attempt's run used (`runs/<id>/` is the intent's): its files
        // exist only once its child started (`restart`).
        let runs = cx.runs(m);
        let used = |n: u32| {
            ["prompt", "json", "err"]
                .iter()
                .any(|x| runs.join(format!("{}-{n}.{x}", st.kind.as_str())).exists())
        };
        let mut n = data.next_n(st.kind.as_str());
        while used(n) {
            n = data.next_n(st.kind.as_str());
        }
        n
    };
    let session = st.session.clone();
    let prompt = st.prompt.clone();
    let repo = match files(cx, m) {
        Ok(f) => f,
        Err(o) => return Ok(Progress::Done(o)),
    };
    let policies = if st.kind.policies() {
        policies::assemble(cx, m)?
    } else {
        "none".to_string()
    };
    let new = match &session {
        SessionArg::New(_) => "new",
        SessionArg::Resume(_) => "resume",
        SessionArg::None => "none",
    };
    data.set(
        "run",
        json!({"kind": st.kind.as_str(), "model": st.model, "step": st.step, "n": n,
               "policies": policies, "eval": st.eval, "session": new}),
    );
    let mut set: Vec<(&str, rusqlite::types::Value)> = vec![("data", data.text().into())];
    if worker_kind(st.kind) && matches!(session, SessionArg::New(_)) {
        set.push(("session_used", 1.into()));
    }
    if let Some(seen) = &st.feedback_seen {
        set.push(("feedback_seen", seen.clone().into()));
    }
    let m = cx.record(m, &st.step, &set)?;
    let mut run = Run::new(
        st.kind,
        &st.model,
        &cx.checkout(&m),
        &cx.runs(&m),
        n,
        prompt,
        cx.config,
    );
    run.schema = st.schema;
    run.session = session;
    run.eval = st.eval;
    run.setup_checks = st.setup_checks;
    run.deny_write = st.deny_write;
    run.guard = st.guard;
    run.verifier = st.verifier;
    if st.kind == RunKind::Worker {
        // Every worker run, a continue or a new session too: the guard and its rules for the
        // round (PIP-29, PIP-31), the base's commands allowed.
        let round = super::round(cx.db.conn(), &m)?;
        run.deny_write = guard::write_rules(cx, &m, &repo, round)?;
        run.guard = true;
        run.setup_checks = repo
            .verifying
            .setup
            .iter()
            .chain(&repo.verifying.checks)
            .cloned()
            .collect();
        run.bash = cx.repo(&m).map_err(StepError::Bug)?.bash.clone();
        if m.intent.is_some() {
            run.network = super::intent(cx, &m)?.network().to_vec();
        }
        let cache = super::sandbox::cache_dir(cx, &m)?.join("worker");
        std::fs::create_dir_all(&cache)
            .map_err(|e| StepError::Bug(format!("{}: {e}", cache.display())))?;
        run.cache = Some(std::path::absolute(&cache).unwrap_or(cache));
    }
    let f = run.files();
    let asked = asked_of(&f.prompt);
    // A continue keeps what the run was asked (a new session needs it, LOOP-7).
    if run.prompt == claude::CONTINUE && !asked.exists() && f.prompt.is_file() {
        std::fs::copy(&f.prompt, &asked)
            .map_err(|e| StepError::Bug(format!("{}: {e}", asked.display())))?;
    }
    let spec =
        claude::prepare(&run, &repo.claude_md, cx.config, cx.exes).map_err(StepError::Bug)?;
    Ok(Progress::Spawn(spec))
}

/// `<kind>-<n>.asked`: the prompt of a run continued with `claude::CONTINUE`.
fn asked_of(prompt: &std::path::Path) -> PathBuf {
    prompt.with_extension("asked")
}

/// The run recorded in `data.run`: (kind, model, step, eval).
fn recorded(m: &Mission) -> Result<(RunKind, String, String, bool), StepError> {
    let data = Data::of(m);
    let run = data
        .get("run")
        .ok_or_else(|| StepError::Bug(format!("{}: no run recorded", m.label())))?;
    let kind = run
        .get("kind")
        .and_then(Value::as_str)
        .and_then(kind_of)
        .ok_or_else(|| StepError::Bug("data.run: no kind".into()))?;
    let s = |k: &str| {
        run.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let eval = run.get("eval").and_then(Value::as_bool).unwrap_or(false);
    Ok((kind, s("model"), s("step"), eval))
}

/// The recorded run again at `m.step` (re-entered after a cut-off, a limit wait or a backoff):
/// the same number and session, `claude::CONTINUE` (the writer: its prompt again). A run that
/// never started (queued for a slot at a shutdown or crash: no output files) gets its own
/// prompt with its own session flag (`--session-id` for a session's first run).
pub fn restart(cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
    let (kind, model, _, eval) = recorded(m)?;
    let data = Data::of(m);
    let n = data.n(kind.as_str());
    let base = cx.runs(m).join(format!("{}-{n}", kind.as_str()));
    let started = base.with_extension("json").exists() || base.with_extension("err").exists();
    let first = !started
        && data
            .get("run")
            .and_then(|r| r.get("session"))
            .and_then(Value::as_str)
            == Some("new");
    let run_session = m.run_session.clone().unwrap_or_default();
    let session = match (worker_kind(kind), kind.toolless(), first) {
        (true, _, true) => SessionArg::New(m.session.clone()),
        (true, _, false) => SessionArg::Resume(m.session.clone()),
        (false, true, _) => SessionArg::None,
        (false, false, true) => SessionArg::New(run_session),
        (false, false, false) => SessionArg::Resume(run_session),
    };
    let prompt = if !started || matches!(session, SessionArg::None) {
        prompt_file(cx, m, kind, n)
    } else {
        claude::CONTINUE.to_string()
    };
    let mut st = Start::new(kind, &m.step, &model, prompt);
    st.schema = schema_of(kind);
    st.session = session;
    st.eval = eval;
    st.again = true;
    start(cx, m, st)
}

/// What run `n` of `kind` was asked (its `.asked` file after a continue, else its `.prompt`;
/// gone: empty).
fn prompt_file(cx: &Ctx<'_>, m: &Mission, kind: RunKind, n: u32) -> String {
    let prompt = cx.runs(m).join(format!("{}-{n}.prompt", kind.as_str()));
    std::fs::read_to_string(asked_of(&prompt))
        .or_else(|_| std::fs::read_to_string(&prompt))
        .unwrap_or_default()
}

/// How a run ended, for its handler.
#[derive(Debug, Clone, PartialEq)]
pub enum Ended {
    /// A result (its `structured_output` still to be checked by the handler).
    Ok(ClaudeResult),
    /// What the stage does now (a limit, an outage, a new session, the continue, a wait).
    Out(Progress),
    /// Review, verifier, triage, writer: no usable result, why (not approved, a mismatch, no
    /// revert, the template).
    Failed(String),
}

/// Why a design, plan or worker run gave no usable result.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    Timeout,
    Budget,
    NoResult(String),
}

/// The `total_cost_usd` of the last `type: result` line of `stdout` (none: 0).
fn cost(stdout: &str) -> f64 {
    stdout
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .chain(serde_json::from_str::<Value>(stdout.trim()).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("result"))
        .and_then(|v| v.get("total_cost_usd").and_then(Value::as_f64))
        .unwrap_or(0.0)
}

/// A denial's one line: `<tool> <input>`.
fn denial(r: &ClaudeResult) -> String {
    let d = r
        .permission_denials
        .iter()
        .find(|d| claude::is_fatal_denial(d, &claude::home().unwrap_or_default()))
        .or(r.permission_denials.first());
    match d {
        Some(d) => {
            let tool = d.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
            let input = d
                .get("tool_input")
                .map(Value::to_string)
                .unwrap_or_default();
            crate::outbox::cut(&crate::outbox::one_line(&format!("{tool} {input}")), 200)
        }
        None => "a push or a secret read".into(),
    }
}

/// The run of `m`'s recorded step ended: its cost and time added (`cost_usd`, `agent_secs`),
/// then (pipeline.md **Code**, `runs.rs`): a limit → `Outcome::limit`; an outage →
/// `Outcome::env(claude)`; session gone → a new session (worker kinds: a `New` run with
/// `claude::fresh_context`; others a new `run_session`); a fatal denial → `no result`
/// (worker kinds); no usable result → the one continue (worker kinds); others `Failed`. The
/// writer never waits: anything but a result is `Failed`.
pub fn finish(cx: &Ctx<'_>, m: &Mission, end: &ChildEnd) -> Result<Ended, StepError> {
    let (kind, model, step, eval) = recorded(m)?;
    let read = |p: &std::path::Path| {
        String::from_utf8_lossy(&std::fs::read(p).unwrap_or_default()).into_owned()
    };
    let (stdout, stderr) = (read(&end.stdout), read(&end.stderr));
    // Cost and tokens per model, however it ended (MET-16); the guard's blocks (MET-26).
    let ev = Ev::of(m);
    if let Ok(r) = claude::result_of(&stdout) {
        let agent = if eval { "eval" } else { kind.agent() };
        indicators::run_usage(&m.repo, agent, m.stage.as_str(), &r, &ev);
    }
    if kind == RunKind::Worker
        && let Err(e) = indicators::guard_blocks(&cx.runs(m), &m.repo, &ev)
    {
        crate::tlog!("towercab: {}: metrics: {e}", m.label());
    }
    cx.db
        .conn()
        .execute(
            "UPDATE missions SET cost_usd = cost_usd + ?1, agent_secs = agent_secs + ?2 WHERE id = ?3",
            params![cost(&stdout), end.run.as_secs_f64(), m.id],
        )
        .map_err(sql)?;
    let ended = claude::parse(&model, &stdout, &stderr, end.status, cx.tick.wall);
    let ended = match ended {
        RunEnd::Limit(_) | RunEnd::Env(_) | RunEnd::SessionGone => ended,
        _ if end.timed_out => {
            return failure(cx, m, kind, Failure::Timeout);
        }
        e => e,
    };
    let toolless = kind == RunKind::Writer;
    match ended {
        RunEnd::Ok(r) => Ok(Ended::Ok(r)),
        RunEnd::Limit(l) if !toolless => Ok(Ended::Out(Progress::Done(Outcome::limit(l)))),
        RunEnd::Env(e) if !toolless => {
            Ok(Ended::Out(Progress::Done(Outcome::env(Fault::Claude, e))))
        }
        RunEnd::SessionGone if !toolless => {
            new_session(cx, m, kind, &model, &step, eval).map(Ended::Out)
        }
        RunEnd::Denied(r) if worker_kind(kind) => Ok(Ended::Out(Progress::Done(Outcome::wait(
            Waiting::NoResult,
            format!("denied: {}", denial(&r)),
        )))),
        RunEnd::Denied(r) => Ok(Ended::Failed(format!("denied: {}", denial(&r)))),
        RunEnd::Budget(_) => failure(cx, m, kind, Failure::Budget),
        e @ (RunEnd::NoResult(_) | RunEnd::Failed(_)) => {
            failure(cx, m, kind, Failure::NoResult(e.to_string()))
        }
        other => Ok(Ended::Failed(other.to_string())),
    }
}

/// A run with no usable result: design, plan, worker → [`retry_result`]; others `Failed`.
fn failure(cx: &Ctx<'_>, m: &Mission, kind: RunKind, f: Failure) -> Result<Ended, StepError> {
    if !worker_kind(kind) {
        return Ok(Ended::Failed(match f {
            Failure::Timeout => "timed out".into(),
            Failure::Budget => "budget used up".into(),
            Failure::NoResult(why) => why,
        }));
    }
    retry_result(cx, m, f).map(Ended::Out)
}

/// PIP-1's one continue: the first failure of a step → a `Resume` run at `<step>:result` asking
/// only for the result (`prompts/result.md`, `data.cont` = the step); the continue's own
/// failure → `worker timeout` / `worker budget` / `no result`. Also for a result whose
/// `structured_output` the handler's parser refuses (`Failure::NoResult`).
pub fn retry_result(cx: &Ctx<'_>, m: &Mission, f: Failure) -> Result<Progress, StepError> {
    if m.step.ends_with(":result") {
        let (w, why) = match f {
            Failure::Timeout => (
                Waiting::WorkerTimeout,
                "timed out after the result continue".into(),
            ),
            Failure::Budget => (
                Waiting::WorkerBudget,
                "budget used up after the result continue".into(),
            ),
            Failure::NoResult(why) => (Waiting::NoResult, why),
        };
        return Ok(Progress::Done(Outcome::wait(w, why)));
    }
    let (kind, model, _, eval) = recorded(m)?;
    let mut data = Data::of(m);
    data.set("cont", m.step.clone());
    let m = cx.record(m, &m.step, &[("data", data.text().into())])?;
    let mut st = Start::new(
        kind,
        &format!("{}:result", m.step),
        &model,
        prompts::render("result", &[]).map_err(StepError::Bug)?,
    );
    st.schema = schema_of(kind);
    st.session = SessionArg::Resume(m.session.clone());
    st.eval = eval;
    start(cx, &m, st)
}

/// The session is gone (LOOP-7): a worker kind gets a new uuid and a `New` run with
/// `claude::fresh_context` and the step's prompt; others a new `run_session`.
fn new_session(
    cx: &Ctx<'_>,
    m: &Mission,
    kind: RunKind,
    model: &str,
    step: &str,
    eval: bool,
) -> Result<Progress, StepError> {
    let data = Data::of(m);
    let asked = prompt_file(cx, m, kind, data.n(kind.as_str()));
    let asked = if asked.trim() == claude::CONTINUE {
        String::new()
    } else {
        asked
    };
    let (m, session, prompt) = if worker_kind(kind) {
        let m = cx.new_session(m)?;
        let spec_ids: Vec<String> = data
            .get("design")
            .and_then(|d| d.get("spec_ids"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let intent = m
            .intent
            .as_deref()
            .and_then(|id| cx.store.scan().open.into_iter().find(|i| i.id == id))
            .map(|i| format!("{}/intent.md in the intents repo", i.dir))
            .unwrap_or_else(|| "intent.md".into());
        let context = claude::fresh_context(
            m.branch.as_deref().unwrap_or_default(),
            m.pr_url.as_deref(),
            &intent,
            &spec_ids,
            data.str("plan_url").unwrap_or("none yet"),
        );
        let s = SessionArg::New(m.session.clone());
        (m, s, format!("{context}\n\n{asked}"))
    } else {
        let m = cx.record(m, "", &[("run_session", rusqlite::types::Value::Null)])?;
        let (m, s) = cx.run_session(&m, step)?;
        (m, s.into(), asked)
    };
    let mut st = Start::new(kind, step, model, prompt.trim().to_string());
    st.schema = schema_of(kind);
    st.session = session;
    st.eval = eval;
    start(cx, &m, st)
}
