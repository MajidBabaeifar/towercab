//! Publish (PIP-2; PIP-23's check runs; PIP-29, PIP-31's refusals): after design's spec commit
//! and after each green verify + proof, Towercab pushes `missions.branch` from its own clone
//! (never `--force`; my push onto the PR is merged in first), opens the PR the first time,
//! marks it ready once, and posts `towercab/verify` and `towercab/proof` on the pushed head.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::Waiting;
use crate::mission::Mission;
use crate::repo::{Protected, RepoFiles};

use super::data::Data;
use super::gh::{self, created, pr_list};
use super::git::{self as pgit, Push};
use super::{Mode, Round, files, guard, intent, round, wait_note};

/// Pushes the checkout's branch from the clone (PIP-2): rejected (my push onto the PR) →
/// `git merge --no-edit refs/remotes/origin/<branch>` in the checkout (my commits kept), then
/// again; a conflict there → `merge --abort`, `answer the question` (`Err` inside). `Ok(sha)`.
/// In `Mode::Eval` nothing is pushed: the checkout's `HEAD`.
pub fn push_branch(
    cx: &Ctx<'_>,
    m: &Mission,
    eval: bool,
) -> Result<Result<String, Progress>, StepError> {
    let dir = cx.checkout(m);
    if eval {
        return pgit::rev(cx, &dir, "HEAD").map(Ok);
    }
    let branch = m
        .branch
        .clone()
        .ok_or_else(|| StepError::Bug(format!("{}: no branch", m.label())))?;
    let wait = |why: String| {
        let note = format!(
            "{why}. Fix what GitHub refused (a ruleset, a hook) or push the branch yourself, then remove `waiting`."
        );
        wait_note(cx, m, Waiting::AnswerTheQuestion, &why, &note).map(Err)
    };
    for _ in 0..3 {
        let why = match pgit::push(cx, m, &dir, &branch)? {
            Push::Pushed(sha) => return Ok(Ok(sha)),
            Push::Refused(e) => {
                return wait(format!(
                    "publish failed: {}",
                    crate::outbox::cut(&crate::outbox::one_line(&e), 300)
                ));
            }
            Push::Rejected(why) => why,
        };
        eprintln!(
            "towercab: {}: push rejected, merging {branch}: {}",
            m.label(),
            crate::outbox::one_line(&why)
        );
        pgit::fetch_branch(cx, m, &branch)?;
        let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
        let remote = format!("refs/remotes/origin/{branch}");
        let clone = repo.path.to_string_lossy().into_owned();
        pgit::run(
            cx,
            &dir,
            &["fetch", "--quiet", &clone, &format!("+{remote}:{remote}")],
        )?;
        if !pgit::merge(cx, &dir, &remote, eval)? {
            let _ = pgit::run(cx, &dir, &["merge", "--abort"]);
            let why = format!(
                "publish failed: {branch} moved on GitHub and conflicts with Towercab's commits"
            );
            let note = format!(
                "{why}. Merge `{branch}` so it builds on what is there, or drop your commits, then remove `waiting`."
            );
            return wait_note(cx, m, Waiting::AnswerTheQuestion, &why, &note).map(Err);
        }
    }
    wait(format!("publish failed: {branch}: push rejected 3 times"))
}

