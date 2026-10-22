//! Crash and restart (LOOP-7): leftover children killed, `unclean` counted for busy missions
//! only, capped at `crashed at <stage>`; a cut-off run resumes its session; SIGTERM is
//! `interrupted`, not counted.

mod common;

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use common::world::{Act, Scripted, World, intent_file};
use towercab::claude::{self, CONTINUE};
use towercab::handler::{
    ChildEnd, ChildKind, ChildSpec, Ctx, Handler, Handlers, Outcome, Progress, Session, StepError,
};
use towercab::machine::{Event, Stage, Waiting};
use towercab::mission::Mission;
use towercab::pick::Pick;
use towercab::runloop::LoopOpts;

const X: &str = "261001-0900";
const Y: &str = "261001-0901";

/// A fake `claude`: each run's argv and stdin to `$RUNS/claude-<n>.argv` / `.stdin`, then
/// `$RUNS/count` = n; with
/// `$RUNS/gone`, `--resume` fails as Claude does when the session is gone; with
/// `$RUNS/stubborn` it ignores SIGTERM; it runs while `$RUNS/hold` exists.
const FAKE_CLAUDE: &str = r#"n=$(($(cat "$RUNS/count" 2>/dev/null || echo 0) + 1))
printf '%s\n' "$@" > "$RUNS/claude-$n.argv"
cat > "$RUNS/claude-$n.stdin"
echo "$n" > "$RUNS/count.tmp" && mv "$RUNS/count.tmp" "$RUNS/count"
if [ -e "$RUNS/gone" ]; then
  for a in "$@"; do
    if [ "$a" = "--resume" ]; then
      echo "No conversation found with session ID: $2" >&2
      exit 1
    fi
  done
fi
[ -e "$RUNS/stubborn" ] && trap '' TERM
while [ -e "$RUNS/hold" ]; do sleep 0.05; done
echo '{"result": "done"}'
"#;

/// The build stage as a worker would run it: the session from `Ctx::session`, a cut-off run
/// continued, a gone session replaced.
struct Worker {
    claude: PathBuf,
}

impl Worker {
    fn run(&self, cx: &Ctx<'_>, m: &Mission, session: &Session, prompt: &str) -> ChildSpec {
        let runs = cx.runs(m);
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
        ChildSpec {
            kind: ChildKind::Claude,
            argv,
            cwd: cx.checkout(m),
            env: vec![
                ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
                ("RUNS".into(), runs.clone().into()),
            ],
            stdin: Some(file),
            stdout: runs.join("build.json"),
            stderr: runs.join("build.err"),
            timeout: None,
            slot: true,
            model: Some(m.model.clone()),
        }
    }
}

impl Handler for Worker {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        // Re-entered at its recorded run: a cut-off (crash, kill, limit): continue.
        let prompt = if m.step == "run" {
            CONTINUE
        } else {
            "build it"
        };
        let (m, session) = cx.session(m, "run")?;
        Ok(Progress::Spawn(self.run(cx, &m, &session, prompt)))
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        let err = fs::read_to_string(&end.stderr).unwrap_or_default();
        if claude::session_gone(&err) {
            let m = cx.new_session(m)?;
            let (m, session) = cx.session(&m, "run")?;
            let prompt = claude::fresh_context(
                m.branch.as_deref().unwrap_or(""),
                m.pr_url.as_deref(),
                &format!("intents/{}/intent.md", m.label()),
                &["LOOP-7".to_string()],
                "plan.md",
            );
            return Ok(Progress::Spawn(self.run(cx, &m, &session, &prompt)));
        }
        Ok(Progress::Done(Outcome::ok()))
    }
}

fn handlers(w: &World) -> Handlers {
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Build,
        Box::new(Worker {
            claude: w.root.join("bin").join("claude"),
        }),
    );
    h
}

fn world(files: &[(String, String)]) -> World {
    let w = World::new(files, &["web", "api"]);
    common::exe(&w.root.join("bin").join("claude"), FAKE_CLAUDE);
    w
}

/// Run `n`'s argv and stdin.
fn run(w: &World, id: &str, n: usize) -> (Vec<String>, String) {
    let runs = w.home.runs(id);
    let argv = fs::read_to_string(runs.join(format!("claude-{n}.argv"))).unwrap();
    let stdin = fs::read_to_string(runs.join(format!("claude-{n}.stdin"))).unwrap();
    (argv.lines().map(str::to_string).collect(), stdin)
}

fn runs(w: &World, id: &str) -> usize {
    fs::read_to_string(w.home.runs(id).join("count"))
        .map(|s| s.trim().parse().unwrap())
        .unwrap_or(0)
}

