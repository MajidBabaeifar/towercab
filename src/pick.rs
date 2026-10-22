//! Picking the next intent (LOOP-5): `decide` is pure; `Pick` is the `pick` stage's handler.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::checkout;
use crate::env::Fault;
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::intents::{Listing, Stage as Playbook};
use crate::machine::Waiting;
use crate::mission::Mission;
use crate::priority::{self, pick_order};
use crate::repo::{self, RepoError};

/// What a pick depends on besides the intents.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PickState {
    pub cutoff: u8,
    /// `meta.paused`.
    pub paused: bool,
    /// LOOP-10.
    pub env_blocked: bool,
    /// Every stage has a handler (`Handlers::built`).
    pub built: bool,
    /// `[repos]` names.
    pub repos: BTreeSet<String>,
    /// `[agent].model`: an intent without `model` runs on it.
    pub model: String,
    /// Repos with `repo_caps.frozen`.
    pub frozen: BTreeSet<String>,
    /// Repos at `workers`: (unfinished missions, workers).
    pub full: BTreeMap<String, (usize, u8)>,
    /// Models cooling down (LOOP-9): model → until (as shown).
    pub cooling: BTreeMap<String, String>,
}

/// Why an intent isn't picked (`Display` = the **Next** reason).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skip {
    Paused,
    EnvBlocked,
    NotBuilt,
    Frozen(String),
    Full { repo: String, n: usize, workers: u8 },
    Cooling { model: String, until: String },
    UnknownRepo(String),
    BadAfter(Vec<String>),
}

impl fmt::Display for Skip {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Skip::Paused => f.write_str("paused"),
            Skip::EnvBlocked => f.write_str("env blocked"),
            Skip::NotBuilt => f.write_str("picks off: pipeline not built"),
            Skip::Frozen(r) => write!(f, "repo {r} frozen"),
            Skip::Full { repo, n, workers } => write!(f, "repo {repo} full ({n}/{workers})"),
            Skip::Cooling { model, until } => write!(f, "{model} cooling until {until}"),
            Skip::UnknownRepo(r) => write!(f, "unknown repo {r}"),
            Skip::BadAfter(ids) => write!(f, "bad after: {}", ids.join(", ")),
        }
    }
}

/// The picker's answer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Decision {
    /// The intent to pick.
    pub pick: Option<String>,
    /// Intents passed over before it, in order, and why.
    pub skipped: Vec<(String, Skip)>,
    /// Waits to write without a mission: (intent id, waiting, `n` = the condition: the repo,
    /// or the sorted `after` ids joined by `, `).
    pub writes: Vec<(String, Waiting, String)>,
}

/// Queued intents with a bad `after:` id (unknown: not open, done or legacy; dropped; or on a
/// cycle of open intents) → their bad ids, sorted.
pub fn bad_after(listing: &Listing) -> Vec<(String, Vec<String>)> {
    let open: BTreeMap<&str, &[String]> = listing
        .open
        .iter()
        .map(|i| (i.id.as_str(), i.after()))
        .collect();
    let dropped: BTreeSet<&str> = listing
        .done
        .iter()
        .filter(|i| i.stage() == Some(Playbook::Dropped))
        .map(|i| i.id.as_str())
        .collect();
    let done: BTreeSet<&str> = listing.done.iter().map(|i| i.id.as_str()).collect();
    let legacy = listing.legacy_ids();
    // Whether `target` is reachable from `from` over `after` edges among open intents.
    let reaches = |from: &str, target: &str| {
        let mut seen = BTreeSet::new();
        let mut todo = vec![from.to_string()];
        while let Some(at) = todo.pop() {
            if at == target {
                return true;
            }
            if !seen.insert(at.clone()) {
                continue;
            }
            if let Some(after) = open.get(at.as_str()) {
                todo.extend(after.iter().cloned());
            }
        }
        false
    };
    let mut out = Vec::new();
    for i in listing.open.iter().filter(|i| priority::queued(i)) {
        let mut bad: Vec<String> = i
            .after()
            .iter()
            .filter(|a| {
                let a = a.as_str();
                dropped.contains(a)
                    || (!open.contains_key(a) && !done.contains(a) && !legacy.contains(a))
                    || (open.contains_key(a) && reaches(a, &i.id))
            })
            .cloned()
            .collect();
        bad.sort();
        bad.dedup();
        if !bad.is_empty() {
            out.push((i.id.clone(), bad));
        }
    }
    out
}

