//! Revert missions (PIP-19), the triage of e2e red after my merge (PIP-20) and the rollback
//! rehearsal (PIP-35).

mod common;

use std::fs;

use common::pipe::{
    CI_VIEW, E2E_LINE, FakeClaude, LOGIN_DIR, LOGIN_ID as ID, MERGE_VIEW, Pipe, check,
};
use serde_json::{Value, json};
use towercab::handler::Handler;
use towercab::machine::{Door, Stage};
use towercab::mission::Mission;
use towercab::pipeline::Mode;
use towercab::pipeline::revert::{Revert, revert_branch};
use towercab::pipeline::schemas::{RedLine, TriageResult};
use towercab::pipeline::triage::decide;

fn live() -> String {
    format!("```live\ndeploy: env:staging\ne2e: {E2E_LINE}\n```\n")
}

/// `live` and a ` ```rollback ` block: `rollback.sh <sha>`, `rehearse.sh <sha>`.
fn with_rollback() -> String {
    format!(
        "{}\n```rollback\ncommand: sh '{{root}}/rollback.sh' <sha>\nrehearse: sh '{{root}}/rehearse.sh' <sha>\n```\n",
        live()
    )
}

/// `<root>/<name>.sh`: appends `$1` to `<name>.args`, exits `<name>.exit` (none: 0).
fn command_script(p: &Pipe, name: &str) {
    let d = p.w.root.display();
    fs::write(
        p.w.root.join(format!("{name}.sh")),
        format!(
            r#"d='{d}'
echo "$1" >> "$d/{name}.args"
code=$(cat "$d/{name}.exit" 2>/dev/null || echo 0)
[ "$code" = 0 ] || echo "{name} refused" >&2
exit "$code"
"#
        ),
    )
    .unwrap();
}

fn transitions(p: &Pipe) -> Vec<String> {
    p.w.transitions(ID)
        .into_iter()
        .map(|(f, e, t)| format!("{f} {e} {t}"))
        .collect()
}

fn origin(p: &Pipe) -> std::path::PathBuf {
    p.w.root.join("repos/web.git")
}

