//! Autonomy (AUT): repo cap, effective `a`, the gate and spec gate, `lower_a`, caps after reverts.

mod common;

use std::fs;
use std::path::Path;

use common::{git, intent_md, loop_config, output, t, towercab, write};
use towercab::autonomy::{
    CAPPED, Ci, Gate, GateIn, Hold, PrKind, RepoState, Review, effective, gate, lower, lowered,
    spec_gate,
};
use towercab::config::Config;
use towercab::db::Db;
use towercab::handler::Outcome;
use towercab::home::Home;
use towercab::intents::Intent;
use towercab::machine::{self, Apply, Door, Event, Next, ORDER, REVERT, Stage, Waiting};
use towercab::mission::{self, NewMission};
use towercab::repo::{self, Towercab};
use towercab::runloop::Tick;
use towercab::{pick, status};

const AS: [Option<u8>; 6] = [None, Some(1), Some(2), Some(3), Some(4), Some(5)];
const CIS: [Ci; 3] = [Ci::Green, Ci::None, Ci::NotGreen];

fn tick() -> Tick {
    Tick {
        wall: t("2026-10-22T10:00:00+02:00"),
        mono: std::time::Duration::from_secs(1),
    }
}

fn review(approved: bool, door: Door, red_lines: bool) -> Option<Review> {
    Some(Review {
        approved,
        door,
        red_lines,
    })
}

/// Approved, two-way, no red line: the best review there is.
fn best() -> Option<Review> {
    review(true, Door::TwoWay, false)
}

/// An intent PR with green CI, nothing unlocked, evals green, the best review, repo cap 5.
fn intent(a: Option<u8>) -> GateIn {
    GateIn {
        kind: PrKind::Intent,
        frozen: false,
        cap: 5,
        a,
        ci: Ci::Green,
        unlock: false,
        evals_red: false,
        review: best(),
    }
}

fn revert() -> GateIn {
    GateIn {
        kind: PrKind::Revert,
        review: None,
        a: None,
        ..intent(None)
    }
}

