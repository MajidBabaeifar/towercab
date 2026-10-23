//! e2e (PIP-9, PIP-20): once the deploy is seen, the ` ```live ` `e2e` command runs in a
//! checkout of the merge commit under the sandbox with network, its env HOME, PATH, LANG plus
//! the repo's secrets file (mode 0600), its output redacted. Red → one rerun after 60 s. Red
//! twice: Towercab's merge → `red` (the revert, PIP-19); mine → a read-only triage run, and code
//! decides ([`super::triage::decide`]). A revert's e2e (`revert_e2e`): green → `reverted,
//! refine`; red twice → `revert failed`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use crate::checkout;
use crate::claude::{ClaudeResult, RunKind};
use crate::config::Config;
use crate::env::Fault;
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::{Door, Event, Waiting};
use crate::mission::Mission;

use super::ci::Seq;
use super::data::Data;
use super::deploy::{DEPLOY_POLL, behind_other, merge_of, short};
use super::review::{limit_once, review_model};
use super::runs::{self, Ended, Start};
use super::schemas::{TRIAGE, TriageResult};
use super::verify::{TAIL, tail};
use super::{Mode, files, git as pgit, sandbox, triage, wait_note};

/// The one rerun of a red e2e comes this long after it.
pub const RERUN_AFTER: Duration = Duration::from_secs(60);

/// What replaces a secret value in e2e output.
pub const REDACTED: &str = "[redacted]";

/// `secrets/<repo>.env` next to the config file (`~/.config/towercab/secrets/<repo>.env`).
pub fn secrets_file(config: &Config, repo: &str) -> PathBuf {
    config
        .file
        .parent()
        .unwrap_or(Path::new("."))
        .join("secrets")
        .join(format!("{repo}.env"))
}

/// The secrets file's `KEY=VALUE` lines (blank lines and `#` comments skipped; a value in
/// matching quotes unquoted); absent → none. Readable by group or others (mode not 0600) or a
/// bad line → `Err` (the e2e is refused, `env_blocked`).
pub fn secrets(file: &Path) -> Result<Vec<(String, String)>, String> {
    read_secrets(file).map(|(kv, _)| kv)
}

/// [`secrets`] and the sha256 of the bytes they were parsed from (absent: of none), read once.
pub fn read_secrets(file: &Path) -> Result<(Vec<(String, String)>, String), String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = match std::fs::metadata(file) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), sha256(b"")));
        }
        Err(e) => return Err(format!("{}: {e}", file.display())),
    };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(format!(
            "{}: mode {mode:o}, readable by others: chmod 600",
            file.display()
        ));
    }
    let bytes = std::fs::read(file).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok((parse_secrets(file, &bytes)?, sha256(&bytes)))
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The `KEY=VALUE` lines of a secrets file's `bytes`.
fn parse_secrets(file: &Path, bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let text = std::str::from_utf8(bytes).map_err(|e| format!("{}: {e}", file.display()))?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let bad = || format!("{}: line {}: want KEY=VALUE", file.display(), i + 1);
        let (k, v) = line.split_once('=').ok_or_else(bad)?;
        let k = k.trim();
        if k.is_empty()
            || k.starts_with(|c: char| c.is_ascii_digit())
            || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(bad());
        }
        let v = v.trim();
        let v = ['"', '\'']
            .iter()
            .find_map(|q| {
                v.strip_prefix(*q)
                    .and_then(|r| r.strip_suffix(*q))
                    .filter(|_| v.len() >= 2)
            })
            .unwrap_or(v);
        out.push((k.to_string(), v.to_string()));
    }
    Ok(out)
}

/// `text` with each secret value of 3 or more characters replaced by [`REDACTED`] (longest
/// first).
pub fn redact(text: &str, values: &[String]) -> String {
    let mut vs: Vec<&String> = values.iter().filter(|v| v.chars().count() >= 3).collect();
    vs.sort_by_key(|v| std::cmp::Reverse(v.len()));
    let mut out = text.to_string();
    for v in vs {
        out = out.replace(v.as_str(), REDACTED);
    }
    out
}

/// What an e2e log says instead of its output when the secrets it ran with are no longer
/// known (the secrets file changed or became unreadable since the spawn, by a process that
/// isn't the one that spawned it).
pub const WITHHELD: &str =
    "(output withheld: the secrets file changed since this e2e started, so it can't be redacted)";

