//! The guard and the test lock (PIP-29, PIP-31): the worker's `PreToolUse` hook and its
//! `denyWrite`, publish's refusals, `unlock`.

mod common;

use std::cell::Cell;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;

use common::pipe::{FakeClaude, LOGIN_BRANCH, LOGIN_ID as ID, LOGIN_TEST, Pipe, done, writes};
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};
use towercab::autonomy::{self, Ci, Gate, GateIn, Hold, PrKind, Review};
use towercab::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError, update};
use towercab::machine::Door;
use towercab::machine::Stage;
use towercab::mission::Mission;
use towercab::pipeline::data::Data;
use towercab::pipeline::guard::{self, Rules};
use towercab::pipeline::{Round, files, publish};

/// The login world (a4, `unlock: [docs/**]`) whose base protects `deploy/**` and `docs/**`.
fn guarded() -> Pipe {
    let p = Pipe::login("a: 4\nunlock: [\"docs/**\"]\n");
    p.base(
        "web",
        &[
            (
                "TOWERCAB.md",
                "---\nprotected: [\"deploy/**\", \"docs/**\"]\n---\n",
            ),
            ("deploy/run.sh", "echo deploy\n"),
            ("docs/guide.md", "# Guide\n"),
            (".github/workflows/ci.yml", "on: push\n"),
        ],
        "protected paths",
    );
    p.plans(2);
    p
}

/// The hook's input for `tool` on `path`.
fn input(tool: &str, path: &str) -> String {
    let key = if tool == "NotebookEdit" {
        "notebook_path"
    } else {
        "file_path"
    };
    json!({"tool_name": tool, "tool_input": {key: path, "content": "x"}}).to_string()
}

fn settings(p: &Pipe) -> Value {
    serde_json::from_str(&fs::read_to_string(p.runs(ID).join("settings-worker.json")).unwrap())
        .unwrap()
}

