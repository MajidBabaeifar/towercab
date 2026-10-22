//! Stage handlers (LOOP-3, loop.md **Handlers**): a stage's work. They return an [`Outcome`];
//! only `machine::apply` moves a mission. The pipeline intent implements one per stage; this
//! intent builds `pick::Pick` and the stubs.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::time::Duration;

use rusqlite::types::Value;

use crate::config::{Config, RepoConfig};
use crate::db::{Db, sql};
use crate::env::Fault;
use crate::exes::Exes;
use crate::github::Identity;
use crate::home::Home;
use crate::intents::Store;
use crate::limits::Limit;
use crate::machine::{Event, Stage, Waiting};
use crate::mission::{self, COLUMNS, Mission};
use crate::runloop::Tick;

pub trait Handler {
    /// Do or redo the step of `m.stage` from `m.step` (LOOP-6): `cx.record` before each side
    /// effect; on re-entry check what the recorded step already did. Never blocks beyond one
    /// git/gh call.
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError>;
    /// The child `step` spawned has ended.
    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError>;
    /// False only for [`NotBuilt`]: picks stay off while any stage has it (LOOP-5).
    fn built(&self) -> bool {
        true
    }
}

/// What a handler call leads to.
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    /// The stage's step is over: `machine::apply` this.
    Done(Outcome),
    /// Run this child; `finish` gets its end.
    Spawn(ChildSpec),
    /// Call `step` again after `after` (CI, deploy).
    Poll { after: Duration },
}

/// A handler that couldn't do its step.
#[derive(Debug, Clone, PartialEq)]
pub enum StepError {
    /// Network, auth or a tool → `env_fail` (LOOP-10).
    Env(Fault, String),
    /// A bug → `Unexpected` (counted like a crash).
    Bug(String),
}

impl From<String> for StepError {
    /// A database or file error: a bug.
    fn from(e: String) -> StepError {
        StepError::Bug(e)
    }
}

/// A step's result.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub event: Event,
    pub waiting: Option<Waiting>,
    pub why: Option<String>,
    pub limit: Option<Limit>,
    pub fault: Option<(Fault, String)>,
    /// `missions` columns set by the transition.
    pub set: Vec<(&'static str, Value)>,
}

impl Outcome {
    pub fn event(event: Event) -> Outcome {
        Outcome {
            event,
            waiting: None,
            why: None,
            limit: None,
            fault: None,
            set: Vec::new(),
        }
    }

    pub fn ok() -> Outcome {
        Outcome::event(Event::Ok)
    }

    pub fn red(why: impl Into<String>) -> Outcome {
        Outcome {
            why: Some(why.into()),
            ..Outcome::event(Event::Red)
        }
    }

    /// `blocked` with its `waiting:`; an empty `why` is none.
    pub fn wait(waiting: Waiting, why: impl Into<String>) -> Outcome {
        let why: String = why.into();
        Outcome {
            waiting: Some(waiting),
            why: (!why.is_empty()).then_some(why),
            ..Outcome::event(Event::Blocked)
        }
    }

    pub fn limit(limit: Limit) -> Outcome {
        Outcome {
            why: Some(limit.text.clone()),
            limit: Some(limit),
            ..Outcome::event(Event::Limit)
        }
    }

    pub fn env(fault: Fault, why: impl Into<String>) -> Outcome {
        let why: String = why.into();
        Outcome {
            why: Some(why.clone()),
            fault: Some((fault, why)),
            ..Outcome::event(Event::EnvFail)
        }
    }

    pub fn timeout() -> Outcome {
        Outcome::event(Event::Timeout)
    }

    pub fn bad_result(why: impl Into<String>) -> Outcome {
        Outcome {
            why: Some(why.into()),
            ..Outcome::event(Event::BadResult)
        }
    }

    /// Also sets `missions.<col>`.
    pub fn with(mut self, col: &'static str, v: impl Into<Value>) -> Outcome {
        self.set.push((col, v.into()));
        self
    }
}

/// What a child is (`missions.child_kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildKind {
    Claude,
    Setup,
    Checks,
    E2e,
    /// A verifier's app (PIP-32).
    App,
    /// A repo command (rollback, rehearse).
    Command,
}

impl ChildKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChildKind::Claude => "claude",
            ChildKind::Setup => "setup",
            ChildKind::Checks => "checks",
            ChildKind::E2e => "e2e",
            ChildKind::App => "app",
            ChildKind::Command => "command",
        }
    }
}

