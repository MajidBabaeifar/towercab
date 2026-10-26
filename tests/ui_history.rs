//! UI-23, UI-24: a mission's stage history and the PR of each visit, derived from rows.

use std::path::Path;

use towercab::db::Db;
use towercab::mission::{self, Mission, NewMission};
use towercab::runloop::Tick;
use towercab::ui::Transition;
use towercab::ui::history::{PrState, RunFile, history, intent_prs};

const SPEC: &str = "https://github.com/me/web/pull/5";
const BUILD: &str = "https://github.com/me/web/pull/6";
const REVERT: &str = "https://github.com/me/web/pull/9";

fn db(tmp: &Path) -> Db {
    Db::open(&tmp.join("db.sqlite")).unwrap()
}

/// A mission of `intent` (created at 100) with its columns set by `set` (SQL `SET` list).
fn mk(db: &Db, intent: &str, set: &str) -> Mission {
    let m = mission::insert(
        db.conn(),
        &NewMission {
            intent: intent.into(),
            slug: "login".into(),
            repo: "web".into(),
            model: "opus".into(),
            a: None,
            min_attempt: 1,
        },
        Tick::now(),
    )
    .unwrap();
    db.conn()
        .execute(
            &format!("UPDATE missions SET created = 100, {set} WHERE id = ?1"),
            [m.id],
        )
        .unwrap();
    mission::get(db.conn(), m.id).unwrap()
}

fn t(at: f64, from: &str, event: &str, to: &str, why: Option<&str>) -> Transition {
    Transition {
        mission: 0,
        at,
        from: from.into(),
        event: event.into(),
        to: to.into(),
        why: why.map(Into::into),
    }
}

/// pick → design → plan → build → publish → ci → merge → deploy, each 100 s apart from 200.
fn to_deploy() -> Vec<Transition> {
    let path = [
        "pick", "design", "plan", "build", "publish", "ci", "merge", "deploy",
    ];
    path.windows(2)
        .enumerate()
        .map(|(i, w)| t(200.0 + 100.0 * i as f64, w[0], "ok", w[1], None))
        .collect()
}

#[test]
fn test_stage_history_visits() {
    let tmp = tempfile::tempdir().unwrap();
    let db = db(tmp.path());
    let m = mk(&db, "261025-0901", "stage = 'build'");
    let ts = vec![
        t(200.0, "pick", "ok", "design", None),
        t(300.0, "design", "wait", "approval:spec", Some("a concern")),
        t(400.0, "approval:spec", "approve", "design", None),
        t(500.0, "design", "ok", "plan", None),
        t(650.0, "plan", "ok", "build", None),
    ];
    let v = history(&m, &ts, &[]);
    let stages: Vec<&str> = v.iter().map(|x| x.stage.as_str()).collect();
    assert_eq!(
        stages,
        ["pick", "design", "approval:spec", "design", "plan", "build"]
    );
    // The first stage is entered when the mission was created.
    assert_eq!((v[0].entered, v[0].left), (100.0, Some(200.0)));
    assert_eq!(v[0].secs(1000.0), 100.0);
    // A stage visited twice lists both visits, in order, each with how it ended.
    let designs: Vec<_> = v.iter().filter(|x| x.stage == "design").collect();
    assert_eq!(designs.len(), 2);
    assert_eq!(designs[0].event.as_deref(), Some("wait"));
    assert_eq!(designs[0].why.as_deref(), Some("a concern"));
    assert_eq!(designs[1].event.as_deref(), Some("ok"));
    assert_eq!((designs[1].entered, designs[1].left), (400.0, Some(500.0)));
    assert_eq!(v[4].secs(0.0), 150.0);
    assert!(v.iter().all(|x| x.attempt == m.attempt));
    // The current stage has no end; its time runs to now.
    let last = v.last().unwrap();
    assert_eq!((last.left, last.event.as_deref()), (None, None));
    assert_eq!(last.secs(700.0), 50.0);
    // A stage never reached has no visit.
    assert!(v.iter().all(|x| x.stage != "ci"));
    // No transitions yet: one visit of the mission's stage since it was created.
    let fresh = mk(&db, "261025-0902", "stage = 'pick'");
    let v = history(&fresh, &[], &[]);
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].stage.as_str(), v[0].entered), ("pick", 100.0));
    // Run files of a stage's family go with its visits.
    let files =
        ["build.txt", "build-1.json", "ci-1.log", "other.txt"].map(|n| RunFile { name: n.into() });
    let v = history(&m, &ts, &files);
    let names = |s: &str| -> Vec<String> {
        v.iter()
            .filter(|x| x.stage == s)
            .flat_map(|x| x.files.clone())
            .collect()
    };
    assert_eq!(names("build"), ["build.txt", "build-1.json"]);
    assert!(names("ci").is_empty() && names("pick").is_empty());
}

