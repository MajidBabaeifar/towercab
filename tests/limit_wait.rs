//! Usage limits in the loop (LOOP-9): a cooldown per (provider, model); the mission keeps its
//! stage and step, then resumes its session with `Continue where you stopped.`; other models
//! keep going; a limit wait is never a crash, a repair or a timeout.

mod common;

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use chrono::DateTime;
use common::world::{World, intent_file};
use towercab::claude::CONTINUE;
use towercab::db::Cooldown;
use towercab::handler::{
    ChildEnd, ChildKind, ChildSpec, Ctx, Handler, Handlers, Outcome, Progress, StepError,
};
use towercab::limits;
use towercab::machine::Stage;
use towercab::mission::Mission;
use towercab::pick::{self, Pick, Skip};
use towercab::runloop::Loop;

const X: &str = "261001-0900";
const Y: &str = "261001-0901";
const Z: &str = "261001-0902";

/// A fake `claude`: each run's argv and stdin to `$RUNS/claude-<n>.argv` / `.stdin`, then
/// `$RUNS/count` = n; it runs while `$RUNS/hold` exists; with `$RUNS/limit` it fails with
/// that file's text as its result (the file then goes, unless `$RUNS/limit.keep` exists).
const FAKE_CLAUDE: &str = r#"n=$(($(cat "$RUNS/count" 2>/dev/null || echo 0) + 1))
printf '%s\n' "$@" > "$RUNS/claude-$n.argv"
cat > "$RUNS/claude-$n.stdin"
echo "$n" > "$RUNS/count.tmp" && mv "$RUNS/count.tmp" "$RUNS/count"
while [ -e "$RUNS/hold" ]; do sleep 0.05; done
if [ -e "$RUNS/limit" ]; then
  msg=$(cat "$RUNS/limit")
  [ -e "$RUNS/limit.keep" ] || rm -f "$RUNS/limit"
  printf '{"type":"result","is_error":true,"result":"%s"}\n' "$msg"
  exit 1
fi
echo '{"type":"result","is_error":false,"result":"done"}'
"#;

/// The build as a worker runs it: its session (`--session-id`, then `--resume`), `CONTINUE`
/// when re-entered at its recorded run; a limit from the run's result (`limits::of_run`).
struct Worker {
    claude: PathBuf,
    timeout: Option<Duration>,
    ends: Rc<RefCell<Vec<(String, ChildEnd)>>>,
}

impl Handler for Worker {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let prompt = if m.step == "run" {
            CONTINUE
        } else {
            "build it"
        };
        let (m, session) = cx.session(m, "run")?;
        let runs = cx.runs(&m);
        fs::create_dir_all(&runs).unwrap();
        let file = runs.join("build.prompt");
        fs::write(&file, prompt).unwrap();
        let mut argv: Vec<std::ffi::OsString> = vec![
            self.claude.clone().into(),
            "-p".into(),
            "--model".into(),
            m.model.clone().into(),
        ];
        argv.extend(session.args().iter().map(|a| a.into()));
        Ok(Progress::Spawn(ChildSpec {
            kind: ChildKind::Claude,
            argv,
            cwd: cx.checkout(&m),
            env: vec![
                ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
                ("RUNS".into(), runs.clone().into()),
            ],
            stdin: Some(file),
            stdout: runs.join("build.json"),
            stderr: runs.join("build.err"),
            timeout: self.timeout,
            slot: true,
            model: Some(m.model.clone()),
        }))
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        self.ends.borrow_mut().push((m.label(), end.clone()));
        let out = fs::read_to_string(&end.stdout).unwrap_or_default();
        let err = fs::read_to_string(&end.stderr).unwrap_or_default();
        let result: serde_json::Value = out
            .lines()
            .rev()
            .find_map(|l| serde_json::from_str(l).ok())
            .unwrap_or_default();
        let failed = !end.status.is_some_and(|s| s.success())
            || result["is_error"].as_bool().unwrap_or(true);
        let text = result["result"].as_str().unwrap_or_default();
        Ok(Progress::Done(
            match limits::of_run(&m.model, failed, text, &err, cx.tick.wall) {
                Some(limit) => Outcome::limit(limit),
                None => Outcome::ok(),
            },
        ))
    }
}

type Ends = Rc<RefCell<Vec<(String, ChildEnd)>>>;

