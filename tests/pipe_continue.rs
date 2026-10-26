//! Continue and attempts (PIP-17): my continue by the wait it clears, an attempt adopting the
//! earlier one's PR, a fresh attempt replacing it, and never a force push.

mod common;

use std::fs;

use common::git;
use common::pipe::{FakeClaude, Pipe, design, writes};
use common::world::{intent_file, open_pr};
use rusqlite::types::Value as Sql;
use serde_json::json;
use towercab::commands::{self, Cmd};
use towercab::events::PrState;
use towercab::handler::update;
use towercab::machine::{Next, Stage, Waiting, continue_to};
use towercab::pipeline::design::{Adoption, adoption};
use towercab::pipeline::gh::pr_view;
use towercab::pipeline::{Round, round};

const ID: &str = "261001-0900";
const DIR: &str = "261001-0900-login";
const BRANCH: &str = "towercab/261001-0900-login";

fn pipe(extra: &str) -> Pipe {
    Pipe::new(&[intent_file(DIR, "web", extra, "Add login")], &["web"])
}

/// Design run `n` writes `specs/web.md` (`rows`) and answers with `spec_ids`.
fn designs(p: &Pipe, n: usize, rows: &str, spec_ids: &[&str]) {
    p.claude
        .script(n, &writes("specs/web.md", rows))
        .answer(n, &FakeClaude::result(design(spec_ids, &[])));
}

/// Attempt 1 at `approval:spec` (a2) with PR 7 on [`BRANCH`]; `list` answers its `pr list`
/// calls (the first must be `[]`).
fn spec_waiting(list: &[(&str, &str, i32)]) -> Pipe {
    let mut p = pipe("a: 2\n");
    designs(&p, 1, "| WEB-1 | log in | test_login |\n", &["WEB-1"]);
    p.gh.on("pr list *", list)
        .on(
            "pr create *",
            &[
                ("https://github.com/me/web/pull/7\n", "", 0),
                ("https://github.com/me/web/pull/8\n", "", 0),
            ],
        )
        .on("api -X PATCH *", &[("{}", "", 0)])
        .on("pr close *", &[("", "", 0)]);
    p.step_to(ID, Stage::ApprovalSpec, 3);
    p
}

/// Attempt 1 ends without `retry_fresh` (stopped); `intent.md` loses `stage`, `waiting` and,
/// with `drop_pr`, `pr:`; the loop opens again (attempt 2 is picked by the next step).
fn end_attempt(p: &mut Pipe, drop_pr: bool) {
    let m = p.mission(ID);
    let db = p.w.db();
    update(
        db.conn(),
        m.id,
        &[
            ("stage".into(), Sql::Text("stopped".into())),
            ("step".into(), Sql::Text(String::new())),
            ("finished".into(), Sql::Real(1.0)),
        ],
    )
    .unwrap();
    let md = p.w.intent_md(DIR);
    let kept: String = md
        .lines()
        .filter(|l| !l.starts_with("stage:") && !l.starts_with("waiting:"))
        .filter(|l| !(drop_pr && l.starts_with("pr:")))
        .map(|l| format!("{l}\n"))
        .collect();
    let rel = format!("intents/{DIR}/intent.md");
    p.w.intents.push_mine(&[(&rel, Some(&kept))], "me: retry");
    // Towercab's intents checkout as a pass would pull it.
    p.w.intents.store().list().unwrap();
    p.open_with(Pipe::handlers());
}

fn view(state: &str, head: &str, merge: Option<&str>, by: &str) -> String {
    json!({
        "state": state, "mergedAt": merge.map(|_| "2026-10-15T10:00:00Z"),
        "mergedBy": {"login": by}, "mergeCommit": merge.map(|m| json!({"oid": m})),
        "headRefName": BRANCH, "headRefOid": head, "isCrossRepository": false,
    })
    .to_string()
}

fn origin_head(p: &Pipe, branch: &str) -> String {
    git(&p.w.root.join("repos/web.git"), &["rev-parse", branch])
        .trim()
        .to_string()
}

