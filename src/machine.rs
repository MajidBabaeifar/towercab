//! The one state machine (LOOP-3, loop.md **Machine** and **Transitions**): every stage ×
//! event pair in one `match`, and the only code that moves a mission (`apply`).

use std::fmt;
use std::str::FromStr;

use crate::intents;

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
        | Waiting::ProductionE2eRed => Next::Go(Stage::Build),
    }
}
