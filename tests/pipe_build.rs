//! Plan and build (PIP-28, PIP-1): the read-only plan written to `plan.md`, the worker's build
//! in the checkout after setup, its result, its notes and its commit.

mod common;

use std::fs;
use std::time::Duration;

use common::pipe::{
    FakeClaude, LOGIN_BRANCH, LOGIN_DIR, LOGIN_ID as ID, Pipe, blocked, design, done, plan_result,
    writes,
};
use serde_json::{Value, json};
use towercab::machine::Stage;
use towercab::pipeline::schemas;

/// The intent's `intent.md` on the intents remote.
fn intent_md(p: &Pipe) -> String {
    p.intents_file(&format!("intents/{LOGIN_DIR}/intent.md"))
        .unwrap()
}

#[test]
fn test_plan_written() {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    p.step_to(ID, Stage::Plan, 3);
    let session = p.mission(ID).session;
    assert_eq!(p.step(ID), "261001-0900: plan → build");
    // The plan run: the worker session, read-only tools, the PLAN schema.
    assert_eq!(p.claude.calls(), 2);
    assert_eq!(p.claude.flag(2, "--resume"), Some(session));
    assert_eq!(
        p.claude.flag(2, "--tools").as_deref(),
        Some("Read,Glob,Grep,Bash,Skill")
    );
    let argv = p.claude.argv(2);
    assert!(
        !argv
            .iter()
            .any(|a| a.starts_with("Edit") || a.starts_with("Write"))
    );
    let schema: Value = serde_json::from_str(&p.claude.flag(2, "--json-schema").unwrap()).unwrap();
    assert_eq!(schema, *schemas::PLAN);
    let stdin = p.claude.stdin(2);
    assert!(stdin.contains("<intent>\n---\nrepo: web\n"), "{stdin}");
    assert!(stdin.contains("Spec IDs of the design: WEB-1"), "{stdin}");
    // plan.md in the intent's folder, its own commit.
    let plan = p
        .intents_file(&format!("intents/{LOGIN_DIR}/plan.md"))
        .unwrap();
    assert_eq!(
        plan,
        "# Plan: Add login\n\nIntent 261001-0900. Spec IDs: WEB-1.\n\n\
         ## Files that change\n\n- src/login.rs\n\n\
         ## Order of work\n\n1. tests first\n2. then the code\n\n\
         ## Risks\n\n- none known\n\n## Proof\n\n- run the checks\n"
    );
    assert!(
        p.intents_log()
            .contains(&"towercab: plan 261001-0900".to_string())
    );
    // Linked in the PR body.
    let url = p.data(ID)["plan_url"].as_str().unwrap().to_string();
    assert!(
        url.ends_with(&format!("intents/{LOGIN_DIR}/plan.md")),
        "{url}"
    );
    let patch = *p
        .gh
        .find("api -X PATCH repos/me/web/pulls/7")
        .last()
        .unwrap();
    let body = p.gh.body(patch).unwrap();
    assert!(body.starts_with("Spec IDs: WEB-1\n"), "{body}");
    assert!(body.contains(&format!("**Plan:** {url}")), "{body}");
}

#[test]
fn test_plan_update_on_departure() {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    let mut r = done("Adds login, in two files.");
    r["plan"] = plan_result(&["src/login.rs", "src/session.rs"]);
    r["plan_why"] = json!("sessions need their own module");
    p.claude
        .script(
            3,
            &(writes("src/login.rs", "pub fn login() {}\n")
                + &writes("src/session.rs", "pub struct Session;\n")
                + &writes("tests/login_test.sh", common::pipe::LOGIN_TEST)),
        )
        .answer(3, &FakeClaude::result(r));
    p.step_to(ID, Stage::Verify, 5);
    let plan = p
        .intents_file(&format!("intents/{LOGIN_DIR}/plan.md"))
        .unwrap();
    assert!(
        plan.contains("Rewritten during the build: sessions need their own module\n"),
        "{plan}"
    );
    assert!(
        plan.contains("- src/login.rs\n- src/session.rs\n"),
        "{plan}"
    );
    // git keeps the old one: two commits of plan.md.
    let history = common::git(
        &p.w.intents.remote,
        &[
            "log",
            "--format=%s",
            "main",
            "--",
            &format!("intents/{LOGIN_DIR}/plan.md"),
        ],
    );
    assert_eq!(
        history.lines().collect::<Vec<_>>(),
        vec!["towercab: plan 261001-0900"; 2]
    );
}

