//! `~/.config/towercab/config.toml`: only what the intent store needs for now (INT-1).
//! The loop intent adds the other sections (LOOP-1).

use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// The file this was read from.
    pub file: PathBuf,
    pub intents: IntentsConfig,
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
        Ok(Config {
            file,
            intents: IntentsConfig {
                remote,
                path,
                cutoff,
            },
        })
    }
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
