//! Release gate (PIP-34): a repo whose `TOWERCAB.md` has a ` ```release ` block treats
//! ` ```live ` as staging; after staging e2e is green it waits for me (`authorize release`).
//! `towercab release <id>` brings it here: `command` once (`<sha>` = the merge), then the
//! production deploy as PIP-8 sees one, then its `e2e` once. No automatic revert in production.

use serde_json::{Value, json};

use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::Waiting;
use crate::mission::Mission;
use crate::repo::Release as Block;

use super::data::Data;
use super::deploy::{DEPLOY_POLL, behind_other, contains, deployed, short};
use super::e2e::{self as e2e_mod, E2eEnd, at_sha, last_log, settle};
use super::verify::tail;
use super::{Mode, evals, files, sandbox};

/// The `release` stage.
pub struct Release {
    mode: Mode,
}

impl Release {
    pub fn new(mode: Mode) -> Release {
        Release { mode }
    }

    /// The release block in force (ignored without ` ```live `), and the merge.
    fn block(
        cx: &Ctx<'_>,
        m: &Mission,
    ) -> Result<Result<Option<(Block, String)>, Outcome>, StepError> {
        let repo = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Err(o)),
        };
        let Some(block) = repo
            .towercab
            .release
            .filter(|_| repo.towercab.live.is_some())
        else {
            return Ok(Ok(None));
        };
        let merge = m
            .merge_sha
            .clone()
            .ok_or_else(|| StepError::Bug(format!("{}: no merge sha to release", m.label())))?;
        Ok(Ok(Some((block, merge))))
    }

    /// On its way to `done`: the eval case (PIP-33; not in an eval), then `ok`.
    fn done(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if !self.mode.eval() {
            evals::write_case(cx, m)?;
        }
        Ok(Progress::Done(Outcome::ok()))
    }

    /// Waits until production shows the merge (PIP-8 rules, the block's `deploy` and
    /// `timeout`), then its `e2e` once.
    fn wait(
        &self,
        cx: &Ctx<'_>,
        m: &Mission,
        block: &Block,
        merge: &str,
    ) -> Result<Progress, StepError> {
        let now = cx.tick.unix();
        let mut data = Data::of(m);
        let mut r = data.get("release").cloned().unwrap_or(json!({}));
        if m.step != "wait" {
            r["since"] = json!(now);
        }
        if let Some(sha) = deployed(cx, m, &block.deploy)?
            && contains(cx, m, merge, &sha)?
        {
            crate::indicators::deployed(cx, m, "production");
            data.set("release", r);
            let Some(line) = &block.e2e else {
                let m = cx.record(m, "wait", &[("data", data.text().into())])?;
                return self.done(cx, &m);
            };
            let dir = at_sha(cx, m, merge)?;
            return e2e_mod::spawn(cx, m, &mut data, "e2e", &dir, line);
        }
        let since = r.get("since").and_then(Value::as_f64).unwrap_or(now);
        let mins = block.timeout_min;
        if cx.timeouts && now - since >= f64::from(mins) * 60.0 {
            data.set("release", r);
            return Ok(Progress::Done(
                Outcome::wait(
                    Waiting::DeployNotSeen,
                    format!("production: {} not deployed after {mins} min", short(merge)),
                )
                .with("data", data.text()),
            ));
        }
        data.set("release", r);
        cx.record(m, "wait", &[("data", data.text().into())])?;
        Ok(Progress::Poll { after: DEPLOY_POLL })
    }
}

impl Handler for Release {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return self.done(cx, m);
        }
        e2e_mod::scrub(cx, m);
        let (block, merge) = match Self::block(cx, m)? {
            Err(o) => return Ok(Progress::Done(o)),
            Ok(None) => return self.done(cx, m),
            Ok(Some(b)) => b,
        };
        if behind_other(cx, m)? {
            cx.record(m, "queued", &[])?;
            return Ok(Progress::Poll { after: DEPLOY_POLL });
        }
        match m.step.as_str() {
            // The production e2e again after a cut-off (it runs once: a re-run, not a retry).
            "e2e" => {
                let line = block.e2e.clone().unwrap_or_default();
                let dir = at_sha(cx, m, &merge)?;
                let mut data = Data::of(m);
                e2e_mod::spawn(cx, m, &mut data, "e2e", &dir, &line)
            }
            "wait" => self.wait(cx, m, &block, &merge),
            step => {
                let mut data = Data::of(m);
                let ran = data
                    .get("release")
                    .and_then(|r| r.get("ran"))
                    .and_then(Value::as_str)
                    == Some(merge.as_str());
                // `command` once per merge (recorded right before its spawn): entered again
                // (deploy not seen, a cut-off) it only waits; a spawn that never happened (its
                // log never made: a crash, a refused start) runs it then.
                let log = |n: u32| cx.runs(m).join(format!("release-{n}.log"));
                let n = data.n("release");
                if ran && (step != "command" || log(n).exists()) {
                    return self.wait(cx, m, &block, &merge);
                }
                let n = if ran { n } else { data.next_n("release") };
                let dir = at_sha(cx, m, &merge)?;
                let runs = cx.runs(m);
                std::fs::create_dir_all(&runs)
                    .map_err(|e| StepError::Bug(format!("{}: {e}", runs.display())))?;
                let line = block.command.replace("<sha>", &merge);
                let spec = sandbox::repo_command(cx, m, &dir, &line, &log(n))?;
                data.set("release", json!({"ran": merge, "since": cx.tick.unix()}));
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
        let (block, merge) = match Self::block(cx, m)? {
            Err(o) => return Ok(Progress::Done(o)),
            Ok(None) => return self.done(cx, m),
            Ok(Some(b)) => b,
        };
        match m.step.as_str() {
            "command" => {
                if end.timed_out || end.status.and_then(|s| s.code()) != Some(0) {
                    let err = tail(&end.stderr, 4000);
                    let why = match err.lines().rev().find(|l| !l.trim().is_empty()) {
                        Some(l) => l.trim().to_string(),
                        None if end.timed_out => "timed out".into(),
                        None => format!(
                            "exit {}",
                            end.status
                                .and_then(|s| s.code())
                                .map_or("unknown".into(), |c| c.to_string())
                        ),
                    };
                    // Not ran: my continue runs the command again (PIP-17).
                    let mut data = Data::of(m);
                    data.set("release", json!({}));
                    return Ok(Progress::Done(
                        Outcome::wait(
                            Waiting::ReleaseFailed,
                            crate::outbox::cut(&crate::outbox::one_line(&why), 300),
                        )
                        .with("data", data.text()),
                    ));
                }
                self.wait(cx, m, &block, &merge)
            }
            "e2e" => {
                let line = block.e2e.clone().unwrap_or_default();
                match settle(cx, m, &line, &end, &last_log(cx, m)) {
                    E2eEnd::Green => self.done(cx, m),
                    E2eEnd::Env(fault, why) => Ok(Progress::Done(Outcome::env(fault, why))),
                    E2eEnd::Red(why) => Ok(Progress::Done(Outcome::wait(
                        Waiting::ProductionE2eRed,
                        format!("production e2e: {why}"),
                    ))),
                }
            }
            s => Err(StepError::Bug(format!("release: no child at {s}"))),
        }
    }
}