/// The intent's PR (PIP-2): an open one on the branch first (`gh pr list --head`: a re-entry
/// after a crash), else `gh pr create --base <base> --head <branch> --title <t> --body-file
/// <runs>/pr-body.md [--draft]` → (number, URL).
pub fn open_pr(
    cx: &Ctx<'_>,
    m: &Mission,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<(u64, String), StepError> {
    let github = gh::github(cx, m)?;
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let branch = m
        .branch
        .clone()
        .ok_or_else(|| StepError::Bug(format!("{}: no branch", m.label())))?;
    let listed = gh::gh(
        cx,
        m,
        &[
            "pr",
            "list",
            "-R",
            &github,
            "--head",
            &branch,
            "--state",
            "open",
            "--json",
            "number,url,headRefOid",
        ],
    )?;
    let open = pr_list(&listed).map_err(StepError::Bug)?;
    if let Some(p) = open
        .iter()
        .find(|p| m.head.as_deref().is_none_or(|h| h == p.head))
    {
        return Ok((p.number, p.url.clone()));
    }
    let file = cx.runs(m).join("pr-body.md");
    std::fs::create_dir_all(cx.runs(m))
        .and_then(|()| std::fs::write(&file, body))
        .map_err(|e| StepError::Bug(format!("{}: {e}", file.display())))?;
    let file = file.to_string_lossy().into_owned();
    let mut args = vec![
        "pr",
        "create",
        "-R",
        &github,
        "--base",
        &repo.base,
        "--head",
        &branch,
        "--title",
        title,
        "--body-file",
        &file,
    ];
    if draft {
        args.push("--draft");
    }
    let out = gh::gh(cx, m, &args)?;
    created(&out)
        .ok_or_else(|| StepError::Bug(format!("gh pr create: no PR URL in {:?}", out.trim())))
}

/// The publish refusals (PIP-29, PIP-31): a path changed since the merge-base with base that
/// is protected and not unlocked; in a verify or CI repair round, a locked test file
/// (`guard::locked`) changed or deleted since the lock's baseline (`guard::lock_base`), unless
/// HEAD keeps the version my push made after it. `Err` inside: the paths.
pub fn check_diff(
    cx: &Ctx<'_>,
    m: &Mission,
    round: Round,
    repo_files: &RepoFiles,
) -> Result<Result<(), String>, StepError> {
    let intent = intent(cx, m)?;
    let protected =
        Protected::new(&repo_files.towercab.protected, intent.unlock()).map_err(StepError::Bug)?;
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let dir = cx.checkout(m);
    let base = pgit::merge_base(cx, &dir, &repo.base)?;
    let changed = pgit::changed(cx, &dir, &base, "HEAD")?;
    let (since_head, locked) = match guard::lock_base(cx, m) {
        Some(lock) if matches!(round, Round::Verify | Round::Ci) => {
            let mut since = pgit::changed(cx, &dir, &lock, "HEAD")?;
            // My push onto the PR after the baseline, merged in as it is: not the worker's.
            let remote = format!(
                "refs/remotes/origin/{}",
                m.branch.as_deref().unwrap_or_default()
            );
            if let Ok(mine) = pgit::rev(cx, &dir, &remote)
                && !pgit::ok(cx, &dir, &["merge-base", "--is-ancestor", &mine, &lock])
            {
                let paths = |v: Vec<(char, String)>| -> BTreeSet<String> {
                    v.into_iter().map(|(_, p)| p).collect()
                };
                let pushed = paths(pgit::changed(cx, &dir, &lock, &mine)?);
                let differs = paths(pgit::changed(cx, &dir, &mine, "HEAD")?);
                since.retain(|(_, p)| !pushed.contains(p) || differs.contains(p));
            }
            (since, guard::locked(cx, m, &repo_files.towercab.tests)?)
        }
        _ => (Vec::new(), Vec::new()),
    };
    Ok(guard::check(&changed, &protected, &since_head, &locked))
}

/// The `publish` stage.
pub struct Publish {
    mode: Mode,
}

impl Publish {
    pub fn new(mode: Mode) -> Publish {
        Publish { mode }
    }

    /// `check_runs`: `towercab/verify`, and `towercab/proof` unless skipped, on `head` (PIP-23,
    /// PIP-30): a failure is logged, never blocks.
    fn check_runs(&self, cx: &Ctx<'_>, m: &Mission, head: &str) -> Result<(), StepError> {
        let data = Data::of(m);
        let github = gh::github(cx, m)?;
        for name in ["verify", "proof"] {
            let Some(d) = data.get(name) else { continue };
            let line = d.get("line").and_then(Value::as_str).unwrap_or_default();
            if line.is_empty() || line.starts_with("skipped") {
                continue;
            }
            let n = d.get("n").and_then(Value::as_u64).unwrap_or(0);
            let log = std::fs::read(cx.runs(m).join(format!("{name}-{n}.log"))).unwrap_or_default();
            let log =
                String::from_utf8_lossy(&log[log.len().saturating_sub(60_000)..]).into_owned();
            let path = format!("repos/{github}/check-runs");
            let args = [
                "api".to_string(),
                "-X".into(),
                "POST".into(),
                path,
                "-f".into(),
                format!("name=towercab/{name}"),
                "-f".into(),
                format!("head_sha={head}"),
                "-f".into(),
                "status=completed".into(),
                "-f".into(),
                "conclusion=success".into(),
                "-f".into(),
                format!("output[title]={line}"),
                "-f".into(),
                format!("output[summary]={log}"),
            ];
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            if let Err(e) = gh::try_gh(cx, m, &args)? {
                eprintln!("towercab: {}: towercab/{name} check run: {e}", m.label());
            }
        }
        Ok(())
    }
}

impl Handler for Publish {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let mut m = m.clone();
        loop {
            match m.step.as_str() {
                "" | "check" => {
                    let r = round(cx.db.conn(), &m).map_err(StepError::Bug)?;
                    let repo_files = match files(cx, &m) {
                        Ok(f) => f,
                        Err(o) => return Ok(Progress::Done(o)),
                    };
                    if let Err(paths) = check_diff(cx, &m, r, &repo_files)? {
                        let why = format!("changed: {paths}");
                        let note = format!(
                            "Publish refused: {why}. These paths go through Majid: revert them on the branch, or unlock them in intent.md, then remove `waiting`."
                        );
                        return wait_note(cx, &m, Waiting::ProtectedPathChanged, &why, &note);
                    }
                    m = cx.record(&m, "push", &[])?;
                }
                "push" => {
                    let sha = match push_branch(cx, &m, false)? {
                        Ok(sha) => sha,
                        Err(p) => return Ok(p),
                    };
                    m = cx.record(
                        &m,
                        "pr",
                        &[("head", sha.into()), ("pushed_at", cx.tick.unix().into())],
                    )?;
                }
                "pr" => {
                    if m.pr.is_none() {
                        let data = Data::of(&m);
                        let title = match data
                            .get("design")
                            .and_then(|d| d.get("title"))
                            .and_then(Value::as_str)
                        {
                            Some(t) => t.to_string(),
                            None => super::conventional("feat", "", false, intent(cx, &m)?.title()),
                        };
                        let body = crate::writer::initial_of(&m);
                        let (pr, url) = open_pr(cx, &m, &title, &body, false)?;
                        let mut data = Data::of(&m);
                        data.set("ready", true);
                        m = cx.record(
                            &m,
                            "ready",
                            &[
                                ("pr", (pr as i64).into()),
                                ("pr_url", url.into()),
                                ("data", data.text().into()),
                            ],
                        )?;
                    } else {
                        m = cx.record(&m, "ready", &[])?;
                    }
                }
                "ready" => {
                    let mut data = Data::of(&m);
                    if !data.bool("ready") {
                        let github = gh::github(cx, &m)?;
                        let n = m.pr.unwrap_or_default().to_string();
                        gh::gh(cx, &m, &["pr", "ready", &n, "-R", &github])?;
                        data.set("ready", true);
                    }
                    m = cx.record(&m, "runs", &[("data", data.text().into())])?;
                }
                "runs" => {
                    let head = m.head.clone().unwrap_or_default();
                    self.check_runs(cx, &m, &head)?;
                    return Ok(Progress::Done(Outcome::ok()));
                }
                other => {
                    return Err(StepError::Bug(format!("publish: unknown step {other}")));
                }
            }
        }
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!(
            "{}: publish runs no child",
            m.label()
        )))
    }
}
