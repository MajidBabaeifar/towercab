//! Stay awake (LOOP-11): one `systemd-inhibit` child while a mission is driven, none while
//! all wait on me or on a limit; after the machine slept, every wait polls again before any
//! wait timeout can fire.

mod common;

use std::fs;
use std::time::{Duration, Instant};

use chrono::{TimeDelta, Utc};
use common::world::{Act, Poller, PublishesPr, Scripted, World, intent_file, open_pr, waiter};
use towercab::awake;
use towercab::handler::{ChildEnd, Ctx, Handler, Handlers, Outcome, Progress, StepError};
use towercab::limits::Limit;
use towercab::machine::{Stage, Waiting};
use towercab::mission::Mission;
use towercab::pick::Pick;
use towercab::runloop::Tick;

const X: &str = "261001-0900";

/// Gone or a zombie: no longer running.
fn dead(pid: i64) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat[stat.rfind(')').unwrap() + 2..].starts_with('Z'),
    }
}

/// Waits (real time, no passes) until `f` holds.
fn eventually(what: &str, f: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < end, "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A build whose child (`waiter`) ends in a usage limit the first time (reset 10 min on),
/// then in `ok`.
struct LimitOnce {
    hit: bool,
}

impl Handler for LimitOnce {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let m = if m.step == "run" {
            m.clone()
        } else {
            cx.record(m, "run", &[])?
        };
        Ok(Progress::Spawn(waiter(cx, &m)))
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        _: ChildEnd,
    ) -> Result<Progress, StepError> {
        if self.hit {
            return Ok(Progress::Done(Outcome::ok()));
        }
        self.hit = true;
        Ok(Progress::Done(Outcome::limit(Limit {
            model: m.model.clone(),
            reset: Some(cx.tick.wall.with_timezone(&Utc) + TimeDelta::minutes(10)),
            text: "usage limit reached".into(),
        })))
    }
}

#[test]
fn test_inhibit_while_driving() {
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Design,
        Scripted::all(Act::Wait(Waiting::ApproveSpec)),
    );
    h.set(Stage::Build, Box::new(LimitOnce { hit: false }));
    let mut lp = w.open(h);
    assert_eq!(w.inhibits(), 0, "nothing driven yet");

    // Picked: one inhibitor, named after the mission and its stage then.
    w.pass(&mut lp);
    assert_eq!(w.stage(X), Some(Stage::Pick));
    eventually("inhibitor 1 starts", || w.inhibits() == 1);
    let (argv, pid1) = w.inhibitor(1);
    assert_eq!(
        argv,
        [
            "--what=sleep:idle:handle-lid-switch",
            "--who=Towercab",
            "--why=261001-0900 pick",
            "--mode=block",
            "sleep",
            "infinity",
        ]
    );
    assert_eq!(
        lp.inhibitor(),
        Some((pid1 as u32, "261001-0900 pick".into()))
    );

    // Waiting on me (approval:spec): killed.
    w.until(&mut lp, 5, |w| w.stage(X) == Some(Stage::ApprovalSpec));
    assert_eq!(lp.inhibitor(), None);
    eventually("inhibitor 1 killed", || dead(pid1));

    // Approved: driven again; a new inhibitor, kept through stage changes; not a slot.
    w.intents.push_mine(
        &[(
            "intents/261001-0900-x/intent.md",
            Some(&common::intent_md("web", "stage: design\n", "X")),
        )],
        "approve",
    );
    w.until(&mut lp, 5, |w| w.stage(X) == Some(Stage::Build));
    w.pass(&mut lp);
    eventually("inhibitor 2 starts", || w.inhibits() == 2);
    let (argv, pid2) = w.inhibitor(2);
    assert!(argv[2].starts_with("--why=261001-0900 "), "{argv:?}");
    assert_eq!(lp.running().len(), 1, "the build's child runs");
    assert_eq!(lp.slots_used(), 1, "the inhibitor holds no slot");
    for _ in 0..3 {
        w.pass(&mut lp);
    }
    assert_eq!(w.inhibits(), 2);
    assert!(!dead(pid2));

    // A limit wait: killed until the cooldown ends.
    w.release(X, Stage::Build);
    w.wait_for(&mut lp, 10, |w, _| w.mission(X).limit_model.is_some());
    assert_eq!(lp.inhibitor(), None);
    eventually("inhibitor 2 killed", || dead(pid2));
    for _ in 0..5 {
        w.pass_after(&mut lp, 60);
        assert_eq!(w.inhibits(), 2, "not while the limit lasts");
    }
    w.pass_after(&mut lp, 360);
    assert_eq!(w.stage(X), Some(Stage::Build));
    eventually("inhibitor 3 starts", || w.inhibits() == 3);
    let (argv, pid3) = w.inhibitor(3);
    assert_eq!(argv[2], "--why=261001-0900 build");

    // Done: killed; the loop's shutdown leaves none behind either.
    w.until(&mut lp, 20, |w| w.stage(X) == Some(Stage::Done));
    w.pass(&mut lp);
    eventually("inhibitor 3 killed", || dead(pid3));
    assert_eq!(lp.inhibitor(), None);
    lp.shutdown().unwrap();
    assert_eq!(w.inhibits(), 3);
}