fn world(files: &[(String, String)], repos: &[&str]) -> (World, Ends) {
    let w = World::new(files, repos);
    common::exe(&w.root.join("bin").join("claude"), FAKE_CLAUDE);
    (w, Rc::new(RefCell::new(Vec::new())))
}

fn handlers(w: &World, ends: &Ends, timeout: Option<Duration>) -> Handlers {
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Build,
        Box::new(Worker {
            claude: w.root.join("bin").join("claude"),
            timeout,
            ends: ends.clone(),
        }),
    );
    h
}

/// Writes (or with `None` removes) `runs/<id>/<name>`.
fn file(w: &World, id: &str, name: &str, text: Option<&str>) {
    let runs = w.home.runs(id);
    fs::create_dir_all(&runs).unwrap();
    match text {
        Some(t) => fs::write(runs.join(name), t).unwrap(),
        None => {
            let _ = fs::remove_file(runs.join(name));
        }
    }
}

fn runs(w: &World, id: &str) -> usize {
    fs::read_to_string(w.home.runs(id).join("count"))
        .map(|s| s.trim().parse().unwrap())
        .unwrap_or(0)
}

/// Run `n`'s argv and stdin.
fn run(w: &World, id: &str, n: usize) -> (Vec<String>, String) {
    let runs = w.home.runs(id);
    let argv = fs::read_to_string(runs.join(format!("claude-{n}.argv"))).unwrap();
    let stdin = fs::read_to_string(runs.join(format!("claude-{n}.stdin"))).unwrap();
    (argv.lines().map(str::to_string).collect(), stdin)
}

fn cooldown(w: &World, model: &str) -> Option<Cooldown> {
    w.db()
        .conn()
        .query_row(
            "SELECT * FROM cooldowns WHERE provider = 'claude' AND model = ?1",
            [model],
            Cooldown::from_row,
        )
        .ok()
}

/// One pass at `hh:mm:ss` (Europe/Berlin, +02:00) on the 15th.
fn at(w: &mut World, lp: &mut Loop, hms: &str) {
    let t = DateTime::parse_from_rfc3339(&format!("2026-10-15T{hms}+02:00")).unwrap();
    let secs = (t - w.clock.wall).num_seconds();
    assert!(secs > 0, "{hms} is ahead");
    w.pass_after(lp, secs as u64);
}

/// The intent's mission waits for its model's cooldown.
fn limited(w: &World, id: &str) -> bool {
    w.missions(id)
        .pop()
        .is_some_and(|m| m.limit_model.is_some())
}

fn unix(rfc3339: &str) -> f64 {
    DateTime::parse_from_rfc3339(rfc3339).unwrap().timestamp() as f64
}

