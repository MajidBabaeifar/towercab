//! `towercab.db`: the schema is loop.md's **Schema**; migrations, transactions, `meta` (LOOP-1).

mod common;

use std::collections::BTreeMap;

use common::read;
use rusqlite::Connection;
use towercab::db::{CommandRow, Db, MIGRATIONS, get_meta, set_meta};

/// Every table's and index's shape: name → columns (name, type, not null, default, pk) or
/// the index's SQL.
fn shape(c: &Connection) -> BTreeMap<String, Vec<String>> {
    let names: Vec<(String, String, Option<String>)> = c
        .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    names
        .into_iter()
        .map(|(kind, name, sql)| {
            let cols = if kind == "table" {
                c.prepare(&format!("PRAGMA table_info({name})"))
                    .unwrap()
                    .query_map([], |r| {
                        Ok(format!(
                            "{} {} notnull={} default={:?} pk={}",
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, i64>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, i64>(5)?
                        ))
                    })
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap()
            } else {
                vec![sql.unwrap_or_default()]
            };
            (format!("{kind} {name}"), cols)
        })
        .collect()
}

#[test]
fn test_schema_matches_spec() {
    let spec = read("specs/loop.md");
    let at = spec.find("**Schema**").expect("loop.md has **Schema**");
    let block = &spec[at..];
    let start = block.find("```sql\n").expect("a sql block") + "```sql\n".len();
    let end = start + block[start..].find("```").unwrap();
    let want = Connection::open_in_memory().unwrap();
    want.execute_batch(&block[start..end]).unwrap();

    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("towercab.db")).unwrap();
    assert_eq!(shape(db.conn()), shape(&want));
    assert!(shape(&want).contains_key("index missions_one_per_intent"));
}

#[test]
fn test_db_migrations_tx_meta() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("towercab.db");
    let db = Db::open(&path).unwrap();
    assert_eq!(db.version().unwrap(), MIGRATIONS.len() as i64);

    // meta.
    assert_eq!(db.meta("paused").unwrap(), None);
    db.set_meta("paused", "1").unwrap();
    db.set_meta("paused", "2").unwrap();
    assert_eq!(db.meta("paused").unwrap().as_deref(), Some("2"));
    db.del_meta("paused").unwrap();
    assert_eq!(db.meta("paused").unwrap(), None);

    // tx: committed on Ok, rolled back on Err.
    let n = db
        .tx(|tx| {
            set_meta(tx, "a", "1")?;
            Ok(7)
        })
        .unwrap();
    assert_eq!(n, 7);
    let e = db
        .tx(|tx| -> Result<(), String> {
            set_meta(tx, "b", "1")?;
            assert_eq!(get_meta(tx, "b")?.as_deref(), Some("1"));
            Err("nope".into())
        })
        .unwrap_err();
    assert_eq!(e, "nope");
    assert_eq!(
        (db.meta("a").unwrap(), db.meta("b").unwrap()),
        (Some("1".into()), None)
    );

    // Constraints hold: one unfinished mission per intent; command names; foreign keys.
    let mission = |intent: &str, stage: &str| {
        db.conn().execute(
            "INSERT INTO missions (intent, repo, stage, model, session, checkout, created, updated)
             VALUES (?1, 'web', ?2, 'opus', 'u', 'work/x', 0, 0)",
            [intent, stage],
        )
    };
    mission("1", "done").unwrap();
    mission("1", "build").unwrap();
    assert!(mission("1", "ci").is_err(), "missions_one_per_intent");
    mission("2", "stopped").unwrap();
    mission("2", "stopped").unwrap();
    assert!(
        db.conn()
            .execute(
                "INSERT INTO commands (name, source, created) VALUES ('rm -rf', 'cli', 0)",
                []
            )
            .is_err()
    );
    assert!(
        db.conn()
            .execute(
                "INSERT INTO transitions (mission, at, from_stage, event, to_stage) VALUES (999, 0, 'a', 'ok', 'b')",
                []
            )
            .is_err(),
        "foreign keys on"
    );
    db.conn()
        .execute(
            "INSERT INTO commands (name, arg, source, created) VALUES ('trust', 'web', 'cli', 1.5)",
            [],
        )
        .unwrap();
    let row = db
        .conn()
        .query_row("SELECT * FROM commands", [], CommandRow::from_row)
        .unwrap();
    assert_eq!(
        row,
        CommandRow {
            id: 1,
            name: "trust".into(),
            arg: "web".into(),
            text: String::new(),
            source: "cli".into(),
            update_id: None,
            created: 1.5,
            applied_at: None,
            result: None,
        }
    );

    // Reopening runs nothing again; data stays.
    drop(db);
    let db = Db::open(&path).unwrap();
    assert_eq!(db.meta("a").unwrap().as_deref(), Some("1"));
    // A database from a newer Towercab is refused.
    db.conn()
        .pragma_update(None, "user_version", MIGRATIONS.len() as i64 + 1)
        .unwrap();
    drop(db);
    assert_eq!(
        Db::open(&path).unwrap_err(),
        format!(
            "db: {} has schema {}, newer than this towercab's {}",
            path.display(),
            MIGRATIONS.len() + 1,
            MIGRATIONS.len()
        )
    );
}