#[test]
fn test_wake_repolls_before_timeout() {
    let pass = Duration::from_secs(5);
    let at = |wall: i64, mono: u64| Tick {
        wall: chrono::DateTime::parse_from_rfc3339("2026-10-15T13:30:00+02:00").unwrap()
            + TimeDelta::seconds(wall),
        mono: Duration::from_secs(mono),
    };
    // Suspend stops the monotonic clock: woke when the wall clock ran > 3 passes ahead of it.
    assert!(awake::woke(at(0, 100), at(16, 100), pass));
    assert!(!awake::woke(at(0, 100), at(15, 100), pass));
    assert!(
        !awake::woke(at(0, 100), at(61, 161), pass),
        "a slow pass isn't sleep"
    );
    assert!(!awake::woke(at(0, 100), at(3600, 3690), pass));
    assert!(awake::woke(at(0, 100), at(7200, 105), pass));

    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    w.prs.set(7, open_pr("h1"));
    let ci = Poller::every(Duration::from_secs(30));
    let handlers = |ci: &Poller| {
        let mut h = Handlers::stubs();
        h.set(Stage::Pick, Box::new(Pick));
        h.set(Stage::Design, Box::new(PublishesPr));
        h.set(Stage::Ci, Box::new(ci.clone()));
        h
    };
    let mut lp = w.open(handlers(&ci));
    w.until(&mut lp, 20, |w| w.stage(X) == Some(Stage::Ci));
    // Awake, passes 5 s apart, and a slow pass: polls every 30 s, timeouts on.
    for _ in 0..12 {
        assert!(!w.pass_after(&mut lp, 5).woke);
    }
    assert!(!w.pass_after(&mut lp, 61).woke);
    assert!(ci.of(X).iter().all(|(_, on)| *on));

    // A poll, then the laptop sleeps 2 h (5 s of monotonic time pass).
    let n = ci.of(X).len();
    while ci.of(X).len() == n {
        w.pass_after(&mut lp, 5);
    }
    let (polls, reads) = (ci.of(X).len(), w.prs.reads());
    w.intents.push_mine(
        &[(
            "intents/261001-0901-y/intent.md",
            Some(&common::intent_md("web", "", "Y")),
        )],
        "add Y",
    );
    w.clock = Tick {
        wall: w.clock.wall + TimeDelta::hours(2),
        mono: w.clock.mono + Duration::from_secs(5),
    };
    let r = lp.pass(w.clock).unwrap();
    assert!(r.woke);
    // Its poll came at once (25 s early by the monotonic clock), with timeouts off.
    assert_eq!(ci.of(X).len(), polls + 1);
    assert_eq!(ci.of(X).last().unwrap(), &(w.clock.mono, false));
    assert_eq!(w.prs.reads(), reads + 1, "the PR read again");
    assert!(
        lp.listing().unwrap().open.iter().any(|i| i.title() == "Y"),
        "intents polled"
    );
    // The next poll, 30 s later, may time out again.
    for _ in 0..6 {
        w.pass_after(&mut lp, 5);
    }
    assert_eq!(ci.of(X).len(), polls + 2);
    assert_eq!(ci.of(X).last().unwrap(), &(w.clock.mono, true));

    // A restart soon after the last pass: no wake. One after a gap (`meta.last_pass`): woke.
    lp.shutdown().unwrap();
    drop(lp);
    let mut lp = w.open(handlers(&ci));
    assert!(!w.pass_after(&mut lp, 10).woke);
    assert!(ci.of(X).last().unwrap().1);
    lp.shutdown().unwrap();
    drop(lp);
    let mut lp = w.open(handlers(&ci));
    let n = ci.of(X).len();
    assert!(w.pass_after(&mut lp, 600).woke);
    assert_eq!(ci.of(X).len(), n + 1);
    assert!(!ci.of(X).last().unwrap().1, "its first poll after the gap");
    lp.shutdown().unwrap();
}
