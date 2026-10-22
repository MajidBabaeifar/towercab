//! The gate (PIP-7), PR reads and the rounds they start (PIP-21), and the merge (PIP-22): the
//! final PR text and the gate's decision in code, my merge, my comments, my push and conflicts
//! with base on a waiting PR, and the merge table with its `Towercab-Gate:` trailer.

mod common;

use std::time::Duration;

use common::pipe::{
    FakeClaude, LOGIN_BRANCH, LOGIN_DIR, LOGIN_ID as ID, MERGE_VIEW, PR_READ, Pipe, done, finding,
    review, writes,
};
use common::world::open_pr;
use serde_json::{Value, json};
use towercab::events::{Comment, PrState};
use towercab::handler::{Handler, Outcome, Progress};
use towercab::machine::{Event, Stage, Waiting};
use towercab::pipeline::ci::Seq;
use towercab::pipeline::gate::findings_comment;
use towercab::pipeline::merge::Merge;
use towercab::pipeline::pr::feedback_text;
use towercab::pipeline::schemas::ReviewResult;
use towercab::pipeline::{Mode, Round, round};

/// The login world (`extra`), built with `fn test_login`, CI green, the review (call 4)
/// approving; gh takes merges and branch updates.
fn approved(extra: &str) -> Pipe {
    let p = Pipe::login(extra);
    p.plans(2).builds_tested(3).ci_green();
    p.claude
        .answer(4, &FakeClaude::result(review(true, json!([]), Value::Null)));
    p.gh.on("pr merge *", &[("", "", 0)])
        .on("api -X PUT *", &[("{}", "", 0)]);
    p
}

/// The last PR body Towercab patched.
fn body(p: &Pipe) -> String {
    let n = *p
        .gh
        .find("api -X PATCH repos/me/web/pulls/7")
        .last()
        .unwrap();
    p.gh.body(n).unwrap()
}

/// Transitions `from` → `to` so far.
fn count(p: &Pipe, from: &str, to: &str) -> usize {
    p.w.transitions(ID)
        .iter()
        .filter(|t| t.0 == from && t.2 == to)
        .count()
}

fn comment(author: &str, at: &str, body: &str) -> Comment {
    Comment {
        author: author.into(),
        at: at.into(),
        body: body.into(),
    }
}

/// An open, mergeable PR with `comments`, its head unknown to the reads ("": no `head_moved`).
fn pr_with(comments: Vec<Comment>) -> PrState {
    PrState {
        comments,
        ..open_pr("")
    }
}

/// gh's PR read with `comments` (`author`, `createdAt`, `body`).
fn gh_read(p: &Pipe, comments: &[(&str, &str, &str)]) {
    let c: Vec<Value> = comments
        .iter()
        .map(|(a, t, b)| json!({"author": {"login": a}, "createdAt": t, "body": b}))
        .collect();
    let v = json!({"state": "OPEN", "headRefOid": "", "mergeable": "MERGEABLE", "comments": c, "reviews": []});
    p.gh.replace(PR_READ, &[(&v.to_string(), "", 0)]);
}