/// Gone or a zombie: no longer running.
fn dead(pid: i64) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat[stat.rfind(')').unwrap() + 2..].starts_with('Z'),
    }
}

fn wait_dead(pid: i64) {
    let end = Instant::now() + Duration::from_secs(5);
    while !dead(pid) {
        assert!(Instant::now() < end, "{pid} still runs");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn hold(w: &World, id: &str, on: bool) {
    let runs = w.home.runs(id);
    fs::create_dir_all(&runs).unwrap();
    let f = runs.join("hold");
    if on {
        fs::write(f, "").unwrap();
    } else {
        let _ = fs::remove_file(f);
    }
}

fn flag(w: &World, id: &str, name: &str) {
    let runs = w.home.runs(id);
    fs::create_dir_all(&runs).unwrap();
    fs::write(runs.join(name), "").unwrap();
}

#[test]
fn test_resume_after_kill() {
    let mut w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    hold(&w, X, true);
    let mut lp = w.open(handlers(&w));
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 1);
    let m = w.mission(X);
    assert_eq!(m.stage, Stage::Build);
    assert_eq!(m.step, "run");
    assert!(m.busy && m.session_used);
    let pid = m.child_pid.expect("child recorded");
    assert_eq!(
        m.child_start.map(|s| s as u64),
        towercab::child::start_time(pid as u32)
    );
    let (argv, stdin) = run(&w, X, 1);
    assert_eq!(argv[3..], ["--session-id".to_string(), m.session.clone()]);
    assert_eq!(stdin, "build it");

    // The loop dies (no shutdown); its child lives on in its own group.
    drop(lp);
    assert!(!dead(pid));
    // The next loop kills it, counts the unclean exit and resumes the same session.
    let mut lp = w.open(handlers(&w));
    assert!(lp.unclean.is_some());
    wait_dead(pid);
    let m = w.mission(X);
    assert_eq!((m.unclean, m.busy, m.child_pid), (1, false, None));
    assert_eq!(m.step, "run", "the recorded step is kept");
    hold(&w, X, false);
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 2);
    let (argv, stdin) = run(&w, X, 2);
    assert_eq!(argv[3..], ["--resume".to_string(), m.session.clone()]);
    assert_eq!(stdin, CONTINUE);
    w.wait_for(&mut lp, 20, |w, _| w.stage(X) == Some(Stage::Done));
    assert_eq!(w.mission(X).session, m.session);
    assert_eq!(runs(&w, X), 2, "never --session-id twice");
    lp.shutdown().unwrap();
}

#[test]
fn test_unresumable_session() {
    let mut w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    hold(&w, X, true);
    let mut lp = w.open(handlers(&w));
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 1);
    let old = w.mission(X).session;
    drop(lp);
    // The session is gone by the time the next loop resumes it.
    flag(&w, X, "gone");
    hold(&w, X, false);
    let mut lp = w.open(handlers(&w));
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 3);
    let (argv, _) = run(&w, X, 2);
    assert_eq!(argv[3..], ["--resume".to_string(), old.clone()]);
    let m = w.mission(X);
    assert_ne!(m.session, old, "a new uuid");
    assert!(uuid::Uuid::parse_str(&m.session).is_ok());
    let (argv, stdin) = run(&w, X, 3);
    assert_eq!(argv[3..], ["--session-id".to_string(), m.session.clone()]);
    for part in [
        "towercab/261001-0900-x",
        "PR: none yet",
        "intents/261001-0900/intent.md",
        "LOOP-7",
        "plan.md",
    ] {
        assert!(stdin.contains(part), "{part} in {stdin}");
    }
    w.wait_for(&mut lp, 20, |w, _| w.stage(X) == Some(Stage::Done));
    assert!(w.mission(X).session_used);
    lp.shutdown().unwrap();
}