#[test]
fn test_stage_history_pr() {
    let tmp = tempfile::tempdir().unwrap();
    let db = db(tmp.path());
    let spec = format!(
        r#"{{"spec_pr": {{"pr": 5, "url": "{SPEC}", "merged_at": 250.0, "pushed_at": 150.0}}}}"#
    );
    // Merged: the spec PR (its row fields were cleared at my merge) and the build PR.
    let m = mk(
        &db,
        "261025-0901",
        &format!(
            "stage = 'deploy', pr = 6, pr_url = '{BUILD}', merge_sha = 'abc', \
             merged_by = 'towercab', data = '{spec}'"
        ),
    );
    let v = history(&m, &to_deploy(), &[]);
    let at = |s: &str| v.iter().find(|x| x.stage == s).unwrap();
    let pr = |s: &str| at(s).pr.clone();
    assert!(pr("pick").is_none());
    let design = pr("design").unwrap();
    assert_eq!((design.url.as_str(), design.state), (SPEC, PrState::Merged));
    assert_eq!(design.merged_at, Some(250.0));
    assert!(pr("build").is_none(), "build ended before any build PR");
    let publish = pr("publish").unwrap();
    assert_eq!(
        (publish.url.as_str(), publish.state, publish.merged_at),
        (BUILD, PrState::Merged, Some(800.0)),
        "the merge time is when the mission left merge"
    );
    for s in ["ci", "merge", "deploy"] {
        assert_eq!(pr(s).unwrap().state, PrState::Merged, "{s}");
    }

    // Open while the mission is unfinished and not merged.
    let m = mk(
        &db,
        "261025-0902",
        &format!("stage = 'ci', pr = 6, pr_url = '{BUILD}'"),
    );
    let v = history(&m, &to_deploy()[..5], &[]);
    let p = v.iter().find(|x| x.stage == "publish").unwrap();
    assert_eq!(p.pr.as_ref().unwrap().state, PrState::Open);

    // Closed: finished without a merge.
    let m = mk(
        &db,
        "261025-0903",
        &format!("stage = 'stopped', finished = 900, pr = 6, pr_url = '{BUILD}'"),
    );
    let v = history(&m, &to_deploy()[..5], &[]);
    let p = v.iter().find(|x| x.stage == "ci").unwrap();
    assert_eq!(p.pr.as_ref().unwrap().state, PrState::Closed);

    // A revert mission: its PR is in data.revert; rollback has none.
    let m = mk(
        &db,
        "261025-0904",
        &format!(
            "kind = 'revert', stage = 'revert_ci', \
             data = '{{\"revert\": {{\"pr\": 9, \"url\": \"{REVERT}\"}}}}'"
        ),
    );
    let ts = vec![
        t(200.0, "rollback", "ok", "revert", None),
        t(300.0, "revert", "ok", "revert_ci", None),
    ];
    let v = history(&m, &ts, &[]);
    let at = |s: &str| v.iter().find(|x| x.stage == s).unwrap();
    assert!(at("rollback").pr.is_none());
    let rv = at("revert_ci").pr.clone().unwrap();
    assert_eq!((rv.url.as_str(), rv.state), (REVERT, PrState::Open));

    // Every PR the intent had: per attempt and stage, by attempt.
    let a1 = mk(
        &db,
        "261025-0905",
        &format!("stage = 'stopped', finished = 1, data = '{spec}'"),
    );
    let a2 = mk(
        &db,
        "261025-0905",
        &format!(
            "stage = 'done', finished = 1, pr_url = '{BUILD}', merge_sha = 'abc', pushed_at = 600"
        ),
    );
    let a3 = mk(
        &db,
        "261025-0905",
        &format!(
            "kind = 'revert', stage = 'revert_ci', \
             data = '{{\"revert\": {{\"pr\": 9, \"url\": \"{REVERT}\"}}}}'"
        ),
    );
    assert_eq!((a1.attempt, a2.attempt, a3.attempt), (1, 2, 3));
    let rows = intent_prs(&[(a3, vec![]), (a1, vec![]), (a2, to_deploy())]);
    let got: Vec<_> = rows
        .iter()
        .map(|r| (r.attempt, r.stage.as_str(), r.url.as_str(), r.state))
        .collect();
    assert_eq!(
        got,
        [
            (1, "design", SPEC, PrState::Merged),
            (2, "publish", BUILD, PrState::Merged),
            (3, "revert", REVERT, PrState::Open),
        ]
    );
    assert_eq!(rows[0].merged_at, Some(250.0));
    assert_eq!(rows[1].opened, Some(600.0));
    assert_eq!(rows[1].merged_at, Some(800.0));
}