/// Every gate input: both kinds, frozen, caps 1–5, every `a`, CI, unlock, evals, reviews.
fn every_input() -> Vec<GateIn> {
    let mut reviews = vec![None];
    for approved in [false, true] {
        for door in Door::ALL {
            for red_lines in [false, true] {
                reviews.push(review(approved, door, red_lines));
            }
        }
    }
    let mut out = Vec::new();
    for kind in [PrKind::Intent, PrKind::Revert] {
        for frozen in [false, true] {
            for cap in 1..=5 {
                for a in AS {
                    for ci in CIS {
                        for unlock in [false, true] {
                            for evals_red in [false, true] {
                                for r in &reviews {
                                    out.push(GateIn {
                                        kind,
                                        frozen,
                                        cap,
                                        a: a.map(|a| a.min(cap)),
                                        ci,
                                        unlock,
                                        evals_red,
                                        review: *r,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

#[test]
fn test_gate_table() {
    let a = |n| Some(n);
    let rows: Vec<(&str, GateIn, Gate)> = vec![
        // AUT-3: a1–a3 wait for my merge, whatever the review says.
        ("a1", intent(a(1)), Gate::Approval(Hold::A(1))),
        ("a2", intent(a(2)), Gate::Approval(Hold::A(2))),
        ("a3", intent(a(3)), Gate::Approval(Hold::A(3))),
        (
            "a3 not approved",
            GateIn {
                review: review(false, Door::OneWay, true),
                ..intent(a(3))
            },
            Gate::Approval(Hold::A(3)),
        ),
        (
            "a5 in a repo capped at 3",
            GateIn {
                cap: 3,
                a: a(3),
                ..intent(a(5))
            },
            Gate::Approval(Hold::Cap(3)),
        ),
        // AUT-4: a4 merges on green CI and an approving review; risk doesn't matter.
        ("a4", intent(a(4)), Gate::Merge),
        (
            "a4 one-way, red line",
            GateIn {
                review: review(true, Door::OneWay, true),
                ..intent(a(4))
            },
            Gate::Merge,
        ),
        (
            "a4 not approved",
            GateIn {
                review: review(false, Door::TwoWay, false),
                ..intent(a(4))
            },
            Gate::Approval(Hold::NotApproved),
        ),
        (
            "a4 no review",
            GateIn {
                review: None,
                ..intent(a(4))
            },
            Gate::Approval(Hold::NotApproved),
        ),
        (
            "a4 CI not green",
            GateIn {
                ci: Ci::NotGreen,
                ..intent(a(4))
            },
            Gate::Approval(Hold::CiNotGreen),
        ),
        // AUT-5: a5 as a4.
        ("a5", intent(a(5)), Gate::Merge),
        (
            "a5 not approved",
            GateIn {
                review: review(false, Door::TwoWay, false),
                ..intent(a(5))
            },
            Gate::Approval(Hold::NotApproved),
        ),
        (
            "a5 in a repo with max_autonomy 4",
            GateIn {
                cap: 4,
                a: a(4),
                ..intent(a(5))
            },
            Gate::Merge,
        ),
        // AUT-9: no `a`: cap ≤ 3 → me; else approved and risk low.
        (
            "no a, cap 3",
            GateIn {
                cap: 3,
                ..intent(None)
            },
            Gate::Approval(Hold::Cap(3)),
        ),
        ("no a, cap 5, risk low", intent(None), Gate::Merge),
        (
            "no a, cap 4, risk low",
            GateIn {
                cap: 4,
                ..intent(None)
            },
            Gate::Merge,
        ),
        (
            "no a, one-way",
            GateIn {
                review: review(true, Door::OneWay, false),
                ..intent(None)
            },
            Gate::Approval(Hold::RiskHigh),
        ),
        (
            "no a, door unknown",
            GateIn {
                review: review(true, Door::Unknown, false),
                ..intent(None)
            },
            Gate::Approval(Hold::RiskHigh),
        ),
        (
            "no a, red line touched",
            GateIn {
                review: review(true, Door::TwoWay, true),
                ..intent(None)
            },
            Gate::Approval(Hold::RiskHigh),
        ),
        (
            "no a, not approved",
            GateIn {
                review: review(false, Door::TwoWay, false),
                ..intent(None)
            },
            Gate::Approval(Hold::NotApproved),
        ),
        // PIP-7's first matches, before any `a`.
        (
            "frozen",
            GateIn {
                frozen: true,
                ..intent(a(5))
            },
            Gate::Approval(Hold::Frozen),
        ),
        (
            "ci: none",
            GateIn {
                ci: Ci::None,
                ..intent(a(5))
            },
            Gate::Approval(Hold::NoCi),
        ),
        (
            "unlock used",
            GateIn {
                unlock: true,
                ..intent(a(5))
            },
            Gate::Approval(Hold::Unlock),
        ),
        (
            "evals red",
            GateIn {
                evals_red: true,
                ..intent(a(5))
            },
            Gate::Approval(Hold::EvalsRed),
        ),
        (
            "frozen beats the rest",
            GateIn {
                frozen: true,
                ci: Ci::None,
                unlock: true,
                ..intent(a(1))
            },
            Gate::Approval(Hold::Frozen),
        ),
        (
            "ci: none before unlock",
            GateIn {
                ci: Ci::None,
                unlock: true,
                evals_red: true,
                ..intent(a(5))
            },
            Gate::Approval(Hold::NoCi),
        ),
        (
            "unlock before evals",
            GateIn {
                unlock: true,
                evals_red: true,
                ..intent(a(5))
            },
            Gate::Approval(Hold::Unlock),
        ),
        (
            "evals before cap",
            GateIn {
                evals_red: true,
                cap: 2,
                a: a(2),
                ..intent(a(5))
            },
            Gate::Approval(Hold::EvalsRed),
        ),
        (
            "cap before a",
            GateIn {
                cap: 3,
                a: a(1),
                ..intent(None)
            },
            Gate::Approval(Hold::Cap(3)),
        ),
        // AUT-6: reverts merge on CI green or none, without a review; frozen holds them.
        ("revert", revert(), Gate::Merge),
        (
            "revert, ci: none",
            GateIn {
                ci: Ci::None,
                ..revert()
            },
            Gate::Merge,
        ),
        ("revert, cap 1", GateIn { cap: 1, ..revert() }, Gate::Merge),
        (
            "revert, CI not green",
            GateIn {
                ci: Ci::NotGreen,
                ..revert()
            },
            Gate::Approval(Hold::CiNotGreen),
        ),
        (
            "revert, frozen",
            GateIn {
                frozen: true,
                ..revert()
            },
            Gate::Merge,
        ),
    ];
    for (name, input, want) in &rows {
        assert_eq!(gate(input), *want, "{name}");
    }

    // Approval is `waiting: review and merge PR` (PIP-7), for a revert `revert failed`
    // (PIP-19); a merge sends nothing (LOOP-14).
    for input in every_input() {
        let want = match (gate(&input), input.kind) {
            (Gate::Merge, _) => None,
            (Gate::Approval(_), PrKind::Intent) => Some(Waiting::ReviewAndMergePr),
            (Gate::Approval(_), PrKind::Revert) => Some(Waiting::RevertFailed),
        };
        assert_eq!(gate(&input).waiting(input.kind), want, "{input:?}");
    }
    // continue_to of each: an intent's back to the gate, a revert's back to its stage.
    assert_eq!(
        machine::continue_to(&Waiting::ReviewAndMergePr, Stage::Gate),
        Next::Go(Stage::Gate)
    );
    assert_eq!(
        machine::continue_to(&Waiting::RevertFailed, Stage::RevertMerge),
        Next::Go(Stage::RevertMerge)
    );
    let whys: Vec<String> = [
        Hold::Frozen,
        Hold::CiNotGreen,
        Hold::NoCi,
        Hold::Unlock,
        Hold::EvalsRed,
        Hold::Cap(3),
        Hold::A(2),
        Hold::NotApproved,
        Hold::RiskHigh,
    ]
    .iter()
    .map(Hold::to_string)
    .collect();
    assert_eq!(
        whys,
        [
            "repo frozen",
            "CI not green",
            "ci: none",
            "unlock used",
            "evals red",
            "cap 3",
            "a2",
            "not approved",
            "risk high"
        ]
    );
    assert!(review(true, Door::TwoWay, false).unwrap().risk_low());
    assert!(!review(true, Door::TwoWay, true).unwrap().risk_low());
    assert!(!review(true, Door::OneWay, false).unwrap().risk_low());
    assert!(!review(true, Door::Unknown, false).unwrap().risk_low());
}

#[test]
fn test_validation_always() {
    // Every intent mission runs verify, CI, the verifier, the review and the gate before a
    // merge, then deploy and e2e: one sequence, no stage chosen by `a`.
    let pos = |s: Stage| ORDER.iter().position(|o| *o == s).unwrap();
    let chain = [
        Stage::Build,
        Stage::Verify,
        Stage::Proof,
        Stage::Publish,
        Stage::Ci,
        Stage::Verifier,
        Stage::Review,
        Stage::Gate,
        Stage::Merge,
        Stage::Deploy,
        Stage::E2e,
    ];
    for w in chain.windows(2) {
        assert_eq!(pos(w[1]), pos(w[0]) + 1, "{:?} then {:?}", w[0], w[1]);
        assert_eq!(
            machine::next(w[0], Event::Ok),
            Next::Go(w[1]),
            "ok never skips"
        );
    }
    for s in [Stage::Verify, Stage::Ci] {
        assert_eq!(machine::next(s, Event::Red), Next::Go(Stage::Build));
    }
    let rpos = |s: Stage| REVERT.iter().position(|o| *o == s).unwrap();
    assert!(
        rpos(Stage::RevertCi) + 1 == rpos(Stage::RevertMerge),
        "a revert's CI first"
    );

    // Whatever `a` and cap: an intent merges only with CI green and an approving review; a
    // revert only with CI green or none.
    let mut merges = 0;
    for input in every_input() {
        if gate(&input) != Gate::Merge {
            continue;
        }
        merges += 1;
        match input.kind {
            PrKind::Intent => {
                assert!(!input.frozen, "{input:?}");
                assert_eq!(input.ci, Ci::Green, "{input:?}");
                assert!(input.review.is_some_and(|r| r.approved), "{input:?}");
                assert!(!input.unlock && !input.evals_red && input.cap > CAPPED);
            }
            PrKind::Revert => assert_ne!(input.ci, Ci::NotGreen, "{input:?}"),
        }
    }
    assert!(merges > 0);
    // A revert needs no review, at any cap.
    for cap in 1..=5 {
        for ci in [Ci::Green, Ci::None] {
            let g = GateIn {
                cap,
                ci,
                ..revert()
            };
            assert_eq!(gate(&g), Gate::Merge);
        }
    }
}

#[test]
fn test_spec_gate() {
    // (effective a, cap, concerns) → stops for my approval of the spec (AUT-11, PIP-26).
    for (a, cap, concerns, stop) in [
        (Some(1), 5, false, true),
        (Some(2), 5, false, true),
        (Some(3), 5, false, false),
        (Some(4), 5, false, false),
        (Some(5), 5, false, false),
        (Some(3), 5, true, true),
        (Some(5), 5, true, true),
        (None, 5, false, false),
        (None, 3, false, false),
        (None, 2, false, true),
        (None, 1, false, true),
        (None, 4, true, true),
    ] {
        assert_eq!(spec_gate(a, cap, concerns), stop, "{a:?} {cap} {concerns}");
    }
    // An a5 intent in a repo with max_autonomy 2 is a2 there.
    let st = RepoState {
        max_autonomy: 2,
        capped: false,
        frozen: false,
    };
    assert!(spec_gate(
        effective(Some(5), Some(5), st.cap()),
        st.cap(),
        false
    ));
}

#[test]
fn test_repo_cap() {
    for (max, capped, frozen, cap) in [
        (5, false, false, 5),
        (4, false, false, 4),
        (2, false, false, 2),
        (5, true, false, 3),
        (4, true, false, 3),
        (2, true, false, 2),
        (5, false, true, 3),
        (1, true, true, 1),
    ] {
        let st = RepoState {
            max_autonomy: max,
            capped,
            frozen,
        };
        assert_eq!(st.cap(), cap, "{st:?}");
    }
    assert_eq!(CAPPED, 3);

    // Effective a = min(a at pick, a now, cap); no `a` stays none.
    for (pick, now, cap, want) in [
        (Some(5), Some(5), 5, Some(5)),
        (Some(5), Some(2), 5, Some(2)),
        (Some(2), Some(5), 5, Some(2)),
        (Some(5), Some(5), 3, Some(3)),
        (Some(4), None, 5, Some(4)),
        (None, Some(4), 3, Some(3)),
        (None, None, 5, None),
        (None, None, 1, None),
    ] {
        assert_eq!(effective(pick, now, cap), want, "{pick:?} {now:?} {cap}");
    }

    // From SQLite: no row → uncapped; a row's flags.
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("towercab.db")).unwrap();
    let tc = Towercab::default();
    let st = RepoState::read(db.conn(), "web", &tc).unwrap();
    assert_eq!(
        st,
        RepoState {
            max_autonomy: 5,
            capped: false,
            frozen: false
        }
    );
    db.conn()
        .execute_batch(
            "INSERT INTO repo_caps (repo, capped, frozen, why, since) VALUES
               ('web', 1, 0, 'reverted, refine', 0), ('api', 0, 1, 'revert failed', 0)",
        )
        .unwrap();
    let web = RepoState::read(db.conn(), "web", &tc).unwrap();
    assert!(web.capped && !web.frozen && web.cap() == 3);
    let api = RepoState::read(db.conn(), "api", &tc).unwrap();
    assert!(!api.capped && api.frozen && api.cap() == 3);
    let low = Towercab {
        max_autonomy: 2,
        ..Towercab::default()
    };
    assert_eq!(RepoState::read(db.conn(), "web", &low).unwrap().cap(), 2);
}

#[test]
fn test_max_autonomy_from_base() {
    // A bare origin, my clone (`me`) and Towercab's (`clone`); the base says max_autonomy 2.
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin.git");
    fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "--quiet", "--bare", "-b", "main"]);
    let o = origin.to_str().unwrap();
    git(tmp.path(), &["clone", "--quiet", o, "me"]);
    let me = tmp.path().join("me");
    git(&me, &["checkout", "--quiet", "-B", "main"]);
    write(
        &me,
        "CLAUDE.md",
        "# Web\n\n## Verifying your work\n\n```checks\nmake test\n```\n",
    );
    write(&me, "TOWERCAB.md", "---\nmax_autonomy: 2\n---\n");
    git(&me, &["add", "-A"]);
    git(&me, &["commit", "--quiet", "-m", "seed"]);
    git(&me, &["push", "--quiet", "origin", "HEAD:main"]);
    git(tmp.path(), &["clone", "--quiet", o, "clone"]);
    let clone = tmp.path().join("clone");

    // The PR's branch and the working tree raise it; neither counts.
    let raise = |dir: &Path| write(dir, "TOWERCAB.md", "---\nmax_autonomy: 5\n---\n");
    raise(&me);
    git(&me, &["commit", "--quiet", "-am", "raise"]);
    git(&me, &["push", "--quiet", "origin", "HEAD:towercab/1-x"]);
    git(&clone, &["fetch", "--quiet", "origin"]);
    git(
        &clone,
        &[
            "checkout",
            "--quiet",
            "-b",
            "towercab/1-x",
            "origin/towercab/1-x",
        ],
    );
    raise(&clone);

    let db = Db::open(&tmp.path().join("towercab.db")).unwrap();
    let files = repo::load(&clone, "main").unwrap();
    let st = RepoState::read(db.conn(), "web", &files.towercab).unwrap();
    assert_eq!(st.cap(), 2);
    let a = effective(Some(5), Some(5), st.cap());
    assert_eq!(a, Some(2));
    assert!(
        spec_gate(a, st.cap(), false),
        "a2 there: I approve the spec"
    );
    let g = GateIn {
        cap: st.cap(),
        a,
        ..intent(Some(5))
    };
    assert_eq!(gate(&g), Gate::Approval(Hold::Cap(2)));
}

#[test]
fn test_no_a_under_cap_goes_to_me() {
    // An intent without `a`, approved and risk low, in repos whose cap is ≤ 3: mine to merge.
    let tc = Towercab::parse("---\nmax_autonomy: 3\n---\n").unwrap();
    for st in [
        RepoState {
            max_autonomy: tc.max_autonomy,
            capped: false,
            frozen: false,
        },
        RepoState {
            max_autonomy: 5,
            capped: true,
            frozen: false,
        },
        RepoState {
            max_autonomy: 1,
            capped: false,
            frozen: false,
        },
    ] {
        let cap = st.cap();
        let a = effective(None, None, cap);
        assert_eq!(a, None);
        let g = GateIn {
            cap,
            a,
            ..intent(None)
        };
        assert_eq!(gate(&g), Gate::Approval(Hold::Cap(cap)), "{st:?}");
    }
    // The same intent where the cap is 4 or 5 merges on the review's word.
    for cap in [4, 5] {
        let g = GateIn {
            cap,
            ..intent(None)
        };
        assert_eq!(gate(&g), Gate::Merge);
    }
}

#[test]
fn test_lower_only() {
    // The pure rule: only down, within 1–5; no `a` → only to ≤ 3.
    for (a, l, want) in [
        (Some(5), Some(3), Some(3)),
        (Some(4), Some(1), Some(1)),
        (Some(3), Some(3), None),
        (Some(3), Some(4), None),
        (Some(2), Some(5), None),
        (Some(5), Some(0), None),
        (Some(5), Some(6), None),
        (Some(5), None, None),
        (None, Some(3), Some(3)),
        (None, Some(1), Some(1)),
        (None, Some(4), None),
        (None, Some(5), None),
        (None, None, None),
    ] {
        assert_eq!(lowered(a, l), want, "{a:?} {l:?}");
    }

    // Written with `Intent::set`: the other lines stay byte-identical.
    let text = "---\nrepo: web\n# mine\nu: 4\na: 5   # trusted\nafter: [261001-0900]\n---\n\n# Intent: X\n";
    let mut i = Intent::parse(text).unwrap();
    assert!(!lower(&mut i, Some(5), Some("same")).unwrap());
    assert!(!lower(&mut i, None, Some("none")).unwrap());
    assert_eq!(i.render(), text, "nothing written");
    assert!(lower(&mut i, Some(3), Some("  touches auth\n")).unwrap());
    assert_eq!(
        i.render(),
        "---\nrepo: web\n# mine\nu: 4\na: 3\nafter: [261001-0900]\nlower_why: touches auth\n---\n\n# Intent: X\n"
    );
    assert_eq!((i.a(), i.lower_why()), (Some(3), Some("touches auth")));
    // Higher or equal later: ignored; lower again: the new reason replaces the old.
    assert!(!lower(&mut i, Some(4), Some("raise")).unwrap());
    assert!(!lower(&mut i, Some(3), Some("again")).unwrap());
    assert_eq!(i.lower_why(), Some("touches auth"));
    assert!(lower(&mut i, Some(2), Some("schema: migration")).unwrap());
    assert_eq!(i.lower_why(), Some("schema: migration"));
    assert!(
        i.render().contains("\na: 2\n")
            && i.render().contains("\nlower_why: \"schema: migration\"\n")
    );
    assert!(lower(&mut i, Some(1), Some(" ")).unwrap());
    assert_eq!(
        (i.a(), i.lower_why()),
        (Some(1), None),
        "an empty why removes the old"
    );

    // No `a`: a4 would raise it (no risk judgment), so only ≤ 3.
    let bare = intent_md("web", "u: 3\n", "Bare");
    let mut i = Intent::parse(&bare).unwrap();
    assert!(!lower(&mut i, Some(4), Some("why")).unwrap());
    assert_eq!(i.render(), bare);
    assert!(lower(&mut i, Some(3), Some("why")).unwrap());
    assert_eq!(i.a(), Some(3));
}

/// A config with `[repos.web]` and `[repos.api]`, and its file.
fn config(dir: &Path) -> (Config, std::path::PathBuf) {
    let cfg = loop_config(
        dir,
        "[repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n\n\
         [repos.api]\ngithub = \"me/api\"\npath = \"/srv/api\"\n",
    );
    (Config::load(Some(&cfg)).unwrap(), cfg)
}

/// A revert mission for `intent` in `repo` at `stage`.
fn revert_mission(db: &Db, intent: &str, repo: &str, stage: Stage) -> mission::Mission {
    let new = NewMission {
        intent: intent.into(),
        slug: "x".into(),
        repo: repo.into(),
        model: "opus".into(),
        a: Some(5),
        min_attempt: 1,
    };
    let m = mission::insert(db.conn(), &new, tick()).unwrap();
    db.conn()
        .execute(
            "UPDATE missions SET kind = 'revert', stage = ?1, step = '' WHERE id = ?2",
            rusqlite::params![stage.as_str(), m.id],
        )
        .unwrap();
    mission::get(db.conn(), m.id).unwrap()
}

#[test]
fn test_cap_after_revert() {
    let tmp = tempfile::tempdir().unwrap();
    let (config, _) = config(tmp.path());
    let db = Db::open(&tmp.path().join("towercab.db")).unwrap();
    let ax = Apply {
        db: &db,
        config: &config,
        listing: None,
        tick: tick(),
    };
    let tc = Towercab::default();

    // A green revert: the intent waits `reverted, refine`; the repo is capped at 3.
    let m = revert_mission(&db, "261001-0900", "web", Stage::RevertE2e);
    let o = Outcome::wait(Waiting::RevertedRefine, "e2e red twice after the merge");
    let m = machine::apply(&ax, &m, &o).unwrap();
    assert_eq!(m.stage, Stage::Blocked);
    let web = RepoState::read(db.conn(), "web", &tc).unwrap();
    assert!(web.capped && !web.frozen);
    assert_eq!(web.cap(), 3);
    let a = effective(Some(5), Some(5), web.cap());
    let g = GateIn {
        cap: web.cap(),
        a,
        ..intent(Some(5))
    };
    assert_eq!(
        gate(&g),
        Gate::Approval(Hold::Cap(3)),
        "a5 waits for me now"
    );
    assert!(
        !pick::state(&db, &config, true, tick())
            .unwrap()
            .frozen
            .contains("web")
    );

    // A failed revert: the repo is frozen (no picks, no intent merges) and I'm told once.
    let m = revert_mission(&db, "261001-0901", "api", Stage::RevertCi);
    let o = Outcome::wait(Waiting::RevertFailed, "CI red after the rerun");
    let m = machine::apply(&ax, &m, &o).unwrap();
    let api = RepoState::read(db.conn(), "api", &tc).unwrap();
    assert!(api.frozen && api.cap() == 3);
    let state = pick::state(&db, &config, true, tick()).unwrap();
    assert!(state.frozen.contains("api") && !state.frozen.contains("web"));
    let g = GateIn {
        frozen: api.frozen,
        cap: api.cap(),
        a: Some(api.cap()),
        ..intent(Some(5))
    };
    assert_eq!(gate(&g), Gate::Approval(Hold::Frozen), "no intent merges");
    // My approve re-enters the revert at its stage; once its CI is green it merges, frozen.
    assert_eq!(
        machine::continue_to(&Waiting::RevertFailed, m.from_stage.unwrap()),
        Next::Go(Stage::RevertCi)
    );
    let g = GateIn {
        frozen: api.frozen,
        cap: api.cap(),
        ..revert()
    };
    assert_eq!(gate(&g), Gate::Merge);
    let frozen: Vec<String> = db
        .conn()
        .prepare("SELECT text FROM outbox WHERE mission = 'repo:api' AND event = 'frozen'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        frozen,
        ["repo frozen: api: trust api when fixed\nCI red after the rerun"]
    );
    let text = status::render(
        &status::Snapshot::read(&db, None, None, &config, None, true, tick()).unwrap(),
    );
    assert!(
        text.contains("\nrepos: api frozen, web capped at a3\n"),
        "{text}"
    );
}

#[test]
fn test_trust_clears() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    fs::create_dir_all(&user).unwrap();
    let (config, cfg) = config(tmp.path());
    let home = Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let db = Db::open(&home.db()).unwrap();
    db.conn()
        .execute(
            "INSERT INTO repo_caps (repo, capped, frozen, why, since) VALUES ('web', 1, 1, 'revert failed', 0)",
            [],
        )
        .unwrap();
    let tc = Towercab::default();
    assert_eq!(RepoState::read(db.conn(), "web", &tc).unwrap().cap(), 3);
    assert!(
        pick::state(&db, &config, true, tick())
            .unwrap()
            .frozen
            .contains("web")
    );
    let shown = |db: &Db| {
        status::render(
            &status::Snapshot::read(db, None, None, &config, None, true, tick()).unwrap(),
        )
    };
    assert!(shown(&db).contains("\nrepos: web capped at a3, web frozen\n"));

    let cli = |args: &[&str]| {
        let mut full = vec![
            "--config",
            cfg.to_str().unwrap(),
            "--home",
            home.root.to_str().unwrap(),
        ];
        full.extend_from_slice(args);
        output(&mut towercab(&user, &full))
    };
    assert_eq!(
        cli(&["trust", "nope"]),
        (
            String::new(),
            "towercab: trust: unknown repo nope\n".into(),
            Some(1)
        )
    );
    assert_eq!(
        cli(&["trust", "web"]),
        ("trusted web\n".into(), String::new(), Some(0))
    );

    let st = RepoState::read(db.conn(), "web", &tc).unwrap();
    assert!(!st.capped && !st.frozen);
    assert_eq!(st.cap(), 5);
    assert!(
        pick::state(&db, &config, true, tick())
            .unwrap()
            .frozen
            .is_empty()
    );
    assert!(!shown(&db).contains("repos:"));
    // Trusting a repo with no caps is a no-op that still answers.
    assert_eq!(
        cli(&["trust", "web"]),
        ("trusted web\n".into(), String::new(), Some(0))
    );
}
