//! Findings feed `CLAUDE.md` (PIP-36): a review finding's `rule`, counted per repo and PR; the
//! same rule in the reviews of two PRs → one draft intent PR on `intents`, once per rule.

mod common;

use std::fs;

use common::pipe::{FakeClaude, LOGIN_ID as ID, Pipe, finding, review};
use serde_json::{Value, json};
use towercab::db::Db;
use towercab::drafts;
use towercab::handler::Handlers;
use towercab::machine::Stage;
use towercab::pipeline::findings;
use towercab::pipeline::schemas::ReviewResult;

/// The `findings` rows: (repo, rule, pr).
fn rows(p: &Pipe) -> Vec<(String, String, i64)> {
    let db = Db::open(&p.w.home.db()).unwrap();
    let mut q = db
        .conn()
        .prepare("SELECT repo, rule, pr FROM findings ORDER BY repo, rule, pr")
        .unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// `n` passes, 61 s of the world's clock apart (the drafts poll is due every 300 s).
fn passes(p: &mut Pipe, n: usize) {
    for _ in 0..n {
        p.w.pass(p.lp.as_mut().unwrap());
    }
}

fn with_rule(f: Value, rule: &str) -> Value {
    let mut f = f;
    f["rule"] = json!(rule);
    f
}

/// A review result naming `rule` once.
fn review_naming(rule: &str) -> ReviewResult {
    ReviewResult::from_json(&review(
        true,
        json!([with_rule(
            finding(false, "src/a.rs", Some(3), "unwrap"),
            rule
        )]),
        Value::Null,
    ))
    .unwrap()
}

#[test]
fn test_repeated_rule_drafts_intent() {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2).builds_tested(3).ci_green();
    // The review of PR 7 names a rule twice (and one finding names none).
    p.claude.answer(
        4,
        &FakeClaude::result(review(
            true,
            json!([
                with_rule(
                    finding(true, "src/login.rs", Some(1), "panics"),
                    "Errors use thiserror"
                ),
                with_rule(
                    finding(false, "src/login.rs", Some(2), "unwrap"),
                    "ERRORS USE THISERROR"
                ),
                finding(false, "src/login.rs", None, "naming"),
            ]),
            Value::Null,
        )),
    );
    p.step_to(ID, Stage::Review, 10);
    assert_eq!(p.step(ID), "261001-0900: review → gate");
    assert_eq!(
        rows(&p),
        vec![("web".into(), "errors use thiserror".into(), 7)],
        "one row per repo, lowercased rule and PR"
    );

    // Draft intent PRs go to `intents` on GitHub (the fake git maps it to the bare repo).
    let hub = p.w.root.join("github/me");
    fs::create_dir_all(&hub).unwrap();
    std::os::unix::fs::symlink(&p.w.intents.remote, hub.join("intents.git")).unwrap();
    p.w.config.intents.remote = Some("https://github.com/me/intents.git".into());
    p.gh.replace_sh(
        "pr create *",
        &["case \"$*\" in *me/intents*) echo https://github.com/me/intents/pull/5 ;; *) echo https://github.com/me/web/pull/7 ;; esac"],
    );
    p.gh.on(
        "pr view 5 -R me/intents --json state",
        &[(r#"{"state":"OPEN"}"#, "", 0)],
    );
    // A loop that moves the login mission on without side effects: only the polls act.
    p.open_with(Handlers::stubs());
    let creates = |p: &Pipe| {
        p.gh.calls()
            .iter()
            .filter(|c| c.starts_with("pr create -R me/intents"))
            .count()
    };
    let draft_rows = |p: &Pipe| drafts::all(Db::open(&p.w.home.db()).unwrap().conn()).unwrap();

    // One PR only: no draft.
    p.until(10, |w| w.stage(ID) == Some(Stage::Done));
    passes(&mut p, 6);
    assert!(draft_rows(&p).is_empty());

    // The same rule (case and outer spaces aside) on another PR of the repo.
    let m = p.mission(ID);
    let db = Db::open(&p.w.home.db()).unwrap();
    let rule = "  ERRORS USE THISERROR ";
    findings::record(db.conn(), "web", 9, m.id, &review_naming(rule), 0.0).unwrap();
    // Another repo's or a one-PR rule never counts.
    findings::record(
        db.conn(),
        "api",
        3,
        m.id,
        &review_naming("Errors use thiserror"),
        0.0,
    )
    .unwrap();
    findings::record(
        db.conn(),
        "web",
        9,
        m.id,
        &review_naming("Tabs not spaces"),
        0.0,
    )
    .unwrap();
    p.until(10, |w| {
        drafts::get(
            Db::open(&w.home.db()).unwrap().conn(),
            "review:errors use thiserror",
        )
        .unwrap()
        .is_some_and(|(_, r)| r.step == "open")
    });
    assert_eq!(draft_rows(&p).len(), 1);
    assert_eq!(creates(&p), 1);
    let row = drafts::get(db.conn(), "review:errors use thiserror")
        .unwrap()
        .unwrap()
        .1;
    assert_eq!(row.source, "review:7,9");
    assert_eq!(row.pr, Some(5));
    let create =
        p.gh.find("pr create -R me/intents")
            .into_iter()
            .next()
            .unwrap();
    let argv = p.gh.argv(create);
    let title = argv.iter().position(|a| a == "--title").unwrap() + 1;
    assert_eq!(
        argv[title],
        "docs(intents): update CLAUDE.md: errors use thiserror"
    );
    let body = argv.join("\n");
    assert!(body.contains("https://github.com/me/web/pull/7"), "{body}");
    let id = row.intent.clone().unwrap();
    let slug = row.slug.clone().unwrap();
    let md = common::git(
        &p.w.intents.remote,
        &[
            "show",
            &format!("intent/{id}-{slug}:intents/{id}-{slug}/intent.md"),
        ],
    );
    let intent = towercab::intents::Intent::parse(&md).unwrap();
    assert_eq!(intent.repo(), "web");
    assert_eq!(intent.unlock(), ["CLAUDE.md".to_string()]);
    assert!(md.contains("source: review:7,9\n"), "{md}");
    assert_eq!(intent.title(), "update CLAUDE.md: errors use thiserror");

    // Once per rule: a third PR with it, or the draft merged, never drafts it again.
    findings::record(db.conn(), "web", 11, m.id, &review_naming(rule), 0.0).unwrap();
    p.gh.replace(
        "pr view 5 -R me/intents --json state",
        &[(r#"{"state":"MERGED"}"#, "", 0)],
    );
    p.until(10, |w| {
        drafts::get(
            Db::open(&w.home.db()).unwrap().conn(),
            "review:errors use thiserror",
        )
        .unwrap()
        .is_some_and(|(_, r)| r.step == "accepted")
    });
    passes(&mut p, 6);
    assert_eq!(creates(&p), 1);
    assert_eq!(draft_rows(&p).len(), 1);
}
