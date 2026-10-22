//! The pipeline (specs/pipeline.md): one handler per stage from design to release, built in
//! parts (pipeline.md **Code**). Handlers return an `Outcome`; only `machine::apply` moves a
//! mission. State the stages keep lives in `missions.data` ([`data::Data`]).

pub mod data;
pub mod design;
pub mod gh;
pub mod git;
pub mod policies;
pub mod prompts;
pub mod publish;
pub mod runs;
pub mod schemas;

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};

use crate::env::Fault;
use crate::handler::{Ctx, Handlers, Outcome, Progress, StepError};
use crate::intents::{Intent, StoreError};
use crate::machine::{Event, Stage, Waiting};
use crate::mission::Mission;
use crate::outbox::Subject;
use crate::repo::{self, RepoError, RepoFiles};

/// Eval cases by intent id → the base sha its checkout starts at (PIP-33).
pub type EvalCases = BTreeMap<String, String>;

/// How the handlers run: for real, or an eval's replay that never publishes (PIP-33).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Mode {
    #[default]
    Live,
    Eval(EvalCases),
}

impl Mode {
    pub fn eval(&self) -> bool {
        matches!(self, Mode::Eval(_))
    }
}

/// `pick::Pick` and every built stage handler; `NotBuilt` for the rest (picks stay off until
/// none is left, LOOP-5).
pub fn handlers(mode: Mode) -> Handlers {
    let mut h = Handlers::production();
    h.set(Stage::Design, Box::new(design::Design::new(mode.clone())));
    h.set(Stage::Publish, Box::new(publish::Publish::new(mode)));
    h
}

/// Which round a build is (the last transition into `build`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Round {
    /// From `plan`: the first build.
    First,
    /// `red` from verify or proof.
    Verify,
    /// `red` from ci.
    Ci,
    /// My PR comments (PIP-21).
    Feedback,
    /// A merge conflict with base (PIP-21).
    Conflict,
    /// My continue of a wait (PIP-17).
    Continue,
}

/// The mission's build round: its last `transitions` row into `build` (none: `First`).
pub fn round(conn: &Connection, m: &Mission) -> Result<Round, String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT from_stage, event FROM transitions WHERE mission = ?1 AND to_stage = 'build'
             ORDER BY id DESC LIMIT 1",
            [m.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(crate::db::sql)?;
    let Some((from, event)) = row else {
        return Ok(Round::First);
    };
    Ok(match event.as_str() {
        "red" if from == "ci" => Round::Ci,
        "red" => Round::Verify,
        "feedback" => Round::Feedback,
        "conflict" => Round::Conflict,
        "approve" | "intent_continued" => Round::Continue,
        _ => Round::First,
    })
}

/// The mission's last transition into `stage`: (from stage, event).
pub fn entered(
    conn: &Connection,
    m: &Mission,
    stage: Stage,
) -> Result<Option<(String, Event)>, String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT from_stage, event FROM transitions WHERE mission = ?1 AND to_stage = ?2
             ORDER BY id DESC LIMIT 1",
            rusqlite::params![m.id, stage.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(crate::db::sql)?;
    Ok(row.and_then(|(f, e)| {
        Event::ALL
            .into_iter()
            .find(|x| x.as_str() == e)
            .map(|e| (f, e))
    }))
}

/// A store failure in a step: unreachable → `Env(github)`; refused → a bug.
pub fn store_failed(e: StoreError) -> StepError {
    match e {
        StoreError::Sync(e) => StepError::Env(Fault::Github, e),
        StoreError::Refused(e) => StepError::Bug(e),
    }
}

/// The mission's intent (`Store::get`, after a pull).
pub fn intent(cx: &Ctx<'_>, m: &Mission) -> Result<Intent, StepError> {
    let id = m
        .intent
        .as_deref()
        .ok_or_else(|| StepError::Bug(format!("{}: no intent", m.label())))?;
    cx.store.get(id).map_err(store_failed)
}