/// The raw output of e2e run `n` in `runs` (stdout, stderr): written by the child, redacted
/// into `e2e-<n>.log`/`.err` by [`settle`] (or [`scrub`]), then deleted. Nothing else reads it.
pub fn raw(runs: &Path, n: u32) -> (PathBuf, PathBuf) {
    (
        runs.join(format!("e2e-{n}.out.raw")),
        runs.join(format!("e2e-{n}.err.raw")),
    )
}

type Held = std::collections::BTreeMap<PathBuf, Vec<String>>;

/// The secret values each e2e child spawned by this process ran with, by its raw stdout path.
static HELD: std::sync::Mutex<Held> = std::sync::Mutex::new(Held::new());

/// The values e2e run `n` ran with: held since its spawn by this process, else the secrets
/// file's when its sha256 is still the one recorded at the spawn (`data.e2e_secrets`), else
/// unknown (`None`: the output is withheld).
fn values_of(cx: &Ctx<'_>, m: &Mission, n: u32, out: &Path) -> Option<Vec<String>> {
    if let Some(v) = HELD.lock().ok().and_then(|mut h| h.remove(out)) {
        return Some(v);
    }
    let rec = Data::of(m).get("e2e_secrets").cloned()?;
    if rec.get("n").and_then(Value::as_u64) != Some(u64::from(n)) {
        return None;
    }
    let file = secrets_file(cx.config, &m.repo);
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return None,
    };
    if rec.get("sha").and_then(Value::as_str) != Some(sha256(&bytes).as_str()) {
        return None;
    }
    parse_secrets(&file, &bytes)
        .ok()
        .map(|kv| kv.into_iter().map(|(_, v)| v).collect())
}

/// Run `n`'s raw output redacted into `log` (`$ <line>`, stdout, stderr) and its `.err`
/// (stderr), or [`WITHHELD`] in both; the raw files deleted → (the raw stderr's first line,
/// the written stderr's first line).
fn redact_raw(cx: &Ctx<'_>, m: &Mission, n: u32, line: &str, log: &Path) -> (String, String) {
    let (out_raw, err_raw) = raw(&cx.runs(m), n);
    let read =
        |p: &Path| String::from_utf8_lossy(&std::fs::read(p).unwrap_or_default()).into_owned();
    let (out, err) = (read(&out_raw), read(&err_raw));
    let (text, err_text) = match values_of(cx, m, n, &out_raw) {
        Some(v) => (
            redact(&format!("$ {line}\n{out}{err}"), &v),
            redact(&err, &v),
        ),
        None => (format!("$ {line}\n{WITHHELD}\n"), format!("{WITHHELD}\n")),
    };
    let _ = std::fs::write(sandbox::err_of(log), &err_text);
    let _ = std::fs::write(log, text);
    let _ = std::fs::remove_file(&out_raw);
    let _ = std::fs::remove_file(&err_raw);
    let first = |s: &str| s.lines().next().unwrap_or_default().to_string();
    (first(&err), first(&err_text))
}

/// Raw e2e output a run left (a crash or a restart before [`settle`]) redacted into its log
/// as [`settle`] would (or withheld), then deleted: run first by every e2e and release step.
pub fn scrub(cx: &Ctx<'_>, m: &Mission) {
    let runs = cx.runs(m);
    let Ok(rd) = std::fs::read_dir(&runs) else {
        return;
    };
    let ns: std::collections::BTreeSet<u32> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix("e2e-")?;
            rest.strip_suffix(".out.raw")
                .or_else(|| rest.strip_suffix(".err.raw"))?
                .parse()
                .ok()
        })
        .collect();
    for n in ns {
        redact_raw(
            cx,
            m,
            n,
            "(interrupted)",
            &runs.join(format!("e2e-{n}.log")),
        );
    }
}

