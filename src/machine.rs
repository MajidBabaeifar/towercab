//! The one state machine (LOOP-3, loop.md **Machine** and **Transitions**): every stage ×
//! event pair in one `match`, and the only code that moves a mission (`apply`).

use std::fmt;
use std::str::FromStr;

use rusqlite::types::Value;
use rusqlite::{Connection, params};

use crate::checkout;
use crate::config::Config;
use crate::db::{Db, del_meta, get_meta, set_meta, sql};
use crate::env;
use crate::handler::{Ctx, Outcome, update};
use crate::intents::{self, Intent, Listing, StoreError, Value as IValue};
use crate::limits;
use crate::mission::{self, Mission, NewMission};
use crate::outbox::{self, Notice, Subject};
use crate::runloop::Tick;

/// A mission's stage: the order, revert and rehearsal sequences, the waits on me, and the ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Stage {
    Pick,
    Design,
    Plan,
    Build,
    Verify,
    Proof,
    Publish,
    Ci,
    Verifier,
    Review,
    Gate,
    Merge,
    Deploy,
    E2e,
    Release,
    Done,
    Rollback,
    Revert,
    RevertCi,
    RevertMerge,
    RevertDeploy,
    RevertE2e,
    Rehearse,
    RehearseCi,
    RehearseClose,
    ApprovalSpec,
    ApprovalMerge,
    ApprovalRelease,
    Blocked,
    Stopped,
}

/// Which sequence a mission's stage belongs to (`missions.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Intent,
    Revert,
    Rehearsal,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Intent => "intent",
            Kind::Revert => "revert",
            Kind::Rehearsal => "rehearsal",
        }
    }
}

impl FromStr for Kind {
    type Err = String;
    fn from_str(s: &str) -> Result<Kind, String> {
        match s {
            "intent" => Ok(Kind::Intent),
            "revert" => Ok(Kind::Revert),
            "rehearsal" => Ok(Kind::Rehearsal),
            _ => Err(format!("unknown mission kind {s:?}")),
        }
    }
}

/// The order: pick → … → release → done.
pub const ORDER: [Stage; 16] = [
    Stage::Pick,
    Stage::Design,
    Stage::Plan,
    Stage::Build,
    Stage::Verify,
    Stage::Proof,
    Stage::Publish,
    Stage::Ci,
    Stage::Verifier,
    Stage::Review,
    Stage::Gate,
    Stage::Merge,
    Stage::Deploy,
    Stage::E2e,
    Stage::Release,
    Stage::Done,
];

/// A revert mission (PIP-19): rollback → … → revert_e2e → done.
pub const REVERT: [Stage; 7] = [
    Stage::Rollback,
    Stage::Revert,
    Stage::RevertCi,
    Stage::RevertMerge,
    Stage::RevertDeploy,
    Stage::RevertE2e,
    Stage::Done,
];

/// A rollback rehearsal (PIP-35): rehearse → rehearse_ci → rehearse_close → done.
pub const REHEARSAL: [Stage; 4] = [
    Stage::Rehearse,
    Stage::RehearseCi,
    Stage::RehearseClose,
    Stage::Done,
];

/// The stages of the order before `done`.
macro_rules! order {
    () => {
        Stage::Pick
            | Stage::Design
            | Stage::Plan
            | Stage::Build
            | Stage::Verify
            | Stage::Proof
            | Stage::Publish
            | Stage::Ci
            | Stage::Verifier
            | Stage::Review
            | Stage::Gate
            | Stage::Merge
            | Stage::Deploy
            | Stage::E2e
            | Stage::Release
    };
}

/// The revert stages before `done`.
macro_rules! revert {
    () => {
        Stage::Rollback
            | Stage::Revert
            | Stage::RevertCi
            | Stage::RevertMerge
            | Stage::RevertDeploy
            | Stage::RevertE2e
    };
}

/// The rehearsal stages before `done`.
macro_rules! rehearsal {
    () => {
        Stage::Rehearse | Stage::RehearseCi | Stage::RehearseClose
    };
}

/// Every stage that runs a handler: the three sequences before `done`.
macro_rules! run {
    () => {
        order!() | revert!() | rehearsal!()
    };
}

/// Waiting on me.
macro_rules! waits {
    () => {
        Stage::ApprovalSpec | Stage::ApprovalMerge | Stage::ApprovalRelease | Stage::Blocked
    };
}

/// design … merge: the stages with a PR that isn't merged yet.
macro_rules! design_to_merge {
    () => {
        Stage::Design
            | Stage::Plan
            | Stage::Build
            | Stage::Verify
            | Stage::Proof
            | Stage::Publish
            | Stage::Ci
            | Stage::Verifier
            | Stage::Review
            | Stage::Gate
            | Stage::Merge
    };
}

impl Stage {
    pub const ALL: [Stage; 30] = [
        Stage::Pick,
        Stage::Design,
        Stage::Plan,
        Stage::Build,
        Stage::Verify,
        Stage::Proof,
        Stage::Publish,
        Stage::Ci,
        Stage::Verifier,
        Stage::Review,
        Stage::Gate,
        Stage::Merge,
        Stage::Deploy,
        Stage::E2e,
        Stage::Release,
        Stage::Done,
        Stage::Rollback,
        Stage::Revert,
        Stage::RevertCi,
        Stage::RevertMerge,
        Stage::RevertDeploy,
        Stage::RevertE2e,
        Stage::Rehearse,
        Stage::RehearseCi,
        Stage::RehearseClose,
        Stage::ApprovalSpec,
        Stage::ApprovalMerge,
        Stage::ApprovalRelease,
        Stage::Blocked,
        Stage::Stopped,
    ];

