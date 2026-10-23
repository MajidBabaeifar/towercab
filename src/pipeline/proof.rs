//! The red→green proof (PIP-30): after a green verify of a behaviour change (`spec_ids` or a
//! `fix`), the PR's changed test files laid over a checkout of `origin/<base>`
//! (`work/<id>-<attempt>-proof`) must make the ` ```checks ` red with ` ```setup ` green. Base
//! green, or no test changed → back to the worker as a verify repair; the environment failing
//! on base (setup red, a timeout, exit 126/127) → rerun once after 60 s, then `waiting: tests
//! don't prove the change`.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::checkout;
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::Waiting;
use crate::mission::Mission;
use crate::repo::Towercab;
use crate::repo::protected::glob;

use super::data::Data;
use super::schemas::DesignResult;
use super::verify::{LineEnd, Runner, repair_or_wait, run_lines};
use super::{Mode, files, git as pgit, wait_note};

/// What the worker hears when its tests pass on base.
pub const BASE_GREEN: &str = "your tests pass without your change";

/// The test files the PR changed (not deleted) since the merge-base with `base`, matching the
/// `tests` globs of `TOWERCAB.md`.
pub fn test_files(
    cx: &Ctx<'_>,
    dir: &Path,
    base: &str,
    towercab: &Towercab,
) -> Result<Vec<String>, StepError> {
    let globs: Vec<_> = towercab.tests.iter().filter_map(|g| glob(g).ok()).collect();
    let from = pgit::merge_base(cx, dir, base)?;
    Ok(pgit::changed(cx, dir, &from, "HEAD")?
        .into_iter()
        .filter(|(st, p)| *st != 'D' && globs.iter().any(|g| g.is_match(p)))
        .map(|(_, p)| p)
        .collect())
}

/// `work/<id>-<attempt>-proof`.
pub fn overlay_path(cx: &Ctx<'_>, m: &Mission) -> PathBuf {
    cx.home.root.join(format!("{}-proof", m.checkout))
}

/// The proof checkout: `checkout::create` of the clone's `origin/<base>` at [`overlay_path`]
/// (an old one removed), with `files` copied over from the mission checkout (symlinks skipped).
pub fn overlay(cx: &Ctx<'_>, m: &Mission, files: &[String]) -> Result<PathBuf, StepError> {
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let dir = overlay_path(cx, m);
    checkout::remove(&dir).map_err(StepError::Bug)?;
    checkout::create(&cx.exes.git, &repo.path, &dir, &repo.base, "towercab-proof")
        .map_err(pgit::failed)?;
    let from = cx.checkout(m);
    for rel in files {
        let src = from.join(rel);
        let is_file = std::fs::symlink_metadata(&src).is_ok_and(|md| md.file_type().is_file());
        if !is_file {
            continue;
        }
        let dst = dir.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| StepError::Bug(format!("{}: {e}", parent.display())))?;
        }
        std::fs::copy(&src, &dst).map_err(|e| StepError::Bug(format!("{}: {e}", dst.display())))?;
    }
    Ok(dir)
}

