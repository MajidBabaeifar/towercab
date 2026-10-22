//! The verifier (PIP-32) and the PR review (PIP-4, PIP-5): the app started in code under the
//! sandbox around one fresh read-only Claude run; the review's model, prompt and schema, and
//! `approved` computed in code.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::time::Duration;

use common::pipe::{FakeClaude, LOGIN_ID as ID, Pipe, claude_md, finding, review};
use serde_json::{Value, json};
use towercab::machine::{Door, Stage};
use towercab::pipeline::review::{
    added_fns, approved, outcome_bullets, review_model, risk_low, verified_by,
};
use towercab::pipeline::schemas::{self, ReviewResult, VerifierReport};

/// The login world (`extra` front matter), its build with `fn test_login`, CI green.
fn login(extra: &str) -> Pipe {
    let p = Pipe::login(extra);
    p.plans(2).builds_tested(3).ci_green();
    p
}

/// A free local port.
fn port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// The base's `CLAUDE.md` with a ` ```run ` block.
fn with_run(p: &Pipe, command: &str, port: u16) {
    let md =
        claude_md("true") + &format!("\n```run\n{command}\nurl: http://127.0.0.1:{port}\n```\n");
    p.base("web", &[("CLAUDE.md", &md)], "verifier");
}

fn report(mismatches: Value) -> Value {
    json!({"ran": true, "saw": "the login page answers", "mismatches": mismatches})
}

/// The intent with `bullets` as its `## Proposed outcome`.
fn intent(bullets: &[&str]) -> towercab::intents::Intent {
    let list: String = bullets.iter().map(|b| format!("- {b}\n")).collect();
    common::intent(
        "261001-0900-login",
        &format!(
            "---\nrepo: web\na: 4\n---\n\n# Intent: Add login\n\n## Proposed outcome\n\n{list}"
        ),
    )
}

#[test]
fn test_verifier_opt_in() {
    let mut p = login("a: 4\n");
    p.step_to(ID, Stage::Verifier, 9);
    let calls = p.claude.calls();
    // No ` ```run ` block: nothing runs, the PR text says so.
    assert_eq!(p.step(ID), "261001-0900: verifier → review");
    assert_eq!(p.claude.calls(), calls);
    assert_eq!(p.data(ID)["verifier"], json!({"line": "not opted in"}));
}

