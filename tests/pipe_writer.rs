//! PR text (PIP-11, PIP-14, PIP-15): the writer, its template, `⛔ Not ready`, and never
//! blocking on any of it.

mod common;

use std::fs;
use std::time::Duration;

use common::pipe::{FakeClaude, Pipe, run_child};
use common::world::intent_file;
use rusqlite::types::Value as Sql;
use serde_json::json;
use towercab::handler::{Outcome, Progress, update};
use towercab::machine::Waiting;
use towercab::mission::{self, Mission, NewMission};
use towercab::pipeline::schemas::WriterResult;
use towercab::pipeline::{never_published, wait_note};
use towercab::writer::{
    self, Checks, Footer, Inputs, ci_line, final_text, head_and_tail, review_line, template,
};

const ID: &str = "261001-0900";

/// Picked, at `design`, with PR 7.
fn picked() -> (Pipe, Mission) {
    let mut p = Pipe::new(
        &[intent_file(
            "261001-0900-login",
            "web",
            "a: 4\n",
            "Add login",
        )],
        &["web"],
    );
    p.step(ID);
    let m = p.mission(ID);
    set(
        &p,
        &m,
        &[
            ("pr", Sql::Integer(7)),
            (
                "pr_url",
                Sql::Text("https://github.com/me/web/pull/7".into()),
            ),
        ],
    );
    let m = p.mission(ID);
    (p, m)
}

fn set(p: &Pipe, m: &Mission, cols: &[(&str, Sql)]) {
    let db = p.w.db();
    let cols: Vec<(String, Sql)> = cols
        .iter()
        .map(|(c, v)| (c.to_string(), v.clone()))
        .collect();
    update(db.conn(), m.id, &cols).unwrap();
}

fn inputs() -> Inputs {
    Inputs {
        title: "feat(auth): Add login".into(),
        notes: "Built the login form.".into(),
        verdicts: vec!["I can log in: met: test_login passes".into()],
        spec_ids: vec!["WEB-1".into(), "WEB-2".into()],
        checks: Checks {
            verify: "green (2 commands)".into(),
            proof: "red on base: make test".into(),
            ci: ci_line("green"),
            verifier: "not opted in".into(),
            review: review_line(true, &[]),
        },
        plan_url: Some(
            "https://github.com/me/intents/blob/main/intents/261001-0900-login/plan.md".into(),
        ),
        closes: None,
        footer: Footer {
            intent_url:
                "https://github.com/me/intents/blob/main/intents/261001-0900-login/intent.md".into(),
            mission: 3,
            cost_usd: 1.5,
            secs: 3900,
            version: "0.3.0".into(),
        },
    }
}

const FINAL: &str = "Users can log in.

- Log in with a password
- Sessions last a day

Spec IDs: WEB-1, WEB-2

**Checks**
- verify: green (2 commands)
- red→green proof: red on base: make test
- CI: green
- verifier: not opted in
- review: approved

**Plan:** https://github.com/me/intents/blob/main/intents/261001-0900-login/plan.md