#[test]
fn test_limit_resumes_same_step() {
    let (mut w, ends) = world(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    file(
        &w,
        X,
        "limit",
        Some("You've hit your limit · resets 3pm (Europe/Berlin)"),
    );
    let mut lp = w.open(handlers(&w, &ends, None));
    w.wait_for(&mut lp, 20, |w, _| limited(w, X));
    let m = w.mission(X);
    assert_eq!(
        (m.stage, m.step.as_str()),
        (Stage::Build, "run"),
        "stage and step kept"
    );
    assert_eq!(m.limit_model.as_deref(), Some("opus"));
    assert!(!m.busy && m.child_pid.is_none());
    assert_eq!((m.unclean, m.retries, m.continued), (0, 0, 0));
    let c = cooldown(&w, "opus").expect("a cooldown for (claude, opus)");
    assert_eq!(c.until, unix("2026-10-15T15:00:30+02:00"), "reset + 30 s");
    assert!(c.parsed);
    assert_eq!(c.backoffs, 0);
    assert_eq!(c.text, "You've hit your limit · resets 3pm (Europe/Berlin)");
    assert_eq!(
        w.transitions(X).pop().unwrap(),
        ("build".into(), "limit".into(), "build".into())
    );
    assert!(w.outbox().is_empty(), "no message for a limit");

    // Until 15:00:30 the step waits: no run; nothing else runnable → idle.
    at(&mut w, &mut lp, "14:00:00");
    let r = w.pass_after(&mut lp, 1);
    assert!(r.idle, "a limit wait alone is idle");
    at(&mut w, &mut lp, "15:00:29");
    assert_eq!(runs(&w, X), 1);
    assert_eq!(w.mission(X).limit_model.as_deref(), Some("opus"));

    // Then it re-enters the same step: its session resumed with the continue prompt.
    at(&mut w, &mut lp, "15:00:31");
    w.wait_for(&mut lp, 20, |w, _| w.stage(X) == Some(Stage::Done));
    assert_eq!(runs(&w, X), 2);
    let (argv, stdin) = run(&w, X, 1);
    assert_eq!(argv[3..], ["--session-id".to_string(), m.session.clone()]);
    assert_eq!(stdin, "build it");
    let (argv, stdin) = run(&w, X, 2);
    assert_eq!(argv[3..], ["--resume".to_string(), m.session.clone()]);
    assert_eq!(stdin, CONTINUE);
    let events: Vec<String> = w.transitions(X).into_iter().map(|t| t.1).collect();
    assert_eq!(events.iter().filter(|e| *e == "limit").count(), 1);
    assert_eq!(ends.borrow().len(), 2);
    lp.shutdown().unwrap();
}

#[test]
fn test_other_model_runs() {
    // parallel 1. X (opus) hits its limit; Y (sonnet) runs meanwhile; Z (opus) waits.
    let (mut w, ends) = world(
        &[
            intent_file("261001-0900-x", "web", "u: 5\ni: 5\n", "X"),
            intent_file("261001-0901-y", "api", "u: 4\ni: 4\nmodel: sonnet\n", "Y"),
            intent_file("261001-0902-z", "docs", "u: 3\ni: 3\n", "Z"),
        ],
        &["web", "api", "docs"],
    );
    file(
        &w,
        X,
        "limit",
        Some("You've hit your limit · resets 3pm (Europe/Berlin)"),
    );
    let mut lp = w.open(handlers(&w, &ends, None));
    w.wait_for(&mut lp, 20, |w, _| limited(w, X));
    w.wait_for(&mut lp, 30, |w, _| w.stage(Y) == Some(Stage::Done));
    let (argv, _) = run(&w, Y, 1);
    assert_eq!(argv[1..3], ["--model".to_string(), "sonnet".to_string()]);
    assert!(cooldown(&w, "sonnet").is_none(), "sonnet never cooled");
    assert_eq!(w.stage(Z), None, "Z (opus) not picked while opus cools");
    let d = pick::decide(lp.listing().unwrap(), &lp.pick_state(w.clock).unwrap());
    assert_eq!(d.pick, None);
    assert!(d.skipped.contains(&(
        Z.to_string(),
        Skip::Cooling {
            model: "opus".into(),
            until: "15:00".into()
        }
    )));
    assert_eq!(w.stage(X), Some(Stage::Build));
    assert_eq!(runs(&w, X), 1);

    // The reset passes: X resumes, then Z is picked.
    at(&mut w, &mut lp, "15:00:31");
    w.wait_for(&mut lp, 30, |w, _| w.stage(Z) == Some(Stage::Done));
    assert_eq!(w.stage(X), Some(Stage::Done));
    assert_eq!(run(&w, X, 2).1, CONTINUE);
    lp.shutdown().unwrap();
}

#[test]
fn test_limit_never_counts_as_crash() {
    // X: limits without a reset time, again and again: backoffs 1, 2, 4, 8 min; never a crash,
    // a repair or `crashed at`; a crash of the loop during the wait isn't counted either.
    // Y (after X) on its own model.
    let (mut w, ends) = world(
        &[
            intent_file("261001-0900-x", "web", "", "X"),
            intent_file(
                "261001-0901-y",
                "api",
                "model: sonnet\nafter: [261001-0900]\n",
                "Y",
            ),
        ],
        &["web", "api"],
    );
    let timeout = Some(Duration::from_secs(100));
    file(&w, X, "limit", Some("429 Too Many Requests"));
    file(&w, X, "limit.keep", Some(""));
    let mut lp = w.open(handlers(&w, &ends, timeout));
    for n in 1..=4u32 {
        w.wait_for(&mut lp, 20, |w, _| {
            runs(w, X) == n as usize && limited(w, X)
        });
        let m = w.mission(X);
        assert_eq!((m.stage, m.step.as_str()), (Stage::Build, "run"));
        assert_eq!(
            (m.unclean, m.retries, m.verify_repairs, m.ci_repairs),
            (0, 0, 0, 0)
        );
        let c = cooldown(&w, "opus").unwrap();
        assert_eq!(c.backoffs, i64::from(n));
        assert!(!c.parsed);
        let wait = c.until - w.clock.unix();
        let want = limits::backoff(n).as_secs_f64();
        assert!(
            wait <= want && wait > want - 30.0,
            "backoff {n}: {wait} s of {want}"
        );
        if n == 3 {
            // The loop dies during the wait: the mission wasn't busy, nothing counted.
            drop(lp);
            lp = w.open(handlers(&w, &ends, timeout));
            assert!(lp.unclean.is_some());
            assert_eq!(w.mission(X).unclean, 0);
        }
        if n == 4 {
            file(&w, X, "limit.keep", None);
            file(&w, X, "limit", None);
        }
        w.pass_after(&mut lp, want as u64);
    }
    // The first success on opus: its backoffs start over.
    w.wait_for(&mut lp, 20, |w, _| w.stage(X) == Some(Stage::Done));
    assert_eq!(runs(&w, X), 5);
    assert_eq!(cooldown(&w, "opus").unwrap().backoffs, 0);
    let events: Vec<String> = w.transitions(X).into_iter().map(|t| t.1).collect();
    assert_eq!(events.iter().filter(|e| *e == "limit").count(), 4);
    for e in ["crash", "timeout", "red", "blocked"] {
        assert!(!events.contains(&e.to_string()), "{e} in {events:?}");
    }
    assert!(w.outbox().is_empty());

    // Y (timeout 100 s): 60 s of run time, a limit, a 10-minute wait, then the resumed run
    // times out after the 40 s left: the wait never counted.
    file(&w, Y, "hold", Some(""));
    w.wait_for(&mut lp, 20, |w, _| runs(w, Y) == 1);
    let ran = w.clock.unix() - w.mission(Y).child_since.unwrap();
    w.pass_after(&mut lp, (60.0 - ran) as u64);
    file(&w, Y, "limit", Some("usage limit reached"));
    file(&w, Y, "hold", None);
    w.wait_for(&mut lp, 20, |w, _| limited(w, Y));
    let m = w.mission(Y);
    assert!((60.0..65.0).contains(&m.step_secs), "{}", m.step_secs);
    file(&w, Y, "hold", Some(""));
    w.pass_after(&mut lp, 600);
    assert!(
        w.mission(Y).child_pid.is_some(),
        "resumed after its backoff"
    );
    let end = std::time::Instant::now() + Duration::from_secs(5);
    while runs(&w, Y) < 2 {
        assert!(std::time::Instant::now() < end, "run 2 starts");
        std::thread::sleep(Duration::from_millis(20));
    }
    let left = 100.0 - m.step_secs;
    w.pass_after(&mut lp, (left - 1.0) as u64);
    assert!(w.mission(Y).child_pid.is_some(), "still within its budget");
    w.pass_after(&mut lp, 2);
    w.wait_for(&mut lp, 20, |w, _| w.mission(Y).child_pid.is_none());
    let ends = ends.borrow();
    let (_, end) = ends.iter().rfind(|(i, _)| i == Y).unwrap();
    assert!(end.timed_out);
    let run = end.run.as_secs_f64();
    assert!(
        run >= left && run < left + 10.0,
        "timed out after {run} s of run time, {left} s left"
    );
    drop(ends);
    lp.shutdown().unwrap();
}

#[test]
fn test_past_reset_backs_off() {
    // A reset time already past (a stale epoch) is no reset time: the backoff (1 min) applies,
    // so the run isn't retried every pass.
    let (mut w, ends) = world(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    file(
        &w,
        X,
        "limit",
        Some("Claude AI usage limit reached|1760000000"),
    );
    let mut lp = w.open(handlers(&w, &ends, None));
    w.wait_for(&mut lp, 20, |w, _| limited(w, X));
    let c = cooldown(&w, "opus").expect("a cooldown for (claude, opus)");
    assert!(!c.parsed);
    assert_eq!(c.backoffs, 1);
    assert!(
        c.until > w.clock.unix() + 50.0,
        "{} vs {}",
        c.until,
        w.clock.unix()
    );
    let r = w.pass_after(&mut lp, 1);
    assert!(r.idle, "still cooling");
    assert_eq!(runs(&w, X), 1);
    lp.shutdown().unwrap();
}