#[test]
fn test_verifier_app_started_in_code() {
    let mut p = login("a: 4\n");
    let port = port();
    with_run(
        &p,
        &format!("python3 -m http.server {port} --bind 127.0.0.1"),
        port,
    );
    let fetched = p.w.root.join("fetched");
    p.claude
        .script(
            4,
            &format!(
                "python3 -c \"import urllib.request as u; print(u.urlopen('http://127.0.0.1:{port}/').status)\" > '{}'\n",
                fetched.display()
            ),
        )
        .answer(4, &FakeClaude::result(report(json!([]))));
    p.step_to(ID, Stage::Verifier, 9);
    let session = p.mission(ID).session;
    assert_eq!(p.step(ID), "261001-0900: verifier → review");
    // The app answered while the Claude run ran, and is gone after.
    assert_eq!(fs::read_to_string(&fetched).unwrap().trim(), "200");
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    let log = fs::read_to_string(p.runs(ID).join("app-1.log")).unwrap();
    assert!(log.contains("\"GET / HTTP/1.1\" 200"), "{log}");
    // Started in code: under bwrap with network, in the checkout.
    let app = p
        .bwraps()
        .into_iter()
        .find(|a| a.last().unwrap().contains("http.server"))
        .unwrap();
    assert!(!app.contains(&"--unshare-net".to_string()));
    let checkout = std::path::absolute(p.checkout(ID)).unwrap();
    let chdir = app.iter().position(|a| a == "--chdir").unwrap();
    assert_eq!(app[chdir + 1], checkout.display().to_string());
    // One fresh read-only session, the review model, the app's port its only network.
    assert_eq!(p.claude.flag(4, "--model").as_deref(), Some("opus"));
    let new = p.claude.flag(4, "--session-id").unwrap();
    assert_ne!(new, session);
    assert_eq!(
        p.claude.flag(4, "--tools").as_deref(),
        Some("Read,Grep,Glob,Bash,Skill")
    );
    let schema: Value = serde_json::from_str(&p.claude.flag(4, "--json-schema").unwrap()).unwrap();
    assert_eq!(schema, *schemas::VERIFIER);
    let settings: Value = serde_json::from_str(
        &fs::read_to_string(p.runs(ID).join("settings-verifier.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        settings["sandbox"]["network"]["allowedDomains"],
        json!([format!("localhost:{port}"), format!("127.0.0.1:{port}")])
    );
    let stdin = p.claude.stdin(4);
    assert!(stdin.contains(&format!("The app runs at http://127.0.0.1:{port}")));
    assert!(
        stdin.contains("<proof>\n- run the checks\n</proof>"),
        "{stdin}"
    );
    let v = &p.data(ID)["verifier"];
    assert_eq!(v["line"], "ran: the login page answers");
    assert_eq!(v["mismatches"], json!([]));
}

#[test]
fn test_verifier_app_did_not_start() {
    let mut p = login("a: 4\n");
    let port = port();
    with_run(&p, "echo broken >&2; exit 1", port);
    p.step_to(ID, Stage::Verifier, 9);
    let calls = p.claude.calls();
    assert_eq!(p.step(ID), "261001-0900: verifier → review");
    // Claude never ran; the report is one mismatch.
    assert_eq!(p.claude.calls(), calls);
    let why = fs::read_to_string(p.runs(ID).join("app-1.log.nostart")).unwrap();
    assert!(why.starts_with("the app exited before answering"), "{why}");
    assert!(
        fs::read_to_string(p.runs(ID).join("app-1.log"))
            .unwrap()
            .contains("broken")
    );
    let v = &p.data(ID)["verifier"];
    assert_eq!(v["ran"], false);
    assert_eq!(v["mismatches"][0]["expected"], "the app answers at its url");
    assert!(
        v["mismatches"][0]["observed"]
            .as_str()
            .unwrap()
            .starts_with("app didn't start: the app exited before answering")
    );
    // The wrapper on its own: an app that never answers → `.nostart`, exit 3, no Claude.
    let log = p.w.root.join("app.log");
    let ran = p.w.root.join("ran");
    let code = towercab::pipeline::verifier::hook_with(
        &json!({"argv": ["sleep", "30"], "env": {"PATH": "/usr/bin:/bin"}}).to_string(),
        &format!("http://127.0.0.1:{port}"),
        &log,
        &[
            "sh".into(),
            "-c".into(),
            format!("touch '{}'", ran.display()).into(),
        ],
        Duration::from_secs(2),
    );
    assert_eq!(code, 3);
    assert!(!ran.exists());
    assert_eq!(
        fs::read_to_string(p.w.root.join("app.log.nostart")).unwrap(),
        format!("no answer at http://127.0.0.1:{port} in 2 s\n")
    );
}

#[test]
fn test_verifier_mismatch_blocks_auto_merge() {
    let mut p = login("a: 4\n");
    let port = port();
    with_run(
        &p,
        &format!("python3 -m http.server {port} --bind 127.0.0.1"),
        port,
    );
    p.claude
        .answer(
            4,
            &FakeClaude::result(report(
                json!([{"expected": "a login form", "observed": "a 404"}]),
            )),
        )
        .answer(5, &FakeClaude::result(review(true, json!([]), Value::Null)));
    p.step_to(ID, Stage::Gate, 11);
    let r = &p.data(ID)["review"];
    assert_eq!(r["approved"], false);
    assert_eq!(
        r["reasons"],
        json!(["verifier: expected a login form, observed a 404"])
    );
    // The review saw the mismatch; the gate sends it to me even at a4.
    assert!(
        p.claude
            .stdin(5)
            .contains("Verifier: 1 mismatch: expected a login form, observed a 404")
    );
    p.step_to(ID, Stage::ApprovalMerge, 2);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("review and merge PR"));
    assert_eq!(m.why.as_deref(), Some("not approved"));
}

#[test]
fn test_reviewer_model() {
    for (worker, want) in [
        ("haiku", "sonnet"),
        ("sonnet", "opus"),
        ("opus", "opus"),
        ("fable", "fable"),
        ("claude-haiku-4-5", "claude-sonnet-4-5"),
    ] {
        assert_eq!(review_model(worker, None), want, "{worker}");
    }
    assert_eq!(review_model("haiku", Some("opus")), "opus");
    // The intent's `model` decides the step.
    let mut p = login("a: 4\nmodel: haiku\n");
    p.step_to(ID, Stage::Review, 10);
    assert_eq!(p.step(ID), "261001-0900: review → gate");
    assert_eq!(p.claude.flag(3, "--model").as_deref(), Some("haiku"));
    assert_eq!(p.claude.flag(4, "--model").as_deref(), Some("sonnet"));
}

#[test]
fn test_review_attr() {
    let mut p = login("a: 4\nreview: fable\n");
    p.step_to(ID, Stage::Review, 10);
    assert_eq!(p.step(ID), "261001-0900: review → gate");
    assert_eq!(p.claude.flag(4, "--model").as_deref(), Some("fable"));
}

#[test]
fn test_review_on_every_pr() {
    let mut p = login("a: 4\n");
    p.claude
        .answer(4, &FakeClaude::result(review(true, json!([]), Value::Null)));
    p.base(
        "web",
        &[(
            "REVIEW.md",
            "# Review\n\n## Passes\n\n- Bugs: logic errors\n",
        )],
        "review policy",
    );
    p.step_to(ID, Stage::Review, 10);
    let m = p.mission(ID);
    assert_eq!(p.step(ID), "261001-0900: review → gate");
    // One fresh read-only session in the PR head's checkout.
    let new = p.claude.flag(4, "--session-id").unwrap();
    assert_ne!(new, m.session);
    assert_eq!(p.claude.flag(4, "--resume"), None);
    assert_eq!(p.mission(ID).run_session.as_deref(), Some(new.as_str()));
    assert_eq!(
        p.claude.flag(4, "--tools").as_deref(),
        Some("Read,Grep,Glob,Bash,Skill")
    );
    let argv = p.claude.argv(4);
    assert!(
        !argv
            .iter()
            .any(|a| a.starts_with("Edit") || a.starts_with("Write"))
    );
    assert_eq!(
        p.claude.cwd(4),
        std::path::absolute(p.checkout(ID))
            .unwrap()
            .display()
            .to_string()
    );
    let stdin = p.claude.stdin(4);
    assert!(stdin.contains("<intent>\n---\nrepo: web\n"), "{stdin}");
    assert!(
        stdin.contains("## Proposed outcome\n\n- I can log in\n"),
        "{stdin}"
    );
    assert!(stdin.contains("Spec IDs of the design: WEB-1"), "{stdin}");
    assert!(stdin.contains("<plan>\n# Plan: Add login\n"), "{stdin}");
    assert!(
        stdin.contains("CI: green\nVerifier: not opted in\n"),
        "{stdin}"
    );
    assert!(stdin.contains("- Bugs: logic errors"), "{stdin}");
    let base = common::git(
        &p.checkout(ID),
        &["merge-base", "HEAD", "refs/remotes/origin/main"],
    );
    assert!(
        stdin.contains(&format!("run `git diff {}...HEAD`", base.trim())),
        "{stdin}"
    );
    let r = &p.data(ID)["review"];
    assert_eq!(r["approved"], true, "{r}");
    assert_eq!(r["head"], json!(m.head));
    assert!(!r["patch_id"].as_str().unwrap().is_empty());
}

#[test]
fn test_review_timeout() {
    // Timed out: not approved, the reason says so.
    let mut p = login("a: 4\n");
    p.w.config.agent.review_timeout = Duration::from_secs(1);
    p.claude
        .script(4, "sleep 5\n")
        .answer(4, &FakeClaude::result(review(true, json!([]), Value::Null)));
    p.step_to(ID, Stage::Review, 10);
    assert_eq!(p.step(ID), "261001-0900: review → gate");
    let r = &p.data(ID)["review"];
    assert_eq!(r["approved"], false);
    assert_eq!(r["reasons"], json!(["review: timed out"]));
    assert_eq!(r["result"], Value::Null);
    // Invalid JSON: not approved either.
    let mut p = login("a: 4\n");
    p.claude
        .answer(4, &FakeClaude::result(json!({"approved": true})));
    p.step_to(ID, Stage::Review, 10);
    assert_eq!(p.step(ID), "261001-0900: review → gate");
    let r = &p.data(ID)["review"];
    assert_eq!(r["approved"], false);
    assert!(
        r["reasons"][0]
            .as_str()
            .unwrap()
            .starts_with("review: invalid result: "),
        "{r}"
    );
}

#[test]
fn test_red_lines_in_review_prompt() {
    let review_md = "# Review\n\n## Red lines\n\n- the session cookie\n- billing\n";
    // No `a`: the review judges the door and the red lines.
    let mut p = login("");
    p.base("web", &[("REVIEW.md", review_md)], "red lines");
    p.step_to(ID, Stage::Review, 10);
    p.step(ID);
    let stdin = p.claude.stdin(4);
    assert!(
        stdin.contains("<red_lines>\n- the session cookie\n- billing\n</red_lines>"),
        "{stdin}"
    );
    assert!(stdin.contains("`door`: `one-way` if"), "{stdin}");
    // With `a`: none asked.
    let mut p = login("a: 4\n");
    p.base("web", &[("REVIEW.md", review_md)], "red lines");
    p.step_to(ID, Stage::Review, 10);
    p.step(ID);
    let stdin = p.claude.stdin(4);
    assert!(!stdin.contains("<red_lines>"), "{stdin}");
    assert!(
        stdin.contains("leave `door` null and `red_lines` empty"),
        "{stdin}"
    );
}

#[test]
fn test_review_schema() {
    let s = &*schemas::REVIEW;
    assert_eq!(s["additionalProperties"], false);
    let keys: BTreeSet<&str> = s["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "approved",
            "outcomes",
            "tests_weakened",
            "plan_followed",
            "findings",
            "door",
            "red_lines",
            "why"
        ])
    );
    assert!(s["properties"].get("risk").is_none(), "no risk field");
    let finding_keys = &s["properties"]["findings"]["items"]["required"];
    assert_eq!(
        finding_keys,
        &json!(["file", "line", "pass", "policy", "rule", "severity", "what"])
    );
    let mut v = review(
        true,
        json!([finding(true, "src/a.rs", Some(3), "panics on empty input")]),
        json!("two-way"),
    );
    v["red_lines"] = json!([{"line": "billing", "file": "src/bill.rs"}]);
    let r = ReviewResult::from_json(&v).unwrap();
    assert_eq!(r.door, Some(Door::TwoWay));
    assert!(r.findings[0].important);
    assert_eq!(r.findings[0].line, Some(3));
    assert_eq!(r.red_lines[0].file, "src/bill.rs");
    // Risk low = two-way and no red line, in code.
    assert!(!risk_low(&r));
    v["red_lines"] = json!([]);
    assert!(risk_low(&ReviewResult::from_json(&v).unwrap()));
    v["door"] = Value::Null;
    assert!(!risk_low(&ReviewResult::from_json(&v).unwrap()));
    v["door"] = json!("sideways");
    assert!(ReviewResult::from_json(&v).is_err());
}

