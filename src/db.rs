//! The loop's SQLite database, `<home>/towercab.db` (LOOP-1, **Schema**): WAL, migrations
//! tracked in `PRAGMA user_version`, times as unix seconds `REAL`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};

/// Migration `i` takes `user_version` from `i` to `i + 1` in one transaction; later intents
/// append.
pub const MIGRATIONS: &[&str] = &[SCHEMA_1, SCHEMA_2, SCHEMA_3, SCHEMA_4, SCHEMA_5];

/// loop.md **Schema**, as written there.
const SCHEMA_1: &str = r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- running "<pid> <unix>", paused "1", tg_offset, env_episode "<unix>" (while env_blocked), bot "<slug> <user id>", last_pass "<unix>", dying "<pid>:<start> …"

CREATE TABLE missions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'intent' CHECK (kind IN ('intent','revert','rehearsal')),  -- Stage::kind of its stage
  intent TEXT,                          -- intent id; NULL for a rehearsal
  repo TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  stage TEXT NOT NULL,                  -- Stage::as_str
  step TEXT NOT NULL DEFAULT 'enter',   -- 'enter': entry effects due; '': the handler's turn; else its recorded step
  busy INTEGER NOT NULL DEFAULT 0,      -- inside a handler call or with a child (LOOP-7)
  unclean INTEGER NOT NULL DEFAULT 0,   -- unclean re-entries of this step
  from_stage TEXT,                      -- the stage left for approval/blocked/stopped
  waiting TEXT, why TEXT,               -- Waiting::text; one-line detail for status and messages
  continued INTEGER NOT NULL DEFAULT 0, -- times continued (outbox n)
  held INTEGER NOT NULL DEFAULT 0,      -- paused at merge, revert_merge or rollback entry
  model TEXT NOT NULL, a_at_pick INTEGER,
  session TEXT NOT NULL, session_used INTEGER NOT NULL DEFAULT 0, run_session TEXT,
  checkout TEXT NOT NULL,               -- relative to the home
  branch TEXT, base_sha TEXT, head TEXT,
  pr INTEGER, pr_url TEXT, pushed_at REAL, feedback_seen TEXT,  -- feedback_seen: RFC 3339
  merged_by TEXT CHECK (merged_by IN ('towercab','human')), merge_sha TEXT, revert_branch TEXT,
  verify_repairs INTEGER NOT NULL DEFAULT 0, ci_repairs INTEGER NOT NULL DEFAULT 0,
  sync_rounds INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0, retry_at REAL,              -- LOOP-10 backoff of this step
  fault TEXT,                           -- its last env_fail's fault kind: the step's next success closes it
  limit_model TEXT,                     -- the step waits for this model's cooldown (LOOP-9)
  step_secs REAL NOT NULL DEFAULT 0,    -- children run time of this step (timeouts)
  child_pid INTEGER, child_start INTEGER, child_kind TEXT, child_since REAL,
  child_model TEXT,                     -- a Claude child's --model (status)
  cost_usd REAL NOT NULL DEFAULT 0, agent_secs REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',      -- JSON: stage results the pipeline keeps
  created REAL NOT NULL, updated REAL NOT NULL, finished REAL
);
CREATE UNIQUE INDEX missions_one_per_intent ON missions(intent)
  WHERE intent IS NOT NULL AND stage NOT IN ('done','stopped');

CREATE TABLE transitions (id INTEGER PRIMARY KEY, mission INTEGER NOT NULL REFERENCES missions(id),
  at REAL NOT NULL, from_stage TEXT NOT NULL, event TEXT NOT NULL, to_stage TEXT NOT NULL, why TEXT);

CREATE TABLE cooldowns (provider TEXT NOT NULL, model TEXT NOT NULL, until REAL NOT NULL,
  parsed INTEGER NOT NULL, backoffs INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, since REAL NOT NULL,
  PRIMARY KEY (provider, model));

