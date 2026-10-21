//! IDs, slugs, folder names, suffixes (INT-3).

mod common;

use std::collections::BTreeSet;

use common::{Home, intent_md, t};
use towercab::intents::id::{new_id, resolve, slug, sort_key, split_dir};
use towercab::intents::{NewIntent, StoreError, Value};

fn new(title: &str, created: &str) -> NewIntent {
    NewIntent {
        repo: "towercab".into(),
        title: title.into(),
        u: None,
        i: None,
        a: None,
        source: "me".into(),
        created: t(created),
    }
}

#[test]
fn test_ids_never_reused() {
    let at = t("2026-10-21T09:05:59+02:00");
    let taken = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
    assert_eq!(new_id(at, &taken(&[])), "261021-0905");
    assert_eq!(new_id(at, &taken(&["261021-0905"])), "261021-0905-2");
    assert_eq!(
        new_id(at, &taken(&["261021-0905", "261021-0905-2"])),
        "261021-0905-3"
    );
    assert_eq!(new_id(at, &taken(&["261021-0905-2"])), "261021-0905");
    assert_eq!(sort_key("261021-0905"), (261021, 905, 1));
    assert_eq!(sort_key("261021-0905-12"), (261021, 905, 12));

    // Every folder counts (readable or not, open or done), and so does done/legacy.md.
    let home = Home::new(&[
        (
            "intents/261021-0905-open/intent.md",
            &intent_md("towercab", "", "Open"),
        ),
        (
            "done/261021-0905-2-finished/intent.md",
            &intent_md("towercab", "stage: done\n", "Finished"),
        ),
        ("intents/261021-0905-3-broken/intent.md", "not an intent\n"),
        ("intents/261021-0905-4-empty/.gitkeep", ""),
        (
            "done/legacy.md",
            "2026-10-21 261021-0905-5 towercab: Old · towercab#1 · $? · ? · 1\n",
        ),
    ]);
    let store = home.store();
    let a = store
        .add(new("Same minute", "2026-10-21T09:05:30+02:00"))
        .unwrap();
    assert_eq!(a.id, "261021-0905-6");
    assert_eq!(a.dir, "intents/261021-0905-6-same-minute");
    let b = store
        .add(new("Same minute", "2026-10-21T09:05:31+02:00"))
        .unwrap();
    assert_eq!(b.id, "261021-0905-7");
    assert_eq!(b.dir, "intents/261021-0905-7-same-minute");
    assert_eq!(
        store
            .add(new("Next minute", "2026-10-21T09:06:00+02:00"))
            .unwrap()
            .id,
        "261021-0906"
    );

    // Dropping an intent moves it to done/: its ID stays taken.
    store
        .update("261021-0906", "drop", |i| {
            i.set("stage", Value::Str("dropped".into()))
        })
        .unwrap();
    assert_eq!(
        store
            .add(new("Again", "2026-10-21T09:06:10+02:00"))
            .unwrap()
            .id,
        "261021-0906-2"
    );
}

#[test]
fn test_suffix_unique() {
    let ids = [
        "261020-0721",
        "261020-0721-2",
        "261020-0721-12",
        "261019-1100",
    ];
    assert_eq!(
        resolve("261020-0721", ids),
        Ok("261020-0721".into()),
        "exact match first"
    );
    assert_eq!(resolve("1100", ids), Ok("261019-1100".into()));
    assert_eq!(resolve("-2", ids), Ok("261020-0721-2".into()));
    assert_eq!(resolve("0721", ids), Ok("261020-0721".into()));
    assert_eq!(
        resolve("2", ids),
        Err("2 matches 2 intents: 261020-0721-12, 261020-0721-2".into())
    );
    assert_eq!(
        resolve("9999", ids),
        Err("no open intent matches 9999".into())
    );
    assert_eq!(resolve("", ids), Err("no open intent matches ".into()));

    // The store resolves over open intents only.
    let home = Home::new(&[
        (
            "intents/261020-0721-a/intent.md",
            &intent_md("towercab", "", "A"),
        ),
        (
            "intents/261020-0721-2-b/intent.md",
            &intent_md("towercab", "", "B"),
        ),
        (
            "done/261019-1100-c/intent.md",
            &intent_md("towercab", "stage: done\n", "C"),
        ),
    ]);
    let store = home.store();
    assert_eq!(store.get("-2").unwrap().title(), "B");
    assert_eq!(store.get("0721").unwrap().title(), "A");
    assert_eq!(
        store.get("1100").unwrap_err(),
        StoreError::Refused("no open intent matches 1100".into())
    );
    let got = store
        .update("-2", "touch", |i| i.set("u", Value::Int(5)))
        .unwrap();
    assert_eq!((got.id.as_str(), got.u()), ("261020-0721-2", Some(5)));
}

#[test]
fn test_slug() {
    for (title, want) in [
        ("Rust crate and intent store", "rust-crate-and-intent-store"),
        ("Don't break: Bob’s API!", "dont-break-bobs-api"),
        ("  --Hello__World--  ", "hello-world"),
        ("2fa for login", "n2fa-for-login"),
        ("1", "n1"),
        ("Ünïcödé", "n-c-d"),
        ("", "intent"),
        ("!!! ???", "intent"),
        (
            "Repo files, protected paths and `towercab protect`",
            "repo-files-protected-paths-and-towercab-protect",
        ),
    ] {
        assert_eq!(slug(title), want, "{title:?}");
    }
    let long = format!("{} b", "a".repeat(47));
    assert_eq!(slug(&long), "a".repeat(47), "cut to 48, then trimmed of -");
    assert!(slug(&"word ".repeat(30)).len() <= 48);

    assert_eq!(
        split_dir("261020-0721-2-priority-order-and-review"),
        Some(("261020-0721-2".into(), "priority-order-and-review".into()))
    );
    assert_eq!(
        split_dir("261020-0721-rust-crate"),
        Some(("261020-0721".into(), "rust-crate".into()))
    );
    assert_eq!(
        split_dir("261020-0721-12-x"),
        Some(("261020-0721-12".into(), "x".into()))
    );
    for bad in [
        "261020-0721-2",
        "261020-0721",
        "notes",
        "261020-0721-Upper",
        "26102-0721-x",
    ] {
        assert_eq!(split_dir(bad), None, "{bad}");
    }
    // Every slug parses back out of its folder name, whatever the ID.
    for title in ["2fa for login", "42", "plain", "x-2-y"] {
        for id in ["261020-0721", "261020-0721-3"] {
            assert_eq!(
                split_dir(&format!("{id}-{}", slug(title))),
                Some((id.to_string(), slug(title))),
                "{id} {title}"
            );
        }
    }
}
