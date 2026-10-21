//! `~/.config/towercab/config.toml`: `[intents]` (INT-1) and `[repos.<name>]` (the slice of
//! LOOP-1 that `repo::load` and `protect` need, REPO-7). The loop intent adds the rest.
//!
//! A bad `[repos.<name>]` fails only what uses that repo ([`Config::repo`]): the Python
//! version's `[repos.<name>]` (no `github`) shares this file, and `add`, `migrate` and
//! `protect intents` never look at `[repos]`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::intents::intent::is_repo;

/// Where the intent home lives and how parked works.
#[derive(Debug, Clone, PartialEq)]
pub struct IntentsConfig {
    /// Clone URL of the `intents` repo; cloned into `path` when that is missing.
    pub remote: Option<String>,
    /// Towercab's own checkout (`~/` expanded).
    pub path: PathBuf,
    /// Priority below this is parked (PRI-5), 1-15.
    pub cutoff: u8,
}

/// A target repo, `[repos.<name>]` (LOOP-1).
#[derive(Debug, Clone, PartialEq)]
pub struct RepoConfig {
    /// The table's name: what `intent.md`'s `repo:` names.
    pub name: String,
    /// `<owner>/<name>` on GitHub.
    pub github: String,
    /// My checkout (`~/` expanded).
    pub path: PathBuf,
    /// The branch PRs go to (default `main`).
    pub base: String,
    /// Unfinished missions at a time (1-255, default 1).
    pub workers: u8,
    /// Extra worker Bash patterns (PIP-24).
    pub bash: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// The file this was read from.
    pub file: PathBuf,
    pub intents: IntentsConfig,
    /// `[repos.<name>]` by name, or why the table is bad (`config: <file>: repos.<name>…`);
    /// read through [`Config::repo`].
    pub repos: BTreeMap<String, Result<RepoConfig, String>>,
}

pub const DEFAULT_INTENTS_PATH: &str = "~/.local/share/towercab/intents";
pub const DEFAULT_CUTOFF: u8 = 7;

impl Config {
    /// Reads `--config` (`file`), else `TOWERCAB_CONFIG`, else `~/.config/towercab/config.toml`.
    /// Errors read `config: <file>: <key or TOML error>`.
    pub fn load(file: Option<&Path>) -> Result<Config, String> {
        let file = match file {
            Some(f) => expand(&f.to_string_lossy())?,
            None => match std::env::var_os("TOWERCAB_CONFIG") {
                Some(f) if !f.is_empty() => expand(&f.to_string_lossy())?,
                _ => expand("~/.config/towercab/config.toml")?,
            },
        };
        let shown = file.display().to_string();
        let err = |what: &str| format!("config: {shown}: {what}");
        let text = std::fs::read_to_string(&file).map_err(|e| err(&e.to_string()))?;
        let table: toml::Table = text
            .parse()
            .map_err(|e: toml::de::Error| err(e.message().trim()))?;
        let (name, section) = match (table.get("intents"), table.get("tasks")) {
            (Some(s), _) => ("intents", s),
            (None, Some(s)) => ("tasks", s),
            (None, None) => return Err(err("[intents] is missing")),
        };
        let section = section
            .as_table()
            .ok_or_else(|| err(&format!("{name} must be a table")))?;
        let string = |key: &str| -> Result<Option<String>, String> {
            match section.get(key) {
                None => Ok(None),
                Some(toml::Value::String(s)) => Ok(Some(s.clone())),
                Some(_) => Err(err(&format!("{name}.{key} must be a string"))),
            }
        };
        let remote = string("remote")?;
        let path = string("path")?;
        if remote.is_none() && path.is_none() {
            return Err(err(&format!("{name}.remote or {name}.path is required")));
        }
        let path = expand(path.as_deref().unwrap_or(DEFAULT_INTENTS_PATH))
            .map_err(|e| err(&format!("{name}.path: {e}")))?;
        let cutoff = match section.get("cutoff") {
            None => DEFAULT_CUTOFF,
            Some(toml::Value::Integer(n)) if (1..=15).contains(n) => *n as u8,
            Some(_) => return Err(err(&format!("{name}.cutoff must be an integer 1-15"))),
        };
        let repos = match table.get("repos") {
            None => BTreeMap::new(),
            Some(toml::Value::Table(t)) => t
                .iter()
                .map(|(name, v)| (name.clone(), repo(name, v).map_err(|e| err(&e))))
                .collect(),
            Some(_) => return Err(err("repos must be a table")),
        };
        Ok(Config {
            file,
            intents: IntentsConfig {
                remote,
                path,
                cutoff,
            },
            repos,
        })
    }

