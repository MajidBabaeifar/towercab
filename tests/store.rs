//! The store: layout, git sync, unreadable files, interface (INT-1, 2, 4, 5, 10, 11, 12).

mod common;

use std::cell::Cell;
use std::fs;
use std::os::unix::fs::PermissionsExt;

use common::{Home, git, intent_md, t};
use towercab::config::{Config, IntentsConfig};
use towercab::intents::store::OLD_FORMAT;
use towercab::intents::{NewIntent, Store, StoreError, Value};

fn new(title: &str, u: Option<u8>, i: Option<u8>) -> NewIntent {
    NewIntent {
        repo: "towercab".into(),
        title: title.into(),
        u,
        i,
        a: None,
        source: "me".into(),
        created: t("2026-10-21T09:05:07+02:00"),
    }
}

fn ids(list: &[towercab::intents::Intent]) -> Vec<&str> {
    list.iter().map(|i| i.id.as_str()).collect()
}

#[test]
fn test_layout() {
    let home = Home::new(&[
        (
            "intents/261020-0721-rust-crate/intent.md",
            &intent_md("towercab", "u: 4\ni: 5\n", "Rust crate"),
        ),
        (
            "intents/261020-0721-2-priority/intent.md",
            &intent_md("towercab", "stage: build\n", "Priority"),
        ),
        ("intents/261020-0721-2-priority/plan.md", "# Plan\n"),
        (
            "intents/261019-0800-shipped/intent.md",
            &intent_md("towercab", "stage: done\n", "Shipped in place"),
        ),
        (
            "done/261015-1446-rename/intent.md",
            &intent_md("towercab", "stage: done\n", "Rename"),
        ),
        ("intents/notes.md", "plain files are ignored\n"),
        ("intents/scratch/keep.txt", "x\n"),
        ("intents/261020-0900-empty/.gitkeep", ""),
        (
            "done/legacy.md",
            "2026-10-15 261015-1710 towercab: Old line · towercab#6\n",
        ),
    ]);
    assert!(!home.checkout.exists());
    let store = home.store();
    assert!(
        home.checkout.join(".git").exists(),
        "cloned from [intents].remote when missing"
    );
    assert_eq!(store.path(), home.checkout);

    let l = store.list().unwrap();
    assert_eq!(ids(&l.open), ["261020-0721", "261020-0721-2"]);
    assert_eq!(ids(&l.done), ["261019-0800", "261015-1446"]);
    assert_eq!(l.open[0].dir, "intents/261020-0721-rust-crate");
    assert_eq!(l.open[0].slug, "rust-crate");
    assert_eq!(
        l.done[0].dir, "intents/261019-0800-shipped",
        "stage: done is finished wherever it is"
    );
    assert_eq!(l.done[1].dir, "done/261015-1446-rename");
    let bad: Vec<(&str, &str)> = l
        .unreadable
        .iter()
        .map(|u| (u.path.as_str(), u.reason.as_str()))
        .collect();
    assert_eq!(
        bad,
        [
            ("intents/261020-0900-empty", "no intent.md"),
            ("intents/scratch", "not an <id>-<slug> folder"),
        ]
    );
    assert_eq!(
        l.legacy,
        "2026-10-15 261015-1710 towercab: Old line · towercab#6\n"
    );

    // A write regenerates both views at the root, ids linking to their folders.
    let added = store.add(new("Layout check", None, None)).unwrap();
    assert_eq!(added.dir, "intents/261021-0905-layout-check");
    assert!(home.remote_has("intents/261021-0905-layout-check/intent.md"));
    let todo = home.remote_file("TODO.md");
    assert!(todo.contains("- [261020-0721](intents/261020-0721-rust-crate/intent.md) towercab: Rust crate · p14 u4 i5\n"));
    assert!(todo.contains(
        "- [261020-0721-2](intents/261020-0721-2-priority/intent.md) towercab: Priority · build\n"
    ));
    assert!(todo.contains("- intents/scratch: not an <id>-<slug> folder\n"));
    let done = home.remote_file("DONE.md");
    assert!(
        done.contains("[261015-1446](done/261015-1446-rename/intent.md) towercab: Rename · no PR")
    );
    assert!(done.ends_with(
        "## Before intents\n\n2026-10-15 261015-1710 towercab: Old line · towercab#6\n"
    ));
    assert_eq!(
        home.remote_file("intents/261020-0721-2-priority/plan.md"),
        "# Plan\n"
    );

    // An existing checkout is used as it is.
    let again = Store::open(&home.config()).unwrap();
    assert_eq!(ids(&again.list().unwrap().open).len(), 3);
}