    /// `missions.stage` and `machine::next`'s table names.
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Pick => "pick",
            Stage::Design => "design",
            Stage::Plan => "plan",
            Stage::Build => "build",
            Stage::Verify => "verify",
            Stage::Proof => "proof",
            Stage::Publish => "publish",
            Stage::Ci => "ci",
            Stage::Verifier => "verifier",
            Stage::Review => "review",
            Stage::Gate => "gate",
            Stage::Merge => "merge",
            Stage::Deploy => "deploy",
            Stage::E2e => "e2e",
            Stage::Release => "release",
            Stage::Done => "done",
            Stage::Rollback => "rollback",
            Stage::Revert => "revert",
            Stage::RevertCi => "revert_ci",
            Stage::RevertMerge => "revert_merge",
            Stage::RevertDeploy => "revert_deploy",
            Stage::RevertE2e => "revert_e2e",
            Stage::Rehearse => "rehearse",
            Stage::RehearseCi => "rehearse_ci",
            Stage::RehearseClose => "rehearse_close",
            Stage::ApprovalSpec => "approval:spec",
            Stage::ApprovalMerge => "approval:merge",
            Stage::ApprovalRelease => "approval:release",
            Stage::Blocked => "blocked",
            Stage::Stopped => "stopped",
        }
    }

    /// `revert` for rollback … revert_e2e, `rehearsal` for rehearse … rehearse_close, else
    /// `intent`.
    pub fn kind(self) -> Kind {
        match self {
            revert!() => Kind::Revert,
            rehearsal!() => Kind::Rehearsal,
            order!() | waits!() | Stage::Done | Stage::Stopped => Kind::Intent,
        }
    }

    /// A stage of the order, revert or rehearsal sequence but `done`: Towercab drives it.
    pub fn driven(self) -> bool {
        matches!(self, run!())
    }

    /// Waiting on me: `approval:*` or `blocked`.
    pub fn waits(self) -> bool {
        matches!(self, waits!())
    }

    /// `done` or `stopped`: the mission is over and ignores every event.
    pub fn finished(self) -> bool {
        matches!(self, Stage::Done | Stage::Stopped)
    }

    /// The next stage of its sequence (`None` for `done` and the stages outside one).
    pub fn next(self) -> Option<Stage> {
        [&ORDER[..], &REVERT, &REHEARSAL]
            .iter()
            .find_map(|seq| seq.windows(2).find(|w| w[0] == self).map(|w| w[1]))
    }

    /// The playbook stage `intent.md` shows (INT-5); `None` = unchanged.
    pub fn playbook(self) -> Option<intents::Stage> {
        use intents::Stage as P;
        match self {
            Stage::Pick | Stage::Design | Stage::ApprovalSpec => Some(P::Design),
            Stage::Plan | Stage::Build => Some(P::Build),
            Stage::Verify | Stage::Proof | Stage::Publish | Stage::Ci | Stage::Verifier => {
                Some(P::Test)
            }
            Stage::Review
            | Stage::Gate
            | Stage::Merge
            | Stage::ApprovalMerge
            | Stage::Deploy
            | Stage::E2e
            | Stage::Release
            | Stage::ApprovalRelease => Some(P::Deploy),
            revert!() => Some(P::Maintain),
            Stage::Done => Some(P::Done),
            Stage::Blocked | Stage::Stopped | rehearsal!() => None,
        }
    }
}

impl fmt::Display for Stage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Stage {
    type Err = String;
    fn from_str(s: &str) -> Result<Stage, String> {
        Stage::ALL
            .into_iter()
            .find(|st| st.as_str() == s)
            .ok_or_else(|| format!("unknown stage {s:?}"))
    }
}

/// What happened to a mission: a handler's outcome, a PR or intent change, or my command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Event {
    Ok,
    Red,
    Timeout,
    Limit,
    Blocked,
    BadResult,
    EnvFail,
    Crash,
    Interrupted,
    PrMerged,
    PrClosed,
    Feedback,
    Conflict,
    HeadMoved,
    IntentRemoved,
    IntentContinued,
    RetryFresh,
    Approve,
    Release,
    Pause,
    Resume,
}

impl Event {
    pub const ALL: [Event; 21] = [
        Event::Ok,
        Event::Red,
        Event::Timeout,
        Event::Limit,
        Event::Blocked,
        Event::BadResult,
        Event::EnvFail,
        Event::Crash,
        Event::Interrupted,
        Event::PrMerged,
        Event::PrClosed,
        Event::Feedback,
        Event::Conflict,
        Event::HeadMoved,
        Event::IntentRemoved,
        Event::IntentContinued,
        Event::RetryFresh,
        Event::Approve,
        Event::Release,
        Event::Pause,
        Event::Resume,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Event::Ok => "ok",
            Event::Red => "red",
            Event::Timeout => "timeout",
            Event::Limit => "limit",
            Event::Blocked => "blocked",
            Event::BadResult => "bad_result",
            Event::EnvFail => "env_fail",
            Event::Crash => "crash",
            Event::Interrupted => "interrupted",
            Event::PrMerged => "pr_merged",
            Event::PrClosed => "pr_closed",
            Event::Feedback => "feedback",
            Event::Conflict => "conflict",
            Event::HeadMoved => "head_moved",
            Event::IntentRemoved => "intent_removed",
            Event::IntentContinued => "intent_continued",
            Event::RetryFresh => "retry_fresh",
            Event::Approve => "approve",
            Event::Release => "release",
            Event::Pause => "pause",
            Event::Resume => "resume",
        }
    }
}

impl fmt::Display for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Event {
    type Err = String;
    fn from_str(s: &str) -> Result<Event, String> {
        Event::ALL
            .into_iter()
            .find(|e| e.as_str() == s)
            .ok_or_else(|| format!("unknown event {s:?}"))
    }
}