fn passes(p: &mut Pipe, n: usize) {
    let lp = p.lp.as_mut().unwrap();
    for _ in 0..n {
        p.w.pass(lp);
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn origin_head(p: &Pipe) -> String {
    common::git(
        &p.w.root.join("repos/web.git"),
        &["rev-parse", &format!("refs/heads/{LOGIN_BRANCH}")],
    )
    .trim()
    .to_string()
}

#[test]
fn test_gate_handler() {
    let mut p = approved("a: 4\n");
    p.claude.answer(
        5,
        &FakeClaude::result(json!({"summary": "Adds a login page.", "changes": ["I can log in"]})),
    );
    p.step_to(ID, Stage::Gate, 12);
    let head = p.mission(ID).head.unwrap();
    assert_eq!(p.step(ID), "261001-0900: gate → merge");
    // The final text by the writer (haiku), checks in code.
    assert_eq!(p.claude.flag(5, "--model").as_deref(), Some("haiku"));
    let b = body(&p);
    assert!(
        b.starts_with("Adds a login page.\n\n- I can log in\n\nSpec IDs: WEB-1\n\n**Checks**\n"),
        "{b}"
    );
    assert!(
        b.contains("- CI: green\n- verifier: not opted in\n- review: approved\n"),
        "{b}"
    );
    assert_eq!(
        p.data(ID)["gate"],
        json!({"head": head, "verdict": "a4 approved", "commented": null})
    );
    assert!(p.gh.find("pr comment").is_empty());
    // a3: to me, with the review's verdicts in the text.
    let mut p = approved("a: 3\n");
    p.step_to(ID, Stage::Gate, 12);
    assert_eq!(
        p.step(ID),
        "261001-0900: gate → approval:merge · review and merge PR"
    );
    assert_eq!(p.mission(ID).why.as_deref(), Some("a3"));
    // The writer failed (no result): the template, never a wait.
    let b = body(&p);
    assert!(
        b.starts_with("feat(auth): Add login\n\n- I can log in: met: login works\n"),
        "{b}"
    );
    // A frozen repo: to me even at a5.
    let mut p = approved("a: 5\n");
    p.step_to(ID, Stage::Gate, 12);
    p.w.db()
        .conn()
        .execute(
            "INSERT INTO repo_caps (repo, capped, frozen, why, since) VALUES ('web', 0, 1, 'revert failed', 0)",
            [],
        )
        .unwrap();
    p.step(ID);
    assert_eq!(p.mission(ID).why.as_deref(), Some("repo frozen"));
    // The Towercab repo: the gate waits for `towercab/evals` on the head; red → to me.
    let mut p = approved("a: 5\n");
    p.step_to(ID, Stage::Gate, 12);
    let head = p.mission(ID).head.unwrap();
    p.w.repo_mut("web").github = "me/towercab".into();
    p.gh.on(
        &format!("api repos/me/towercab/commits/{head}/status"),
        &[
            (r#"{"state": "pending", "statuses": []}"#, "", 0),
            (
                r#"{"state": "failure", "statuses": [{"context": "towercab/evals", "state": "failure"}]}"#,
                "",
                0,
            ),
        ],
    );
    p.open_with(Pipe::handlers());
    assert_eq!(
        p.step(ID),
        "261001-0900: gate → gate",
        "no status yet: polls"
    );
    assert_eq!(p.mission(ID).step, "decide");
    p.step(ID);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("review and merge PR"));
    assert_eq!(m.why.as_deref(), Some("evals red"));
    // The review not approved at a5: to me.
    let mut p = approved("a: 5\n");
    p.claude.answer(
        4,
        &FakeClaude::result(review(
            true,
            json!([finding(true, "src/login.rs", Some(1), "no password check")]),
            Value::Null,
        )),
    );
    p.step_to(ID, Stage::Gate, 12);
    p.step(ID);
    assert_eq!(p.mission(ID).why.as_deref(), Some("not approved"));
    assert!(
        body(&p).contains("- review: not approved: important: src/login.rs:1: no password check\n")
    );
}

#[test]
fn test_no_ci_goes_to_me() {
    let mut p = approved("a: 5\n");
    p.w.config.agent.ci_grace = Duration::ZERO;
    p.ci_answers("MERGEABLE", "[]");
    p.step_to(ID, Stage::Gate, 12);
    assert_eq!(p.data(ID)["ci"]["result"], "none");
    assert_eq!(p.data(ID)["review"]["approved"], true);
    assert_eq!(
        p.step(ID),
        "261001-0900: gate → approval:merge · review and merge PR"
    );
    assert_eq!(p.mission(ID).why.as_deref(), Some("ci: none"));
    assert!(body(&p).contains("- CI: no CI checks on this repo, nothing ran\n"));
}

#[test]
fn test_findings_comment_once_per_head() {
    let mut important = finding(true, "src/login.rs", Some(3), "panics on an empty password");
    important["rule"] = json!("check input at the edge");
    important["policy"] = json!("security");
    let mut findings = vec![finding(false, "src/a.rs", None, "nit 1")];
    findings.push(important);
    for k in 2..=7 {
        findings.push(finding(false, "src/a.rs", Some(k), &format!("nit {k}")));
    }
    let r = review(true, json!(findings), Value::Null);
    let text = findings_comment(&ReviewResult::from_json(&r).unwrap(), 5).unwrap();
    assert_eq!(
        text,
        "**Review findings**: 1 important, 7 nits\n\
         - **important** `src/login.rs:3` panics on an empty password (correctness; rule: check input at the edge; policy: security)\n\
         - nit `src/a.rs` nit 1 (correctness)\n\
         - nit `src/a.rs:2` nit 2 (correctness)\n\
         - nit `src/a.rs:3` nit 3 (correctness)\n\
         - nit `src/a.rs:4` nit 4 (correctness)\n\
         - nit `src/a.rs:5` nit 5 (correctness)\n\
         2 more nits.\n"
    );
    let none = review(true, json!([]), Value::Null);
    assert_eq!(
        findings_comment(&ReviewResult::from_json(&none).unwrap(), 5),
        None
    );
    // a3 → to me with one comment; the gate again on the same head comments no more.
    let mut p = approved("a: 3\n");
    p.claude.answer(4, &FakeClaude::result(r));
    p.step_to(ID, Stage::ApprovalMerge, 12);
    let head = p.mission(ID).head.unwrap();
    let posted = p.gh.find("pr comment 7 -R me/web --body-file");
    assert_eq!(posted.len(), 1);
    let file = p.runs(ID).join(format!("findings-{}.md", &head[..7]));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    assert_eq!(p.gh.body(posted[0]).unwrap(), text);
    let md =
        p.w.intent_md(LOGIN_DIR)
            .replace("waiting: review and merge PR\n", "");
    p.w.intents.push_mine(
        &[(&format!("intents/{LOGIN_DIR}/intent.md"), Some(&md))],
        "me: again",
    );
    p.until(10, |w| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.0 == "gate" && t.2 == "approval:merge")
            .count()
            == 2
    });
    assert_eq!(p.gh.find("pr comment").len(), 1);
    assert_eq!(count(&p, "approval:merge", "gate"), 1);
}