/// The mission checkout at `sha`, detached and clean: base fetched into the clone (as the
/// App), the checkout ensured (LOOP-8) and its base refreshed, then `git checkout --force
/// --detach <sha>` and `git clean -ffdxq` (nothing a worker or a PR's commands left, ignored
/// files too, stays for e2e or a release command).
pub fn at_sha(cx: &Ctx<'_>, m: &Mission, sha: &str) -> Result<PathBuf, StepError> {
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    pgit::fetch_branch(cx, m, &repo.base)?;
    let dir = cx.checkout(m);
    let branch = m
        .branch
        .clone()
        .unwrap_or_else(|| format!("towercab/{}", m.label()));
    checkout::ensure(&cx.exes.git, &repo.path, &dir, &repo.base, &branch).map_err(pgit::failed)?;
    checkout::refresh_base(&cx.exes.git, &repo.path, &dir, &repo.base).map_err(pgit::failed)?;
    pgit::run(
        cx,
        &dir,
        &["checkout", "--quiet", "--force", "--detach", sha],
    )?;
    pgit::run(cx, &dir, &["clean", "-ffdxq"])?;
    Ok(dir)
}

/// How an e2e child ended.
#[derive(Debug, Clone, PartialEq)]
pub enum E2eEnd {
    Green,
    /// Red: why (`exit <c>`, `timed out after 10 min`).
    Red(String),
    /// The command couldn't run (exit 126/127, the sandbox didn't start): `env_blocked`.
    Env(Fault, String),
}

/// The child's raw output redacted into `log` (`$ <line>`, stdout, stderr; the `.err` too)
/// with the secret values it ran with, or withheld when those aren't known any more; the raw
/// files deleted → how it ended.
pub fn settle(cx: &Ctx<'_>, m: &Mission, line: &str, end: &ChildEnd, log: &Path) -> E2eEnd {
    let n = Data::of(m).n("e2e");
    let (raw_first, first) = redact_raw(cx, m, n, line, log);
    if end.timed_out {
        return E2eEnd::Red(format!(
            "timed out after {} min",
            sandbox::E2E_TIMEOUT.as_secs() / 60
        ));
    }
    match end.status.and_then(|s| s.code()) {
        Some(0) => E2eEnd::Green,
        Some(c @ (126 | 127)) => {
            let exe = line.split_whitespace().next().unwrap_or("sh").to_string();
            E2eEnd::Env(Fault::Tool(exe), format!("e2e: exit {c}: {first}"))
        }
        Some(_) if raw_first.starts_with("bwrap:") => {
            E2eEnd::Env(Fault::Sandbox, format!("e2e: {first}"))
        }
        Some(c) => E2eEnd::Red(format!("exit {c}")),
        None => E2eEnd::Red("killed".into()),
    }
}

/// The e2e `line` at `step` in `dir`: the repo's secrets file read once (refused →
/// `env_blocked`), its log number `n.e2e` and the file's sha256 (`data.e2e_secrets` = `{n,
/// sha}`) recorded with the step → the child, writing [`raw`] output; its values held for
/// [`settle`].
pub fn spawn(
    cx: &Ctx<'_>,
    m: &Mission,
    data: &mut Data,
    step: &str,
    dir: &Path,
    line: &str,
) -> Result<Progress, StepError> {
    let (kv, sha) = match read_secrets(&secrets_file(cx.config, &m.repo)) {
        Ok(s) => s,
        Err(why) => {
            return Ok(Progress::Done(Outcome::env(
                Fault::Secrets(m.repo.clone()),
                why,
            )));
        }
    };
    let n = data.next_n("e2e");
    data.set("e2e_secrets", json!({"n": n, "sha": sha}));
    let m = cx.record(m, step, &[("data", data.text().into())])?;
    let runs = cx.runs(&m);
    std::fs::create_dir_all(&runs)
        .map_err(|e| StepError::Bug(format!("{}: {e}", runs.display())))?;
    let (out, err) = raw(&runs, n);
    let values: Vec<String> = kv.iter().map(|(_, v)| v.clone()).collect();
    let spec = sandbox::e2e(cx, &m, dir, line, &out, &err, kv)?;
    if let Ok(mut h) = HELD.lock() {
        h.insert(out, values);
    }
    Ok(Progress::Spawn(spec))
}

/// The log of the last e2e run (`e2e-<n>.log`).
pub fn last_log(cx: &Ctx<'_>, m: &Mission) -> PathBuf {
    cx.runs(m).join(format!("e2e-{}.log", Data::of(m).n("e2e")))
}

/// `e2e` and `revert_e2e`.
pub struct E2e {
    pub seq: Seq,
    mode: Mode,
}

impl E2e {
    pub fn new(seq: Seq, mode: Mode) -> E2e {
        E2e { seq, mode }
    }

