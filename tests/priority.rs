//! Scores, order, cutoff, pick order, review queue and trigger (PRI-1..6, PRI-7 queue, PRI-8).

mod common;

use std::cmp::Ordering;

use common::{Home, intent, intent_md, t};
use towercab::cli::parse_add;
use towercab::config::DEFAULT_CUTOFF;
use towercab::intents::{Intent, Listing, Value};
use towercab::priority::{
    DEFAULT_SCORE, REVIEW_DAYS, ReviewDue, Scores, cmp, last_review, parked, parse_scores,
    pick_order, priority, queued, review_due, review_queue,
};
use towercab::review;

fn open(dir: &str, extra: &str) -> Intent {
    let name = dir.rsplit('/').next().unwrap();
    intent(dir, &intent_md("towercab", extra, name))
}

fn ids<'a>(list: impl IntoIterator<Item = &'a Intent>) -> Vec<&'a str> {
    list.into_iter().map(|i| i.id.as_str()).collect()
}

fn listing(open: Vec<Intent>, done: Vec<Intent>) -> Listing {
    Listing {
        open,
        done,
        ..Listing::default()
    }
}

#[test]
fn test_scores_range() {
    // `Intent::parse`: u, i, a are integers 1-5.
    for (extra, err) in [
        ("u: 0\n", "u must be an integer 1-5"),
        ("u: 6\n", "u must be an integer 1-5"),
        ("i: 7\n", "i must be an integer 1-5"),
        ("a: 0\n", "a must be an integer 1-5"),
        ("u: -1\n", "u must be an integer 1-5"),
        ("u: x\n", "u must be an integer 1-5"),
        ("i: 2.5\n", "i must be an integer 1-5"),
        ("u: \"3\"\n", "u must be an integer 1-5"),
    ] {
        assert_eq!(
            Intent::parse(&intent_md("towercab", extra, "X")).unwrap_err(),
            err,
            "{extra:?}"
        );
    }
    for n in 1..=5 {
        let i = Intent::parse(&intent_md(
            "towercab",
            &format!("u: {n}\ni: {n}\na: {n}\n"),
            "X",
        ))
        .unwrap();
        assert_eq!((i.u(), i.i(), i.a()), (Some(n), Some(n), Some(n)));
    }

    // `Intent::set`: the same check; a refused set changes nothing.
    let mut i = Intent::parse(&intent_md("towercab", "u: 4\n", "X")).unwrap();
    let before = i.render();
    for (key, n) in [("u", 0), ("i", 6), ("a", -1), ("u", 10)] {
        assert_eq!(
            i.set(key, Value::Int(n)).unwrap_err(),
            format!("{key} must be an integer 1-5")
        );
        assert_eq!(i.render(), before);
    }
    i.set("a", Value::Int(5)).unwrap();
    assert_eq!(i.a(), Some(5));

    // Score words (`add`, rescore): `[uia][1-5]`, each key at most once.
    assert_eq!(
        parse_scores(&["u4", "i5", "a3"]),
        Ok(Scores {
            u: Some(4),
            i: Some(5),
            a: Some(3)
        })
    );
    assert_eq!(
        parse_scores(&["i1"]),
        Ok(Scores {
            i: Some(1),
            ..Scores::default()
        })
    );
    let none: [&str; 0] = [];
    assert_eq!(parse_scores(&none), Ok(Scores::default()));
    let bad = |s: &str| format!("bad score {s:?}: want uN, iN or aN with N 1-5, each once");
    for s in [
        "u0", "u6", "i9", "a0", "x3", "u", "u33", "4u", "U4", "u3 ", "", "uu", "u-1", "u٣",
    ] {
        assert_eq!(parse_scores(&[s]), Err(bad(s)), "{s:?}");
    }
    assert_eq!(parse_scores(&["u3", "i2", "u4"]), Err(bad("u4")));
    assert_eq!(
        parse_scores(&[String::from("a2"), String::from("a2")]),
        Err(bad("a2"))
    );

    // `add` takes the same words, with the same errors.
    let n = parse_add("towercab: X", &["a2".into(), "u5".into()]).unwrap();
    assert_eq!((n.u, n.i, n.a), (Some(5), None, Some(2)));
    for s in ["u6", "q3", "u33"] {
        assert_eq!(parse_add("towercab: X", &[s.into()]).unwrap_err(), bad(s));
    }
    assert_eq!(
        parse_add("towercab: X", &["i2".into(), "i3".into()]).unwrap_err(),
        bad("i3")
    );
}