CREATE TABLE outbox (mission TEXT NOT NULL,   -- mission id, 'intent:<id>', 'repo:<name>' or 'loop'
  event TEXT NOT NULL, n TEXT NOT NULL, text TEXT NOT NULL, created REAL NOT NULL,
  sent_at REAL, tries INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (mission, event, n));

CREATE TABLE commands (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('approve','retry_fresh','release','pause','resume','trust')),
  arg TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,  -- 'cli' or 'telegram'
  update_id INTEGER,                                    -- a Telegram one's update: its reply's outbox n
  created REAL NOT NULL, applied_at REAL, result TEXT);

CREATE TABLE repo_caps (repo TEXT PRIMARY KEY, capped INTEGER NOT NULL DEFAULT 0,  -- cap 3 (AUT-10, MNT-6)
  frozen INTEGER NOT NULL DEFAULT 0, why TEXT NOT NULL, since REAL NOT NULL);

CREATE TABLE faults (kind TEXT PRIMARY KEY, since REAL NOT NULL, last REAL NOT NULL,
  error TEXT NOT NULL, next_try REAL NOT NULL);

CREATE TABLE drafts (key TEXT PRIMARY KEY,   -- 'issue:<url>', 'alert:<band>', 'review:<rule>'
  repo TEXT NOT NULL, source TEXT NOT NULL, intent TEXT, slug TEXT, pr INTEGER, pr_url TEXT,
  step TEXT NOT NULL,                        -- draft, drafted, push, pr, link, open, accepted, rejected, failed
  tries INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL);
"#;

/// The pipeline's findings (PIP-36): review findings with a `rule`, one row per repo, rule
/// (lowercased) and PR.
const SCHEMA_2: &str = r#"
CREATE TABLE findings (repo TEXT NOT NULL, rule TEXT NOT NULL /* lowercased */, pr INTEGER NOT NULL,
  mission INTEGER NOT NULL REFERENCES missions(id), at REAL NOT NULL, PRIMARY KEY (repo, rule, pr));
"#;

/// Maintain (MNT-3..8): breach events, open episodes, triage counts per band, lessons.
const SCHEMA_3: &str = r#"
CREATE TABLE breaches (band TEXT NOT NULL, tier TEXT NOT NULL CHECK (tier IN ('1sigma','2sigma','3sigma')),
  point REAL NOT NULL /* the newest point's time */, value REAL NOT NULL, mean REAL NOT NULL, sigma REAL NOT NULL,
  at REAL NOT NULL, step TEXT NOT NULL /* diagnose, comment, done */, PRIMARY KEY (band, tier, point));
