//! A revert mission (PIP-19): the same mission, `kind = revert` from `rollback` on. With a
//! ` ```rollback ` block its `command` restores the merge's parent first (a failure doesn't
//! stop the revert), then, always: `git revert [-m 1] <merge>` on `towercab/revert-<sha7>` →
//! push → PR `revert: <title>` → `revert_ci` → `revert_merge` → `revert_deploy` → `revert_e2e`.

use std::path::Path;

use serde_json::{Value, json};

use crate::checkout;
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::Waiting;
use crate::mission::Mission;

use super::data::Data;
use super::deploy::{DEPLOY_POLL, compare, deployed, short};
use super::e2e::at_sha;
use super::verify::tail;
use super::{Mode, conventional, files, gh, git as pgit, sandbox};

/// `towercab/revert-<merge sha7>`: one branch per merge.
pub fn revert_branch(merge: &str) -> String {
    format!("towercab/revert-{}", short(merge))
}

/// The intent PR's title (`data.design.title`, else `feat: <intent title>`).
pub fn pr_title(cx: &Ctx<'_>, m: &Mission) -> String {
    match Data::of(m)
        .get("design")
        .and_then(|d| d.get("title"))
        .and_then(Value::as_str)
    {
        Some(t) => t.to_string(),
        None => conventional(
            "feat",
            "",
            false,
            &super::intent(cx, m).map_or_else(|_| m.label(), |i| i.title().to_string()),
        ),
    }
}

/// The revert PR's body (pipeline.md **PR text**): `Reverts #<n> (<title>): e2e red twice
/// after the merge.` and the e2e log's last 40 lines, fenced.
pub fn pr_body(n: Option<u64>, title: &str, log: &str) -> String {
    let lines: Vec<&str> = log.lines().collect();
    let last = lines[lines.len().saturating_sub(40)..].join("\n");
    let pr = n.map_or_else(|| "the PR".to_string(), |n| format!("#{n}"));
    format!("Reverts {pr} ({title}): e2e red twice after the merge.\n\n```\n{last}\n```\n")
}

