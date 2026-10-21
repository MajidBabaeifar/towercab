//! `towercab protect <repo>` (REPO-7): the `towercab` branch ruleset on a repo's base, set with
//! my own `gh` login (`gh` from `PATH` in my environment; Towercab adds no token).

use std::ffi::OsStr;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::config::Config;
use crate::intents::intent::is_repo;

/// The ruleset's name.
pub const NAME: &str = "towercab";

/// Towercab's own status on its PRs (PIP-33), required on the Towercab repo.
pub const EVALS: &str = "towercab/evals";

/// GitHub clone URLs: `https://[<user>@]github.com/<o>/<n>[.git]`,
/// `git@github.com:<o>/<n>[.git]`, `ssh://git@github.com/<o>/<n>[.git]`.
static GITHUB_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:https://(?:[^@/\s]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/\s]+)/([^/\s]+?)(?:\.git)?$",
    )
    .unwrap()
});

/// The repo `protect` sets the ruleset on.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    /// `<owner>/<name>`.
    pub github: String,
    /// The protected branch.
    pub base: String,
    /// The intent home: Towercab pushes to `main` directly (INT-10), so no PR rules.
    pub intent_home: bool,
}

impl Target {
    /// `repo` = a `[repos]` name (its `github`, `base`; [`Config::repo`]'s errors) or `intents`
    /// (the intent home: owner and name from `[intents].remote`, base `main`, `[repos]` not
    /// read); else `unknown repo <repo>`.
    pub fn resolve(config: &Config, repo: &str) -> Result<Target, String> {
        if repo == "intents" {
            // The URL may hold a token: never echoed.
            let github = config
                .intents
                .remote
                .as_deref()
                .and_then(github_repo)
                .ok_or("[intents].remote is not a GitHub repo URL")?;
            return Ok(Target {
                github,
                base: "main".into(),
                intent_home: true,
            });
        }
        let r = config.repo(repo)?;
        Ok(Target {
            github: r.github.clone(),
            base: r.base.clone(),
            intent_home: false,
        })
    }
}

/// `<owner>/<name>` of a GitHub clone URL.
pub fn github_repo(url: &str) -> Option<String> {
    let c = GITHUB_URL.captures(url)?;
    (is_repo(&c[1]) && is_repo(&c[2])).then(|| format!("{}/{}", &c[1], &c[2]))
}

/// The checks to require: `checks` deduplicated in order; on the Towercab repo
/// (`<owner>/towercab`) plus [`EVALS`] when there are any.
fn required_checks(target: &Target, checks: Option<&[String]>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in checks.unwrap_or_default() {
        if !out.contains(c) {
            out.push(c.clone());
        }
    }
    let towercab = target
        .github
        .split_once('/')
        .is_some_and(|(_, n)| n.eq_ignore_ascii_case("towercab"));
    if towercab && !out.is_empty() && !out.iter().any(|c| c == EVALS) {
        out.push(EVALS.into());
    }
    out
}

/// The ruleset payload: PR + required status checks (`checks`, if any) + no force push + no
/// deletion of `refs/heads/<base>`, no bypass; the intent home only the last two.
pub fn ruleset(target: &Target, checks: Option<&[String]>) -> Value {
    let mut rules = Vec::new();
    if !target.intent_home {
        rules.push(json!({
            "type": "pull_request",
            "parameters": {
                "required_approving_review_count": 0,
                "dismiss_stale_reviews_on_push": false,
                "require_code_owner_review": false,
                "require_last_push_approval": false,
                "required_review_thread_resolution": false,
            },
        }));
        let checks = required_checks(target, checks);
        if !checks.is_empty() {
            let contexts: Vec<Value> = checks.iter().map(|c| json!({ "context": c })).collect();
            rules.push(json!({
                "type": "required_status_checks",
                "parameters": {
                    "strict_required_status_checks_policy": false,
                    "required_status_checks": contexts,
                },
            }));
        }
    }
    rules.push(json!({ "type": "non_fast_forward" }));
    rules.push(json!({ "type": "deletion" }));
    json!({
        "name": NAME,
        "target": "branch",
        "enforcement": "active",
        "bypass_actors": [],
        "conditions": {
            "ref_name": {
                "include": [format!("refs/heads/{}", target.base)],
                "exclude": [],
            },
        },
        "rules": rules,
    })
}