#[test]
fn test_defaults() {
    assert_eq!(DEFAULT_SCORE, 3);
    assert_eq!(priority(None, None), 9);
    assert_eq!(priority(None, None), priority(Some(3), Some(3)));
    assert_eq!(priority(Some(5), None), 11);
    assert_eq!(priority(None, Some(1)), 5);

    // Applied on read: the fields stay missing, `a` too.
    let bare = open("intents/261020-0721-bare", "");
    assert_eq!((bare.u(), bare.i(), bare.a()), (None, None, None));
    let l = listing(
        vec![bare, open("intents/261020-0722-nine", "u: 3\ni: 3\n")],
        vec![],
    );
    assert_eq!(
        cmp(&l.open[0], &l.open[1]),
        Ordering::Less,
        "p9 = p9, older first"
    );
    assert_eq!(ids(pick_order(&l, 10)), ["261020-0721", "261020-0722"]);
    assert!(
        review_queue(&l, 10, t("2026-10-21T12:00:00+02:00")).len() == 2,
        "both parked at 10"
    );

    // Never written: a store write leaves the missing scores missing.
    let text = intent_md("towercab", "source: me\n", "Bare");
    let home = Home::new(&[("intents/261020-0721-bare/intent.md", &text)]);
    let store = home.store();
    let now = t("2026-10-21T12:00:00+02:00");
    review::keep(&store, "0721", now).unwrap();
    assert_eq!(
        home.remote_file("intents/261020-0721-bare/intent.md"),
        intent_md(
            "towercab",
            "source: me\nreviewed: 2026-10-21T12:00:00+02:00\n",
            "Bare"
        )
    );
    assert!(
        home.remote_file("TODO.md")
            .contains("towercab: Bare · p9 u3 i3\n")
    );
    // A rescore writes only the scores given.
    let later = now + chrono::TimeDelta::days(REVIEW_DAYS);
    let got = review::rescore(
        &store,
        "0721",
        Scores {
            u: Some(2),
            ..Scores::default()
        },
        later,
    )
    .unwrap();
    assert_eq!((got.u(), got.i(), got.a()), (Some(2), None, None));
    let file = home.remote_file("intents/261020-0721-bare/intent.md");
    assert!(file.contains("\nu: 2\n") && !file.contains("\ni:") && !file.contains("\na:"));
    assert!(
        home.remote_file("TODO.md")
            .contains("towercab: Bare · p8 u2 i3\n")
    );
}

#[test]
fn test_priority() {
    for u in 1..=5u8 {
        for i in 1..=5u8 {
            assert_eq!(priority(Some(u), Some(i)), 2 * i + u, "u{u} i{i}");
        }
    }
    assert_eq!(priority(Some(1), Some(1)), 3, "lowest");
    assert_eq!(priority(Some(5), Some(5)), 15, "highest");
    // Importance weighs double: important-but-not-urgent beats urgent trivia.
    assert!(priority(Some(1), Some(4)) > priority(Some(5), Some(1)));
    let i = open("intents/261020-0721-x", "u: 4\ni: 5\na: 1\n");
    assert_eq!(priority(i.u(), i.i()), 14, "a plays no part");
}

#[test]
fn test_order() {
    let mut list = vec![
        open("intents/261020-0722-c", "u: 4\ni: 5\n"),
        open("intents/261020-0721-10-ten", "u: 4\ni: 5\n"),
        open("intents/251231-2359-low", "u: 1\ni: 1\n"),
        open("intents/261020-0721-2-two", "u: 4\ni: 5\n"),
        open("intents/261021-0000-eleven", "u: 1\ni: 5\n"),
        open("intents/261020-0721-one", "u: 4\ni: 5\n"),
        open("intents/261019-2359-older", "u: 4\ni: 5\n"),
        open("intents/250101-0000-nine", ""),
        open("intents/261020-0900-eleven2", "u: 3\ni: 4\n"),
    ];
    list.sort_by(cmp);
    assert_eq!(
        ids(&list),
        [
            "261019-2359",
            "261020-0721",
            "261020-0721-2",
            "261020-0721-10",
            "261020-0722",
            "261020-0900",
            "261021-0000",
            "250101-0000",
            "251231-2359",
        ],
        "priority desc, then ID asc: date, time, suffix (none = 1, numeric)"
    );
    for a in &list {
        assert_eq!(cmp(a, a), Ordering::Equal);
        for b in &list {
            assert_eq!(cmp(a, b), cmp(b, a).reverse());
        }
    }
}