/// The open PR of `branch` (`gh pr list --head <branch> --state open`), else a new one (`gh pr
/// create --base <base> --head <branch> --title <title> --body-file <runs>/pr-body.md
/// [--draft]`) → (number, URL).
pub fn open_pr(
    cx: &Ctx<'_>,
    m: &Mission,
    branch: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<(u64, String), StepError> {
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let out = gh::gh(
        cx,
        m,
        &[
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "-R",
            &repo.github,
            "--json",
            "number,url,headRefOid",
        ],
    )?;
    if let Some(p) = gh::pr_list(&out)
        .map_err(StepError::Bug)?
        .into_iter()
        .next()
    {
        return Ok((p.number, p.url));
    }
    let runs = cx.runs(m);
    std::fs::create_dir_all(&runs)
        .map_err(|e| StepError::Bug(format!("{}: {e}", runs.display())))?;
    let file = runs.join("pr-body.md");
    std::fs::write(&file, body).map_err(|e| StepError::Bug(format!("{}: {e}", file.display())))?;
    let file = file.to_string_lossy().into_owned();
    let mut args = vec![
        "pr",
        "create",
        "--base",
        &repo.base,
        "--head",
        branch,
        "--title",
        title,
        "--body-file",
        &file,
        "-R",
        &repo.github,
    ];
    if draft {
        args.push("--draft");
    }
    let out = gh::gh(cx, m, &args)?;
    gh::created(&out)
        .ok_or_else(|| StepError::Bug(format!("gh pr create: no PR URL in {}", out.trim())))
}

/// The last stderr line of a command that failed (else `exit <c>`, `timed out`).
pub fn failure(end: &ChildEnd) -> Option<String> {
    let code = end.status.and_then(|s| s.code());
    if !end.timed_out && code == Some(0) {
        return None;
    }
    let err = tail(&end.stderr, 4000);
    let why = match err.lines().rev().find(|l| !l.trim().is_empty()) {
        Some(l) => l.trim().to_string(),
        None if end.timed_out => "timed out".into(),
        None => format!("exit {}", code.map_or("unknown".into(), |c| c.to_string())),
    };
    Some(crate::outbox::cut(&crate::outbox::one_line(&why), 300))
}

/// The `rollback` stage: a revert mission's first.
pub struct Rollback {
    mode: Mode,
}

impl Rollback {
    pub fn new(mode: Mode) -> Rollback {
        Rollback { mode }
    }

    /// Until the deploy no longer contains the merge (compare `behind` or `diverged`); the
    /// live block's timeout → on to the revert anyway.
    fn wait(&self, cx: &Ctx<'_>, m: &Mission, merge: &str) -> Result<Progress, StepError> {
        let repo = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let Some(live) = repo.towercab.live else {
            return Ok(Progress::Done(Outcome::ok()));
        };
        let now = cx.tick.unix();
        let mut data = Data::of(m);
        let mut r = data.get("rollback").cloned().unwrap_or(json!({}));
        if m.step != "wait" {
            r["since"] = json!(now);
        }
        if let Some(sha) = deployed(cx, m, &live.deploy)?
            && matches!(
                compare(cx, m, merge, &sha)?.as_deref(),
                Some("behind" | "diverged")
            )
        {
            r["sha"] = json!(sha);
            data.set("rollback", r);
            return Ok(Progress::Done(Outcome::ok().with("data", data.text())));
        }
        let since = r.get("since").and_then(Value::as_f64).unwrap_or(now);
        let mins = live.timeout_min;
        if cx.timeouts && now - since >= f64::from(mins) * 60.0 {
            data.set("rollback", r);
            let mut o = Outcome::ok().with("data", data.text());
            o.why = Some(format!("rollback not seen after {mins} min"));
            return Ok(Progress::Done(o));
        }
        data.set("rollback", r);
        cx.record(m, "wait", &[("data", data.text().into())])?;
        Ok(Progress::Poll { after: DEPLOY_POLL })
    }
}

impl Handler for Rollback {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let repo = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let (Some(block), Some(_)) = (repo.towercab.rollback, repo.towercab.live) else {
            return Ok(Progress::Done(Outcome::ok()));
        };
        let merge = m
            .merge_sha
            .clone()
            .ok_or_else(|| StepError::Bug(format!("{}: no merge sha to roll back", m.label())))?;
        let mut data = Data::of(m);
        let log = |n: u32| cx.runs(m).join(format!("rollback-{n}.log"));
        // Once: recorded right before its spawn; re-entered after it started (its log made) it
        // only waits.
        let started = m.step == "command" && log(data.n("rollback")).exists();
        match m.step.as_str() {
            "wait" => self.wait(cx, m, &merge),
            "command" if started => self.wait(cx, m, &merge),
            step => {
                let n = if step == "command" {
                    data.n("rollback")
                } else {
                    data.next_n("rollback")
                };
                let dir = at_sha(cx, m, &merge)?;
                let parent = pgit::rev(cx, &dir, &format!("{merge}^1"))?;
                let runs = cx.runs(m);
                std::fs::create_dir_all(&runs)
                    .map_err(|e| StepError::Bug(format!("{}: {e}", runs.display())))?;
                let line = block.command.replace("<sha>", &parent);
                let spec = sandbox::repo_command(cx, m, &dir, &line, &log(n))?;
                data.set("rollback", json!({"parent": parent}));
                cx.record(m, "command", &[("data", data.text().into())])?;
                Ok(Progress::Spawn(spec))
            }
        }
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        let merge = m.merge_sha.clone().unwrap_or_default();
        match failure(&end) {
            // The revert follows anyway.
            Some(why) => {
                let mut data = Data::of(m);
                let mut r = data.get("rollback").cloned().unwrap_or(json!({}));
                r["failed"] = json!(why);
                data.set("rollback", r);
                let mut o = Outcome::ok().with("data", data.text());
                o.why = Some(format!("rollback command failed: {why}"));
                Ok(Progress::Done(o))
            }
            None => self.wait(cx, m, &merge),
        }
    }
}

/// The `revert` stage.
pub struct Revert {
    mode: Mode,
}

impl Revert {
    pub fn new(mode: Mode) -> Revert {
        Revert { mode }
    }

