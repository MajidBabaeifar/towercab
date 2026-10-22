//! One loop per home and the `commands` table (LOOP-15 mechanics).

mod common;

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use common::{loop_config, output, towercab};
use rusqlite::params;
use towercab::commands::{self, Cmd, CmdCx, PAUSED, QUEUED, RESUMED};
use towercab::config::Config;
use towercab::db::Db;
use towercab::handler::Handlers;
use towercab::home::Home;
use towercab::runloop::{Loop, LoopOpts, Tick};

fn open(config: &Config, home: &Home) -> Result<Loop, String> {
    Loop::open(
        config.clone(),
        home.clone(),
        Handlers::production(),
        common::fake_exes(&home.root.with_file_name("fakebin")),
        LoopOpts::default(),
    )
}

/// `towercab run --watch` on `home`, once it holds the lock.
fn watch(user: &Path, cfg: &Path, home: &Home) -> Child {
    let mut c = towercab(
        user,
        &[
            "--config",
            cfg.to_str().unwrap(),
            "--home",
            home.root.to_str().unwrap(),
            "run",
            "--watch",
        ],
    );
    let child = c
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    while home.holder() != Some(child.id()) {
        assert!(Instant::now() < end, "run --watch takes the lock");
        std::thread::sleep(Duration::from_millis(20));
    }
    child
}

fn term(mut child: Child) {
    let ok = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(ok.success());
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0), "SIGTERM: a clean exit");
}