    /// Run `k` (1, or the rerun 2) of the e2e at the merge.
    fn run(&self, cx: &Ctx<'_>, m: &Mission, k: u32) -> Result<Progress, StepError> {
        let repo = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let Some(live) = repo.towercab.live else {
            return self.green(cx, m);
        };
        let merge = merge_of(self.seq, m)
            .ok_or_else(|| StepError::Bug(format!("{}: no merge sha for e2e", m.label())))?;
        if behind_other(cx, m)? {
            cx.record(m, "queued", &[])?;
            return Ok(Progress::Poll { after: DEPLOY_POLL });
        }
        let dir = at_sha(cx, m, &merge)?;
        let mut data = Data::of(m);
        let mut e = data.get("e2e").cloned().unwrap_or(Value::Null);
        if e.get("merge").and_then(Value::as_str) != Some(merge.as_str()) {
            e = json!({"merge": merge});
        }
        e["runs"] = json!(k);
        data.set("e2e", e);
        spawn(cx, m, &mut data, &format!("e2e:{k}"), &dir, &live.e2e)
    }

    /// Green: an intent's → `authorize release` with a ` ```release ` block, else `ok`; a
    /// revert's → `reverted, refine` with the e2e log that started it and the revert PR.
    fn green(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        match self.seq {
            Seq::Revert => {
                let data = Data::of(m);
                let rv = data.get("revert").cloned().unwrap_or(Value::Null);
                let s = |k: &str| rv.get(k).and_then(Value::as_str).unwrap_or_default();
                let log = tail(Path::new(s("e2e_log")), TAIL);
                let merge = m.merge_sha.clone().unwrap_or_default();
                let note = format!(
                    "Reverted: e2e went red twice after the merge of {} ({}), and the revert {} is live and green. \
                     Refine this intent, then remove `waiting` for a fresh attempt.\n\n\
                     The e2e log (redacted, last 16k):\n\n```\n{}\n```",
                    short(&merge),
                    m.pr_url.as_deref().unwrap_or("the PR"),
                    s("url"),
                    log.trim_end()
                );
                wait_note(
                    cx,
                    m,
                    Waiting::RevertedRefine,
                    &format!("revert {} green", s("url")),
                    &note,
                )
            }
            Seq::Intent | Seq::Rehearsal => {
                let release = match files(cx, m) {
                    Ok(f) => f.towercab.release.filter(|_| f.towercab.live.is_some()),
                    Err(o) => return Ok(Progress::Done(o)),
                };
                Ok(Progress::Done(match release {
                    Some(_) => Outcome::wait(Waiting::AuthorizeRelease, "staging e2e green"),
                    None => Outcome::ok(),
                }))
            }
        }
    }

    /// Red twice: a revert's → `revert failed`; Towercab's merge → `red`; mine → triage.
    fn red_twice(&self, cx: &Ctx<'_>, m: &Mission, why: &str) -> Result<Progress, StepError> {
        let why = format!("e2e red twice: {why}");
        match self.seq {
            Seq::Revert => Ok(Progress::Done(Outcome::wait(
                Waiting::RevertFailed,
                format!("revert {why}"),
            ))),
            _ if m.merged_by.as_deref() == Some("towercab") => {
                Ok(Progress::Done(Outcome::red(why)))
            }
            _ => self.triage(cx, m),
        }
    }

    /// PIP-20: one fresh read-only run (review model) on the merged diff and the e2e log.
    fn triage(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let repo = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let merge = m.merge_sha.clone().unwrap_or_default();
        let log = tail(&last_log(cx, m), TAIL);
        let prompt = triage::prompt(
            &format!("git diff {merge}^1 {merge}"),
            &log,
            &repo.review.red_lines,
        )
        .map_err(StepError::Bug)?;
        let review = super::intent(cx, m)
            .ok()
            .and_then(|i| i.review().map(str::to_string));
        let model = review_model(&m.model, review.as_deref());
        let mut data = Data::of(m);
        data.set("triage_limited", Value::Null);
        let m = cx.record(m, &m.step, &[("data", data.text().into())])?;
        let (m, session) = cx.run_session(&m, "triage:run")?;
        let mut st = Start::new(RunKind::Triage, "triage:run", &model, prompt);
        st.schema = Some(TRIAGE.clone());
        st.session = session.into();
        runs::start(cx, &m, st)
    }

