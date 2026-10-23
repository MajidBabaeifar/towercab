//! The pipeline's `gh` calls (pipeline.md **gh and git**): as the App (`Identity::gh`), `-R
//! <github>` on every `pr`/`run` command, and the parsers of their JSON.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::env::Fault;
use crate::github::GhError;
use crate::handler::{Ctx, StepError};
use crate::mission::Mission;

/// The mission's repo on GitHub (`owner/name`).
pub fn github(cx: &Ctx<'_>, m: &Mission) -> Result<String, StepError> {
    Ok(cx.repo(m).map_err(StepError::Bug)?.github.clone())
}

/// `gh <args>` on the mission's repo → stdout, or GitHub's refusal (`Err` inside); network or
/// auth → `StepError::Env(github)` (LOOP-10).
pub fn try_gh(
    cx: &Ctx<'_>,
    m: &Mission,
    args: &[&str],
) -> Result<Result<String, String>, StepError> {
    let github = github(cx, m)?;
    match cx.identity.gh(&github, args) {
        Ok(out) => Ok(Ok(out)),
        Err(GhError::Env(e)) => Err(StepError::Env(Fault::Github, e)),
        Err(GhError::Failed(e)) if throttled(&e) => Err(StepError::Env(Fault::Github, e)),
        Err(GhError::Failed(e)) => Ok(Err(e)),
    }
}

static THROTTLED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)rate limit|\bhttp(?:/[0-9.]+)?:? 429\b|too many requests|abuse detection|something went wrong while executing your query",
    )
    .expect("throttled regex")
});

/// GitHub throttling (a primary or secondary rate limit, 429) or a transient GraphQL error: an
/// outage to back off from (LOOP-10), never a refusal a poll counts as a bug.
pub fn throttled(e: &str) -> bool {
    THROTTLED.is_match(e)
}

/// [`try_gh`] where a refusal is a bug (`gh <first arg> <second>: <stderr>`).
pub fn gh(cx: &Ctx<'_>, m: &Mission, args: &[&str]) -> Result<String, StepError> {
    try_gh(cx, m, args)?.map_err(|e| {
        let what: Vec<&str> = args.iter().take(2).copied().collect();
        StepError::Bug(format!("gh {}: {e}", what.join(" ")))
    })
}

static PR_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"https://github\.com/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/pull/(\d+)").expect("pr url")
});

/// A PR URL → (`owner/name`, number).
pub fn pr_of(url: &str) -> Option<(String, u64)> {
    let c = PR_URL.captures(url)?;
    Some((c[1].to_string(), c[2].parse().ok()?))
}

/// The first `https://github.com/<o>/<n>/pull/<n>` in `gh pr create`'s output.
pub fn created(out: &str) -> Option<(u64, String)> {
    let c = PR_URL.captures(out)?;
    Some((c[2].parse().ok()?, c[0].to_string()))
}

fn s(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `pr view <n> --json state,mergedAt,mergedBy,mergeCommit,headRefName,headRefOid,isCrossRepository`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PrView {
    /// `OPEN`, `CLOSED`, `MERGED`.
    pub state: String,
    pub merged_at: Option<String>,
    pub merged_by: Option<String>,
    pub merge_commit: Option<String>,
    pub head_ref_name: String,
    pub head_ref_oid: String,
    pub cross_repository: bool,
}

pub const PR_VIEW_FIELDS: &str =
    "state,mergedAt,mergedBy,mergeCommit,headRefName,headRefOid,isCrossRepository";

pub fn pr_view(json: &str) -> Result<PrView, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("gh pr view: {e}"))?;
    if !v.is_object() {
        return Err("gh pr view: not an object".into());
    }
    Ok(PrView {
        state: s(&v, "state"),
        merged_at: v
            .get("mergedAt")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
        merged_by: v
            .get("mergedBy")
            .and_then(|b| b.get("login"))
            .and_then(Value::as_str)
            .map(str::to_string),
        merge_commit: v
            .get("mergeCommit")
            .and_then(|c| c.get("oid"))
            .and_then(Value::as_str)
            .map(str::to_string),
        head_ref_name: s(&v, "headRefName"),
        head_ref_oid: s(&v, "headRefOid"),
        cross_repository: v
            .get("isCrossRepository")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// An open PR of `pr list --head <branch> --state open --json number,url,headRefOid`.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub number: u64,
    pub url: String,
    pub head: String,
}

pub fn pr_list(json: &str) -> Result<Vec<Listed>, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("gh pr list: {e}"))?;
    let a = v.as_array().ok_or("gh pr list: not a list")?;
    Ok(a.iter()
        .filter_map(|p| {
            Some(Listed {
                number: p.get("number")?.as_u64()?,
                url: s(p, "url"),
                head: s(p, "headRefOid"),
            })
        })
        .collect())
}

/// `pr view <n> --json headRefOid,mergeStateStatus,mergedAt,mergeCommit` → (head, merge state,
/// merged at, merge commit).
pub fn merge_state(json: &str) -> Result<(String, String, Option<String>, Option<String>), String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("gh pr view: {e}"))?;
    Ok((
        s(&v, "headRefOid"),
        s(&v, "mergeStateStatus"),
        v.get("mergedAt")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
        v.get("mergeCommit")
            .and_then(|c| c.get("oid"))
            .and_then(Value::as_str)
            .map(str::to_string),
    ))
}

/// `api repos/<r>/compare/<a>...<b> --jq .status` → `ahead`, `identical`, `behind`, `diverged`.
pub fn compare_status(out: &str) -> String {
    out.trim().trim_matches('"').to_string()
}

/// `api 'repos/<r>/deployments?environment=<env>&per_page=20'` → (id, sha), newest first.
pub fn deployments(json: &str) -> Result<Vec<(u64, String)>, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("gh api deployments: {e}"))?;
    let a = v.as_array().ok_or("gh api deployments: not a list")?;
    Ok(a.iter()
        .filter_map(|d| Some((d.get("id")?.as_u64()?, s(d, "sha"))))
        .collect())
}