#[test]
fn test_thin_intent() {
    let home = Home::new(&[]);
    let store = home.store();
    let got = store
        .add(new("Rust crate and intent store", Some(4), Some(5)))
        .unwrap();
    assert_eq!(got.id, "261021-0905");
    assert_eq!(got.dir, "intents/261021-0905-rust-crate-and-intent-store");
    let text = home.remote_file("intents/261021-0905-rust-crate-and-intent-store/intent.md");
    assert_eq!(
        text,
        "---\nrepo: towercab\nu: 4\ni: 5\nsource: me\nstarted: 2026-10-21T09:05:07+02:00\n---\n\n# Intent: Rust crate and intent store\n"
    );
    assert_eq!(home.log()[0], "towercab: add 261021-0905");
    assert_eq!(
        (got.a(), got.stage(), got.source()),
        (None, None, Some("me"))
    );
    assert!(home.remote_file("TODO.md").contains(
        "## Next\n\n- [261021-0905](intents/261021-0905-rust-crate-and-intent-store/intent.md) towercab: Rust crate and intent store · p14 u4 i5\n"
    ));

    // No scores given → none written; `a` only when given.
    let mut bare = new("Bare", None, None);
    bare.a = Some(2);
    bare.created = t("2026-10-21T09:06:00+00:00");
    store.add(bare).unwrap();
    assert_eq!(
        home.remote_file("intents/261021-0906-bare/intent.md"),
        "---\nrepo: towercab\na: 2\nsource: me\nstarted: 2026-10-21T09:06:00+00:00\n---\n\n# Intent: Bare\n"
    );
    // A thin intent runs as written: it parses with only repo and title.
    let got = store.get("0906").unwrap();
    assert_eq!((got.title(), got.u(), got.i()), ("Bare", None, None));

    for (title, u) in [("", None), ("two\nlines", None), ("ok", Some(6))] {
        assert!(
            matches!(store.add(new(title, u, None)), Err(StoreError::Refused(_))),
            "{title:?}"
        );
    }
}

#[test]
fn test_only_main_is_accepted() {
    let home = Home::new(&[(
        "intents/261020-0721-on-main/intent.md",
        &intent_md("towercab", "", "On main"),
    )]);
    // A machine-written intent waits on its own branch (+ PR) until merged.
    git(
        &home.me,
        &["checkout", "--quiet", "-b", "intent/261021-1000-machine"],
    );
    common::write(
        &home.me,
        "intents/261021-1000-machine/intent.md",
        &intent_md("towercab", "", "Machine"),
    );
    git(&home.me, &["add", "-A"]);
    git(&home.me, &["commit", "--quiet", "-m", "draft"]);
    git(
        &home.me,
        &[
            "push",
            "--quiet",
            "origin",
            "HEAD:intent/261021-1000-machine",
        ],
    );
    git(&home.me, &["checkout", "--quiet", "main"]);

    let store = home.store();
    assert_eq!(ids(&store.list().unwrap().open), ["261020-0721"]);
    assert!(store.get("1000").is_err());

    // Merged → on main → accepted.
    git(
        &home.me,
        &[
            "merge",
            "--quiet",
            "--ff-only",
            "intent/261021-1000-machine",
        ],
    );
    git(&home.me, &["push", "--quiet", "origin", "HEAD:main"]);
    assert_eq!(
        ids(&store.list().unwrap().open),
        ["261020-0721", "261021-1000"]
    );

    // A checkout on another branch is refused, also when it is switched after open.
    git(&home.checkout, &["checkout", "--quiet", "-b", "feature"]);
    let err = Store::open(&home.config()).err().unwrap();
    let want = StoreError::Refused(format!(
        "intents: {} is on feature, not main",
        home.checkout.display()
    ));
    assert_eq!(err, want);
    assert_eq!(store.list().unwrap_err(), want);
    assert_eq!(store.add(new("On feature", None, None)).unwrap_err(), want);
}