#[test]
fn test_plan_revises_design_after_intent_edit() {
    let mut p = Pipe::login("a: 2\n");
    p.step_to(ID, Stage::ApprovalSpec, 3);
    let spec_head = p.mission(ID).head.unwrap();
    // While the spec waits I add to intent.md and continue in the same push.
    let md = intent_md(&p)
        .replace("waiting: approve spec\n", "")
        .replace("- I can log in\n", "- I can log in\n- I can log out\n");
    p.w.intents.push_mine(
        &[(&format!("intents/{LOGIN_DIR}/intent.md"), Some(&md))],
        "me: logout too",
    );
    p.claude
        .script(
            2,
            &writes(
                "specs/web.md",
                "| WEB-1 | log in | test_login |\n| WEB-2 | log out | test_logout |\n",
            ),
        )
        .answer(2, &FakeClaude::result(design(&["WEB-1", "WEB-2"], &[])));
    p.plans(3);
    p.until(10, |w| w.stage(ID) == Some(Stage::Build));
    // The design session revised first (resumed, told what changed), then the plan ran.
    let session = p.mission(ID).session;
    assert_eq!(p.claude.flag(2, "--resume"), Some(session.clone()));
    let stdin = p.claude.stdin(2);
    assert!(stdin.starts_with("Revise your spec change"), "{stdin}");
    assert!(
        stdin.contains("intent.md changed while the spec waited"),
        "{stdin}"
    );
    assert!(stdin.contains("- I can log out\n"), "{stdin}");
    assert_eq!(
        p.claude.flag(2, "--tools").as_deref(),
        Some("Read,Glob,Grep,Edit,Write,Skill")
    );
    assert_eq!(
        p.claude.flag(3, "--tools").as_deref(),
        Some("Read,Glob,Grep,Bash,Skill")
    );
    assert!(
        p.claude
            .stdin(3)
            .contains("Spec IDs of the design: WEB-1, WEB-2")
    );
    // The revision is committed and pushed onto the PR; no new approval stop.
    let log = p.origin_log("web", LOGIN_BRANCH);
    assert_eq!(log[0].0, "docs(specs): revise Add login");
    assert_eq!(log[1].0, "docs(specs): Add login");
    assert_ne!(p.mission(ID).head.unwrap(), spec_head);
    assert_eq!(p.data(ID)["design"]["spec_ids"], json!(["WEB-1", "WEB-2"]));
    let stops = p.w.transitions(ID);
    assert_eq!(
        stops.iter().filter(|t| t.2 == "approval:spec").count(),
        1,
        "{stops:?}"
    );
}

#[test]
fn test_build_prompt() {
    let mut p = Pipe::login("a: 4\nmodel: sonnet\n");
    p.plans(2).builds(3);
    p.step_to(ID, Stage::Build, 4);
    let m = p.mission(ID);
    assert_eq!(p.step(ID), "261001-0900: build → verify");
    // The worker session, resumed, in the mission checkout, on the intent's model.
    assert_eq!(p.claude.flag(3, "--resume"), Some(m.session.clone()));
    assert_eq!(p.claude.flag(3, "--model").as_deref(), Some("sonnet"));
    assert_eq!(
        fs::canonicalize(p.claude.cwd(3)).unwrap(),
        fs::canonicalize(p.checkout(ID)).unwrap()
    );
    assert_eq!(
        p.claude.flag(3, "--tools").as_deref(),
        Some("Read,Edit,Write,Glob,Grep,Bash,Skill")
    );
    let argv = p.claude.argv(3);
    assert!(
        argv.contains(&"Bash(sh check.sh:*)".to_string()),
        "{argv:?}"
    );
    assert!(argv.contains(&"Bash(git push:*)".to_string()));
    assert_eq!(p.claude.flag(3, "--max-budget-usd").as_deref(), Some("5"));
    // Its prompt: plan.md, the intent, spec IDs, the commands, the rules.
    let stdin = p.claude.stdin(3);
    assert!(stdin.contains("<plan>\n# Plan: Add login\n"), "{stdin}");
    assert!(stdin.contains("<intent>\n---\nrepo: web\n"), "{stdin}");
    assert!(stdin.contains("Spec IDs: WEB-1\n"), "{stdin}");
    assert!(
        stdin.contains("checks (in order, all must pass):\n  sh check.sh\n"),
        "{stdin}"
    );
    assert!(stdin.contains("failing tests"), "{stdin}");
    assert!(
        stdin.contains("never commit, push or touch `.git`"),
        "{stdin}"
    );
    assert!(
        stdin.contains("never weaken, skip or delete a test"),
        "{stdin}"
    );
    // Towercab commits the build as the bot, with the PR title; the notes kept.
    let dir = p.checkout(ID);
    let subject = common::git(&dir, &["log", "-1", "--format=%s%x09%an"]);
    assert_eq!(subject.trim(), "feat(auth): Add login\tTowercab");
    assert_eq!(
        fs::read_to_string(p.runs(ID).join("build.txt")).unwrap(),
        "Adds login."
    );
}

