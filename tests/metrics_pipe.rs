//! What the pipeline's handlers and entry effects record (MET-16, 23..26): the login intent
//! through the real pipeline on fakes, the records read back from the loop home's spool (the
//! test config's collector is dead, so every flush spools).

mod common;

use std::fs;

use common::pipe::{
    E2E_LINE, FakeClaude, LOGIN_DIR, LOGIN_ID as ID, LOGIN_TEST, MERGE_VIEW, Pipe, done, finding,
    review, writes,
};
use serde_json::{Value, json};
use towercab::db::Db;
use towercab::indicators;
use towercab::machine::Stage;
use towercab::metrics::{self, Ev, Metric, Record, spool_read};
use towercab::pipeline::findings;
use towercab::pipeline::schemas::ReviewResult;

/// Everything the loop flushed so far, plus this thread's unflushed records.
fn recorded(p: &Pipe) -> Vec<Record> {
    let mut all = spool_read(&p.w.home.root.join("metrics.jsonl"), usize::MAX);
    all.extend(metrics::take());
    all
}

fn values(recs: &[Record], metric: Metric, labels: &[(&str, &str)]) -> Vec<f64> {
    recs.iter()
        .filter(|r| r.metric == metric && labels.iter().all(|(k, v)| r.label(k) == Some(*v)))
        .map(|r| r.value)
        .collect()
}

fn state(head: &str, s: &str) -> String {
    json!({"headRefOid": head, "mergeStateStatus": s, "mergedAt": null, "mergeCommit": null})
        .to_string()
}

fn merged(head: &str) -> String {
    json!({"headRefOid": head, "mergeStateStatus": "UNKNOWN", "mergedAt": "2026-10-22T12:00:00Z",
           "mergeCommit": {"oid": "5quash"}})
    .to_string()
}

/// The login world (`extra`): design (call 1), plan (2), a build (3) that also adds a spec
/// row, CI green, the review (4) approving with one nit; gh takes merges.
fn login(extra: &str) -> Pipe {
    let p = Pipe::login(extra);
    p.plans(2).ci_green();
    p.claude
        .script(
            3,
            &(writes("src/login.rs", "pub fn login() {}\n")
                + &writes("tests/login_test.sh", LOGIN_TEST)
                + &writes("tests/login.rs", "#[test]\nfn test_login() {}\n")
                + &writes(
                    "specs/web.md",
                    "| WEB-1 | log in | test_login |\n| WEB-2 | log out | test_logout |\n",
                )),
        )
        .answer(3, &FakeClaude::result(done("Adds login.")));
    p.claude.answer(
        4,
        &FakeClaude::result(review(
            true,
            json!([finding(false, "src/login.rs", Some(1), "naming")]),
            Value::Null,
        )),
    );
    p.gh.on("pr merge *", &[("", "", 0)])
        .on("api -X PUT *", &[("{}", "", 0)]);
    p
}

/// Steps to `merge`, merges (Towercab), then the `deploy` entry.
fn merge(p: &mut Pipe) {
    p.step_to(ID, Stage::Merge, 14);
    let head = p.mission(ID).head.unwrap();
    p.gh.on(
        MERGE_VIEW,
        &[(&state(&head, "CLEAN"), "", 0), (&merged(&head), "", 0)],
    );
    assert_eq!(p.step(ID), "261001-0900: merge → deploy");
}