#[test]
fn test_sigterm_not_counted() {
    let mut w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    hold(&w, X, true);
    let mut lp = w.open(handlers(&w));
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 1);
    let pid = w.mission(X).child_pid.unwrap();
    w.pass_after(&mut lp, 7);
    // SIGTERM (`down`, logout): the child's group gets SIGTERM, the mission `interrupted`;
    // its run time counts toward the step's timeout.
    lp.shutdown().unwrap();
    wait_dead(pid);
    let m = w.mission(X);
    assert_eq!((m.unclean, m.busy, m.child_pid), (0, false, None));
    assert!(m.step_secs >= 7.0, "{}", m.step_secs);
    assert_eq!((m.stage, m.step.as_str()), (Stage::Build, "run"));
    assert_eq!(w.db().meta("running").unwrap(), None);
    let last = w.transitions(X).pop().unwrap();
    assert_eq!(last, ("build".into(), "interrupted".into(), "build".into()));
    drop(lp);
    // A clean exit: nothing counted; the step resumes.
    hold(&w, X, false);
    let mut lp = w.open(handlers(&w));
    assert_eq!(lp.unclean, None);
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 2);
    let (argv, stdin) = run(&w, X, 2);
    assert_eq!(argv[3], "--resume");
    assert_eq!(stdin, CONTINUE);
    assert_eq!(w.mission(X).unclean, 0);

    // A child that ignores SIGTERM: SIGKILL after `kill_after`.
    let mut w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    hold(&w, X, true);
    flag(&w, X, "stubborn");
    let opts = LoopOpts {
        kill_after: Duration::from_millis(500),
        ..LoopOpts::default()
    };
    let mut lp = w.open_with(handlers(&w), w.exes(), opts);
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 1);
    std::thread::sleep(Duration::from_millis(200));
    let pid = w.mission(X).child_pid.unwrap();
    let started = Instant::now();
    lp.shutdown().unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(500),
        "SIGTERM ignored"
    );
    wait_dead(pid);
    assert_eq!(w.mission(X).unclean, 0);
}

#[test]
fn test_crash_loop_capped() {
    // Unclean exits count only busy missions: X builds (a child), Y polls CI.
    let mut w = world(&[
        intent_file("261001-0900-x", "web", "", "X"),
        intent_file("261001-0901-y", "api", "u: 5\ni: 5\n", "Y"),
    ]);
    hold(&w, X, true);
    let mk = |w: &World| {
        let mut h = handlers(w);
        h.set(
            Stage::Ci,
            Scripted::by(Act::Ok, &[(Y, Act::Poll(Duration::from_secs(30)))]),
        );
        h
    };
    let mut lp = w.open(mk(&w));
    w.wait_for(&mut lp, 30, |w, _| {
        w.stage(Y) == Some(Stage::Ci) && runs(w, X) == 1
    });
    for crash in 1..=3 {
        let pid = w.mission(X).child_pid.unwrap();
        w.pass_after(&mut lp, 7);
        drop(lp);
        lp = w.open(mk(&w));
        wait_dead(pid);
        let (x, y) = (w.mission(X), w.mission(Y));
        assert_eq!(
            (y.stage, y.unclean),
            (Stage::Ci, 0),
            "not busy: not counted"
        );
        if crash < 3 {
            assert_eq!((x.stage, x.unclean), (Stage::Build, crash));
            // The killed run's time counts toward the step's timeout, up to the last pass.
            assert!(x.step_secs >= 7.0 * f64::from(crash), "{}", x.step_secs);
            w.wait_for(&mut lp, 20, |w, _| runs(w, X) == crash as usize + 1);
        } else {
            assert_eq!(x.stage, Stage::Blocked);
            assert_eq!(x.waiting.as_deref(), Some("crashed at build"));
            assert_eq!(x.from_stage, Some(Stage::Build));
        }
    }
    let rows = w.outbox();
    let x = w.mission(X);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].0.as_str(), rows[0].1.as_str(), rows[0].2.as_str()),
        (x.id.to_string().as_str(), "crashed_at", "0")
    );
    assert!(
        rows[0]
            .3
            .starts_with("crashed at build\n261001-0900 web: X\n")
    );
    // I continue: back to build, counts reset.
    w.pass(&mut lp);
    assert!(
        w.intent_md("261001-0900-x")
            .contains("waiting: crashed at build")
    );
    hold(&w, X, false);
    w.intents.push_mine(
        &[(
            "intents/261001-0900-x/intent.md",
            Some(&common::intent_md("web", "stage: build\n", "X")),
        )],
        "continue",
    );
    w.until(&mut lp, 3, |w| w.stage(X) == Some(Stage::Build));
    let x = w.mission(X);
    assert_eq!((x.unclean, x.continued), (0, 1));

    // A handler's panic counts the same: the third → crashed at <stage>.
    let mut w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    let mut h = handlers(&w);
    h.set(Stage::Plan, Box::new(Panics));
    let mut lp = w.open(h);
    w.until(&mut lp, 10, |w| w.stage(X) == Some(Stage::Blocked));
    let x = w.mission(X);
    assert_eq!(x.waiting(), Some(Waiting::CrashedAt(Stage::Plan)));
    let crashes = w
        .transitions(X)
        .into_iter()
        .filter(|(f, e, _)| f == "plan" && e == "crash")
        .count();
    assert_eq!(crashes, 3);
    lp.shutdown().unwrap();
}

