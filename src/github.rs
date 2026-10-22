//! Who Towercab is on GitHub (LOOP-19) and its `gh` calls.
//!
//! So far `Identity::none()`: my own `gh` login, no token (loop-runner part 2). The GitHub App
//! (JWT, installation tokens, bot author) comes with part 5.

use std::ffi::OsStr;
use std::fmt;
use std::process::Command;

/// A failed `gh` or GitHub API call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhError {
    /// Network or auth: retried with backoff (LOOP-10).
    Env(String),
    /// GitHub answered no: the message is the reason.
    Failed(String),
}

impl fmt::Display for GhError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GhError::Env(m) | GhError::Failed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for GhError {}

/// Network and auth failures by their stderr (`env::classify`, LOOP-10).
pub fn is_env_failure(stderr: &str) -> bool {
    crate::env::classify(stderr).is_some()
}

/// The identity Towercab's own `gh` and `git` calls use.
#[derive(Debug, Default)]
pub struct Identity {
    _none: (),
}

impl Identity {
    /// My `gh` login, no token (until the App, part 5).
    pub fn none() -> Identity {
        Identity::default()
    }

    /// `gh <args>` for `github` → stdout; a non-zero exit → [`GhError`] by its stderr.
    pub fn gh(&mut self, gh: &OsStr, args: &[&str]) -> Result<String, GhError> {
        let out = Command::new(gh)
            .args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .output()
            .map_err(|e| GhError::Env(format!("{}: {e}", gh.to_string_lossy())))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            format!("gh {} failed", args.first().unwrap_or(&""))
        } else {
            err
        };
        Err(if is_env_failure(&err) {
            GhError::Env(err)
        } else {
            GhError::Failed(err)
        })
    }
}