#[test]
fn test_human_merge() {
    let mut p = approved("a: 3\n");
    p.step_to(ID, Stage::ApprovalMerge, 12);
    // I merge on GitHub: the next PR read sends it to deploy.
    p.w.prs.set(
        7,
        PrState {
            state: "MERGED".into(),
            merged_at: Some("2026-10-15T12:00:00Z".into()),
            merge_commit: Some("m3rg3d".into()),
            ..open_pr("")
        },
    );
    p.until(5, |w| w.mission(ID).merged_by.is_some());
    let m = p.mission(ID);
    assert_eq!(m.merged_by.as_deref(), Some("human"));
    assert_eq!(m.merge_sha.as_deref(), Some("m3rg3d"));
    assert!(p.w.transitions(ID).contains(&(
        "approval:merge".into(),
        "pr_merged".into(),
        "deploy".into()
    )));
    assert!(p.gh.find("pr merge").is_empty());
}

#[test]
fn test_my_comment_resumes_worker() {
    let mut p = approved("a: 3\n");
    p.step_to(ID, Stage::ApprovalMerge, 12);
    let before = p.mission(ID);
    p.claude
        .script(
            6,
            &writes("src/login.rs", "pub fn login() {}\npub fn sign_in() {}\n"),
        )
        .answer(6, &FakeClaude::result(done("Added sign_in.")))
        .answer(7, &FakeClaude::result(review(true, json!([]), Value::Null)));
    let at = "2099-01-01T09:00:00Z";
    gh_read(&p, &[("me", at, "Add sign_in too.")]);
    p.w.prs
        .set(7, pr_with(vec![comment("me", at, "Add sign_in too.")]));
    p.until(15, |w| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.0 == "gate" && t.2 == "approval:merge")
            .count()
            == 2
    });
    // The worker resumed in its session with my comment as data, then verify onward.
    assert!(p.w.transitions(ID).contains(&(
        "approval:merge".into(),
        "feedback".into(),
        "build".into()
    )));
    assert_eq!(p.claude.flag(6, "--resume"), Some(before.session.clone()));
    let stdin = p.claude.stdin(6);
    assert!(
        stdin.contains("<comments>\n- me at 2099-01-01T09:00:00Z: Add sign_in too.\n</comments>"),
        "{stdin}"
    );
    let m = p.mission(ID);
    assert_eq!(m.feedback_seen.as_deref(), Some(at));
    assert_eq!(count(&p, "build", "verify"), 2);
    assert_eq!(
        p.origin_log("web", LOGIN_BRANCH)[0].0,
        "feat(auth): address review feedback"
    );
    assert_ne!(m.head, before.head);
    // Seen: no second round.
    passes(&mut p, 2);
    assert_eq!(count(&p, "approval:merge", "build"), 1);
}

