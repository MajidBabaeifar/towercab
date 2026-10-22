//! Concurrency (LOOP-4): `[agent].parallel` slots, `workers` per repo, one unfinished mission
//! per intent; a free slot goes to unfinished missions before the picker.

mod common;

use std::time::Duration;

use common::world::{Act, Scripted, World, intent_file};
use towercab::handler::Handlers;
use towercab::machine::{Stage, Waiting};
use towercab::mission::{self, NewMission};
use towercab::pick::Pick;

const A: &str = "261001-0900";
const B: &str = "261001-0901";
const C: &str = "261001-0902";
const D: &str = "261001-0903";

#[test]
fn test_pick_while_others_wait() {
    // parallel 1. A waits on CI (polls), B on me (approval:spec): C is picked and its build
    // runs; D waits for the slot, which goes to B first when I approve.
    let mut w = World::new(
        &[
            intent_file("261001-0900-a", "web", "u: 5\ni: 5\n", "A"),
            intent_file("261001-0901-b", "api", "u: 5\ni: 4\n", "B"),
            intent_file("261001-0902-c", "cli", "u: 4\ni: 4\n", "C"),
            intent_file("261001-0903-d", "doc", "u: 3\ni: 3\n", "D"),
        ],
        &["web", "api", "cli", "doc"],
    );
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Design,
        Scripted::by(Act::Ok, &[(B, Act::Wait(Waiting::ApproveSpec))]),
    );
    h.set(Stage::Build, Scripted::all(Act::Child));
    h.set(
        Stage::Verify,
        Scripted::by(Act::Ok, &[(B, Act::Child), (C, Act::Child)]),
    );
    h.set(
        Stage::Ci,
        Scripted::by(Act::Ok, &[(A, Act::Poll(Duration::from_secs(30)))]),
    );
    let mut lp = w.open(h);
    // A: picked, built (its child released), polling CI.
    w.wait_for(&mut lp, 20, |w, lp| {
        if !lp.running().is_empty() {
            w.release(A, Stage::Build);
        }
        w.stage(A) == Some(Stage::Ci)
    });
    // B: picked, waiting on me.
    w.wait_for(&mut lp, 20, |w, _| w.stage(B) == Some(Stage::ApprovalSpec));
    // C: picked while A polls and B waits; its build holds the one slot.
    w.wait_for(&mut lp, 20, |w, lp| {
        w.stage(C) == Some(Stage::Build) && lp.running().len() == 1
    });
    assert_eq!(lp.slots_used(), 1);
    let c = w.mission(C);
    assert_eq!(
        w.child_cwd(C, Stage::Build).as_deref(),
        Some(w.home.root.join(&c.checkout).to_str().unwrap()),
        "in its own checkout"
    );
    // No slot: D isn't picked; I approve B, whose build queues for the slot.
    w.intents.push_mine(
        &[(
            "intents/261001-0901-b/intent.md",
            Some(&common::intent_md(
                "api",
                "u: 5\ni: 4\nstage: design\n",
                "B",
            )),
        )],
        "approve",
    );
    for _ in 0..6 {
        let r = w.pass(&mut lp);
        assert_eq!(r.picked, None);
        assert_eq!(lp.slots_used(), 1);
    }
    assert!(w.missions(D).is_empty());
    assert_eq!(w.stage(B), Some(Stage::Build));
    assert_eq!(lp.queued(), vec![w.mission(B).id], "B waits for the slot");
    assert_eq!(w.stage(A), Some(Stage::Ci), "A still polling");
    // C's child ends: the slot goes to B, not to C's next step (verify, stepped in the same
    // pass) nor to the picker.
    w.release(C, Stage::Build);
    w.wait_for(&mut lp, 20, |w, lp| lp.running() == vec![w.mission(B).id]);
    assert_eq!(w.stage(C), Some(Stage::Verify));
    assert_eq!(lp.queued(), vec![w.mission(C).id]);
    assert!(w.missions(D).is_empty());
    // B's ends: B's verify is ahead of C's (PRI-4).
    w.release(B, Stage::Build);
    w.wait_for(&mut lp, 20, |w, _| w.stage(B) == Some(Stage::Verify));
    w.wait_for(&mut lp, 20, |w, lp| lp.running() == vec![w.mission(B).id]);
    assert_eq!(lp.queued(), vec![w.mission(C).id]);
    w.release(B, Stage::Verify);
    w.wait_for(&mut lp, 20, |w, lp| lp.running() == vec![w.mission(C).id]);
    // C's ends: now D.
    w.release(C, Stage::Verify);
    w.wait_for(&mut lp, 20, |w, _| !w.missions(D).is_empty());
    lp.shutdown().unwrap();
}