    /// `[repos.<name>]`: absent → `unknown repo <name>`; a bad table → its error.
    pub fn repo(&self, name: &str) -> Result<&RepoConfig, String> {
        match self.repos.get(name) {
            None => Err(format!("unknown repo {name}")),
            Some(r) => r.as_ref().map_err(Clone::clone),
        }
    }
}

/// A branch name Towercab accepts as `base` (within `git check-ref-format --branch`):
/// `[A-Za-z0-9._/-]+`, not `HEAD`, not starting with `-` or ending with `.`, no `..`; each
/// `/`-separated component non-empty, not starting with `.` or ending with `.lock`.
pub fn is_branch(s: &str) -> bool {
    s != "HEAD"
        && !s.starts_with('-')
        && !s.ends_with('.')
        && !s.contains("..")
        && s.split('/')
            .all(|c| !c.is_empty() && !c.starts_with('.') && !c.ends_with(".lock"))
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

/// `<owner>/<name>`, each a repo name.
pub fn is_github(s: &str) -> bool {
    s.split_once('/')
        .is_some_and(|(o, n)| is_repo(o) && is_repo(n))
}

/// `[repos.<name>]`; errors read `repos.<name>[.<key>] …` (a bad name shown as a quoted TOML
/// key). Other keys are ignored (the Python version's `verify`, `remote`).
fn repo(name: &str, value: &toml::Value) -> Result<RepoConfig, String> {
    if !is_repo(name) {
        return Err(format!(
            "repos.{name:?} is not a repo name ([A-Za-z0-9._-], no leading -)"
        ));
    }
    let at = format!("repos.{name}");
    if name == "intents" {
        return Err(format!(
            "{at} is reserved: `protect intents` is the intent home"
        ));
    }
    let t = value
        .as_table()
        .ok_or_else(|| format!("{at} must be a table"))?;
    let string = |key: &str| -> Result<Option<&str>, String> {
        match t.get(key) {
            None => Ok(None),
            Some(toml::Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(format!("{at}.{key} must be a string")),
        }
    };
    let github = string("github")?.ok_or_else(|| format!("{at}.github is required"))?;
    if !is_github(github) {
        return Err(format!("{at}.github must be \"<owner>/<name>\""));
    }
    let path = string("path")?.ok_or_else(|| format!("{at}.path is required"))?;
    if path.is_empty() {
        return Err(format!("{at}.path is empty"));
    }
    let path = expand(path).map_err(|e| format!("{at}.path: {e}"))?;
    if !path.is_absolute() {
        return Err(format!("{at}.path must be absolute or start with ~/"));
    }
    let base = string("base")?.unwrap_or("main");
    if !is_branch(base) {
        return Err(format!("{at}.base must be a branch name ([A-Za-z0-9._/-])"));
    }
    let workers = match t.get("workers") {
        None => 1,
        Some(toml::Value::Integer(n)) if (1..=255).contains(n) => *n as u8,
        Some(_) => return Err(format!("{at}.workers must be an integer 1-255")),
    };
    let bash = match t.get("bash") {
        None => Vec::new(),
        Some(toml::Value::Array(items)) => items
            .iter()
            .map(|i| match i {
                toml::Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("{at}.bash must be a list of non-empty strings"))?,
        Some(_) => return Err(format!("{at}.bash must be a list of non-empty strings")),
    };
    Ok(RepoConfig {
        name: name.to_string(),
        github: github.to_string(),
        path,
        base: base.to_string(),
        workers,
        bash,
    })
}

/// `~` and `~/…` → `$HOME/…`; anything else unchanged.
pub fn expand(path: &str) -> Result<PathBuf, String> {
    if path == "~" || path.starts_with("~/") {
        let home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .ok_or("HOME is not set")?;
        let mut out = PathBuf::from(home);
        if let Some(rest) = path.strip_prefix("~/") {
            out.push(rest);
        }
        Ok(out)
    } else {
        Ok(PathBuf::from(path))
    }
}