#[test]
fn test_continue_by_waiting() {
    use Waiting as W;
    // PIP-17's table.
    let go = |w: W| continue_to(&w, Stage::Ci);
    assert_eq!(go(W::ApproveSpec), Next::Go(Stage::Plan));
    assert_eq!(go(W::ReviewAndMergePr), Next::Go(Stage::Gate));
    assert_eq!(go(W::AuthorizeRelease), Next::Go(Stage::Release));
    assert_eq!(
        go(W::E2eRedAfterYourMerge(towercab::machine::Door::OneWay)),
        Next::Go(Stage::Done)
    );
    assert_eq!(
        continue_to(&W::DeployNotSeen, Stage::Deploy),
        Next::Go(Stage::Deploy)
    );
    assert_eq!(go(W::PrClosed), Next::Fresh);
    for w in [
        W::AnswerTheQuestion,
        W::ChecksRed,
        W::CiRed,
        W::NoResult,
        W::WorkerTimeout,
        W::PrStateUnknown,
    ] {
        assert_eq!(go(w), Next::Go(Stage::Build), "{w}");
    }
    // A wait before the build goes back to its stage; CI waits wait again; after the merge
    // nothing is rebuilt: a failed release command runs again, a red production e2e is kept.
    for (w, from) in [
        (W::NoResult, Stage::Design),
        (W::PrStateUnknown, Stage::Design),
        (W::AnswerTheQuestion, Stage::Design),
        (W::WorkerTimeout, Stage::Plan),
        (W::CiStuck, Stage::Ci),
        (W::NoCiChecks, Stage::Ci),
        (W::ReleaseFailed, Stage::Release),
    ] {
        assert_eq!(continue_to(&w, from), Next::Go(from), "{w}");
    }
    assert_eq!(
        continue_to(&W::ProductionE2eRed, Stage::Release),
        Next::Go(Stage::Done)
    );
    // A wait in design (no result) continued by removing `waiting`: the same mission designs
    // again (no build without a spec), repair counts reset.
    let mut p = pipe("a: 4\n");
    p.claude.answer(1, "").answer(2, "");
    designs(&p, 3, "| WEB-1 | log in | test_login |\n", &["WEB-1"]);
    p.gh.on("pr list *", &[("[]", "", 0)])
        .on(
            "pr create *",
            &[("https://github.com/me/web/pull/7\n", "", 0)],
        )
        .on("api -X PATCH *", &[("{}", "", 0)]);
    p.step_to(ID, Stage::Blocked, 3);
    let m = p.mission(ID);
    let db = p.w.db();
    update(
        db.conn(),
        m.id,
        &[("verify_repairs".into(), Sql::Integer(2))],
    )
    .unwrap();
    let md = p.w.intent_md(DIR).replace("waiting: no result\n", "");
    p.w.intents.push_mine(
        &[(&format!("intents/{DIR}/intent.md"), Some(&md))],
        "me: go on",
    );
    let Pipe { w, lp, .. } = &mut p;
    w.until(lp.as_mut().unwrap(), 5, |w| {
        w.transitions(ID).iter().any(|t| t.1 == "intent_continued")
    });
    let t = p.w.transitions(ID);
    assert!(
        t.contains(&("blocked".into(), "intent_continued".into(), "design".into())),
        "{t:?}"
    );
    assert_eq!(p.w.missions(ID).len(), 1);
    assert_eq!(p.mission(ID).verify_repairs, 0);
    // The design runs again in its session, and its spec gate stops it (a4 with a spec: no
    // gate; the PR opens as a draft).
    let Pipe { w, lp, .. } = &mut p;
    w.until(lp.as_mut().unwrap(), 5, |w| {
        w.stage(ID) == Some(Stage::Plan)
    });
    assert!(p.claude.stdin(3).contains("Add login"), "the design prompt");
    assert_eq!(p.mission(ID).pr, Some(7));
    // `PR closed` (a stopped mission): my approve → attempt 2, fresh from base, nothing closed.
    let mut p = spec_waiting(&[("[]", "", 0)]);
    let mut closed = open_pr("x");
    closed.state = "CLOSED".into();
    p.w.prs.set(7, closed);
    let Pipe { w, lp, .. } = &mut p;
    w.until(lp.as_mut().unwrap(), 5, |w| {
        w.stage(ID) == Some(Stage::Stopped)
    });
    assert_eq!(p.mission(ID).waiting.as_deref(), Some("PR closed"));
    p.gh.on("pr view 7 *", &[(&view("CLOSED", "x", None, ""), "", 0)]);
    designs(&p, 2, "| WEB-1 | log in again | test_login |\n", &["WEB-1"]);
    let db = p.w.db();
    commands::queue(&db, &Cmd::Approve(ID.into()), "cli").unwrap();
    // Applied by the loop: `waiting` removed, the intent unstaged (no unfinished mission); a
    // step picks attempt 2.
    p.until(10, |w| {
        let md = w.intent_md(DIR);
        !md.contains("waiting:") && !md.contains("stage:")
    });
    assert_eq!(p.step(ID), "261001-0900: pick → design");
    assert_eq!(
        p.step(ID),
        "261001-0900: design → approval:spec · approve spec"
    );
    let m2 = p.mission(ID);
    assert_eq!(m2.attempt, 2);
    assert_eq!(m2.branch.as_deref(), Some("towercab/261001-0900-login-2"));
    assert_eq!(p.data(ID)["adopted"]["state"], "closed");
    assert!(
        p.claude
            .stdin(2)
            .contains("PR https://github.com/me/web/pull/7 is closed: start over from base")
    );
    assert!(p.gh.find("pr close").is_empty());
}

