//! Where an intent waits for me ([AUT](../specs/autonomy.md)): repo cap, effective `a`, the
//! gate, the spec gate and a worker's `lower_a`. Pure but [`RepoState::read`]; the pipeline's
//! handlers call it and do the I/O.

use std::fmt;

use rusqlite::{Connection, OptionalExtension};

use crate::db::{RepoCap, sql};
use crate::intents::{Intent, Value};
use crate::machine::{Door, Waiting};
use crate::repo::Towercab;

/// The cap while a repo is capped after a revert, or frozen (AUT-10).
pub const CAPPED: u8 = 3;

/// The highest autonomy.
const MAX: u8 = 5;

/// What a repo allows (AUT-8, AUT-10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepoState {
    /// From the base branch's `TOWERCAB.md` (REPO-1), default 5.
    pub max_autonomy: u8,
    /// `repo_caps.capped`: a revert went green.
    pub capped: bool,
    /// `repo_caps.frozen`: a revert failed; no picks or merges.
    pub frozen: bool,
}

impl RepoState {
    /// `repo`'s `repo_caps` row (none → neither flag) with `towercab.max_autonomy`.
    pub fn read(conn: &Connection, repo: &str, towercab: &Towercab) -> Result<RepoState, String> {
        let row = conn
            .query_row(
                "SELECT * FROM repo_caps WHERE repo = ?1",
                [repo],
                RepoCap::from_row,
            )
            .optional()
            .map_err(sql)?;
        Ok(RepoState {
            max_autonomy: towercab.max_autonomy,
            capped: row.as_ref().is_some_and(|r| r.capped),
            frozen: row.as_ref().is_some_and(|r| r.frozen),
        })
    }

    /// `min(max_autonomy, 3 if capped or frozen else 5)`.
    pub fn cap(&self) -> u8 {
        let limit = if self.capped || self.frozen {
            CAPPED
        } else {
            MAX
        };
        self.max_autonomy.min(limit)
    }
}

/// `min(a at pick, a now, cap)` over the `a`s present; neither → `None` (AUT-8).
pub fn effective(a_at_pick: Option<u8>, a_now: Option<u8>, cap: u8) -> Option<u8> {
    [a_at_pick, a_now]
        .into_iter()
        .flatten()
        .min()
        .map(|a| a.min(cap))
}

/// Design stops for my approval of the spec (AUT-11): a concern, effective `a` ≤ 2, or no
/// `a` in a repo capped at ≤ 2.
pub fn spec_gate(a: Option<u8>, cap: u8, concerns: bool) -> bool {
    concerns
        || match a {
            Some(a) => a <= 2,
            None => cap <= 2,
        }
}

/// The PR at the gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrKind {
    Intent,
    /// A revert mission's PR (PIP-19): no review.
    Revert,
}

/// The PR's CI as the gate sees it (PIP-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ci {
    Green,
    /// No checks in a repo without workflows (`ci: none`).
    None,
    /// Red, pending or anything else.
    NotGreen,
}

/// The PR review's verdict, computed in code (PIP-5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Review {
    pub approved: bool,
    pub door: Door,
    /// A `## Red lines` entry touched.
    pub red_lines: bool,
}

impl Review {
    /// Two-way door, no red line touched (AUT-9).
    pub fn risk_low(&self) -> bool {
        self.door == Door::TwoWay && !self.red_lines
    }
}

/// What the gate decides on (PIP-7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateIn {
    pub kind: PrKind,
    pub frozen: bool,
    /// [`RepoState::cap`].
    pub cap: u8,
    /// [`effective`] `a`.
    pub a: Option<u8>,
    pub ci: Ci,
    /// The intent has `unlock` (PIP-29).
    pub unlock: bool,
    /// `towercab/evals` red (PIP-33).
    pub evals_red: bool,
    /// `None`: no review (a revert's, or none came back: not approved).
    pub review: Option<Review>,
}

/// Why the gate sends a PR to me.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    Frozen,
    CiNotGreen,
    NoCi,
    Unlock,
    EvalsRed,
    Cap(u8),
    A(u8),
    NotApproved,
    RiskHigh,
}

impl fmt::Display for Hold {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Hold::Frozen => f.write_str("repo frozen"),
            Hold::CiNotGreen => f.write_str("CI not green"),
            Hold::NoCi => f.write_str("ci: none"),
            Hold::Unlock => f.write_str("unlock used"),
            Hold::EvalsRed => f.write_str("evals red"),
            Hold::Cap(n) => write!(f, "cap {n}"),
            Hold::A(n) => write!(f, "a{n}"),
            Hold::NotApproved => f.write_str("not approved"),
            Hold::RiskHigh => f.write_str("risk high"),
        }
    }
}

/// The gate's decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Merge,
    /// `waiting: review and merge PR`, the review's findings as one PR comment (PIP-7).
    Approval(Hold),
}

impl Gate {
    /// The wait it puts the mission in; a merge sends no message (LOOP-14).
    pub fn waiting(&self) -> Option<Waiting> {
        match self {
            Gate::Merge => None,
            Gate::Approval(_) => Some(Waiting::ReviewAndMergePr),
        }
    }
}

/// The gate (AUT-3..6, AUT-9, PIP-7): first match wins.
pub fn gate(g: &GateIn) -> Gate {
    let hold = |h| Gate::Approval(h);
    if g.frozen {
        return hold(Hold::Frozen);
    }
    if g.ci == Ci::NotGreen {
        return hold(Hold::CiNotGreen);
    }
    if g.kind == PrKind::Revert {
        return Gate::Merge;
    }
    if g.ci == Ci::None {
        return hold(Hold::NoCi);
    }
    if g.unlock {
        return hold(Hold::Unlock);
    }
    if g.evals_red {
        return hold(Hold::EvalsRed);
    }
    if g.cap <= CAPPED {
        return hold(Hold::Cap(g.cap));
    }
    let approved = g.review.is_some_and(|r| r.approved);
    match g.a {
        Some(a) if a <= CAPPED => hold(Hold::A(a)),
        _ if !approved => hold(Hold::NotApproved),
        Some(_) => Gate::Merge,
        None if g.review.is_some_and(|r| r.risk_low()) => Gate::Merge,
        None => hold(Hold::RiskHigh),
    }
}

/// The `a` a worker's `lower_a` sets, if any (AUT-7): only lower, within 1–5; no `a` → only
/// to ≤ 3 (a higher one would skip the risk judgment).
pub fn lowered(a: Option<u8>, lower_a: Option<u8>) -> Option<u8> {
    let l = lower_a.filter(|l| (1..=MAX).contains(l))?;
    match a {
        Some(a) => (l < a).then_some(l),
        None => (l <= CAPPED).then_some(l),
    }
}

/// Writes a lowered `a` and `lower_why` (trimmed; empty → removed) into `intent` with
/// `Intent::set`/`remove`; `false` = nothing changed (AUT-7). The build handler calls it inside
/// its `Store::update` (PIP-1).
pub fn lower(
    intent: &mut Intent,
    lower_a: Option<u8>,
    lower_why: Option<&str>,
) -> Result<bool, String> {
    let Some(a) = lowered(intent.a(), lower_a) else {
        return Ok(false);
    };
    let mut next = intent.clone();
    next.set("a", Value::Int(a.into()))?;
    match lower_why.map(str::trim).filter(|w| !w.is_empty()) {
        Some(why) => next.set("lower_why", Value::Str(why.to_string()))?,
        None => next.remove("lower_why")?,
    }
    *intent = next;
    Ok(true)
}
