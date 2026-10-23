//! `ops/bands.yaml` (MNT-1): the bands the loop watches, read from Towercab's clone.

use std::sync::LazyLock;

use regex::Regex;
use yaml_rust2::{Yaml, YamlLoader};

use crate::checkout;
use crate::config::Config;
use crate::exes::Exes;
use crate::intents::intent::is_repo;
use crate::metrics::Metric;

/// The file, in the Towercab repo.
pub const PATH: &str = "ops/bands.yaml";

/// Points a band's baseline must hold: [`super::detect::RECENT`] judged plus
/// [`super::detect::MIN_BASELINE`] to judge them by.
pub const MIN_POINTS: u64 = 22;

/// Which side of the mean breaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    High,
    Low,
    Both,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::High => "high",
            Side::Low => "low",
            Side::Both => "both",
        }
    }
}

/// A Western Electric tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    One,
    Two,
    Three,
}

impl Tier {
    pub const ALL: [Tier; 3] = [Tier::One, Tier::Two, Tier::Three];

    /// `1sigma`, `2sigma`, `3sigma`.
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::One => "1sigma",
            Tier::Two => "2sigma",
            Tier::Three => "3sigma",
        }
    }

    /// `1σ`, `2σ`, `3σ` (messages).
    pub fn sigma(self) -> &'static str {
        match self {
            Tier::One => "1σ",
            Tier::Two => "2σ",
            Tier::Three => "3σ",
        }
    }

    pub fn parse(s: &str) -> Option<Tier> {
        Tier::ALL.into_iter().find(|t| t.as_str() == s)
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// What a tier does (MNT-4..6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Log,
    Diagnose,
    Propose {
        pull_request: bool,
        cap_repo: bool,
        pause: bool,
    },
}

impl Action {
    /// A draft intent PR: `diagnose`, or `propose` with `pull_request`.
    pub fn drafts(self) -> bool {
        matches!(
            self,
            Action::Diagnose
                | Action::Propose {
                    pull_request: true,
                    ..
                }
        )
    }
}

/// The playbook's tiers: log, diagnose, propose with `[pull_request]`.
pub const PLAYBOOK: [Action; 3] = [
    Action::Log,
    Action::Diagnose,
    Action::Propose {
        pull_request: true,
        cap_repo: false,
        pause: false,
    },
];

/// One band.
#[derive(Debug, Clone, PartialEq)]
pub struct Band {
    pub name: String,
    /// A **Names** name without `towercab.`.
    pub metric: String,
    pub query: String,
    /// Seconds.
    pub period: u64,
    /// Seconds.
    pub baseline: u64,
    pub side: Side,
    /// The least shift from the mean (absolute units) any rule counts; 0 by default.
    pub min_shift: f64,
    pub repo: Option<String>,
    /// By tier: 1σ, 2σ, 3σ.
    pub tiers: [Action; 3],
}

impl Band {
    /// Points in the baseline window.
    pub fn points(&self) -> u64 {
        self.baseline / self.period
    }

    /// The last completed period's end at `now` (unix s), [`super::GRACE`] after it.
    pub fn end(&self, now: f64) -> f64 {
        let p = self.period as f64;
        ((now - super::GRACE) / p).floor() * p
    }

    pub fn action(&self, t: Tier) -> Action {
        self.tiers[t.index()]
    }
}

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9_]+$").expect("name regex"));
static PERIOD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([1-9][0-9]{0,3})([hdw])$").expect("period regex"));
static BASELINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^rolling_([1-9][0-9]{0,3})d$").expect("baseline regex"));

const KEYS: [&str; 9] = [
    "metric",
    "query",
    "period",
    "baseline",
    "rules",
    "side",
    "min_shift",
    "repo",
    "tiers",
];

fn period_secs(s: &str) -> Option<u64> {
    let c = PERIOD.captures(s)?;
    let n: u64 = c[1].parse().ok()?;
    Some(
        n * match &c[2] {
            "h" => 3600,
            "d" => 86_400,
            _ => 7 * 86_400,
        },
    )
}

fn text(y: &Yaml) -> Option<String> {
    match y {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(n) => Some(n.to_string()),
        _ => None,
    }
}

fn action(y: &Yaml) -> Result<Action, String> {
    let Yaml::Hash(h) = y else {
        return Err("a tier is a map {action, routes}".into());
    };
    for k in h.keys() {
        match k.as_str() {
            Some("action" | "routes") => {}
            _ => return Err(format!("unknown tier key {}", shown(k))),
        }
    }
    let get = |k: &str| h.get(&Yaml::String(k.into()));
    let routes = match get("routes") {
        None => None,
        Some(Yaml::Array(a)) => Some(
            a.iter()
                .map(|r| text(r).ok_or_else(|| "routes are strings".to_string()))
                .collect::<Result<Vec<String>, String>>()?,
        ),
        Some(_) => return Err("routes is a list".into()),
    };
    let a = match get("action").and_then(text).as_deref() {
        Some("log") => Action::Log,
        Some("diagnose") => Action::Diagnose,
        Some("propose") => {
            let routes = routes
                .clone()
                .unwrap_or_else(|| vec!["pull_request".into()]);
            let mut p = (false, false, false);
            for r in &routes {
                match r.as_str() {
                    "pull_request" => p.0 = true,
                    "runbook:cap_repo" => p.1 = true,
                    "runbook:pause" => p.2 = true,
                    other => return Err(format!("unknown route {other}")),
                }
            }
            return Ok(Action::Propose {
                pull_request: p.0,
                cap_repo: p.1,
                pause: p.2,
            });
        }
        Some(other) => return Err(format!("unknown action {other}")),
        None => return Err("a tier needs an action".into()),
    };
    if routes.is_some() {
        return Err("routes only with action: propose".into());
    }
    Ok(a)
}