#[test]
fn test_retry_continues_on_open_pr() {
    let mut p = spec_waiting(&[("[]", "", 0)]);
    let head1 = origin_head(&p, BRANCH);
    end_attempt(&mut p, false);
    p.gh.on("pr view 7 *", &[(&view("OPEN", &head1, None, ""), "", 0)]);
    let seen = p.claude.dir.join("seen-2");
    p.claude
        .script(
            2,
            &format!(
                "cat specs/web.md > '{}'\n{}",
                seen.display(),
                writes(
                    "specs/web.md",
                    "| WEB-1 | log in | test_login |\n| WEB-2 | log out | test_logout |\n"
                )
            ),
        )
        .answer(2, &FakeClaude::result(design(&["WEB-1", "WEB-2"], &[])));
    assert_eq!(p.step(ID), "261001-0900: pick → design");
    assert_eq!(
        p.step(ID),
        "261001-0900: design → approval:spec · approve spec"
    );
    let m = p.mission(ID);
    assert_eq!(m.attempt, 2);
    // Adopted: its branch, its PR; the design run saw the earlier work.
    assert_eq!(m.branch.as_deref(), Some(BRANCH));
    assert_eq!(m.pr, Some(7));
    assert_eq!(
        p.data(ID)["adopted"],
        json!({"pr": 7, "url": "https://github.com/me/web/pull/7", "state": "open"})
    );
    assert_eq!(
        fs::read_to_string(&seen).unwrap(),
        "| WEB-1 | log in | test_login |\n"
    );
    assert!(p.claude.stdin(2).contains("is open and adopted"));
    // Pushed onto it (a fast-forward), no second PR; its body reset to the initial text.
    let log = p.origin_log("web", BRANCH);
    assert_eq!(log.len(), 3, "{log:?}");
    assert_eq!(
        git(
            &p.w.root.join("repos/web.git"),
            &["rev-parse", &format!("{BRANCH}^")]
        )
        .trim(),
        head1
    );
    assert_eq!(p.gh.find("pr create").len(), 1);
    let patch = *p
        .gh
        .find("api -X PATCH repos/me/web/pulls/7")
        .last()
        .unwrap();
    assert!(
        p.gh.body(patch)
            .unwrap()
            .starts_with("Spec IDs: WEB-1, WEB-2\n")
    );
}

/// A plan result.
fn plan() -> String {
    FakeClaude::result(
        json!({"files": ["src/login.rs"], "order": ["test", "code"], "risks": [], "proof": ["log in"]}),
    )
}

/// A blocked worker result asking `q`.
fn blocked(q: &str) -> String {
    FakeClaude::result(
        json!({"status": "blocked", "question": q, "notes": "", "plan": null,
        "plan_why": null, "lower_a": null, "lower_why": null}),
    )
}

