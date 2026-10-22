//! Merge (PIP-22), in code only: the PR read first (my unhandled feedback goes back to the
//! worker, a moved head back to CI), then by `mergeStateStatus`: squash-merge with
//! `--match-head-commit` and the `Towercab-Gate:` trailer, update the branch, start a conflict
//! round, recheck, mark ready, or read again; else `review and merge PR`.

use std::time::Duration;

use serde_json::{Value, json};

use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::{Event, Waiting};
use crate::mission::Mission;

use super::ci::Seq;
use super::data::Data;
use super::gh::{self, merge_state};
use super::{Mode, conventional, never_published, pr};

/// The fields of `merge`'s `gh pr view`.
pub const MERGE_FIELDS: &str = "headRefOid,mergeStateStatus,mergedAt,mergeCommit";

/// `UNKNOWN` is read again this often, at most [`UNKNOWN_READS`] times.
pub const UNKNOWN_AFTER: Duration = Duration::from_secs(10);
pub const UNKNOWN_READS: u64 = 6;

/// The `merge` stage (and, from part 4, `revert_merge`).
pub struct Merge {
    pub seq: Seq,
    mode: Mode,
}

impl Merge {
    pub fn new(seq: Seq, mode: Mode) -> Merge {
        Merge { seq, mode }
    }

    /// `merged → ok`: `merged_by` (`towercab` when the recorded `merge` step did it),
    /// `merge_sha`.
    fn merged(m: &Mission, commit: Option<String>) -> Progress {
        let by = if m.step == "merge" {
            "towercab"
        } else {
            "human"
        };
        let mut o = Outcome::ok().with("merged_by", by.to_string());
        if let Some(sha) = commit {
            o = o.with("merge_sha", sha);
        }
        Progress::Done(o)
    }