/// A child to run (`child::spawn`).
#[derive(Debug, Clone, PartialEq)]
pub struct ChildSpec {
    pub kind: ChildKind,
    pub argv: Vec<OsString>,
    pub cwd: PathBuf,
    /// The whole environment (it is cleared first).
    pub env: Vec<(OsString, OsString)>,
    /// `None` → `/dev/null`.
    pub stdin: Option<PathBuf>,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
    pub timeout: Option<Duration>,
    /// Counts toward `[agent].parallel` (LOOP-4).
    pub slot: bool,
    /// The `--model` of a Claude run.
    pub model: Option<String>,
}

/// How a child ended.
#[derive(Debug, Clone, PartialEq)]
pub struct ChildEnd {
    /// `None`: unknown (killed, or lost).
    pub status: Option<ExitStatus>,
    pub timed_out: bool,
    /// Its run time (monotonic).
    pub run: Duration,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
}

/// Crash injection for tests (LOOP-6's `test_crash_at_every_step`): the loop calls
/// [`Probe::point`] after each durable write (a `record`, a transition, an entry effect, a
/// pick); the k-th panics with [`Crashed`], which the loop never catches.
#[derive(Debug, Default)]
pub struct Probe {
    after: Cell<Option<u64>>,
    count: Cell<u64>,
}

/// The panic payload of an injected crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crashed;

impl Probe {
    /// Crash at the k-th point from now (`None`: never).
    pub fn crash_after(&self, k: Option<u64>) {
        self.count.set(0);
        self.after.set(k);
    }

    /// Points passed since `crash_after`.
    pub fn count(&self) -> u64 {
        self.count.get()
    }

    /// A durable write is done.
    pub fn point(&self) {
        let n = self.count.get() + 1;
        self.count.set(n);
        if self.after.get() == Some(n) {
            std::panic::panic_any(Crashed);
        }
    }
}

/// The session argument of a worker run (LOOP-7, PIP-13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Session {
    /// `--session-id <uuid>`: the session's first run.
    New(String),
    /// `--resume <uuid>`.
    Resume(String),
}

impl Session {
    pub fn args(&self) -> [&str; 2] {
        match self {
            Session::New(u) => ["--session-id", u],
            Session::Resume(u) => ["--resume", u],
        }
    }
}

/// What a handler call can use.
pub struct Ctx<'a> {
    pub config: &'a Config,
    pub home: &'a Home,
    pub db: &'a Db,
    pub store: &'a Store,
    pub exes: &'a Exes,
    pub identity: &'a mut Identity,
    pub tick: Tick,
    /// False until every wait has polled once after a wake (LOOP-11): no wait timeout fires.
    pub timeouts: bool,
    pub probe: &'a Probe,
}

impl Ctx<'_> {
    /// One transaction storing `step` and `set` (ids the step will use) before a side effect
    /// (LOOP-6). A new step resets `unclean`, `retries` and `step_secs` (its children's run
    /// time, which its timeouts count). Returns the mission as stored.
    pub fn record(
        &self,
        m: &Mission,
        step: &str,
        set: &[(&str, Value)],
    ) -> Result<Mission, String> {
        let out = self.db.tx(|tx| {
            let mut cols: Vec<(String, Value)> = vec![
                ("step".into(), Value::Text(step.into())),
                ("updated".into(), Value::Real(self.tick.unix())),
            ];
            if step != m.step {
                cols.push(("unclean".into(), Value::Integer(0)));
                cols.push(("retries".into(), Value::Integer(0)));
                cols.push(("retry_at".into(), Value::Null));
                cols.push(("step_secs".into(), Value::Real(0.0)));
            }
            cols.extend(set.iter().map(|(k, v)| (k.to_string(), v.clone())));
            update(tx, m.id, &cols)?;
            mission::get(tx, m.id)
        })?;
        self.probe.point();
        Ok(out)
    }

    /// Before a worker run in `step`: records it with `session_used = 1` and returns the
    /// session flag: `--session-id` for the session's first run, `--resume` for every later
    /// one, never `--session-id` twice (LOOP-7). A step re-entered after a cut-off
    /// (`m.step == step`) resumes; its prompt is `claude::CONTINUE`.
    pub fn session(&self, m: &Mission, step: &str) -> Result<(Mission, Session), String> {
        let flag = if m.session_used {
            Session::Resume(m.session.clone())
        } else {
            Session::New(m.session.clone())
        };
        let m = self.record(m, step, &[("session_used", Value::Integer(1))])?;
        Ok((m, flag))
    }

    /// The session is gone (`claude::session_gone`): a new uuid, unused, step cleared, so the
    /// next run gets `--session-id` and a prompt with the context (`claude::fresh_context`).
    pub fn new_session(&self, m: &Mission) -> Result<Mission, String> {
        let uuid = uuid::Uuid::new_v4().to_string();
        self.record(
            m,
            "",
            &[
                ("session", Value::Text(uuid)),
                ("session_used", Value::Integer(0)),
            ],
        )
    }

    /// The mission's checkout (absolute).
    pub fn checkout(&self, m: &Mission) -> PathBuf {
        self.home.root.join(&m.checkout)
    }

    /// Its run files: `runs/<intent id>` (a rehearsal: `runs/<checkout name>`).
    pub fn runs(&self, m: &Mission) -> PathBuf {
        self.home.runs(&m.label())
    }

    /// Its `[repos.<r>]`.
    pub fn repo(&self, m: &Mission) -> Result<&RepoConfig, String> {
        self.config.repo(&m.repo)
    }
}