#[test]
fn test_continue_resumes_session() {
    let mut p = pipe("a: 4\n");
    designs(&p, 1, "| WEB-1 | log in | test_login |\n", &["WEB-1"]);
    p.claude
        .answer(2, &plan())
        .answer(3, &blocked("which provider?"))
        .answer(4, &blocked("and the scope?"));
    p.gh.on("pr list *", &[("[]", "", 0)])
        .on(
            "pr create *",
            &[("https://github.com/me/web/pull/7\n", "", 0)],
        )
        .on("api -X PATCH *", &[("{}", "", 0)]);
    p.step_to(ID, Stage::Blocked, 6);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("answer the question"));
    assert_eq!(p.claude.calls(), 3);
    // I comment on the PR, the checkout is gone, I remove `waiting`.
    let head = m.head.clone().unwrap();
    let mut pr: PrState = open_pr(&head);
    pr.comments = vec![towercab::events::Comment {
        author: "me".into(),
        at: "2099-01-01T09:00:00Z".into(),
        body: "Use GitHub.".into(),
    }];
    p.gh.on(
        "pr view 7 *",
        &[(&json!({"state": "OPEN", "headRefOid": head, "mergeable": "MERGEABLE", "reviews": [],
            "comments": [{"author": {"login": "me"}, "createdAt": "2099-01-01T09:00:00Z", "body": "Use GitHub."}]}).to_string(), "", 0)],
    )
    .on("api --paginate *", &[("[]", "", 0)]);
    let checkout = p.w.home.root.join(&m.checkout);
    fs::remove_dir_all(&checkout).unwrap();
    let md =
        p.w.intent_md(DIR)
            .replace("waiting: answer the question\n", "");
    p.w.intents.push_mine(
        &[(&format!("intents/{DIR}/intent.md"), Some(&md))],
        "me: GitHub",
    );
    p.until(10, |w| {
        w.transitions(ID).iter().any(|t| t.1 == "intent_continued")
            && w.stage(ID) == Some(Stage::Blocked)
    });
    // The build resumed: a Continue round of the same attempt, session (resumed) and checkout,
    // re-made on the PR head.
    let after = p.mission(ID);
    assert_eq!((after.id, after.attempt), (m.id, 1));
    assert_eq!(round(p.w.db().conn(), &after).unwrap(), Round::Continue);
    assert_eq!(p.claude.calls(), 4);
    assert_eq!(p.claude.flag(4, "--resume"), Some(m.session.clone()));
    assert_eq!(
        fs::canonicalize(p.claude.cwd(4)).unwrap(),
        fs::canonicalize(&checkout).unwrap()
    );
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]).trim(), head);
    assert_eq!(git(&checkout, &["branch", "--show-current"]).trim(), BRANCH);
    // The prompt: the wait's reason, intent.md, my new comment, all as data; my comment seen.
    let what = p.claude.stdin(4);
    assert!(
        what.contains("<wait>\nanswer the question\n261001-0900 web: Add login\nwhich provider?"),
        "{what}"
    );
    assert!(what.contains("<intent>\n---\nrepo: web\n"), "{what}");
    assert!(
        what.contains("## Towercab\n\nQuestion: which provider?"),
        "the note: {what}"
    );
    assert!(
        what.contains("<comments>\n- me at 2099-01-01T09:00:00Z: Use GitHub.\n</comments>"),
        "{what}"
    );
    assert_eq!(after.feedback_seen.as_deref(), Some("2099-01-01T09:00:00Z"));
    assert_eq!(after.waiting.as_deref(), Some("answer the question"));
    assert_eq!(after.why.as_deref(), Some("and the scope?"));
}