#[test]
fn test_other_authors_ignored() {
    let pr = pr_with(vec![
        comment("someone", "2099-01-01T09:00:00Z", "Rewrite it in Go."),
        comment(
            "towercab[bot]",
            "2099-01-01T09:01:00Z",
            "Review findings: …",
        ),
        comment("me", "2099-01-01T09:02:00Z", ""),
    ]);
    let mut p = approved("a: 3\n");
    p.step_to(ID, Stage::ApprovalMerge, 12);
    let m = p.mission(ID);
    assert_eq!(feedback_text(&pr, &m, "me"), ("(none)".into(), None));
    let mine = pr_with(vec![comment("me", "2099-01-01T09:03:00Z", "Fine.")]);
    assert_eq!(
        feedback_text(&mine, &m, "me"),
        (
            "- me at 2099-01-01T09:03:00Z: Fine.".into(),
            Some("2099-01-01T09:03:00Z".into())
        )
    );
    p.w.prs.set(7, pr);
    passes(&mut p, 3);
    assert_eq!(p.mission(ID).stage, Stage::ApprovalMerge);
    assert_eq!(count(&p, "approval:merge", "build"), 0);
    assert_eq!(p.claude.calls(), 5);
}

#[test]
fn test_conflict_merges_base() {
    let mut p = approved("a: 3\n");
    p.step_to(ID, Stage::ApprovalMerge, 12);
    let old = origin_head(&p);
    // Base adds its own src/login.rs: the PR conflicts.
    p.base(
        "web",
        &[("src/login.rs", "// base login\n")],
        "base: login stub",
    );
    let base = common::git(&p.w.mine("web"), &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    p.claude
        .script(
            6,
            &writes("src/login.rs", "// base login\npub fn login() {}\n"),
        )
        .answer(6, &FakeClaude::result(done("Merged base's login stub.")))
        .answer(7, &FakeClaude::result(review(true, json!([]), Value::Null)));
    p.w.prs.set(
        7,
        PrState {
            mergeable: "CONFLICTING".into(),
            ..open_pr("")
        },
    );
    p.until(15, |w| {
        if w.stage(ID) == Some(Stage::Build) {
            w.prs.set(7, open_pr(""));
        }
        w.transitions(ID)
            .iter()
            .filter(|t| t.0 == "gate" && t.2 == "approval:merge")
            .count()
            == 2
    });
    let m = p.mission(ID);
    assert!(p.w.transitions(ID).contains(&(
        "approval:merge".into(),
        "conflict".into(),
        "build".into()
    )));
    assert_eq!(m.sync_rounds, 1);
    // Towercab started `git merge` of base; the worker resolved the files only.
    let stdin = p.claude.stdin(6);
    assert!(
        stdin.contains("Towercab started `git merge` of origin/main into your branch (no rebase). Resolve the conflicts in:\nsrc/login.rs\n"),
        "{stdin}"
    );
    // Towercab's commit concludes the merge: base and the old head its parents, pushed
    // without force.
    let new = origin_head(&p);
    let origin = p.w.root.join("repos/web.git");
    let parents = common::git(&origin, &["rev-list", "--parents", "-n", "1", &new]);
    let parents: Vec<&str> = parents.split_whitespace().skip(1).collect();
    assert_eq!(parents, [old.as_str(), base.as_str()]);
    assert_eq!(
        p.origin_log("web", LOGIN_BRANCH)[0],
        (
            "feat(auth): address merge of main".into(),
            "Towercab".into()
        )
    );
    assert_eq!(
        p.origin_file("web", LOGIN_BRANCH, "src/login.rs"),
        "// base login\npub fn login() {}\n"
    );
}

#[test]
fn test_my_push_rechecks() {
    let mut p = approved("a: 3\n");
    p.claude
        .answer(6, &FakeClaude::result(review(true, json!([]), Value::Null)));
    p.step_to(ID, Stage::ApprovalMerge, 12);
    let calls = p.claude.calls();
    p.push_mine(
        "web",
        LOGIN_BRANCH,
        &[("src/extra.rs", "// mine\n")],
        "me: extra",
    );
    let mine = origin_head(&p);
    p.w.prs.set(7, open_pr(&mine));
    p.until(15, |w| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.0 == "gate" && t.2 == "approval:merge")
            .count()
            == 2
    });
    // My push → `ci` for it, then the review again on the new diff.
    assert!(p.w.transitions(ID).contains(&(
        "approval:merge".into(),
        "head_moved".into(),
        "ci".into()
    )));
    let m = p.mission(ID);
    assert_eq!(m.head.as_deref(), Some(mine.as_str()));
    assert_eq!(p.data(ID)["ci"]["head"], json!(mine));
    assert_eq!(p.data(ID)["review"]["head"], json!(mine));
    assert_eq!(p.claude.calls(), calls + 2, "a review and the writer");
    assert!(
        p.claude
            .stdin(calls + 1)
            .contains("Review the pull request")
    );
    assert_eq!(count(&p, "approval:merge", "build"), 0, "no worker run");
}