/// The proof's one rerun after 60 s was used (`proof.retried`).
fn retried(data: &Data) -> bool {
    data.get("proof")
        .and_then(|p| p.get("retried"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A proof is due: the design changed spec rows or its type is `fix` (no design: no).
pub fn due(data: &Data) -> bool {
    data.get("design")
        .and_then(|d| DesignResult::from_json(d).ok())
        .is_some_and(|d| !d.spec_ids.is_empty() || d.kind == "fix")
}

/// The `proof` stage (the same in `Mode::Eval`).
pub struct Proof;

impl Proof {
    pub fn new(_mode: Mode) -> Proof {
        Proof
    }

    fn runner(cx: &Ctx<'_>, m: &Mission) -> Result<Result<Runner, Outcome>, StepError> {
        run_lines(cx, m, "proof", &overlay_path(cx, m))
    }

    /// The test files recorded at the start (`data.proof.files`).
    fn files_of(m: &Mission) -> Vec<String> {
        Data::of(m)
            .get("proof")
            .and_then(|p| p.get("files"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Base green (or no test changed): back to the worker as a verify repair.
    fn base_green(
        cx: &Ctx<'_>,
        m: &Mission,
        why: &str,
        findings: &str,
        log: &Path,
    ) -> Result<Progress, StepError> {
        let _ = checkout::remove(&overlay_path(cx, m));
        let mut data = Data::of(m);
        repair_or_wait(
            cx,
            m,
            &mut data,
            Waiting::TestsDontProve,
            BASE_GREEN,
            why,
            findings,
            log,
        )
    }

    fn settle(cx: &Ctx<'_>, m: &Mission, r: &Runner, end: LineEnd) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        let head = || pgit::rev(cx, &cx.checkout(m), "HEAD");
        match end {
            LineEnd::Next(p) => Ok(p),
            LineEnd::Green(_) => {
                let files = Self::files_of(m).join(", ");
                let findings = format!(
                    "the checks pass on {} with only your test files ({files}) laid over it: they don't fail without your change. Make them test the change.",
                    cx.repo(m).map(|r| r.base.clone()).unwrap_or_default()
                );
                Self::base_green(cx, m, BASE_GREEN, &findings, &r.log(cx, m))
            }
            LineEnd::CheckRed {
                line, env: false, ..
            } => {
                let _ = checkout::remove(&overlay_path(cx, m));
                data.set(
                    "proof",
                    json!({"head": head()?, "line": format!("red on base: {line}"), "n": r.n(m)}),
                );
                Ok(Progress::Done(Outcome::ok().with("data", data.text())))
            }
            // Once per proof, not per line (PIP-30).
            LineEnd::SetupRed { again: false, .. } | LineEnd::CheckRed { again: false, .. }
                if !retried(&data) =>
            {
                if let Some(Value::Object(p)) = data.0.get_mut("proof") {
                    p.insert("retried".into(), Value::Bool(true));
                }
                r.again(cx, m, &data)
            }
            LineEnd::SetupRed { why, .. } | LineEnd::CheckRed { why, .. } => {
                let _ = checkout::remove(&overlay_path(cx, m));
                let why = format!("on base: {why}");
                let note = format!(
                    "The red→green proof couldn't run on base ({why}); its log: {}. Fix the repo's setup or checks, or remove `waiting` to try again.",
                    r.log(cx, m).display()
                );
                let m = cx.record(m, &m.step, &[("data", data.text().into())])?;
                wait_note(cx, &m, Waiting::TestsDontProve, &why, &note)
            }
        }
    }
}

impl Handler for Proof {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        if !due(&data) {
            data.set(
                "proof",
                json!({"line": "skipped: no behaviour change", "n": 0}),
            );
            return Ok(Progress::Done(Outcome::ok().with("data", data.text())));
        }
        let r = match Self::runner(cx, m)? {
            Ok(r) => r,
            Err(o) => return Ok(Progress::Done(o)),
        };
        if r.lines.parse(&m.step).is_some() {
            // A re-entry or the rerun: the overlay as it was, re-made if gone.
            if !checkout::valid(&cx.exes.git, &r.dir) {
                overlay(cx, m, &Self::files_of(m))?;
            }
            return r.spawn(cx, m);
        }
        let repo_files = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let base = cx.repo(m).map_err(StepError::Bug)?.base.clone();
        let tests = test_files(cx, &cx.checkout(m), &base, &repo_files.towercab)?;
        if tests.is_empty() {
            let m = cx.record(m, "proof", &[])?;
            return Self::base_green(
                cx,
                &m,
                "no test file changed",
                "no test file changed: write a test that fails without your change",
                &cx.runs(&m)
                    .join(format!("verify-{}.log", Data::of(&m).n("verify"))),
            );
        }
        overlay(cx, m, &tests)?;
        let end = r.start(cx, m, "proof", json!({ "files": tests }))?;
        let m = crate::mission::get(cx.db.conn(), m.id)?;
        Self::settle(cx, &m, &r, end)
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        let r = match Self::runner(cx, m)? {
            Ok(r) => r,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let line = r.ended(cx, m, &end)?;
        let m = crate::mission::get(cx.db.conn(), m.id)?;
        Self::settle(cx, &m, &r, line)
    }
}
