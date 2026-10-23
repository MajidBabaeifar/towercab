//! The pass (LOOP-12): children never block it; polls keep their cadence while one runs; a
//! child's timeout (run time, monotonic) sends SIGTERM to its process group, SIGKILL 10 s later.

mod common;

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;
use std::time::{Duration, Instant};

use common::world::{Act, Poller, PublishesPr, Scripted, World, intent_file, open_pr};
use towercab::commands::{self, Cmd, PAUSED};
use towercab::handler::{
    ChildEnd, ChildKind, ChildSpec, Ctx, Handler, Handlers, Outcome, Progress, StepError,
};
use towercab::machine::Stage;
use towercab::mission::Mission;
use towercab::pick::Pick;

const X: &str = "261001-0900";
const Y: &str = "261001-0901";

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

/// A build whose child (a shell and its `sleep` grandchild, both ignoring SIGTERM for X) runs
/// until killed, with a 30 s timeout; each end logged.
struct Sleeper {
    ends: Rc<RefCell<Vec<(String, ChildEnd)>>>,
}

impl Handler for Sleeper {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let m = cx.record(m, "run", &[])?;
        let runs = cx.runs(&m);
        fs::create_dir_all(&runs).unwrap();
        let trap = if m.label() == X { "trap '' TERM; " } else { "" };
        Ok(Progress::Spawn(ChildSpec {
            kind: ChildKind::Checks,
            argv: vec![
                "sh".into(),
                "-c".into(),
                format!(
                    "{trap}sleep 1000 & echo $! > {g}.tmp && mv {g}.tmp {g}; wait",
                    g = runs.join("grandchild").display()
                )
                .into(),
            ],
            cwd: cx.checkout(&m),
            env: vec![("PATH".into(), std::env::var_os("PATH").unwrap_or_default())],
            stdin: None,
            stdout: runs.join("checks.out"),
            stderr: runs.join("checks.err"),
            timeout: Some(Duration::from_secs(30)),
            slot: true,
            model: None,
        }))
    }

    fn finish(
        &mut self,
        _: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        self.ends.borrow_mut().push((m.label(), end));
        Ok(Progress::Done(Outcome::ok()))
    }
}

fn grandchild(w: &World, id: &str) -> Option<i64> {
    fs::read_to_string(w.home.runs(id).join("grandchild"))
        .ok()
        .map(|s| s.trim().parse().unwrap())
}

#[test]
fn test_timeout_kills_group() {
    use std::os::unix::process::ExitStatusExt;
    let mut w = World::new(
        &[
            intent_file("261001-0900-x", "web", "u: 5\ni: 5\n", "X"),
            intent_file("261001-0901-y", "api", "u: 4\ni: 4\n", "Y"),
        ],
        &["web", "api"],
    );
    let ends = Rc::new(RefCell::new(Vec::new()));
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Build, Box::new(Sleeper { ends: ends.clone() }));
    let mut lp = w.open(h);

    // X ignores SIGTERM, and so does its grandchild: SIGKILL to the group 10 s after.
    w.wait_for(&mut lp, 20, |w, _| grandchild(w, X).is_some());
    let m = w.mission(X);
    let (pid, g) = (m.child_pid.unwrap(), grandchild(&w, X).unwrap());
    // Seconds of run time the passes until now took.
    let k = w.clock.unix() - m.child_since.unwrap();
    assert!(k < 10.0);
    w.pass_after(&mut lp, 20);
    assert!(!dead(pid) && !dead(g), "20 s of 30");
    w.pass_after(&mut lp, 11);
    std::thread::sleep(Duration::from_millis(200));
    assert!(!dead(pid) && !dead(g), "SIGTERM sent at 31 s, ignored");
    w.pass_after(&mut lp, 5);
    std::thread::sleep(Duration::from_millis(200));
    assert!(!dead(pid) && !dead(g), "SIGKILL only 10 s after SIGTERM");
    assert!(ends.borrow().is_empty());
    w.pass_after(&mut lp, 6);
    wait_dead(pid);
    wait_dead(g);
    w.pass_after(&mut lp, 1);
    {
        let ends = ends.borrow();
        let (id, end) = &ends[0];
        assert_eq!(id, X);
        assert!(end.timed_out);
        assert_eq!(end.status.and_then(|s| s.signal()), Some(libc::SIGKILL));
        assert!(
            (end.run.as_secs_f64() - (k + 43.0)).abs() < 1e-3,
            "monotonic run time"
        );
    }

    // Y doesn't ignore SIGTERM: it and its grandchild end at the timeout.
    w.wait_for(&mut lp, 20, |w, _| grandchild(w, Y).is_some());
    let pid = w.mission(Y).child_pid.unwrap();
    let g = grandchild(&w, Y).unwrap();
    w.pass_after(&mut lp, 30);
    wait_dead(pid);
    wait_dead(g);
    w.pass_after(&mut lp, 1);
    let ends = ends.borrow();
    let (id, end) = &ends[1];
    assert_eq!(id, Y);
    assert!(end.timed_out);
    assert_eq!(end.status.and_then(|s| s.signal()), Some(libc::SIGTERM));
    assert!(end.run >= Duration::from_secs(30));
}

