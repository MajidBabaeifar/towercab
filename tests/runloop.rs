//! `run`: a pass every 5 s until SIGTERM or SIGINT (`--watch`) or until idle; `meta.running`
//! marks an unclean exit (LOOP-12, LOOP-15 `run`; the pass so far applies `commands`).

mod common;

use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use common::{loop_config, output, towercab};
use towercab::commands::{self, Cmd, PAUSED, RESUMED};
use towercab::config::Config;
use towercab::db::Db;
use towercab::exes::Exes;
use towercab::handler::Handlers;
use towercab::home::Home;
use towercab::runloop::{Loop, LoopOpts, PASS, Tick};

fn open(config: &Config, home: &Home) -> Loop {
    Loop::open(
        config.clone(),
        home.clone(),
        Handlers::production(),
        Exes::default(),
        LoopOpts::default(),
    )
    .unwrap()
}

#[test]
fn test_run_once_and_unclean_exit() {
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

    // Without --watch: one pass (it applies the pending rows), nothing runnable → exit 0.
    let db = Db::open(&home.db()).unwrap();
    let id = commands::queue(&db, &Cmd::Pause, "telegram").unwrap();
    let started = Instant::now();
    assert_eq!(run(&["run"]), (String::new(), String::new(), Some(0)));
    assert!(started.elapsed() < PASS, "no sleep before exiting");
    assert_eq!(
        commands::get(&db, id).unwrap().result.as_deref(),
        Some(PAUSED)
    );
    assert_eq!(db.meta("running").unwrap(), None, "a clean exit");
    assert_eq!(home.holder(), None);

    // --intent: no stage handler built, so it can't be picked.
    assert_eq!(
        run(&["run", "--intent", "0721"]),
        (
            String::new(),
            "towercab: 0721: not picked: picks off: pipeline not built\n".into(),
            Some(1)
        )
    );
    assert_eq!(db.meta("running").unwrap(), None);
    assert!(!Handlers::production().built());

    // meta.running = "<pid> <unix s>" while a loop runs; a loop dropped without shutdown
    // leaves it, and the next loop sees the unclean exit.
    let lp = open(&config, &home);
    assert_eq!(lp.unclean, None);
    let running = db.meta("running").unwrap().expect("set at open");
    let (pid, at) = running.split_once(' ').unwrap();
    assert_eq!(pid, std::process::id().to_string());
    let at: i64 = at.parse().unwrap();
    assert!((at - Tick::now().wall.timestamp()).abs() < 60);
    drop(lp);
    let mut lp = open(&config, &home);
    assert_eq!(lp.unclean.as_deref(), Some(running.as_str()));
    lp.shutdown().unwrap();
    drop(lp);
    let mut lp = open(&config, &home);
    assert_eq!(lp.unclean, None);

    // A signal seen: the pass does nothing.
    commands::queue(&db, &Cmd::Resume, "cli").unwrap();
    lp.stop_flag().store(true, Ordering::SeqCst);
    let report = lp.pass(Tick::now()).unwrap();
    assert!(report.stop);
    assert_eq!(report.commands, vec![]);
    assert_eq!(commands::pending(&db).unwrap().len(), 1);
    lp.shutdown().unwrap();
}

