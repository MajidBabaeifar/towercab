//! `towercab status` and `next` (LOOP-13, loop.md **Status**, **Next**): from SQLite and the
//! intents, with or without a running loop.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{git, intent, intent_md, loop_config, output, t, towercab, write};
use rusqlite::params;
use towercab::config::{Config, IntentsConfig, RepoConfig};
use towercab::db::Db;
use towercab::home::Home;
use towercab::intents::Listing;
use towercab::pick::{self, PickState};
use towercab::runloop::Tick;
use towercab::status::{self, Snapshot};

const V: &str = env!("CARGO_PKG_VERSION");

fn config(repos: &[&str]) -> Config {
    let mut c = Config::new(
        "/c.toml".into(),
        IntentsConfig {
            remote: None,
            path: "/i".into(),
            cutoff: 7,
        },
    );
    for r in repos {
        c.repos.insert(
            r.to_string(),
            Ok(RepoConfig {
                name: r.to_string(),
                github: format!("me/{r}"),
                path: format!("/clones/{r}").into(),
                base: "main".into(),
                workers: 1,
                bash: Vec::new(),
            }),
        );
    }
    c
}

fn tick() -> Tick {
    Tick {
        wall: t("2026-10-15T13:30:00+02:00"),
        mono: std::time::Duration::from_secs(1),
    }
}

fn at(s: &str) -> f64 {
    towercab::runloop::unix(t(s))
}

/// An open intent `intents/<id>-x` in `repo`.
fn open(id: &str, repo: &str, extra: &str, title: &str) -> towercab::intents::Intent {
    intent(&format!("intents/{id}-x"), &intent_md(repo, extra, title))
}