#[test]
fn test_merged_pr_reenters_deploy() {
    let mut p = spec_waiting(&[("[]", "", 0)]);
    end_attempt(&mut p, false);
    p.gh.on(
        "pr view 7 *",
        &[(&view("MERGED", "h", Some("abc123"), "me"), "", 0)],
    );
    p.step(ID);
    assert_eq!(p.step(ID), "261001-0900: design → deploy");
    let m = p.mission(ID);
    assert_eq!((m.attempt, m.pr), (2, Some(7)));
    assert_eq!(m.merge_sha.as_deref(), Some("abc123"));
    assert_eq!(m.merged_by.as_deref(), Some("human"));
    assert_eq!(p.claude.calls(), 1, "no rebuild");
    // Merged and reverted on base: a fresh attempt from base instead.
    let mut p = spec_waiting(&[("[]", "", 0)]);
    end_attempt(&mut p, false);
    let mine = p.w.mine("web");
    git(&mine, &["checkout", "--quiet", "main"]);
    git(
        &mine,
        &[
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Revert \"login\"\n\nThis reverts commit abc123.",
        ],
    );
    git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
    p.gh.on(
        "pr view 7 *",
        &[(&view("MERGED", "h", Some("abc123"), "me"), "", 0)],
    );
    designs(&p, 2, "| WEB-1 | log in | test_login |\n", &["WEB-1"]);
    p.step(ID);
    assert_eq!(
        p.step(ID),
        "261001-0900: design → approval:spec · approve spec"
    );
    let m = p.mission(ID);
    assert_eq!(p.data(ID)["adopted"]["state"], "merged and reverted");
    assert_eq!(m.branch.as_deref(), Some("towercab/261001-0900-login-2"));
    assert_eq!(m.pr, Some(8));
    assert!(
        p.claude
            .stdin(2)
            .contains("is merged and reverted: start over from base")
    );
}

/// Attempt 1 at `approval:spec` with PR 7, then `retry --fresh`: attempt 2 designs from base
/// on `…-2` and opens PR 8.
fn fresh() -> (Pipe, String) {
    let mut p = spec_waiting(&[("[]", "", 0)]);
    let head1 = origin_head(&p, BRANCH);
    designs(
        &p,
        2,
        "| WEB-1 | log in, fresh | test_login |\n",
        &["WEB-1"],
    );
    let db = p.w.db();
    commands::queue(&db, &Cmd::RetryFresh(ID.into()), "cli").unwrap();
    let Pipe { w, lp, .. } = &mut p;
    w.wait_for(lp.as_mut().unwrap(), 30, |w, _| {
        w.missions(ID).len() == 2 && w.stage(ID) == Some(Stage::ApprovalSpec)
    });
    (p, head1)
}

#[test]
fn test_retry_fresh() {
    let (p, _) = fresh();
    let ms = p.w.missions(ID);
    assert_eq!(ms[0].stage, Stage::Stopped);
    assert_eq!(ms[0].why.as_deref(), Some("replaced by attempt 2"));
    let m = &ms[1];
    assert_eq!(m.attempt, 2);
    assert_eq!((m.verify_repairs, m.ci_repairs, m.sync_rounds), (0, 0, 0));
    assert_ne!(m.session, ms[0].session);
    assert_eq!(p.data(ID)["adopted"]["state"], "fresh");
    assert!(
        p.claude
            .stdin(2)
            .contains("a fresh attempt replacing PR https://github.com/me/web/pull/7")
    );
    // The old PR closed with a link to the new one.
    let close = p.gh.find("pr close 7");
    assert_eq!(close.len(), 1);
    assert_eq!(
        p.gh.argv(close[0]),
        [
            "pr",
            "close",
            "7",
            "-R",
            "me/web",
            "--comment",
            "Replaced by https://github.com/me/web/pull/8"
        ]
    );
    assert_eq!(m.pr, Some(8));
}

#[test]
fn test_fresh_attempt_replaces_stale_branch() {
    let (p, head1) = fresh();
    let m = p.mission(ID);
    let new = "towercab/261001-0900-login-2";
    assert_eq!(m.branch.as_deref(), Some(new));
    // From base: the old branch's commits aren't on it; the old one is left as it was.
    let origin = p.w.root.join("repos/web.git");
    let base = git(&origin, &["rev-parse", "main"]).trim().to_string();
    assert_eq!(
        git(&origin, &["rev-parse", &format!("{new}^")]).trim(),
        base
    );
    assert_eq!(origin_head(&p, BRANCH), head1);
    assert_eq!(
        p.origin_file("web", new, "specs/web.md"),
        "| WEB-1 | log in, fresh | test_login |\n"
    );
    // Its checkout is new; the replaced one is gone.
    assert!(!p.w.home.root.join("work/261001-0900-1").exists());
    let dir = p.w.home.root.join(&m.checkout);
    assert_eq!(m.checkout, "work/261001-0900-2");
    assert_eq!(git(&dir, &["branch", "--show-current"]).trim(), new);
}