#[test]
fn test_cutoff() {
    assert_eq!(DEFAULT_CUTOFF, 7);
    for cutoff in 1..=15 {
        for p in 3..=15 {
            assert_eq!(parked(p, cutoff), p < cutoff);
        }
    }
    // Cutoff 7: i >= 3 never parked; i2 needs u >= 3; i1 needs u5.
    for u in 1..=5 {
        for i in 1..=5 {
            let want = (i == 2 && u < 3) || (i == 1 && u < 5);
            assert_eq!(parked(priority(Some(u), Some(i)), 7), want, "u{u} i{i}");
        }
    }

    // `pick_order`: queued intents whose `after` ids are all done (legacy, or in `done/` or
    // `stage: done` and not dropped).
    let l = Listing {
        open: vec![
            open("intents/261020-0700-top", "u: 5\ni: 5\n"),
            open("intents/261020-0701-staged", "u: 5\ni: 5\nstage: design\n"),
            open(
                "intents/261020-0702-waiting",
                "u: 5\ni: 5\nwaiting: answer the question\n",
            ),
            open(
                "intents/261020-0703-blocked",
                "u: 5\ni: 5\nafter: [261020-0700]\n",
            ),
            open(
                "intents/261020-0704-unknown",
                "u: 5\ni: 5\nafter: [251010-1010]\n",
            ),
            open(
                "intents/261020-0705-cycle-a",
                "u: 5\ni: 5\nafter: [261020-0706]\n",
            ),
            open(
                "intents/261020-0706-cycle-b",
                "u: 5\ni: 5\nafter: [261020-0705]\n",
            ),
            open(
                "intents/261020-0707-unblocked",
                "u: 3\ni: 4\nafter: [261019-0900, 261015-1446, 261019-1200, 261019-1300]\n",
            ),
            open("intents/261020-0708-parked", "u: 2\ni: 2\n"),
            open("intents/261020-0709-at-cutoff", "u: 1\ni: 3\n"),
            // A dropped prerequisite never meets an `after`: the loop asks (`bad after:`).
            open(
                "intents/261020-0710-after-dropped-in-place",
                "u: 5\ni: 5\nafter: [261019-0900, 261019-1000]\n",
            ),
            open(
                "intents/261020-0711-after-dropped",
                "u: 5\ni: 5\nafter: [261019-1100]\n",
            ),
        ],
        done: vec![
            open("done/261019-0900-shipped", "stage: done\n"),
            open("intents/261019-1000-dropped-in-place", "stage: dropped\n"),
            open("done/261019-1100-dropped", "stage: dropped\n"),
            open("done/261019-1200-moved-by-hand", ""),
            open("intents/261019-1300-done-in-place", "stage: done\n"),
        ],
        legacy: "2026-10-15 261015-1446 towercab: Rename · towercab#5\n".into(),
        ..Listing::default()
    };
    let order = pick_order(&l, 7);
    assert_eq!(
        ids(order),
        ["261020-0700", "261020-0707", "261020-0709", "261020-0708"]
    );
    assert!(queued(&l.open[0]) && !queued(&l.open[1]) && !queued(&l.open[2]));
    assert!(!queued(&l.done[0]), "in done/");
    // The cutoff moves the line, not the order inside each group.
    assert_eq!(
        ids(pick_order(&l, 1)),
        ["261020-0700", "261020-0707", "261020-0709", "261020-0708"]
    );
    assert_eq!(
        ids(pick_order(&l, 15)),
        ["261020-0700", "261020-0707", "261020-0709", "261020-0708"]
    );
    // Order computed with the configured cutoff: TODO.md and the picker agree.
    let todo = towercab::intents::views::todo(&l, 8);
    assert!(
        todo.contains("## Parked\n\n- [261020-0709]"),
        "p7 parked at 8"
    );
    // … and TODO.md shows what a dropped prerequisite still blocks.
    assert!(todo.contains("after-dropped-in-place · p15 u5 i5 · after 261019-1000\n"));
    assert!(todo.contains("after-dropped · p15 u5 i5 · after 261019-1100\n"));
    assert!(todo.contains("unblocked · p11 u3 i4\n"));
}