/// `UPDATE missions SET <cols> WHERE id`; only [`COLUMNS`].
pub fn update(
    conn: &rusqlite::Connection,
    id: i64,
    cols: &[(String, Value)],
) -> Result<(), String> {
    if cols.is_empty() {
        return Ok(());
    }
    for (c, _) in cols {
        if !COLUMNS.contains(&c.as_str()) {
            return Err(format!("missions has no column {c}"));
        }
    }
    let set: Vec<String> = cols
        .iter()
        .enumerate()
        .map(|(i, (c, _))| format!("{c} = ?{}", i + 1))
        .collect();
    let sql_text = format!(
        "UPDATE missions SET {} WHERE id = ?{}",
        set.join(", "),
        cols.len() + 1
    );
    let mut values: Vec<Value> = cols.iter().map(|(_, v)| v.clone()).collect();
    values.push(Value::Integer(id));
    conn.execute(&sql_text, rusqlite::params_from_iter(values))
        .map(drop)
        .map_err(sql)
}

/// A stage without its handler yet: picks stay off (LOOP-5).
pub struct NotBuilt;

impl Handler for NotBuilt {
    fn step(&mut self, _: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!("{} handler not built", m.stage)))
    }
    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        _: ChildEnd,
    ) -> Result<Progress, StepError> {
        self.step(cx, m)
    }
    fn built(&self) -> bool {
        false
    }
}

/// A stub (tests): records step `stub`, then `ok`.
pub struct Stub;

impl Handler for Stub {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if m.step != "stub" {
            cx.record(m, "stub", &[])?;
        }
        Ok(Progress::Done(Outcome::ok()))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Ok(Progress::Done(Outcome::ok()))
    }
}

/// The handlers the loop runs, one per driven stage.
pub struct Handlers {
    map: BTreeMap<Stage, Box<dyn Handler>>,
}

impl fmt::Debug for Handlers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Handlers")
            .field("stages", &self.map.keys().collect::<Vec<_>>())
            .field("built", &self.built())
            .finish()
    }
}

impl Handlers {
    fn every(h: impl Fn() -> Box<dyn Handler>) -> Handlers {
        Handlers {
            map: Stage::ALL
                .into_iter()
                .filter(|s| s.driven())
                .map(|s| (s, h()))
                .collect(),
        }
    }

    /// Every driven stage → [`Stub`] (tests).
    pub fn stubs() -> Handlers {
        Handlers::every(|| Box::new(Stub))
    }

    /// What `run` uses: `pick::Pick`, every other stage [`NotBuilt`]: picks stay off until the
    /// pipeline exists.
    pub fn production() -> Handlers {
        let mut h = Handlers::every(|| Box::new(NotBuilt));
        h.set(Stage::Pick, Box::new(crate::pick::Pick));
        h
    }

    /// Replaces a stage's handler.
    pub fn set(&mut self, stage: Stage, h: Box<dyn Handler>) -> &mut Handlers {
        self.map.insert(stage, h);
        self
    }

    /// Every driven stage has a built handler: picks may run (LOOP-5).
    pub fn built(&self) -> bool {
        self.map.values().all(|h| h.built())
    }

    pub fn get_mut(&mut self, stage: Stage) -> Option<&mut Box<dyn Handler>> {
        self.map.get_mut(&stage)
    }
}
