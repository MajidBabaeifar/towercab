//! `TOWERCAB.md`: what has no playbook home (REPO-1, REPO-3): front matter `max_autonomy`,
//! `protected`, `tests`; ` ```live `, ` ```release `, ` ```rollback ` blocks.

use std::sync::LazyLock;

use regex::Regex;
use yaml_rust2::{Yaml, YamlLoader};

use super::markdown::{Fence, Item, fences, items, key_lines, lines};
use super::protected::glob;

/// PIP-30's test globs, when `tests` is absent or empty.
pub const DEFAULT_TESTS: [&str; 7] = [
    "tests/**",
    "test/**",
    "**/__tests__/**",
    "**/*_test.*",
    "**/test_*.*",
    "**/*.test.*",
    "**/*.spec.*",
];

/// Minutes to wait for a deploy to show the sha, when `timeout` is absent.
pub const DEFAULT_TIMEOUT_MIN: u32 = 15;

const KEYS: [&str; 3] = ["max_autonomy", "protected", "tests"];

static KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]|$)").unwrap());

static HTTP_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://\S+$").unwrap());

/// Where a deploy shows the sha (PIP-8).
#[derive(Debug, Clone, PartialEq)]
pub enum Deploy {
    /// `env:<name>`: a GitHub deployment environment.
    Env(String),
    /// `url:<http(s) URL>`: its body shows the deployed sha.
    Url(String),
}

/// ` ```live `: the repo deploys on merge (PIP-8, PIP-9).
#[derive(Debug, Clone, PartialEq)]
pub struct Live {
    pub deploy: Deploy,
    pub timeout_min: u32,
    pub e2e: String,
}

/// ` ```release `: the production gate (PIP-34).
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub command: String,
    pub deploy: Deploy,
    pub timeout_min: u32,
    pub e2e: Option<String>,
}

/// ` ```rollback `: restore a sha, and its rehearsal (PIP-35).
#[derive(Debug, Clone, PartialEq)]
pub struct Rollback {
    pub command: String,
    pub rehearse: String,
}

/// `TOWERCAB.md`, read from the base branch.
#[derive(Debug, Clone, PartialEq)]
pub struct Towercab {
    /// Repo cap on autonomy, 1-5 (AUT-8).
    pub max_autonomy: u8,
    /// Globs the worker can't write (REPO-8), as written.
    pub protected: Vec<String>,
    /// Test file globs (PIP-30), as written.
    pub tests: Vec<String>,
    pub live: Option<Live>,
    pub release: Option<Release>,
    pub rollback: Option<Rollback>,
}

impl Default for Towercab {
    /// No `TOWERCAB.md`.
    fn default() -> Towercab {
        Towercab {
            max_autonomy: 5,
            protected: Vec::new(),
            tests: DEFAULT_TESTS.iter().map(|s| s.to_string()).collect(),
            live: None,
            release: None,
            rollback: None,
        }
    }
}

impl Towercab {
    /// `TOWERCAB.md`'s text → its settings; errors read `TOWERCAB.md: <where>: <what>`.
    pub fn parse(file: &str) -> Result<Towercab, String> {
        Self::read(file).map_err(|e| format!("TOWERCAB.md: {e}"))
    }

    fn read(file: &str) -> Result<Towercab, String> {
        let lines = lines(file);
        let mut t = Towercab::default();
        let mut rest = 0;
        // Front matter: from the first non-blank line, if it trims to `---`, to the next one.
        if let Some(open) = lines.iter().position(|l| !l.trim().is_empty())
            && lines[open].trim() == "---"
        {
            let body = open + 1;
            let close = lines[body..]
                .iter()
                .position(|l| l.trim() == "---")
                .ok_or("front matter: no closing ---")?;
            front_matter(&lines[body..body + close], &mut t)
                .map_err(|e| format!("front matter: {e}"))?;
            rest = body + close + 1;
        }
        let items = items(&lines[rest..], rest + 1)?;
        // A misplaced front matter is an error, never the defaults.
        for item in &items {
            if let Item::Line(n, line) = item
                && let Some(key) = KEYS.iter().find(|k| {
                    line.strip_prefix(**k)
                        .is_some_and(|r| r.trim_start().starts_with(':'))
                })
            {
                return Err(format!("line {n}: {key} outside front matter"));
            }
        }
        let [live, release, rollback] = fences(&items, ["live", "release", "rollback"])?;
        t.live = live.map(parse_live).transpose()?;
        t.release = release.map(parse_release).transpose()?;
        t.rollback = rollback.map(parse_rollback).transpose()?;
        Ok(t)
    }
}