#[test]
fn test_unpushed_commit_recovered() {
    let home = Home::new(&[(
        "intents/261020-0721-x/intent.md",
        &intent_md("towercab", "", "X"),
    )]);
    let a = home.store();
    a.add(new("First", None, None)).unwrap();
    let mut config_b = home.config();
    config_b.intents.path = home.tmp.path().join("b");
    let b = Store::open(&config_b).unwrap();
    let at = |title: &str, time: &str| {
        let mut n = new(title, None, None);
        n.created = t(time);
        n
    };

    // A write in A stopped between its commit and its push; meanwhile B adds one, so the
    // views conflict. A's next read rebases (views from main), regenerates them and pushes.
    common::write(
        &home.checkout,
        "intents/261021-1000-crashed/intent.md",
        &intent_md("towercab", "", "Crashed"),
    );
    common::write(
        &home.checkout,
        "TODO.md",
        "# TODO\n\n<!-- generated by towercab, stale -->\n\nA's view\n",
    );
    git(&home.checkout, &["add", "-A"]);
    git(
        &home.checkout,
        &["commit", "--quiet", "-m", "towercab: add 261021-1000"],
    );
    b.add(at("From B", "2026-10-21T11:00:00+02:00")).unwrap();
    let l = a.list().unwrap();
    let titles: Vec<&str> = l.open.iter().map(|i| i.title()).collect();
    assert!(
        titles.contains(&"Crashed") && titles.contains(&"From B"),
        "{titles:?}"
    );
    assert!(home.remote_has("intents/261021-1000-crashed/intent.md"));
    let todo = home.remote_file("TODO.md");
    assert!(todo.contains("Crashed") && todo.contains("From B") && !todo.contains("A's view"));
    assert_eq!(
        &home.log()[..3],
        [
            "towercab: views",
            "towercab: add 261021-1000",
            "towercab: add 261021-1100"
        ]
    );
    assert!(home.checkout_clean());

    // A local commit that conflicts outside the views is dropped and named; A goes on.
    let x = "intents/261020-0721-x/intent.md";
    common::write(&home.checkout, x, &intent_md("towercab", "u: 1\n", "X"));
    git(&home.checkout, &["commit", "--quiet", "-am", "local edit"]);
    home.push_mine(
        &[(x, Some(&intent_md("towercab", "u: 5\n", "X")))],
        "my edit",
    );
    let err = a.list().unwrap_err();
    assert!(
        matches!(&err, StoreError::Sync(m) if m.starts_with("pull failed: ") && m.ends_with("dropped: local edit")),
        "{err:?}"
    );
    assert_eq!(a.get("0721").unwrap().u(), Some(5));
    assert!(home.checkout_clean());

    // A run killed mid-rebase leaves a stopped rebase on a detached HEAD: the next open
    // aborts it, and the read rebases again.
    common::write(
        &home.checkout,
        "TODO.md",
        "# TODO\n\n<!-- generated by towercab, stale -->\n\nlocal\n",
    );
    git(&home.checkout, &["commit", "--quiet", "-am", "local view"]);
    b.add(at("Third", "2026-10-21T12:00:00+02:00")).unwrap();
    git(&home.checkout, &["fetch", "--quiet", "origin"]);
    let stopped = std::process::Command::new("git")
        .args(["-c", "user.name=me", "-c", "user.email=me@localhost"])
        .args(["rebase", "--quiet", "origin/main"])
        .current_dir(&home.checkout)
        .output()
        .unwrap();
    assert!(!stopped.status.success());
    assert!(home.checkout.join(".git/rebase-merge").exists());
    let a = Store::open(&home.config()).unwrap();
    assert!(a.list().unwrap().open.iter().any(|i| i.title() == "Third"));
    assert!(home.checkout_clean());
    assert_eq!(
        git(&home.checkout, &["rev-parse", "HEAD"]),
        git(&home.remote, &["rev-parse", "main"])
    );
}