CREATE TABLE episodes (band TEXT PRIMARY KEY, since REAL NOT NULL /* its first breach's point */,
  drafted INTEGER NOT NULL DEFAULT 0, proposed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE triage (band TEXT PRIMARY KEY, accepted INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE lessons (intent TEXT PRIMARY KEY, band TEXT NOT NULL, pr TEXT, fixed REAL NOT NULL,
  point REAL, value REAL, within INTEGER, step TEXT NOT NULL /* wait, write, written */);
"#;

/// Commands I answer waits with (LOOP-15): `answer`, `unlock`, `allow`, `drop`, and their `text`.
const SCHEMA_4: &str = r#"
CREATE TABLE commands_new (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('approve','retry_fresh','release','pause','resume','trust','answer','unlock','drop')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  update_id INTEGER, created REAL NOT NULL, applied_at REAL, result TEXT);
INSERT INTO commands_new (id, name, arg, source, update_id, created, applied_at, result)
  SELECT id, name, arg, source, update_id, created, applied_at, result FROM commands;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;
"#;

/// `allow` (PIP-24's network for an intent's worker).
const SCHEMA_5: &str = r#"
CREATE TABLE commands_new (id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('approve','retry_fresh','release','pause','resume','trust','answer','unlock','allow','drop')),
  arg TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  update_id INTEGER, created REAL NOT NULL, applied_at REAL, result TEXT);
INSERT INTO commands_new (id, name, arg, text, source, update_id, created, applied_at, result)
  SELECT id, name, arg, text, source, update_id, created, applied_at, result FROM commands;
DROP TABLE commands;
ALTER TABLE commands_new RENAME TO commands;
"#;

/// An open `towercab.db`.
#[derive(Debug)]
pub struct Db {
    conn: Connection,
    pub path: PathBuf,
}

/// `db: <error>`.
pub fn sql(e: rusqlite::Error) -> String {
    format!("db: {e}")
}

impl Db {
    /// Opens (creating) the database: `journal_mode=WAL`, `synchronous=FULL`,
    /// `foreign_keys=ON`, `busy_timeout=5000`, then the migrations it lacks.
    pub fn open(path: &Path) -> Result<Db, String> {
        let shown = |e: rusqlite::Error| format!("db: {}: {e}", path.display());
        let conn = Connection::open(path).map_err(shown)?;
        conn.busy_timeout(Duration::from_millis(5000))
            .map_err(shown)?;
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
            .map_err(shown)?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(format!(
                "db: {}: journal_mode is {mode}, not wal",
                path.display()
            ));
        }
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(shown)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(shown)?;
        let db = Db {
            conn,
            path: path.to_path_buf(),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let newest = MIGRATIONS.len() as i64;
        loop {
            let done = self.tx(|tx| {
                // Read inside the write transaction: another process may have migrated.
                let v = version(tx)?;
                if v > newest {
                    return Err(format!(
                        "db: {} has schema {v}, newer than this towercab's {newest}",
                        self.path.display()
                    ));
                }
                if v == newest {
                    return Ok(true);
                }
                tx.execute_batch(MIGRATIONS[v as usize]).map_err(sql)?;
                tx.pragma_update(None, "user_version", v + 1).map_err(sql)?;
                Ok(false)
            })?;
            if done {
                return Ok(());
            }
        }
    }

    /// The connection, for reads and single statements.
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// `PRAGMA user_version`: migrations applied.
    pub fn version(&self) -> Result<i64, String> {
        version(&self.conn)
    }

    /// Runs `f` in one `BEGIN IMMEDIATE` transaction: committed on `Ok`, rolled back on `Err`
    /// (with the metrics it recorded).
    pub fn tx<T>(&self, f: impl FnOnce(&Transaction) -> Result<T, String>) -> Result<T, String> {
        let tx =
            Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate).map_err(sql)?;
        // Metrics recorded inside count only if it commits (MET-13).
        let mark = crate::metrics::mark();
        let out = f(&tx).and_then(|out| tx.commit().map(|()| out).map_err(sql));
        if out.is_err() {
            crate::metrics::drop_since(mark);
        }
        out
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, String> {
        get_meta(&self.conn, key)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        set_meta(&self.conn, key, value)
    }

    pub fn del_meta(&self, key: &str) -> Result<(), String> {
        del_meta(&self.conn, key)
    }
}

fn version(conn: &Connection) -> Result<i64, String> {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(sql)
}

/// `meta.<key>` on a connection or inside a transaction.
pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(sql)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(drop)
    .map_err(sql)
}

pub fn del_meta(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key])
        .map(drop)
        .map_err(sql)
}

/// A `commands` row (LOOP-15).
#[derive(Debug, Clone, PartialEq)]
pub struct CommandRow {
    pub id: i64,
    pub name: String,
    pub arg: String,
    /// `answer`'s text, `unlock`'s globs (one per line); else empty.
    pub text: String,
    pub source: String,
    /// The Telegram update it came from (its reply goes to the outbox under this `n`).
    pub update_id: Option<i64>,
    pub created: f64,
    pub applied_at: Option<f64>,
    pub result: Option<String>,
}

