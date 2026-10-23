//! Evals (PIP-33): a case per intent `release` brings to `done`; a run replays cases with the
//! build under test (the loop in `Mode::Eval` on a scratch home, never publishing);
//! `towercab/evals` on every Towercab PR head; the noise rule and the 20-case floor.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

use common::pipe::{FakeClaude, GhScript, LOGIN_DIR, LOGIN_ID as ID, Pipe, writes};
use common::{exe, git};
use serde_json::{Value, json};
use towercab::db::Db;
use towercab::handler::Handlers;
use towercab::home::Home;
use towercab::machine::Stage;
use towercab::mission;
use towercab::pipeline::evals::{
    self, CASES, Case, CaseResult, Job, PrInfo, RunResult, Verdict, cheap, compare, trusted,
};

/// A case of intent `id` on `web` at `base`, added at `added`.
fn case(id: &str, base: &str, added: &str, incident: bool) -> Case {
    Case {
        id: id.into(),
        repo: "web".into(),
        base_sha: base.into(),
        intent_md: format!("---\nrepo: web\n---\n\n# Intent: Case {id}\n"),
        spec_ids: vec![],
        model: "opus".into(),
        checks: vec!["sh check.sh".into()],
        merge_sha: "m".into(),
        added: added.into(),
        incident,
    }
}

/// `n` cases on the intent home's `main` (`evals/<id>.json`).
fn cases_files(n: usize) -> Vec<(String, String)> {
    (0..n)
        .map(|i| {
            let id = format!("2610{:02}-0900", i + 1);
            let c = case(
                &id,
                "abc",
                &format!("2026-10-{:02}T09:00:00+02:00", i + 1),
                false,
            );
            (format!("evals/{id}.json"), c.to_json().to_string())
        })
        .collect()
}

/// A result: `pass` ids pass (1 try), `fail` ids fail twice.
fn result(pass: &[String], fail: &[String]) -> RunResult {
    let mut cases = BTreeMap::new();
    for id in pass {
        cases.insert(
            id.clone(),
            CaseResult {
                pass: true,
                tries: 1,
                why: "pass".into(),
            },
        );
    }
    for id in fail {
        cases.insert(
            id.clone(),
            CaseResult {
                pass: false,
                tries: 2,
                why: "ended at blocked".into(),
            },
        );
    }
    RunResult::new("r", cases)
}

fn ids(range: std::ops::Range<usize>) -> Vec<String> {
    range.map(|i| format!("c{i:02}")).collect()
}

/// The status posts so far: (sha, state, description).
fn posts(gh: &GhScript) -> Vec<(String, String, String)> {
    gh.find("api -X POST repos/me/towercab/statuses/")
        .into_iter()
        .map(|n| {
            let a = gh.argv(n);
            let sha = a[3].rsplit('/').next().unwrap().to_string();
            let field = |k: &str| {
                a.iter()
                    .find_map(|x| x.strip_prefix(&format!("{k}=")))
                    .unwrap_or_default()
                    .to_string()
            };
            assert_eq!(field("context"), "towercab/evals");
            (sha, field("state"), field("description"))
        })
        .collect()
}

#[test]
fn test_eval_case_written() {
    let (mut p, merge) = Pipe::merged("# Towercab\n", "towercab");
    p.step_to(ID, Stage::Release, 10);
    // Written again on the way (a re-entry after a crash): one case, one commit.
    let m = p.mission(ID);
    p.cx(|cx| evals::write_case(cx, &m)).unwrap();
    p.cx(|cx| evals::write_case(cx, &m)).unwrap();
    p.step_to(ID, Stage::Done, 4);
    let eval_commits = p
        .intents_log()
        .iter()
        .filter(|l| l.as_str() == format!("towercab: eval {ID}"))
        .count();
    assert_eq!(eval_commits, 1);
    let m = p.mission(ID);
    let text = p
        .intents_file(&format!("evals/{ID}.json"))
        .expect("evals/<id>.json on intents main");
    let c = Case::from_json(&serde_json::from_str::<Value>(&text).unwrap()).unwrap();
    assert_eq!(c.id, ID);
    assert_eq!(c.repo, "web");
    assert_eq!(Some(c.base_sha.clone()), m.base_sha);
    assert_eq!(c.merge_sha, merge);
    assert_eq!(c.model, m.model);
    assert_eq!(c.checks, ["sh check.sh"]);
    assert!(!c.incident);
    assert!(
        chrono::DateTime::parse_from_rfc3339(&c.added).is_ok(),
        "{}",
        c.added
    );
    // intent.md as I wrote it: none of Towercab's fields or notes.
    assert!(
        c.intent_md.contains("# Intent: Add login"),
        "{}",
        c.intent_md
    );
    assert!(
        c.intent_md
            .contains("## Proposed outcome\n\n- I can log in\n")
    );
    for k in ["stage:", "started:", "pr:", "## Towercab"] {
        assert!(!c.intent_md.contains(k), "{k} in {}", c.intent_md);
    }
    assert!(
        p.intents_log().contains(&format!("towercab: eval {ID}")),
        "{:?}",
        p.intents_log()
    );
    // And the case is one a run reads.
    let store = towercab::intents::Store::open(&p.w.config).unwrap();
    store.list().unwrap();
    assert_eq!(evals::cases(&store), vec![c]);
}