#[test]
fn test_sync_rounds_cap() {
    let mut p = approved("a: 3\n");
    p.step_to(ID, Stage::ApprovalMerge, 12);
    p.w.db()
        .conn()
        .execute(
            "UPDATE missions SET sync_rounds = 2 WHERE intent = ?1",
            [ID],
        )
        .unwrap();
    p.base(
        "web",
        &[("src/login.rs", "// base login\n")],
        "base: login stub",
    );
    p.claude
        .script(
            6,
            &writes("src/login.rs", "// base login\npub fn login() {}\n"),
        )
        .answer(6, &FakeClaude::result(done("Merged base's login stub.")))
        .answer(7, &FakeClaude::result(review(true, json!([]), Value::Null)));
    let conflicting = |head: &str| PrState {
        mergeable: "CONFLICTING".into(),
        ..open_pr(head)
    };
    p.w.prs.set(7, conflicting(""));
    // The third round runs …
    p.until(15, |w| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.0 == "gate" && t.2 == "approval:merge")
            .count()
            == 2
    });
    assert_eq!(p.mission(ID).sync_rounds, 3);
    assert_eq!(count(&p, "approval:merge", "build"), 1);
    // … then a PR still in conflict raises no more rounds: it waits on me.
    passes(&mut p, 3);
    assert_eq!(p.mission(ID).stage, Stage::ApprovalMerge);
    assert_eq!(count(&p, "approval:merge", "build"), 1);
    // A fourth found by CI (my push, still conflicting): `review and merge PR`.
    p.push_mine(
        "web",
        LOGIN_BRANCH,
        &[("README.md", "mine\n")],
        "me: readme",
    );
    let mine = origin_head(&p);
    p.w.prs.set(7, conflicting(&mine));
    p.ci_answers("CONFLICTING", "[]");
    p.until(10, |w| {
        w.transitions(ID)
            .contains(&("build".into(), "blocked".into(), "approval:merge".into()))
    });
    let m = p.mission(ID);
    assert_eq!(m.why.as_deref(), Some("3 sync rounds"));
    assert_eq!(m.sync_rounds, 3);
    assert_eq!(round(p.w.db().conn(), &m).unwrap(), Round::Conflict);
    assert_eq!(p.claude.calls(), 8, "no worker run for the fourth");
}