    fn read(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let github = gh::github(cx, m)?;
        let pr = m.pr.unwrap_or_default();
        let n = pr.to_string();
        let out = gh::gh(
            cx,
            m,
            &["pr", "view", &n, "-R", &github, "--json", MERGE_FIELDS],
        )?;
        let (head, state, merged_at, commit) = merge_state(&out).map_err(StepError::Bug)?;
        if merged_at.is_some() {
            return Ok(Self::merged(m, commit));
        }
        // No merge while my feedback is unhandled (LOOP-18).
        let prs = pr::read(cx, m, pr)?;
        if !crate::events::new_feedback(m, &prs, &pr::me(cx)).is_empty() {
            return Ok(Progress::Done(Outcome::event(Event::Feedback)));
        }
        let mut data = Data::of(m);
        let gated = data
            .get("gate")
            .and_then(|g| g.get("head"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if head != gated {
            return Ok(Progress::Done(Outcome::event(Event::HeadMoved)));
        }
        let mut counts = data.get("merge").cloned().unwrap_or(Value::Null);
        if counts.get("head").and_then(Value::as_str) != Some(head.as_str()) {
            counts = json!({"head": head, "blocked": 0, "unknown": 0});
        }
        let count = |c: &Value, k: &str| c.get(k).and_then(Value::as_u64).unwrap_or(0);
        match state.as_str() {
            "CLEAN" | "HAS_HOOKS" => {
                data.set("merge", counts);
                let m = cx.record(m, "merge", &[("data", data.text().into())])?;
                self.merge(cx, &m, &head)
            }
            "BEHIND" => {
                if m.sync_rounds >= 3 {
                    return Ok(Progress::Done(Outcome::wait(
                        Waiting::ReviewAndMergePr,
                        "3 sync rounds",
                    )));
                }
                data.set("merge", counts);
                let m = cx.record(
                    m,
                    "update",
                    &[
                        ("data", data.text().into()),
                        ("sync_rounds", (i64::from(m.sync_rounds) + 1).into()),
                    ],
                )?;
                self.update(cx, &m, &head)
            }
            "DIRTY" => Ok(Progress::Done(Outcome::event(Event::Conflict))),
            "BLOCKED" | "UNSTABLE" => {
                let k = count(&counts, "blocked") + 1;
                counts["blocked"] = json!(k);
                data.set("merge", counts);
                if k >= 3 {
                    return Ok(Progress::Done(
                        Outcome::wait(
                            Waiting::ReviewAndMergePr,
                            format!("{state} 3 times on this head"),
                        )
                        .with("data", data.text()),
                    ));
                }
                Ok(Progress::Done(
                    Outcome::event(Event::HeadMoved).with("data", data.text()),
                ))
            }
            "DRAFT" => {
                gh::gh(cx, m, &["pr", "ready", &n, "-R", &github])?;
                Ok(Progress::Poll {
                    after: Duration::ZERO,
                })
            }
            other => {
                let k = count(&counts, "unknown") + 1;
                counts["unknown"] = json!(k);
                data.set("merge", counts);
                if k > UNKNOWN_READS {
                    return Ok(Progress::Done(
                        Outcome::wait(
                            Waiting::ReviewAndMergePr,
                            format!("merge state {other} after {UNKNOWN_READS} reads"),
                        )
                        .with("data", data.text()),
                    ));
                }
                cx.record(m, "read", &[("data", data.text().into())])?;
                Ok(Progress::Poll {
                    after: UNKNOWN_AFTER,
                })
            }
        }
    }

    /// `gh pr merge <n> --squash --match-head-commit <head> --subject "<PR title> (#<n>)"
    /// --body "Towercab-Gate: <verdict> sha=<head>"`, then the PR read for its merge commit.
    fn merge(&self, cx: &Ctx<'_>, m: &Mission, head: &str) -> Result<Progress, StepError> {
        let github = gh::github(cx, m)?;
        let n = m.pr.unwrap_or_default().to_string();
        let data = Data::of(m);
        let title = match data
            .get("design")
            .and_then(|d| d.get("title"))
            .and_then(Value::as_str)
        {
            Some(t) => t.to_string(),
            None => conventional("feat", "", false, super::intent(cx, m)?.title()),
        };
        let verdict = data
            .get("gate")
            .and_then(|g| g.get("verdict"))
            .and_then(Value::as_str)
            .unwrap_or("approved")
            .to_string();
        let subject = format!("{title} (#{n})");
        let body = format!("Towercab-Gate: {verdict} sha={head}");
        let args = [
            "pr",
            "merge",
            &n,
            "-R",
            &github,
            "--squash",
            "--match-head-commit",
            head,
            "--subject",
            &subject,
            "--body",
            &body,
        ];
        if let Err(e) = gh::try_gh(cx, m, &args)? {
            let low = e.to_lowercase();
            if low.contains("head branch was modified")
                || low.contains("match-head-commit")
                || low.contains("head commit")
                || low.contains("expected head sha")
            {
                return Ok(Progress::Done(Outcome::event(Event::HeadMoved)));
            }
            return Ok(Progress::Done(Outcome::wait(
                Waiting::MergeFailed,
                crate::outbox::cut(&crate::outbox::one_line(&e), 300),
            )));
        }
        let out = gh::gh(
            cx,
            m,
            &["pr", "view", &n, "-R", &github, "--json", MERGE_FIELDS],
        )?;
        let (_, _, merged_at, commit) = merge_state(&out).map_err(StepError::Bug)?;
        if merged_at.is_some() {
            return Ok(Self::merged(m, commit));
        }
        Ok(Progress::Poll {
            after: UNKNOWN_AFTER,
        })
    }

    /// `BEHIND`: `gh api -X PUT repos/<r>/pulls/<n>/update-branch -f expected_head_sha=<head>`
    /// → `ci` for the new head.
    fn update(&self, cx: &Ctx<'_>, m: &Mission, head: &str) -> Result<Progress, StepError> {
        let github = gh::github(cx, m)?;
        let n = m.pr.unwrap_or_default();
        let path = format!("repos/{github}/pulls/{n}/update-branch");
        let sha = format!("expected_head_sha={head}");
        if let Err(e) = gh::try_gh(cx, m, &["api", "-X", "PUT", &path, "-f", &sha])? {
            eprintln!(
                "towercab: {}: update-branch: {}",
                m.label(),
                crate::outbox::one_line(&e)
            );
        }
        Ok(Progress::Done(Outcome::event(Event::HeadMoved)))
    }
}

impl Handler for Merge {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        if let Some(p) = never_published(m) {
            return Ok(p);
        }
        if m.step == "update" {
            // Recorded before the PUT: the branch may have moved; CI reads the head.
            return Ok(Progress::Done(Outcome::event(Event::HeadMoved)));
        }
        self.read(cx, m)
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!(
            "{}: merge runs no child",
            m.label()
        )))
    }
}