#[test]
fn test_polls_while_child_runs() {
    // parallel 1. Y (first in order) polls CI; X's build child holds the slot meanwhile.
    let mut w = World::new(
        &[
            intent_file("261001-0900-x", "web", "u: 4\ni: 4\n", "X"),
            intent_file("261001-0901-y", "api", "u: 5\ni: 5\n", "Y"),
        ],
        &["web", "api"],
    );
    w.prs.set(7, open_pr("h1"));
    let ci = Poller::every(Duration::from_secs(30));
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Design, Box::new(PublishesPr));
    h.set(Stage::Build, Scripted::by(Act::Ok, &[(X, Act::Child)]));
    h.set(Stage::Ci, Box::new(ci.clone()));
    let mut lp = w.open(h);
    w.wait_for(&mut lp, 20, |w, lp| {
        w.stage(Y) == Some(Stage::Ci) && w.stage(X) == Some(Stage::Build) && lp.running().len() == 1
    });
    let pid = w.mission(X).child_pid.unwrap();
    let (reads, polls) = (w.prs.reads(), ci.of(Y).len());

    // Two minutes of passes 5 s apart while the child runs: each returns at once.
    let db = w.db();
    commands::queue(&db, &Cmd::Pause, "telegram").unwrap();
    w.intents.push_mine(
        &[(
            "intents/261001-0902-z/intent.md",
            Some(&common::intent_md("web", "", "Z")),
        )],
        "add Z",
    );
    let mut replies = Vec::new();
    for _ in 0..24 {
        let started = Instant::now();
        let r = w.pass_after(&mut lp, 5);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a pass never waits for a child"
        );
        replies.extend(r.commands.into_iter().map(|(_, reply)| reply));
    }
    assert_eq!(replies, [PAUSED], "commands applied");
    assert!(!dead(pid), "the child still runs");
    assert_eq!(lp.running().len(), 1);
    assert_eq!(w.stage(X), Some(Stage::Build));
    assert_eq!(ci.of(Y).len() - polls, 4, "CI polled every 30 s");
    assert_eq!(w.prs.reads() - reads, 4, "both PRs read every 60 s");
    assert!(
        lp.listing().unwrap().open.iter().any(|i| i.title() == "Z"),
        "intents polled"
    );

    // The child ends: X goes on.
    w.release(X, Stage::Build);
    w.wait_for(&mut lp, 20, |w, _| w.stage(X) == Some(Stage::Ci));
}

#[test]
fn test_cadence() {
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    w.config.agent.ci_poll = Duration::from_secs(30);
    w.prs.set(7, open_pr("h1"));
    // Issues are polled only with `[intents].remote` on GitHub (INT-7): the bare intents repo
    // as `https://github.com/me/intents.git`, Towercab's checkout cloned before.
    drop(w.intents.store());
    let hub = w.root.join("hub");
    fs::create_dir_all(hub.join("me")).unwrap();
    std::os::unix::fs::symlink(&w.intents.remote, hub.join("me/intents.git")).unwrap();
    w.config.intents.remote = Some("https://github.com/me/intents.git".into());
    let exes = towercab::exes::Exes {
        git: common::github_git(&w.root.join("gitbin"), &hub).into(),
        ..w.exes()
    };
    let ci = Poller::every(w.config.agent.ci_poll);
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Design, Box::new(PublishesPr));
    h.set(Stage::Ci, Box::new(ci.clone()));
    let mut lp = w.open_with(h, exes, Default::default());
    w.until(&mut lp, 20, |w| w.stage(X) == Some(Stage::Ci));
    // Line the clock up on an intents poll (every 60 s): 61 s on, every poll is due.
    w.pass(&mut lp);
    let (t0, reads) = (w.clock.mono, w.prs.reads());
    let polls = ci.of(X).len();
    w.intents.push_mine(
        &[(
            "intents/261001-0901-y/intent.md",
            Some(&common::intent_md("web", "", "Y")),
        )],
        "add Y",
    );
    let seen =
        |lp: &towercab::runloop::Loop| lp.listing().unwrap().open.iter().any(|i| i.title() == "Y");
    // Three minutes of passes 5 s apart (then four more for issues and gauges).
    let (mut drafts, mut gauges) = (Vec::new(), Vec::new());
    for i in 1..=84 {
        let r = w.pass_after(&mut lp, 5);
        let t = (w.clock.mono - t0).as_secs();
        if r.drafts {
            drafts.push(t);
        }
        if r.gauges {
            gauges.push(t);
        }
        if i == 11 {
            assert!(!seen(&lp), "intents: not before 60 s");
        }
        if i == 12 {
            assert!(seen(&lp), "intents: at 60 s");
        }
        if i == 36 {
            assert_eq!(w.prs.reads() - reads, 3, "PR reads: every 60 s");
        }
    }
    let at: Vec<u64> = ci.of(X)[polls..polls + 6]
        .iter()
        .map(|(t, _)| (*t - t0).as_secs())
        .collect();
    assert_eq!(
        at,
        [30, 60, 90, 120, 150, 180],
        "CI: ci_poll (the handler's Poll)"
    );
    // Issues and draft PRs every 300 s (each repo's `gh issue list`), gauges every 60 s
    // (MET-20). Telegram goes every pass (LOOP-16's tests).
    let steps = |v: &[u64]| v.windows(2).map(|p| p[1] - p[0]).collect::<Vec<_>>();
    assert_eq!(steps(&drafts), [300], "{drafts:?}");
    assert_eq!(steps(&gauges), [60; 6], "{gauges:?}");
    let listed = std::fs::read_to_string(w.fakebin().join("gh.log")).unwrap();
    assert!(
        listed
            .lines()
            .all(|l| l.starts_with("issue list -R me/web --label intent")),
        "{listed}"
    );
}
