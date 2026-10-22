//! Durable steps (LOOP-6): the loop crashed after each of its durable writes in turn (a
//! `record`, a transition, an entry effect, a pick), reopened on the same home, reaches
//! `done` with each intent write, outbox row and checkout made once. Its own binary: it sets
//! a panic hook.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::atomic::{AtomicU64, Ordering};

use common::world::{Act, Scripted, World, intent_file};
use towercab::exes::Exes;
use towercab::handler::{Crashed, Handlers};
use towercab::machine::{Stage, Waiting};
use towercab::pick::Pick;
use towercab::runloop::{Loop, LoopOpts};

const ID: &str = "261001-0900";
const DIR: &str = "intents/261001-0900-x/intent.md";

/// What a run left: Towercab's commits on `intents` (subjects), the outbox, the transitions
/// without `crash` ones, how often the checkout was cloned.
#[derive(Debug, PartialEq)]
struct Trace {
    commits: Vec<String>,
    outbox: Vec<(String, String, String, String)>,
    transitions: Vec<(String, String, String)>,
    clones: usize,
}

fn handlers() -> Handlers {
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Design,
        Scripted::all(Act::Wait(Waiting::ApproveSpec)),
    );
    h
}

fn open(w: &World, git: &std::path::Path) -> Loop {
    let exes = Exes {
        git: git.into(),
        ..Exes::default()
    };
    w.open_with(handlers(), exes, LoopOpts::default())
}

/// One intent from pick to done, approving its spec when asked; with `crash`, the loop dies
/// at that durable write and a new one carries on. Returns the trace and the points passed.
fn scenario(crash: Option<u64>) -> (Trace, u64, bool) {
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    let log = w.root.join("clones.log");
    let git = w.root.join("bin").join("git");
    common::exe(
        &git,
        &format!(
            "for a in \"$@\"; do [ \"$a\" = clone ] && echo clone >> {}; done\nexec git \"$@\"\n",
            log.display()
        ),
    );
    let mut lp = open(&w, &git);
    lp.probe.crash_after(crash);
    let (mut crashed, mut approved) = (false, false);
    for _ in 0..80 {
        let m = w.missions(ID).pop();
        if m.as_ref()
            .is_some_and(|m| m.stage == Stage::Done && m.step.is_empty())
        {
            break;
        }
        if !approved && w.intents.remote_file(DIR).contains("waiting: approve spec") {
            w.intents.push_mine(
                &[(DIR, Some(&common::intent_md("web", "stage: design\n", "X")))],
                "approve",
            );
            approved = true;
        }
        match catch_unwind(AssertUnwindSafe(|| w.pass(&mut lp))) {
            Ok(_) => {}
            Err(p) if p.is::<Crashed>() => {
                assert!(!crashed, "one crash per scenario");
                crashed = true;
                drop(lp);
                lp = open(&w, &git);
            }
            Err(p) => resume_unwind(p),
        }
    }
    let ms = w.missions(ID);
    assert_eq!(ms.len(), 1, "crash at {crash:?}: one attempt");
    assert_eq!(
        (ms[0].stage, ms[0].step.as_str()),
        (Stage::Done, ""),
        "crash at {crash:?}: done"
    );
    assert!(w.intents.remote_has("done/261001-0900-x/intent.md"));
    assert!(!w.home.root.join(&ms[0].checkout).exists());
    let points = lp.probe.count();
    lp.shutdown().unwrap();
    let trace = Trace {
        commits: w
            .intents
            .log()
            .into_iter()
            .filter(|s| s.starts_with("towercab: "))
            .collect(),
        outbox: w.outbox(),
        transitions: w
            .transitions(ID)
            .into_iter()
            .filter(|(_, e, _)| e != "crash")
            .collect(),
        clones: fs::read_to_string(&log)
            .map(|s| s.lines().count())
            .unwrap_or(0),
    };
    (trace, points, crashed)
}

#[test]
fn test_crash_at_every_step() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !info.payload().is::<Crashed>() {
            default(info);
        }
    }));
    let (want, points, crashed) = scenario(None);
    assert!(!crashed);
    assert!(points >= 40, "{points} durable writes");
    assert_eq!(want.clones, 1);
    assert_eq!(want.outbox.len(), 1, "approve spec, once");
    assert_eq!(
        (want.outbox[0].1.as_str(), want.outbox[0].2.as_str()),
        ("approve_spec", "0")
    );
    for stage in ["pick", "approval:spec", "plan", "verify", "review", "done"] {
        let n = want
            .commits
            .iter()
            .filter(|c| **c == format!("towercab: {stage} {ID}"))
            .count();
        assert_eq!(n, 1, "{stage}: {:?}", want.commits);
    }
    // Crash after every k-th durable write, scenarios in parallel.
    let next = AtomicU64::new(1);
    let failures: BTreeMap<u64, String> = std::thread::scope(|s| {
        let workers: Vec<_> = (0..8)
            .map(|_| {
                s.spawn(|| {
                    let mut bad = BTreeMap::new();
                    loop {
                        let k = next.fetch_add(1, Ordering::SeqCst);
                        if k > points {
                            return bad;
                        }
                        let got = catch_unwind(|| scenario(Some(k)));
                        match got {
                            Ok((trace, _, true)) if trace == want => {}
                            Ok((trace, _, crashed)) => {
                                bad.insert(k, format!("crashed {crashed}: {trace:?}"));
                            }
                            Err(p) => {
                                let msg = p
                                    .downcast_ref::<String>()
                                    .cloned()
                                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                                    .unwrap_or_default();
                                bad.insert(k, format!("panicked: {msg}"));
                            }
                        }
                    }
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect()
    });
    assert!(
        failures.is_empty(),
        "of {points}, crashes at:\n{}\nwant {want:?}",
        failures
            .iter()
            .map(|(k, f)| format!("{k}: {f}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}
