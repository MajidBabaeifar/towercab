//! Deploy (PIP-8): after a merge into a repo with ` ```live `, Towercab polls every 30 s until
//! the deployed sha contains the merge (`gh api repos/<r>/compare/<merge>...<sha>` `ahead` or
//! `identical`). One deploy, e2e or release at a time per repo, lowest mission id first. A
//! timeout never reverts: `waiting: deploy not seen` (a revert's: `revert failed`).

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::Waiting;
use crate::mission::Mission;
use crate::repo::Deploy as Where;

use super::ci::Seq;
use super::data::Data;
use super::{Mode, files, gh};

/// How often a deploy (and a release's production deploy, a rollback) is looked for.
pub const DEPLOY_POLL: Duration = Duration::from_secs(30);

/// How long a `url:` deploy's page may take.
pub const URL_TIMEOUT: Duration = Duration::from_secs(10);

static SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[0-9a-f]{7,40}\b").expect("sha regex"));

/// The first sha in a `url:` deploy's page.
pub fn sha_in(body: &str) -> Option<String> {
    SHA.find(body).map(|s| s.as_str().to_string())
}

/// The merge a stage waits for: an intent's `merge_sha`, a revert's `data.revert.merge_sha`.
pub fn merge_of(seq: Seq, m: &Mission) -> Option<String> {
    match seq {
        Seq::Revert => Data::of(m)
            .get("revert")
            .and_then(|r| r.get("merge_sha"))
            .and_then(Value::as_str)
            .map(str::to_string),
        Seq::Intent | Seq::Rehearsal => m.merge_sha.clone(),
    }
}

/// This one waits its turn on the repo's staging: a revert (`revert_deploy`, `revert_e2e`)
/// behind a lower-id revert there only; an intent's `deploy`, `e2e`, `release` behind a revert
/// mission on its way (`rollback` … `revert_e2e`: staging still has the broken merge) and a
/// lower-id intent in `deploy`, `e2e` or `release`.
pub fn behind_other(cx: &Ctx<'_>, m: &Mission) -> Result<bool, StepError> {
    let sql = if m.kind == crate::machine::Kind::Revert {
        "SELECT EXISTS (SELECT 1 FROM missions WHERE repo = ?1 AND id < ?2
           AND stage IN ('revert_deploy', 'revert_e2e'))"
    } else {
        "SELECT EXISTS (SELECT 1 FROM missions WHERE repo = ?1 AND id <> ?2
           AND (stage IN ('rollback', 'revert', 'revert_ci', 'revert_merge', 'revert_deploy',
                          'revert_e2e')
                OR (id < ?2 AND stage IN ('deploy', 'e2e', 'release'))))"
    };
    cx.db
        .conn()
        .query_row(sql, rusqlite::params![m.repo, m.id], |r| {
            r.get::<_, bool>(0)
        })
        .map_err(|e| StepError::Bug(crate::db::sql(e)))
}

/// The sha deployed where `at` says: `env:<name>` → the newest of the environment's last 20
/// deployments with a `success` status; `url:<u>` → the first sha in a 2xx answer's body (no
/// answer: none).
pub fn deployed(cx: &Ctx<'_>, m: &Mission, at: &Where) -> Result<Option<String>, StepError> {
    match at {
        Where::Env(env) => {
            let github = gh::github(cx, m)?;
            let path = format!(
                "repos/{github}/deployments?environment={}&per_page=20",
                encode(env)
            );
            let out = gh::gh(cx, m, &["api", &path])?;
            for (id, sha) in gh::deployments(&out).map_err(StepError::Bug)? {
                let path = format!("repos/{github}/deployments/{id}/statuses");
                let out = gh::gh(cx, m, &["api", &path])?;
                let v: Value = serde_json::from_str(&out)
                    .map_err(|e| StepError::Bug(format!("gh api {path}: {e}")))?;
                // The newest status (GitHub lists them newest first) says where it stands.
                let ok = v
                    .as_array()
                    .and_then(|a| a.first())
                    .is_some_and(|s| s.get("state").and_then(Value::as_str) == Some("success"));
                if ok {
                    return Ok(Some(sha));
                }
            }
            Ok(None)
        }
        Where::Url(url) => match crate::http::get_text(url, URL_TIMEOUT) {
            Ok((status, body)) if (200..300).contains(&status) => Ok(sha_in(&body)),
            Ok(_) => Ok(None),
            Err(e) => {
                eprintln!("towercab: {}: deploy {url}: {e}", m.label());
                Ok(None)
            }
        },
    }
}