#[test]
fn test_eval_replays_case() {
    let p = Pipe::login("a: 4\n");
    p.plans(2).builds_tested(3);
    p.claude.answer(
        4,
        &FakeClaude::result(common::pipe::review(true, json!([]), Value::Null)),
    );
    p.claude.script(
        1,
        &(writes("specs/web.md", "| WEB-1 | log in | test_login |\n")
            + &format!(
                "git rev-parse HEAD > '{root}/design-head'\n[ -e later.txt ] && touch '{root}/design-saw-later'\ntrue\n",
                root = p.w.root.display()
            )),
    );
    let clone = p.w.clone_path("web");
    let base = git(&clone, &["rev-parse", "refs/remotes/origin/main"])
        .trim()
        .to_string();
    // Base moved on since the case: the replay still starts at the case's base.
    p.base("web", &[("later.txt", "later\n")], "later");
    let intent_md =
        p.w.intents
            .remote_file(&format!("intents/{LOGIN_DIR}/intent.md"));
    let c = Case {
        id: ID.into(),
        repo: "web".into(),
        base_sha: base.clone(),
        intent_md: intent_md.replace("---\nrepo: web\n", "---\nrepo: web\nafter: [261001-0800]\n"),
        spec_ids: vec!["WEB-1".into()],
        model: "opus".into(),
        checks: vec!["sh check.sh".into()],
        merge_sha: "m".into(),
        added: "2026-10-01T09:00:00+02:00".into(),
        incident: false,
    };
    let run = p.w.root.join("evals/251023-100000");
    let r = evals::run_cases(
        &p.w.config,
        &p.exes,
        std::slice::from_ref(&c),
        &run,
        Duration::from_millis(10),
    )
    .unwrap();
    assert_eq!(r.run, "251023-100000");
    assert_eq!(
        r.cases[ID],
        CaseResult {
            pass: true,
            tries: 1,
            why: "pass".into()
        },
        "{r:?}"
    );
    assert_eq!((r.passed, r.total, r.rate), (1, 1, 100.0));
    // Design → plan → build → review: the same prompts and handlers, never published.
    assert_eq!(p.claude.calls(), 4);
    assert!(p.gh.calls().is_empty(), "no GitHub: {:?}", p.gh.calls());
    let home = run.join(format!("{ID}-1"));
    let db = Db::open(&home.join("towercab.db")).unwrap();
    let m = mission::for_intent(db.conn(), ID).unwrap().pop().unwrap();
    assert_eq!(m.stage, Stage::Done);
    assert_eq!((m.pr, m.merge_sha.clone()), (None, None));
    assert_eq!(m.base_sha.as_deref(), Some(base.as_str()));
    // The design ran in a checkout at the case's base (the done mission's checkout is gone).
    assert_eq!(
        fs::read_to_string(p.w.root.join("design-head"))
            .unwrap()
            .trim(),
        base
    );
    assert!(!p.w.root.join("design-saw-later").exists());
    // The data the verdict reads.
    let data: Value = serde_json::from_str(&m.data).unwrap();
    assert!(
        data["proof"]["line"]
            .as_str()
            .unwrap()
            .starts_with("red on base")
    );
    // No eval case from an eval; nothing pushed to the real repo or intents.
    let scratch = home.join("intents.git");
    assert!(
        !git(&scratch, &["ls-tree", "-r", "--name-only", "main"]).contains("evals/"),
        "an eval writes no case"
    );
    let origin = p.w.root.join("repos/web.git");
    assert_eq!(
        git(
            &origin,
            &["for-each-ref", "--format=%(refname)", "refs/heads"]
        )
        .trim(),
        "refs/heads/main"
    );
    assert!(p.intents_file(&format!("evals/{ID}.json")).is_none());

    // A failing case runs once more: tries 2, the why of the last.
    let r = evals::run_cases(
        &p.w.config,
        &p.exes,
        std::slice::from_ref(&c),
        &p.w.root.join("evals/r2"),
        Duration::from_millis(10),
    )
    .unwrap();
    assert_eq!(r.cases[ID].tries, 2, "{r:?}");
    assert!(!r.cases[ID].pass);
    assert!(r.cases[ID].why.starts_with("ended at"), "{r:?}");

    // A case whose repo left `[repos]` fails alone: the run goes on.
    let mut gone = c.clone();
    gone.id = "261001-0800".into();
    gone.repo = "api".into();
    let r = evals::run_cases(
        &p.w.config,
        &p.exes,
        &[gone],
        &p.w.root.join("evals/r3"),
        Duration::from_millis(10),
    )
    .unwrap();
    let case = &r.cases["261001-0800"];
    assert!(!case.pass);
    assert!(case.why.starts_with("not set up: "), "{case:?}");
}