#[test]
fn test_plan_design_metrics() {
    let started = "2026-10-01T08:00:00+02:00";
    let mut p = login(&format!("a: 4\nstarted: {started}\n"));
    p.step_to(ID, Stage::Build, 6);
    // After the spec: my edit of the body counts; one of a field Towercab ignores doesn't.
    let rel = format!("intents/{LOGIN_DIR}/intent.md");
    let mut text = p.intents_file(&rel).unwrap();
    text.push_str("\nAlso on mobile.\n");
    p.w.intents
        .push_mine(&[(&rel, Some(&text))], "login: mobile too");
    let text = text.replacen("---\n", "---\nreview: opus\n", 1);
    p.w.intents
        .push_mine(&[(&rel, Some(&text))], "login: reviewer");
    merge(&mut p);

    let recs = recorded(&p);
    // Started → the commit that put intent.md on main (the fixture's seed, made just now).
    let seed: f64 = common::git(
        &p.w.intents.remote,
        &["log", "--format=%ct", "--diff-filter=A", "main", "--", &rel],
    )
    .trim()
    .parse()
    .unwrap();
    let start = chrono::DateTime::parse_from_rfc3339(started)
        .unwrap()
        .timestamp() as f64;
    assert_eq!(
        values(&recs, Metric::TimeToIntent, &[("source", "me")]),
        [seed - start]
    );
    // Intent on main → the spec commit (the design's exit): seconds here.
    let lead = values(&recs, Metric::SpecLeadDuration, &[("repo", "web")]);
    assert_eq!(lead.len(), 1);
    assert!((0.0..600.0).contains(&lead[0]), "{lead:?}");
    assert_eq!(
        values(&recs, Metric::EditsAfterSpec, &[("repo", "web")]),
        [1.0]
    );
    // The build's commit changed specs/ after plan.md.
    assert_eq!(values(&recs, Metric::SpecRework, &[("repo", "web")]), [1.0]);
    // Once each.
    let entries: Vec<Metric> = recs.iter().map(|r| r.metric).collect();
    assert_eq!(
        entries.iter().filter(|m| **m == Metric::SpecRework).count(),
        1
    );
}

#[test]
fn test_build_git_metrics() {
    let mut p = login("a: 4\n");
    merge(&mut p);
    let recs = recorded(&p);
    assert_eq!(
        values(&recs, Metric::ClaudeMdUpdates, &[("repo", "web")]),
        [0.0]
    );
    assert_eq!(
        values(&recs, Metric::GateViolations, &[("repo", "web")]),
        [0.0]
    );
    assert_eq!(
        values(&recs, Metric::FirstPass, &[("result", "yes")]),
        [1.0]
    );
    // The gate's first decision on the head: the nit, on the auto path; its label. Its pass,
    // `correctness`, isn't one of REVIEW.md's (none here: the defaults): `other`.
    assert_eq!(
        values(
            &recs,
            Metric::ReviewFindings,
            &[
                ("repo", "web"),
                ("pass", "other"),
                ("policy", "none"),
                ("severity", "nit"),
                ("path", "auto"),
            ]
        ),
        [1.0]
    );
    let head = p.mission(ID).head.unwrap();
    assert_eq!(p.data(ID)["gate"]["label"], "a4");
    assert_eq!(p.data(ID)["gate"]["counted"], json!(head));

    // The same entry over a head that changes CLAUDE.md and a protected path: an update and a
    // violation (a Towercab merge).
    let dir = p.checkout(ID);
    common::write(&dir, "CLAUDE.md", "# Web, corrected\n");
    common::write(&dir, ".github/workflows/x.yml", "on: push\n");
    common::git(&dir, &["add", "-A"]);
    common::git(&dir, &["commit", "--quiet", "-m", "sneaky"]);
    let sneaky = common::git(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    p.w.db()
        .conn()
        .execute(
            "UPDATE missions SET head = ?1 WHERE intent = ?2",
            rusqlite::params![sneaky, ID],
        )
        .unwrap();
    let m = p.mission(ID);
    p.cx(|cx| indicators::entered(cx, &m)).unwrap();
    let recs = metrics::take();
    assert_eq!(values(&recs, Metric::ClaudeMdUpdates, &[]), [1.0]);
    assert_eq!(values(&recs, Metric::GateViolations, &[]), [1.0]);
    // Not a merge's entry: nothing.
    p.w.db()
        .conn()
        .execute(
            "INSERT INTO transitions (mission, at, from_stage, event, to_stage) VALUES (?1, 0, 'deploy', 'ok', 'e2e')",
            [m.id],
        )
        .unwrap();
    p.cx(|cx| indicators::entered(cx, &m)).unwrap();
    assert!(metrics::take().is_empty());
}

#[test]
fn test_findings_repeated_counted() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("t.db")).unwrap();
    let r = |rule: &str| {
        let mut v = review(
            true,
            json!([finding(false, "a.rs", None, "x")]),
            Value::Null,
        );
        v["findings"][0]["rule"] = json!(rule);
        ReviewResult::from_json(&v).unwrap()
    };
    metrics::take();
    db.conn()
        .execute(
            "INSERT INTO missions (id, intent, repo, stage, model, session, checkout, created, updated)
             VALUES (1, 'x', 'web', 'review', 'opus', 's', 'work/x-1', 0, 0)",
            [],
        )
        .unwrap();
    findings::record(db.conn(), "web", 7, 1, &r("Use ? not unwrap"), 1.0).unwrap();
    assert!(metrics::take().is_empty(), "the first PR with the rule");
    findings::record(db.conn(), "web", 9, 1, &r("use ? not unwrap"), 2.0).unwrap();
    findings::record(db.conn(), "web", 9, 1, &r("use ? not unwrap"), 3.0).unwrap();
    findings::record(db.conn(), "api", 9, 1, &r("use ? not unwrap"), 3.0).unwrap();
    let recs = metrics::take();
    assert_eq!(
        values(&recs, Metric::FindingsRepeated, &[("repo", "web")]),
        [1.0]
    );
    assert_eq!(recs.len(), 1, "once per new row; another repo's is its own");
}