#[test]
fn test_build_prompt_fast_set() {
    // CI on the base and a ```fast block: the worker is told to run those lines (placeholders
    // explained) and that the full suite is CI's; it may run only their commands.
    let mut p = Pipe::login_fast(true);
    p.plans(2).builds(3);
    p.step_to(ID, Stage::Build, 4);
    assert_eq!(p.step(ID), "261001-0900: build → verify");
    let stdin = p.claude.stdin(3);
    assert!(
        stdin.contains("fast checks (run only these, in order, all must pass; the full suite runs in CI):\n  echo \"lint $PWD\" >> "),
        "{stdin}"
    );
    assert!(stdin.contains("\n  sh fast.sh {tests}\n"), "{stdin}");
    assert!(stdin.contains("{tests}: the paths of the test files you added or changed"));
    assert!(!stdin.contains("sh check.sh"), "{stdin}");
    assert!(!stdin.contains("every checks command"), "{stdin}");
    let argv = p.claude.argv(3);
    assert!(argv.contains(&"Bash(sh fast.sh:*)".to_string()), "{argv:?}");
    assert!(
        !argv.contains(&"Bash(sh check.sh:*)".to_string()),
        "{argv:?}"
    );
    assert!(
        argv.iter()
            .any(|a| a.starts_with("Bash(echo \"lint $PWD\""))
    );
    // Without CI the worker runs everything, as before.
    let mut p = Pipe::login_fast(false);
    p.plans(2).builds(3);
    p.step_to(ID, Stage::Build, 4);
    p.step(ID);
    let stdin = p.claude.stdin(3);
    assert!(
        stdin.contains("checks (in order, all must pass):\n  echo full >> "),
        "{stdin}"
    );
    assert!(!stdin.contains("fast checks"), "{stdin}");
    let argv = p.claude.argv(3);
    assert!(
        argv.contains(&"Bash(sh check.sh:*)".to_string()),
        "{argv:?}"
    );
    assert!(
        !argv.contains(&"Bash(sh fast.sh:*)".to_string()),
        "{argv:?}"
    );
}

#[test]
fn test_build_result_schema() {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    // `blocked` without a question is no result: one continue asking only for it.
    let mut bad = blocked("x");
    bad["question"] = Value::Null;
    p.claude
        .answer(3, &FakeClaude::result(bad))
        .answer(4, &FakeClaude::result(blocked("Which provider?")));
    p.step_to(ID, Stage::Blocked, 6);
    let schema: Value = serde_json::from_str(&p.claude.flag(3, "--json-schema").unwrap()).unwrap();
    assert_eq!(schema, *schemas::WORKER);
    assert_eq!(p.claude.calls(), 4);
    assert!(
        p.claude
            .stdin(4)
            .starts_with("Stop working. Reply with only the JSON result")
    );
    assert_eq!(p.claude.flag(4, "--resume"), Some(p.mission(ID).session));
    // Blocked: my question, in intent.md.
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("answer the question"));
    assert_eq!(m.why.as_deref(), Some("Which provider?"));
    assert!(
        intent_md(&p).contains("## Towercab\n\nQuestion: Which provider?"),
        "{}",
        intent_md(&p)
    );
    // `lower_a`: the build lowers the intent's `a` (AUT-7), with its reason.
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    let mut lower = done("Adds login.");
    lower["lower_a"] = json!(2);
    lower["lower_why"] = json!("touches billing");
    p.claude
        .script(
            3,
            &(writes("src/login.rs", "pub fn login() {}\n")
                + &writes("tests/login_test.sh", common::pipe::LOGIN_TEST)),
        )
        .answer(3, &FakeClaude::result(lower));
    p.step_to(ID, Stage::Verify, 6);
    let md = intent_md(&p);
    assert!(md.contains("\na: 2\n"), "{md}");
    assert!(md.contains("touches billing"), "{md}");
}

#[test]
fn test_build_timeout() {
    let mut p = Pipe::login("a: 4\n");
    p.w.config.agent.build_timeout = Duration::from_secs(1);
    p.plans(2);
    p.claude.script(3, "sleep 20\n").script(4, "sleep 20\n");
    p.step_to(ID, Stage::Blocked, 6);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("worker timeout"));
    assert_eq!(p.claude.calls(), 4);
    assert!(p.claude.stdin(4).starts_with("Stop working."));
}