#[test]
fn test_one_writer_at_a_time() {
    let home = Home::new(&[]);
    home.store();
    // Two writers on one checkout (each its own Store, as two processes would be): the lock
    // runs them one after the other, so neither resets away the other's files.
    let mut got: Vec<String> = std::thread::scope(|s| {
        let writers: Vec<_> = (0..2)
            .map(|n| {
                let home = &home;
                s.spawn(move || {
                    let store = home.store();
                    store.add(new(&format!("Writer {n}"), None, None)).unwrap()
                })
            })
            .collect();
        writers
            .into_iter()
            .map(|w| {
                let i = w.join().unwrap();
                assert!(
                    home.remote_has(&format!("{}/intent.md", i.dir)),
                    "{}",
                    i.dir
                );
                i.id
            })
            .collect()
    });
    got.sort();
    assert_eq!(got, ["261021-0905", "261021-0905-2"]);
    assert_eq!(home.store().list().unwrap().open.len(), 2);
    assert!(home.checkout_clean());
}

#[test]
fn test_done_moves_folder() {
    let home = Home::new(&[
        (
            "intents/261020-0721-ship/intent.md",
            &intent_md("towercab", "u: 4\ni: 5\nstage: deploy\n", "Ship it"),
        ),
        ("intents/261020-0721-ship/plan.md", "# Plan\n"),
        (
            "intents/261020-0722-drop/intent.md",
            &intent_md("towercab", "", "Drop it"),
        ),
        (
            "intents/261020-0723-keep/intent.md",
            &intent_md(
                "towercab",
                "finished: 2026-10-19T08:00:00+02:00\n",
                "Keep finished",
            ),
        ),
    ]);
    let store = home.store();
    let got = store
        .update("0721", "done", |i| {
            i.set("stage", Value::Str("done".into()))?;
            i.set(
                "pr",
                Value::Str("https://github.com/o/towercab/pull/9".into()),
            )?;
            i.set("cost", Value::Float(1.5))?;
            i.set("agent_time", Value::Int(90))?;
            i.set("attempts", Value::Int(1))
        })
        .unwrap();
    assert_eq!(got.dir, "done/261020-0721-ship");
    assert!(
        got.finished().is_some(),
        "finished written with stage: done"
    );
    assert_eq!(home.log()[0], "towercab: done 261020-0721");
    assert!(!home.remote_has("intents/261020-0721-ship"));
    assert_eq!(
        home.remote_file("done/261020-0721-ship/plan.md"),
        "# Plan\n"
    );
    let moved = home.remote_file("done/261020-0721-ship/intent.md");
    assert!(moved.contains("stage: done\n") && moved.contains("\nfinished: "));
    let status = git(
        &home.remote,
        &["diff", "--name-status", "-M", "main~1", "main"],
    );
    assert!(
        status.contains("intents/261020-0721-ship/plan.md\tdone/261020-0721-ship/plan.md"),
        "moved with git mv: {status}"
    );
    let date = got.finished().unwrap().format("%Y-%m-%d").to_string();
    assert!(home.remote_file("DONE.md").contains(&format!(
        "- {date} [261020-0721](done/261020-0721-ship/intent.md) towercab: Ship it · [towercab#9](https://github.com/o/towercab/pull/9) · $1.50 · 1m30s · 1\n"
    )));
    assert!(!home.remote_file("TODO.md").contains("Ship it"));

    store
        .update("0722", "drop", |i| {
            i.set("stage", Value::Str("dropped".into()))
        })
        .unwrap();
    assert!(home.remote_has("done/261020-0722-drop/intent.md"));
    assert!(
        home.remote_file("DONE.md")
            .contains("towercab: Drop it · dropped\n")
    );
    assert!(store.get("0722").is_err(), "done intents are not open");

    // An existing `finished` is kept; other writes move nothing.
    store
        .update("0723", "done", |i| {
            i.set("stage", Value::Str("done".into()))
        })
        .unwrap();
    assert!(
        home.remote_file("done/261020-0723-keep/intent.md")
            .contains("finished: 2026-10-19T08:00:00+02:00\n")
    );
    let l = store.list().unwrap();
    assert!(l.open.is_empty());
    assert_eq!(ids(&l.done), ["261020-0723", "261020-0722", "261020-0721"]);
}

