//! Verifier (PIP-32, opt-in with a ` ```run ` block): Towercab starts the app in code under the
//! sandbox (with network) and a fresh read-only session exercises the change against `plan.md`
//! `## Proof` with `curl` (and Playwright with `ui: true`), reporting `{ran, saw, mismatches}`.
//! The app and the Claude run are one child, `towercab hook verifier` ([`hook`]): the loop tracks
//! one child per mission and the app dies with it.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::claude::{RunKind, VerifierNet};
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::machine::Event;
use crate::mission::Mission;
use crate::repo::verifying::Run as AppRun;

use super::data::Data;
use super::review::{limit_once, review_model};
use super::runs::{self, Ended, Start};
use super::schemas::{Mismatch, VERIFIER, VerifierReport};
use super::{Mode, files, git as pgit, intent, prompts, sandbox};

/// How long the app gets to answer at its `url`.
pub const APP_WAIT: Duration = Duration::from_secs(60);

/// The wrapper's exit code when the app never answered (Claude not run).
pub const NO_START: i32 = 3;

/// The app's command as the wrapper runs it: PIP-23's `bwrap` with network in `dir`, the
/// repo's cache read-only, and the sandbox's environment.
pub fn app_argv(cx: &Ctx<'_>, m: &Mission, dir: &Path, command: &str) -> Result<Value, StepError> {
    let home = crate::claude::home().map_err(StepError::Bug)?;
    let cache_dir = sandbox::cache_dir(cx, m)?;
    let cache = sandbox::Cache::Read(&cache_dir);
    let argv: Vec<String> =
        sandbox::checks_argv(cx.exes, cx.config, &home, dir, command, true, cache)
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
    let env: serde_json::Map<String, Value> = sandbox::env(cx.config, &home, cache)
        .into_iter()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                Value::String(v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    Ok(json!({"argv": argv, "env": env}))
}

/// `<log>.nostart`: the wrapper's note that the app never answered.
pub fn nostart(log: &Path) -> PathBuf {
    let mut s = log.as_os_str().to_owned();
    s.push(".nostart");
    PathBuf::from(s)
}

/// The report's line in the PR text.
pub fn line(r: &VerifierReport) -> String {
    if r.mismatches.is_empty() {
        format!(
            "ran: {}",
            crate::outbox::cut(&crate::outbox::one_line(&r.saw), 200)
        )
    } else {
        let k = r.mismatches.len();
        let s = if k == 1 { "" } else { "es" };
        let all: Vec<String> = r
            .mismatches
            .iter()
            .map(|x| format!("expected {}, observed {}", x.expected, x.observed))
            .collect();
        crate::outbox::cut(&format!("{k} mismatch{s}: {}", all.join("; ")), 300)
    }
}

fn to_json(r: &VerifierReport) -> Value {
    json!({
        "ran": r.ran,
        "saw": r.saw,
        "mismatches": r.mismatches.iter().map(|x| json!({"expected": x.expected, "observed": x.observed})).collect::<Vec<_>>(),
        "line": line(r),
    })
}

/// A failed verification: one mismatch `{expected: "a report", observed: why}`.
pub fn failed(why: &str) -> VerifierReport {
    VerifierReport {
        ran: false,
        saw: String::new(),
        mismatches: vec![Mismatch {
            expected: "a report".into(),
            observed: crate::outbox::one_line(why),
        }],
    }
}

/// The `verifier` stage.
pub struct Verifier {
    mode: Mode,
}

impl Verifier {
    pub fn new(mode: Mode) -> Verifier {
        Verifier { mode }
    }

    /// The app's log of the current verifier run: `app-<n>.log` (`n` = the verifier run's).
    fn app_log(cx: &Ctx<'_>, m: &Mission) -> PathBuf {
        cx.runs(m)
            .join(format!("app-{}.log", Data::of(m).n("verifier")))
    }

    /// A Claude run's spec wrapped in `towercab hook verifier --app … --url … --log … --`.
    fn wrap(cx: &Ctx<'_>, m: &Mission, app: &AppRun, p: Progress) -> Result<Progress, StepError> {
        let Progress::Spawn(mut spec) = p else {
            return Ok(p);
        };
        let m = crate::mission::get(cx.db.conn(), m.id)?;
        let exe = crate::exes::towercab(cx.exes).map_err(StepError::Bug)?;
        let app_json = app_argv(cx, &m, &cx.checkout(&m), &app.command)?;
        let log = Self::app_log(cx, &m);
        let mut argv: Vec<OsString> = vec![
            exe.into(),
            "hook".into(),
            "verifier".into(),
            "--app".into(),
            app_json.to_string().into(),
            "--url".into(),
            app.url.clone().into(),
            "--log".into(),
            log.into(),
            "--".into(),
        ];
        argv.extend(spec.argv);
        spec.argv = argv;
        Ok(Progress::Spawn(spec))
    }

    fn start(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        let repo_files = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let mut data = Data::of(m);
        let Some(app) = repo_files.verifying.run.clone() else {
            data.set("verifier", json!({"line": "not opted in"}));
            return Ok(Progress::Done(Outcome::ok().with("data", data.text())));
        };
        if !pgit::sync_head(cx, m)? {
            return Ok(Progress::Done(Outcome::event(Event::Conflict)));
        }
        let intent = intent(cx, m)?;
        let plan = std::fs::read_to_string(cx.store.path().join(&intent.dir).join("plan.md"))
            .unwrap_or_default();
        let proof = proof_section(&plan);
        let ui = if app.ui {
            " With `ui: true` you also have a Playwright browser (`mcp__playwright`) limited to that url."
        } else {
            ""
        };
        let prompt = prompts::render(
            "verifier",
            &[("url", &app.url), ("proof", &proof), ("ui", ui)],
        )
        .map_err(StepError::Bug)?;
        data.set("verifier", Value::Null);
        data.set("verifier_limited", Value::Null);
        let m = cx.record(m, &m.step, &[("data", data.text().into())])?;
        let (m, session) = cx.run_session(&m, "verifier:run")?;
        let model = review_model(&m.model, intent.review());
        let mut st = Start::new(RunKind::Verifier, "verifier:run", &model, prompt);
        st.schema = Some(VERIFIER.clone());
        st.session = session.into();
        st.verifier = Some(VerifierNet {
            port: app.port,
            url: app.url.clone(),
            ui: app.ui,
        });
        let p = runs::start(cx, &m, st)?;
        Self::wrap(cx, &m, &app, p)
    }

    fn settle(&self, m: &Mission, r: VerifierReport) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        data.set("verifier_limited", Value::Null);
        data.set("verifier", to_json(&r));
        Ok(Progress::Done(Outcome::ok().with("data", data.text())))
    }

    fn app(cx: &Ctx<'_>, m: &Mission) -> Result<Result<AppRun, Outcome>, StepError> {
        let repo_files = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Err(o)),
        };
        repo_files
            .verifying
            .run
            .ok_or_else(|| StepError::Bug("verifier: the run block is gone".into()))
            .map(Ok)
    }
}