fn origin_rev(p: &Pipe, rev: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", rev])
        .current_dir(origin(p))
        .output()
        .unwrap();
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Towercab merged; staging shows the merge; e2e red twice → at `revert` (no rollback block).
fn at_revert(towercab: &str, two_parents: bool) -> (Pipe, String) {
    let (mut p, merge) = Pipe::merged_with(towercab, "towercab", two_parents);
    p.deploys("staging", 1, &merge, "ahead");
    p.e2e_exits(&[1, 1]);
    p.gh.replace(
        "pr create *",
        &[("https://github.com/me/web/pull/8\n", "", 0)],
    );
    p.step_to(ID, Stage::Rollback, 6);
    (p, merge)
}

/// The revert PR's CI green on any head.
fn revert_ci_green(p: &Pipe) {
    let rollup = json!({"headRefOid": "", "mergeable": "MERGEABLE",
        "statusCheckRollup": [serde_json::from_str::<Value>(&check("test", "COMPLETED", "SUCCESS", 21)).unwrap()]});
    p.gh.on(CI_VIEW, &[(&rollup.to_string(), "", 0)]);
}

/// GitHub's squash merge of the revert branch: its head pushed to `main`; the merge view says
/// so after a `CLEAN` read.
fn merge_revert(p: &Pipe, branch: &str) -> String {
    let head = origin_rev(p, &format!("refs/heads/{branch}")).unwrap();
    common::git(&origin(p), &["update-ref", "refs/heads/main", &head]);
    common::git(&p.w.clone_path("web"), &["fetch", "--quiet", "origin"]);
    let clean = json!({"headRefOid": head, "mergeStateStatus": "CLEAN", "mergedAt": null, "mergeCommit": null});
    let merged = json!({"headRefOid": head, "mergeStateStatus": "UNKNOWN",
        "mergedAt": "2026-10-22T12:00:00Z", "mergeCommit": {"oid": head}});
    p.gh.on(
        MERGE_VIEW,
        &[(&clean.to_string(), "", 0), (&merged.to_string(), "", 0)],
    );
    p.gh.on("pr merge *", &[("", "", 0)]);
    head
}

#[test]
fn test_revert_flow() {
    let (mut p, merge) = at_revert(&live(), false);
    assert_eq!(p.mission(ID).kind, towercab::mission::Kind::Revert);
    assert_eq!(p.step(ID), "261001-0900: rollback → revert");
    assert_eq!(p.step(ID), "261001-0900: revert → revert_ci");
    let branch = format!("towercab/revert-{}", &merge[..7]);
    let m = p.mission(ID);
    assert_eq!(m.revert_branch.as_deref(), Some(branch.as_str()));
    // The revert commit, as the bot, on its branch from main.
    let log = p.origin_log("web", &branch);
    assert_eq!(log[0].0, "Revert \"feat(auth): Add login (#7)\"");
    assert_eq!(log[0].1, "Towercab");
    assert_eq!(p.origin_file("web", &branch, "src/lib.rs"), "// code\n");
    assert!(origin_rev(&p, &format!("refs/heads/{branch}:src/login.rs")).is_none());
    // Its PR: `revert: <title>`, the body says why with the e2e log.
    let n = p.gh.find("pr create")[0];
    let argv = p.gh.argv(n);
    let at = |f: &str| argv[argv.iter().position(|a| a == f).unwrap() + 1].clone();
    assert_eq!(at("--title"), "revert: feat(auth): Add login");
    assert_eq!(at("--head"), branch);
    assert!(!argv.contains(&"--draft".to_string()));
    let body = p.gh.body(n).unwrap();
    assert!(
        body.starts_with("Reverts #7 (feat(auth): Add login): e2e red twice after the merge.\n"),
        "{body}"
    );
    assert!(body.contains("e2e run 2 failed"));
    let rv = p.datum(ID, "revert");
    assert_eq!(rv["pr"], json!(8));
    // CI (no repairs), the merge (no gate or review), its deploy, its e2e.
    revert_ci_green(&p);
    assert_eq!(p.step(ID), "261001-0900: revert_ci → revert_merge");
    let head = merge_revert(&p, &branch);
    assert_eq!(p.step(ID), "261001-0900: revert_merge → revert_deploy");
    let n = p.gh.find("pr merge")[0];
    assert_eq!(
        p.gh.argv(n),
        [
            "pr",
            "merge",
            "8",
            "-R",
            "me/web",
            "--squash",
            "--match-head-commit",
            &head,
            "--subject",
            "revert: feat(auth): Add login (#8)",
            "--body",
            &format!("Towercab-Gate: revert sha={head}"),
        ]
    );
    assert_eq!(p.datum(ID, "revert")["merge_sha"], json!(head));
    p.deploys("staging", 2, &head, "identical");
    assert_eq!(p.step(ID), "261001-0900: revert_deploy → revert_e2e");
    assert_eq!(
        p.step(ID),
        "261001-0900: revert_e2e → blocked · reverted, refine"
    );
    assert_eq!(p.root_file("e2e-3.head").trim(), head, "e2e of the revert");
    // My note: the e2e log and the revert PR; the repo capped at 3; no new intent.
    let md = p.w.intent_md(LOGIN_DIR);
    assert!(md.contains("waiting: reverted, refine"), "{md}");
    assert!(md.contains("## Towercab"));
    assert!(md.contains("https://github.com/me/web/pull/8"));
    assert!(md.contains("e2e run 2 failed"));
    let capped: i64 =
        p.w.db()
            .conn()
            .query_row("SELECT capped FROM repo_caps WHERE repo = 'web'", [], |r| {
                r.get(0)
            })
            .unwrap();
    assert_eq!(capped, 1);
    assert_eq!(p.w.intents.store().scan().open.len(), 1);
    assert_eq!(
        transitions(&p)
            .into_iter()
            .skip_while(|t| !t.starts_with("e2e red"))
            .collect::<Vec<_>>(),
        [
            "e2e red rollback",
            "rollback ok revert",
            "revert ok revert_ci",
            "revert_ci ok revert_merge",
            "revert_merge ok revert_deploy",
            "revert_deploy ok revert_e2e",
            "revert_e2e blocked blocked",
        ]
    );
}

#[test]
fn test_revert_branch_per_sha() {
    assert_eq!(revert_branch("0123456789abcdef"), "towercab/revert-0123456");
    let (mut p, merge) = at_revert(&live(), false);
    p.step_to(ID, Stage::RevertCi, 3);
    let branch = revert_branch(&merge);
    let first = origin_rev(&p, &format!("refs/heads/{branch}")).unwrap();
    // The step again (a crash after the push): the branch on origin is reused for this sha,
    // its open PR too; nothing reverted twice, no second PR.
    p.gh.replace(
        "pr list *",
        &[(
            r#"[{"number":8,"url":"https://github.com/me/web/pull/8","headRefOid":""}]"#,
            "",
            0,
        )],
    );
    p.w.db()
        .conn()
        .execute("UPDATE missions SET step = ''", [])
        .unwrap();
    let m: Mission = p.mission(ID);
    let out = p.cx(|cx| Revert::new(Mode::Live).step(cx, &m).unwrap());
    assert!(
        matches!(out, towercab::handler::Progress::Done(ref o) if o.event == towercab::machine::Event::Ok),
        "{out:?}"
    );
    assert_eq!(
        origin_rev(&p, &format!("refs/heads/{branch}")).unwrap(),
        first
    );
    assert_eq!(
        p.origin_log("web", &branch)
            .iter()
            .filter(|(s, _)| s.starts_with("Revert"))
            .count(),
        1
    );
    assert_eq!(p.gh.find("pr create").len(), 1);
}

#[test]
fn test_revert_two_parent_merge() {
    let (mut p, merge) = at_revert(&live(), true);
    assert_eq!(
        common::git(&origin(&p), &["rev-list", "--parents", "-n", "1", &merge])
            .split_whitespace()
            .count(),
        3,
        "a two-parent merge"
    );
    p.step_to(ID, Stage::RevertCi, 3);
    let branch = revert_branch(&merge);
    // `-m 1`: back to the first parent's tree.
    assert_eq!(
        origin_rev(&p, &format!("refs/heads/{branch}^{{tree}}")),
        origin_rev(&p, &format!("{merge}^1^{{tree}}"))
    );
    let msg = common::git(&origin(&p), &["log", "-1", "--format=%B", &branch]);
    assert!(
        msg.contains(&format!("This reverts commit {merge}, reversing")),
        "{msg}"
    );
}

#[test]
fn test_revert_failure_freezes() {
    let (mut p, merge) = at_revert(&live(), false);
    // main changed the same line after the merge: the revert conflicts.
    p.base(
        "web",
        &[("src/login.rs", "pub fn login() { todo!() }\n")],
        "later",
    );
    assert_eq!(p.step(ID), "261001-0900: rollback → revert");
    assert_eq!(p.step(ID), "261001-0900: revert → blocked · revert failed");
    let m = p.mission(ID);
    assert_eq!(
        m.why.as_deref(),
        Some(format!("revert conflict on {}: src/login.rs", revert_branch(&merge)).as_str())
    );
    assert!(p.gh.find("pr create").is_empty());
    let (frozen, capped): (i64, i64) =
        p.w.db()
            .conn()
            .query_row(
                "SELECT frozen, capped FROM repo_caps WHERE repo = 'web'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
    assert_eq!((frozen, capped), (1, 0));
    assert!(
        p.w.outbox()
            .iter()
            .any(|o| o.0 == "repo:web" && o.3.starts_with("repo frozen: web"))
    );
    assert!(
        p.w.outbox()
            .iter()
            .any(|o| o.3.starts_with("revert failed"))
    );
    // CI red after its one rerun: revert failed too, no repair.
    let (mut p, _) = at_revert(&live(), false);
    p.step_to(ID, Stage::RevertCi, 3);
    let red = json!({"headRefOid": "", "mergeable": "MERGEABLE",
        "statusCheckRollup": [serde_json::from_str::<Value>(&check("test", "COMPLETED", "FAILURE", 31)).unwrap()]});
    p.gh.on(CI_VIEW, &[(&red.to_string(), "", 0)])
        .on("run rerun *", &[("", "", 0)]);
    assert_eq!(p.step(ID), "261001-0900: revert_ci → revert_ci");
    assert_eq!(p.gh.find("run rerun 31 --failed").len(), 1);
    assert_eq!(
        p.step(ID),
        "261001-0900: revert_ci → blocked · revert failed"
    );
    assert_eq!(p.mission(ID).ci_repairs, 0);
    assert!(p.gh.find("run view").is_empty());
}

#[test]
fn test_revert_never_reverted() {
    let (mut p, _) = at_revert(&live(), false);
    p.step_to(ID, Stage::RevertCi, 3);
    revert_ci_green(&p);
    p.step(ID);
    let branch = p.mission(ID).revert_branch.unwrap();
    let head = merge_revert(&p, &branch);
    p.step(ID);
    p.deploys("staging", 2, &head, "ahead");
    p.e2e_exits(&[1, 1, 1, 1]);
    assert_eq!(p.step(ID), "261001-0900: revert_deploy → revert_e2e");
    assert_eq!(p.step(ID), "261001-0900: revert_e2e → revert_e2e");
    // Red twice after the revert: revert failed (frozen), never a revert of the revert.
    assert_eq!(
        p.step(ID),
        "261001-0900: revert_e2e → blocked · revert failed"
    );
    assert_eq!(p.e2e_runs(), 4);
    assert_eq!(
        transitions(&p)
            .iter()
            .filter(|t| t.ends_with(" rollback"))
            .count(),
        1
    );
    let frozen: i64 =
        p.w.db()
            .conn()
            .query_row("SELECT frozen FROM repo_caps WHERE repo = 'web'", [], |r| {
                r.get(0)
            })
            .unwrap();
    assert_eq!(frozen, 1);
}

#[test]
fn test_rollback_command_first() {
    let (mut p, merge) = at_revert(&with_rollback(), false);
    command_script(&p, "rollback");
    let parent = origin_rev(&p, &format!("{merge}^1")).unwrap();
    // The command restores the merge's parent; the deploy still has the merge: wait.
    assert_eq!(p.step(ID), "261001-0900: rollback → rollback");
    assert_eq!(p.root_file("rollback.args"), format!("{parent}\n"));
    assert!(p.runs(ID).join("rollback-1.log").exists());
    assert!(
        origin_rev(&p, &format!("refs/heads/{}", revert_branch(&merge))).is_none(),
        "the revert comes after"
    );
    // The deploy is behind the merge: rolled back; the revert follows.
    p.deploys("staging", 3, &parent, "behind");
    assert_eq!(p.step(ID), "261001-0900: rollback → revert");
    assert_eq!(p.datum(ID, "rollback")["sha"], json!(parent));
    assert_eq!(p.step(ID), "261001-0900: revert → revert_ci");

    // A failing rollback command doesn't stop the revert.
    let (mut p, _) = at_revert(&with_rollback(), false);
    command_script(&p, "rollback");
    fs::write(p.w.root.join("rollback.exit"), "1").unwrap();
    assert_eq!(p.step(ID), "261001-0900: rollback → revert");
    let why: String =
        p.w.db()
            .conn()
            .query_row(
                "SELECT why FROM transitions WHERE from_stage = 'rollback'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(why, "rollback command failed: rollback refused");
}

/// Towercab didn't merge (I did); staging shows it; REVIEW.md has red lines; e2e red twice →
/// the triage (Claude call 1) answers `triage`.
fn triaged(triage: Value) -> Pipe {
    let (mut p, merge) = Pipe::merged(&live(), "human");
    p.base(
        "web",
        &[(
            "REVIEW.md",
            "# Review\n\n## Red lines\n\n- `src/login.rs`: auth\n- billing\n",
        )],
        "review",
    );
    p.deploys("staging", 1, &merge, "ahead");
    p.e2e_exits(&[1, 1]);
    p.claude.answer(1, &FakeClaude::result(triage));
    p.step_to(ID, Stage::E2e, 2);
    p.step(ID);
    p.step(ID);
    p
}

fn triage(door: &str, red_lines: &[(&str, &str)]) -> Value {
    json!({"door": door,
           "red_lines": red_lines.iter().map(|(l, f)| json!({"line": l, "file": f})).collect::<Vec<_>>(),
           "why": "The login change broke the session cookie."})
}

#[test]
fn test_triage_table() {
    let t = |door: Door, lines: usize| TriageResult {
        door,
        red_lines: (0..lines)
            .map(|_| RedLine {
                line: "auth".into(),
                file: "src/login.rs".into(),
            })
            .collect(),
        why: String::new(),
    };
    assert_eq!(decide(&t(Door::TwoWay, 1)), None, "revert");
    assert_eq!(decide(&t(Door::TwoWay, 0)), Some(Door::TwoWay));
    assert_eq!(decide(&t(Door::OneWay, 1)), Some(Door::OneWay));
    assert_eq!(decide(&t(Door::OneWay, 0)), Some(Door::OneWay));

    // Two-way with a red line touched: the revert.
    let p = triaged(triage(
        "two-way",
        &[("`src/login.rs`: auth", "src/login.rs")],
    ));
    assert_eq!(p.w.stage(ID), Some(Stage::Rollback));
    // One fresh read-only run on the review model with the diff, the log and the red lines.
    assert_eq!(p.claude.calls(), 1);
    assert_eq!(
        p.claude.flag(1, "--tools").as_deref(),
        Some("Read,Grep,Glob,Bash,Skill")
    );
    assert!(p.claude.flag(1, "--session-id").is_some());
    let merge = p.mission(ID).merge_sha.unwrap();
    let stdin = p.claude.stdin(1);
    assert!(
        stdin.contains(&format!("git diff {merge}^1 {merge}")),
        "{stdin}"
    );
    assert!(stdin.contains("e2e run 2 failed"));
    assert!(stdin.contains("- billing"));
    assert!(p.runs(ID).join("triage-1.prompt").exists());

    // Otherwise no revert: `e2e red after your merge (<door>)`, reason and log in intent.md.
    let p = triaged(triage("one-way", &[("billing", "src/pay.rs")]));
    let m = p.mission(ID);
    assert_eq!(
        m.waiting.as_deref(),
        Some("e2e red after your merge (one-way)")
    );
    assert_eq!(
        m.why.as_deref(),
        Some("The login change broke the session cookie.")
    );
    let md = p.w.intent_md(LOGIN_DIR);
    assert!(md.contains("Door: one-way"), "{md}");
    assert!(md.contains("e2e run 2 failed"));
    assert!(md.contains("`approve 261001-0900` keeps it"));
    assert!(p.w.outbox().iter().any(|o| o.3.starts_with(
        "e2e red after your merge (one-way): approve 261001-0900 to keep it, or retry --fresh 261001-0900 to fix forward"
    )));
    assert!(!transitions(&p).iter().any(|t| t.contains("rollback")));
}

#[test]
fn test_triage_failure_no_revert() {
    // Invalid JSON: no revert, door unknown.
    let p = triaged(json!({"door": "sideways"}));
    let m = p.mission(ID);
    assert_eq!(
        m.waiting.as_deref(),
        Some("e2e red after your merge (unknown)")
    );
    assert!(
        m.why
            .as_deref()
            .unwrap()
            .starts_with("triage: invalid result")
    );
    assert!(!transitions(&p).iter().any(|t| t.contains("rollback")));
    // A failed run: the same.
    let (mut p, merge) = Pipe::merged(&live(), "human");
    p.deploys("staging", 1, &merge, "ahead");
    p.e2e_exits(&[1, 1]);
    p.claude.exit(1, 1).stderr(1, "boom");
    p.step_to(ID, Stage::E2e, 2);
    p.step(ID);
    p.step(ID);
    assert_eq!(
        p.mission(ID).waiting.as_deref(),
        Some("e2e red after your merge (unknown)")
    );
}

/// A world without intents whose `web` is live with a rollback block; `api` isn't live. gh:
/// PR 9 for the rehearsal, CI `ci` (a check JSON), closes taken.
fn rehearsal_world(ci: &str) -> Pipe {
    let mut p = Pipe::new(&[], &["web", "api"]);
    let root = p.w.root.display().to_string();
    p.base(
        "web",
        &[("TOWERCAB.md", &with_rollback().replace("{root}", &root))],
        "live",
    );
    command_script(&p, "rehearse");
    let rollup = json!({"headRefOid": "", "mergeable": "MERGEABLE",
        "statusCheckRollup": [serde_json::from_str::<Value>(ci).unwrap()]});
    p.gh.on("pr list *", &[("[]", "", 0)])
        .on(
            "pr create *",
            &[("https://github.com/me/web/pull/9\n", "", 0)],
        )
        .on(CI_VIEW, &[(&rollup.to_string(), "", 0)])
        .on("pr close *", &[("", "", 0)])
        .on("run rerun *", &[("", "", 0)]);
    p.lp();
    p
}

fn rehearsals(p: &Pipe) -> Vec<Mission> {
    let db = p.w.db();
    let mut q = db
        .conn()
        .prepare("SELECT * FROM missions WHERE kind = 'rehearsal' ORDER BY id")
        .unwrap();
    q.query_map([], Mission::from_row)
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn test_rehearsal_never_merges() {
    let mut p = rehearsal_world(&check("test", "COMPLETED", "SUCCESS", 41));
    let head = origin_rev(&p, "refs/heads/main").unwrap();
    let parent = origin_rev(&p, "refs/heads/main^1").unwrap();
    p.until(30, |w| {
        w.db()
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM missions WHERE kind = 'rehearsal' AND stage = 'done'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            == 1
    });
    let r = rehearsals(&p);
    assert_eq!(r.len(), 1);
    let m = &r[0];
    assert_eq!((m.repo.as_str(), m.intent.as_deref()), ("web", None));
    assert_eq!(m.checkout, "work/rehearse-web-261015");
    let branch = "towercab/rehearse-261015";
    assert_eq!(m.branch.as_deref(), Some(branch));
    // A revert of main's head on its branch, a draft PR, CI, the rehearse command; closed.
    let log = p.origin_log("web", branch);
    assert!(log[0].0.starts_with("Revert \"live\""), "{log:?}");
    assert_eq!(
        origin_rev(&p, &format!("refs/heads/{branch}^1")),
        Some(head)
    );
    let n = p.gh.find("pr create")[0];
    assert!(p.gh.argv(n).contains(&"--draft".to_string()));
    assert_eq!(p.root_file("rehearse.args"), format!("{parent}\n"));
    assert_eq!(p.gh.find("pr close 9 -R me/web --delete-branch").len(), 1);
    assert!(p.gh.find("pr merge").is_empty(), "never merged");
    let stages: Vec<String> = p
        .w
        .db()
        .conn()
        .prepare("SELECT from_stage || ' ' || event || ' ' || to_stage FROM transitions WHERE mission = ?1 ORDER BY id")
        .unwrap()
        .query_map([m.id], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        stages,
        [
            "rehearse ok rehearse_ci",
            "rehearse_ci ok rehearse_close",
            "rehearse_close ok done"
        ]
    );
    // Weekly: no second one now; never for a repo without live.
    for _ in 0..80 {
        let lp = p.lp.as_mut().unwrap();
        p.w.pass(lp);
    }
    assert_eq!(rehearsals(&p).len(), 1);
    assert!(p.w.outbox().iter().all(|o| o.1 != "rehearsal_failed"));
}

#[test]
fn test_rehearsal_failure_messages() {
    // The rehearse command fails: closed all the same, and a message.
    let mut p = rehearsal_world(&check("test", "COMPLETED", "SUCCESS", 41));
    fs::write(p.w.root.join("rehearse.exit"), "1").unwrap();
    let done = |w: &common::world::World| {
        w.db()
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM missions WHERE kind = 'rehearsal' AND stage = 'done'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            == 1
    };
    p.until(30, done);
    let msg =
        p.w.outbox()
            .into_iter()
            .find(|o| o.1 == "rehearsal_failed")
            .expect("a message");
    assert_eq!(msg.0, "repo:web");
    assert!(
        msg.3.starts_with("rollback rehearsal failed: web"),
        "{}",
        msg.3
    );
    assert!(msg.3.contains("rehearse command: rehearse refused"));
    assert!(msg.3.contains("PR https://github.com/me/web/pull/9"));
    assert_eq!(p.gh.find("pr close 9").len(), 1);

    // CI red: no rerun for a rehearsal, red at once.
    let mut p = rehearsal_world(&check("test", "COMPLETED", "FAILURE", 51));
    p.until(30, done);
    assert!(p.gh.find("run rerun").is_empty());
    assert!(
        p.w.outbox()
            .iter()
            .any(|o| o.1 == "rehearsal_failed" && o.3.contains("rehearsal CI"))
    );
    assert_eq!(p.gh.find("pr close 9").len(), 1);
}
