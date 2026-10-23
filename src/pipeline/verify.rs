//! Verify (PIP-23): after each build or repair, in code: the base branch's ` ```setup ` lines
//! (sandboxed with network and the repo's cache), then its ` ```checks ` lines in order under the sandbox, one child
//! per line (steps `setup:<i>`, `check:<i>`). Red → the output to the worker session as a
//! verify repair (cap 3, then `waiting: checks red`). [`run_lines`] is shared with the proof
//! (PIP-30).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use crate::handler::{ChildEnd, ChildKind, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::Waiting;
use crate::mission::Mission;

use super::data::Data;
use super::{Mode, files, git as pgit, sandbox, wait_note};

/// How much of a red command's output goes to the worker (and `repair.findings`).
pub const TAIL: usize = 16_000;

/// The rerun after a failed setup (or a proof's environment failure).
pub const AGAIN_AFTER: Duration = Duration::from_secs(60);

/// The last `bytes` of `path` (lossy UTF-8; missing: empty).
pub fn tail(path: &Path, bytes: usize) -> String {
    let all = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(&all[all.len().saturating_sub(bytes)..]).into_owned()
}

/// The commands of one run: setup lines then checks lines (both sandboxed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lines {
    pub setup: Vec<String>,
    pub checks: Vec<String>,
}

impl Lines {
    /// The base branch's verifying block, blank lines dropped.
    pub fn of(setup: &[String], checks: &[String]) -> Lines {
        let keep = |v: &[String]| {
            v.iter()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        };
        Lines {
            setup: keep(setup),
            checks: keep(checks),
        }
    }

    /// The step of global line `k` (1-based): `setup:<i>` or `check:<j>`.
    pub fn step(&self, k: usize) -> String {
        if k <= self.setup.len() {
            format!("setup:{k}")
        } else {
            format!("check:{}", k - self.setup.len())
        }
    }

    /// A line step (`setup:<i>`, `check:<j>`, either with `:again`) → (global k, again).
    pub fn parse(&self, step: &str) -> Option<(usize, bool)> {
        let (step, again) = match step.strip_suffix(":again") {
            Some(s) => (s, true),
            None => (step, false),
        };
        let (kind, i) = step.split_once(':')?;
        let i: usize = i.parse().ok().filter(|i| *i >= 1)?;
        let k = match kind {
            "setup" if i <= self.setup.len() => i,
            "check" if i <= self.checks.len() => self.setup.len() + i,
            _ => return None,
        };
        Some((k, again))
    }

    /// Line `k`: (is setup, text).
    pub fn line(&self, k: usize) -> (bool, &str) {
        if k <= self.setup.len() {
            (true, &self.setup[k - 1])
        } else {
            (false, &self.checks[k - 1 - self.setup.len()])
        }
    }

