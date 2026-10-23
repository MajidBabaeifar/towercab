//! Rollback rehearsal (PIP-35): weekly per repo with ` ```live `, when the loop is idle, a
//! mission of its own (`kind = rehearsal`, no intent): `git revert` of `origin/<base>`'s head on
//! `towercab/rehearse-<yymmdd>`, a draft PR, CI (`rehearse_ci`), the ` ```rollback ` block's
//! `rehearse` command; never merged: `rehearse_close` closes the PR and deletes the branch.
//! Red anywhere → `rollback rehearsal failed: <repo>` (the machine's message).

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::checkout;
use crate::config::Config;
use crate::db::{Db, get_meta, set_meta, sql};
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::mission::Mission;
use crate::runloop::Tick;

use super::data::Data;
use super::deploy::short;
use super::revert::{failure, open_pr};
use super::{Mode, files, gh, git as pgit, sandbox};

/// A repo is rehearsed at most this often.
pub const EVERY: f64 = 7.0 * 86_400.0;

/// [`schedule`] looks for a due repo at most this often (`meta.rehearse_checked`).
pub const CHECK_EVERY: f64 = 3_600.0;

/// The repos due a rehearsal at `now`: ` ```live ` in the base branch's `TOWERCAB.md` (from
/// Towercab's clone), no unfinished mission, none rehearsed in the last 7 days.
pub fn due(conn: &Connection, config: &Config, now: f64) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for (name, repo) in &config.repos {
        let Ok(repo) = repo else { continue };
        let (busy, last): (bool, Option<f64>) = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM missions WHERE repo = ?1
                    AND stage NOT IN ('done', 'stopped')),
                   (SELECT MAX(created) FROM missions WHERE repo = ?1 AND kind = 'rehearsal')",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql)?;
        if busy || last.is_some_and(|t| now - t < EVERY) || !repo.path.exists() {
            continue;
        }
        if crate::repo::load(&repo.path, &repo.base).is_ok_and(|f| f.towercab.live.is_some()) {
            out.push(name.clone());
        }
    }
    Ok(out)
}

/// In the pick slot of an idle pass (the loop): at most every [`CHECK_EVERY`] s, one
/// rehearsal mission for the first due repo: `kind` rehearsal, `stage` rehearse, `intent`
/// NULL, `checkout` `work/rehearse-<repo>-<yymmdd>`, `branch` `towercab/rehearse-<yymmdd>`,
/// `model` `[agent].model`, a new session. Returns its id.
pub fn schedule(db: &Db, config: &Config, tick: Tick) -> Result<Option<i64>, String> {
    let now = tick.unix();
    db.tx(|tx| {
        let checked = get_meta(tx, "rehearse_checked")?
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(f64::MIN);
        if now - checked < CHECK_EVERY {
            return Ok(None);
        }
        set_meta(tx, "rehearse_checked", &now.to_string())?;
        let Some(repo) = due(tx, config, now)?.into_iter().next() else {
            return Ok(None);
        };
        let day = tick.wall.format("%y%m%d").to_string();
        tx.execute(
            "INSERT INTO missions (kind, intent, repo, attempt, stage, step, model, session,
               checkout, branch, created, updated)
             VALUES ('rehearsal', NULL, ?1, 1, 'rehearse', 'enter', ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                repo,
                config.agent.model,
                uuid::Uuid::new_v4().to_string(),
                format!("work/rehearse-{repo}-{day}"),
                format!("towercab/rehearse-{day}"),
                now
            ],
        )
        .map_err(sql)?;
        Ok(Some(tx.last_insert_rowid()))
    })
}

/// The `rehearse` stage.
pub struct Rehearse {
    mode: Mode,
}

impl Rehearse {
    pub fn new(mode: Mode) -> Rehearse {
        Rehearse { mode }
    }

    fn rehearsal(m: &Mission) -> Value {
        Data::of(m).get("rehearsal").cloned().unwrap_or(json!({}))
    }

    /// The checkout on the branch, fresh from `origin/<base>`; its head is what gets reverted.
    fn checkout(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
        let branch = m
            .branch
            .clone()
            .ok_or_else(|| StepError::Bug(format!("{}: no branch", m.label())))?;
        let m = cx.record(m, "checkout", &[])?;
        pgit::fetch_branch(cx, &m, &repo.base)?;
        let dir = cx.checkout(&m);
        checkout::ensure(&cx.exes.git, &repo.path, &dir, &repo.base, &branch)
            .map_err(pgit::failed)?;
        checkout::refresh_base(&cx.exes.git, &repo.path, &dir, &repo.base).map_err(pgit::failed)?;
        let base = format!("refs/remotes/origin/{}", repo.base);
        pgit::run(
            cx,
            &dir,
            &["checkout", "--quiet", "--force", "-B", &branch, &base],
        )?;
        let sha = pgit::rev(cx, &dir, "HEAD")?;
        let mut data = Data::of(&m);
        data.set("rehearsal", json!({"sha": sha}));
        let m = cx.record(&m, "revert", &[("data", data.text().into())])?;
        self.revert(cx, &m)
    }