#[test]
fn test_repo_slot() {
    // workers 1: a second intent in the repo waits while one is unfinished; blocked doesn't
    // count, approval:* does.
    let mut w = World::new(
        &[
            intent_file("261001-0900-a", "web", "u: 5\ni: 5\n", "A"),
            intent_file("261001-0901-b", "web", "", "B"),
        ],
        &["web"],
    );
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Design,
        Scripted::by(Act::Ok, &[(A, Act::Wait(Waiting::ApproveSpec))]),
    );
    h.set(
        Stage::Plan,
        Scripted::by(Act::Ok, &[(A, Act::Wait(Waiting::AnswerTheQuestion))]),
    );
    let mut lp = w.open(h);
    w.until(&mut lp, 5, |w| w.stage(A) == Some(Stage::ApprovalSpec));
    for _ in 0..3 {
        w.pass(&mut lp);
    }
    assert!(
        w.missions(B).is_empty(),
        "approval:spec holds web's one worker"
    );
    let state = lp.pick_state(w.clock).unwrap();
    assert_eq!(state.full.get("web"), Some(&(1, 1)));
    let decision = towercab::pick::decide(lp.listing().unwrap(), &state);
    assert_eq!(
        decision
            .skipped
            .iter()
            .map(|(i, s)| format!("{i} {s}"))
            .collect::<Vec<_>>(),
        [format!("{B} repo web full (1/1)")]
    );
    // I approve; A asks a question (blocked): B runs.
    w.intents.push_mine(
        &[(
            "intents/261001-0900-a/intent.md",
            Some(&common::intent_md(
                "web",
                "u: 5\ni: 5\nstage: design\n",
                "A",
            )),
        )],
        "approve",
    );
    w.until(&mut lp, 6, |w| w.stage(A) == Some(Stage::Blocked));
    w.until(&mut lp, 4, |w| !w.missions(B).is_empty());
    assert_eq!(w.stage(A), Some(Stage::Blocked));
    lp.shutdown().unwrap();
    drop(lp);

    // workers 2: both at once.
    let mut w = World::new(
        &[
            intent_file("261001-0900-a", "web", "u: 5\ni: 5\n", "A"),
            intent_file("261001-0901-b", "web", "", "B"),
        ],
        &["web"],
    );
    w.repo_mut("web").workers = 2;
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Design,
        Scripted::all(Act::Wait(Waiting::ApproveSpec)),
    );
    let mut lp = w.open(h);
    w.until(&mut lp, 8, |w| {
        w.stage(A) == Some(Stage::ApprovalSpec) && w.stage(B) == Some(Stage::ApprovalSpec)
    });
    assert!(lp.pick_state(w.clock).unwrap().full.contains_key("web"));
    lp.shutdown().unwrap();
}

#[test]
fn test_one_mission_per_intent() {
    let mut w = World::new(
        &[
            intent_file("261001-0900-a", "web", "u: 5\ni: 5\n", "A"),
            intent_file("261001-0901-b", "api", "", "B"),
        ],
        &["web", "api"],
    );
    w.config.agent.parallel = 2;
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Build, Scripted::all(Act::Child));
    let mut lp = w.open(h);
    // Two slots: both build at once, each in its own checkout.
    w.wait_for(&mut lp, 20, |_, lp| lp.running().len() == 2);
    assert_eq!(lp.slots_used(), 2);
    let (a, b) = (w.mission(A), w.mission(B));
    assert_ne!(a.checkout, b.checkout);
    w.wait_for(&mut lp, 5, |w, _| {
        w.child_cwd(A, Stage::Build).is_some() && w.child_cwd(B, Stage::Build).is_some()
    });
    assert_eq!(
        w.child_cwd(A, Stage::Build).unwrap(),
        w.home.root.join(&a.checkout).to_str().unwrap()
    );
    assert_eq!(
        w.child_cwd(B, Stage::Build).unwrap(),
        w.home.root.join(&b.checkout).to_str().unwrap()
    );
    // The unique index: no second unfinished mission for an intent.
    let db = w.db();
    let again = NewMission {
        intent: A.into(),
        slug: "a".into(),
        repo: "web".into(),
        model: "opus".into(),
        a: None,
        min_attempt: 1,
    };
    let err = mission::insert(db.conn(), &again, w.clock).unwrap_err();
    assert!(err.contains("UNIQUE constraint failed"), "{err}");
    // An intent with an unfinished mission is never picked again, staged or not.
    let mut state = lp.pick_state(w.clock).unwrap();
    assert!(state.active.contains(A) && state.active.contains(B));
    let mut listing = lp.listing().unwrap().clone();
    for i in &mut listing.open {
        i.remove("stage").unwrap();
    }
    state.full.clear();
    assert_eq!(towercab::pick::decide(&listing, &state).pick, None);
    w.release(A, Stage::Build);
    w.release(B, Stage::Build);
    w.wait_for(&mut lp, 20, |w, _| {
        w.stage(A) == Some(Stage::Done) && w.stage(B) == Some(Stage::Done)
    });
    // Once finished, a new attempt may start.
    let next = mission::insert(db.conn(), &again, w.clock).unwrap();
    assert_eq!(next.attempt, 2);
    lp.shutdown().unwrap();
}