#[test]
fn test_gh_failure_at_retry_asks_and_never_force_pushes() {
    let mut p = spec_waiting(&[("[]", "", 0)]);
    let head1 = origin_head(&p, BRANCH);
    end_attempt(&mut p, false);
    p.gh.on(
        "pr view 7 *",
        &[("", "HTTP 403: Resource not accessible by integration", 1)],
    );
    p.step(ID);
    assert_eq!(
        p.step(ID),
        "261001-0900: design → blocked · PR state unknown"
    );
    assert!(p.mission(ID).why.unwrap().contains("HTTP 403"));
    assert_eq!(origin_head(&p, BRANCH), head1);
    assert_eq!(p.claude.calls(), 1);
    let log = fs::read_to_string(p.w.root.join("pipebin/git.log")).unwrap();
    assert_eq!(
        log.lines().filter(|l| l.contains(" push ")).count(),
        1,
        "only attempt 1's"
    );
    for push in log.lines().filter(|l| l.contains(" push ")) {
        assert!(!push.contains("--force") && !push.contains(" +"), "{push}");
    }
    // My continue: design again, adoption first: PR 7 adopted, never a second PR.
    let creates = p.gh.find("pr create").len();
    p.gh.replace("pr view 7 *", &[(&view("OPEN", &head1, None, ""), "", 0)]);
    designs(&p, 2, "| WEB-1 | log in again | test_login |\n", &["WEB-1"]);
    commands::queue(&p.w.db(), &Cmd::Approve(ID.into()), "cli").unwrap();
    p.until(20, |w| w.stage(ID) == Some(Stage::ApprovalSpec));
    assert!(
        p.w.transitions(ID)
            .contains(&("blocked".into(), "approve".into(), "design".into()))
    );
    assert_eq!(p.data(ID)["adopted"]["state"], "open");
    assert_eq!(p.mission(ID).pr, Some(7));
    assert_eq!(p.gh.find("pr create").len(), creates);
}

#[test]
fn test_lost_pr_line_never_force_pushes() {
    // `pr list --head` for attempt 1's publish ([]), then for attempt 2's adoption (PR 7).
    let open = json!([{"number": 7, "url": "https://github.com/me/web/pull/7", "headRefOid": "x"}])
        .to_string();
    let mut p = spec_waiting(&[("[]", "", 0), (&open, "", 0)]);
    // I push onto the PR, then lose its `pr:` line.
    p.push_mine("web", BRANCH, &[("README.md", "# mine\n")], "docs: mine");
    let mine = origin_head(&p, BRANCH);
    end_attempt(&mut p, true);
    assert!(!p.w.intent_md(DIR).contains("pr:"));
    p.gh.on("pr view 7 *", &[(&view("OPEN", &mine, None, ""), "", 0)]);
    designs(
        &p,
        2,
        "| WEB-1 | log in | test_login |\n| WEB-2 | log out | test_logout |\n",
        &["WEB-1", "WEB-2"],
    );
    p.step(ID);
    p.step(ID);
    let m = p.mission(ID);
    assert_eq!((m.pr, m.branch.as_deref()), (Some(7), Some(BRANCH)));
    let list = p.gh.find("pr list");
    assert!(p.gh.calls()[list[1] - 1].contains(&format!("--head {BRANCH} --state open")));
    // My commit kept: the new head builds on it.
    let origin = p.w.root.join("repos/web.git");
    assert_eq!(
        git(&origin, &["rev-parse", &format!("{BRANCH}^")]).trim(),
        mine
    );
    assert_eq!(p.origin_file("web", BRANCH, "README.md"), "# mine\n");
}