fn deny_write(p: &Pipe) -> Vec<String> {
    settings(p)["sandbox"]["filesystem"]["denyWrite"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

fn blocks(p: &Pipe) -> Vec<Value> {
    fs::read_to_string(p.runs(ID).join("guard-blocks.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn test_guard_blocks_protected_write() {
    let mut p = guarded();
    p.builds(3);
    p.step_to(ID, Stage::Verify, 5);
    let checkout = fs::canonicalize(p.checkout(ID)).unwrap();
    let c = checkout.display().to_string();
    let rules_file = p.runs(ID).join("guard.json");
    // The worker run's hook: `'<towercab>' hook guard '<runs>/guard.json'` on every edit.
    let hook = &settings(&p)["hooks"]["PreToolUse"][0];
    assert_eq!(hook["matcher"], "Edit|Write|NotebookEdit");
    let command = hook["hooks"][0]["command"].as_str().unwrap();
    assert!(
        command.ends_with(&format!(" hook guard '{}'", rules_file.display())),
        "{command}"
    );
    // Its rules: the control files + TOWERCAB.md's, the intent's unlock, nothing locked yet.
    let rules = Rules::read(&rules_file).unwrap();
    assert_eq!(fs::canonicalize(&rules.checkout).unwrap(), checkout);
    assert_eq!(
        rules.protected,
        [
            "CLAUDE.md",
            "REVIEW.md",
            "TOWERCAB.md",
            ".github/**",
            ".claude/**",
            ".git/**",
            "deploy/**",
            "docs/**"
        ]
    );
    assert_eq!(rules.unlock, ["docs/**"]);
    assert!(rules.locked.is_empty());
    // Blocked: protected, outside, through `..` or a symlink; allowed: the rest, unlocked docs.
    let protected = |rel: &str| format!("{rel} is protected: changes here go through Majid");
    std::os::unix::fs::symlink("../.github", checkout.join("src/gh")).unwrap();
    for (tool, path, want) in [
        (
            "Write",
            format!("{c}/.github/workflows/ci.yml"),
            Err(protected(".github/workflows/ci.yml")),
        ),
        (
            "Edit",
            format!("{c}/CLAUDE.md"),
            Err(protected("CLAUDE.md")),
        ),
        (
            "Write",
            format!("{c}/deploy/run.sh"),
            Err(protected("deploy/run.sh")),
        ),
        (
            "NotebookEdit",
            format!("{c}/deploy/x.ipynb"),
            Err(protected("deploy/x.ipynb")),
        ),
        (
            "Write",
            ".github/new.yml".into(),
            Err(protected(".github/new.yml")),
        ),
        (
            "Write",
            format!("{c}/src/../.github/x.yml"),
            Err(protected(".github/x.yml")),
        ),
        (
            "Write",
            format!("{c}/src/gh/y.yml"),
            Err(protected(".github/y.yml")),
        ),
        (
            "Write",
            "/etc/passwd".into(),
            Err("/etc/passwd is outside the checkout: changes here go through Majid".into()),
        ),
        (
            "Edit",
            format!("{c}/.git/config"),
            Err(protected(".git/config")),
        ),
        ("Edit", format!("{c}/docs/guide.md"), Ok(())),
        ("Write", format!("{c}/src/new.rs"), Ok(())),
    ] {
        assert_eq!(
            guard::hook(&input(tool, &path), &rules_file),
            want,
            "{tool} {path}"
        );
    }
    // Each block logged for the metrics.
    let logged = blocks(&p);
    assert_eq!(logged.len(), 9);
    assert_eq!(logged[0]["path"], format!("{c}/.github/workflows/ci.yml"));
    assert_eq!(logged[0]["kind"], "protected");
    assert_eq!(logged[0]["reason"], protected(".github/workflows/ci.yml"));
    // Fails closed: no path, no rules.
    assert!(guard::hook("{}", &rules_file).is_err());
    assert!(guard::hook("not json", &rules_file).is_err());
    assert!(
        guard::hook(
            &input("Write", "src/a.rs"),
            Path::new("/nonexistent/guard.json")
        )
        .is_err()
    );
}

#[test]
fn test_sandbox_denies_protected_bash_write() {
    let mut p = guarded();
    p.builds(3);
    p.step_to(ID, Stage::Verify, 5);
    // What Bash could write is denied by the sandbox: each protected path that exists
    // (absolute), never the unlocked docs; and the checkout's .git.
    let c = std::path::absolute(p.checkout(ID))
        .unwrap()
        .display()
        .to_string();
    assert_eq!(
        deny_write(&p),
        [
            format!("{c}/.git"),
            format!("{c}/.github"),
            format!("{c}/CLAUDE.md"),
            format!("{c}/TOWERCAB.md"),
            format!("{c}/deploy"),
        ]
    );
}

#[test]
fn test_publish_refuses_protected_diff() {
    let mut p = guarded();
    // A new protected file (no denyWrite entry can name it) and an unlocked doc.
    p.claude
        .script(
            3,
            &(writes("src/login.rs", "pub fn login() {}\n")
                + &writes("tests/login_test.sh", LOGIN_TEST)
                + &writes(".github/workflows/evil.yml", "on: push\n")
                + &writes("docs/login.md", "# Login\n")),
        )
        .answer(3, &FakeClaude::result(done("Adds login.")));
    p.step_to(ID, Stage::Blocked, 10);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("protected path changed"));
    assert_eq!(
        m.why.as_deref(),
        Some("changed: .github/workflows/evil.yml (protected)")
    );
    // Nothing pushed: origin has only the spec commit.
    let log = p.origin_log("web", LOGIN_BRANCH);
    assert_eq!(
        log.len(),
        4,
        "seed, verifying, protected paths, spec: {log:?}"
    );
    assert_eq!(log[0].0, "docs(specs): Add login");
    assert!(
        p.w.intent_md(common::pipe::LOGIN_DIR)
            .contains("## Towercab\n\nPublish refused: changed: .github/workflows/evil.yml")
    );
}

#[test]
fn test_unlock_goes_to_me() {
    // An intent with `unlock` always goes to me at the gate, even approved at a5.
    let review = Review {
        approved: true,
        door: Door::TwoWay,
        red_lines: false,
    };
    let g = |unlock: bool| {
        autonomy::gate(&GateIn {
            kind: PrKind::Intent,
            frozen: false,
            cap: 5,
            a: Some(5),
            ci: Ci::Green,
            unlock,
            evals_red: false,
            review: Some(review),
        })
    };
    assert_eq!(g(true), Gate::Approval(Hold::Unlock));
    assert_eq!(g(false), Gate::Merge);
    // What it unlocks the guard lets through; the rest of the protected paths stay.
    let rules = Rules {
        checkout: PathBuf::from("/w/c"),
        protected: vec!["CLAUDE.md".into(), "docs/**".into()],
        unlock: vec!["docs/**".into()],
        locked: Vec::new(),
    };
    assert_eq!(guard::decide(&rules, "docs/a.md"), Ok(()));
    assert!(guard::decide(&rules, "CLAUDE.md").is_err());
    // Through the gate handler: approved at a5 with `unlock`, to me.
    let mut p = Pipe::login("a: 5\nunlock: [\"docs/**\"]\n");
    p.plans(2).builds_tested(3).ci_green();
    p.claude.answer(
        4,
        &FakeClaude::result(common::pipe::review(true, json!([]), Value::Null)),
    );
    p.step_to(ID, Stage::Gate, 12);
    assert_eq!(
        p.step(ID),
        "261001-0900: gate → approval:merge · review and merge PR"
    );
    assert_eq!(p.mission(ID).why.as_deref(), Some("unlock used"));
    assert!(p.gh.find("pr merge").is_empty());
}

/// `towercab hook guard <rules>` with `stdin` → (exit code, stderr).
fn hook_cli(args: &[&str], stdin: &str) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_towercab"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn test_guard_hook_cli() {
    let tmp = tempfile::tempdir().unwrap();
    let checkout = tmp.path().join("work/c");
    fs::create_dir_all(checkout.join("src")).unwrap();
    let runs = tmp.path().join("runs");
    fs::create_dir_all(&runs).unwrap();
    let rules = Rules {
        checkout: checkout.clone(),
        protected: vec!["CLAUDE.md".into(), ".github/**".into()],
        unlock: Vec::new(),
        locked: vec!["tests/a_test.rs".into()],
    };
    let file = runs.join("guard.json");
    fs::write(&file, rules.to_json().to_string()).unwrap();
    let f = file.to_str().unwrap();
    let c = checkout.display();
    // Allowed → 0, nothing said.
    assert_eq!(
        hook_cli(
            &["hook", "guard", f],
            &input("Write", &format!("{c}/src/a.rs"))
        ),
        (Some(0), String::new())
    );
    // Blocked → 2, the reason on stderr (Claude Code shows it to the worker).
    assert_eq!(
        hook_cli(
            &["hook", "guard", f],
            &input("Edit", &format!("{c}/CLAUDE.md"))
        ),
        (
            Some(2),
            "CLAUDE.md is protected: changes here go through Majid\n".into()
        )
    );
    let (code, err) = hook_cli(
        &["hook", "guard", f],
        &input("Edit", &format!("{c}/tests/a_test.rs")),
    );
    assert_eq!(code, Some(2));
    assert!(err.contains("locked in repair rounds"), "{err}");
    // Fails closed: bad input, a missing rules file, no rules argument.
    assert_eq!(hook_cli(&["hook", "guard", f], "{").0, Some(2));
    let (code, err) = hook_cli(
        &["hook", "guard", "/nonexistent/guard.json"],
        &input("Write", &format!("{c}/src/a.rs")),
    );
    assert_eq!(code, Some(2));
    assert!(err.starts_with("guard: "), "{err}");
    assert_eq!(hook_cli(&["hook", "guard"], "").0, Some(2));
    assert_eq!(
        fs::read_to_string(runs.join("guard-blocks.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

/// A weaker login test: any `login` in the file.
const WEAKER: &str = "grep -q login src/login.rs\n";

/// CI: red once (as part 3's CI would leave `repair`), then green.
struct RedOnce(Rc<Cell<bool>>);

impl Handler for RedOnce {
    fn step(&mut self, _: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.0.replace(false) {
            let mut data = Data::of(m);
            data.set(
                "repair",
                json!({"what": "CI red: test", "findings": "test failed", "log": ""}),
            );
            return Ok(Progress::Done(
                Outcome::red("CI red").with("data", data.text()),
            ));
        }
        Ok(Progress::Done(Outcome::ok()))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        unreachable!()
    }
}

/// The login world published once, CI red: the build's CI round is next (call 4).
fn ci_red(call4: &str) -> Pipe {
    let mut p = Pipe::login("a: 4\n");
    p.plans(2).builds(3);
    p.claude
        .script(4, call4)
        .answer(4, &FakeClaude::result(done("Fixed CI.")));
    let mut h = Pipe::handlers();
    h.set(Stage::Ci, Box::new(RedOnce(Rc::new(Cell::new(true)))));
    p.open_with(h);
    p.step_to(ID, Stage::Ci, 8);
    assert_eq!(p.step(ID), "261001-0900: ci → build");
    p
}

#[test]
fn test_lock_blocks_test_edit_in_repair() {
    let mut p = ci_red("");
    assert_eq!(p.step(ID), "261001-0900: build → verify");
    let c = std::path::absolute(p.checkout(ID)).unwrap();
    // The CI round's worker run: the pushed test is locked in the guard and the sandbox.
    let rules_file = p.runs(ID).join("guard.json");
    assert_eq!(
        Rules::read(&rules_file).unwrap().locked,
        ["tests/login_test.sh"]
    );
    assert!(deny_write(&p).contains(&format!("{}/tests/login_test.sh", c.display())));
    let test = format!("{}/tests/login_test.sh", c.display());
    let err = guard::hook(&input("Edit", &test), &rules_file).unwrap_err();
    assert_eq!(
        err,
        "tests/login_test.sh is a test already pushed: it is locked in repair rounds; changes here go through Majid"
    );
    assert_eq!(blocks(&p).last().unwrap()["kind"], "test_lock");
    // A new test is fine.
    let new = format!("{}/tests/logout_test.sh", c.display());
    assert_eq!(guard::hook(&input("Write", &new), &rules_file), Ok(()));
    assert!(p.claude.stdin(4).contains("CI red: test:\ntest failed"));
}

#[test]
fn test_publish_refuses_locked_test_change() {
    // The CI repair weakens the pushed test through Bash (still red on base).
    let mut p = ci_red(&writes("tests/login_test.sh", WEAKER));
    let pushed = p.mission(ID).head.unwrap();
    p.step_to(ID, Stage::Blocked, 8);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("protected path changed"));
    assert_eq!(
        m.why.as_deref(),
        Some("changed: tests/login_test.sh (a test already pushed)")
    );
    assert_eq!(m.head.as_deref(), Some(pushed.as_str()), "nothing pushed");
}

#[test]
fn test_feedback_round_unlocked() {
    let mut p = ci_red(&writes("tests/login_test.sh", WEAKER));
    p.step_to(ID, Stage::Blocked, 8);
    let m = p.mission(ID);
    // The same changed test: refused in a CI or verify round, fine in my feedback and conflict
    // rounds (I asked for it, or base moved).
    p.cx(|cx| {
        for (round, refused) in [
            (Round::Ci, true),
            (Round::Verify, true),
            (Round::Feedback, false),
            (Round::Conflict, false),
            (Round::Continue, false),
        ] {
            let repo = files(cx, &m).unwrap();
            let r = publish::check_diff(cx, &m, round, &repo).unwrap();
            assert_eq!(r.is_err(), refused, "{round:?}: {r:?}");
        }
        let repo = files(cx, &m).unwrap();
        let deny = guard::write_rules(cx, &m, &repo, Round::Feedback).unwrap();
        let rules = Rules::read(&cx.runs(&m).join("guard.json")).unwrap();
        assert!(rules.locked.is_empty());
        assert!(!deny.iter().any(|d| d.ends_with("tests/login_test.sh")));
        let deny = guard::write_rules(cx, &m, &repo, Round::Verify).unwrap();
        assert!(deny.iter().any(|d| d.ends_with("tests/login_test.sh")));
    });
}

#[test]
fn test_lock_kept_after_outage_in_repair() {
    // The CI round's worker run fails on the network: a backoff in `build` (build → build),
    // then the same run again; the round is still CI, its tests still locked.
    let mut p = ci_red("");
    p.claude
        .stderr(4, "error: connect ECONNREFUSED: connection refused")
        .exit(4, 1)
        .answer(5, &FakeClaude::result(done("Fixed CI.")));
    p.step(ID);
    let m = p.mission(ID);
    assert_eq!(m.stage, Stage::Build);
    assert!(m.retry_at.is_some(), "backing off");
    let t = p.w.transitions(ID);
    assert_eq!(
        t.last().unwrap(),
        &(
            "build".to_string(),
            "env_fail".to_string(),
            "build".to_string()
        )
    );
    let db = p.w.db();
    update(db.conn(), m.id, &[("retry_at".into(), Sql::Null)]).unwrap();
    assert_eq!(p.step(ID), "261001-0900: build → verify");
    assert_eq!(p.claude.calls(), 5);
    assert_eq!(p.claude.stdin(5).trim(), towercab::claude::CONTINUE);
    let rules = Rules::read(&p.runs(ID).join("guard.json")).unwrap();
    assert_eq!(rules.locked, ["tests/login_test.sh"]);
    assert_eq!(
        towercab::pipeline::round(db.conn(), &p.mission(ID)).unwrap(),
        Round::Ci
    );
}

#[test]
fn test_lock_baseline_after_first_build() {
    // The first build edits a test base already has; verify goes red once. The verify round
    // locks the tests as the first build left them, and publish takes the build's edit.
    let mut p = Pipe::login("a: 4\n");
    p.base("web", &[("tests/old_test.sh", "true\n")], "an old test");
    p.plans(2);
    p.claude
        .script(
            3,
            &(writes("src/login.rs", "pub fn logon() {}\n")
                + &writes("tests/login_test.sh", LOGIN_TEST)
                + &writes("tests/old_test.sh", "true # checked\n")),
        )
        .answer(3, &FakeClaude::result(done("Adds login.")))
        .script(4, &writes("src/login.rs", "pub fn login() {}\n"))
        .answer(4, &FakeClaude::result(done("Fixed login.")));
    p.step_to(ID, Stage::Publish, 12);
    let rules = Rules::read(&p.runs(ID).join("guard.json")).unwrap();
    assert!(
        rules.locked.contains(&"tests/old_test.sh".to_string()),
        "{:?}",
        rules.locked
    );
    assert_eq!(p.step(ID), "261001-0900: publish → ci");
    assert_eq!(
        p.origin_file("web", LOGIN_BRANCH, "tests/old_test.sh"),
        "true # checked\n"
    );
}

#[test]
fn test_guard_blocks_dangling_symlink() {
    // A write through a symlink to nowhere would land wherever it points: blocked.
    let tmp = tempfile::tempdir().unwrap();
    let checkout = tmp.path().join("c");
    fs::create_dir_all(&checkout).unwrap();
    std::os::unix::fs::symlink(tmp.path().join("nowhere/x"), checkout.join("link")).unwrap();
    let rules = Rules {
        checkout: checkout.clone(),
        protected: Vec::new(),
        unlock: Vec::new(),
        locked: Vec::new(),
    };
    let file = tmp.path().join("guard.json");
    fs::write(&file, rules.to_json().to_string()).unwrap();
    let path = format!("{}/link", checkout.display());
    assert_eq!(
        guard::hook(&input("Write", &path), &file),
        Err(format!(
            "{path} goes through a dangling symlink: changes here go through Majid"
        ))
    );
}

#[test]
fn test_repair_round_merges_my_push() {
    // I push onto the PR while CI runs; the CI round's sync merges it in and it conflicts:
    // the worker is told first, resolves it, Towercab concludes the merge.
    let resolve = writes("src/login.rs", "pub fn login() { mine() }\n");
    let mut p = ci_red(&resolve);
    unpushed(&p);
    p.push_mine(
        "web",
        LOGIN_BRANCH,
        &[("src/login.rs", "pub fn login() { mine() }\n")],
        "fix: mine",
    );
    let origin = p.w.root.join("repos/web.git");
    let mine = common::git(&origin, &["rev-parse", LOGIN_BRANCH])
        .trim()
        .to_string();
    assert_eq!(p.step(ID), "261001-0900: build → verify");
    let stdin = p.claude.stdin(4);
    assert!(
        stdin.contains("`git merge` of the branch as it is on GitHub")
            && stdin.contains("Resolve the conflicts in:\nsrc/login.rs\n"),
        "{stdin}"
    );
    assert!(
        stdin.contains("CI red: test"),
        "the round's own text too: {stdin}"
    );
    let c = p.checkout(ID);
    let parents = common::git(&c, &["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert!(parents.contains(&mine), "my push merged in: {parents}");
    // A worker that leaves the markers: concluding would commit them, so it asks me.
    let mut p = ci_red("");
    unpushed(&p);
    p.push_mine(
        "web",
        LOGIN_BRANCH,
        &[("src/login.rs", "pub fn login() { mine() }\n")],
        "fix: mine",
    );
    p.step(ID);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("answer the question"));
    assert_eq!(
        m.why.as_deref(),
        Some("conflict markers left in src/login.rs")
    );
}

/// An earlier round's commit in the checkout, not pushed yet (a verify round's).
fn unpushed(p: &Pipe) {
    let c = p.checkout(ID);
    fs::write(c.join("src/login.rs"), "pub fn login() { ours() }\n").unwrap();
    common::git(&c, &["add", "-A"]);
    common::git(
        &c,
        &[
            "-c",
            "user.name=Towercab",
            "-c",
            "user.email=towercab@localhost",
            "commit",
            "--quiet",
            "-m",
            "fix: address checks red",
        ],
    );
}