#[test]
fn test_run_passes_until_signal() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let cfg = loop_config(tmp.path(), "");
    let home = Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let db = Db::open(&home.db()).unwrap();
    for (sig, cmds) in [("-TERM", true), ("-INT", false)] {
        let mut child = towercab(
            &user,
            &[
                "--config",
                cfg.to_str().unwrap(),
                "--home",
                home.root.to_str().unwrap(),
                "run",
                "--watch",
            ],
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        while home.holder() != Some(child.id()) {
            assert!(Instant::now() < end, "run --watch takes the lock");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(db.meta("running").unwrap().is_some());
        if cmds {
            // Idle, it keeps passing: one row per pass, passes 5 s apart.
            let a = commands::queue(&db, &Cmd::Pause, "telegram").unwrap();
            assert_eq!(
                commands::wait_result(&db, a, Duration::from_secs(7)).as_deref(),
                Some(PAUSED)
            );
            let b = commands::queue(&db, &Cmd::Resume, "telegram").unwrap();
            assert_eq!(
                commands::wait_result(&db, b, Duration::from_secs(7)).as_deref(),
                Some(RESUMED)
            );
            let at = |id| commands::get(&db, id).unwrap().applied_at.unwrap();
            let gap = at(b) - at(a);
            assert!(
                (4.5..6.0).contains(&gap),
                "the next pass {gap} s later, not sooner"
            );
        }
        // A signal ends the sleep at once: exit 0, meta.running removed, lock free.
        std::thread::sleep(Duration::from_millis(300));
        let sent = Instant::now();
        let ok = Command::new("kill")
            .args([sig, &child.id().to_string()])
            .status()
            .unwrap();
        assert!(ok.success());
        let status = child.wait().unwrap();
        assert!(
            sent.elapsed() < Duration::from_secs(2),
            "{sig}: woke at once"
        );
        assert_eq!(status.code(), Some(0), "{sig}");
        assert_eq!(db.meta("running").unwrap(), None, "{sig}");
        assert_eq!(home.holder(), None, "{sig}");
    }
}

#[test]
fn test_idle() {
    use common::world::{Act, Scripted, World, intent_file, open_pr};
    use towercab::machine::{Stage, Waiting};
    use towercab::pick::Pick;

    const ID: &str = "261001-0900";
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    w.prs.set(7, open_pr("h1"));
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Design, Box::new(common::world::PublishesPr));
    h.set(
        Stage::Review,
        Scripted::all(Act::Wait(Waiting::ReviewAndMergePr)),
    );
    let mut lp = w.open(h);
    // Driven: not idle.
    let r = w.pass(&mut lp);
    assert_eq!(r.picked.as_deref(), Some(ID));
    assert!(!r.idle);
    w.until(&mut lp, 20, |w| w.stage(ID) == Some(Stage::ApprovalMerge));
    // Waiting on me, nothing runnable: idle, and the passes go on: PR reads, intents pulls.
    let rows = w.outbox().len();
    let reads = w.prs.reads();
    let r = w.pass(&mut lp);
    assert!(r.idle && r.picked.is_none());
    w.intents.push_mine(
        &[(
            "intents/261001-0900-x/intent.md",
            Some(&common::intent_md(
                "web",
                "stage: deploy\nwaiting: review and merge PR\npr: https://github.com/me/web/pull/7\n",
                "X, renamed",
            )),
        )],
        "rename",
    );
    for _ in 0..3 {
        assert!(w.pass(&mut lp).idle);
    }
    assert!(w.prs.reads() >= reads + 3, "PR reads go on");
    let listing = lp.listing().unwrap();
    assert_eq!(listing.open[0].title(), "X, renamed", "intents pulled");
    assert_eq!(w.outbox().len(), rows, "no message for being idle");

    // A limit wait is idle too; a CI poll isn't.
    let db = w.db();
    db.conn()
        .execute_batch(
            "INSERT INTO cooldowns (provider, model, until, parsed, text, since)
               VALUES ('claude', 'opus', 9999999999, 1, 'limit', 0);
             INSERT INTO missions (repo, stage, step, model, session, checkout, limit_model, created, updated)
               VALUES ('web', 'build', '', 'opus', 's', 'work/l', 'opus', 0, 0);",
        )
        .unwrap();
    let r = w.pass(&mut lp);
    assert!(r.idle);
    let l = towercab::mission::get(db.conn(), 2).unwrap();
    assert_eq!(
        (l.stage, l.limit_model.as_deref()),
        (Stage::Build, Some("opus"))
    );
    db.conn()
        .execute(
            "UPDATE missions SET limit_model = NULL, stage = 'blocked' WHERE checkout = 'work/l'",
            [],
        )
        .unwrap();
    lp.shutdown().unwrap();
    drop(lp);
    let mut h = Handlers::stubs();
    h.set(Stage::Ci, Scripted::all(Act::Poll(Duration::from_secs(30))));
    let mut lp = w.open(h);
    db.conn()
        .execute(
            "INSERT INTO missions (repo, stage, step, model, session, checkout, created, updated)
               VALUES ('web', 'ci', '', 'opus', 's', 'work/c', 0, 0)",
            [],
        )
        .unwrap();
    assert!(!w.pass(&mut lp).idle, "polling CI is driven");
    lp.shutdown().unwrap();

    // Picks off (production handlers) with an intent queued: nothing runnable, idle.
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    let mut lp = w.open(Handlers::production());
    for _ in 0..2 {
        let r = w.pass(&mut lp);
        assert!(r.idle && r.picked.is_none());
    }
    lp.shutdown().unwrap();
}