#[test]
fn test_open_pr_states() {
    let v = |state: &str, merged: bool, fork: bool| {
        let mut j: serde_json::Value =
            serde_json::from_str(&view(state, "h", merged.then_some("abc"), "me")).unwrap();
        j["isCrossRepository"] = json!(fork);
        pr_view(&j.to_string()).unwrap()
    };
    assert_eq!(adoption(&v("OPEN", false, false), false), Adoption::Open);
    assert_eq!(adoption(&v("MERGED", true, false), false), Adoption::Merged);
    assert_eq!(
        adoption(&v("MERGED", true, false), true),
        Adoption::Gone("merged and reverted")
    );
    assert_eq!(
        adoption(&v("CLOSED", false, false), false),
        Adoption::Gone("closed")
    );
    assert_eq!(
        adoption(&v("OPEN", false, true), false),
        Adoption::Gone("fork")
    );
    let parsed = v("MERGED", true, false);
    assert_eq!(parsed.merge_commit.as_deref(), Some("abc"));
    assert_eq!(parsed.merged_by.as_deref(), Some("me"));
    assert_eq!(parsed.head_ref_name, BRANCH);
    assert!(pr_view("not json").is_err());
    // Another repo's PR in `pr:`: fresh, not adopted.
    let mut p = spec_waiting(&[("[]", "", 0)]);
    end_attempt(&mut p, true);
    let md = p.w.intent_md(DIR).replace(
        "---\n\n#",
        "pr: https://github.com/other/web/pull/3\n---\n\n#",
    );
    p.w.intents.push_mine(
        &[(&format!("intents/{DIR}/intent.md"), Some(&md))],
        "me: pr",
    );
    p.w.intents.store().list().unwrap();
    p.open_with(Pipe::handlers());
    designs(&p, 2, "| WEB-1 | log in | test_login |\n", &["WEB-1"]);
    p.step(ID);
    p.step(ID);
    assert_eq!(p.data(ID)["adopted"]["state"], "other repo");
    assert!(p.gh.find("pr view").is_empty());
}

/// Attempt 1 blocked at build with `q` (a4: no plan review); PR 7 open, read without comments.
fn asked(q: &str) -> Pipe {
    let mut p = pipe("a: 4\n");
    designs(&p, 1, "| WEB-1 | log in | test_login |\n", &["WEB-1"]);
    p.claude
        .answer(2, &plan())
        .answer(3, &blocked(q))
        .answer(4, &blocked("anything else?"));
    p.gh.on("pr list *", &[("[]", "", 0)])
        .on(
            "pr create *",
            &[("https://github.com/me/web/pull/7\n", "", 0)],
        )
        .on("api -X PATCH *", &[("{}", "", 0)])
        .on("api --paginate *", &[("[]", "", 0)]);
    p.step_to(ID, Stage::Blocked, 6);
    let head = p.mission(ID).head.clone().unwrap();
    p.gh.on(
        "pr view 7 *",
        &[(&json!({"state": "OPEN", "headRefOid": head, "mergeable": "MERGEABLE", "reviews": [], "comments": []}).to_string(), "", 0)],
    );
    p
}

#[test]
fn test_answer_continues() {
    let mut p = asked("which provider?");
    let db = p.w.db();
    commands::queue(
        &db,
        &Cmd::Answer(ID.into(), "Use GitHub, not Google.".into()),
        "ui",
    )
    .unwrap();
    p.until(10, |w| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.2 == "blocked")
            .count()
            >= 2
    });
    // The answer is in the intent, and the worker got it with the wait.
    let md = p.w.intent_md(DIR);
    assert!(md.contains("## Answers\n"), "{md}");
    assert!(md.contains(": Use GitHub, not Google."), "{md}");
    assert!(
        p.w.transitions(ID)
            .contains(&("blocked".into(), "approve".into(), "build".into()))
    );
    let what = p.claude.stdin(4);
    assert!(what.contains("Use GitHub, not Google."), "{what}");
    assert!(what.contains("which provider?"), "{what}");
}

#[test]
fn test_unlock_continues() {
    let mut p = asked("can I change .github/workflows/ci.yml?");
    let db = p.w.db();
    let cmd = Cmd::Unlock(ID.into(), vec![".github/workflows/**".into()]);
    commands::queue(&db, &cmd, "telegram").unwrap();
    p.until(10, |w| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.2 == "blocked")
            .count()
            >= 2
    });
    let md = p.w.intent_md(DIR);
    assert!(
        md.contains("unlock:") && md.contains(".github/workflows/**"),
        "{md}"
    );
    // Refused: a path out of the checkout.
    assert!(!commands::glob_ok("../x") && !commands::glob_ok("/etc/passwd"));
    assert!(commands::glob_ok(".github/workflows/**") && commands::glob_ok("CLAUDE.md"));
}