#[test]
fn test_parked_after_important() {
    // An old parked intent waits for a new one at the cutoff.
    let l = listing(
        vec![
            open("intents/250101-0000-old-parked", "u: 1\ni: 1\n"),
            open("intents/250101-0001-old-parked-2", "u: 2\ni: 2\n"),
            open("intents/261021-0900-new", "u: 1\ni: 3\n"),
        ],
        vec![],
    );
    assert_eq!(
        ids(pick_order(&l, 7)),
        ["261021-0900", "250101-0001", "250101-0000"]
    );
    // Parked ones are still picked once nothing at or above the cutoff is runnable.
    let l = listing(
        vec![
            open("intents/250101-0000-old-parked", "u: 1\ni: 1\n"),
            open(
                "intents/261021-0900-new",
                "u: 5\ni: 5\nafter: [261021-0901]\n",
            ),
            open("intents/261021-0901-dep", "u: 5\ni: 5\nstage: build\n"),
            open(
                "intents/261021-0902-busy",
                "u: 5\ni: 5\nwaiting: approve spec\n",
            ),
        ],
        vec![],
    );
    assert_eq!(ids(pick_order(&l, 7)), ["250101-0000"]);
    let only_parked = listing(vec![open("intents/250101-0000-p", "u: 1\ni: 1\n")], vec![]);
    assert_eq!(ids(pick_order(&only_parked, 7)), ["250101-0000"]);
    assert!(pick_order(&Listing::default(), 7).is_empty());
}

#[test]
fn test_todo_order() {
    let seeded = [
        (
            "intents/261020-0900-low/intent.md",
            intent_md("towercab", "u: 1\ni: 1\n", "Low"),
        ),
        (
            "intents/261020-0800-mid/intent.md",
            intent_md("towercab", "u: 3\ni: 3\n", "Mid"),
        ),
        (
            "intents/261020-0700-top/intent.md",
            intent_md("towercab", "u: 4\ni: 5\n", "Top"),
        ),
        (
            "intents/261020-0600-parked/intent.md",
            intent_md("towercab", "u: 2\ni: 2\n", "Parked"),
        ),
    ];
    let files: Vec<(&str, &str)> = seeded.iter().map(|(p, s)| (*p, s.as_str())).collect();
    let home = Home::new(&files);
    let store = home.store();
    let l = store.list().unwrap();
    assert_eq!(
        ids(&l.open),
        ["261020-0700", "261020-0800", "261020-0600", "261020-0900"],
        "Listing::open is in PRI-4 order"
    );
    store
        .update("0800", "build", |i| {
            i.set("stage", Value::Str("build".into()))
        })
        .unwrap();
    let todo = home.remote_file("TODO.md");
    let next = todo.find("## Next").unwrap();
    let parked_at = todo.find("## Parked").unwrap();
    let pos = |s: &str| todo.find(s).unwrap_or_else(|| panic!("{s} in {todo}"));
    assert!(next < pos("towercab: Top · p14") && pos("towercab: Top · p14") < parked_at);
    assert!(
        parked_at < pos("towercab: Parked · p6")
            && pos("towercab: Parked · p6") < pos("towercab: Low · p3")
    );

    // My edit changes the scores: the order follows on the next read and write.
    home.push_mine(
        &[(
            "intents/261020-0900-low/intent.md",
            Some(&intent_md("towercab", "u: 5\ni: 5\n", "Low")),
        )],
        "rescore low",
    );
    let l = store.list().unwrap();
    assert_eq!(
        ids(&l.open),
        ["261020-0900", "261020-0700", "261020-0800", "261020-0600"]
    );
    store
        .update("0800", "unstage", |i| i.remove("stage"))
        .unwrap();
    let todo = home.remote_file("TODO.md");
    let pos = |s: &str| todo.find(s).unwrap_or_else(|| panic!("{s} in {todo}"));
    assert!(
        pos("## Next") < pos("towercab: Low · p15")
            && pos("towercab: Low · p15") < pos("towercab: Top · p14")
            && pos("towercab: Top · p14") < pos("towercab: Mid · p9")
            && pos("towercab: Mid · p9") < pos("## Parked")
    );

    // No order or priority is ever written to intent.md.
    for (path, text) in &seeded {
        let now = home.remote_file(path);
        if path.contains("-mid/") {
            assert_eq!(&now, text, "stage written and removed: the same bytes");
        } else if path.contains("-low/") {
            assert_eq!(now, intent_md("towercab", "u: 5\ni: 5\n", "Low"));
        } else {
            assert_eq!(&now, text);
        }
    }
}

