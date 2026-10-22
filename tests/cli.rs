//! The `towercab` binary: `add`, `migrate`, `--version` (INT-2, INT-13, LOOP-15 so far).

mod common;

use std::path::Path;
use std::process::{Command, Output};

use chrono::{DateTime, Local};
use common::Home;
use regex::Regex;

fn towercab(home: &Path, args: &[&str], env: &[(&str, &Path)]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_towercab"));
    cmd.args(args)
        .env("HOME", home)
        .env_remove("TOWERCAB_CONFIG")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[test]
fn test_add_command() {
    let home = Home::new(&[]);
    let user_home = home.tmp.path().join("home");
    std::fs::create_dir_all(&user_home).unwrap();
    let cfg = home.tmp.path().join("config.toml");
    std::fs::write(
        &cfg,
        format!(
            // The Python version's `[repos.<name>]` (no `github`): `add` doesn't read `[repos]`.
            "[intents]\nremote = \"{}\"\npath = \"{}\"\n\n[repos.towercab]\npath = \"src/towercab\"\n\
             base = \"main\"\nverify = [\"make\"]\nbash = [\"ls*\"]\n",
            home.remote.display(),
            home.checkout.display()
        ),
    )
    .unwrap();
    let cfg_s = cfg.to_str().unwrap();

    let before = Local::now();
    let out = towercab(
        &user_home,
        &[
            "--config",
            cfg_s,
            "add",
            "towercab: Ship the thing",
            "u4",
            "i5",
            "a3",
        ],
        &[],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    let c = Regex::new(r"^(\d{6}-\d{4}) intents/(\d{6}-\d{4})-ship-the-thing/intent\.md\n$")
        .unwrap()
        .captures(&stdout)
        .unwrap_or_else(|| panic!("stdout {stdout:?}"));
    assert_eq!(&c[1], &c[2]);
    let file = home.remote_file(&format!("intents/{}-ship-the-thing/intent.md", &c[1]));
    let started = Regex::new(r"(?m)^started: (.+)$")
        .unwrap()
        .captures(&file)
        .unwrap()[1]
        .to_string();
    assert_eq!(
        file,
        format!(
            "---\nrepo: towercab\nu: 4\ni: 5\na: 3\nsource: me\nstarted: {started}\n---\n\n# Intent: Ship the thing\n"
        )
    );
    let started = DateTime::parse_from_rfc3339(&started).unwrap();
    assert!(
        (started.timestamp() - before.timestamp()).abs() < 60,
        "started = now"
    );
    assert_eq!(
        started.offset().local_minus_utc(),
        before.offset().local_minus_utc(),
        "local offset"
    );
    assert_eq!(
        started.format("%y%m%d-%H%M").to_string(),
        c[1],
        "ID = creation minute"
    );
    assert_eq!(home.log()[0], format!("towercab: add {}", &c[1]));

    // TOWERCAB_CONFIG works too; scores are optional.
    let out = towercab(
        &user_home,
        &["add", "towercab:No scores"],
        &[("TOWERCAB_CONFIG", &cfg)],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("-no-scores/intent.md"));

    // Run from a git hook (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE set for another repo):
    // Towercab still writes to its own checkout and leaves the other repo alone.
    let decoy = home.tmp.path().join("decoy");
    std::fs::create_dir_all(&decoy).unwrap();
    common::git(&decoy, &["init", "--quiet", "-b", "main"]);
    let out = towercab(
        &user_home,
        &["--config", cfg_s, "add", "towercab: From a hook"],
        &[
            ("GIT_DIR", &decoy.join(".git")),
            ("GIT_WORK_TREE", &decoy),
            ("GIT_INDEX_FILE", &decoy.join(".git/index")),
        ],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("-from-a-hook/intent.md"));
    assert!(home.log()[0].starts_with("towercab: add "));
    assert!(
        std::process::Command::new("git")
            .args(["rev-parse", "--verify", "-q", "HEAD"])
            .current_dir(&decoy)
            .output()
            .unwrap()
            .stdout
            .is_empty(),
        "nothing committed in the other repo"
    );

    // Bad arguments → exit 2, nothing written.
    let head = home.head();
    for args in [
        vec!["add", "no colon here"],
        vec!["add", ": no repo"],
        vec!["add", "towercab: "],
        vec!["add", "bad repo!: title"],
        vec!["add", "..: title"],
        vec!["add", "--", "-rf: title"],
        vec!["add", "towercab: x", "u6"],
        vec!["add", "towercab: x", "u3", "u4"],
        vec!["add", "towercab: x", "q3"],
        vec!["add", "towercab: x", "u33"],
        vec!["add"],
        vec!["bogus"],
        vec![],
    ] {
        let mut full = vec!["--config", cfg_s];
        full.extend(args.iter());
        let out = towercab(&user_home, &full, &[]);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{args:?}: {}",
            text(&out.stderr)
        );
    }
    assert_eq!(home.head(), head);

    // Errors → stderr `towercab: <reason>`, exit 1.
    let out = towercab(
        &user_home,
        &["--config", "/nonexistent/c.toml", "add", "towercab: x"],
        &[],
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(
        text(&out.stderr).starts_with("towercab: config: /nonexistent/c.toml: "),
        "{}",
        text(&out.stderr)
    );
    let out = towercab(&user_home, &["add", "towercab: x"], &[]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "no config at ~/.config/towercab/config.toml"
    );

    let out = towercab(&user_home, &["--version"], &[]);
    assert!(out.status.success());
    assert_eq!(
        text(&out.stdout),
        format!("towercab {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.3.0");

    // Old format: `add` refuses until `migrate` has run; `migrate` prints its summary.
    home.push_mine(
        &[(
            "TODO.md",
            Some("# TODO\n\n- [ ] 261017-1200 towercab: Old one\n"),
        )],
        "old",
    );
    let out = towercab(
        &user_home,
        &["--config", cfg_s, "add", "towercab: Too early"],
        &[],
    );
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        text(&out.stderr),
        "towercab: TODO.md is in the old format: run towercab migrate\n"
    );
    let out = towercab(&user_home, &["migrate", "--config", cfg_s], &[]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        text(&out.stdout),
        "migrated 1 intents (0 done), 0 lines to done/legacy.md\n"
    );
    assert!(home.remote_has("intents/261017-1200-old-one/intent.md"));
    let out = towercab(
        &user_home,
        &["--config", cfg_s, "add", "towercab: In time"],
        &[],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let out = towercab(&user_home, &["--config", cfg_s, "migrate"], &[]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        text(&out.stderr),
        "towercab: TODO.md is already generated: migrate has run\n"
    );
}

/// The loop's commands from the binary (LOOP-15): stubs, `status`/`next`/`step`/`run
/// --intent` refusals with no pipeline, and `approve`, `retry --fresh`, `release` applied by
/// the CLI itself (no loop running), entry effects included; then `step` and `--intent` with
/// stub handlers.
#[test]
fn test_cli() {
    use common::world::{Act, Scripted, World, intent_file};
    use towercab::db::Db;
    use towercab::handler::Handlers;
    use towercab::machine::{Stage, Waiting};
    use towercab::runloop::LoopOpts;

    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let file = common::loop_config(
        tmp.path(),
        "[repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n",
    );
    let intents = tmp.path().join("intents");
    for (rel, extra, title) in [
        (
            "intents/261001-0900-spec",
            "stage: design\nwaiting: approve spec\n",
            "Spec",
        ),
        (
            "intents/261001-0901-ship",
            "stage: deploy\nwaiting: authorize release\n",
            "Ship",
        ),
        (
            "intents/261001-0902-old",
            "stage: test\nwaiting: CI red\nattempts: 2\n",
            "Old",
        ),
        ("done/261001-0903-gone", "stage: done\n", "Gone"),
        (
            "intents/261001-0904-wait",
            "waiting: \"bad after:\"\n",
            "Wait",
        ),
    ] {
        common::write(
            &intents,
            &format!("{rel}/intent.md"),
            &common::intent_md("web", extra, title),
        );
    }
    common::git(&intents, &["add", "-A"]);
    common::git(&intents, &["commit", "--quiet", "-m", "seed"]);
    let home = towercab::home::Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let db = Db::open(&home.db()).unwrap();
    for (intent, stage, waiting) in [
        ("261001-0900", "approval:spec", "approve spec"),
        ("261001-0901", "approval:release", "authorize release"),
    ] {
        db.conn()
            .execute(
                "INSERT INTO missions (intent, repo, stage, step, model, session, checkout, branch,
                   waiting, from_stage, created, updated)
                 VALUES (?1, 'web', ?2, '', 'opus', 's', ?3, 'b', ?4, 'design', 0, 0)",
                rusqlite::params![intent, stage, format!("work/{intent}-1"), waiting],
            )
            .unwrap();
    }
    let run = |args: &[&str]| {
        let mut full = vec![
            "--config",
            file.to_str().unwrap(),
            "--home",
            home.root.to_str().unwrap(),
        ];
        full.extend_from_slice(args);
        common::output(&mut common::towercab(&user, &full))
    };
    let ok = |s: &str| (format!("{s}\n"), String::new(), Some(0));
    let err = |s: &str, code: i32| (String::new(), format!("towercab: {s}\n"), Some(code));
    let md = |rel: &str| std::fs::read_to_string(intents.join(rel)).unwrap();

    // Stubs until their intents.
    assert_eq!(run(&["telemetry", "on"]), err("not built yet: MET-12", 1));
    assert_eq!(
        run(&["telemetry", "status"]),
        err("not built yet: MET-12", 1)
    );
    assert_eq!(run(&["eval"]), err("not built yet: PIP-33", 1));
    assert_eq!(run(&["hook", "guard"]), err("not built yet: PIP-29", 2));
    assert_eq!(run(&["telemetry", "maybe"]).2, Some(2));
    assert_eq!(
        run(&["--version"]),
        ok(&format!("towercab {}", env!("CARGO_PKG_VERSION")))
    );

    // Commands, applied here (no loop), their entry effects too.
    assert_eq!(run(&["approve", "0900"]), ok("approved 261001-0900"));
    let spec = md("intents/261001-0900-spec/intent.md");
    assert!(
        !spec.contains("waiting:") && spec.contains("stage: build"),
        "{spec}"
    );
    assert_eq!(
        run(&["approve", "0900"]),
        err("approve: 261001-0900 isn't waiting on you", 1)
    );
    assert_eq!(
        run(&["release", "0900"]),
        err("release: 261001-0900 isn't waiting for release", 1)
    );
    assert_eq!(
        run(&["release", "261001-0901"]),
        ok("releasing 261001-0901")
    );
    assert_eq!(
        run(&["retry", "--fresh", "0902"]),
        ok("fresh attempt 3 for 261001-0902")
    );
    let old = md("intents/261001-0902-old/intent.md");
    assert!(
        !old.contains("stage:") && !old.contains("waiting:"),
        "{old}"
    );
    assert_eq!(
        run(&["retry", "--fresh", "0903"]),
        err("retry: 261001-0903 is done", 1)
    );
    assert_eq!(run(&["approve", "0904"]), ok("approved 261001-0904"));
    assert!(!md("intents/261001-0904-wait/intent.md").contains("waiting"));
    assert_eq!(
        run(&["approve", "7777"]),
        err("approve: no open intent matches 7777", 1)
    );
    let stages: Vec<String> = db
        .conn()
        .prepare("SELECT stage FROM missions ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(stages, ["plan", "release"]);

    // No pipeline yet: `step` and `run --intent` refuse.
    assert_eq!(
        run(&["step", "0900"]),
        err("261001-0900: plan handler not built", 1)
    );
    assert_eq!(
        run(&["step", "0904"]),
        err("261001-0904: not picked: picks off: pipeline not built", 1)
    );
    assert_eq!(
        run(&["run", "--intent", "0904"]),
        err("0904: not picked: picks off: pipeline not built", 1)
    );
    assert_eq!(
        run(&["step", "7777"]),
        err("no open intent matches 7777", 1)
    );
    let lock = home.lock().unwrap();
    assert_eq!(
        run(&["step", "0900"]),
        err(
            &format!(
                "towercab is running (pid {}); towercab down first",
                std::process::id()
            ),
            1
        )
    );
    drop(lock);
    let (out, _, code) = run(&["status"]);
    assert_eq!(code, Some(0));
    assert!(
        out.starts_with(&format!(
            "towercab {} · not running\nactive: none\n",
            env!("CARGO_PKG_VERSION")
        )) && !out.contains("waiting on you"),
        "{out}"
    );
    let (out, _, code) = run(&["next"]);
    assert_eq!(
        (out.lines().next(), code),
        (Some("next: nothing runnable"), Some(0))
    );

    // `step` with stub handlers: X is picked first though parked and after Y, one step at a
    // time; a child is waited for.
    let w = World::new(
        &[
            intent_file("261001-0900-x", "web", "u: 1\ni: 1\n", "X"),
            intent_file("261001-0901-y", "web", "", "Y"),
        ],
        &["web"],
    );
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(towercab::pick::Pick));
    h.set(Stage::Build, Scripted::all(Act::Child));
    let mut lp = w.open(h);
    assert_eq!(
        lp.step_intent("0900").unwrap(),
        "261001-0900: pick → design"
    );
    assert_eq!(
        lp.step_intent("0900").unwrap(),
        "261001-0900: design → plan"
    );
    assert_eq!(lp.step_intent("0900").unwrap(), "261001-0900: plan → build");
    w.release("261001-0900", Stage::Build);
    assert_eq!(
        lp.step_intent("0900").unwrap(),
        "261001-0900: build → verify"
    );
    assert!(w.missions("261001-0901").is_empty(), "Y untouched");
    lp.shutdown().unwrap();
    drop(lp);

    // `run --intent`: only its mission, until it waits on me; a frozen repo refuses it.
    let mut w = World::new(
        &[
            intent_file("261001-0900-x", "web", "u: 1\ni: 1\n", "X"),
            intent_file("261001-0901-y", "web", "", "Y"),
            intent_file("261001-0902-z", "api", "", "Z"),
        ],
        &["web", "api"],
    );
    let spec_waits = || {
        let mut h = Handlers::stubs();
        h.set(
            Stage::Design,
            Scripted::all(Act::Wait(Waiting::ApproveSpec)),
        );
        h
    };
    let mut lp = w.open(spec_waits());
    lp.set_target("0900").unwrap();
    let mut end = None;
    for _ in 0..10 {
        let r = w.pass(&mut lp);
        if r.target.is_some() {
            end = r.target;
            break;
        }
    }
    assert_eq!(
        end,
        Some(Ok("261001-0900: approval:spec · approve spec".to_string()))
    );
    assert!(w.missions("261001-0901").is_empty() && w.missions("261001-0902").is_empty());
    lp.shutdown().unwrap();
    drop(lp);
    w.db()
        .conn()
        .execute(
            "INSERT INTO repo_caps (repo, frozen, why, since) VALUES ('api', 1, 'x', 0)",
            [],
        )
        .unwrap();
    let mut lp = w.open(spec_waits());
    lp.set_target("0902").unwrap();
    assert_eq!(
        w.pass(&mut lp).target,
        Some(Err("261001-0902: not picked: repo api frozen".to_string()))
    );
    lp.shutdown().unwrap();
    drop(lp);
    // `run` itself: passes until the target is done (stub handlers everywhere); web is full
    // (X waits on me), so Y can't be picked.
    let run_intent = |id: &str| {
        let opts = LoopOpts {
            intent: Some(id.into()),
            pass: std::time::Duration::from_millis(5),
            ..LoopOpts::default()
        };
        w.open_with(Handlers::stubs(), w.exes(), opts).run()
    };
    assert_eq!(
        run_intent("0901"),
        Err("261001-0901: not picked: repo web full (1/1)".into())
    );
    w.db().conn().execute("DELETE FROM repo_caps", []).unwrap();
    run_intent("0902").unwrap();
    assert_eq!(w.stage("261001-0902"), Some(Stage::Done));
    assert!(w.missions("261001-0901").is_empty());
}