/// Open intents with a `stage`, no `waiting` and no unfinished mission: they lose their
/// `stage` (accepted again).
pub fn orphans(listing: &Listing, unfinished: &[Mission]) -> Vec<String> {
    let busy: BTreeSet<&str> = unfinished
        .iter()
        .filter_map(|m| m.intent.as_deref())
        .collect();
    listing
        .open
        .iter()
        .filter(|i| i.stage().is_some() && i.waiting().is_none() && !busy.contains(i.id.as_str()))
        .map(|i| i.id.clone())
        .collect()
}

/// LOOP-5: [PRI-4](priority.md) order over `priority::pick_order` (at or above the cutoff
/// first, then parked); the first intent nothing skips is picked.
pub fn decide(listing: &Listing, state: &PickState) -> Decision {
    let mut d = Decision::default();
    for (id, ids) in bad_after(listing) {
        d.writes
            .push((id.clone(), Waiting::BadAfter, ids.join(", ")));
        d.skipped.push((id, Skip::BadAfter(ids)));
    }
    for i in pick_order(listing, state.cutoff) {
        let repo = i.repo().to_string();
        if !state.repos.contains(&repo) {
            d.writes
                .push((i.id.clone(), Waiting::UnknownRepo, repo.clone()));
            d.skipped.push((i.id.clone(), Skip::UnknownRepo(repo)));
            continue;
        }
        let model = i.model().unwrap_or(&state.model).to_string();
        let skip = if state.paused {
            Some(Skip::Paused)
        } else if state.env_blocked {
            Some(Skip::EnvBlocked)
        } else if !state.built {
            Some(Skip::NotBuilt)
        } else if state.frozen.contains(&repo) {
            Some(Skip::Frozen(repo))
        } else if let Some((n, workers)) = state.full.get(&repo) {
            Some(Skip::Full {
                repo,
                n: *n,
                workers: *workers,
            })
        } else {
            state.cooling.get(&model).map(|until| Skip::Cooling {
                model,
                until: until.clone(),
            })
        };
        match skip {
            Some(s) => d.skipped.push((i.id.clone(), s)),
            None => {
                d.pick = Some(i.id.clone());
                break;
            }
        }
    }
    d
}

/// The `pick` stage: fetch Towercab's clone (LOOP-8), load the repo files (REPO-1), make the
/// checkout (LOOP-8) → `design`.
pub struct Pick;

impl Handler for Pick {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
        let git = cx.exes.git.clone();
        checkout::ensure_clone(&git, &repo, None).map_err(|e| StepError::Env(Fault::Github, e))?;
        match repo::load(&repo.path, &repo.base) {
            Ok(_) => {}
            Err(RepoError::NoVerifyingBlock) => {
                return Ok(Progress::Done(Outcome::wait(
                    Waiting::AddVerifyingBlock,
                    format!(
                        "{}: no ## Verifying your work with a ```checks block",
                        repo.github
                    ),
                )));
            }
            Err(RepoError::Invalid(e)) => {
                return Ok(Progress::Done(Outcome::wait(Waiting::FixRepoFiles, e)));
            }
            Err(RepoError::Git(e)) => return Err(StepError::Env(Fault::Github, e)),
        }
        let m = if m.step == "checkout" {
            m.clone()
        } else {
            cx.record(m, "checkout", &[])?
        };
        let dir = cx.checkout(&m);
        let branch = m
            .branch
            .clone()
            .ok_or_else(|| StepError::Bug(format!("{}: no branch", m.label())))?;
        checkout::ensure(&git, &repo.path, &dir, &repo.base, &branch).map_err(StepError::Bug)?;
        let base = checkout::rev(&git, &dir, &format!("refs/remotes/origin/{}", repo.base))
            .map_err(StepError::Bug)?;
        Ok(Progress::Done(Outcome::ok().with("base_sha", base)))
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!("{}: pick runs no child", m.label())))
    }
}
