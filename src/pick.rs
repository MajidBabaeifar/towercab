//! Picking the next intent (LOOP-5): `decide` is pure; `Pick` is the `pick` stage's handler.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::checkout;
use crate::config::Config;
use crate::db::{Db, sql};
use crate::env::{self, Fault};
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::intents::{Listing, Stage as Playbook};
use crate::limits;
use crate::machine::{self, Stage, Waiting};
use crate::mission::{self, Mission};
use crate::priority::{self, pick_order};
use crate::repo::{self, RepoError};
use crate::runloop::{Tick, shown_time};

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
    /// Intents with an unfinished mission: never picked again (LOOP-4).
    pub active: BTreeSet<String>,
}

/// Why an intent isn't picked (`Display` = the **Next** reason).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skip {
    Paused,
    EnvBlocked,
    NotBuilt,
    Frozen(String),
    Full {
        repo: String,
        n: usize,
        workers: u8,
    },
    Cooling {
        model: String,
        until: String,
    },
    UnknownRepo(String),
    BadAfter(Vec<String>),
    /// Below the cutoff (PRI-5): waits until I raise its u or i.
    Parked {
        p: u8,
        cutoff: u8,
    },
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
            Skip::Parked { p, cutoff } => {
                write!(f, "parked (p{p} < {cutoff}): raise u or i to run it")
            }
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

/// LOOP-5: [PRI-4](priority.md) order over `priority::pick_order` (parked ones never picked; at or above the cutoff
/// first, then parked); the first intent nothing skips is picked.
pub fn decide(listing: &Listing, state: &PickState) -> Decision {
    let mut d = Decision::default();
    for (id, ids) in bad_after(listing) {
        d.writes
            .push((id.clone(), Waiting::BadAfter, ids.join(", ")));
        d.skipped.push((id, Skip::BadAfter(ids)));
    }
    for i in pick_order(listing, state.cutoff)
        .into_iter()
        .filter(|i| !state.active.contains(&i.id))
    {
        // Parked intents wait for me (PRI-5): listed, never picked, nothing written.
        let p = priority::p(i);
        if priority::parked(p, state.cutoff) {
            d.skipped.push((
                i.id.clone(),
                Skip::Parked {
                    p,
                    cutoff: state.cutoff,
                },
            ));
            continue;
        }
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

/// LOOP-5's inputs from the database and config; `built`: every stage has a handler.
pub fn state(db: &Db, config: &Config, built: bool, tick: Tick) -> Result<PickState, String> {
    let conn = db.conn();
    let frozen: BTreeSet<String> = {
        let mut q = conn
            .prepare("SELECT repo FROM repo_caps WHERE frozen = 1")
            .map_err(sql)?;
        q.query_map([], |r| r.get(0))
            .map_err(sql)?
            .collect::<Result<_, _>>()
            .map_err(sql)?
    };
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut active = BTreeSet::new();
    for m in mission::unfinished(conn)? {
        if m.stage != Stage::Blocked {
            *counts.entry(m.repo.clone()).or_default() += 1;
        }
        active.extend(m.intent);
    }
    let full = config
        .repos
        .iter()
        .filter_map(|(name, r)| {
            let r = r.as_ref().ok()?;
            let n = counts.get(name).copied().unwrap_or(0);
            (n >= usize::from(r.workers)).then(|| (name.clone(), (n, r.workers)))
        })
        .collect();
    let cooling = limits::cooling(db, tick.unix())?
        .into_iter()
        .filter(|c| c.provider == limits::CLAUDE)
        .map(|c| (c.model.clone(), shown_time(c.until, tick.wall)))
        .collect();
    Ok(PickState {
        cutoff: config.intents.cutoff,
        paused: machine::paused(conn)?,
        env_blocked: env::blocked(conn)?,
        built,
        repos: config
            .repos
            .iter()
            .filter(|(_, r)| r.is_ok())
            .map(|(n, _)| n.clone())
            .collect(),
        model: config.agent.model.clone(),
        frozen,
        full,
        cooling,
        active,
    })
}

/// `run --intent` and `step` (LOOP-15): only `id`, regardless of order and cutoff, not of
/// skips: [`decide`] with every other open intent counted active. `Err`: why it isn't picked.
pub fn decide_for(
    listing: &Listing,
    state: &PickState,
    id: &str,
) -> (Decision, Result<(), String>) {
    let mut only = state.clone();
    // Asked for by name: parked or not (`run --intent`, `step`).
    only.cutoff = 1;
    only.active.extend(
        listing
            .open
            .iter()
            .filter(|i| i.id != id)
            .map(|i| i.id.clone()),
    );
    let mut d = decide(listing, &only);
    // Only its own wait is written: the others aren't looked at.
    d.writes.retain(|(w, _, _)| w == id);
    if d.pick.as_deref() == Some(id) {
        return (d, Ok(()));
    }
    if let Some((_, skip)) = d.skipped.iter().find(|(s, _)| s == id) {
        let why = skip.to_string();
        return (d, Err(why));
    }
    let why = match listing.open.iter().find(|i| i.id == id) {
        None => format!("no open intent matches {id}"),
        Some(_) if state.active.contains(id) => "it has a mission".to_string(),
        Some(i) => match (i.waiting(), i.stage()) {
            (Some(w), _) => format!("waiting: {w}"),
            (None, Some(s)) => format!("stage: {}", s.as_str()),
            (None, None) => {
                let done = listing.done_ids();
                let left: Vec<&str> = i
                    .after()
                    .iter()
                    .filter(|a| !done.contains(*a))
                    .map(String::as_str)
                    .collect();
                format!("after: {} not done", left.join(", "))
            }
        },
    };
    (d, Err(why))
}

/// A git failure: network or auth (`env::classify`) → `env_fail`; anything else (a
/// `[repos.<r>].path` that isn't a clone, a bad remote path) is no outage: a bug, counted.
fn git_failed(e: String) -> StepError {
    match env::classify(&e) {
        Some(_) => StepError::Env(Fault::Github, e),
        None => StepError::Bug(e),
    }
}

/// The pick after its fetch: load the repo files (REPO-1), make the checkout from the clone's
/// `origin/<base>` (LOOP-8) → `ok` with `base_sha` (shared with the evals' pick, PIP-33).
pub fn prepare(cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let git = cx.exes.git.clone();
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
        Err(RepoError::Git(e)) => return Err(git_failed(e)),
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

/// The `pick` stage: fetch Towercab's clone (LOOP-8), then [`prepare`] → `design`.
pub struct Pick;

impl Handler for Pick {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
        let git = cx.exes.git.clone();
        let auth = cx
            .identity
            .auth_for_url(&checkout::origin_url(&git, &repo))
            .map_err(|e| StepError::Env(Fault::Github, e.to_string()))?;
        checkout::ensure_clone(&git, &repo, Some(&auth)).map_err(git_failed)?;
        prepare(cx, m)
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!("{}: pick runs no child", m.label())))
    }
}