    /// The triage's call: two-way with a red line → `red` (revert); else `e2e red after your
    /// merge (<door>)` with the reason and log in `intent.md`.
    fn triaged(
        &self,
        cx: &Ctx<'_>,
        m: &Mission,
        result: Result<TriageResult, String>,
    ) -> Result<Progress, StepError> {
        let (door, why) = match &result {
            Ok(t) => match triage::decide(t) {
                None => {
                    let lines: Vec<String> = t
                        .red_lines
                        .iter()
                        .map(|r| format!("{} ({})", r.line, r.file))
                        .collect();
                    return Ok(Progress::Done(Outcome::red(format!(
                        "e2e red twice after your merge; triage: two-way, red lines touched: {}",
                        lines.join(", ")
                    ))));
                }
                Some(door) => (door, crate::outbox::one_line(&t.why)),
            },
            Err(e) => (Door::Unknown, format!("triage: {e}")),
        };
        let merge = m.merge_sha.clone().unwrap_or_default();
        let log = tail(&last_log(cx, m), TAIL);
        let note = format!(
            "e2e went red twice after your merge of {} ({}). Door: {}. {why}\n\n\
             `approve <id>` keeps it; `retry --fresh <id>` fixes forward.\n\n\
             The e2e log (redacted, last 16k):\n\n```\n{}\n```",
            short(&merge),
            m.pr_url.as_deref().unwrap_or("the PR"),
            door.as_str(),
            log.trim_end()
        )
        .replace("<id>", &m.label());
        wait_note(cx, m, Waiting::E2eRedAfterYourMerge(door), &why, &note)
    }

    fn triage_ended(
        &self,
        cx: &Ctx<'_>,
        m: &Mission,
        r: ClaudeResult,
    ) -> Result<Progress, StepError> {
        let result = match &r.structured_output {
            Some(v) => TriageResult::from_json(v).map_err(|e| format!("invalid result: {e}")),
            None => Err("no structured_output".into()),
        };
        self.triaged(cx, m, result)
    }
}

/// The run number of an e2e step (`e2e:<k>`).
fn run_of(step: &str) -> Option<u32> {
    step.strip_prefix("e2e:")?
        .parse()
        .ok()
        .filter(|k| (1..=2).contains(k))
}

impl Handler for E2e {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        scrub(cx, m);
        if m.step.starts_with("triage:") {
            return runs::restart(cx, m);
        }
        self.run(cx, m, run_of(&m.step).unwrap_or(1))
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        if m.step.starts_with("triage:") {
            return match runs::finish(cx, m, &end)? {
                Ended::Ok(r) => self.triage_ended(cx, m, r),
                Ended::Failed(why) => self.triaged(cx, m, Err(why)),
                Ended::Out(Progress::Done(o)) if o.event == Event::Limit => {
                    match limit_once(m, &o, "triage_limited") {
                        Some(p) => Ok(p),
                        None => self.triaged(
                            cx,
                            m,
                            Err(format!(
                                "usage limit after its wait: {}",
                                o.why.unwrap_or_default()
                            )),
                        ),
                    }
                }
                Ended::Out(p) => Ok(p),
            };
        }
        let k =
            run_of(&m.step).ok_or_else(|| StepError::Bug(format!("e2e: no run at {}", m.step)))?;
        let line = match files(cx, m) {
            Ok(f) => f.towercab.live.map(|l| l.e2e).unwrap_or_default(),
            Err(o) => return Ok(Progress::Done(o)),
        };
        let log = last_log(cx, m);
        match settle(cx, m, &line, &end, &log) {
            E2eEnd::Green => self.green(cx, m),
            E2eEnd::Env(fault, why) => Ok(Progress::Done(Outcome::env(fault, why))),
            E2eEnd::Red(why) => {
                let mut data = Data::of(m);
                let mut e = data.get("e2e").cloned().unwrap_or(json!({}));
                e["red"] = json!(log.to_string_lossy());
                data.set("e2e", e);
                if k == 1 {
                    cx.record(m, "e2e:2", &[("data", data.text().into())])?;
                    return Ok(Progress::Poll { after: RERUN_AFTER });
                }
                let m = cx.record(m, &m.step, &[("data", data.text().into())])?;
                self.red_twice(cx, &m, &why)
            }
        }
    }
}