/// The login PR approved at a4, at `merge` (head `H`).
fn at_merge() -> (Pipe, String) {
    let mut p = approved("a: 4\n");
    p.step_to(ID, Stage::Merge, 12);
    let head = p.mission(ID).head.unwrap();
    (p, head)
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

#[test]
fn test_merge_trailer() {
    let (mut p, head) = at_merge();
    p.gh.on(
        MERGE_VIEW,
        &[(&state(&head, "CLEAN"), "", 0), (&merged(&head), "", 0)],
    );
    assert_eq!(p.step(ID), "261001-0900: merge → deploy");
    let n = p.gh.find("pr merge")[0];
    assert_eq!(
        p.gh.argv(n),
        [
            "pr",
            "merge",
            "7",
            "-R",
            "me/web",
            "--squash",
            "--match-head-commit",
            &head,
            "--subject",
            "feat(auth): Add login (#7)",
            "--body",
            &format!("Towercab-Gate: a4 approved sha={head}"),
        ]
    );
    let m = p.mission(ID);
    assert_eq!(m.merged_by.as_deref(), Some("towercab"));
    assert_eq!(m.merge_sha.as_deref(), Some("5quash"));
}

#[test]
fn test_merge_state_table() {
    let (p, head) = at_merge();
    p.gh.on(MERGE_VIEW, &[(&state(&head, "CLEAN"), "", 0)])
        .on("pr ready *", &[("", "", 0)]);
    let m0 = p.mission(ID);
    // Each state on the gated head, the handler called directly.
    let run = |s: &str, sync_rounds: u32, merge: Value, gh_merge: Option<(&str, i32)>| {
        p.gh.replace(MERGE_VIEW, &[(&state(&head, s), "", 0)]);
        if let Some((err, code)) = gh_merge {
            p.gh.replace("pr merge *", &[("", err, code)]);
        }
        let mut data: Value = serde_json::from_str(&m0.data).unwrap();
        data["merge"] = merge;
        p.w.db()
            .conn()
            .execute(
                "UPDATE missions SET step = '', sync_rounds = ?1, data = ?2 WHERE id = ?3",
                rusqlite::params![sync_rounds, data.to_string(), m0.id],
            )
            .unwrap();
        let m = p.mission(ID);
        p.cx(|cx| Merge::new(Seq::Intent, Mode::Live).step(cx, &m).unwrap())
    };
    let event = |e: Event| Progress::Done(Outcome::event(e));
    let none = Value::Null;
    assert_eq!(run("DIRTY", 0, none.clone(), None), event(Event::Conflict));
    match run("BLOCKED", 0, none.clone(), None) {
        Progress::Done(o) => assert_eq!(o.event, Event::HeadMoved),
        p => panic!("{p:?}"),
    }
    match run(
        "UNSTABLE",
        0,
        json!({"head": head, "blocked": 2, "unknown": 0}),
        None,
    ) {
        Progress::Done(o) => {
            assert_eq!(o.waiting, Some(Waiting::ReviewAndMergePr));
            assert_eq!(o.why.as_deref(), Some("UNSTABLE 3 times on this head"));
        }
        p => panic!("{p:?}"),
    }
    assert_eq!(
        run("UNKNOWN", 0, none.clone(), None),
        Progress::Poll {
            after: Duration::from_secs(10)
        }
    );
    match run(
        "UNKNOWN",
        0,
        json!({"head": head, "blocked": 0, "unknown": 6}),
        None,
    ) {
        Progress::Done(o) => assert_eq!(o.waiting, Some(Waiting::ReviewAndMergePr)),
        p => panic!("{p:?}"),
    }
    assert_eq!(
        run("DRAFT", 0, none.clone(), None),
        Progress::Poll {
            after: Duration::ZERO
        }
    );
    assert_eq!(
        p.gh.find("pr ready 7 -R me/web").len(),
        2,
        "publish's and this one"
    );
    match run("BEHIND", 3, none.clone(), None) {
        Progress::Done(o) => {
            assert_eq!(o.waiting, Some(Waiting::ReviewAndMergePr));
            assert_eq!(o.why.as_deref(), Some("3 sync rounds"));
        }
        p => panic!("{p:?}"),
    }
    // The merge refused: the head moved → ci; anything else → `merge failed` + stderr.
    assert_eq!(
        run(
            "CLEAN",
            0,
            none.clone(),
            Some((
                "GraphQL: Head branch was modified. Review and try the merge again.",
                1
            ))
        ),
        event(Event::HeadMoved)
    );
    match run(
        "HAS_HOOKS",
        0,
        none.clone(),
        Some(("Pull request is not mergeable: required reviews missing", 1)),
    ) {
        Progress::Done(o) => {
            assert_eq!(o.waiting, Some(Waiting::MergeFailed));
            assert_eq!(
                o.why.as_deref(),
                Some("Pull request is not mergeable: required reviews missing")
            );
        }
        p => panic!("{p:?}"),
    }
    // Another head than the gate's → ci; my unhandled comment → back to the worker first.
    p.gh.replace(MERGE_VIEW, &[(&state("0ther", "CLEAN"), "", 0)]);
    let m = p.mission(ID);
    assert_eq!(
        p.cx(|cx| Merge::new(Seq::Intent, Mode::Live).step(cx, &m).unwrap()),
        event(Event::HeadMoved)
    );
    gh_read(
        &p,
        &[("me", "2099-01-01T09:00:00Z", "Wait, one more thing.")],
    );
    assert_eq!(
        p.cx(|cx| Merge::new(Seq::Intent, Mode::Live).step(cx, &m).unwrap()),
        event(Event::Feedback)
    );
}

/// GitHub's update-branch: base merged into the PR branch on origin.
fn update_branch(p: &Pipe) {
    let mine = p.w.mine("web");
    common::git(&mine, &["fetch", "--quiet", "origin"]);
    common::git(
        &mine,
        &[
            "checkout",
            "--quiet",
            "-B",
            LOGIN_BRANCH,
            &format!("origin/{LOGIN_BRANCH}"),
        ],
    );
    common::git(&mine, &["merge", "--quiet", "--no-edit", "origin/main"]);
    common::git(
        &mine,
        &["push", "--quiet", "origin", &format!("HEAD:{LOGIN_BRANCH}")],
    );
    common::git(&mine, &["checkout", "--quiet", "main"]);
}

/// At merge, base moved: `BEHIND` → update-branch → ci.
fn behind() -> (Pipe, String) {
    let (mut p, head) = at_merge();
    p.base("web", &[("docs/notes.md", "base moved\n")], "base: notes");
    p.gh.on(MERGE_VIEW, &[(&state(&head, "BEHIND"), "", 0)]);
    assert_eq!(p.step(ID), "261001-0900: merge → ci");
    (p, head)
}

#[test]
fn test_behind_updates_via_api() {
    let (p, head) = behind();
    let n = p.gh.find("api -X PUT")[0];
    assert_eq!(
        p.gh.argv(n),
        [
            "api",
            "-X",
            "PUT",
            "repos/me/web/pulls/7/update-branch",
            "-f",
            &format!("expected_head_sha={head}"),
        ]
    );
    let m = p.mission(ID);
    assert_eq!(m.sync_rounds, 1);
    assert!(
        p.w.transitions(ID)
            .contains(&("merge".into(), "head_moved".into(), "ci".into()))
    );
}

#[test]
fn test_review_reused_same_patch() {
    let (mut p, _) = behind();
    update_branch(&p);
    let updated = origin_head(&p);
    let calls = p.claude.calls();
    let before = p.data(ID)["review"]["patch_id"].clone();
    p.gh.replace(
        MERGE_VIEW,
        &[
            (&state(&updated, "CLEAN"), "", 0),
            (&merged(&updated), "", 0),
        ],
    );
    p.step_to(ID, Stage::Gate, 4);
    // The PR diff is the same after base merged in: the review is reused, on the new head.
    assert_eq!(p.claude.calls(), calls);
    let r = &p.data(ID)["review"];
    assert_eq!(r["patch_id"], before);
    assert_eq!(r["head"], json!(updated));
    assert_eq!(r["approved"], true);
    p.step_to(ID, Stage::Deploy, 3);
    assert_eq!(p.mission(ID).merged_by.as_deref(), Some("towercab"));
    let n = *p.gh.find("pr merge").last().unwrap();
    assert!(
        p.gh.argv(n)
            .contains(&format!("Towercab-Gate: a4 approved sha={updated}"))
    );
}