impl CommandRow {
    pub fn from_row(r: &Row) -> rusqlite::Result<CommandRow> {
        Ok(CommandRow {
            id: r.get("id")?,
            name: r.get("name")?,
            arg: r.get("arg")?,
            text: r.get("text")?,
            source: r.get("source")?,
            update_id: r.get("update_id")?,
            created: r.get("created")?,
            applied_at: r.get("applied_at")?,
            result: r.get("result")?,
        })
    }
}

/// An `outbox` row (LOOP-14).
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxRow {
    pub mission: String,
    pub event: String,
    pub n: String,
    pub text: String,
    pub created: f64,
    pub sent_at: Option<f64>,
    pub tries: i64,
    pub next_try: f64,
}

impl OutboxRow {
    pub fn from_row(r: &Row) -> rusqlite::Result<OutboxRow> {
        Ok(OutboxRow {
            mission: r.get("mission")?,
            event: r.get("event")?,
            n: r.get("n")?,
            text: r.get("text")?,
            created: r.get("created")?,
            sent_at: r.get("sent_at")?,
            tries: r.get("tries")?,
            next_try: r.get("next_try")?,
        })
    }
}

/// A `cooldowns` row (LOOP-9).
#[derive(Debug, Clone, PartialEq)]
pub struct Cooldown {
    pub provider: String,
    pub model: String,
    pub until: f64,
    /// The reset time came from the text (else a backoff).
    pub parsed: bool,
    pub backoffs: i64,
    pub text: String,
    pub since: f64,
}

impl Cooldown {
    pub fn from_row(r: &Row) -> rusqlite::Result<Cooldown> {
        Ok(Cooldown {
            provider: r.get("provider")?,
            model: r.get("model")?,
            until: r.get("until")?,
            parsed: r.get("parsed")?,
            backoffs: r.get("backoffs")?,
            text: r.get("text")?,
            since: r.get("since")?,
        })
    }
}

/// A `repo_caps` row (AUT-10, MNT-6).
#[derive(Debug, Clone, PartialEq)]
pub struct RepoCap {
    pub repo: String,
    pub capped: bool,
    pub frozen: bool,
    pub why: String,
    pub since: f64,
}

impl RepoCap {
    pub fn from_row(r: &Row) -> rusqlite::Result<RepoCap> {
        Ok(RepoCap {
            repo: r.get("repo")?,
            capped: r.get("capped")?,
            frozen: r.get("frozen")?,
            why: r.get("why")?,
            since: r.get("since")?,
        })
    }
}

/// A `faults` row (LOOP-10).
#[derive(Debug, Clone, PartialEq)]
pub struct FaultRow {
    pub kind: String,
    pub since: f64,
    pub last: f64,
    pub error: String,
    pub next_try: f64,
}

impl FaultRow {
    pub fn from_row(r: &Row) -> rusqlite::Result<FaultRow> {
        Ok(FaultRow {
            kind: r.get("kind")?,
            since: r.get("since")?,
            last: r.get("last")?,
            error: r.get("error")?,
            next_try: r.get("next_try")?,
        })
    }
}

/// A `drafts` row (INT-7, INT-8).
#[derive(Debug, Clone, PartialEq)]
pub struct DraftRow {
    pub key: String,
    pub repo: String,
    pub source: String,
    pub intent: Option<String>,
    pub slug: Option<String>,
    pub pr: Option<i64>,
    pub pr_url: Option<String>,
    pub step: String,
    pub tries: i64,
    pub created: f64,
    pub updated: f64,
}

impl DraftRow {
    pub fn from_row(r: &Row) -> rusqlite::Result<DraftRow> {
        Ok(DraftRow {
            key: r.get("key")?,
            repo: r.get("repo")?,
            source: r.get("source")?,
            intent: r.get("intent")?,
            slug: r.get("slug")?,
            pr: r.get("pr")?,
            pr_url: r.get("pr_url")?,
            step: r.get("step")?,
            tries: r.get("tries")?,
            created: r.get("created")?,
            updated: r.get("updated")?,
        })
    }
}