#[test]
fn test_review_queue() {
    let now = t("2026-10-21T12:00:00+02:00");
    let l = listing(
        vec![
            // Parked, never reviewed: in, however new.
            open(
                "intents/261020-0900-parked-new",
                "u: 1\ni: 1\nstarted: 2026-10-20T09:00:00+02:00\n",
            ),
            // Parked, reviewed 10 days ago: out.
            open(
                "intents/261001-0900-parked-recent",
                "u: 1\ni: 1\nreviewed: 2026-10-11T12:00:00+02:00\n",
            ),
            // Parked, reviewed exactly 30 days ago: in.
            open(
                "intents/260801-0900-parked-due",
                "u: 2\ni: 2\nreviewed: 2026-09-21T12:00:00+02:00\n",
            ),
            // Not parked, started 2 days ago: out.
            open(
                "intents/261019-0900-fresh",
                "u: 4\ni: 5\nstarted: 2026-10-19T09:00:00+02:00\n",
            ),
            // Not parked, started 50 days ago, never reviewed: in.
            open(
                "intents/260901-0900-stale",
                "u: 3\ni: 4\nstarted: 2026-09-01T09:00:00+02:00\n",
            ),
            // No `started`: the ID's time in now's offset, exactly 30 days: in; a minute less: out.
            open("intents/260921-1200-by-id", ""),
            open("intents/260921-1201-by-id-late", ""),
            // `started` before the ID: a newer `started` wins.
            open(
                "intents/260101-0000-started-wins",
                "started: 2026-10-01T00:00:00+02:00\n",
            ),
            // Reviewed 50 days ago: in.
            open(
                "intents/260101-0001-reviewed-old",
                "u: 5\ni: 5\nreviewed: 2026-09-01T12:00:00+02:00\n",
            ),
            // Reviewed 29 days ago though started long ago: out.
            open(
                "intents/260101-0002-reviewed-29",
                "started: 2026-01-01T00:00:00+02:00\nreviewed: 2026-09-22T12:00:00+02:00\n",
            ),
            // In flight or waiting on me: a mission's, never walked.
            open(
                "intents/260101-0003-in-flight",
                "u: 1\ni: 1\nstage: build\n",
            ),
            open(
                "intents/260101-0004-waiting",
                "u: 1\ni: 1\nwaiting: answer the question\n",
            ),
            // A `reviewed` or `started` after now (typo, wrong clock) counts as missing.
            open(
                "intents/261010-0900-parked-reviewed-future",
                "u: 1\ni: 1\nreviewed: 2062-10-21T12:00:00+02:00\n",
            ),
            open(
                "intents/260101-0006-reviewed-future",
                "u: 4\ni: 4\nstarted: 2026-01-01T00:00:00+02:00\nreviewed: 2062-10-21T12:00:00+02:00\n",
            ),
            open(
                "intents/260101-0007-started-future",
                "u: 4\ni: 3\nstarted: 2062-01-01T00:00:00+02:00\n",
            ),
        ],
        vec![open(
            "done/260101-0005-dropped",
            "u: 1\ni: 1\nstage: dropped\n",
        )],
    );
    assert_eq!(REVIEW_DAYS, 30);
    assert_eq!(
        ids(review_queue(&l, 7, now)),
        [
            "260101-0001",
            "260101-0006",
            "260901-0900",
            "260101-0007",
            "260921-1200",
            "260801-0900",
            "261010-0900",
            "261020-0900"
        ],
        "PRI-4 order"
    );
    // Nothing parked at cutoff 1: only the stale ones.
    assert_eq!(
        ids(review_queue(&l, 1, now)),
        [
            "260101-0001",
            "260101-0006",
            "260901-0900",
            "260101-0007",
            "260921-1200",
            "260801-0900"
        ]
    );
    // The same instant in another offset: the ID is read in that offset.
    let utc = t("2026-10-21T10:00:00+00:00");
    assert!(!ids(review_queue(&l, 7, utc)).contains(&"260921-1200"));
    assert!(review_queue(&Listing::default(), 7, now).is_empty());
}