#[test]
fn test_dying_child_killed_after_crash() {
    // I remove the intent while its build runs: stopped, the child (ignoring SIGTERM) dying.
    // The loop crashes before its SIGKILL: the next start kills it (`meta.dying`).
    let mut w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    hold(&w, X, true);
    flag(&w, X, "stubborn");
    let mut lp = w.open(handlers(&w));
    w.wait_for(&mut lp, 20, |w, _| runs(w, X) == 1);
    std::thread::sleep(Duration::from_millis(200));
    let pid = w.mission(X).child_pid.unwrap();
    w.intents
        .push_mine(&[("intents/261001-0900-x/intent.md", None)], "drop X");
    w.pass(&mut lp);
    let m = w.mission(X);
    assert_eq!((m.stage, m.child_pid), (Stage::Stopped, None));
    std::thread::sleep(Duration::from_millis(200));
    assert!(!dead(pid), "SIGTERM ignored");
    assert!(w.db().meta("dying").unwrap().is_some());
    drop(lp);
    let lp = w.open(handlers(&w));
    wait_dead(pid);
    assert_eq!(w.db().meta("dying").unwrap(), None);
    drop(lp);
}

/// What a [`Bad`] handler returns.
#[derive(Clone, Copy)]
enum Bad {
    /// `blocked` without a mission's waiting (a pick-time one).
    NoWaiting,
    /// `limit` without a `Limit`.
    NoLimit,
    /// An event its stage ignores.
    Ignored,
    /// `StepError::Bug`.
    Bug,
    /// A child whose directory is missing: the handler's bug, not `sh`'s fault.
    NoCwd,
}

impl Handler for Bad {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        Ok(Progress::Done(match self {
            Bad::NoCwd => {
                let runs = cx.runs(m);
                return Ok(Progress::Spawn(ChildSpec {
                    kind: ChildKind::Checks,
                    argv: vec!["sh".into(), "-c".into(), "exit 0".into()],
                    cwd: runs.join("missing"),
                    env: vec![],
                    stdin: None,
                    stdout: runs.join("plan.out"),
                    stderr: runs.join("plan.err"),
                    timeout: None,
                    slot: true,
                    model: None,
                }));
            }
            Bad::NoWaiting => Outcome::wait(Waiting::UnknownRepo, ""),
            Bad::NoLimit => Outcome::event(Event::Limit),
            Bad::Ignored => Outcome::event(Event::Approve),
            Bad::Bug => return Err(StepError::Bug("no plan.md".into())),
        }))
    }
    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        _: ChildEnd,
    ) -> Result<Progress, StepError> {
        self.step(cx, m)
    }
}