    fn revert(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let r = Self::rehearsal(m);
        let sha = r["sha"].as_str().unwrap_or_default().to_string();
        let dir = cx.checkout(m);
        if !pgit::reverts(cx, &dir, &sha) && !pgit::revert(cx, &dir, &sha, self.mode.eval())? {
            return Ok(Progress::Done(Outcome::red(format!(
                "revert of {} conflicts",
                short(&sha)
            ))));
        }
        let m = cx.record(m, "push", &[])?;
        self.push(cx, &m)
    }

    fn push(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let branch = m.branch.clone().unwrap_or_default();
        let dir = cx.checkout(m);
        match pgit::push(cx, m, &dir, &branch)? {
            pgit::Push::Pushed(head) => {
                let mut r = Self::rehearsal(m);
                r["head"] = json!(head);
                r["pushed_at"] = json!(cx.tick.unix());
                let mut data = Data::of(m);
                data.set("rehearsal", r);
                let m = cx.record(m, "pr", &[("data", data.text().into())])?;
                self.pr(cx, &m)
            }
            pgit::Push::Rejected(e) | pgit::Push::Refused(e) => {
                Ok(Progress::Done(Outcome::red(format!(
                    "push of {branch} rejected: {}",
                    crate::outbox::cut(&crate::outbox::one_line(&e), 200)
                ))))
            }
        }
    }

    fn pr(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let mut r = Self::rehearsal(m);
        let sha = r["sha"].as_str().unwrap_or_default().to_string();
        let branch = m.branch.clone().unwrap_or_default();
        let base = cx.repo(m).map_err(StepError::Bug)?.base.clone();
        let body = format!(
            "Rollback rehearsal (PIP-35): reverts {} on {base}. Never merged: Towercab closes it \
             and deletes the branch after CI.\n",
            short(&sha)
        );
        let title = format!("rehearsal: revert {}", short(&sha));
        let (n, url) = open_pr(cx, m, &branch, &title, &body, true)?;
        r["pr"] = json!(n);
        r["url"] = json!(url);
        let mut data = Data::of(m);
        data.set("rehearsal", r);
        let m = cx.record(
            m,
            "command",
            &[("data", data.text().into()), ("pr_url", url.into())],
        )?;
        self.command(cx, &m)
    }

    /// The ` ```rollback ` block's `rehearse`, `<sha>` = the reverted head's parent.
    fn command(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let repo = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let Some(block) = repo.towercab.rollback else {
            return Ok(Progress::Done(Outcome::ok()));
        };
        let sha = Self::rehearsal(m)["sha"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let dir = cx.checkout(m);
        let parent = pgit::rev(cx, &dir, &format!("{sha}^1"))?;
        let mut data = Data::of(m);
        let n = data.next_n("rehearse");
        let m = cx.record(m, "command", &[("data", data.text().into())])?;
        let runs = cx.runs(&m);
        std::fs::create_dir_all(&runs)
            .map_err(|e| StepError::Bug(format!("{}: {e}", runs.display())))?;
        let log = runs.join(format!("rehearse-{n}.log"));
        let line = block.rehearse.replace("<sha>", &parent);
        Ok(Progress::Spawn(sandbox::repo_command(
            cx, &m, &dir, &line, &log,
        )?))
    }
}

impl Handler for Rehearse {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let valid = checkout::valid(&cx.exes.git, &cx.checkout(m));
        match m.step.as_str() {
            "revert" if valid => self.revert(cx, m),
            "push" if valid => self.push(cx, m),
            "pr" => self.pr(cx, m),
            "command" if valid => self.command(cx, m),
            _ => self.checkout(cx, m),
        }
    }

    fn finish(
        &mut self,
        _: &mut Ctx<'_>,
        _: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        Ok(Progress::Done(match failure(&end) {
            Some(why) => Outcome::red(format!("rehearse command: {why}")),
            None => Outcome::ok(),
        }))
    }
}

/// The `rehearse_close` stage: `gh pr close <n> --delete-branch` (a refusal is logged); `ok`.
pub struct RehearseClose {
    mode: Mode,
}

impl RehearseClose {
    pub fn new(mode: Mode) -> RehearseClose {
        RehearseClose { mode }
    }
}

impl Handler for RehearseClose {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let pr = Data::of(m)
            .get("rehearsal")
            .and_then(|r| r.get("pr"))
            .and_then(Value::as_u64);
        if let Some(n) = pr {
            let github = gh::github(cx, m)?;
            let n = n.to_string();
            if let Err(e) = gh::try_gh(
                cx,
                m,
                &["pr", "close", &n, "-R", &github, "--delete-branch"],
            )? {
                eprintln!(
                    "towercab: {}: gh pr close {n}: {}",
                    m.label(),
                    crate::outbox::one_line(&e)
                );
            }
        }
        Ok(Progress::Done(Outcome::ok()))
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!(
            "{}: rehearse_close runs no child",
            m.label()
        )))
    }
}