#[test]
fn test_approved_computed_in_code() {
    let i = intent(&["I can log in", "I can log out"]);
    assert_eq!(outcome_bullets(&i), ["I can log in", "I can log out"]);
    let ids = vec!["WEB-1".to_string()];
    let tests = BTreeMap::from([("WEB-1".to_string(), vec!["test_login".to_string()])]);
    let fns = BTreeSet::from(["test_login".to_string()]);
    let base = || {
        let mut v = review(
            true,
            json!([finding(false, "a.rs", None, "naming")]),
            Value::Null,
        );
        v["outcomes"] = json!([
            {"bullet": "I can log in", "met": true, "why": "ok"},
            {"bullet": "I can log out.", "met": true, "why": "ok"},
        ]);
        v
    };
    let r = ReviewResult::from_json(&base()).unwrap();
    assert_eq!(approved(&r, &i, &ids, &tests, &fns, None), (true, vec![]));
    let no = |v: Value, verifier: Option<&VerifierReport>, fns: &BTreeSet<String>| {
        let r = ReviewResult::from_json(&v).unwrap();
        let (ok, why) = approved(&r, &i, &ids, &tests, fns, verifier);
        assert!(!ok);
        why
    };
    // The model's own `approved` isn't enough, nor needed alone.
    let mut v = base();
    v["approved"] = json!(false);
    v["why"] = json!("too big");
    assert_eq!(no(v, None, &fns), ["the reviewer did not approve: too big"]);
    let mut v = base();
    v["outcomes"][1]["met"] = json!(false);
    v["outcomes"][1]["why"] = json!("no logout button");
    assert_eq!(
        no(v, None, &fns),
        ["I can log out: not met: no logout button"]
    );
    let mut v = base();
    v["outcomes"] = json!([{"bullet": "I can log in", "met": true, "why": "ok"}]);
    assert_eq!(no(v, None, &fns), ["I can log out: no verdict"]);
    let mut v = base();
    v["tests_weakened"] = json!({"weakened": true, "where": "tests/a.rs"});
    assert_eq!(no(v, None, &fns), ["tests weakened: tests/a.rs"]);
    let mut v = base();
    v["plan_followed"] = json!({"followed": false, "where": "skipped the order"});
    assert_eq!(no(v, None, &fns), ["plan not followed: skipped the order"]);
    let mut v = base();
    v["findings"] = json!([finding(true, "src/a.rs", Some(9), "unwrap on input")]);
    assert_eq!(
        no(v, None, &fns),
        ["important: src/a.rs:9: unwrap on input"]
    );
    let mismatch = VerifierReport::from_json(&json!({"ran": true, "saw": "x",
        "mismatches": [{"expected": "200", "observed": "500"}]}))
    .unwrap();
    assert_eq!(
        no(base(), Some(&mismatch), &fns),
        ["verifier: expected 200, observed 500"]
    );
    assert_eq!(
        no(base(), None, &BTreeSet::new()),
        ["WEB-1: test_login not in the diff"]
    );
    // The spec rows' tests and the diff's added `fn test_…(`, in code.
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("web.md"),
        "| ID | Requirement | Verified by |\n|---|---|---|\n\
         | WEB-1 | log in, `a \\| b` | test_login, test_login_twice |\n\
         | WEB-2 | manual | manual |\n",
    )
    .unwrap();
    let ids2 = vec![
        "WEB-1".to_string(),
        "WEB-2".to_string(),
        "WEB-9".to_string(),
    ];
    assert_eq!(
        verified_by(dir.path(), &ids2),
        BTreeMap::from([
            (
                "WEB-1".to_string(),
                vec!["test_login".to_string(), "test_login_twice".to_string()]
            ),
            ("WEB-2".to_string(), vec![]),
        ])
    );
    let diff = "+++ b/tests/login.rs\n+#[test]\n+fn test_login() {\n+}\n-fn test_old() {}\n fn test_kept() {}\n+    fn test_login_twice ( ) {}\n";
    assert_eq!(
        added_fns(diff),
        BTreeSet::from(["test_login".to_string(), "test_login_twice".to_string()])
    );
    let r = ReviewResult::from_json(&base()).unwrap();
    let (ok, why) = approved(
        &r,
        &i,
        &ids2,
        &verified_by(dir.path(), &ids2),
        &added_fns(diff),
        None,
    );
    assert!(!ok);
    assert_eq!(why, ["WEB-9: no spec row"]);
}