#[test]
fn test_status() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("t.db")).unwrap();
    let c = db.conn();
    let mission = |intent: Option<&str>, repo: &str, stage: &str, cols: &str, vals: &str| {
        c.execute(
            &format!(
                "INSERT INTO missions (kind, intent, repo, stage, step, model, session, checkout,
                   created, updated{cols})
                 VALUES (?1, ?2, ?3, ?4, '', 'opus', 's', ?5, 0, 0{vals})"
            ),
            params![
                if intent.is_some() {
                    "intent"
                } else {
                    "rehearsal"
                },
                intent,
                repo,
                stage,
                intent.map_or("work/rehearse-web-261015".to_string(), |i| format!(
                    "work/{i}-1"
                ))
            ],
        )
        .unwrap();
        c.last_insert_rowid()
    };
    let since = at("2026-10-15T13:05:00+02:00");
    let yesterday = at("2026-10-14T09:00:00+02:00");
    mission(
        Some("261001-0900"),
        "web",
        "review",
        ", child_pid, child_kind, child_since, child_model",
        &format!(", 4242, 'claude', {since}, 'fable'"),
    );
    mission(
        Some("261001-0901"),
        "web",
        "e2e",
        ", child_pid, child_kind, child_since, model, merge_sha",
        &format!(", 4243, 'e2e', {yesterday}, 'sonnet', 'abc'"),
    );
    mission(
        Some("261001-0902"),
        "api",
        "approval:spec",
        ", waiting, pr_url",
        ", 'approve spec', 'https://github.com/me/api/pull/3'",
    );
    let ci = mission(Some("261001-0903"), "api", "ci", "", "");
    let rehearsal = mission(None, "web", "rehearse_ci", "", "");
    mission(
        Some("261001-0905"),
        "web",
        "blocked",
        ", waiting, merge_sha",
        ", 'e2e red after your merge (two-way)', 'def'",
    );
    mission(Some("261001-0909"), "web", "done", "", "");
    for (m, when) in [(ci, "12:00"), (rehearsal, "11:00")] {
        c.execute(
            "INSERT INTO transitions (mission, at, from_stage, event, to_stage) VALUES (?1, ?2, 'x', 'ok', ?3)",
            params![
                m,
                at(&format!("2026-10-15T{when}:00+02:00")),
                if m == ci { "ci" } else { "rehearse_ci" }
            ],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO cooldowns (provider, model, until, parsed, text, since) VALUES
           ('claude', 'sonnet', ?1, 1, 'limit', 0), ('claude', 'haiku', ?2, 1, 'old', 0)",
        params![
            at("2026-10-15T14:30:00+02:00"),
            at("2026-10-15T12:00:00+02:00")
        ],
    )
    .unwrap();
    c.execute_batch(&format!(
        "INSERT INTO meta (key, value) VALUES ('paused', '1'), ('env_episode', '1');
         INSERT INTO faults (kind, since, last, error, next_try) VALUES
           ('github', {}, 0, 'Could not resolve host: github.com', 0);
         INSERT INTO repo_caps (repo, capped, frozen, why, since) VALUES
           ('web', 1, 0, 'reverted', 0), ('api', 0, 1, 'revert failed', 0), ('ops', 0, 0, 'x', 0);
         INSERT INTO drafts (key, repo, source, step, created, updated) VALUES
           ('issue:https://github.com/me/web/issues/1', 'web', 'issue', 'failed', 0, 0),
           ('alert:lead_time', 'towercab', 'alert', 'pr', 0, 0);",
        at("2026-10-15T13:00:00+02:00")
    ))
    .unwrap();
    let listing = Listing {
        open: vec![
            open("261001-0900", "web", "stage: build\n", "Alpha"),
            open("261001-0901", "web", "stage: deploy\n", "Echo"),
            open(
                "261001-0902",
                "api",
                "stage: design\nwaiting: approve spec\n",
                "Bravo",
            ),
            open("261001-0903", "api", "stage: test\n", "Delta"),
            open("261001-0904", "web", "waiting: \"bad after:\"\n", "Charlie"),
            open("261001-0905", "web", "stage: deploy\n", "Mike"),
            open(
                "261001-0906",
                "web",
                "waiting: ask legal\n",
                "Quebec\u{1b}[2J",
            ),
            open("261001-0907", "ops", "", "November"),
            open("261001-0908", "ops", "u: 1\ni: 1\n", "Papa"),
        ],
        ..Listing::default()
    };
    let cfg = config(&["api", "ops", "web"]);
    let s = Snapshot::read(
        &db,
        Some(&listing),
        Some("git pull: Could not resolve host"),
        &cfg,
        Some(777),
        true,
        tick(),
    )
    .unwrap();
    assert_eq!(
        status::render(&s),
        format!(
            "towercab {V} · running (pid 777) · paused · env blocked
active: 261001-0900 web: Alpha · review · fable · since 13:05
active: 261001-0901 web: Echo · e2e · - · since 2026-10-14 09:00
queued: 261001-0903 api: Delta · ci · behind 261001-0902
waiting on you:
- 261001-0902 api: Bravo · approve spec: approve 261001-0902 · https://github.com/me/api/pull/3
- 261001-0905 web: Mike · e2e red after your merge (two-way): approve 261001-0905 to keep it, or retry --fresh 261001-0905 to fix forward
- 261001-0904 web: Charlie · bad after:
- 261001-0906 web: Quebec\u{FFFD}[2J · ask legal
waiting on CI or deploy:
- 261001-0903 api: Delta · ci · since 12:00
- rehearse-web-261015 web: rehearse-web-261015 · rehearse_ci · since 11:00
cooling: sonnet until 2026-10-15 14:30 +02:00
env blocked: github: Could not resolve host: github.com · since 13:00
repos: api frozen, web capped at a3
drafts failed: issue:https://github.com/me/web/issues/1
intents: git pull: Could not resolve host
next: nothing runnable
review due: towercab review"
        )
    );

    // Nothing going on: the next intent; no pause, no env block, no loop.
    let empty = Db::open(&tmp.path().join("e.db")).unwrap();
    let s = Snapshot::read(&empty, Some(&listing), None, &cfg, None, true, tick()).unwrap();
    assert_eq!(
        status::render(&s),
        format!(
            "towercab {V} · not running
active: none
waiting on you:
- 261001-0902 api: Bravo · approve spec: approve 261001-0902
- 261001-0904 web: Charlie · bad after:
- 261001-0906 web: Quebec\u{FFFD}[2J · ask legal
next: 261001-0907 ops: November
review due: towercab review"
        )
    );
    // Picks off (no pipeline yet): nothing runnable; no intents: no next, no review.
    let s = Snapshot::read(&empty, Some(&listing), None, &cfg, None, false, tick()).unwrap();
    assert!(status::render(&s).contains("\nnext: nothing runnable\n"));
    let s = Snapshot::read(&empty, None, Some("no clone"), &cfg, None, true, tick()).unwrap();
    assert_eq!(
        status::render(&s),
        format!(
            "towercab {V} · not running\nactive: none\nintents: no clone\nnext: nothing runnable"
        )
    );

    // The binary, no loop, then while the home is held.
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let file = loop_config(
        tmp.path(),
        "[repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n",
    );
    let intents = tmp.path().join("intents");
    write(
        &intents,
        "intents/261001-0900-x/intent.md",
        &intent_md("web", "waiting: CI red\n", "X"),
    );
    git(&intents, &["add", "-A"]);
    git(&intents, &["commit", "--quiet", "-m", "seed"]);
    let home = Home::resolve(Some(&tmp.path().join("home"))).unwrap();
    let run = || {
        output(&mut towercab(
            &user,
            &[
                "--config",
                file.to_str().unwrap(),
                "--home",
                home.root.to_str().unwrap(),
                "status",
            ],
        ))
    };
    assert_eq!(
        run(),
        (
            format!(
                "towercab {V} · not running\nactive: none\nwaiting on you:\n\
                 - 261001-0900 web: X · CI red\nnext: nothing runnable\n"
            ),
            String::new(),
            Some(0)
        )
    );
    let _lock = home.lock().unwrap();
    let (out, _, code) = run();
    assert_eq!(code, Some(0));
    assert!(
        out.starts_with(&format!(
            "towercab {V} · running (pid {})\n",
            std::process::id()
        )),
        "{out}"
    );

    // The loop's status after a failed `intents` pull: the checkout as it is, and the error
    // once.
    let mut w = common::world::World::new(
        &[common::world::intent_file("261001-0900-x", "web", "", "X")],
        &["web"],
    );
    let mut lp = w.open(towercab::handler::Handlers::stubs());
    std::fs::rename(&w.intents.remote, w.root.join("gone.git")).unwrap();
    w.pass(&mut lp);
    let text = lp.status_text(w.clock).unwrap();
    let line = text
        .lines()
        .find(|l| l.starts_with("intents: "))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(!line.starts_with("intents: intents:"), "{line}");
    lp.shutdown().unwrap();
}

#[test]
fn test_next() {
    let listing = Listing {
        open: vec![
            open("261001-0900", "web", "u: 5\ni: 5\n", "Frozen one"),
            open("261001-0901", "api", "", "Full one"),
            open("261001-0902", "ops", "model: sonnet\n", "Cooling one"),
            open("261001-0903", "nowhere", "", "Lost"),
            open("261001-0904", "ops", "after: [250101-0000]\n", "Bad"),
            open("261001-0905", "ops", "u: 3\ni: 3\na: 2\n", "Foxtrot"),
            open("261001-0906", "ops", "u: 1\ni: 2\n", "Golf"),
        ],
        ..Listing::default()
    };
    let mut state = PickState {
        cutoff: 7,
        built: true,
        repos: ["web", "api", "ops"].map(String::from).into(),
        model: "opus".into(),
        frozen: BTreeSet::from(["web".to_string()]),
        full: BTreeMap::from([("api".to_string(), (1, 1))]),
        cooling: BTreeMap::from([("sonnet".to_string(), "14:30".to_string())]),
        ..PickState::default()
    };
    let d = pick::decide(&listing, &state);
    assert_eq!(
        status::next_text(&d, &listing, 7),
        "next: 261001-0905 ops: Foxtrot · p9 u3 i3 a2
skipped:
- 261001-0904 ops: Bad · bad after: 250101-0000
- 261001-0900 web: Frozen one · repo web frozen
- 261001-0901 api: Full one · repo api full (1/1)
- 261001-0902 ops: Cooling one · sonnet cooling until 14:30
- 261001-0903 nowhere: Lost · unknown repo nowhere"
    );
    // Only a parked one left: it waits for me (PRI-5).
    let parked = Listing {
        open: vec![listing.open[6].clone()],
        ..Listing::default()
    };
    assert_eq!(
        status::next_text(&pick::decide(&parked, &state), &parked, 7),
        "next: nothing runnable\nskipped:\n- 261001-0906 ops: Golf · parked (p5 < 7): raise u or i to run it"
    );
    // Paused, env blocked, picks off: each says so; nothing runnable.
    for (set, why) in [
        (
            (|s: &mut PickState| s.paused = true) as fn(&mut PickState),
            "paused",
        ),
        (|s: &mut PickState| s.env_blocked = true, "env blocked"),
        (
            |s: &mut PickState| s.built = false,
            "picks off: pipeline not built",
        ),
    ] {
        let mut st = state.clone();
        set(&mut st);
        let one = Listing {
            open: vec![
                listing
                    .open
                    .iter()
                    .find(|i| i.id == "261001-0905")
                    .unwrap()
                    .clone(),
            ],
            ..Listing::default()
        };
        assert_eq!(
            status::next_text(&pick::decide(&one, &st), &one, 7),
            format!("next: nothing runnable\nskipped:\n- 261001-0905 ops: Foxtrot · {why}")
        );
    }
    state.frozen.clear();
    assert!(
        status::next_text(&pick::decide(&listing, &state), &listing, 7)
            .starts_with("next: 261001-0900 web: Frozen one · p15 u5 i5\n")
    );

    // The binary: picks on (the pipeline); a repo not in [repos] says so.
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let file = loop_config(
        tmp.path(),
        "[repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n",
    );
    let intents = tmp.path().join("intents");
    write(
        &intents,
        "intents/261001-0900-a/intent.md",
        &intent_md("web", "", "Alpha"),
    );
    write(
        &intents,
        "intents/261001-0901-l/intent.md",
        &intent_md("nowhere", "u: 5\ni: 5\n", "Lost"),
    );
    git(&intents, &["add", "-A"]);
    git(&intents, &["commit", "--quiet", "-m", "seed"]);
    let (out, err, code) = output(&mut towercab(
        &user,
        &[
            "--config",
            file.to_str().unwrap(),
            "--home",
            tmp.path().join("home").to_str().unwrap(),
            "next",
        ],
    ));
    assert_eq!(code, Some(0), "{err}");
    assert_eq!(
        out,
        "next: 261001-0900 web: Alpha · p9 u3 i3\nskipped:\n\
         - 261001-0901 nowhere: Lost · unknown repo nowhere\n"
    );
    assert!(
        !std::fs::read_to_string(intents.join("intents/261001-0901-l/intent.md"))
            .unwrap()
            .contains("waiting"),
        "next only reads"
    );
}