/// The base branch's repo files from Towercab's clone (REPO-1): `NoVerifyingBlock`/`Invalid`
/// → the pick's waits, `Git` → `env_fail` (github).
#[allow(clippy::result_large_err)] // the outcome is what the step returns
pub fn files(cx: &Ctx<'_>, m: &Mission) -> Result<RepoFiles, Outcome> {
    let repo = cx
        .repo(m)
        .map_err(|e| Outcome::bad_result(format!("bug: {e}")))?;
    repo::load(&repo.path, &repo.base).map_err(|e| match e {
        RepoError::NoVerifyingBlock => Outcome::wait(
            Waiting::AddVerifyingBlock,
            format!(
                "{}: no ## Verifying your work with a ```checks block",
                repo.github
            ),
        ),
        RepoError::Invalid(e) => Outcome::wait(Waiting::FixRepoFiles, e),
        RepoError::Git(e) => Outcome::env(Fault::Github, e),
    })
}

/// The `## Towercab` section of the intent's `intent.md` (pipeline.md **Notes**), replaced
/// whole; empty → removed. A gone intent: nothing.
pub fn note(cx: &Ctx<'_>, m: &Mission, text: &str) -> Result<(), StepError> {
    let Some(id) = m.intent.as_deref() else {
        return Ok(());
    };
    match cx
        .store
        .update(id, "note", |i| i.set_section("Towercab", text))
    {
        Ok(_) => Ok(()),
        Err(StoreError::Refused(e)) if e.starts_with("no open intent matches") => Ok(()),
        Err(e) => Err(store_failed(e)),
    }
}

/// The waits PIP-14 shows as `⛔ Not ready` in the PR text: on me before the review.
pub fn not_ready(w: Waiting) -> bool {
    matches!(
        w,
        Waiting::ChecksRed
            | Waiting::TestsDontProve
            | Waiting::CiRed
            | Waiting::NoCiChecks
            | Waiting::CiStuck
            | Waiting::AnswerTheQuestion
            | Waiting::ProtectedPathChanged
    )
}

/// A wait with a note for me: the note in `intent.md`, then, for PIP-14's waits on a PR, its
/// body `⛔ Not ready: <why>` (never blocks), then `Outcome::wait`.
pub fn wait_note(
    cx: &Ctx<'_>,
    m: &Mission,
    w: Waiting,
    why: &str,
    note_text: &str,
) -> Result<Progress, StepError> {
    note(cx, m, note_text)?;
    if not_ready(w) && m.pr.is_some() {
        let footer = crate::writer::footer(cx, m);
        let url = intent_url(cx, m);
        crate::writer::patch(
            cx,
            m,
            &crate::writer::not_ready(&format!("{w}: {why}"), &url, &footer),
        );
    }
    Ok(Progress::Done(Outcome::wait(w, why)))
}

/// PIP-15: a mission at a stage that needs its PR, without one → `waiting: never published`.
pub fn never_published(m: &Mission) -> Option<Progress> {
    m.pr.is_none().then(|| {
        Progress::Done(Outcome::wait(
            Waiting::NeverPublished,
            format!("{} has no PR", m.branch.as_deref().unwrap_or("the branch")),
        ))
    })
}

/// A Conventional Commit subject: `<type>(<scope>)[!]: <description>` (scope empty →
/// `<type>[!]: …`), on one line.
pub fn conventional(kind: &str, scope: &str, breaking: bool, description: &str) -> String {
    let scope = scope.trim();
    let scope = if scope.is_empty() {
        String::new()
    } else {
        format!("({scope})")
    };
    let bang = if breaking { "!" } else { "" };
    format!(
        "{kind}{scope}{bang}: {}",
        crate::outbox::one_line(description)
    )
}

/// The link to the intent's `intent.md` (on GitHub when `[intents].remote` is, else its path).
pub fn intent_url(cx: &Ctx<'_>, m: &Mission) -> String {
    let id = m.intent.clone().unwrap_or_default();
    let slug = cx
        .store
        .scan()
        .open
        .iter()
        .chain(cx.store.scan().done.iter())
        .find(|i| i.id == id)
        .map(|i| i.slug.clone())
        .unwrap_or_default();
    crate::outbox::intent_link(
        &Subject {
            id,
            slug,
            ..Subject::default()
        },
        cx.config,
    )
}