#[test]
fn test_concurrent_edits_both_kept() {
    let mine = intent_md("towercab", "u: 4\ni: 5\n", "Shared");
    let home = Home::new(&[
        ("intents/261020-0721-shared/intent.md", &mine),
        (
            "intents/261020-0722-other/intent.md",
            &intent_md("towercab", "", "Other"),
        ),
    ]);
    let store = home.store();
    let calls = Cell::new(0);
    // While Towercab writes, I push an edit to the same intent: its push is rejected,
    // it replays its change on my commit, and both edits survive.
    let got = store
        .update("0721", "start", |i| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                home.push_mine(
                    &[(
                        "intents/261020-0721-shared/intent.md",
                        Some(&mine.replace("i: 5", "i: 2")),
                    )],
                    "my edit",
                );
            }
            i.set("stage", Value::Str("design".into()))
        })
        .unwrap();
    assert_eq!(calls.get(), 2, "replayed once after the rejected push");
    assert_eq!(
        (got.i(), got.stage().map(|s| s.as_str())),
        (Some(2), Some("design"))
    );
    assert_eq!(
        home.remote_file("intents/261020-0721-shared/intent.md"),
        "---\nrepo: towercab\nu: 4\ni: 2\nstage: design\n---\n\n# Intent: Shared\n"
    );
    assert_eq!(&home.log()[..2], ["towercab: start 261020-0721", "my edit"]);
    assert!(home.checkout_clean());

    // My edits before Towercab's read are pulled first, never overwritten.
    home.push_mine(
        &[(
            "intents/261020-0722-other/intent.md",
            Some(&intent_md("towercab", "u: 5\n", "Other, renamed")),
        )],
        "rename",
    );
    store
        .update("0721", "build", |i| {
            i.set("stage", Value::Str("build".into()))
        })
        .unwrap();
    assert!(
        home.remote_file("intents/261020-0722-other/intent.md")
            .contains("u: 5\n")
    );
    assert!(
        home.remote_file("TODO.md")
            .contains("towercab: Other, renamed · p11 u5 i3\n")
    );
}