/// What an event does to a mission (loop.md **Machine**).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    /// To that stage, its entry effects due.
    Go(Stage),
    /// To the stage of the outcome's `waiting` (`Waiting::stage`).
    Wait,
    /// Re-enter the step; nothing counted.
    Again,
    /// A usage limit: cooldown, step kept.
    Cool,
    /// A network or auth failure: retry the step later (LOOP-10).
    Backoff,
    /// An unclean exit or a caught panic: `unclean + 1`; the third → `crashed at <stage>`.
    Recover,
    /// To `stopped`.
    Stop,
    /// I went on: `continue_to` its `waiting`.
    Continue,
    /// A new attempt replaces this mission.
    Fresh,
    /// Nothing happens.
    Ignore,
    /// An event this stage never produces: logged, then as `Recover`.
    Unexpected,
}

/// The transition table (loop.md **Transitions**): one `match`, no catch-all arm.
pub fn next(stage: Stage, event: Event) -> Next {
    use Next::*;
    let seq = || match stage.next() {
        Some(s) => Go(s),
        None => Unexpected,
    };
    match event {
        Event::Ok => match stage {
            run!() => seq(),
            waits!() => Unexpected,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Red => match stage {
            Stage::Verify | Stage::Proof | Stage::Ci => Go(Stage::Build),
            Stage::E2e => Go(Stage::Rollback),
            Stage::Pick
            | Stage::Design
            | Stage::Plan
            | Stage::Build
            | Stage::Publish
            | Stage::Verifier
            | Stage::Review
            | Stage::Gate
            | Stage::Merge
            | Stage::Deploy
            | Stage::Release => Unexpected,
            revert!() => Unexpected,
            Stage::Rehearse | Stage::RehearseCi => Go(Stage::RehearseClose),
            Stage::RehearseClose => Unexpected,
            waits!() => Unexpected,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Timeout | Event::BadResult => match stage {
            run!() => Again,
            waits!() => Unexpected,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Limit => match stage {
            run!() => Cool,
            waits!() => Unexpected,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Blocked => match stage {
            run!() | waits!() => Wait,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::EnvFail => match stage {
            run!() | waits!() => Backoff,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Crash => match stage {
            run!() => Recover,
            waits!() | Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Interrupted => match stage {
            run!() => Again,
            waits!() | Stage::Done | Stage::Stopped => Ignore,
        },
        Event::PrMerged => match stage {
            design_to_merge!() => Go(Stage::Deploy),
            Stage::Pick | Stage::Deploy | Stage::E2e | Stage::Release => Ignore,
            revert!() | rehearsal!() => Ignore,
            Stage::ApprovalSpec | Stage::ApprovalMerge | Stage::Blocked => Go(Stage::Deploy),
            Stage::ApprovalRelease => Ignore,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::PrClosed => match stage {
            design_to_merge!() => Stop,
            Stage::Pick | Stage::Deploy | Stage::E2e | Stage::Release => Ignore,
            revert!() | rehearsal!() => Ignore,
            Stage::ApprovalSpec | Stage::ApprovalMerge | Stage::Blocked => Stop,
            Stage::ApprovalRelease => Ignore,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Feedback => match stage {
            Stage::Build
            | Stage::Verify
            | Stage::Proof
            | Stage::Publish
            | Stage::Ci
            | Stage::Verifier
            | Stage::Review
            | Stage::Gate
            | Stage::Merge => Go(Stage::Build),
            Stage::Pick
            | Stage::Design
            | Stage::Plan
            | Stage::Deploy
            | Stage::E2e
            | Stage::Release => Ignore,
            revert!() | rehearsal!() => Ignore,
            Stage::ApprovalSpec => Go(Stage::Design),
            Stage::ApprovalMerge | Stage::Blocked => Go(Stage::Build),
            Stage::ApprovalRelease => Ignore,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Conflict => match stage {
            Stage::Ci | Stage::Verifier | Stage::Review | Stage::Gate | Stage::Merge => {
                Go(Stage::Build)
            }
            Stage::Pick
            | Stage::Design
            | Stage::Plan
            | Stage::Build
            | Stage::Verify
            | Stage::Proof
            | Stage::Publish
            | Stage::Deploy
            | Stage::E2e
            | Stage::Release => Ignore,
            revert!() | rehearsal!() => Ignore,
            Stage::ApprovalSpec | Stage::ApprovalRelease => Ignore,
            Stage::ApprovalMerge | Stage::Blocked => Go(Stage::Build),
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::HeadMoved => match stage {
            Stage::Ci | Stage::Verifier | Stage::Review | Stage::Gate | Stage::Merge => {
                Go(Stage::Ci)
            }
            Stage::Pick
            | Stage::Design
            | Stage::Plan
            | Stage::Build
            | Stage::Verify
            | Stage::Proof
            | Stage::Publish
            | Stage::Deploy
            | Stage::E2e
            | Stage::Release => Ignore,
            revert!() | rehearsal!() => Ignore,
            Stage::ApprovalSpec | Stage::ApprovalRelease => Ignore,
            Stage::ApprovalMerge | Stage::Blocked => Go(Stage::Ci),
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::IntentRemoved => match stage {
            order!() | waits!() => Stop,
            revert!() | rehearsal!() => Ignore,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::IntentContinued | Event::Approve => match stage {
            run!() => Ignore,
            waits!() => Continue,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::RetryFresh => match stage {
            order!() | waits!() => Fresh,
            revert!() | rehearsal!() => Ignore,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Release => match stage {
            Stage::ApprovalRelease => Go(Stage::Release),
            run!() | Stage::ApprovalSpec | Stage::ApprovalMerge | Stage::Blocked => Ignore,
            Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Pause => match stage {
            run!() | waits!() | Stage::Done | Stage::Stopped => Ignore,
        },
        Event::Resume => match stage {
            Stage::Merge | Stage::Rollback | Stage::RevertMerge => Again,
            Stage::Pick
            | Stage::Design
            | Stage::Plan
            | Stage::Build
            | Stage::Verify
            | Stage::Proof
            | Stage::Publish
            | Stage::Ci
            | Stage::Verifier
            | Stage::Review
            | Stage::Gate
            | Stage::Deploy
            | Stage::E2e
            | Stage::Release => Ignore,
            Stage::Revert | Stage::RevertCi | Stage::RevertDeploy | Stage::RevertE2e => Ignore,
            rehearsal!() | waits!() | Stage::Done | Stage::Stopped => Ignore,
        },
    }
}

/// Which way a merge that broke e2e can be undone (PIP-20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Door {
    OneWay,
    TwoWay,
    Unknown,
}

impl Door {
    pub const ALL: [Door; 3] = [Door::OneWay, Door::TwoWay, Door::Unknown];

    pub fn as_str(self) -> &'static str {
        match self {
            Door::OneWay => "one-way",
            Door::TwoWay => "two-way",
            Door::Unknown => "unknown",
        }
    }
}

/// Every `waiting:` Towercab writes (LOOP-14, loop.md **Messages**).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Waiting {
    ApproveSpec,
    ReviewAndMergePr,
    AuthorizeRelease,
    AnswerTheQuestion,
    CiRed,
    ChecksRed,
    TestsDontProve,
    NoCiChecks,
    CiStuck,
    WorkerTimeout,
    WorkerBudget,
    NoResult,
    NoChanges,
    CrashedAt(Stage),
    BadAfter,
    UnknownRepo,
    PrStateUnknown,
    MergeFailed,
    NeverPublished,
    AddVerifyingBlock,
    FixRepoFiles,
    ProtectedPathChanged,
    RevertedRefine,
    E2eRedAfterYourMerge(Door),
    DeployNotSeen,
    RevertFailed,
    ReleaseFailed,
    ProductionE2eRed,
    PrClosed,
}

/// The waits without a parameter, with their text.
const PLAIN: [(Waiting, &str); 27] = [
    (Waiting::ApproveSpec, "approve spec"),
    (Waiting::ReviewAndMergePr, "review and merge PR"),
    (Waiting::AuthorizeRelease, "authorize release"),
    (Waiting::AnswerTheQuestion, "answer the question"),
    (Waiting::CiRed, "CI red"),
    (Waiting::ChecksRed, "checks red"),
    (Waiting::TestsDontProve, "tests don't prove the change"),
    (Waiting::NoCiChecks, "no CI checks appeared"),
    (Waiting::CiStuck, "CI stuck"),
    (Waiting::WorkerTimeout, "worker timeout"),
    (Waiting::WorkerBudget, "worker budget"),
    (Waiting::NoResult, "no result"),
    (Waiting::NoChanges, "no changes"),
    (Waiting::BadAfter, "bad after:"),
    (Waiting::UnknownRepo, "unknown repo"),
    (Waiting::PrStateUnknown, "PR state unknown"),
    (Waiting::MergeFailed, "merge failed"),
    (Waiting::NeverPublished, "never published"),
    (Waiting::AddVerifyingBlock, "add CLAUDE.md verifying block"),
    (Waiting::FixRepoFiles, "fix repo files"),
    (Waiting::ProtectedPathChanged, "protected path changed"),
    (Waiting::RevertedRefine, "reverted, refine"),
    (Waiting::DeployNotSeen, "deploy not seen"),
    (Waiting::RevertFailed, "revert failed"),
    (Waiting::ReleaseFailed, "release failed"),
    (Waiting::ProductionE2eRed, "production e2e red"),
    (Waiting::PrClosed, "PR closed"),
];

const CRASHED_AT: &str = "crashed at ";
const E2E_RED: &str = "e2e red after your merge";

impl Waiting {
    /// One sample per variant.
    pub const ALL: [Waiting; 29] = [
        Waiting::ApproveSpec,
        Waiting::ReviewAndMergePr,
        Waiting::AuthorizeRelease,
        Waiting::AnswerTheQuestion,
        Waiting::CiRed,
        Waiting::ChecksRed,
        Waiting::TestsDontProve,
        Waiting::NoCiChecks,
        Waiting::CiStuck,
        Waiting::WorkerTimeout,
        Waiting::WorkerBudget,
        Waiting::NoResult,
        Waiting::NoChanges,
        Waiting::CrashedAt(Stage::Build),
        Waiting::BadAfter,
        Waiting::UnknownRepo,
        Waiting::PrStateUnknown,
        Waiting::MergeFailed,
        Waiting::NeverPublished,
        Waiting::AddVerifyingBlock,
        Waiting::FixRepoFiles,
        Waiting::ProtectedPathChanged,
        Waiting::RevertedRefine,
        Waiting::E2eRedAfterYourMerge(Door::TwoWay),
        Waiting::DeployNotSeen,
        Waiting::RevertFailed,
        Waiting::ReleaseFailed,
        Waiting::ProductionE2eRed,
        Waiting::PrClosed,
    ];

    /// The `waiting:` text (`crashed at build`, `e2e red after your merge (two-way)`).
    pub fn text(&self) -> String {
        match self {
            Waiting::CrashedAt(s) => format!("{CRASHED_AT}{s}"),
            Waiting::E2eRedAfterYourMerge(d) => format!("{E2E_RED} ({})", d.as_str()),
            w => PLAIN
                .iter()
                .find(|(p, _)| p == w)
                .map(|(_, t)| t.to_string())
                .unwrap_or_default(),
        }
    }

    /// A `waiting:` text Towercab wrote; any other (mine) → `None`.
    pub fn parse(s: &str) -> Option<Waiting> {
        let s = s.trim();
        if let Some((w, _)) = PLAIN.iter().find(|(_, t)| *t == s) {
            return Some(*w);
        }
        if let Some(stage) = s.strip_prefix(CRASHED_AT) {
            return stage.parse().ok().map(Waiting::CrashedAt);
        }
        let door = s.strip_prefix(E2E_RED)?.trim().strip_prefix('(')?;
        let door = door.strip_suffix(')')?;
        Door::ALL
            .into_iter()
            .find(|d| d.as_str() == door)
            .map(Waiting::E2eRedAfterYourMerge)
    }

    /// The stage a mission waits in; `None` for the waits written without a mission (LOOP-5).
    pub fn stage(&self) -> Option<Stage> {
        match self {
            Waiting::ApproveSpec => Some(Stage::ApprovalSpec),
            Waiting::ReviewAndMergePr => Some(Stage::ApprovalMerge),
            Waiting::AuthorizeRelease => Some(Stage::ApprovalRelease),
            Waiting::BadAfter | Waiting::UnknownRepo => None,
            Waiting::PrClosed => Some(Stage::Stopped),
            _ => Some(Stage::Blocked),
        }
    }

    /// The text before any parameter, lowercased, each run of other characters → `_`
    /// (`crashed_at`, `bad_after`): the outbox `event`.
    pub fn key(&self) -> String {
        let text = match self {
            Waiting::CrashedAt(_) => CRASHED_AT.to_string(),
            Waiting::E2eRedAfterYourMerge(_) => E2E_RED.to_string(),
            w => w.text(),
        };
        let mut out = String::new();
        for c in text.chars() {
            if c.is_ascii_alphanumeric() {
                out.push(c.to_ascii_lowercase());
            } else if !out.ends_with('_') {
                out.push('_');
            }
        }
        out.trim_matches('_').to_string()
    }
}

impl fmt::Display for Waiting {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text())
    }
}

/// Where I continue a mission waiting with `waiting` (PIP-17); `from` = the stage it left.
pub fn continue_to(waiting: &Waiting, from: Stage) -> Next {
    match waiting {
        Waiting::ApproveSpec => Next::Go(Stage::Plan),
        Waiting::ReviewAndMergePr => Next::Go(Stage::Gate),
        Waiting::AuthorizeRelease => Next::Go(Stage::Release),
        Waiting::E2eRedAfterYourMerge(_) => Next::Go(Stage::Done),
        Waiting::DeployNotSeen
        | Waiting::RevertFailed
        | Waiting::AddVerifyingBlock
        | Waiting::FixRepoFiles => Next::Go(from),
        Waiting::CrashedAt(s) => Next::Go(*s),
        Waiting::RevertedRefine | Waiting::PrClosed => Next::Fresh,
        Waiting::AnswerTheQuestion
        | Waiting::CiRed
        | Waiting::ChecksRed
        | Waiting::TestsDontProve
        | Waiting::NoCiChecks
        | Waiting::CiStuck
        | Waiting::WorkerTimeout
        | Waiting::WorkerBudget
        | Waiting::NoResult
        | Waiting::NoChanges
        | Waiting::BadAfter
        | Waiting::UnknownRepo
        | Waiting::PrStateUnknown
        | Waiting::MergeFailed
        | Waiting::NeverPublished
        | Waiting::ProtectedPathChanged
        | Waiting::ReleaseFailed
        | Waiting::ProductionE2eRed => match from.kind() {
            Kind::Intent => Next::Go(Stage::Build),
            // A revert or rehearsal has no worker: it goes on where it stopped.
            Kind::Revert | Kind::Rehearsal => Next::Go(from),
        },
    }
}

/// What `apply` reads besides the mission: messages need the intent's title and slug, a fresh
/// attempt its `model` and `a`.
pub struct Apply<'a> {
    pub db: &'a Db,
    pub config: &'a Config,
    /// The last `intents` listing, if any.
    pub listing: Option<&'a Listing>,
    pub tick: Tick,
}

impl Apply<'_> {
    fn intent(&self, m: &Mission) -> Option<&Intent> {
        let id = m.intent.as_deref()?;
        self.listing?.open.iter().find(|i| i.id == id)
    }

    /// The mission as a message's subject.
    pub fn subject(&self, m: &Mission, why: Option<&str>) -> Subject {
        let i = self.intent(m);
        Subject {
            id: m.label(),
            repo: m.repo.clone(),
            title: i.map_or_else(|| m.label(), |i| i.title().to_string()),
            slug: i.map(|i| i.slug.clone()).unwrap_or_default(),
            pr_url: m.pr_url.clone(),
            why: why.map(str::to_string),
        }
    }
}

/// The kind a mission has in `to`: it follows the stage; a rehearsal stays one.
fn kind_in(cur: Kind, to: Stage) -> Kind {
    if cur == Kind::Rehearsal {
        Kind::Rehearsal
    } else {
        to.kind()
    }
}

/// Sets `col` in `cols`, replacing an earlier value.
fn put(cols: &mut Vec<(String, Value)>, col: &str, v: impl Into<Value>) {
    let v = v.into();
    match cols.iter_mut().find(|(c, _)| c == col) {
        Some(slot) => slot.1 = v,
        None => cols.push((col.to_string(), v)),
    }
}

fn text(s: Option<impl Into<String>>) -> Value {
    s.map_or(Value::Null, |s| Value::Text(s.into()))
}

/// Moves `m` by `o` (LOOP-6): one transaction for the stage, `step = 'enter'`, `Outcome::set`,
/// counters, `waiting`, `why`, a `transitions` row and its outbox rows. `Ignore`, or `m` no
/// longer at its stage, writes nothing. Returns the mission as stored.
pub fn apply(ax: &Apply, m: &Mission, o: &Outcome) -> Result<Mission, String> {
    apply_as(ax, m, o, None)
}

/// [`apply`] with the `Next` given (`Unexpected` for a handler's bug), else the table's.
pub fn apply_as(
    ax: &Apply,
    m: &Mission,
    o: &Outcome,
    given: Option<Next>,
) -> Result<Mission, String> {
    ax.db.tx(|tx| apply_tx(tx, ax, m, o, given))
}

/// What a transition does to the row.
enum Act {
    /// Same stage and step (`Again`, `Cool`, `Backoff`, `Recover` below 3).
    Stay,
    /// To a stage (waiting there with `Some`).
    Move(Stage, Option<Waiting>),
    /// This mission stopped, a new attempt at `pick`.
    Fresh,
}

/// [`apply`] inside a transaction.
pub fn apply_tx(
    tx: &Connection,
    ax: &Apply,
    m: &Mission,
    o: &Outcome,
    given: Option<Next>,
) -> Result<Mission, String> {
    let cur = mission::get(tx, m.id)?;
    if cur.stage != m.stage {
        return Ok(cur);
    }
    let now = ax.tick.unix();
    let mut n = given.unwrap_or_else(|| next(cur.stage, o.event));
    let mut why = o.why.clone();
    if n == Next::Ignore {
        return Ok(cur);
    }
    let from = cur.from_stage.unwrap_or(cur.stage);
    let cont = cur
        .waiting()
        .map_or(Next::Go(Stage::Build), |w| continue_to(&w, from));
    // An outcome the table can't carry out is a handler's bug: Unexpected (counted), never an
    // error that stalls every pass.
    let bug = match n {
        Next::Wait if o.waiting.and_then(|w| w.stage()).is_none() => {
            Some("blocked without a mission's waiting")
        }
        Next::Cool if o.limit.is_none() => Some("limit without a Limit"),
        Next::Fresh if cur.intent.is_none() => Some("a fresh attempt without an intent"),
        Next::Continue if cont == Next::Fresh && cur.intent.is_none() => {
            Some("a fresh attempt without an intent")
        }
        _ => None,
    };
    if let Some(b) = bug {
        why = Some(match why {
            Some(w) => format!("bug: {b}: {w}"),
            None => format!("bug: {b}"),
        });
        n = Next::Unexpected;
    }
    if n == Next::Unexpected {
        let what = format!("unexpected {} at {}", o.event, cur.stage);
        why = Some(match why {
            Some(w) => format!("{what}: {w}"),
            None => what,
        });
        eprintln!(
            "towercab: {}: {}",
            cur.label(),
            why.as_deref().unwrap_or("")
        );
        n = Next::Recover;
    }
    let mut cols: Vec<(String, Value)> = Vec::new();
    put(&mut cols, "updated", now);
    let act = match n {
        Next::Go(s) => Act::Move(s, None),
        Next::Wait => match o.waiting.and_then(|w| w.stage().map(|s| (s, w))) {
            Some((s, w)) => Act::Move(s, Some(w)),
            None => unreachable!("checked above"),
        },
        Next::Again => {
            if o.event == Event::Resume {
                put(&mut cols, "held", 0);
            }
            Act::Stay
        }
        Next::Cool => {
            let Some(limit) = &o.limit else {
                unreachable!("checked above")
            };
            // A reset already past: the backoff (`limits::cool`).
            limits::cool(tx, limit, now)?;
            put(&mut cols, "limit_model", limit.model.clone());
            Act::Stay
        }
        Next::Backoff => {
            let retries = cur.retries + 1;
            put(&mut cols, "retries", retries);
            // While env_blocked its calls retry every 5 min (LOOP-10).
            let delay = if env::blocked(tx)? {
                env::RECHECK
            } else {
                env::backoff(retries).as_secs_f64()
            };
            put(&mut cols, "retry_at", now + delay);
            if let Some((fault, error)) = &o.fault {
                if env::open(tx, fault, error, now)? {
                    eprintln!("towercab: {fault}: {}", outbox::one_line(error));
                }
                put(&mut cols, "fault", fault.to_string());
            }
            Act::Stay
        }
        Next::Recover => {
            let unclean = cur.unclean + 1;
            if unclean >= 3 {
                Act::Move(Stage::Blocked, Some(Waiting::CrashedAt(cur.stage)))
            } else {
                put(&mut cols, "unclean", unclean);
                Act::Stay
            }
        }
        Next::Stop => Act::Move(
            Stage::Stopped,
            (o.event == Event::PrClosed).then_some(Waiting::PrClosed),
        ),
        Next::Continue => {
            for c in ["verify_repairs", "ci_repairs", "sync_rounds"] {
                put(&mut cols, c, 0);
            }
            match cont {
                Next::Go(s) => Act::Move(s, None),
                Next::Fresh => Act::Fresh,
                other => return Err(format!("{}: continue gave {other:?}", cur.label())),
            }
        }
        Next::Fresh => Act::Fresh,
        Next::Ignore | Next::Unexpected => unreachable!("handled above"),
    };
    // A step's end: no child, not busy. Its handler's result (not an env_fail) closes the
    // fault the step held (LOOP-10). A child still running is remembered until reaped.
    if let (Some(pid), Some(start)) = (cur.child_pid, cur.child_start) {
        let mut d = dying(tx)?;
        if !d.contains(&(pid, start)) {
            d.push((pid, start));
            set_dying(tx, &d)?;
        }
    }
    for c in mission::CHILD {
        put(&mut cols, c, Value::Null);
    }
    if let Some(kind) = &cur.fault
        && matches!(
            o.event,
            Event::Ok
                | Event::Red
                | Event::Timeout
                | Event::BadResult
                | Event::Limit
                | Event::Blocked
        )
    {
        env::close(tx, kind)?;
        put(&mut cols, "fault", Value::Null);
    }
    put(&mut cols, "busy", 0);
    let to = match &act {
        Act::Stay => cur.stage,
        Act::Move(s, _) => *s,
        Act::Fresh => Stage::Stopped,
    };
    if !matches!(act, Act::Stay) {
        put(&mut cols, "stage", to.as_str().to_string());
        put(
            &mut cols,
            "kind",
            kind_in(cur.kind, to).as_str().to_string(),
        );
        put(&mut cols, "step", mission::ENTER.to_string());
        // Every way out of a wait (my continue, feedback, a conflict, a push) counts: the
        // next wait is a new message (outbox `n`, LOOP-14).
        if cur.stage.waits() {
            put(&mut cols, "continued", cur.continued + 1);
        }
        for c in ["unclean", "retries", "held"] {
            put(&mut cols, c, 0);
        }
        put(&mut cols, "step_secs", 0.0);
        // A fault left behind is no longer held: rechecked until it passes.
        for c in ["retry_at", "limit_model", "fault"] {
            put(&mut cols, c, Value::Null);
        }
    }
    let waiting = match &act {
        Act::Move(_, w) => *w,
        _ => None,
    };
    if let Act::Move(s, w) = &act {
        put(&mut cols, "waiting", text(w.map(|w| w.text())));
        put(&mut cols, "why", text(why.clone()));
        let left = if cur.stage.waits() {
            cur.from_stage
        } else {
            Some(cur.stage)
        };
        let from = (w.is_some() || *s == Stage::Stopped)
            .then_some(left)
            .flatten();
        put(&mut cols, "from_stage", text(from.map(|s| s.as_str())));
    }
    for (c, v) in &o.set {
        put(&mut cols, c, v.clone());
    }
    if let Act::Fresh = act {
        put(&mut cols, "waiting", Value::Null);
        put(&mut cols, "from_stage", cur.stage.as_str().to_string());
        update(tx, cur.id, &cols)?;
        let intent = ax.intent(&cur);
        let new = NewMission {
            intent: cur
                .intent
                .clone()
                .ok_or("a fresh attempt needs an intent")?,
            slug: intent
                .map(|i| i.slug.clone())
                .unwrap_or_else(|| slug_of(&cur)),
            repo: cur.repo.clone(),
            model: intent
                .and_then(|i| i.model())
                .map(str::to_string)
                .unwrap_or_else(|| ax.config.agent.model.clone()),
            a: intent.map_or(cur.a_at_pick, |i| i.a()),
            min_attempt: cur.attempt + 1,
        };
        let fresh = mission::insert(tx, &new, ax.tick)?;
        why = Some(format!("replaced by attempt {}", fresh.attempt));
        update(tx, cur.id, &[("why".into(), text(why.clone()))])?;
    } else {
        update(tx, cur.id, &cols)?;
    }
    let stored = mission::get(tx, cur.id)?;
    if let Some(w) = waiting.filter(|w| *w != Waiting::PrClosed) {
        let n = if w == Waiting::ReviewAndMergePr {
            stored.head.clone().unwrap_or_default()
        } else {
            stored.continued.to_string()
        };
        let text = outbox::render_waiting(&w, &ax.subject(&stored, why.as_deref()), ax.config);
        outbox::enqueue(tx, &cur.id.to_string(), &w.key(), &n, &text, now)?;
    }
    match waiting {
        Some(Waiting::RevertFailed) => {
            let why = why.clone().unwrap_or_else(|| "revert failed".into());
            tx.execute(
                "INSERT INTO repo_caps (repo, frozen, why, since) VALUES (?1, 1, ?2, ?3)
                 ON CONFLICT (repo) DO UPDATE SET frozen = 1, why = excluded.why",
                params![cur.repo, why, now],
            )
            .map_err(sql)?;
            let since: f64 = tx
                .query_row(
                    "SELECT since FROM repo_caps WHERE repo = ?1",
                    [&cur.repo],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            let notice = Notice::RepoFrozen {
                repo: cur.repo.clone(),
                why,
            };
            outbox::notify(tx, &notice, &since.to_string(), now)?;
        }
        Some(Waiting::RevertedRefine) => {
            tx.execute(
                "INSERT INTO repo_caps (repo, capped, why, since) VALUES (?1, 1, 'reverted, refine', ?2)
                 ON CONFLICT (repo) DO UPDATE SET capped = 1",
                params![cur.repo, now],
            )
            .map_err(sql)?;
        }
        _ => {}
    }
    if o.event == Event::Red && matches!(cur.stage, Stage::Rehearse | Stage::RehearseCi) {
        let day = ax.tick.wall.format("%y%m%d").to_string();
        let notice = Notice::RehearsalFailed {
            repo: cur.repo.clone(),
            why: why.clone().unwrap_or_default(),
            pr_url: cur.pr_url.clone(),
        };
        outbox::notify(tx, &notice, &day, now)?;
    }
    tx.execute(
        "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![cur.id, now, cur.stage.as_str(), o.event.as_str(), to.as_str(), why],
    )
    .map_err(sql)?;
    Ok(stored)
}

/// The slug in a mission's branch (`towercab/<id>-<slug>[-<attempt>]`).
fn slug_of(m: &Mission) -> String {
    let id = m.intent.as_deref().unwrap_or_default();
    let b = m.branch.as_deref().unwrap_or_default();
    let rest = b
        .strip_prefix("towercab/")
        .and_then(|r| r.strip_prefix(id))
        .and_then(|r| r.strip_prefix('-'))
        .unwrap_or("intent");
    let suffix = format!("-{}", m.attempt);
    rest.strip_suffix(&suffix)
        .filter(|_| m.attempt >= 2)
        .unwrap_or(rest)
        .to_string()
}

/// Children a transition left running (`meta.dying`: `<pid>:<start> …`) until the loop reaps
/// them: an unclean exit's recovery kills them (LOOP-7).
pub fn dying(conn: &Connection) -> Result<Vec<(i64, i64)>, String> {
    Ok(get_meta(conn, "dying")?
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|e| {
            let (pid, start) = e.split_once(':')?;
            Some((pid.parse().ok()?, start.parse().ok()?))
        })
        .collect())
}

/// Stores `meta.dying` (none: removed).
pub fn set_dying(conn: &Connection, d: &[(i64, i64)]) -> Result<(), String> {
    if d.is_empty() {
        return del_meta(conn, "dying");
    }
    let v: Vec<String> = d.iter().map(|(p, s)| format!("{p}:{s}")).collect();
    set_meta(conn, "dying", &v.join(" "))
}

/// `meta.paused`.
pub fn paused(conn: &Connection) -> Result<bool, String> {
    Ok(get_meta(conn, "paused")?.as_deref() == Some("1"))
}

/// Entry effects (LOOP-6, **Machine**), idempotent, after the transition's transaction: the
/// intent write (kinds `intent`, `revert`; skipped when the file is gone), at `done`/`stopped`
/// the checkout deleted and `finished` set, `merge`/`revert_merge`/`rollback` held while
/// paused; then `step = ''`. (The left stage's child is killed by the loop at the transition.)
pub fn enter(cx: &mut Ctx<'_>, m: &Mission) -> Result<Mission, String> {
    if m.step != mission::ENTER {
        return Ok(m.clone());
    }
    // A finished mission replaced by a newer one (`retry --fresh`) no longer owns its intent:
    // a late write would undo the new attempt's (LOOP-6).
    let replaced = m.stage.finished()
        && cx
            .db
            .conn()
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM missions WHERE intent = ?1 AND id > ?2)",
                params![m.intent, m.id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(sql)?;
    if matches!(m.kind, Kind::Intent | Kind::Revert)
        && !replaced
        && let Some(id) = m.intent.as_deref()
    {
        let transition: i64 = cx
            .db
            .conn()
            .query_row(
                "SELECT COALESCE(MAX(id), 0) FROM transitions WHERE mission = ?1",
                [m.id],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let mark = format!("{ENTRY_MARK} {} {transition}", m.session);
        // Errors: the caller names the mission.
        if !cx.store.has_mark(&mark).map_err(|e| e.to_string())? {
            write_intent(cx, m, id, &mark)?;
            cx.probe.point();
        }
    }
    if m.stage.finished() && m.checkout.starts_with("work/") {
        checkout::remove(&cx.checkout(m))?;
    }
    let hold = matches!(m.stage, Stage::Merge | Stage::RevertMerge | Stage::Rollback)
        && paused(cx.db.conn())?;
    let now = cx.tick.unix();
    let out = cx.db.tx(|tx| {
        let mut cols: Vec<(String, Value)> = Vec::new();
        put(&mut cols, "step", String::new());
        put(&mut cols, "updated", now);
        if m.stage.finished() && m.finished.is_none() {
            put(&mut cols, "finished", now);
        }
        if hold {
            put(&mut cols, "held", 1);
        }
        update(tx, m.id, &cols)?;
        mission::get(tx, m.id)
    })?;
    cx.probe.point();
    Ok(out)
}

/// The trailer of an entry's intent commit: `Towercab-Entry: <session> <transition id>`. A
/// re-run after a crash finds it and leaves the intent alone, so my edits since stay (LOOP-6).
pub const ENTRY_MARK: &str = "Towercab-Entry:";

/// One `Store::update(id, <stage>, …)`: `stage` (`playbook()`), `waiting` set or removed,
/// `pr`; at `pick` `retry` removed; at `done` `cost`, `agent_time`, `attempts`.
fn write_intent(cx: &Ctx<'_>, m: &Mission, id: &str, mark: &str) -> Result<(), String> {
    let totals = if m.stage == Stage::Done {
        let t: (f64, f64, u32) = cx
            .db
            .conn()
            .query_row(
                "SELECT COALESCE(SUM(cost_usd), 0), COALESCE(SUM(agent_secs), 0), MAX(attempt)
                 FROM missions WHERE intent = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql)?;
        Some(t)
    } else {
        None
    };
    let r = cx
        .store
        .update_marked(id, m.stage.as_str(), Some(mark), |i| {
            if let Some(p) = m.stage.playbook() {
                i.set("stage", IValue::Str(p.as_str().into()))?;
            }
            match &m.waiting {
                Some(w) => i.set("waiting", IValue::Str(w.clone()))?,
                None => i.remove("waiting")?,
            }
            if let Some(url) = &m.pr_url {
                i.set("pr", IValue::Str(url.clone()))?;
            }
            if m.stage == Stage::Pick {
                i.remove("retry")?;
            }
            if let Some((cost, secs, attempts)) = totals {
                i.set("cost", IValue::Float(cost))?;
                i.set("agent_time", IValue::Int(secs.round() as i64))?;
                i.set("attempts", IValue::Int(i64::from(attempts.max(1))))?;
            }
            Ok(())
        });
    match r {
        Ok(_) => Ok(()),
        // Gone, or moved to done/ by an earlier run of this effect.
        Err(StoreError::Refused(e)) if e.starts_with("no open intent matches") => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