/// A `type: result` line with usage by two models.
fn usage_result(structured: Value) -> String {
    json!({
        "type": "result", "subtype": "success", "is_error": false, "result": "done",
        "session_id": "s", "total_cost_usd": 0.75, "duration_ms": 1000,
        "structured_output": structured,
        "modelUsage": {
            "claude-opus-4": {"inputTokens": 100, "outputTokens": 20,
                "cacheReadInputTokens": 300, "cacheCreationInputTokens": 40, "costUSD": 0.5},
            "claude-haiku-4": {"inputTokens": 10, "outputTokens": 2,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0, "costUSD": 0.25},
        },
    })
    .to_string()
        + "\n"
}

#[test]
fn test_run_usage_per_model() {
    let mut p = login("a: 4\n");
    p.claude
        .answer(1, &usage_result(common::pipe::design(&["WEB-1"], &[])));
    p.step_to(ID, Stage::Plan, 4);
    let recs = recorded(&p);
    let l = |model: &str| {
        vec![
            ("repo", "web"),
            ("agent", "worker"),
            ("model", model.to_string().leak() as &str),
            ("stage", "design"),
        ]
    };
    assert_eq!(values(&recs, Metric::CostUsd, &l("claude-opus-4")), [0.5]);
    assert_eq!(values(&recs, Metric::CostUsd, &l("claude-haiku-4")), [0.25]);
    for (t, n) in [
        ("input", 100.0),
        ("output", 20.0),
        ("cache_read", 300.0),
        ("cache_creation", 40.0),
    ] {
        let mut labels = l("claude-opus-4");
        labels.push(("type", t));
        assert_eq!(values(&recs, Metric::Tokens, &labels), [n], "{t}");
    }
    // The mission's total for the DONE line.
    assert_eq!(p.mission(ID).cost_usd, 0.75);
    // The event names the intent; the labels don't.
    let r = recs.iter().find(|r| r.metric == Metric::CostUsd).unwrap();
    assert_eq!(r.ev.intent.as_deref(), Some(ID));
    assert!(r.label("intent_id").is_none());

    // An eval's replay keeps only its runs' usage (agent `eval`).
    metrics::take();
    {
        let _scope = metrics::eval_scope();
        metrics::add(Metric::CiRepairs, 1.0, &[("repo", "web")], &Ev::none());
        let mut r = towercab::claude::ClaudeResult::default();
        r.model_usage.insert(
            "opus".into(),
            towercab::claude::ModelUsage {
                cost_usd: 0.1,
                ..Default::default()
            },
        );
        indicators::run_usage("web", "eval", "build", &r, &Ev::none());
    }
    let recs = metrics::take();
    assert!(
        recs.iter()
            .all(|r| matches!(r.metric, Metric::CostUsd | Metric::Tokens))
    );
    assert_eq!(values(&recs, Metric::CostUsd, &[("agent", "eval")]), [0.1]);
    metrics::add(Metric::CiRepairs, 1.0, &[("repo", "web")], &Ev::none());
    assert_eq!(metrics::take().len(), 1, "the scope ended");
}