/// A `pre-receive` hook on the remote that rejects the first `n` pushes.
fn reject_pushes(home: &Home, n: usize) {
    let count = home.tmp.path().join("pushes");
    let hook = home.remote.join("hooks/pre-receive");
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\nn=$(cat '{c}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '{c}'\n\
if [ $n -le {n} ]; then echo \"test: push $n rejected\" >&2; exit 1; fi\nexit 0\n",
            c = count.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn test_push_retries() {
    let home = Home::new(&[(
        "intents/261020-0721-x/intent.md",
        &intent_md("towercab", "", "X"),
    )]);
    let store = home.store();
    reject_pushes(&home, 2);
    let calls = Cell::new(0);
    store
        .update("0721", "start", |i| {
            calls.set(calls.get() + 1);
            i.set("stage", Value::Str("design".into()))
        })
        .unwrap();
    assert_eq!(calls.get(), 3, "two rejected pushes, two replays");
    assert_eq!(&home.log()[..2], ["towercab: start 261020-0721", "seed"]);

    // Rejected every time: 1 push + 3 retries, then give up with nothing left behind.
    let head = home.head();
    reject_pushes(&home, 1000);
    calls.set(0);
    let err = store
        .update("0721", "build", |i| {
            calls.set(calls.get() + 1);
            i.set("stage", Value::Str("build".into()))
        })
        .unwrap_err();
    assert_eq!(calls.get(), 4);
    match err {
        StoreError::Sync(m) => {
            assert!(m.starts_with("push failed 4 times: "), "{m}");
            assert!(m.contains("test: push"), "{m}");
        }
        other => panic!("want Sync, got {other:?}"),
    }
    assert_eq!(home.head(), head);
    assert_eq!(
        git(&home.checkout, &["rev-parse", "HEAD"]).trim(),
        git(&home.checkout, &["rev-parse", "origin/main"]).trim()
    );
    assert!(home.checkout_clean());
    assert_eq!(
        store.get("0721").unwrap().stage().unwrap().as_str(),
        "design"
    );
}

#[test]
fn test_bad_file_reported() {
    let bad = "---\nrepo: towercab\nu: 9\n---\n\n# Intent: Bad score\n";
    let home = Home::new(&[
        (
            "intents/261020-0721-good/intent.md",
            &intent_md("towercab", "", "Good"),
        ),
        ("intents/261020-0800-bad/intent.md", bad),
        (
            "intents/261020-0900-a/intent.md",
            &intent_md("towercab", "", "Dup A"),
        ),
        (
            "done/261020-0900-b/intent.md",
            &intent_md("towercab", "stage: done\n", "Dup B"),
        ),
        (
            "intents/261019-1900-fine/intent.md",
            &intent_md("towercab", "", "Fine"),
        ),
    ]);
    let store = home.store();
    let l = store.list().unwrap();
    assert_eq!(ids(&l.open), ["261019-1900", "261020-0721"]);
    // A suffix resolves over open intents first: `900` is 261019-1900, not the bad 261020-0900.
    assert_eq!(store.get("900").unwrap().title(), "Fine");
    store.add(new("Trigger a write", None, None)).unwrap();
    assert!(home.remote_file("TODO.md").ends_with(
        "## Can't read\n\n\
- done/261020-0900-b: duplicate id\n\
- intents/261020-0800-bad/intent.md: u must be an integer 1-5\n\
- intents/261020-0900-a: duplicate id\n"
    ));
    assert!(
        !home.remote_file("DONE.md").contains("Dup B"),
        "a duplicate is never picked or listed as done"
    );
    assert_eq!(
        home.remote_file("intents/261020-0800-bad/intent.md"),
        bad,
        "never rewritten"
    );

    let reason =
        StoreError::Refused("intents/261020-0800-bad/intent.md: u must be an integer 1-5".into());
    assert_eq!(store.get("0800").unwrap_err(), reason);
    let head = home.head();
    assert_eq!(
        store.update("0800", "touch", |_| Ok(())).unwrap_err(),
        reason
    );
    assert_eq!(home.head(), head);
    assert_eq!(
        store.get("0900").unwrap_err(),
        StoreError::Refused("intents/261020-0900-a: duplicate id".into())
    );
    assert_eq!(
        store.get("261020-0900").unwrap_err(),
        StoreError::Refused("intents/261020-0900-a: duplicate id".into())
    );

    // Fixed by me → readable again.
    home.push_mine(
        &[(
            "intents/261020-0800-bad/intent.md",
            Some(&bad.replace("u: 9", "u: 2")),
        )],
        "fix",
    );
    assert_eq!(store.get("0800").unwrap().u(), Some(2));

    // An unreadable done/legacy.md is listed, and no write runs (its IDs and lines would be lost).
    fs::create_dir_all(home.me.join("done")).unwrap();
    fs::write(home.me.join("done/legacy.md"), b"\xff old line\n").unwrap();
    git(&home.me, &["add", "-A"]);
    git(&home.me, &["commit", "--quiet", "-m", "binary legacy"]);
    git(&home.me, &["push", "--quiet", "origin", "HEAD:main"]);
    let l = store.list().unwrap();
    let u = l.unreadable.iter().find(|u| u.path == "done/legacy.md");
    assert!(u.is_some_and(|u| u.reason.contains("UTF-8")), "{l:?}");
    let err = store.add(new("Blocked", None, None)).unwrap_err();
    assert!(
        matches!(&err, StoreError::Refused(m) if m.starts_with("done/legacy.md: ")),
        "{err:?}"
    );
    assert_eq!(home.log()[0], "binary legacy");
}

#[test]
fn test_store_interface() {
    let home = Home::new(&[(
        "intents/261020-0721-x/intent.md",
        &intent_md("towercab", "u: 2\n", "X"),
    )]);
    let store = home.store();
    assert_eq!(ids(&store.list().unwrap().open), ["261020-0721"]);
    assert_eq!(store.get("0721").unwrap().title(), "X");
    let added = store.add(new("Y", None, None)).unwrap();
    assert_eq!(home.log()[0], format!("towercab: add {}", added.id));
    let up = store
        .update(&added.id, "rescore", |i| i.set("u", Value::Int(5)))
        .unwrap();
    assert_eq!(up.u(), Some(5));
    assert_eq!(home.log()[0], format!("towercab: rescore {}", added.id));
    // A marked update: the same subject, the mark its last line, found by `has_mark`.
    let mark = "Towercab-Entry: s 12";
    assert!(!store.has_mark(mark).unwrap());
    store
        .update_marked(&added.id, "design", Some(mark), |i| {
            i.set("stage", Value::Str("design".into()))
        })
        .unwrap();
    assert_eq!(home.log()[0], format!("towercab: design {}", added.id));
    let body = common::git(&home.remote, &["log", "-1", "--format=%B", "main"]);
    assert!(
        body.trim_end().ends_with("\n\nTowercab-Entry: s 12"),
        "{body}"
    );
    assert!(store.has_mark(mark).unwrap());
    assert!(
        !store.has_mark("Towercab-Entry: s 1").unwrap(),
        "whole lines only"
    );
    // A marked commit a crash left unpushed: pushed before it counts as written.
    common::write(
        &home.checkout,
        &format!("{}/intent.md", up.dir),
        &intent_md("towercab", "u: 1\n", "Y"),
    );
    git(&home.checkout, &["add", "-A"]);
    git(
        &home.checkout,
        &[
            "commit",
            "--quiet",
            "-m",
            "towercab: x\n\nTowercab-Entry: s 13",
        ],
    );
    assert!(store.has_mark("Towercab-Entry: s 13").unwrap());
    let body = common::git(&home.remote, &["log", "-3", "--format=%B", "main"]);
    assert!(body.contains("Towercab-Entry: s 13"), "pushed: {body}");

    // `Err` from the closure → nothing written.
    let head = home.head();
    assert_eq!(
        store
            .update("0721", "nope", |_| Err("not now".into()))
            .unwrap_err(),
        StoreError::Refused("not now".into())
    );
    assert_eq!(home.head(), head);
    assert!(home.checkout_clean());
    // A closure that changes nothing commits nothing.
    store.update("0721", "noop", |_| Ok(())).unwrap();
    assert_eq!(home.head(), head);
    assert_eq!(
        store.get("zzz").unwrap_err(),
        StoreError::Refused("no open intent matches zzz".into())
    );
    assert_eq!(StoreError::Sync("x".into()).to_string(), "x");

    // Uncommitted changes in the checkout → refuse reads and writes.
    common::write(&home.checkout, "stray.txt", "x");
    let err = store.list().unwrap_err();
    assert!(
        matches!(&err, StoreError::Refused(m) if m.ends_with("has uncommitted changes")),
        "{err:?}"
    );
    assert!(matches!(
        store.add(new("Z", None, None)),
        Err(StoreError::Refused(_))
    ));
    fs::remove_file(home.checkout.join("stray.txt")).unwrap();

    // Old-format TODO.md → reads work, writes refuse until migrate.
    home.push_mine(
        &[("TODO.md", Some("# TODO\n\n- [ ] 261020-0721 towercab: X\n"))],
        "old format",
    );
    assert_eq!(store.list().unwrap().open.len(), 2);
    assert_eq!(
        store.add(new("Z", None, None)).unwrap_err(),
        StoreError::Refused(OLD_FORMAT.into())
    );
    assert_eq!(
        OLD_FORMAT,
        "TODO.md is in the old format: run towercab migrate"
    );

    // Pull failure is a Sync error.
    fs::rename(&home.remote, home.tmp.path().join("gone.git")).unwrap();
    assert!(matches!(store.list(), Err(StoreError::Sync(m)) if m.starts_with("pull failed: ")));

    // Clone failure is a Sync error; no remote and no checkout is refused.
    let mut config = home.config();
    config.intents.path = home.tmp.path().join("fresh");
    assert!(
        matches!(Store::open(&config), Err(StoreError::Sync(m)) if m.starts_with("clone failed: "))
    );
    // A remote that looks like an option is a path to git, never an option.
    let marker = home.tmp.path().join("ran");
    config.intents.remote = Some(format!("--upload-pack=touch {}", marker.display()));
    assert!(matches!(
        Store::open(&config),
        Err(StoreError::Sync(m)) if m.starts_with("clone failed: ") && m.contains("'--upload-pack=touch ")
    ));
    assert!(!marker.exists());
    config.intents.remote = None;
    assert!(
        matches!(Store::open(&config), Err(StoreError::Refused(m)) if m.contains("does not exist"))
    );
    fs::create_dir_all(&config.intents.path).unwrap();
    assert!(
        matches!(Store::open(&config), Err(StoreError::Refused(m)) if m.ends_with("is not a git checkout"))
    );

    // No `origin` → commits locally only.
    let local = home.tmp.path().join("local");
    fs::create_dir_all(&local).unwrap();
    git(&local, &["init", "--quiet", "-b", "main"]);
    git(
        &local,
        &["commit", "--quiet", "--allow-empty", "-m", "start"],
    );
    let config = Config::new(
        home.tmp.path().join("config.toml"),
        IntentsConfig {
            remote: None,
            path: local.clone(),
            cutoff: 7,
        },
    );
    let store = Store::open(&config).unwrap();
    let got = store.add(new("Local only", None, None)).unwrap();
    assert_eq!(
        git(&local, &["log", "-1", "--format=%s"]).trim(),
        format!("towercab: add {}", got.id)
    );
    assert!(local.join("TODO.md").exists() && local.join("DONE.md").exists());
}

#[test]
fn test_symlinks_never_followed() {
    use std::os::unix::fs::symlink;
    let home = Home::new(&[(
        "intents/261020-0721-real/intent.md",
        &intent_md("towercab", "", "Real"),
    )]);
    // Outside the checkout: what a committed symlink could lead Towercab to read or write.
    let outside = home.tmp.path().join("outside");
    let text = intent_md("towercab", "", "Outside");
    common::write(&outside, "intent.md", &text);
    let outside_md = outside.join("intent.md");
    symlink(&outside, home.me.join("intents/261020-0800-link")).unwrap();
    fs::create_dir_all(home.me.join("intents/261020-0900-file")).unwrap();
    symlink(
        &outside_md,
        home.me.join("intents/261020-0900-file/intent.md"),
    )
    .unwrap();
    git(&home.me, &["add", "-A"]);
    git(&home.me, &["commit", "--quiet", "-m", "links"]);
    git(&home.me, &["push", "--quiet", "origin", "HEAD:main"]);

    let store = home.store();
    let l = store.list().unwrap();
    assert_eq!(ids(&l.open), ["261020-0721"]);
    let bad: Vec<(&str, &str)> = l
        .unreadable
        .iter()
        .map(|u| (u.path.as_str(), u.reason.as_str()))
        .collect();
    assert_eq!(
        bad,
        [
            ("intents/261020-0800-link", "symlink"),
            ("intents/261020-0900-file/intent.md", "symlink"),
        ]
    );
    assert_eq!(
        store.update("0900", "touch", |_| Ok(())).unwrap_err(),
        StoreError::Refused("intents/261020-0900-file/intent.md: symlink".into())
    );
    store
        .update("0721", "start", |i| {
            i.set("stage", Value::Str("design".into()))
        })
        .unwrap();
    assert_eq!(fs::read_to_string(&outside_md).unwrap(), text);

    // A symlinked view is never read or written through.
    git(&home.me, &["pull", "--quiet", "--rebase", "origin", "main"]);
    fs::remove_file(home.me.join("DONE.md")).unwrap();
    symlink(&outside_md, home.me.join("DONE.md")).unwrap();
    git(&home.me, &["add", "-A"]);
    git(&home.me, &["commit", "--quiet", "-m", "linked view"]);
    git(&home.me, &["push", "--quiet", "origin", "HEAD:main"]);
    assert_eq!(
        store.add(new("Through a link", None, None)).unwrap_err(),
        StoreError::Refused("DONE.md: symlink".into())
    );
    assert_eq!(fs::read_to_string(&outside_md).unwrap(), text);
}

#[test]
fn test_store_put() {
    let home = Home::new(&[(
        "intents/261020-0721-x/intent.md",
        &intent_md("towercab", "", "X"),
    )]);
    let store = home.store();
    let rel = "intents/261020-0721-x/plan.md";
    assert_eq!(store.put(rel, "# Plan\n", "plan 261020-0721"), Ok(true));
    assert_eq!(home.remote_file(rel), "# Plan\n");
    assert_eq!(home.log()[0], "towercab: plan 261020-0721");
    // The same text: no commit.
    let head = home.head();
    assert_eq!(store.put(rel, "# Plan\n", "plan 261020-0721"), Ok(false));
    assert_eq!(home.head(), head);
    for bad in [
        "../x",
        "/tmp/x",
        "intents/261020-0721-x/intent.md",
        "TODO.md",
        "a/../b",
    ] {
        assert!(
            matches!(store.put(bad, "x", "bad"), Err(StoreError::Refused(_))),
            "{bad}"
        );
    }
    std::os::unix::fs::symlink("/tmp", home.checkout.join("evals")).unwrap();
    assert!(matches!(
        store.put("evals/1.json", "{}", "eval"),
        Err(StoreError::Refused(_))
    ));
}