#[test]
fn test_bad_outcome_counted() {
    // An outcome the table can't carry out is Unexpected: counted like a crash, the third
    // → crashed at <stage>; the passes go on, the step isn't left busy.
    for bad in [
        Bad::NoWaiting,
        Bad::NoLimit,
        Bad::Ignored,
        Bad::Bug,
        Bad::NoCwd,
    ] {
        let mut w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
        let mut h = handlers(&w);
        h.set(Stage::Plan, Box::new(bad));
        let mut lp = w.open(h);
        w.until(&mut lp, 10, |w| w.stage(X) == Some(Stage::Blocked));
        let x = w.mission(X);
        assert_eq!(x.waiting(), Some(Waiting::CrashedAt(Stage::Plan)));
        assert!(!x.busy);
        let from_plan = w
            .transitions(X)
            .into_iter()
            .filter(|(f, _, _)| f == "plan")
            .count();
        assert_eq!(from_plan, 3);
        let why: Option<String> = w
            .db()
            .conn()
            .query_row(
                "SELECT why FROM transitions WHERE from_stage = 'plan' ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(why.unwrap().starts_with("unexpected "));
        assert!(towercab::env::faults(w.db().conn()).unwrap().is_empty());
        lp.shutdown().unwrap();
    }
}

struct Panics;

impl Handler for Panics {
    fn step(&mut self, _: &mut Ctx<'_>, _: &Mission) -> Result<Progress, StepError> {
        panic!("a bug in the handler");
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        panic!("a bug in the handler");
    }
}

#[test]
fn test_step_interrupted() {
    // `towercab step` gets SIGINT (Ctrl-C) while its child runs: the child is stopped and the
    // mission `interrupted` (not counted), as at a loop's shutdown.
    let w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    hold(&w, X, true);
    let mut lp = w.open(handlers(&w));
    assert_eq!(lp.step_intent(X).unwrap(), format!("{X}: pick → design"));
    assert_eq!(lp.step_intent(X).unwrap(), format!("{X}: design → plan"));
    assert_eq!(lp.step_intent(X).unwrap(), format!("{X}: plan → build"));
    let stop = lp.stop_flag();
    let runs_dir = w.home.runs(X);
    std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(10);
        while !runs_dir.join("count").exists() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    assert_eq!(lp.step_intent(X), Err(format!("{X}: interrupted")));
    let pid = w.mission(X).child_pid.unwrap();
    lp.shutdown().unwrap();
    wait_dead(pid);
    let m = w.mission(X);
    assert_eq!((m.stage, m.unclean, m.busy), (Stage::Build, 0, false));
    let last = w.transitions(X).pop().unwrap();
    assert_eq!(last, ("build".into(), "interrupted".into(), "build".into()));
}

#[test]
fn test_step_refuses_waits() {
    // `step` doesn't wait: a cooling model, a backoff or entry effects not done refuse it.
    let w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    let mut lp = w.open(handlers(&w));
    assert_eq!(lp.step_intent(X).unwrap(), format!("{X}: pick → design"));
    let db = w.db();
    db.conn()
        .execute(
            "INSERT INTO cooldowns (provider, model, until, parsed, text, since)
             VALUES ('claude', 'opus', 9e9, 1, 'limit', 0)",
            [],
        )
        .unwrap();
    let set = |sql: &str| db.conn().execute(sql, []).unwrap();
    set("UPDATE missions SET limit_model = 'opus'");
    let e = lp.step_intent(X).unwrap_err();
    assert!(e.starts_with(&format!("{X}: opus cooling until ")), "{e}");
    set("UPDATE missions SET limit_model = NULL, retry_at = 9e9");
    let e = lp.step_intent(X).unwrap_err();
    assert!(e.starts_with(&format!("{X}: retry at ")), "{e}");
    // Its entry write can't be pushed: refused with the error, the step not called.
    set("UPDATE missions SET retry_at = NULL, step = 'enter'");
    fs::rename(&w.intents.remote, w.root.join("gone.git")).unwrap();
    let e = lp.step_intent(X).unwrap_err();
    assert!(e.starts_with(&format!("{X}: pull failed: ")), "{e}");
    let m = w.mission(X);
    assert_eq!((m.stage, m.step.as_str()), (Stage::Design, "enter"));
    lp.shutdown().unwrap();
}

#[test]
fn test_run_session_fresh_per_run() {
    // Review, triage and verifier runs: a new session per run (`missions.run_session`),
    // resumed only when re-entered at its recorded step (a cut-off); the worker's untouched.
    let w = world(&[intent_file("261001-0900-x", "web", "", "X")]);
    let db = w.db();
    db.conn()
        .execute(
            "INSERT INTO missions (intent, repo, stage, step, model, session, checkout, created,
               updated)
             VALUES ('261001-0900', 'web', 'review', '', 'opus', 'worker', 'work/x', 0, 0)",
            [],
        )
        .unwrap();
    let m = towercab::mission::get(db.conn(), 1).unwrap();
    let store = w.intents.store();
    let exes = w.exes();
    let mut identity = towercab::github::Identity::none();
    let probe = towercab::handler::Probe::default();
    let cx = Ctx {
        config: &w.config,
        home: &w.home,
        db: &db,
        store: &store,
        exes: &exes,
        identity: &mut identity,
        tick: w.clock,
        timeouts: true,
        probe: &probe,
    };
    let (m1, s1) = cx.run_session(&m, "review").unwrap();
    let Session::New(first) = s1 else {
        panic!("{s1:?}")
    };
    assert_ne!(first, "worker");
    assert_eq!(
        (m1.step.as_str(), m1.run_session.as_deref()),
        ("review", Some(first.as_str()))
    );
    // Cut off and re-entered at its step: resumed.
    let (m2, s2) = cx.run_session(&m1, "review").unwrap();
    assert_eq!(s2, Session::Resume(first.clone()));
    // The next run (after another step): a new one.
    let m3 = cx.record(&m2, "triage", &[]).unwrap();
    let (m4, s4) = cx.run_session(&m3, "review").unwrap();
    let Session::New(second) = s4 else {
        panic!("{s4:?}")
    };
    assert_ne!(second, first);
    assert_eq!((m4.session.as_str(), m4.session_used), ("worker", false));
}
