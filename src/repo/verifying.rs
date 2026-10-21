//! `CLAUDE.md` `## Verifying your work` (REPO-2, REPO-5).

use std::sync::LazyLock;

use regex::Regex;

use super::RepoError;
use super::markdown::{fences, items, lines, sections};

pub const SECTION: &str = "Verifying your work";

/// `http://localhost:<port>` or `http://127.0.0.1:<port>` with an optional `/<path>`.
static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^http://(?:localhost|127\.0\.0\.1):([0-9]{1,5})(?:/\S*)?$").unwrap()
});

/// How to verify work in the repo.
#[derive(Debug, Clone, PartialEq)]
pub struct Verifying {
    /// ` ```setup `: one command per line, with network, after each clone and before checks.
    pub setup: Vec<String>,
    /// ` ```checks `: one command per line, in order, sandboxed, no network. Never empty.
    pub checks: Vec<String>,
    /// ` ```run `: opts the repo into the verifier (PIP-32).
    pub run: Option<Run>,
}

/// ` ```run `: the app's start command and where it answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub command: String,
    pub url: String,
    pub port: u16,
    pub ui: bool,
}

impl Verifying {
    /// `CLAUDE.md`'s text → its verifying block. No section or no non-empty ` ```checks ` →
    /// `NoVerifyingBlock`; a malformed file → `Invalid("CLAUDE.md: …")`.
    pub fn parse(text: &str) -> Result<Verifying, RepoError> {
        let invalid = |e: String| RepoError::Invalid(format!("CLAUDE.md: {e}"));
        let items = items(&lines(text), 1).map_err(invalid)?;
        let [Some(section)] = sections(&items, [SECTION]).map_err(invalid)? else {
            return Err(RepoError::NoVerifyingBlock);
        };
        let [setup, checks, run] = fences(section, ["setup", "checks", "run"]).map_err(invalid)?;
        let run = run
            .map(|f| parse_run(&f.body))
            .transpose()
            .map_err(invalid)?;
        let checks = checks.ok_or(RepoError::NoVerifyingBlock)?;
        let owned = |body: &[&str]| body.iter().map(|l| l.to_string()).collect();
        Ok(Verifying {
            setup: setup.map(|f| owned(&f.body)).unwrap_or_default(),
            checks: owned(&checks.body),
            run,
        })
    }
}

/// ` ```run ` lines: `url:` and `ui:` at most once each, exactly one start command.
fn parse_run(body: &[&str]) -> Result<Run, String> {
    let (mut url, mut ui, mut commands) = (None, None, Vec::new());
    for line in body {
        if let Some(v) = line.strip_prefix("url:") {
            if url.replace(v.trim()).is_some() {
                return Err("run: url twice".into());
            }
        } else if let Some(v) = line.strip_prefix("ui:") {
            let v = match v.trim() {
                "true" => true,
                "false" => false,
                _ => return Err("run: ui must be true or false".into()),
            };
            if ui.replace(v).is_some() {
                return Err("run: ui twice".into());
            }
        } else {
            commands.push(*line);
        }
    }
    let command = match commands[..] {
        [c] => c.to_string(),
        [] => return Err("run: start command missing".into()),
        _ => return Err(format!("run: one start command, got {}", commands.len())),
    };
    let bad_url = || "run: url must be http://localhost:<port>".to_string();
    let url = url.ok_or_else(bad_url)?;
    let port = URL
        .captures(url)
        .and_then(|c| c[1].parse::<u16>().ok())
        .filter(|p| *p > 0)
        .ok_or_else(bad_url)?;
    Ok(Run {
        command,
        url: url.to_string(),
        port,
        ui: ui.unwrap_or(false),
    })
}