/// The front matter's lines → `max_autonomy`, `protected`, `tests` into `t`.
fn front_matter(lines: &[&str], t: &mut Towercab) -> Result<(), String> {
    let mut seen: Vec<&str> = Vec::new();
    for line in lines {
        if let Some(key) = KEY.captures(line).and_then(|c| c.get(1)) {
            let key = key.as_str();
            if seen.contains(&key) {
                return Err(format!("{key} twice"));
            }
            seen.push(key);
        }
    }
    let docs = YamlLoader::load_from_str(&lines.join("\n")).map_err(|e| e.to_string())?;
    let map = match docs.first() {
        None | Some(Yaml::Null) => return Ok(()),
        Some(Yaml::Hash(h)) => h,
        Some(_) => return Err("not a mapping".into()),
    };
    for (k, v) in map {
        let key = match k {
            Yaml::String(s) if KEYS.contains(&s.as_str()) => s.as_str(),
            Yaml::String(s) => return Err(format!("unknown key {s}")),
            Yaml::Integer(n) => return Err(format!("unknown key {n}")),
            Yaml::Real(s) => return Err(format!("unknown key {s}")),
            Yaml::Boolean(b) => return Err(format!("unknown key {b}")),
            _ => return Err("unknown key (not a string)".into()),
        };
        match key {
            "max_autonomy" => {
                t.max_autonomy = match v {
                    Yaml::Integer(n) if (1..=5).contains(n) => *n as u8,
                    _ => return Err("max_autonomy must be an integer 1-5".into()),
                }
            }
            _ => {
                let globs = globs(key, v)?;
                if key == "protected" {
                    t.protected = globs;
                } else if !globs.is_empty() {
                    t.tests = globs;
                }
            }
        }
    }
    Ok(())
}

/// A list of globs or one glob string; null → none. Each checked with [`glob`].
fn globs(key: &str, v: &Yaml) -> Result<Vec<String>, String> {
    let list = match v {
        Yaml::Null => Vec::new(),
        Yaml::String(s) => vec![s.clone()],
        Yaml::Array(items) => items
            .iter()
            .map(|i| match i {
                Yaml::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect::<Option<_>>()
            .ok_or_else(|| format!("{key} must be a list of globs"))?,
        _ => return Err(format!("{key} must be a list of globs")),
    };
    for g in &list {
        glob(g).map_err(|e| format!("{key}: {e}"))?;
    }
    Ok(list)
}

/// `env:<name>` or `url:<http(s) URL>`, spaces after the `:` allowed.
fn deploy(block: &str, v: &str) -> Result<Deploy, String> {
    let bad = || format!("{block}: deploy must be env:<name> or url:<http(s) URL>");
    if let Some(env) = v.strip_prefix("env:").map(str::trim) {
        if env.is_empty() || env.contains(char::is_whitespace) {
            return Err(bad());
        }
        return Ok(Deploy::Env(env.to_string()));
    }
    if let Some(url) = v.strip_prefix("url:").map(str::trim)
        && HTTP_URL.is_match(url)
    {
        return Ok(Deploy::Url(url.to_string()));
    }
    Err(bad())
}

/// `timeout`: minutes 1-1440, default 15.
fn timeout(block: &str, v: Option<&str>) -> Result<u32, String> {
    match v {
        None => Ok(DEFAULT_TIMEOUT_MIN),
        Some(v) => v
            .parse()
            .ok()
            .filter(|m| (1..=1440).contains(m))
            .ok_or_else(|| format!("{block}: timeout must be minutes 1-1440")),
    }
}

fn required<'a>(block: &str, key: &str, v: Option<&'a str>) -> Result<&'a str, String> {
    v.ok_or_else(|| format!("{block}: {key} is required"))
}

fn parse_live(f: &Fence) -> Result<Live, String> {
    let [d, t, e] = key_lines(f, ["deploy", "timeout", "e2e"])?;
    Ok(Live {
        deploy: deploy("live", required("live", "deploy", d)?)?,
        timeout_min: timeout("live", t)?,
        e2e: required("live", "e2e", e)?.to_string(),
    })
}

fn parse_release(f: &Fence) -> Result<Release, String> {
    let [c, d, t, e] = key_lines(f, ["command", "deploy", "timeout", "e2e"])?;
    Ok(Release {
        command: required("release", "command", c)?.to_string(),
        deploy: deploy("release", required("release", "deploy", d)?)?,
        timeout_min: timeout("release", t)?,
        e2e: e.map(str::to_string),
    })
}

fn parse_rollback(f: &Fence) -> Result<Rollback, String> {
    let [c, r] = key_lines(f, ["command", "rehearse"])?;
    Ok(Rollback {
        command: required("rollback", "command", c)?.to_string(),
        rehearse: required("rollback", "rehearse", r)?.to_string(),
    })
}
