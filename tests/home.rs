//! The loop's home (LOOP-1): where it is, its layout, its database and its lock. The only test
//! in this binary: it sets `HOME` and `TOWERCAB_HOME`.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use towercab::db::{Db, MIGRATIONS};
use towercab::home::Home;

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn test_home_layout() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    fs::create_dir_all(&user).unwrap();
    // SAFETY: no other test runs in this binary, so nothing reads the environment concurrently.
    unsafe {
        std::env::set_var("HOME", &user);
        std::env::remove_var("TOWERCAB_HOME");
    }

    // ~/.local/share/towercab when nothing says otherwise; TOWERCAB_HOME; --home wins.
    let h = Home::resolve(None).unwrap();
    assert_eq!(h.root, user.join(".local/share/towercab"));
    let by_env = tmp.path().join("env-home");
    // SAFETY: as above.
    unsafe { std::env::set_var("TOWERCAB_HOME", &by_env) };
    assert_eq!(Home::resolve(None).unwrap().root, by_env);
    let arg = tmp.path().join("arg/home");
    let h = Home::resolve(Some(&arg)).unwrap();
    assert_eq!(h.root, arg);
    assert_eq!(
        Home::resolve(Some(Path::new("~/tc"))).unwrap().root,
        user.join("tc"),
        "~/ expanded"
    );

    // Created 0700, with work/ and runs/.
    for d in [&h.root, &h.root.join("work"), &h.root.join("runs")] {
        assert!(d.is_dir(), "{}", d.display());
        assert_eq!(mode(d), 0o700, "{}", d.display());
    }
    assert_eq!(h.db(), arg.join("towercab.db"));
    assert_eq!(h.lock_path(), arg.join("towercab.lock"));
    assert_eq!(h.work("261020-0721", 2), arg.join("work/261020-0721-2"));
    assert_eq!(h.runs("261020-0721"), arg.join("runs/261020-0721"));
    assert_eq!(
        h.runs("rehearse-web-261022"),
        arg.join("runs/rehearse-web-261022")
    );
    // An existing home is used as it is.
    fs::write(h.root.join("keep"), "x").unwrap();
    assert_eq!(Home::resolve(Some(&arg)).unwrap(), h);
    assert!(h.root.join("keep").exists());

    // towercab.db: WAL, synchronous FULL, foreign keys, 5 s busy timeout, every migration.
    let db = Db::open(&h.db()).unwrap();
    let c = db.conn();
    let pragma = |p: &str| -> String {
        c.query_row(&format!("PRAGMA {p}"), [], |r| {
            r.get::<_, rusqlite::types::Value>(0)
        })
        .map(|v| match v {
            rusqlite::types::Value::Integer(n) => n.to_string(),
            rusqlite::types::Value::Text(t) => t,
            other => format!("{other:?}"),
        })
        .unwrap()
    };
    assert_eq!(pragma("journal_mode"), "wal");
    assert_eq!(pragma("synchronous"), "2", "FULL");
    assert_eq!(pragma("foreign_keys"), "1");
    assert_eq!(pragma("busy_timeout"), "5000");
    assert_eq!(db.version().unwrap(), MIGRATIONS.len() as i64);
    let mut tables: Vec<String> = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    tables.sort();
    assert_eq!(
        tables,
        [
            "breaches",
            "commands",
            "cooldowns",
            "drafts",
            "episodes",
            "faults",
            "findings",
            "lessons",
            "meta",
            "missions",
            "outbox",
            "repo_caps",
            "transitions",
            "triage"
        ]
    );
    db.set_meta("paused", "1").unwrap();
    assert!(
        h.root.join("towercab.db-wal").exists(),
        "writes go to the WAL"
    );

    // towercab.lock: flock, content "<pid>\n"; a second lock is refused with the holder's pid.
    assert_eq!(h.holder(), None);
    let lock = h.lock().unwrap();
    assert_eq!(
        fs::read_to_string(h.lock_path()).unwrap(),
        format!("{}\n", std::process::id())
    );
    assert_eq!(h.holder(), Some(std::process::id()));
    assert_eq!(
        h.lock().unwrap_err(),
        format!(
            "towercab is running (pid {}); towercab down first",
            std::process::id()
        )
    );
    drop(lock);
    assert_eq!(h.holder(), None, "dropping releases it");
    // A stale pid in a free lock file doesn't count; the next holder overwrites it.
    fs::write(h.lock_path(), "99999999\n").unwrap();
    assert_eq!(h.holder(), None);
    let _lock = h.lock().unwrap();
    assert_eq!(
        fs::read_to_string(h.lock_path()).unwrap(),
        format!("{}\n", std::process::id())
    );
}