/// `gh api <args>` (`path` is the endpoint, for errors) with `input` on stdin → its JSON.
/// Non-zero exit or not JSON → `gh api <path>: <stderr, or unexpected output>`.
fn gh_api(gh: &OsStr, args: &[&str], path: &str, input: Option<&str>) -> Result<Value, String> {
    let failed = |e: &str| format!("gh api {path}: {e}");
    let mut cmd = Command::new(gh);
    cmd.arg("api")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = cmd.spawn().map_err(|e| failed(&e.to_string()))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        // gh exiting before it reads is reported by its exit status below.
        let _ = stdin.write_all(input.as_bytes());
    }
    let out = child
        .wait_with_output()
        .map_err(|e| failed(&e.to_string()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(failed(&if err.is_empty() {
            format!("gh exited with {}", out.status)
        } else {
            err
        }));
    }
    serde_json::from_slice(&out.stdout).map_err(|_| failed("unexpected output"))
}

/// A GET.
fn gh_get(gh: &OsStr, path: &str) -> Result<Value, String> {
    gh_api(gh, &[path], path, None)
}

/// The id of `github`'s ruleset named `towercab`, if any (this repo's own, one page of 100).
pub fn find_ruleset(gh: &OsStr, github: &str) -> Result<Option<u64>, String> {
    let path = format!("repos/{github}/rulesets?includes_parents=false&per_page=100");
    let unexpected = || format!("gh api {path}: unexpected output");
    let list = gh_get(gh, &path)?;
    for r in list.as_array().ok_or_else(unexpected)? {
        if r.get("name").and_then(Value::as_str) == Some(NAME) {
            return r
                .get("id")
                .and_then(Value::as_u64)
                .map(Some)
                .ok_or_else(unexpected);
        }
    }
    Ok(None)
}

/// The job names (deduplicated, in order) of the last green `push` run on the base; `None`
/// without one. More jobs than one page (`total_count` > 100) → an error, never fewer checks.
pub fn last_green_checks(gh: &OsStr, target: &Target) -> Result<Option<Vec<String>>, String> {
    let github = &target.github;
    let path = format!(
        "repos/{github}/actions/runs?branch={}&event=push&status=success&per_page=1",
        target.base
    );
    let runs = gh_get(gh, &path)?;
    let unexpected = |path: &str| format!("gh api {path}: unexpected output");
    let runs = runs
        .get("workflow_runs")
        .and_then(Value::as_array)
        .ok_or_else(|| unexpected(&path))?;
    let Some(run) = runs.first() else {
        return Ok(None);
    };
    let id = run
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| unexpected(&path))?;
    let path = format!("repos/{github}/actions/runs/{id}/jobs?per_page=100");
    let jobs = gh_get(gh, &path)?;
    let list = jobs
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or_else(|| unexpected(&path))?;
    if jobs
        .get("total_count")
        .and_then(Value::as_u64)
        .is_some_and(|n| n > list.len() as u64)
    {
        return Err(format!("gh api {path}: more than 100 jobs"));
    }
    let mut names: Vec<String> = Vec::new();
    for job in list {
        let name = job
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| unexpected(&path))?;
        if !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    Ok((!names.is_empty()).then_some(names))
}

/// Creates or updates the `towercab` ruleset on `target` with `gh` → what it set
/// (**`protect` output**).
pub fn protect(target: &Target, gh: &OsStr) -> Result<String, String> {
    let github = &target.github;
    let existing = find_ruleset(gh, github)?;
    let checks = if target.intent_home {
        None
    } else {
        last_green_checks(gh, target)?
    };
    let payload = ruleset(target, checks.as_deref());
    let (method, path, done) = match existing {
        Some(id) => ("PUT", format!("repos/{github}/rulesets/{id}"), "updated"),
        None => ("POST", format!("repos/{github}/rulesets"), "created"),
    };
    let set = gh_api(
        gh,
        &["--method", method, &path, "--input", "-"],
        &path,
        Some(&payload.to_string()),
    )?;
    let id = set
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("gh api {path}: unexpected output"))?;
    let mut out = format!(
        "{github}: {done} ruleset {NAME} {id} on refs/heads/{}\nrules: {}",
        target.base,
        describe(&payload)
    );
    if !target.intent_home && checks.is_none() {
        out.push_str(&format!(
            "\nno green run on {}: no required status checks",
            target.base
        ));
    }
    Ok(out)
}

/// `pull_request, required_status_checks (<check>, …), non_fast_forward, deletion`.
fn describe(payload: &Value) -> String {
    let rules = payload["rules"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    rules
        .iter()
        .map(|r| {
            let kind = r["type"].as_str().unwrap_or_default();
            match r["parameters"]["required_status_checks"].as_array() {
                Some(checks) => {
                    let names: Vec<&str> = checks
                        .iter()
                        .filter_map(|c| c["context"].as_str())
                        .collect();
                    format!("{kind} ({})", names.join(", "))
                }
                None => kind.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}
