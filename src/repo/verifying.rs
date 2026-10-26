//! `CLAUDE.md` `## Verifying your work` (REPO-2, REPO-5).

use std::sync::LazyLock;

use regex::Regex;

use super::RepoError;
use super::markdown::{Item, fences, items, lines, sections};

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
    /// ` ```fast `: the subset run before publish when the repo has CI (REPO-9); `{tests}` and
    /// `{stems}` in a line stand for the touched tests. Empty block: `Some` of none.
    pub fast: Option<Vec<String>>,
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
        let [setup, checks, fast, run] =
            fences(section, ["setup", "checks", "fast", "run"]).map_err(invalid)?;
        let run = run
            .map(|f| parse_run(&f.body))
            .transpose()
            .map_err(invalid)?;
        let checks = checks.ok_or(RepoError::NoVerifyingBlock)?;
        let owned = |body: &[&str]| -> Vec<String> { body.iter().map(|l| l.to_string()).collect() };
        // An empty ```fast block is a block (no local checks); `fences` skips empty ones.
        let empty_fast = section
            .iter()
            .any(|i| matches!(i, Item::Fence(f) if f.name == "fast"));
        Ok(Verifying {
            setup: setup.map(|f| owned(&f.body)).unwrap_or_default(),
            checks: owned(&checks.body),
            fast: fast
                .map(|f| owned(&f.body))
                .or_else(|| empty_fast.then(Vec::new)),
            run,
        })
    }

    /// What the worker may run (PIP-24): the setup lines, then the [`run_set`]'s commands up to
    /// their first placeholder or `$(`: the full checks, or with CI and a ` ```fast ` block
    /// those lines' static prefixes (a line that starts with one is left out).
    pub fn allowed(&self, ci: bool) -> Vec<String> {
        let mut v = self.setup.clone();
        match self.fast.as_ref().filter(|_| ci) {
            None => v.extend(self.checks.iter().cloned()),
            Some(fast) => v.extend(
                fast.iter()
                    .map(|l| static_prefix(l).to_string())
                    .filter(|p| !p.is_empty()),
            ),
        }
        v
    }
}

/// The lines to run before publish (REPO-9): without CI, or without a ` ```fast ` block, the
/// ` ```checks `; else the ` ```fast ` lines in order, with `{tests}` (the touched test files,
/// `changed_tests`) and `{stems}` (their names without directory or extension; none for a
/// file below a subdirectory of `tests/`: a helper, not a test target) replaced, space-separated
/// and shell-quoted. A line whose placeholder has nothing to stand for is left out, never run bare.
pub fn run_set(v: &Verifying, ci: bool, changed_tests: &[String]) -> Vec<String> {
    let Some(fast) = v.fast.as_ref().filter(|_| ci) else {
        return v.checks.clone();
    };
    let tests = join_quoted(changed_tests.iter().map(String::as_str));
    let mut stems: Vec<String> = Vec::new();
    for t in changed_tests {
        if let Some(s) = stem(t)
            && !stems.contains(&s)
        {
            stems.push(s);
        }
    }
    let stems = join_quoted(stems.iter().map(String::as_str));
    fast.iter()
        .filter(|l| !(l.contains("{tests}") && tests.is_empty()))
        .filter(|l| !(l.contains("{stems}") && stems.is_empty()))
        .map(|l| l.replace("{tests}", &tests).replace("{stems}", &stems))
        .collect()
}

/// `line` up to its first `{` or `$(`, trimmed.
fn static_prefix(line: &str) -> &str {
    let end = ["{", "$("]
        .iter()
        .filter_map(|p| line.find(p))
        .min()
        .unwrap_or(line.len());
    line[..end].trim()
}

/// The file name of a test path without its last extension; none for a file below a
/// subdirectory of a `tests` directory.
fn stem(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let (name, dirs) = parts.split_last()?;
    if dirs
        .iter()
        .position(|d| *d == "tests")
        .is_some_and(|i| i + 1 != dirs.len())
    {
        return None;
    }
    let stem = name.rsplit_once('.').map_or(*name, |(s, _)| s);
    (!stem.is_empty()).then(|| stem.to_string())
}

/// The words shell-quoted where needed, joined with a space.
fn join_quoted<'a>(words: impl Iterator<Item = &'a str>) -> String {
    let quote = |w: &str| {
        let plain = !w.is_empty()
            && w.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_./@%+=:,-".contains(c));
        if plain {
            w.to_string()
        } else {
            format!("'{}'", w.replace('\'', "'\\''"))
        }
    };
    words.map(quote).collect::<Vec<_>>().join(" ")
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