/// `plan.md`'s `## Proof` section (none: a note).
pub fn proof_section(plan: &str) -> String {
    let mut out = Vec::new();
    let mut on = false;
    for l in plan.lines() {
        if l.starts_with("## ") {
            on = l.trim() == "## Proof";
            continue;
        }
        if on {
            out.push(l);
        }
    }
    let s = out.join("\n").trim().to_string();
    if s.is_empty() {
        "(plan.md has no ## Proof: exercise the change the intent describes)".into()
    } else {
        s
    }
}

impl Handler for Verifier {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if m.step.starts_with("verifier:run") {
            let app = match Self::app(cx, m)? {
                Ok(a) => a,
                Err(o) => return Ok(Progress::Done(o)),
            };
            let p = runs::restart(cx, m)?;
            return Self::wrap(cx, m, &app, p);
        }
        self.start(cx, m)
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        let log = Self::app_log(cx, m);
        if let Ok(why) = std::fs::read_to_string(nostart(&log)) {
            let mut r = failed("");
            r.mismatches = vec![Mismatch {
                expected: "the app answers at its url".into(),
                observed: format!("app didn't start: {}", crate::outbox::one_line(&why)),
            }];
            return self.settle(m, r);
        }
        let r = match runs::finish(cx, m, &end)? {
            Ended::Ok(r) => match r.structured_output.as_ref().map(VerifierReport::from_json) {
                Some(Ok(mut v)) => {
                    if !v.ran && v.mismatches.is_empty() {
                        v.mismatches.push(Mismatch {
                            expected: "the change exercised".into(),
                            observed: format!("ran: false: {}", crate::outbox::one_line(&v.saw)),
                        });
                    }
                    v
                }
                Some(Err(e)) => failed(&format!("invalid result: {e}")),
                None => failed("no structured_output"),
            },
            Ended::Failed(why) => failed(&why),
            Ended::Out(Progress::Done(o)) if o.event == Event::Limit => {
                match limit_once(m, &o, "verifier_limited") {
                    Some(p) => return Ok(p),
                    None => failed(&format!(
                        "usage limit after its wait: {}",
                        o.why.unwrap_or_default()
                    )),
                }
            }
            Ended::Out(p) => {
                let app = match Self::app(cx, m)? {
                    Ok(a) => a,
                    Err(o) => return Ok(Progress::Done(o)),
                };
                return Self::wrap(cx, m, &app, p);
            }
        };
        self.settle(m, r)
    }
}