#[test]
fn test_second_run_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let cfg = loop_config(tmp.path(), "");
    let config = Config::load(Some(&cfg)).unwrap();
    let home = Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let run = |args: &[&str]| {
        let mut full = vec![
            "--config",
            cfg.to_str().unwrap(),
            "--home",
            home.root.to_str().unwrap(),
        ];
        full.extend_from_slice(args);
        output(&mut towercab(&user, &full))
    };
    let refused = |pid: u32| format!("towercab is running (pid {pid}); towercab down first");

    // The lock held (here: by this test): `run` and `run --watch` refused, nothing touched.
    let lock = home.lock().unwrap();
    for args in [
        &["run"][..],
        &["run", "--watch"],
        &["run", "--intent", "0721"],
    ] {
        let (stdout, stderr, code) = run(args);
        assert_eq!(code, Some(1), "{args:?}");
        assert_eq!(
            stderr,
            format!("towercab: {}\n", refused(std::process::id()))
        );
        assert_eq!(stdout, "");
    }
    assert!(!home.db().exists(), "refused before the database");
    assert_eq!(
        open(&config, &home).err(),
        Some(refused(std::process::id()))
    );
    drop(lock);

    // A loop holds it: a second loop is refused with the first one's pid, in and out of
    // process.
    let first = open(&config, &home).unwrap();
    assert_eq!(
        open(&config, &home).err(),
        Some(refused(std::process::id()))
    );
    drop(first);
    let child = watch(&user, &cfg, &home);
    let (_, stderr, code) = run(&["run"]);
    assert_eq!(code, Some(1));
    assert_eq!(stderr, format!("towercab: {}\n", refused(child.id())));
    assert_eq!(open(&config, &home).err(), Some(refused(child.id())));
    term(child);
    assert_eq!(home.holder(), None, "released on exit");
    let (_, stderr, code) = run(&["run"]);
    assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn test_commands_row_applied() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let cfg = loop_config(
        tmp.path(),
        "[repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n",
    );
    let config = Config::load(Some(&cfg)).unwrap();
    let home = Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let db = Db::open(&home.db()).unwrap();
    db.conn()
        .execute(
            "INSERT INTO repo_caps (repo, capped, frozen, why, since) VALUES ('web', 1, 1, 'reverted', 0)",
            [],
        )
        .unwrap();

    // Rows from the CLI and Telegram wait for the loop's next pass, which applies them oldest
    // first, each with its reply.
    let cmds = [
        (Cmd::Pause, "telegram"),
        (Cmd::Trust("web".into()), "cli"),
        (Cmd::Trust("nope".into()), "cli"),
        (Cmd::Approve("0721".into()), "telegram"),
        (Cmd::RetryFresh("0721".into()), "telegram"),
        (Cmd::Release("0721".into()), "cli"),
    ];
    let ids: Vec<i64> = cmds
        .iter()
        .map(|(c, src)| commands::queue(&db, c, src).unwrap())
        .collect();
    let row = commands::get(&db, ids[1]).unwrap();
    assert_eq!(
        (row.name.as_str(), row.arg.as_str(), row.source.as_str()),
        ("trust", "web", "cli")
    );
    assert_eq!((row.applied_at, row.result), (None, None));
    assert_eq!(commands::pending(&db).unwrap().len(), 6);
    assert_eq!(db.meta("paused").unwrap(), None, "nothing applied yet");

    let mut lp = open(&config, &home).unwrap();
    let tick = Tick::now();
    let report = lp.pass(tick).unwrap();
    let replies = [
        PAUSED,
        "trusted web",
        "trust: unknown repo nope",
        "approve: not built yet",
        "retry: not built yet",
        "release: not built yet",
    ];
    assert_eq!(
        report.commands,
        ids.iter()
            .zip(replies)
            .map(|(id, r)| (*id, r.to_string()))
            .collect::<Vec<_>>()
    );
    assert!(report.idle && !report.stop);
    for (id, reply) in ids.iter().zip(replies) {
        let row = commands::get(&db, *id).unwrap();
        assert_eq!(row.applied_at, Some(tick.unix()));
        assert_eq!(row.result.as_deref(), Some(reply));
    }
    assert_eq!(db.meta("paused").unwrap().as_deref(), Some("1"));
    let caps: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM repo_caps", [], |r| r.get(0))
        .unwrap();
    assert_eq!(caps, 0, "trust deletes the repo's caps");
    assert_eq!(lp.pass(Tick::now()).unwrap().commands, vec![], "each once");
    for ((cmd, _), reply) in cmds.iter().zip(replies) {
        assert_eq!(
            cmd.failed(reply),
            reply.starts_with(&format!("{}: ", cmd.word())),
            "{reply}"
        );
    }
    assert!(Cmd::Trust("x".into()).failed("trust: unknown repo x"));
    assert!(!Cmd::Pause.failed(PAUSED));
    assert!(Cmd::RetryFresh("1".into()).failed("retry: not built yet"));

    // An applied row is never applied again, even when asked.
    let cx = CmdCx {
        config: &config,
        db: &db,
        tick: Tick::now(),
    };
    let first = commands::get(&db, ids[0]).unwrap();
    db.del_meta("paused").unwrap();
    assert_eq!(commands::apply(&cx, &first).unwrap(), PAUSED);
    assert_eq!(db.meta("paused").unwrap(), None);

    // The CLI while a loop holds the home: its row waits for the loop's pass; no pass within
    // the wait → queued.
    let got =
        commands::submit(&config, &home, &db, &Cmd::Pause, Duration::from_millis(300)).unwrap();
    assert_eq!(got, None);
    let queued: i64 = db
        .conn()
        .query_row("SELECT max(id) FROM commands", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        lp.pass(Tick::now()).unwrap().commands,
        vec![(queued, PAUSED.to_string())]
    );
    assert_eq!(
        commands::wait_result(&db, queued, Duration::ZERO).as_deref(),
        Some(PAUSED)
    );
    lp.shutdown().unwrap();
    drop(lp);

    // No loop: the CLI applies its row itself, with any rows still pending before it.
    let pending = commands::queue(&db, &Cmd::Pause, "telegram").unwrap();
    let got = commands::submit(&config, &home, &db, &Cmd::Resume, Duration::from_secs(10)).unwrap();
    assert_eq!(got.as_deref(), Some(RESUMED));
    assert_eq!(
        commands::get(&db, pending).unwrap().result.as_deref(),
        Some(PAUSED)
    );
    assert_eq!(db.meta("paused").unwrap(), None, "applied in order");
    assert_eq!(home.holder(), None, "lock released");

    // The binary, no loop running: applied at once; error replies exit 1.
    let cli = |args: &[&str]| {
        let mut full = vec![
            "--config",
            cfg.to_str().unwrap(),
            "--home",
            home.root.to_str().unwrap(),
        ];
        full.extend_from_slice(args);
        output(&mut towercab(&user, &full))
    };
    for (args, out, err, code) in [
        (&["pause"][..], format!("{PAUSED}\n"), "", 0),
        (&["resume"], "resumed\n".into(), "", 0),
        (&["trust", "web"], "trusted web\n".into(), "", 0),
        (
            &["trust", "nope"],
            String::new(),
            "towercab: trust: unknown repo nope\n",
            1,
        ),
        (
            &["approve", "0721"],
            String::new(),
            "towercab: approve: not built yet\n",
            1,
        ),
        (
            &["retry", "--fresh", "0721"],
            String::new(),
            "towercab: retry: not built yet\n",
            1,
        ),
        (
            &["release", "0721"],
            String::new(),
            "towercab: release: not built yet\n",
            1,
        ),
    ] {
        assert_eq!(cli(args), (out, err.to_string(), Some(code)), "{args:?}");
    }
    let (_, _, code) = cli(&["retry", "0721"]);
    assert_eq!(code, Some(2), "retry needs --fresh");
    let source: String = db
        .conn()
        .query_row(
            "SELECT source FROM commands WHERE id = (SELECT max(id) FROM commands)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(source, "cli");

    // The binary while `run --watch` runs: the loop's next pass (≤ 5 s) answers.
    let child = watch(&user, &cfg, &home);
    let started = Instant::now();
    assert_eq!(
        cli(&["pause"]),
        (format!("{PAUSED}\n"), String::new(), Some(0))
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    let applied_by_loop: Option<f64> = db
        .conn()
        .query_row(
            "SELECT applied_at FROM commands WHERE id = (SELECT max(id) FROM commands)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(applied_by_loop.is_some());
    assert_eq!(db.meta("paused").unwrap().as_deref(), Some("1"));
    // Unapplied rows from before are left for the loop, never lost.
    db.conn()
        .execute(
            "INSERT INTO commands (name, source, created) VALUES ('resume', 'telegram', ?1)",
            params![Tick::now().unix()],
        )
        .unwrap();
    let id = db.conn().last_insert_rowid();
    assert_eq!(
        commands::wait_result(&db, id, Duration::from_secs(10)).as_deref(),
        Some(RESUMED)
    );
    term(child);
}

#[test]
fn test_command_queued_while_held() {
    // The home held by something that applies no commands (a `step`): after 10 s the CLI
    // says the row is queued; the next loop applies it.
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let cfg = loop_config(tmp.path(), "");
    let home = Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let lock = home.lock().unwrap();
    let started = Instant::now();
    let got = output(&mut towercab(
        &user,
        &[
            "--config",
            cfg.to_str().unwrap(),
            "--home",
            home.root.to_str().unwrap(),
            "pause",
        ],
    ));
    assert!(started.elapsed() >= Duration::from_secs(10), "waited 10 s");
    assert_eq!(got, (format!("{QUEUED}\n"), String::new(), Some(0)));
    drop(lock);
    let db = Db::open(&home.db()).unwrap();
    assert_eq!(commands::pending(&db).unwrap().len(), 1);
    let config = Config::load(Some(&cfg)).unwrap();
    let mut lp = open(&config, &home).unwrap();
    assert_eq!(
        lp.pass(Tick::now()).unwrap().commands,
        vec![(1, PAUSED.to_string())]
    );
}