    pub fn len(&self) -> usize {
        self.setup.len() + self.checks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A run of [`Lines`] in a directory, logged as `<family>-<n>-<k>.log` (+ `.err`) and
/// together in `<family>-<n>.log` (`$ <command>` before each output).
#[derive(Debug, Clone)]
pub struct Runner {
    /// `verify` or `proof`.
    pub family: &'static str,
    pub dir: PathBuf,
    pub lines: Lines,
}

/// How one line ended.
#[derive(Debug, Clone, PartialEq)]
pub enum LineEnd {
    /// The next line runs.
    Next(Progress),
    /// Every line passed: how many checks ran.
    Green(usize),
    /// A setup line failed (`again`: it was the rerun).
    SetupRed {
        line: String,
        why: String,
        again: bool,
    },
    /// A check failed; `env`: a timeout or exit 126/127 (the command couldn't run).
    CheckRed {
        line: String,
        why: String,
        env: bool,
        again: bool,
        k: usize,
    },
}

impl Runner {
    /// Its number (`n.<family>`, **Mission data**).
    pub fn n(&self, m: &Mission) -> u32 {
        Data::of(m).n(self.family)
    }

    /// `<family>-<n>.log`.
    pub fn log(&self, cx: &Ctx<'_>, m: &Mission) -> PathBuf {
        cx.runs(m)
            .join(format!("{}-{}.log", self.family, self.n(m)))
    }

    fn line_log(&self, cx: &Ctx<'_>, m: &Mission, k: usize) -> PathBuf {
        cx.runs(m)
            .join(format!("{}-{}-{k}.log", self.family, self.n(m)))
    }

    /// A new run: `n.<family>` + 1 (and `data.<key>` = `state` unless null), recorded with its
    /// first line's step → that line. No lines at all → `Green(0)`.
    pub fn start(
        &self,
        cx: &Ctx<'_>,
        m: &Mission,
        key: &str,
        state: Value,
    ) -> Result<LineEnd, StepError> {
        let mut data = Data::of(m);
        data.next_n(self.family);
        if !state.is_null() {
            data.set(key, state);
        }
        if self.lines.is_empty() {
            cx.record(m, m.step.as_str(), &[("data", data.text().into())])?;
            return Ok(LineEnd::Green(0));
        }
        let m = cx.record(m, &self.lines.step(1), &[("data", data.text().into())])?;
        std::fs::create_dir_all(cx.runs(&m))
            .map_err(|e| StepError::Bug(format!("{}: {e}", cx.runs(&m).display())))?;
        let _ = std::fs::remove_file(self.log(cx, &m));
        self.spawn(cx, &m).map(LineEnd::Next)
    }

    /// The line of `m.step` as a child (a re-entry, or the rerun).
    pub fn spawn(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let (k, _) = self
            .lines
            .parse(&m.step)
            .ok_or_else(|| StepError::Bug(format!("{}: no line at {}", self.family, m.step)))?;
        let (setup, line) = self.lines.line(k);
        let log = self.line_log(cx, m, k);
        let spec = if setup {
            sandbox::setup_spec(cx, m, &self.dir, line, &log)?
        } else {
            sandbox::command(cx, m, ChildKind::Checks, &self.dir, line, &log)?
        };
        Ok(Progress::Spawn(spec))
    }

    /// The line at `m.step` ended: its output appended to `<family>-<n>.log`, then the next
    /// line, or how the run ended.
    pub fn ended(&self, cx: &Ctx<'_>, m: &Mission, end: &ChildEnd) -> Result<LineEnd, StepError> {
        let (k, again) = self
            .lines
            .parse(&m.step)
            .ok_or_else(|| StepError::Bug(format!("{}: no line at {}", self.family, m.step)))?;
        let (setup, line) = self.lines.line(k);
        let mut out = std::fs::read(&end.stdout).unwrap_or_default();
        out.extend(std::fs::read(&end.stderr).unwrap_or_default());
        let combined = self.log(cx, m);
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&combined)
            .map_err(|e| StepError::Bug(format!("{}: {e}", combined.display())))?;
        let _ = writeln!(f, "$ {line}");
        let _ = f.write_all(&out);
        if !out.ends_with(b"\n") && !out.is_empty() {
            let _ = writeln!(f);
        }
        let code = end.status.and_then(|s| s.code());
        let failed = end.timed_out || code != Some(0);
        if !failed {
            if k == self.lines.len() {
                return Ok(LineEnd::Green(self.lines.checks.len()));
            }
            let m = cx.record(m, &self.lines.step(k + 1), &[])?;
            return self.spawn(cx, &m).map(LineEnd::Next);
        }
        let why = if end.timed_out {
            let mins = cx.config.agent.check_timeout.as_secs().div_ceil(60);
            format!("{line}: timed out after {mins} min")
        } else {
            match code {
                Some(c) => format!("{line}: exit {c}"),
                None => format!("{line}: killed"),
            }
        };
        let line = line.to_string();
        Ok(if setup {
            LineEnd::SetupRed { line, why, again }
        } else {
            LineEnd::CheckRed {
                line,
                why,
                env: end.timed_out || matches!(code, Some(126 | 127)),
                again,
                k,
            }
        })
    }

    /// Line `k`'s own output (stdout + stderr), its last [`TAIL`] bytes.
    pub fn output(&self, cx: &Ctx<'_>, m: &Mission, k: usize) -> String {
        let log = self.line_log(cx, m, k);
        let mut s = tail(&log, TAIL);
        s.push_str(&tail(&sandbox::err_of(&log), TAIL));
        let cut = s.len().saturating_sub(TAIL);
        let cut = (cut..=s.len())
            .find(|i| s.is_char_boundary(*i))
            .unwrap_or(0);
        s[cut..].to_string()
    }

    /// The rerun of the line at `m.step` after [`AGAIN_AFTER`] (step `<step>:again`).
    pub fn again(&self, cx: &Ctx<'_>, m: &Mission, data: &Data) -> Result<Progress, StepError> {
        let step = format!("{}:again", m.step.trim_end_matches(":again"));
        cx.record(m, &step, &[("data", data.text().into())])?;
        Ok(Progress::Poll { after: AGAIN_AFTER })
    }
}

/// [`Runner`] of the base's verifying block in `dir` (`Err`: the repo files' wait).
pub fn run_lines(
    cx: &Ctx<'_>,
    m: &Mission,
    family: &'static str,
    dir: &Path,
) -> Result<Result<Runner, Outcome>, StepError> {
    let f = match files(cx, m) {
        Ok(f) => f,
        Err(o) => return Ok(Err(o)),
    };
    Ok(Ok(Runner {
        family,
        dir: dir.to_path_buf(),
        lines: Lines::of(&f.verifying.setup, &f.verifying.checks),
    }))
}

/// A red verify (or proof), `why` in one line: `verify_repairs` ≥ 3 → `wait` (with its note);
/// else `red` with `repair {what, findings, log}` for the worker and `verify_repairs + 1`.
#[allow(clippy::too_many_arguments)]
pub fn repair_or_wait(
    cx: &Ctx<'_>,
    m: &Mission,
    data: &mut Data,
    w: Waiting,
    what: &str,
    why: &str,
    findings: &str,
    log: &Path,
) -> Result<Progress, StepError> {
    let why = crate::outbox::cut(&crate::outbox::one_line(why), 300);
    if m.verify_repairs >= 3 {
        let m = cx.record(m, &m.step, &[("data", data.text().into())])?;
        let note = format!(
            "{what} after 3 repairs. The output: {}. Fix it on the branch or say how in intent.md, then remove `waiting`.",
            log.display()
        );
        return wait_note(cx, &m, w, &why, &note);
    }
    let log = std::path::absolute(log).unwrap_or_else(|_| log.to_path_buf());
    data.set(
        "repair",
        json!({"what": what, "findings": findings, "log": log.to_string_lossy()}),
    );
    Ok(Progress::Done(
        Outcome::red(why)
            .with("verify_repairs", i64::from(m.verify_repairs) + 1)
            .with("data", data.text()),
    ))
}

/// The `verify` stage (the same in `Mode::Eval`).
pub struct Verify;

impl Verify {
    pub fn new(_mode: Mode) -> Verify {
        Verify
    }