/// `towercab hook verifier --app <json> --url <url> --log <file> -- <claude argv>` (PIP-32):
/// starts the app (`{argv, env}`: its own process group, stdout and stderr to `log`), polls
/// `url` every second for [`APP_WAIT`] (any HTTP answer counts), runs Claude with this
/// process's stdin, stdout and stderr, then kills the app's group. The app exits or never
/// answers → `<log>.nostart` with why, exit [`NO_START`], Claude not run. SIGTERM or SIGINT
/// (the loop stopping its child) → the app's group killed too. Returns the exit code.
pub fn hook(app: &str, url: &str, log: &Path, claude: &[OsString]) -> i32 {
    hook_with(app, url, log, claude, APP_WAIT)
}

/// [`hook`] with the app's wait given.
pub fn hook_with(app: &str, url: &str, log: &Path, claude: &[OsString], wait: Duration) -> i32 {
    let fail = |why: String| {
        let _ = std::fs::write(nostart(log), format!("{why}\n"));
        eprintln!("towercab hook verifier: {why}");
        NO_START
    };
    let spec: Value = match serde_json::from_str(app) {
        Ok(v) => v,
        Err(e) => return fail(format!("--app: {e}")),
    };
    let argv: Vec<String> = spec["argv"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let Some((prog, args)) = argv.split_first() else {
        return fail("--app: no argv".into());
    };
    if claude.is_empty() {
        return fail("no claude argv after --".into());
    }
    let out = match std::fs::File::create(log) {
        Ok(f) => f,
        Err(e) => return fail(format!("{}: {e}", log.display())),
    };
    let err = match out.try_clone() {
        Ok(f) => f,
        Err(e) => return fail(format!("{}: {e}", log.display())),
    };
    let term = Arc::new(AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        let _ = signal_hook::flag::register(sig, Arc::clone(&term));
    }
    let mut cmd = Command::new(prog);
    cmd.args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    use std::os::unix::process::CommandExt as _;
    cmd.process_group(0);
    if let Some(env) = spec["env"].as_object() {
        for (k, v) in env {
            cmd.env(k, v.as_str().unwrap_or_default());
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("the app can't start: {prog}: {e}")),
    };
    let pgid = child.id() as i32;
    let kill = |child: &mut std::process::Child| {
        // SAFETY: signals the app's own process group, nothing else.
        unsafe {
            libc::killpg(pgid, libc::SIGTERM);
        }
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // SAFETY: as above; whatever is left of the group.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
        let _ = child.wait();
    };
    let deadline = Instant::now() + wait;
    loop {
        if crate::http::get_text(url, Duration::from_secs(2)).is_ok() {
            break;
        }
        if let Ok(Some(st)) = child.try_wait() {
            kill(&mut child);
            return fail(format!("the app exited before answering at {url}: {st}"));
        }
        if term.load(Ordering::SeqCst) {
            kill(&mut child);
            return 143;
        }
        if Instant::now() >= deadline {
            kill(&mut child);
            return fail(format!("no answer at {url} in {} s", wait.as_secs()));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let mut run = Command::new(&claude[0]);
    run.args(&claude[1..]);
    let code = match run.spawn() {
        Ok(mut c) => loop {
            match c.try_wait() {
                Ok(Some(st)) => {
                    use std::os::unix::process::ExitStatusExt as _;
                    break st.code().unwrap_or_else(|| 128 + st.signal().unwrap_or(0));
                }
                Ok(None) => {}
                Err(_) => break 1,
            }
            if term.load(Ordering::SeqCst) {
                let _ = c.kill();
                let _ = c.wait();
                break 143;
            }
            std::thread::sleep(Duration::from_millis(50));
        },
        Err(e) => {
            let _ = writeln!(
                std::io::stderr(),
                "towercab hook verifier: {:?}: {e}",
                claude[0]
            );
            127
        }
    };
    kill(&mut child);
    code
}