#[test]
fn test_no_result() {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    p.claude.answer(3, "").answer(4, "not json\n");
    p.step_to(ID, Stage::Blocked, 6);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("no result"));
    assert_eq!(p.claude.calls(), 4);
    assert!(p.claude.stdin(4).starts_with("Stop working."));
    // A budget used up: `worker budget` after the continue.
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    let budget = json!({"type": "result", "subtype": "error_max_budget_usd", "is_error": true,
        "result": "", "session_id": "s", "total_cost_usd": 5.0})
    .to_string()
        + "\n";
    p.claude.answer(3, &budget).answer(4, &budget);
    p.step_to(ID, Stage::Blocked, 6);
    assert_eq!(p.mission(ID).waiting.as_deref(), Some("worker budget"));
}

#[test]
fn test_no_changes() {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    p.claude
        .answer(3, &FakeClaude::result(done("Nothing to do.")));
    p.step_to(ID, Stage::Blocked, 5);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("no changes"));
    // The spec commit alone is no change.
    let dir = p.checkout(ID);
    let subject = common::git(&dir, &["log", "-1", "--format=%s"]);
    assert_eq!(subject.trim(), "docs(specs): Add login");
}

#[test]
fn test_setup_before_build() {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2);
    let seen = p.w.root.join("seen");
    // The build sees setup done in its checkout; verify is red once.
    p.claude
        .script(
            3,
            &format!(
                "cp '{}' '{}-3'\n{}",
                p.w.root.join("setup.log").display(),
                seen.display(),
                writes("src/login.rs", "pub fn login() {}\n")
                    + &writes("tests/login_test.sh", "exit 1\n")
            ),
        )
        .answer(3, &FakeClaude::result(done("Adds login.")))
        .script(
            4,
            &format!(
                "cp '{}' '{}-4'\n{}",
                p.w.root.join("setup.log").display(),
                seen.display(),
                writes("tests/login_test.sh", common::pipe::LOGIN_TEST)
            ),
        )
        .answer(4, &FakeClaude::result(done("Fixed the test.")));
    p.step_to(ID, Stage::Publish, 12);
    let checkout = p.checkout(ID).display().to_string();
    let lines = |f: &str| -> Vec<String> {
        fs::read_to_string(f)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    };
    // Setup ran in the checkout before the first build.
    assert_eq!(
        lines(&format!("{}-3", seen.display())),
        vec![checkout.clone()]
    );
    // Once per checkout: the repair round's build doesn't run it again (verify does, each time).
    assert_eq!(
        lines(&format!("{}-4", seen.display())),
        vec![checkout.clone(), checkout.clone()]
    );
    assert_eq!(p.setups().len(), 4, "build, verify, verify, proof");
    assert!(p.setups()[3].ends_with("-proof"));
    // The repair's notes follow the build's.
    assert_eq!(
        fs::read_to_string(p.runs(ID).join("build.txt")).unwrap(),
        "Adds login.\n\nRepair: Fixed the test."
    );
    let subject = common::git(&p.checkout(ID), &["log", "-1", "--format=%s"]);
    assert_eq!(subject.trim(), "feat(auth): address checks red");
}

#[test]
fn test_plan_review() {
    // a3: after the plan, it waits for my approval before any code (AUT-12).
    let mut p = Pipe::login("a: 3\n");
    p.approve_plans = false;
    p.plans(2);
    p.step_to(ID, Stage::Plan, 3);
    assert_eq!(p.step(ID), "261001-0900: plan → blocked · approve plan");
    assert_eq!(p.claude.calls(), 2, "no build run yet");
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("approve plan"));
    assert_eq!(m.why.as_deref(), Some("a3"));
    assert!(intent_md(&p).contains("Plan written:"), "{}", intent_md(&p));
    // One message, its first line the action.
    let rows = p.w.outbox();
    assert!(
        rows.iter()
            .any(|r| r.1 == "approve_plan" && r.3.starts_with("approve plan: approve 261001-0900")),
        "{rows:?}"
    );
    // Approved: the first build, with the build prompt (not a continue).
    p.approve_plans = true;
    p.builds_tested(3);
    p.step_to(ID, Stage::Verify, 4);
    assert!(
        p.claude.stdin(3).starts_with("Build the intent below now"),
        "{}",
        p.claude.stdin(3)
    );
    // a4: no stop.
    let mut q = Pipe::login("a: 4\n");
    q.approve_plans = false;
    q.plans(2);
    q.step_to(ID, Stage::Plan, 3);
    assert_eq!(q.step(ID), "261001-0900: plan → build");
}