/// `gh api repos/<r>/compare/<merge>...<sha> --jq .status` (`ahead`, `identical`, `behind`,
/// `diverged`); GitHub refusing (an unknown sha) → none.
pub fn compare(
    cx: &Ctx<'_>,
    m: &Mission,
    merge: &str,
    sha: &str,
) -> Result<Option<String>, StepError> {
    let github = gh::github(cx, m)?;
    let path = format!("repos/{github}/compare/{merge}...{sha}");
    Ok(gh::try_gh(cx, m, &["api", &path, "--jq", ".status"])?
        .ok()
        .map(|o| gh::compare_status(&o)))
}

/// The deployed `sha` contains `merge`: the same commit, or compare `ahead` / `identical`.
pub fn contains(cx: &Ctx<'_>, m: &Mission, merge: &str, sha: &str) -> Result<bool, StepError> {
    if sha.is_empty() || merge.is_empty() {
        return Ok(false);
    }
    if merge.starts_with(sha) || sha.starts_with(merge) {
        return Ok(true);
    }
    Ok(matches!(
        compare(cx, m, merge, sha)?.as_deref(),
        Some("ahead" | "identical")
    ))
}

/// A query value percent-encoded (all but `A-Za-z0-9-._~`).
pub fn encode(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The first 7 characters of a sha.
pub fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

/// `deploy` and `revert_deploy`.
pub struct Deploy {
    pub seq: Seq,
    mode: Mode,
}

impl Deploy {
    pub fn new(seq: Seq, mode: Mode) -> Deploy {
        Deploy { seq, mode }
    }
}

impl Handler for Deploy {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let repo = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        // No `live`: merged means done.
        let Some(live) = repo.towercab.live else {
            return Ok(Progress::Done(Outcome::ok()));
        };
        let merge = merge_of(self.seq, m)
            .ok_or_else(|| StepError::Bug(format!("{}: no merge sha to deploy", m.label())))?;
        if behind_other(cx, m)? {
            cx.record(m, "queued", &[])?;
            return Ok(Progress::Poll { after: DEPLOY_POLL });
        }
        let now = cx.tick.unix();
        let mut data = Data::of(m);
        let mut d = data.get("deploy").cloned().unwrap_or(Value::Null);
        // A new wait (entered again, e.g. after `deploy not seen`) starts its clock now.
        if m.step != "poll" || d.get("merge").and_then(Value::as_str) != Some(merge.as_str()) {
            d = json!({"merge": merge, "since": now});
        }
        let seen = deployed(cx, m, &live.deploy)?;
        if let Some(sha) = &seen {
            d["sha"] = json!(sha);
            if contains(cx, m, &merge, sha)? {
                if self.seq == Seq::Intent {
                    // DORA (MET-26): `live` is staging when a release block follows it.
                    let env = if repo.towercab.release.is_some() {
                        "staging"
                    } else {
                        "production"
                    };
                    crate::indicators::deployed(cx, m, env);
                }
                data.set("deploy", d);
                return Ok(Progress::Done(Outcome::ok().with("data", data.text())));
            }
        }
        let since = d.get("since").and_then(Value::as_f64).unwrap_or(now);
        let mins = live.timeout_min;
        if cx.timeouts && now - since >= f64::from(mins) * 60.0 {
            data.set("deploy", d);
            let last = seen.as_deref().map_or("none", short);
            let why = format!(
                "{} not deployed after {mins} min (deployed: {last})",
                short(&merge)
            );
            let o = match self.seq {
                Seq::Revert => {
                    Outcome::wait(Waiting::RevertFailed, format!("revert deploy: {why}"))
                }
                Seq::Intent | Seq::Rehearsal => Outcome::wait(Waiting::DeployNotSeen, why),
            };
            return Ok(Progress::Done(o.with("data", data.text())));
        }
        data.set("deploy", d);
        cx.record(m, "poll", &[("data", data.text().into())])?;
        Ok(Progress::Poll { after: DEPLOY_POLL })
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!(
            "{}: deploy runs no child",
            m.label()
        )))
    }
}