<sub>🤖 Built by Towercab · [intent](https://github.com/me/intents/blob/main/intents/261001-0900-login/intent.md) · mission 3 · $1.50 · 1h05m</sub>
";

#[test]
fn test_pr_writer() {
    let (p, m) = picked();
    p.claude.answer(
        1,
        &FakeClaude::result(json!({
            "summary": "Users can log in.",
            "changes": ["Log in with a password", "Sessions last a day"],
        })),
    );
    let i = inputs();
    let started = p.cx(|cx| writer::start(cx, &m, &i, false)).unwrap();
    let Ok(Progress::Spawn(spec)) = started else {
        panic!("{started:?}")
    };
    // Haiku, no tools, no slot, 60 s, prompt on stdin, in runs/<id>/.
    assert!(!spec.slot);
    assert_eq!(spec.timeout, Some(Duration::from_secs(60)));
    assert_eq!(spec.cwd, p.runs(ID));
    let end = run_child(&spec);
    let m = p.mission(ID);
    let body = p.cx(|cx| writer::finish(cx, &m, &end, &i)).unwrap();
    assert_eq!(body, FINAL);
    assert_eq!(p.claude.flag(1, "--model").as_deref(), Some("haiku"));
    assert_eq!(p.claude.flag(1, "--tools").as_deref(), Some(""));
    let argv = p.claude.argv(1);
    assert!(argv.contains(&"--strict-mcp-config".to_string()));
    for f in [
        "--session-id",
        "--resume",
        "--plugin-dir",
        "--allowedTools",
        "--max-budget-usd",
    ] {
        assert!(!argv.contains(&f.to_string()), "{f}");
    }
    let prompt = p.claude.stdin(1);
    assert!(prompt.contains("Title: feat(auth): Add login"));
    assert!(prompt.contains("<notes>\nBuilt the login form.\n</notes>"));
    assert!(prompt.contains("- I can log in: met: test_login passes"));
    // At most 5 bullets, every line code but the summary and bullets.
    let many = WriterResult::from_json(
        &json!({"summary": "S\nx", "changes": ["1", "2", "3", "4", "5", "6", "7"]}),
    )
    .unwrap();
    let text = final_text(&many, &i);
    assert!(
        text.starts_with("S x\n\n- 1\n- 2\n- 3\n- 4\n- 5\n\nSpec IDs"),
        "{text}"
    );
    // Its cost counts toward the mission's.
    assert!(p.mission(ID).cost_usd > 0.2);
}

#[test]
fn test_no_ci_pr_text_says_nothing_ran() {
    // The gate's inputs of a repo without checks (`ci.result = none`).
    let (p, m) = picked();
    set(
        &p,
        &m,
        &[(
            "data",
            Sql::Text(json!({"ci": {"result": "none"}}).to_string()),
        )],
    );
    let m = p.mission(ID);
    let i = p
        .cx(|cx| towercab::pipeline::gate::Gate::inputs(cx, &m))
        .unwrap();
    assert_eq!(i.checks.ci, "no CI checks on this repo, nothing ran");
    let mut i = inputs();
    i.checks.ci = ci_line("none");
    let text = template(&i);
    assert!(
        text.contains("\n- CI: no CI checks on this repo, nothing ran\n"),
        "{text}"
    );
    assert_eq!(ci_line("green"), "green");
    assert_eq!(ci_line("flaky"), "flaky (green on rerun)");
}

#[test]
fn test_blocked_pr_text_says_not_ready() {
    let (p, m) = picked();
    p.gh.on("api -X PATCH *", &[("{}", "", 0)]);
    for w in [
        Waiting::ChecksRed,
        Waiting::TestsDontProve,
        Waiting::CiRed,
        Waiting::NoCiChecks,
        Waiting::CiStuck,
        Waiting::AnswerTheQuestion,
        Waiting::ProtectedPathChanged,
    ] {
        let before = p.gh.calls().len();
        let r = p
            .cx(|cx| wait_note(cx, &m, w, "3 repairs", "why in detail"))
            .unwrap();
        assert_eq!(r, Progress::Done(Outcome::wait(w, "3 repairs")));
        let n = p.gh.calls().len();
        assert_eq!(n, before + 1, "{w}");
        assert_eq!(
            p.gh.calls()[n - 1].split(" -F ").next().unwrap(),
            "api -X PATCH repos/me/web/pulls/7"
        );
        let body = p.gh.body(n).unwrap();
        let url = "intents/261001-0900-login/intent.md";
        assert!(
            body.starts_with(&format!("⛔ Not ready: {w}: 3 repairs\nSee [intent.md]({url}).\n\n<sub>🤖 Built by Towercab · [intent]({url}) · mission {} · $", m.id)),
            "{body}"
        );
    }
    // The note is in intent.md.
    assert!(
        p.w.intent_md("261001-0900-login")
            .ends_with("## Towercab\n\nwhy in detail\n")
    );
    // Waits after the review or on my approval keep the PR text.
    for w in [
        Waiting::ApproveSpec,
        Waiting::ReviewAndMergePr,
        Waiting::NoResult,
    ] {
        let before = p.gh.calls().len();
        p.cx(|cx| wait_note(cx, &m, w, "x", "")).unwrap();
        assert_eq!(p.gh.calls().len(), before, "{w}");
    }
    // An empty note removes the section.
    assert!(!p.w.intent_md("261001-0900-login").contains("## Towercab"));
}

#[test]
fn test_rejected_review_verdicts_in_pr_text() {
    let mut i = inputs();
    i.verdicts = vec![
        "I can log in: met: test_login".into(),
        "I can log out: not met: no logout".into(),
    ];
    i.checks.review = review_line(
        false,
        &[
            "I can log out: not met".into(),
            "tests weakened: tests/login.rs".into(),
        ],
    );
    assert_eq!(
        i.checks.review,
        "not approved: I can log out: not met; tests weakened: tests/login.rs"
    );
    for text in [
        template(&i),
        final_text(
            &WriterResult {
                summary: "S".into(),
                changes: vec![],
            },
            &i,
        ),
    ] {
        assert!(
            text.contains(
                "\n- review: not approved: I can log out: not met; tests weakened: tests/login.rs\n"
            ),
            "{text}"
        );
    }
    assert!(template(&i).contains("- I can log out: not met: no logout\n"));
}

#[test]
fn test_retry_reviews_and_describes_the_whole_pr() {
    let (p, first) = picked();
    let head = ("head", Sql::Text("h1".into()));
    set(
        &p,
        &first,
        &[
            head.clone(),
            ("cost_usd", Sql::Real(1.25)),
            ("agent_secs", Sql::Real(1800.0)),
            ("stage", Sql::Text("stopped".into())),
        ],
    );
    let db = p.w.db();
    let second = mission::insert(
        db.conn(),
        &NewMission {
            intent: ID.into(),
            slug: "login".into(),
            repo: "web".into(),
            model: "opus".into(),
            a: Some(4),
            min_attempt: 2,
        },
        p.w.clock,
    )
    .unwrap();
    set(
        &p,
        &second,
        &[
            ("pr", Sql::Integer(7)),
            head,
            ("cost_usd", Sql::Real(0.5)),
            ("agent_secs", Sql::Real(600.0)),
        ],
    );
    let runs = p.runs(ID);
    fs::create_dir_all(&runs).unwrap();
    let long = format!("First summary.{}Last repair.", " middle".repeat(2000));
    fs::write(runs.join("build.txt"), &long).unwrap();
    fs::write(runs.join("build-2.txt"), "Second attempt: fixed logout.").unwrap();
    let second = mission::get(db.conn(), second.id).unwrap();
    let notes = p.cx(|cx| writer::notes(cx, &second));
    assert!(notes.starts_with("Attempt 1:\nFirst summary."), "{notes}");
    assert!(
        notes.contains("Last repair.\n\nAttempt 2:\nSecond attempt: fixed logout."),
        "{notes}"
    );
    assert!(notes.len() < 5000);
    let f = p.cx(|cx| writer::footer(cx, &second));
    assert_eq!((f.cost_usd, f.secs, f.mission), (1.75, 2400, second.id));
    assert!(f.render().contains(" · $1.75 · 0h40m</sub>"));
    // An attempt that never pushed into this PR doesn't count.
    set(&p, &first, &[("pr", Sql::Integer(8))]);
    let f = p.cx(|cx| writer::footer(cx, &second));
    assert_eq!(f.cost_usd, 0.5);
}

#[test]
fn test_head_and_tail_keeps_the_summary() {
    let notes = format!("Summary: login.\n{}\nRepair: fixed CI.", "x".repeat(10_000));
    let short = head_and_tail(&notes, 200);
    assert!(short.chars().count() <= 200, "{}", short.len());
    assert!(short.starts_with("Summary: login.\n"));
    assert!(short.ends_with("\nRepair: fixed CI."));
    assert!(short.contains("\n…\n"));
    assert_eq!(head_and_tail("short", 200), "short");
}

#[test]
fn test_writer_template() {
    let i = inputs();
    let text = template(&i);
    assert!(text.starts_with("feat(auth): Add login\n\n- I can log in: met: test_login passes\n\nSpec IDs: WEB-1, WEB-2\n\n**Checks**\n"), "{text}");
    assert!(text.ends_with(&format!("{}\n", i.footer.render())));
}

#[test]
fn test_writer_fallback() {
    let (p, m) = picked();
    let i = inputs();
    // A result that doesn't parse (empty summary, no changes list) → the template.
    for (n, out) in [
        (1, json!({"summary": "", "changes": []})),
        (2, json!({"summary": "S"})),
    ] {
        p.claude.answer(n, &FakeClaude::result(out));
        let Ok(Progress::Spawn(spec)) = p.cx(|cx| writer::start(cx, &m, &i, false)).unwrap() else {
            panic!()
        };
        let end = run_child(&spec);
        let body = p
            .cx(|cx| writer::finish(cx, &p.mission(ID), &end, &i))
            .unwrap();
        assert_eq!(body, template(&i));
    }
}

#[test]
fn test_writer_failure_falls_back() {
    let (mut p, m) = picked();
    let i = inputs();
    // Non-zero exit, empty output, a usage limit, a timeout.
    p.claude
        .answer(
            1,
            &FakeClaude::result(json!({"summary": "S", "changes": []})),
        )
        .exit(1, 1)
        .answer(2, "")
        .stderr(3, "Claude AI usage limit reached|1760540400")
        .exit(3, 1)
        .script(4, "sleep 5\n");
    for n in 1..=4 {
        let Ok(Progress::Spawn(mut spec)) = p.cx(|cx| writer::start(cx, &m, &i, false)).unwrap()
        else {
            panic!()
        };
        if n == 4 {
            spec.timeout = Some(Duration::from_millis(300));
        }
        let end = run_child(&spec);
        let body = p
            .cx(|cx| writer::finish(cx, &p.mission(ID), &end, &i))
            .unwrap();
        assert_eq!(body, template(&i), "call {n}");
    }
    // The writer never waits: no cooldown for its limit.
    let db = p.w.db();
    let cooling: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM cooldowns", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cooling, 0);
    // A missing executable: the template at once.
    p.exes.claude = p.w.root.join("no-claude").into();
    let r = p.cx(|cx| writer::start(cx, &m, &i, false)).unwrap();
    assert_eq!(r, Err(template(&i)));
}

#[test]
fn test_pr_text_edit_failure_never_blocks() {
    let (p, m) = picked();
    p.gh.on("api -X PATCH *", &[("", "HTTP 422: Validation Failed", 1)]);
    assert!(!p.cx(|cx| writer::patch(cx, &m, "body")));
    // The wait still settles.
    let r = p
        .cx(|cx| wait_note(cx, &m, Waiting::ChecksRed, "red", ""))
        .unwrap();
    assert_eq!(r, Progress::Done(Outcome::wait(Waiting::ChecksRed, "red")));
    assert_eq!(
        fs::read_to_string(p.runs(ID).join("pr-body.md"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
        "⛔ Not ready: checks red: red"
    );
}

#[test]
fn test_ready_without_pr_does_not_crash() {
    let mut p = Pipe::new(
        &[intent_file(
            "261001-0900-login",
            "web",
            "a: 4\n",
            "Add login",
        )],
        &["web"],
    );
    p.step(ID);
    let m = p.mission(ID);
    assert_eq!(m.pr, None);
    assert_eq!(
        never_published(&m),
        Some(Progress::Done(Outcome::wait(
            Waiting::NeverPublished,
            "towercab/261001-0900-login has no PR"
        )))
    );
    assert!(!p.cx(|cx| writer::patch(cx, &m, "body")));
    // The stages that need a PR, stepped without one: the wait, never a crash.
    use towercab::handler::Handler;
    use towercab::pipeline::{Mode, gate::Gate, merge::Merge, review::Review};
    let never = Progress::Done(Outcome::wait(
        Waiting::NeverPublished,
        "towercab/261001-0900-login has no PR",
    ));
    assert_eq!(
        p.cx(|cx| Gate::new(Mode::Live).step(cx, &m)).unwrap(),
        never
    );
    assert_eq!(
        p.cx(|cx| Review::new(Mode::Live).step(cx, &m)).unwrap(),
        never
    );
    assert_eq!(
        p.cx(|cx| Merge::new(towercab::pipeline::ci::Seq::Intent, Mode::Live).step(cx, &m))
            .unwrap(),
        never
    );
    let r = p
        .cx(|cx| wait_note(cx, &m, Waiting::CiRed, "red", ""))
        .unwrap();
    assert_eq!(r, Progress::Done(Outcome::wait(Waiting::CiRed, "red")));
    assert!(p.gh.calls().is_empty());
    let (p, m) = picked();
    assert_eq!(never_published(&m), None);
    drop(p);
}