    /// `towercab/revert-<sha7>` in the mission checkout: reused from origin when its tip
    /// already reverts this merge, else `git checkout -B` from `origin/<base>` and `git revert
    /// --no-edit [-m 1] <merge>` as the bot (a conflict → `revert failed`).
    fn branch(&self, cx: &Ctx<'_>, m: &Mission, merge: &str) -> Result<Progress, StepError> {
        let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
        let branch = revert_branch(merge);
        let mut data = Data::of(m);
        let log = data
            .get("e2e")
            .and_then(|e| e.get("red"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        data.set("revert", json!({"branch": branch, "e2e_log": log}));
        let m = cx.record(
            m,
            "branch",
            &[
                ("revert_branch", branch.clone().into()),
                ("data", data.text().into()),
            ],
        )?;
        let dir = at_sha(cx, &m, merge)?;
        let remote = format!("refs/remotes/origin/{branch}");
        let reused = pgit::fetch_branch(cx, &m, &branch)? && {
            let from = repo.path.to_string_lossy().into_owned();
            pgit::run(
                cx,
                &dir,
                &["fetch", "--quiet", &from, &format!("+{remote}:{remote}")],
            )?;
            pgit::run(cx, &dir, &["checkout", "--quiet", "-B", &branch, &remote])?;
            pgit::reverts(cx, &dir, merge)
        };
        if !reused {
            let base = format!("refs/remotes/origin/{}", repo.base);
            pgit::run(cx, &dir, &["checkout", "--quiet", "-B", &branch, &base])?;
            if !pgit::revert(cx, &dir, merge, self.mode.eval())? {
                let files = conflicts(cx, &dir, &base, merge);
                return Ok(Progress::Done(Outcome::wait(
                    Waiting::RevertFailed,
                    format!("revert conflict on {branch}: {files}"),
                )));
            }
        }
        let m = cx.record(&m, "push", &[])?;
        self.push(cx, &m)
    }

    fn push(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        let mut rv = data.get("revert").cloned().unwrap_or(json!({}));
        let branch = rv
            .get("branch")
            .and_then(Value::as_str)
            .ok_or_else(|| StepError::Bug(format!("{}: no revert branch", m.label())))?
            .to_string();
        let dir = cx.checkout(m);
        match pgit::push(cx, m, &dir, &branch)? {
            pgit::Push::Pushed(sha) => {
                rv["head"] = json!(sha);
                rv["pushed_at"] = json!(cx.tick.unix());
                data.set("revert", rv);
                let m = cx.record(m, "pr", &[("data", data.text().into())])?;
                self.pr(cx, &m)
            }
            pgit::Push::Rejected(e) | pgit::Push::Refused(e) => Ok(Progress::Done(Outcome::wait(
                Waiting::RevertFailed,
                format!(
                    "revert push of {branch} rejected: {}",
                    crate::outbox::cut(&crate::outbox::one_line(&e), 200)
                ),
            ))),
        }
    }

    fn pr(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        let mut rv = data.get("revert").cloned().unwrap_or(json!({}));
        let s = |k: &str| {
            rv.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let branch = s("branch");
        let title = pr_title(cx, m);
        let log = std::fs::read_to_string(s("e2e_log")).unwrap_or_default();
        let body = pr_body(m.pr, &title, &log);
        let (n, url) = open_pr(cx, m, &branch, &format!("revert: {title}"), &body, false)?;
        rv["pr"] = json!(n);
        rv["url"] = json!(url);
        data.set("revert", rv);
        Ok(Progress::Done(Outcome::ok().with("data", data.text())))
    }
}

/// The files a revert of `merge` onto `base` conflicts in (`git diff --name-only` of the
/// merge's change that `base` also changed), for the why.
fn conflicts(cx: &Ctx<'_>, dir: &Path, base: &str, merge: &str) -> String {
    let changed = |a: &str, b: &str| -> Vec<String> {
        pgit::run(cx, dir, &["diff", "--name-only", a, b])
            .map(|o| o.lines().map(str::to_string).collect())
            .unwrap_or_default()
    };
    let ours = changed(&format!("{merge}^1"), merge);
    let since = changed(merge, base);
    let both: Vec<String> = ours.into_iter().filter(|f| since.contains(f)).collect();
    if both.is_empty() {
        "see git revert".into()
    } else {
        both.join(", ")
    }
}

impl Handler for Revert {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let merge = m
            .merge_sha
            .clone()
            .ok_or_else(|| StepError::Bug(format!("{}: no merge sha to revert", m.label())))?;
        match m.step.as_str() {
            "push" if checkout::valid(&cx.exes.git, &cx.checkout(m)) => self.push(cx, m),
            "pr" => self.pr(cx, m),
            _ => self.branch(cx, m, &merge),
        }
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!(
            "{}: revert runs no child",
            m.label()
        )))
    }
}