    fn runner(cx: &Ctx<'_>, m: &Mission) -> Result<Result<Runner, Outcome>, StepError> {
        run_lines(cx, m, "verify", &cx.checkout(m))
    }

    fn settle(
        &self,
        cx: &Ctx<'_>,
        m: &Mission,
        r: &Runner,
        end: LineEnd,
    ) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        match end {
            LineEnd::Next(p) => Ok(p),
            LineEnd::Green(k) => {
                let head = pgit::rev(cx, &cx.checkout(m), "HEAD")?;
                let s = if k == 1 { "" } else { "s" };
                data.set(
                    "verify",
                    json!({"head": head, "line": format!("green ({k} command{s})"), "n": r.n(m)}),
                );
                data.set("repair", Value::Null);
                Ok(Progress::Done(Outcome::ok().with("data", data.text())))
            }
            LineEnd::SetupRed { again: false, .. } => r.again(cx, m, &data),
            LineEnd::SetupRed { line, why, .. } => {
                let k = r.lines.parse(&m.step).map_or(1, |(k, _)| k);
                let findings = format!("setup failed: $ {line}\n{}\n{why}", r.output(cx, m, k));
                repair_or_wait(
                    cx,
                    m,
                    &mut data,
                    Waiting::ChecksRed,
                    "checks red",
                    &format!("setup: {why}"),
                    &findings,
                    &r.log(cx, m),
                )
            }
            LineEnd::CheckRed { line, why, k, .. } => {
                let findings = format!("$ {line}\n{}\n{why}", r.output(cx, m, k));
                repair_or_wait(
                    cx,
                    m,
                    &mut data,
                    Waiting::ChecksRed,
                    "checks red",
                    &why,
                    &findings,
                    &r.log(cx, m),
                )
            }
        }
    }
}

impl Handler for Verify {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let r = match Self::runner(cx, m)? {
            Ok(r) => r,
            Err(o) => return Ok(Progress::Done(o)),
        };
        if r.lines.parse(&m.step).is_some() {
            return r.spawn(cx, m);
        }
        let end = r.start(cx, m, "verify", Value::Null)?;
        let m = crate::mission::get(cx.db.conn(), m.id)?;
        self.settle(cx, &m, &r, end)
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
        self.settle(cx, &m, &r, line)
    }
}
