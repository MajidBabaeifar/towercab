//! A mission: one intent's attempt (or a revert, a rehearsal) as a typed `missions` row
//! (loop.md **Schema**).

use std::error::Error;

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::config::Config;
use crate::db::sql;
use crate::intents::Intent;
pub use crate::machine::Kind;
use crate::machine::Stage;
use crate::runloop::Tick;

/// The `missions` columns a transition or a record may set (`Outcome::set`, `Ctx::record`).
pub const COLUMNS: [&str; 46] = [
    "kind",
    "intent",
    "repo",
    "attempt",
    "stage",
    "step",
    "busy",
    "unclean",
    "from_stage",
    "waiting",
    "why",
    "continued",
    "held",
    "model",
    "a_at_pick",
    "session",
    "session_used",
    "run_session",
    "checkout",
    "branch",
    "base_sha",
    "head",
    "pr",
    "pr_url",
    "pushed_at",
    "feedback_seen",
    "merged_by",
    "merge_sha",
    "revert_branch",
    "verify_repairs",
    "ci_repairs",
    "sync_rounds",
    "retries",
    "retry_at",
    "limit_model",
    "step_secs",
    "child_pid",
    "child_start",
    "child_kind",
    "child_since",
    "cost_usd",
    "agent_secs",
    "data",
    "created",
    "updated",
    "finished",
];

/// `step` while a stage's entry effects are due (LOOP-6).
pub const ENTER: &str = "enter";

#[derive(Debug, Clone, PartialEq)]
pub struct Mission {
    pub id: i64,
    pub kind: Kind,
    /// `None` for a rehearsal.
    pub intent: Option<String>,
    pub repo: String,
    pub attempt: u32,
    pub stage: Stage,
    /// `enter`: entry effects due; empty: the handler's turn; else its recorded step.
    pub step: String,
    pub busy: bool,
    pub unclean: u32,
    pub from_stage: Option<Stage>,
    pub waiting: Option<String>,
    pub why: Option<String>,
    pub continued: u32,
    pub held: bool,
    pub model: String,
    pub a_at_pick: Option<u8>,
    pub session: String,
    pub session_used: bool,
    pub run_session: Option<String>,
    /// Relative to the home (`work/<id>-<attempt>`).
    pub checkout: String,
    pub branch: Option<String>,
    pub base_sha: Option<String>,
    pub head: Option<String>,
    pub pr: Option<u64>,
    pub pr_url: Option<String>,
    pub pushed_at: Option<f64>,
    pub feedback_seen: Option<String>,
    pub merged_by: Option<String>,
    pub merge_sha: Option<String>,
    pub revert_branch: Option<String>,
    pub verify_repairs: u32,
    pub ci_repairs: u32,
    pub sync_rounds: u32,
    pub retries: u32,
    pub retry_at: Option<f64>,
    pub limit_model: Option<String>,
    pub step_secs: f64,
    pub child_pid: Option<i64>,
    pub child_start: Option<i64>,
    pub child_kind: Option<String>,
    pub child_since: Option<f64>,
    pub cost_usd: f64,
    pub agent_secs: f64,
    pub data: String,
    pub created: f64,
    pub updated: f64,
    pub finished: Option<f64>,
}

fn parsed<T: std::str::FromStr<Err = String>>(r: &Row, col: &str) -> rusqlite::Result<T> {
    let s: String = r.get(col)?;
    s.parse().map_err(|e: String| {
        let idx = r.as_ref().column_index(col).unwrap_or(0);
        rusqlite::Error::FromSqlConversionFailure(
            idx,
            Type::Text,
            Box::<dyn Error + Send + Sync>::from(e),
        )
    })
}

impl Mission {
    pub fn from_row(r: &Row) -> rusqlite::Result<Mission> {
        let from_stage: Option<String> = r.get("from_stage")?;
        Ok(Mission {
            id: r.get("id")?,
            kind: parsed(r, "kind")?,
            intent: r.get("intent")?,
            repo: r.get("repo")?,
            attempt: r.get("attempt")?,
            stage: parsed(r, "stage")?,
            step: r.get("step")?,
            busy: r.get("busy")?,
            unclean: r.get("unclean")?,
            from_stage: from_stage.and_then(|s| s.parse().ok()),
            waiting: r.get("waiting")?,
            why: r.get("why")?,
            continued: r.get("continued")?,
            held: r.get("held")?,
            model: r.get("model")?,
            a_at_pick: r.get("a_at_pick")?,
            session: r.get("session")?,
            session_used: r.get("session_used")?,
            run_session: r.get("run_session")?,
            checkout: r.get("checkout")?,
            branch: r.get("branch")?,
            base_sha: r.get("base_sha")?,
            head: r.get("head")?,
            pr: r.get::<_, Option<i64>>("pr")?.map(|n| n as u64),
            pr_url: r.get("pr_url")?,
            pushed_at: r.get("pushed_at")?,
            feedback_seen: r.get("feedback_seen")?,
            merged_by: r.get("merged_by")?,
            merge_sha: r.get("merge_sha")?,
            revert_branch: r.get("revert_branch")?,
            verify_repairs: r.get("verify_repairs")?,
            ci_repairs: r.get("ci_repairs")?,
            sync_rounds: r.get("sync_rounds")?,
            retries: r.get("retries")?,
            retry_at: r.get("retry_at")?,
            limit_model: r.get("limit_model")?,
            step_secs: r.get("step_secs")?,
            child_pid: r.get("child_pid")?,
            child_start: r.get("child_start")?,
            child_kind: r.get("child_kind")?,
            child_since: r.get("child_since")?,
            cost_usd: r.get("cost_usd")?,
            agent_secs: r.get("agent_secs")?,
            data: r.get("data")?,
            created: r.get("created")?,
            updated: r.get("updated")?,
            finished: r.get("finished")?,
        })
    }