#[test]
fn test_drop_stops() {
    let mut p = asked("should I go on?");
    let db = p.w.db();
    commands::queue(&db, &Cmd::Drop(ID.into()), "ui").unwrap();
    p.until(10, |w| w.stage(ID) == Some(Stage::Stopped));
    assert!(
        p.intents_file(&format!("intents/{DIR}/intent.md"))
            .is_none(),
        "no longer open"
    );
    let md = p
        .intents_file(&format!("done/{DIR}/intent.md"))
        .expect("moved to done/");
    assert!(md.contains("stage: dropped"), "{md}");
}

#[test]
fn test_env_failure_is_fault() {
    let mut p = pipe("a: 4\n");
    designs(&p, 1, "| WEB-1 | log in | test_login |\n", &["WEB-1"]);
    p.claude.answer(2, &plan()).answer(
        3,
        &blocked("Every Bash call fails: apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted): Permission denied"),
    );
    p.gh.on("pr list *", &[("[]", "", 0)])
        .on(
            "pr create *",
            &[("https://github.com/me/web/pull/7\n", "", 0)],
        )
        .on("api -X PATCH *", &[("{}", "", 0)]);
    p.step_to(ID, Stage::Build, 6);
    for _ in 0..3 {
        if p.claude.calls() >= 3 {
            break;
        }
        p.step(ID);
    }
    let m = p.mission(ID);
    assert_eq!(m.stage, Stage::Build, "not a wait on me");
    assert_eq!(m.waiting, None);
    assert_eq!(m.fault.as_deref(), Some("sandbox"));
    // A missing program in a setup log: tool:<exe>.
    let (f, why) = towercab::env::classify_run("$ npm ci\nsh: 1: npm: not found\n").unwrap();
    assert_eq!(f.to_string(), "tool:npm");
    assert!(why.contains("npm: not found"));
    let (f, _) = towercab::env::classify_run(
        "  = note: /home/me/.local/bin/cc: 12: exec: /home/me/.local/zig-0.16.0/zig: not found",
    )
    .unwrap();
    assert_eq!(f.to_string(), "tool:zig");
    assert!(towercab::env::classify_run("which provider?").is_none());
    assert!(towercab::env::classify_run("src/login.rs: not found in the plan").is_none());
}

#[test]
fn test_open_question_placeholders() {
    use towercab::pipeline::schemas::{DesignResult, no_question};
    for p in ["None.", "none", "- None.", "n/a", "-", "Nothing."] {
        assert!(no_question(p), "{p}");
    }
    assert!(!no_question("Which provider?"));
    let d = |qs: serde_json::Value| {
        DesignResult::from_json(&json!({"type": "feat", "scope": "ui", "breaking": false,
            "spec_ids": [], "concerns": [], "open_questions": qs, "summary": "s"}))
    };
    // `- None.` in the intent: zero or one placeholder entry both pass; both/neither never fail.
    let none = vec!["None.".to_string()];
    d(json!([])).unwrap().check_questions(&none).unwrap();
    d(json!([{"question": "None.", "answer": "n/a", "carried": true}]))
        .unwrap()
        .check_questions(&none)
        .unwrap();
    let real =
        d(json!([{"question": "Which provider?", "answer": null, "carried": false}])).unwrap();
    assert!(real.open_questions[0].carried, "neither: left to me");
    real.check_questions(&["Which provider?".into()]).unwrap();
    assert!(
        d(json!([]))
            .unwrap()
            .check_questions(&["Which provider?".into()])
            .is_err()
    );
}

#[test]
fn test_continue_resets_caps() {
    let mut p = asked("go on?");
    let db = p.w.db();
    db.conn()
        .execute(
            "UPDATE missions SET sync_rounds = 3, verify_repairs = 3, ci_repairs = 2 WHERE intent = ?1",
            [ID],
        )
        .unwrap();
    commands::queue(&db, &Cmd::Approve(ID.into()), "ui").unwrap();
    p.until(10, |w| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.2 == "blocked")
            .count()
            >= 2
    });
    let m = p.mission(ID);
    assert_eq!((m.sync_rounds, m.verify_repairs, m.ci_repairs), (0, 0, 0));
}