#[test]
fn test_review_trigger() {
    let now = t("2026-10-21T12:00:00+02:00");
    let parked_new = || {
        open(
            "intents/261020-0900-parked",
            "u: 1\ni: 1\nstarted: 2026-10-20T09:00:00+02:00\n",
        )
    };
    let important = || {
        open(
            "intents/261020-0800-top",
            "u: 4\ni: 5\nstarted: 2026-10-20T08:00:00+02:00\n",
        )
    };
    let done_reviewed = |when: &str| {
        open(
            "done/261001-0900-gone",
            &format!("stage: dropped\nreviewed: {when}\n"),
        )
    };

    // Nothing to review → never due, however long ago the last review.
    assert_eq!(review_due(&Listing::default(), 7, now), None);
    assert_eq!(
        review_due(&listing(vec![important()], vec![]), 7, now),
        None
    );

    // Something to review, never reviewed → monthly, `last` none.
    let l = listing(vec![important(), parked_new()], vec![]);
    assert_eq!(last_review(&l, now), None);
    assert_eq!(
        review_due(&l, 7, now),
        Some(ReviewDue::Monthly { last: None })
    );

    // Reviewed 10 days ago (a dropped intent keeps it), an open intent at the cutoff → not due.
    let l = listing(
        vec![important(), parked_new()],
        vec![done_reviewed("2026-10-11T12:00:00+02:00")],
    );
    assert_eq!(last_review(&l, now), Some(t("2026-10-11T12:00:00+02:00")));
    assert_eq!(review_due(&l, 7, now), None);
    // An in-flight intent at the cutoff is open too.
    let busy = open("intents/261020-0700-busy", "u: 4\ni: 5\nstage: build\n");
    let l = listing(
        vec![busy, parked_new()],
        vec![done_reviewed("2026-10-11T12:00:00+02:00")],
    );
    assert_eq!(review_due(&l, 7, now), None);
    // … but nothing open at or above the cutoff → due.
    let l = listing(
        vec![parked_new()],
        vec![done_reviewed("2026-10-11T12:00:00+02:00")],
    );
    assert_eq!(review_due(&l, 7, now), Some(ReviewDue::NothingAtCutoff));
    assert_eq!(
        review_due(&l, 3, now),
        None,
        "at cutoff 3 it isn't parked, nor stale"
    );

    // Last review exactly 30 days ago → monthly again.
    let last = t("2026-09-21T12:00:00+02:00");
    let l = listing(
        vec![important(), parked_new()],
        vec![done_reviewed("2026-09-21T12:00:00+02:00")],
    );
    assert_eq!(
        review_due(&l, 7, now),
        Some(ReviewDue::Monthly { last: Some(last) })
    );
    let l = listing(
        vec![important(), parked_new()],
        vec![done_reviewed("2026-09-21T12:01:00+02:00")],
    );
    assert_eq!(review_due(&l, 7, now), None, "a minute short of 30 days");

    // A `reviewed` after now is ignored: it can't silence the monthly review.
    let l = listing(
        vec![important(), parked_new()],
        vec![done_reviewed("2062-10-21T12:00:00+02:00")],
    );
    assert_eq!(last_review(&l, now), None);
    assert_eq!(
        review_due(&l, 7, now),
        Some(ReviewDue::Monthly { last: None })
    );
    let l = listing(
        vec![
            important(),
            parked_new(),
            open(
                "intents/261001-0800-x",
                "reviewed: 2026-10-11T12:00:00+02:00\n",
            ),
        ],
        vec![done_reviewed("2062-10-21T12:00:00+02:00")],
    );
    assert_eq!(last_review(&l, now), Some(t("2026-10-11T12:00:00+02:00")));
    assert_eq!(review_due(&l, 7, now), None);

    // The newest `reviewed` over open and done, compared as instants.
    let l = listing(
        vec![open(
            "intents/261001-0800-x",
            "reviewed: 2026-10-01T23:00:00-05:00\n",
        )],
        vec![done_reviewed("2026-10-02T05:00:00+02:00")],
    );
    assert_eq!(last_review(&l, now), Some(t("2026-10-01T23:00:00-05:00")));
}