    /// The intent id, or (a rehearsal) the checkout's name.
    pub fn label(&self) -> String {
        self.intent.clone().unwrap_or_else(|| {
            self.checkout
                .rsplit('/')
                .next()
                .unwrap_or(&self.checkout)
                .to_string()
        })
    }

    /// The mission's waiting reason as Towercab wrote it.
    pub fn waiting(&self) -> Option<crate::machine::Waiting> {
        self.waiting
            .as_deref()
            .and_then(crate::machine::Waiting::parse)
    }

    /// The child's process is recorded.
    pub fn has_child(&self) -> bool {
        self.child_pid.is_some()
    }
}

fn query(
    conn: &Connection,
    sql_text: &str,
    p: impl rusqlite::Params,
) -> Result<Vec<Mission>, String> {
    let mut q = conn.prepare(sql_text).map_err(sql)?;
    q.query_map(p, Mission::from_row)
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

/// Mission `id`.
pub fn get(conn: &Connection, id: i64) -> Result<Mission, String> {
    conn.query_row(
        "SELECT * FROM missions WHERE id = ?1",
        [id],
        Mission::from_row,
    )
    .map_err(sql)
}

/// Every mission not `done` or `stopped`, oldest first.
pub fn unfinished(conn: &Connection) -> Result<Vec<Mission>, String> {
    query(
        conn,
        "SELECT * FROM missions WHERE stage NOT IN ('done', 'stopped') ORDER BY id",
        [],
    )
}

/// Missions whose entry effects are due (`step = 'enter'`, finished ones included).
pub fn entering(conn: &Connection) -> Result<Vec<Mission>, String> {
    query(
        conn,
        "SELECT * FROM missions WHERE step = 'enter' ORDER BY id",
        [],
    )
}

/// Every attempt of an intent, oldest first.
pub fn for_intent(conn: &Connection, intent: &str) -> Result<Vec<Mission>, String> {
    query(
        conn,
        "SELECT * FROM missions WHERE intent = ?1 ORDER BY attempt, id",
        [intent],
    )
}

/// The intent's unfinished mission.
pub fn unfinished_for(conn: &Connection, intent: &str) -> Result<Option<Mission>, String> {
    conn.query_row(
        "SELECT * FROM missions WHERE intent = ?1 AND stage NOT IN ('done', 'stopped')",
        [intent],
        Mission::from_row,
    )
    .optional()
    .map_err(sql)
}

/// What a new attempt starts with.
#[derive(Debug, Clone, PartialEq)]
pub struct NewMission {
    pub intent: String,
    pub slug: String,
    pub repo: String,
    pub model: String,
    pub a: Option<u8>,
    /// At least this attempt (the intent's `attempts` + 1, or the replaced one's + 1).
    pub min_attempt: u32,
}

impl NewMission {
    /// From an intent (LOOP-5): `model` = its `model` else `[agent].model`; `a_at_pick` = `a`.
    pub fn of(intent: &Intent, config: &Config) -> NewMission {
        NewMission {
            intent: intent.id.clone(),
            slug: intent.slug.clone(),
            repo: intent.repo().to_string(),
            model: intent
                .model()
                .map(str::to_string)
                .unwrap_or_else(|| config.agent.model.clone()),
            a: intent.a(),
            min_attempt: intent.attempts().unwrap_or(0) + 1,
        }
    }
}

/// `towercab/<id>-<slug>`, attempt ≥ 2: `…-<attempt>`.
pub fn branch(id: &str, slug: &str, attempt: u32) -> String {
    if attempt >= 2 {
        format!("towercab/{id}-{slug}-{attempt}")
    } else {
        format!("towercab/{id}-{slug}")
    }
}

/// Inserts a mission at `pick` (LOOP-5): `attempt` = the intent's last + 1, a new session
/// uuid, checkout `work/<id>-<attempt>`, branch [`branch`]. Fails while the intent has an
/// unfinished mission (`missions_one_per_intent`).
pub fn insert(conn: &Connection, new: &NewMission, tick: Tick) -> Result<Mission, String> {
    let last: Option<u32> = conn
        .query_row(
            "SELECT MAX(attempt) FROM missions WHERE intent = ?1",
            [&new.intent],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let attempt = (last.unwrap_or(0) + 1).max(new.min_attempt);
    let now = tick.unix();
    conn.execute(
        "INSERT INTO missions (kind, intent, repo, attempt, stage, step, model, a_at_pick, session,
           checkout, branch, created, updated)
         VALUES ('intent', ?1, ?2, ?3, 'pick', 'enter', ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            new.intent,
            new.repo,
            attempt,
            new.model,
            new.a,
            uuid::Uuid::new_v4().to_string(),
            format!("work/{}-{attempt}", new.intent),
            branch(&new.intent, &new.slug, attempt),
            now
        ],
    )
    .map_err(|e| format!("{}: {}", new.intent, sql(e)))?;
    get(conn, conn.last_insert_rowid())
}

/// [`insert`] for an intent (LOOP-5's pick).
pub fn insert_pick(
    conn: &Connection,
    intent: &Intent,
    config: &Config,
    tick: Tick,
) -> Result<Mission, String> {
    insert(conn, &NewMission::of(intent, config), tick)
}
