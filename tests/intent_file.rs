//! `intent.md` parse, typed fields and line-level writes (INT-2, INT-5, INT-10).

mod common;

use common::{Home, intent_md};
use towercab::intents::{Intent, Stage, Value};

const FULL: &str = "---
repo: towercab
u: 4
i: 5
a: 3
after: [261020-0721, 261020-0721-2]
model: opus
review: fable
source: issue:https://github.com/o/towercab/issues/3
unlock:
  - CLAUDE.md
  - .github/**
started: 2026-10-20T07:21:00+02:00

# my own comment
owner: majid   # not a Towercab field: kept as written
stage: build
waiting: review and merge PR
pr: https://github.com/o/towercab/pull/7
retry: fresh
cost: 3.5
agent_time: 86
attempts: 2
finished: 2026-10-21T10:00:00+02:00
---

# Intent: Rust crate and intent store

## Problem
The Rust version has no code yet.
";

#[test]
fn test_parse_intent() {
    let i = Intent::parse(FULL).unwrap();
    assert_eq!(i.repo(), "towercab");
    assert_eq!((i.u(), i.i(), i.a()), (Some(4), Some(5), Some(3)));
    assert_eq!(i.after(), ["261020-0721", "261020-0721-2"]);
    assert_eq!(i.model(), Some("opus"));
    assert_eq!(i.review(), Some("fable"));
    assert_eq!(
        i.source(),
        Some("issue:https://github.com/o/towercab/issues/3")
    );
    assert_eq!(i.unlock(), ["CLAUDE.md", ".github/**"]);
    assert_eq!(
        i.started().unwrap().to_rfc3339(),
        "2026-10-20T07:21:00+02:00"
    );
    assert_eq!(i.stage(), Some(Stage::Build));
    assert_eq!(i.waiting(), Some("review and merge PR"));
    assert_eq!(i.pr(), Some("https://github.com/o/towercab/pull/7"));
    assert_eq!(i.retry(), Some("fresh"));
    assert_eq!(i.cost(), Some(3.5));
    assert_eq!(i.agent_time(), Some(86));
    assert_eq!(i.attempts(), Some(2));
    assert_eq!(
        i.finished().unwrap().to_rfc3339(),
        "2026-10-21T10:00:00+02:00"
    );
    assert_eq!(i.title(), "Rust crate and intent store");
    assert!(
        i.body()
            .starts_with("\n# Intent: Rust crate and intent store\n\n## Problem\n")
    );
    assert!(i.has("owner"), "unknown keys are kept");
    assert_eq!(i.get("owner"), None, "unknown keys are not typed");

    // Thin: only repo and title; `Intent: ` prefix optional; a single `after` id is a list.
    let thin =
        Intent::parse("---\nrepo: pocket-notes\nafter: 261020-0721\n---\n# Plain title\n").unwrap();
    assert_eq!(thin.title(), "Plain title");
    assert_eq!(thin.after(), ["261020-0721"]);
    assert_eq!(
        (thin.u(), thin.i(), thin.a(), thin.stage()),
        (None, None, None, None)
    );
    // Block list values, indented continuation lines, CRLF line ends.
    let crlf = "---\r\nrepo: x\r\nafter:\r\n  - 261020-0721\r\n---\r\n# Intent: CRLF\r\n";
    let i = Intent::parse(crlf).unwrap();
    assert_eq!(
        (i.after(), i.title()),
        (&["261020-0721".to_string()][..], "CRLF")
    );

    // A UTF-8 BOM before the first `---` is kept.
    let bom = Intent::parse("\u{feff}---\nrepo: x\n---\n# BOM\n").unwrap();
    assert_eq!((bom.repo(), bom.title()), ("x", "BOM"));

    let bad = |fm: &str, body: &str| Intent::parse(&format!("---\n{fm}---\n{body}")).unwrap_err();
    let title = "\n# Intent: t\n";
    assert!(
        Intent::parse("# Intent: t\n")
            .unwrap_err()
            .contains("no front matter")
    );
    assert!(
        Intent::parse("---\nrepo: x\n# Intent: t\n")
            .unwrap_err()
            .contains("no closing ---")
    );
    assert_eq!(bad("u: 3\n", title), "repo is missing");
    assert_eq!(bad("repo: x\nu: 6\n", title), "u must be an integer 1-5");
    assert_eq!(bad("repo: x\ni: high\n", title), "i must be an integer 1-5");
    assert_eq!(bad("repo: x\na: 2.5\n", title), "a must be an integer 1-5");
    let bad_repo = "repo must be a repo name ([A-Za-z0-9._-], no leading -, not . or ..)";
    for repo in ["bad name!", "42", "..", "\".\"", "-x", "a/b"] {
        assert_eq!(bad(&format!("repo: {repo}\n"), title), bad_repo, "{repo}");
    }
    for repo in [".github", "pocket-notes", "a_b.c"] {
        assert!(
            Intent::parse(&format!("---\nrepo: {repo}\n---\n{title}")).is_ok(),
            "{repo}"
        );
    }
    assert_eq!(
        bad("repo: x\nstage: shipping\n", title),
        "stage must be one of design, build, test, deploy, maintain, done, dropped"
    );
    assert_eq!(
        bad("repo: x\nstarted: yesterday\n", title),
        "started must be an RFC 3339 time with offset"
    );
    assert_eq!(
        bad("repo: x\nfinished: 2026-10-21\n", title),
        "finished must be an RFC 3339 time with offset"
    );
    assert_eq!(
        bad("repo: x\nattempts: 0\n", title),
        "attempts must be an integer >= 1"
    );
    assert_eq!(
        bad("repo: x\nagent_time: -1\n", title),
        "agent_time must be an integer >= 0 (seconds)"
    );
    assert_eq!(
        bad("repo: x\ncost: cheap\n", title),
        "cost must be a number"
    );
    assert_eq!(
        bad("repo: x\nafter: {a: 1}\n", title),
        "after must be a list of ids"
    );
    assert_eq!(
        bad("repo: x\nafter: [nope]\n", title),
        "after must be a list of ids"
    );
    assert_eq!(
        bad("repo: x\nafter: nope\n", title),
        "after must be a list of ids"
    );
    assert_eq!(
        bad("repo: x\nunlock: CLAUDE.md\n", title),
        "unlock must be a list of strings",
        "one string is a list only for after"
    );
    assert_eq!(
        bad("repo: x\nattempts: 4294967297\n", title),
        "attempts must be an integer >= 1"
    );
    assert_eq!(
        bad("repo: x\nunlock: [1, 2]\n", title),
        "unlock must be a list of strings"
    );
    assert_eq!(
        bad("repo: x\nwaiting:\n", title),
        "waiting must be a string"
    );
    assert_eq!(
        bad("repo: x\nmodel: true\n", title),
        "model must be a string"
    );
    assert_eq!(bad("repo: x\nu: 3\nu: 4\n", title), "duplicate key u");
    assert_eq!(
        bad("repo: x\nowner: a\nowner: b\n", title),
        "duplicate key owner"
    );
    assert!(bad("repo: x\njust text\n", title).contains("line 3: not a `key:` line at column 0"));
    assert!(bad("  - stray\nrepo: x\n", title).contains("line 2: no key before it"));
    assert!(bad("repo: x\nmodel: [unclosed\n", title).starts_with("front matter: "));
    assert_eq!(
        bad("repo: x\n", "\nno heading here\n"),
        "no title: the body needs a `# ` line"
    );
}

#[test]
fn test_round_trip_is_byte_identical() {
    let odd = "---\n\
repo: towercab   # trailing comment\n\
u:    4\n\
# comment between keys\n\
\n\
after: [\n  261020-0721,\n  261020-0721-2 ]\n\
model: \"opus\"\n\
waiting: 'it''s: quoted'\n\
unlock:\n  - CLAUDE.md\n\n  - \".github/**\"\n\
custom:\n  nested: {a: 1}\n\
---\n\
# Intent: Odd but valid\n\
no trailing newline";
    let crlf = FULL.replace('\n', "\r\n");
    let bom = format!("\u{feff}{crlf}");
    for text in [
        FULL,
        odd,
        crlf.as_str(),
        bom.as_str(),
        "---\nrepo: x\n---\n# t",
    ] {
        let i = Intent::parse(text).unwrap();
        assert_eq!(i.render(), text);
        // Setting a value to what it already is leaves the bytes alone too.
        let mut same = i.clone();
        same.set("repo", Value::Str(i.repo().to_string())).unwrap();
        assert_eq!(same.render(), text);
    }
    let i = Intent::parse(odd).unwrap();
    assert_eq!(i.waiting(), Some("it's: quoted"));
    assert_eq!(i.unlock(), ["CLAUDE.md", ".github/**"]);
    assert_eq!(i.after(), ["261020-0721", "261020-0721-2"]);

    // A store write elsewhere leaves this file's bytes untouched.
    let home = Home::new(&[
        ("intents/261020-0721-odd/intent.md", odd),
        (
            "intents/261020-0722-other/intent.md",
            &intent_md("towercab", "", "Other"),
        ),
    ]);
    let store = home.store();
    store
        .update("0722", "start", |i| {
            i.set("stage", Value::Str("design".into()))
        })
        .unwrap();
    assert_eq!(home.remote_file("intents/261020-0721-odd/intent.md"), odd);
    assert!(
        home.remote_file("intents/261020-0722-other/intent.md")
            .contains("stage: design\n")
    );
}

#[test]
fn test_changed_file_keeps_other_lines() {
    let mut i = Intent::parse(FULL).unwrap();
    i.set("stage", Value::Str("test".into())).unwrap();
    assert_eq!(i.render(), FULL.replace("stage: build\n", "stage: test\n"));

    // A multi-line key becomes one flow line in place.
    i.set("unlock", Value::List(vec!["CLAUDE.md".into()]))
        .unwrap();
    assert_eq!(
        i.render(),
        FULL.replace("stage: build\n", "stage: test\n").replace(
            "unlock:\n  - CLAUDE.md\n  - .github/**\n",
            "unlock: [CLAUDE.md]\n"
        )
    );

    // A new key goes last, just before the closing `---`.
    let mut j = Intent::parse(FULL).unwrap();
    j.remove("retry").unwrap();
    j.set("retry", Value::Str("fresh".into())).unwrap();
    let want = FULL.replace("retry: fresh\n", "").replace(
        "finished: 2026-10-21T10:00:00+02:00\n---\n",
        "finished: 2026-10-21T10:00:00+02:00\nretry: fresh\n---\n",
    );
    assert_eq!(j.render(), want);

    // Every line but the changed ones is the same, comments and unknown keys included.
    let before: Vec<&str> = FULL.lines().collect();
    let rendered = j.render();
    let after: Vec<&str> = rendered.lines().collect();
    for line in &before {
        assert!(after.contains(line), "lost line {line:?}");
    }
    assert!(rendered.contains("owner: majid   # not a Towercab field: kept as written\n"));
    assert!(rendered.contains("\n# my own comment\n"));

    // A key Towercab doesn't know is never written, not even to its current value.
    for (key, v) in [
        ("owner", Value::Str("majid".into())),
        ("note_for_me", Value::Str("new".into())),
        ("a: b", Value::Str("c".into())),
    ] {
        assert_eq!(
            j.set(key, v).unwrap_err(),
            format!("{key} is not a Towercab field")
        );
        assert_eq!(
            j.remove(key).unwrap_err(),
            format!("{key} is not a Towercab field")
        );
        assert_eq!(j.render(), rendered);
    }

    // CRLF files get CRLF lines; a new key too.
    let crlf = FULL.replace('\n', "\r\n");
    let mut c = Intent::parse(&crlf).unwrap();
    c.set("stage", Value::Str("test".into())).unwrap();
    c.remove("retry").unwrap();
    c.set("retry", Value::Str("fresh".into())).unwrap();
    assert_eq!(
        c.render(),
        want.replace("stage: build\n", "stage: test\n")
            .replace('\n', "\r\n")
    );
}

#[test]
fn test_lifecycle_fields() {
    let base = intent_md("towercab", "u: 4\ni: 5\n", "Lifecycle");
    let mut i = Intent::parse(&base).unwrap();
    assert_eq!(i.stage(), None, "no stage = accepted, not started");
    for stage in Stage::ALL {
        assert_eq!(stage.as_str().parse::<Stage>(), Ok(stage));
        i.set("stage", Value::Str(stage.as_str().into())).unwrap();
        assert_eq!(i.stage(), Some(stage));
    }
    assert_eq!(
        Stage::ALL.map(|s| s.as_str()),
        [
            "design", "build", "test", "deploy", "maintain", "done", "dropped"
        ]
    );
    assert!("shipping".parse::<Stage>().is_err());
    assert!(
        Stage::Done.is_finished() && Stage::Dropped.is_finished() && !Stage::Maintain.is_finished()
    );

    let mut i = Intent::parse(&base).unwrap();
    i.set("stage", Value::Str("deploy".into())).unwrap();
    i.set("waiting", Value::Str("review and merge PR".into()))
        .unwrap();
    i.set(
        "pr",
        Value::Str("https://github.com/o/towercab/pull/7".into()),
    )
    .unwrap();
    i.set("cost", Value::Float(3.456)).unwrap();
    i.set("agent_time", Value::Int(86)).unwrap();
    i.set("attempts", Value::Int(1)).unwrap();
    i.set("finished", Value::Str("2026-10-21T10:00:00+02:00".into()))
        .unwrap();
    i.set("after", Value::Str("261020-0721".into())).unwrap();
    i.set(
        "unlock",
        Value::List(vec!["CLAUDE.md".into(), "**/x".into(), "a, b".into()]),
    )
    .unwrap();
    assert_eq!(
        i.render(),
        "---\nrepo: towercab\nu: 4\ni: 5\nstage: deploy\nwaiting: review and merge PR\n\
pr: https://github.com/o/towercab/pull/7\ncost: 3.46\nagent_time: 86\nattempts: 1\n\
finished: 2026-10-21T10:00:00+02:00\nafter: [261020-0721]\nunlock: [CLAUDE.md, \"**/x\", \"a, b\"]\n\
---\n\n# Intent: Lifecycle\n"
    );
    assert_eq!(i.unlock(), ["CLAUDE.md", "**/x", "a, b"]);
    assert_eq!(i.cost(), Some(3.46));

    // Strings YAML would misread are double-quoted, with escapes.
    for (s, written) in [
        ("approve spec: now", "\"approve spec: now\""),
        ("say \"hi\"\\", "say \"hi\"\\"),
        ("\"a\\b\" c", "\"\\\"a\\\\b\\\" c\""),
        ("two\nlines", "\"two\\nlines\""),
        ("42", "\"42\""),
        ("true", "\"true\""),
        ("", "\"\""),
        (" padded", "\" padded\""),
        ("#hash", "\"#hash\""),
        ("a\0b", "\"a\\x00b\""),
        ("bell\u{7}", "\"bell\\x07\""),
        ("del\u{7f}", "\"del\\x7f\""),
        ("tab\there", "tab\there"),
    ] {
        i.set("waiting", Value::Str(s.into())).unwrap();
        assert!(
            i.render().contains(&format!("\nwaiting: {written}\n")),
            "{s:?}"
        );
        assert_eq!(i.waiting(), Some(s));
    }
    i.set("cost", Value::Int(3)).unwrap();
    assert!(i.render().contains("\ncost: 3.00\n"));

    // Same type checks as parse; a refused set changes nothing.
    let before = i.render();
    for (key, v) in [
        ("u", Value::Int(6)),
        ("stage", Value::Str("bogus".into())),
        ("attempts", Value::Int(0)),
        ("finished", Value::Str("today".into())),
        ("after", Value::Int(3)),
        ("repo", Value::Str("no spaces".into())),
        ("bad key", Value::Int(1)),
    ] {
        assert!(i.set(key, v).is_err(), "{key}");
        assert_eq!(i.render(), before);
    }
    assert!(i.remove("repo").is_err(), "repo is required");

    // `remove` drops a key's lines; removing an absent key changes nothing.
    i.remove("waiting").unwrap();
    assert_eq!(i.waiting(), None);
    assert!(!i.render().contains("waiting"));
    let before = i.render();
    i.remove("waiting").unwrap();
    assert_eq!(i.render(), before);

    // Through the store: `update` writes the fields, TODO.md shows them.
    let home = Home::new(&[("intents/261020-0721-life/intent.md", &base)]);
    let store = home.store();
    let got = store
        .update("0721", "wait", |i| {
            i.set("stage", Value::Str("deploy".into()))?;
            i.set("waiting", Value::Str("review and merge PR".into()))
        })
        .unwrap();
    assert_eq!(got.waiting(), Some("review and merge PR"));
    assert_eq!(home.log()[0], "towercab: wait 261020-0721");
    assert!(home.remote_file("TODO.md").contains(
        "## Waiting on me\n\n- [261020-0721](intents/261020-0721-life/intent.md) towercab: Lifecycle · **review and merge PR**\n"
    ));
    store
        .update("0721", "continue", |i| i.remove("waiting"))
        .unwrap();
    assert!(home.remote_file("TODO.md").contains(
        "## In flight\n\n- [261020-0721](intents/261020-0721-life/intent.md) towercab: Lifecycle · deploy\n"
    ));
}