fn shown(y: &Yaml) -> String {
    match y {
        Yaml::Real(r) => r.clone(),
        _ => text(y).unwrap_or_else(|| format!("{y:?}")),
    }
}

fn band(name: &str, y: &Yaml) -> Result<Band, String> {
    if !NAME.is_match(name) {
        return Err("a band name is [a-z0-9_]+".into());
    }
    let Yaml::Hash(h) = y else {
        return Err("a band is a map".into());
    };
    for k in h.keys() {
        match k.as_str() {
            Some(k) if KEYS.contains(&k) => {}
            _ => return Err(format!("unknown key {}", shown(k))),
        }
    }
    let get = |k: &str| h.get(&Yaml::String(k.into()));
    let string = |k: &str| -> Result<Option<String>, String> {
        match get(k) {
            None => Ok(None),
            Some(v) => text(v)
                .map(|s| Some(s.trim().to_string()))
                .ok_or_else(|| format!("{k} is a string")),
        }
    };
    let metric = string("metric")?.ok_or("metric is required")?;
    if Metric::by_name(&format!("towercab.{metric}")).is_none() {
        return Err(format!("metric {metric} isn't one of metrics::METRICS"));
    }
    let query = string("query")?.ok_or("query is required")?;
    if query.is_empty() {
        return Err("query is empty".into());
    }
    let period = match string("period")? {
        None => 86_400,
        Some(p) => period_secs(&p).ok_or_else(|| format!("period {p}: <n>h, <n>d or <n>w"))?,
    };
    let baseline = match string("baseline")? {
        None => 30 * 86_400,
        Some(b) => {
            let c = BASELINE
                .captures(&b)
                .ok_or_else(|| format!("baseline {b}: rolling_<n>d"))?;
            c[1].parse::<u64>().unwrap_or_default() * 86_400
        }
    };
    if baseline / period < MIN_POINTS {
        return Err(format!(
            "baseline holds {} periods, fewer than {MIN_POINTS}",
            baseline / period
        ));
    }
    match string("rules")?.as_deref() {
        None | Some("western_electric") => {}
        Some(r) => return Err(format!("rules {r}: only western_electric")),
    }
    let side = match string("side")?.as_deref() {
        None | Some("both") => Side::Both,
        Some("high") => Side::High,
        Some("low") => Side::Low,
        Some(s) => return Err(format!("side {s}: high, low or both")),
    };
    let min_shift = match get("min_shift") {
        None => 0.0,
        Some(y) => match y {
            Yaml::Integer(n) => Some(*n as f64),
            Yaml::Real(r) => r.parse::<f64>().ok(),
            _ => None,
        }
        .filter(|x| x.is_finite() && *x >= 0.0)
        .ok_or_else(|| format!("min_shift {}: a number ≥ 0", shown(y)))?,
    };
    let repo = string("repo")?;
    if let Some(r) = &repo
        && !is_repo(r)
    {
        return Err(format!("repo {r} isn't a repo name"));
    }
    let mut tiers = PLAYBOOK;
    match get("tiers") {
        None => {}
        Some(Yaml::Hash(t)) => {
            for (k, v) in t {
                let tier = k
                    .as_str()
                    .and_then(Tier::parse)
                    .ok_or_else(|| format!("unknown tier {}", shown(k)))?;
                tiers[tier.index()] = action(v).map_err(|e| format!("{}: {e}", tier.as_str()))?;
            }
        }
        Some(_) => return Err("tiers is a map".into()),
    }
    Ok(Band {
        name: name.to_string(),
        metric,
        query,
        period,
        baseline,
        side,
        min_shift,
        repo,
        tiers,
    })
}

/// `bands.yaml` → its bands, in file order; any error → `ops/bands.yaml: [<band>: ]<reason>`.
pub fn parse(yaml: &str) -> Result<Vec<Band>, String> {
    let err = |e: String| format!("{PATH}: {e}");
    let docs = YamlLoader::load_from_str(yaml).map_err(|e| err(e.to_string()))?;
    let root = match docs.as_slice() {
        [] => return Ok(Vec::new()),
        [d] => d,
        _ => return Err(err("one YAML document".into())),
    };
    let Yaml::Hash(top) = root else {
        return Err(err("a map with bands".into()));
    };
    for k in top.keys() {
        if k.as_str() != Some("bands") {
            return Err(err(format!("unknown key {}", shown(k))));
        }
    }
    match top.get(&Yaml::String("bands".into())) {
        None | Some(Yaml::Null) => Ok(Vec::new()),
        Some(Yaml::Hash(h)) => h
            .iter()
            .map(|(k, v)| {
                let name = text(k).ok_or_else(|| err("a band name is a string".into()))?;
                band(&name, v).map_err(|e| err(format!("{name}: {e}")))
            })
            .collect(),
        Some(_) => Err(err("bands is a map".into())),
    }
}

/// The bands on the Towercab repo's base in its clone (`evals::towercab_repo`): `None` without
/// that repo or its clone; no file there → none; `Err` when it doesn't parse.
pub fn read(config: &Config, exes: &Exes) -> Result<Option<Vec<Band>>, String> {
    let Some(repo) = crate::pipeline::evals::towercab_repo(config) else {
        return Ok(None);
    };
    if !checkout::valid(&exes.git, &repo.path) {
        return Ok(None);
    }
    let spec = format!("refs/remotes/origin/{}:{PATH}", repo.base);
    match checkout::git(&exes.git, &repo.path, &["show", &spec], None) {
        Ok(text) => parse(&text).map(Some),
        Err(_) => Ok(Some(Vec::new())),
    }
}