#[test]
fn test_guard_blocks_counted() {
    let tmp = tempfile::tempdir().unwrap();
    let runs = tmp.path();
    let log = runs.join("guard-blocks.jsonl");
    fs::write(
        &log,
        "{\"at\":1,\"path\":\".github/x\",\"reason\":\"r\",\"kind\":\"protected\"}\n\
         {\"at\":2,\"path\":\"tests/a.rs\",\"reason\":\"r\",\"kind\":\"test_lock\"}\n",
    )
    .unwrap();
    metrics::take();
    let ev = Ev::none();
    indicators::guard_blocks(runs, "web", &ev).unwrap();
    let recs = metrics::take();
    assert_eq!(
        values(&recs, Metric::GuardBlocks, &[("kind", "protected")]),
        [1.0]
    );
    assert_eq!(
        values(&recs, Metric::GuardBlocks, &[("kind", "test_lock")]),
        [1.0]
    );
    // Counted once; a new block counts.
    indicators::guard_blocks(runs, "web", &ev).unwrap();
    assert!(metrics::take().is_empty());
    let mut text = fs::read_to_string(&log).unwrap();
    text.push_str("{\"at\":3,\"path\":\"tests/b.rs\",\"reason\":\"r\",\"kind\":\"test_lock\"}\n");
    fs::write(&log, text).unwrap();
    indicators::guard_blocks(runs, "web", &ev).unwrap();
    assert_eq!(
        values(
            &metrics::take(),
            Metric::GuardBlocks,
            &[("repo", "web"), ("kind", "test_lock")]
        ),
        [1.0]
    );
}

/// `TOWERCAB.md` with ` ```live ` on `env:staging` (`release`: and a release block).
fn live(release: bool) -> String {
    let mut t = format!("```live\ndeploy: env:staging\ne2e: {E2E_LINE}\n```\n");
    if release {
        t.push_str(&format!(
            "\n```release\ncommand: true <sha>\ndeploy: env:production\ne2e: {E2E_LINE}\n```\n"
        ));
    }
    t
}

#[test]
fn test_deploys_counted() {
    for release in [false, true] {
        let (mut p, merge) = Pipe::merged(&live(release), "towercab");
        // The PR's head: one commit on the branch in the mission checkout.
        let dir = p.checkout(ID);
        common::write(&dir, "src/login.rs", "pub fn login() {}\n");
        common::git(&dir, &["add", "-A"]);
        common::git(&dir, &["commit", "--quiet", "-m", "login"]);
        let head = common::git(&dir, &["rev-parse", "HEAD"]).trim().to_string();
        let first: f64 = common::git(&dir, &["log", "-1", "--format=%ct"])
            .trim()
            .parse()
            .unwrap();
        p.w.db()
            .conn()
            .execute(
                "UPDATE missions SET head = ?1 WHERE intent = ?2",
                rusqlite::params![head, ID],
            )
            .unwrap();
        p.deploys("staging", 5, &merge, "identical");
        assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
        let recs = recorded(&p);
        if release {
            // `live` is staging: production comes with the release.
            assert_eq!(values(&recs, Metric::Deploys, &[("env", "staging")]), [1.0]);
            assert!(values(&recs, Metric::ChangeLeadDuration, &[]).is_empty());
        } else {
            assert_eq!(
                values(&recs, Metric::Deploys, &[("env", "production")]),
                [1.0]
            );
            let lead = values(&recs, Metric::ChangeLeadDuration, &[("repo", "web")]);
            assert_eq!(lead.len(), 1);
            let now = chrono::Utc::now().timestamp() as f64;
            assert!((lead[0] - (now - first)).abs() < 60.0, "{lead:?}");
        }
    }
}

#[test]
fn test_eval_gate_counted() {
    for (state, result) in [("failure", "drop"), ("success", "pass")] {
        let mut p = login("a: 5\n");
        p.step_to(ID, Stage::Gate, 12);
        let head = p.mission(ID).head.unwrap();
        p.w.repo_mut("web").github = "me/towercab".into();
        let status = json!({"statuses": [{"context": "towercab/evals", "state": state}]});
        p.gh.on(
            &format!("api repos/me/towercab/commits/{head}/status"),
            &[(&status.to_string(), "", 0)],
        );
        p.open_with(Pipe::handlers());
        p.step(ID);
        let recs = recorded(&p);
        assert_eq!(
            values(&recs, Metric::EvalGate, &[("result", result)]),
            [1.0]
        );
        let path = if result == "pass" { "auto" } else { "approval" };
        assert_eq!(
            values(&recs, Metric::ReviewFindings, &[("path", path)]),
            [1.0]
        );
    }
    // Another repo's PR: no evals read, none counted.
    let mut p = login("a: 5\n");
    p.step_to(ID, Stage::Merge, 14);
    assert!(values(&recorded(&p), Metric::EvalGate, &[]).is_empty());
}