/// `gh pr view --json headRefOid,files,isCrossRepository,author,commits` of a PR of mine:
/// opened by `me`, one commit by `me`, from the repo itself.
fn mine_pr(head: &str, path: &str) -> String {
    json!({
        "headRefOid": head,
        "files": [{"path": path}],
        "isCrossRepository": false,
        "author": {"login": "me"},
        "commits": [{"oid": head, "authors": [{"login": "me", "email": "me@localhost"}]}],
    })
    .to_string()
}

/// A `cargo` whose `build` (in a checkout) logs `<pwd> <args>` and makes
/// `target/debug/towercab`: it logs its argv to `<log dir>/inner.argv` and writes a result
/// to `--out`: every case passes but those listed in `<log dir>/fail` (failed twice).
fn fake_cargo(dir: &Path) -> std::path::PathBuf {
    let bin = dir.join("cargo");
    exe(
        &bin,
        &format!(
            r#"d='{d}'
echo "$PWD $*" >> "$d/cargo.log"
[ -f "$d/cargo-fails" ] && echo 'error: could not compile' >&2 && exit 101
mkdir -p target/debug
cat > target/debug/towercab <<'INNER'
#!/bin/sh
d='{d}'
printf '%s\n' "$@" > "$d/inner.argv"
env > "$d/inner.env"
cases='' out=''
while [ $# -gt 0 ]; do
  [ "$1" = --cases ] && cases="$2"
  [ "$1" = --out ] && out="$2"
  shift
done
{{
  printf '{{"run":"x","version":"9","cases":{{'
  sep=''
  for f in "$cases"/*.json; do
    id=$(basename "$f" .json)
    if grep -qx "$id" "$d/fail" 2>/dev/null; then
      printf '%s"%s":{{"pass":false,"tries":2,"why":"red"}}' "$sep" "$id"
    else
      printf '%s"%s":{{"pass":true,"tries":1,"why":"pass"}}' "$sep" "$id"
    fi
    sep=','
  done
  printf '}}}}'
}} > "$out"
INNER
chmod +x target/debug/towercab
"#,
            d = dir.display()
        ),
    );
    bin
}

#[test]
fn test_eval_builds_pr_head() {
    let mut p = Pipe::new(&cases_files(CASES), &["web", "towercab"]);
    // PR 12 of the Towercab repo: a prompt changed.
    let mine = p.w.mine("towercab");
    git(&mine, &["checkout", "--quiet", "-B", "pr12"]);
    common::write(&mine, "prompts/build.md", "Build it better.\n");
    git(&mine, &["add", "-A"]);
    git(&mine, &["commit", "--quiet", "-m", "prompt"]);
    git(
        &mine,
        &["push", "--quiet", "origin", "HEAD:refs/pull/12/head"],
    );
    let head = git(&mine, &["rev-parse", "HEAD"]).trim().to_string();
    git(&mine, &["checkout", "--quiet", "main"]);
    let bin = p.w.root.join("cargobin");
    fs::create_dir_all(&bin).unwrap();
    p.exes.cargo = fake_cargo(&bin).into();
    p.gh.on(
        "pr view 12 -R me/towercab --json headRefOid,files,isCrossRepository,author,commits",
        &[(&mine_pr(&head, "prompts/build.md"), "", 0)],
    )
    .on("api -X POST repos/me/towercab/statuses/*", &[("{}", "", 0)]);
    // The baseline: every case passed.
    let home = Home::resolve(Some(&p.w.root.join("home"))).unwrap();
    let all: Vec<String> = cases_files(CASES)
        .iter()
        .map(|(f, _)| {
            f.trim_start_matches("evals/")
                .trim_end_matches(".json")
                .to_string()
        })
        .collect();
    result(&all, &[])
        .write(&home.root.join("evals/base/result.json"))
        .unwrap();
    Db::open(&home.db())
        .unwrap()
        .set_meta("eval_baseline", "base")
        .unwrap();
    // Three cases that passed there fail twice now: 85% ≤ 100 − 10 → red.
    fs::write(bin.join("fail"), all[..3].join("\n") + "\n").unwrap();
    // My config: a Telegram token and the App, which the inner run never gets.
    fs::write(
        &p.w.config.file,
        "[telegram]\nbot_token = \"t0ken\"\nchat_id = \"1\"\n\n[github]\napp_id = 7\nme = \"me\"\n\n[agent]\nmodel = \"opus\"\n",
    )
    .unwrap();

    let out = evals::pr(&p.w.config, &home, &p.exes, 12).unwrap();
    // The PR head checked out and built with `cargo build --locked`, in the sandbox (network,
    // the evals' cargo cache writable).
    let build = home.root.join("evals/build-12");
    assert_eq!(git(&build, &["rev-parse", "HEAD"]).trim(), head);
    assert_eq!(
        fs::read_to_string(bin.join("cargo.log")).unwrap(),
        format!("{} build --locked\n", build.display())
    );
    let sandbox = p.bwraps().pop().unwrap();
    let cache = home.root.join("evals/cache").display().to_string();
    let b = build.display().to_string();
    let has = |w: &[&str]| sandbox.windows(w.len()).any(|x| x == w);
    assert!(has(&["--bind", &cache, &cache]), "{sandbox:?}");
    assert!(has(&["--bind", &b, &b]) && !sandbox.contains(&"--unshare-net".to_string()));
    assert!(
        sandbox.last().unwrap().ends_with("build --locked"),
        "{sandbox:?}"
    );
    // Its binary ran the cases: a scratch config (no [telegram], no [github]) and home, the
    // cases in a directory, an environment of HOME, PATH, LANG only.
    let argv: Vec<String> = fs::read_to_string(bin.join("inner.argv"))
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    let cases_dir = Path::new(&argv[6]);
    let run = cases_dir.parent().unwrap();
    assert_eq!(
        argv[..5],
        [
            "--config".to_string(),
            run.join("config.toml").display().to_string(),
            "--home".into(),
            run.join("home").display().to_string(),
            "eval".into(),
        ]
    );
    let scratch = fs::read_to_string(run.join("config.toml")).unwrap();
    assert!(
        !scratch.contains("telegram") && !scratch.contains("github") && !scratch.contains("t0ken"),
        "{scratch}"
    );
    assert!(scratch.contains("[agent]"), "{scratch}");
    let env = fs::read_to_string(bin.join("inner.env")).unwrap();
    for l in env.lines() {
        let k = l.split_once('=').map_or(l, |(k, _)| k);
        assert!(
            ["HOME", "PATH", "LANG", "PWD", "OLDPWD", "SHLVL", "_"].contains(&k),
            "{k} leaked: {env}"
        );
    }
    assert_eq!(argv[5], "--cases");
    assert_eq!(argv[7], "--out");
    assert_eq!(fs::read_dir(cases_dir).unwrap().count(), CASES);
    assert_eq!(Path::new(&argv[8]).parent(), cases_dir.parent());
    let ids3 = all[..3].join(", ");
    assert_eq!(
        posts(&p.gh),
        vec![(
            head.clone(),
            "failure".into(),
            format!("dropped 15 points: {ids3}")
        )]
    );
    assert!(out.contains("17/20 (85%)"), "{out}");
    // The run's pass rate (MET-25), 0–1.
    let rates: Vec<(f64, Option<String>)> = towercab::metrics::take()
        .into_iter()
        .filter(|r| r.metric == towercab::metrics::Metric::EvalPassRate)
        .map(|r| (r.value, r.label("kind").map(str::to_string)))
        .collect();
    assert_eq!(rates, [(0.85, Some("pr".to_string()))]);

    // A build that fails posts `error`.
    fs::write(bin.join("cargo-fails"), "").unwrap();
    let e = evals::pr(&p.w.config, &home, &p.exes, 12).unwrap_err();
    assert!(e.starts_with("cargo build failed"), "{e}");
    assert_eq!(
        posts(&p.gh).last().unwrap(),
        &(
            head,
            "error".into(),
            "cargo build failed: error: could not compile".into()
        )
    );
}

#[test]
fn test_eval_status_every_head() {
    let mut p = Pipe::new(&[], &["web", "towercab"]);
    let list = "pr list -R me/towercab --state open --json number,headRefOid";
    let status = |sha: &str| format!("api repos/me/towercab/commits/{sha}/status");
    let files = |n: u64| {
        format!(
            "pr view {n} -R me/towercab --json headRefOid,files,isCrossRepository,author,commits"
        )
    };
    let view = |sha: &str, path: &str| mine_pr(sha, path);
    p.gh.on(
        list,
        &[(
            &json!([{"number": 12, "headRefOid": "h12"}, {"number": 13, "headRefOid": "h13"},
                    {"number": 14, "headRefOid": "h14"}])
            .to_string(),
            "",
            0,
        )],
    )
    .on(
        &status("h12"),
        &[(
            r#"{"statuses":[{"context":"towercab/evals","state":"success"}]}"#,
            "",
            0,
        )],
    )
    .on(
        &status("h13"),
        &[(
            r#"{"statuses":[{"context":"ci","state":"success"}]}"#,
            "",
            0,
        )],
    )
    .on(&status("h13b"), &[(r#"{"statuses":[]}"#, "", 0)])
    .on(&status("h14"), &[(r#"{"statuses":[]}"#, "", 0)])
    .on(&files(13), &[(&view("h13", "src/pick.rs"), "", 0)])
    .on(&files(14), &[(&view("h14", "src/claude.rs"), "", 0)])
    .on("api -X POST repos/me/towercab/statuses/*", &[("{}", "", 0)]);

    // Unaffected → `not affected`; affected with fewer than 20 cases → `0/20 cases`; a head
    // with its status already is left alone. Nothing to run.
    let job = p.cx(|cx| evals::poll(cx, false)).unwrap();
    assert_eq!(job, None);
    assert_eq!(
        posts(&p.gh),
        vec![
            ("h13".into(), "success".into(), "not affected".into()),
            ("h14".into(), "success".into(), "0/20 cases".into()),
        ]
    );

    // A new head on PR 13 gets its own; with 20 cases PR 14 needs a run: an eval child.
    let files20 = cases_files(CASES);
    let pushed: Vec<(&str, Option<&str>)> = files20
        .iter()
        .map(|(r, t)| (r.as_str(), Some(t.as_str())))
        .collect();
    p.w.intents.push_mine(&pushed, "cases");
    p.w.intents.store().list().unwrap();
    p.gh.replace(
        list,
        &[(
            &json!([{"number": 13, "headRefOid": "h13b"}, {"number": 14, "headRefOid": "h14"}])
                .to_string(),
            "",
            0,
        )],
    )
    .replace(&files(13), &[(&view("h13b", "README.md"), "", 0)]);
    let job = p.cx(|cx| evals::poll(cx, false)).unwrap();
    assert_eq!(
        job,
        Some(Job::Pr {
            n: 14,
            head: "h14".into()
        })
    );
    assert_eq!(posts(&p.gh).len(), 3);
    assert_eq!(
        posts(&p.gh)[2],
        ("h13b".into(), "success".into(), "not affected".into())
    );
    p.gh.replace(
        &status("h13b"),
        &[(r#"{"statuses":[{"context":"towercab/evals"}]}"#, "", 0)],
    );

    // The loop runs it as its child (`towercab eval --pr 14`); one that fails posts `error`.
    p.open_with(Handlers::stubs());
    p.until(20, |w| {
        fs::read_to_string(w.home.root.join("evals/eval-pr-14.err")).is_ok_and(|e| !e.is_empty())
    });
    let lp = p.lp.as_mut().unwrap();
    for _ in 0..200 {
        if lp.evaluating().is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
        p.w.pass_after(lp, 1);
    }
    assert_eq!(lp.evaluating(), None);
    let last = posts(&p.gh).pop().unwrap();
    assert_eq!(
        (last.0.as_str(), last.1.as_str()),
        ("h14", "error"),
        "{last:?}"
    );
    assert!(last.2.contains("config"), "{last:?}");
}

#[test]
fn test_eval_noise_rule() {
    let base = result(&ids(0..20), &[]);
    // Two cases that passed fail twice: 90% ≤ 100 − 10 → red, naming them.
    let r = result(&ids(2..20), &ids(0..2));
    assert_eq!(
        compare(&r, Some(&base)),
        Verdict::new("failure", "dropped 10 points: c00, c01")
    );
    // One: 95% → still green.
    let r = result(&ids(1..20), &ids(0..1));
    assert_eq!(
        compare(&r, Some(&base)),
        Verdict::new("success", "95% (baseline 100%)")
    );
    // A drop without a case that passed in the baseline failing (new cases) → green.
    let base17 = result(&ids(0..17), &[]);
    let r = result(&ids(0..17), &ids(17..20));
    assert_eq!(
        compare(&r, Some(&base17)),
        Verdict::new("success", "85% (baseline 100%)")
    );
    // A case that failed once and passed on its rerun is a pass.
    let mut r = result(&ids(0..20), &[]);
    r.cases.get_mut("c00").unwrap().tries = 2;
    assert_eq!(
        compare(&r, Some(&base)),
        Verdict::new("success", "100% (baseline 100%)")
    );
    // No baseline yet.
    assert_eq!(
        compare(&result(&ids(0..20), &[]), None),
        Verdict::new("success", "100% (no baseline)")
    );
    // Descriptions fit GitHub's 140 characters.
    let r = result(&[], &ids(0..20));
    let v = compare(&r, Some(&base));
    assert_eq!(v.state, "failure");
    assert!(v.description.chars().count() <= 140, "{}", v.description);
}

#[test]
fn test_eval_waits_for_20() {
    // Fewer than 20 cases: success `<n>/20 cases`, whatever the run says.
    let base = result(&ids(0..19), &[]);
    let r = result(&[], &ids(0..19));
    assert_eq!(
        compare(&r, Some(&base)),
        Verdict::new("success", "19/20 cases")
    );
    let changed = |f: &str| vec![f.to_string()];
    assert_eq!(
        cheap(&changed("prompts/review.md"), 19),
        Some(Verdict::new("success", "19/20 cases"))
    );
    assert_eq!(
        cheap(&changed("src/claude.rs"), 20),
        None,
        "20 cases: a run"
    );
    assert_eq!(
        cheap(&changed("src/pick.rs"), 0),
        Some(Verdict::new("success", "not affected"))
    );

    // A run takes the newest 20 by `added` plus every incident case.
    let mut files = cases_files(25);
    let mut old = case("260901-0900", "abc", "2026-09-01T09:00:00+02:00", true);
    files.push((format!("evals/{}.json", old.id), old.to_json().to_string()));
    old.id = "260902-0900".into();
    old.incident = false;
    files.push((format!("evals/{}.json", old.id), old.to_json().to_string()));
    let p = Pipe::new(&files, &["web"]);
    let store = p.w.intents.store();
    let picked = evals::cases(&store);
    assert_eq!(picked.len(), 21);
    assert_eq!(picked[0].id, "261025-0900");
    assert!(picked.iter().any(|c| c.id == "260901-0900"));
    assert!(!picked.iter().any(|c| c.id == "260902-0900"));

    // The loop's baseline triggers (weekly, policies, model) run nothing under 20 cases.
    let mut few = p.cx(|cx| evals::poll(cx, true)).unwrap();
    assert!(matches!(few, Some(Job::Baseline { .. })), "{few:?}");
    if let Some(Job::Baseline { reason, model, .. }) = few.take() {
        assert_eq!((reason.as_str(), model.as_str()), ("weekly", "opus"));
    }
    let q = Pipe::new(&cases_files(3), &["web"]);
    assert_eq!(q.cx(|cx| evals::poll(cx, true)).unwrap(), None);
    let db = Db::open(&q.w.home.db()).unwrap();
    assert_eq!(db.meta("eval_model").unwrap().as_deref(), Some("opus"));
    assert_eq!(db.meta("eval_policies").unwrap().as_deref(), Some("none"));
    assert!(db.meta("eval_at").unwrap().is_some());
    // Set: nothing due until a week passes or the model changes.
    assert_eq!(q.cx(|cx| evals::poll(cx, true)).unwrap(), None);
}

#[test]
fn test_eval_builds_only_my_prs() {
    // Who may run as me: a PR from the repo itself, opened by me or the App, every commit
    // theirs.
    let mine = PrInfo {
        head: "h".into(),
        files: vec![],
        cross: false,
        author: "me".into(),
        commits: vec![("h".into(), vec![("me".into(), "me@x".into())])],
    };
    let email = "1+towercab[bot]@users.noreply.github.com";
    let bot = Some(("towercab[bot]", email));
    assert_eq!(trusted(&mine, Some("me"), bot), Ok(()));
    let by_bot = PrInfo {
        author: "app/towercab".into(),
        commits: vec![("h".into(), vec![(String::new(), email.into())])],
        ..mine.clone()
    };
    assert_eq!(trusted(&by_bot, Some("me"), bot), Ok(()));
    assert_eq!(
        trusted(&by_bot, Some("me"), None),
        Err("opened by app/towercab".into())
    );
    let fork = PrInfo {
        cross: true,
        ..mine.clone()
    };
    assert_eq!(trusted(&fork, Some("me"), bot), Err("a fork's PR".into()));
    let stranger = PrInfo {
        author: "eve".into(),
        ..mine.clone()
    };
    assert_eq!(
        trusted(&stranger, Some("me"), bot),
        Err("opened by eve".into())
    );
    let pushed = PrInfo {
        commits: vec![("abcdef123".into(), vec![("eve".into(), "eve@x".into())])],
        ..mine.clone()
    };
    assert_eq!(
        trusted(&pushed, Some("me"), bot),
        Err("commit abcdef1 by eve".into())
    );

    // The loop: a fork's PR that needs a run gets `error` `not evaluated: …`, no eval child.
    let p = Pipe::new(&cases_files(CASES), &["web", "towercab"]);
    let fork = json!({
        "headRefOid": "h15",
        "files": [{"path": "prompts/build.md"}],
        "isCrossRepository": true,
        "author": {"login": "me"},
        "commits": [{"oid": "h15", "authors": [{"login": "me", "email": "me@x"}]}],
    })
    .to_string();
    p.gh.on(
        "pr list -R me/towercab --state open --json number,headRefOid",
        &[(
            &json!([{"number": 15, "headRefOid": "h15"}]).to_string(),
            "",
            0,
        )],
    )
    .on(
        "api repos/me/towercab/commits/h15/status",
        &[(r#"{"statuses":[]}"#, "", 0)],
    )
    .on(
        "pr view 15 -R me/towercab --json headRefOid,files,isCrossRepository,author,commits",
        &[(&fork, "", 0)],
    )
    .on("api -X POST repos/me/towercab/statuses/*", &[("{}", "", 0)]);
    p.w.intents.store().list().unwrap();
    assert_eq!(p.cx(|cx| evals::poll(cx, false)).unwrap(), None);
    assert_eq!(
        posts(&p.gh),
        vec![(
            "h15".into(),
            "error".into(),
            "not evaluated: a fork's PR".into()
        )]
    );
    // By hand too: nothing fetched or built.
    let home = Home::resolve(Some(&p.w.root.join("home"))).unwrap();
    let e = evals::pr(&p.w.config, &home, &p.exes, 15).unwrap_err();
    assert_eq!(e, "not evaluated: a fork's PR");
    assert!(!home.root.join("evals/build-15").exists());
}
