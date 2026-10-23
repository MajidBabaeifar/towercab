//! Maintain (MNT, specs/maintain.md): bands on Towercab's own process metrics, judged in code
//! (Western Electric) once per completed period; a breach is logged, diagnosed into a draft
//! intent PR, or proposed with pre-approved runbooks; lessons and incident eval cases close
//! the loop.
//!
//! The pass calls [`Watch::round`] (Prometheus on a helper thread: never blocks); the drafts
//! poll calls [`settle`] (comments, lessons, incident cases: GitHub and `intents` writes); the
//! diagnosis itself is the drafter's child (`drafts::next_run`, `drafts::finish_run`).

pub mod bands;
pub mod detect;
pub mod diagnose;
pub mod lessons;
pub mod prom;

use std::collections::BTreeMap;
use std::fs;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::config::Config;
use crate::db::{Db, set_meta, sql};
use crate::drafts;
use crate::exes::Exes;
use crate::github::GhError;
use crate::handler::Ctx;
use crate::home::Home;
use crate::intents::{Intent, Stage as IStage};
use crate::metrics::{self, Ev, Metric};
use crate::mission;
use crate::outbox::{self, Notice, num};
use crate::runloop::Tick;

use bands::{Action, Band};
use detect::Verdict;
use diagnose::utc;
use prom::{Fetch, Query};

/// Bands are read and the due ones queried this often.
pub const ROUND: Duration = Duration::from_secs(300);

/// A period counts as completed this long after its end (Prometheus takes samples up to
/// 10 min old).
pub const GRACE: f64 = 600.0;

/// Periods of context: a breach's events and merges, a lesson's wait for a value.
pub const CONTEXT: u64 = 8;

/// Transitions a breach keeps (the newest).
pub const EVENTS: usize = 100;

/// The `drafts` key of a band's draft intent PR.
pub fn key(band: &str) -> String {
    format!("alert:{band}")
}

/// The repo a band's intent and `cap_repo` are for: its `repo`, else the Towercab repo.
pub fn band_repo(config: &Config, band: &Band) -> String {
    band.repo.clone().unwrap_or_else(|| {
        crate::pipeline::evals::towercab_repo(config)
            .map(|r| r.name)
            .unwrap_or_else(|| "towercab".into())
    })
}

/// The loop's watch over its bands (MNT-3): last period evaluated per band (in memory), the
/// next round, the query thread in flight.
#[derive(Debug, Default)]
pub struct Watch {
    checked: BTreeMap<String, f64>,
    due: Option<Duration>,
    fetch: Option<(Fetch, Vec<(Band, f64)>)>,
    warned: BTreeMap<String, String>,
}

impl Watch {
    /// The period end `band` was last evaluated for.
    pub fn checked(&self, band: &str) -> Option<f64> {
        self.checked.get(band).copied()
    }

    /// A query thread is in flight.
    pub fn fetching(&self) -> bool {
        self.fetch.is_some()
    }

    fn warn(&mut self, kind: &str, msg: String) {
        if self.warned.get(kind) != Some(&msg) {
            eprintln!("towercab: {msg}");
            self.warned.insert(kind.to_string(), msg);
        }
    }

    fn ok(&mut self, kind: &str) {
        self.warned.remove(kind);
    }

    /// One pass's share: the answers of a query thread that finished are judged and recorded;
    /// else every [`ROUND`] `bands.yaml` is read, lessons whose band is gone or quiet are let
    /// go, and the due bands' range queries start on a new thread. Never waits on Prometheus
    /// and never fails the pass: a failure is logged (once per message) and the band stays due.
    pub fn round(&mut self, config: &Config, exes: &Exes, db: &Db, home: &Home, tick: Tick) {
        if let Some((fetch, _)) = &self.fetch {
            let Some(answers) = fetch.poll() else {
                return;
            };
            let due = self.fetch.take().map(|(_, d)| d).unwrap_or_default();
            let answers = match answers {
                Ok(a) => a,
                Err(e) => {
                    self.warn("prometheus", e);
                    return;
                }
            };
            self.ok("prometheus");
            for (name, r) in answers {
                let Some((band, end)) = due.iter().find(|(b, _)| b.name == name) else {
                    continue;
                };
                let kind = format!("band {name}");
                match r.and_then(|points| evaluate(db, config, home, band, &points, tick)) {
                    Err(e) => self.warn(&kind, format!("band {name}: {e}")),
                    Ok(()) => {
                        self.ok(&kind);
                        self.checked.insert(name.clone(), *end);
                    }
                }
            }
            return;
        }
        if self.due.is_some_and(|d| tick.mono < d) {
            return;
        }
        self.due = Some(tick.mono + ROUND);
        let bands = match bands::read(config, exes) {
            Ok(Some(b)) => b,
            // No Towercab clone yet: nothing to read, no lesson let go.
            Ok(None) => return,
            Err(e) => {
                self.warn("bands", e);
                return;
            }
        };
        self.ok("bands");
        let now = tick.unix();
        match let_go(db.conn(), &bands, now) {
            Ok(()) => self.ok("lessons"),
            Err(e) => self.warn("lessons", format!("lessons: {e}")),
        }
        let due: Vec<(Band, f64)> = bands
            .into_iter()
            .map(|b| {
                let e = b.end(now);
                (b, e)
            })
            .filter(|(b, e)| self.checked.get(&b.name).is_none_or(|c| e > c))
            .collect();
        if due.is_empty() {
            return;
        }
        let queries = due
            .iter()
            .map(|(b, e)| Query {
                band: b.name.clone(),
                query: b.query.clone(),
                start: e - (b.points().saturating_sub(1) * b.period) as f64,
                end: *e,
                step: b.period,
            })
            .collect();
        self.fetch = Some((
            Fetch::start(&config.metrics.prometheus, queries, prom::TIMEOUT),
            due,
        ));
    }
}

/// A band's points judged (MNT-3): a verdict recorded with its action, lessons waiting on the
/// band given their value.
pub fn evaluate(
    db: &Db,
    config: &Config,
    home: &Home,
    band: &Band,
    points: &[(f64, f64)],
    tick: Tick,
) -> Result<(), String> {
    if let Some(v) = detect::detect(points, band.side, band.min_shift) {
        record(db, config, home, band, &v, points, tick)?;
    }
    evaluated(db.conn(), band, points, detect::baseline(points))
}

/// The facts a diagnosis gets (`breach.json`): the band, the verdict, the series, and the
/// transitions and merges of the last [`CONTEXT`] periods.
pub fn breach_json(
    conn: &Connection,
    band: &Band,
    v: &Verdict,
    series: &[(f64, f64)],
    now: f64,
) -> Result<Value, String> {
    let from = v.point.0 - (CONTEXT * band.period) as f64;
    let mut q = conn
        .prepare(
            "SELECT t.at, m.intent, m.repo, t.from_stage, t.event, t.to_stage, t.why
             FROM transitions t JOIN missions m ON m.id = t.mission
             WHERE t.at >= ?1 ORDER BY t.id DESC LIMIT ?2",
        )
        .map_err(sql)?;
    let mut events: Vec<String> = q
        .query_map(params![from, EVENTS as i64], |r| {
            let why: Option<String> = r.get(6)?;
            Ok(format!(
                "{} {} {}: {} -{}-> {}{}",
                utc(r.get(0)?),
                r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "-".into()),
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                why.map(|w| format!(": {}", outbox::one_line(&w)))
                    .unwrap_or_default()
            ))
        })
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)?;
    events.reverse();
    let mut q = conn
        .prepare(
            "SELECT t.at, m.intent, m.repo, m.pr_url, m.merged_by
             FROM transitions t JOIN missions m ON m.id = t.mission
             WHERE t.to_stage = 'deploy' AND t.from_stage != 'deploy' AND t.at >= ?1
               AND m.pr_url IS NOT NULL ORDER BY t.id",
        )
        .map_err(sql)?;
    let merges: Vec<Value> = q
        .query_map([from], |r| {
            Ok(json!({
                "at": r.get::<_, f64>(0)?,
                "intent": r.get::<_, Option<String>>(1)?,
                "repo": r.get::<_, String>(2)?,
                "pr": r.get::<_, String>(3)?,
                "merged_by": r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "none".into()),
            }))
        })
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)?;
    Ok(json!({
        "band": {
            "name": band.name, "metric": band.metric, "query": band.query,
            "period": band.period, "baseline": band.baseline, "side": band.side.as_str(),
            "repo": band.repo,
        },
        "tier": v.tier.as_str(), "point": v.point.0, "value": v.point.1,
        "mean": v.mean, "sigma": v.sigma, "at": now,
        "series": series.iter().map(|(t, x)| json!([t, x])).collect::<Vec<_>>(),
        "events": events,
        "merges": merges,
    }))
}

/// One breach event (MNT-3) with its tier's action (MNT-4..6), in one transaction: the
/// `breaches` row (a known (band, tier, point) → nothing, `false`), `towercab.breaches`, the
/// log line; a draft (`diagnose`, `propose` with `pull_request`): a new `alert:<band>` row and
/// its `breach.json` when none is pending or open, else the breach comments later; runbooks
/// and the `triage` message for `propose`.
pub fn record(
    db: &Db,
    config: &Config,
    home: &Home,
    band: &Band,
    v: &Verdict,
    series: &[(f64, f64)],
    tick: Tick,
) -> Result<bool, String> {
    let now = tick.unix();
    let action = band.action(v.tier);
    let repo = band_repo(config, band);
    let tier = v.tier.as_str();
    db.tx(|tx| {
        let n = tx
            .execute(
                "INSERT OR IGNORE INTO breaches (band, tier, point, value, mean, sigma, at, step)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'done')",
                params![band.name, tier, v.point.0, v.point.1, v.mean, v.sigma, now],
            )
            .map_err(sql)?;
        if n == 0 {
            return Ok(false);
        }
        metrics::add(
            Metric::Breaches,
            1.0,
            &[("band", &band.name), ("tier", tier)],
            &Ev::none(),
        );
        eprintln!(
            "towercab: band {} at {tier}: value {} · mean {} · σ {}",
            band.name,
            num(v.point.1),
            num(v.mean),
            num(v.sigma)
        );
        let key = key(&band.name);
        let draft = drafts::get(tx, &key)?;
        let open_url = draft
            .as_ref()
            .filter(|(_, r)| r.step == "link" || r.step == "open")
            .and_then(|(_, r)| r.pr_url.clone());
        let mut step = "done";
        if action.drafts() {
            let pending = draft
                .as_ref()
                .is_some_and(|(_, r)| !drafts::FINISHED.contains(&r.step.as_str()));
            if pending {
                step = "comment";
            } else {
                if draft.is_some() {
                    tx.execute("DELETE FROM drafts WHERE key = ?1", [&key])
                        .map_err(sql)?;
                    tx.execute(
                        "UPDATE breaches SET step = 'done' WHERE band = ?1 AND step IN ('diagnose', 'comment')",
                        [&band.name],
                    )
                    .map_err(sql)?;
                }
                tx.execute(
                    "INSERT INTO drafts (key, repo, source, step, created, updated)
                     VALUES (?1, ?2, ?1, 'draft', ?3, ?3)",
                    params![key, repo, now],
                )
                .map_err(sql)?;
                let dir = home.runs(&format!("draft-{}", tx.last_insert_rowid()));
                let breach = breach_json(tx, band, v, series, now)?;
                let _ = fs::remove_dir_all(&dir);
                fs::create_dir_all(&dir)
                    .and_then(|()| fs::write(dir.join("breach.json"), breach.to_string()))
                    .map_err(|e| format!("{}: {e}", dir.display()))?;
                step = "diagnose";
            }
        }
        if let Action::Propose { cap_repo, pause, .. } = action {
            if cap_repo {
                if config.repo(&repo).is_ok() {
                    tx.execute(
                        "INSERT INTO repo_caps (repo, capped, why, since) VALUES (?1, 1, ?2, ?3)
                         ON CONFLICT (repo) DO UPDATE SET capped = 1",
                        params![repo, format!("{} at 3σ", band.name), now],
                    )
                    .map_err(sql)?;
                } else {
                    eprintln!(
                        "towercab: band {}: runbook:cap_repo: {repo} isn't in [repos]",
                        band.name
                    );
                }
            }
            if pause {
                set_meta(tx, "paused", "1")?;
            }
            let notice = Notice::Triage {
                band: band.name.clone(),
                value: v.point.1,
                mean: v.mean,
                sigma: v.sigma,
                pr_url: open_url,
            };
            outbox::notify(tx, &notice, &(v.point.0 as i64).to_string(), now)?;
        }
        tx.execute(
            "UPDATE breaches SET step = ?4 WHERE band = ?1 AND tier = ?2 AND point = ?3",
            params![band.name, tier, v.point.0, step],
        )
        .map_err(sql)?;
        Ok(true)
    })
}

/// MNT-8: each lesson waiting on `band` gets the band's first point whose period began at or
/// after the fix (`within` = |v − mean| ≤ σ, unknown without `base`) → `write`.
pub fn evaluated(
    conn: &Connection,
    band: &Band,
    points: &[(f64, f64)],
    base: Option<(f64, f64)>,
) -> Result<(), String> {
    let waiting: Vec<(String, f64)> = {
        let mut q = conn
            .prepare("SELECT intent, fixed FROM lessons WHERE band = ?1 AND step = 'wait'")
            .map_err(sql)?;
        q.query_map([&band.name], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(sql)?
            .collect::<Result<_, _>>()
            .map_err(sql)?
    };
    for (intent, fixed) in waiting {
        let Some((t, value)) = points
            .iter()
            .copied()
            .find(|(t, _)| t - band.period as f64 >= fixed)
        else {
            continue;
        };
        let within = base.map(|(m, s)| (value - m).abs() <= s);
        conn.execute(
            "UPDATE lessons SET point = ?2, value = ?3, within = ?4, step = 'write' WHERE intent = ?1",
            params![intent, t, value, within],
        )
        .map_err(sql)?;
    }
    Ok(())
}

/// MNT-8: lessons waiting on a band no longer in `bands.yaml`, or for more than [`CONTEXT`]
/// periods, are written without a value.
fn let_go(conn: &Connection, bands: &[Band], now: f64) -> Result<(), String> {
    let waiting: Vec<(String, String, f64)> = {
        let mut q = conn
            .prepare("SELECT intent, band, fixed FROM lessons WHERE step = 'wait'")
            .map_err(sql)?;
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(sql)?
            .collect::<Result<_, _>>()
            .map_err(sql)?
    };
    for (intent, band, fixed) in waiting {
        let gone = match bands.iter().find(|b| b.name == band) {
            None => true,
            Some(b) => now - fixed > (CONTEXT * b.period) as f64,
        };
        if gone {
            conn.execute(
                "UPDATE lessons SET step = 'write' WHERE intent = ?1",
                [&intent],
            )
            .map_err(sql)?;
        }
    }
    Ok(())
}

/// MNT-7: an `alert:<band>` draft accepted (merged) or rejected (closed), counted in the
/// transaction that records it.
pub fn triaged(conn: &Connection, band: &str, result: &str) -> Result<(), String> {
    let (a, d) = if result == "accepted" { (1, 0) } else { (0, 1) };
    conn.execute(
        "INSERT INTO triage (band, accepted, dismissed) VALUES (?1, ?2, ?3)
         ON CONFLICT (band) DO UPDATE SET accepted = accepted + excluded.accepted,
           dismissed = dismissed + excluded.dismissed",
        params![band, a, d],
    )
    .map(drop)
    .map_err(sql)
}

/// Dismissals per band (`status`): bands with one, by name.
pub fn dismissed(conn: &Connection) -> Result<Vec<(String, i64)>, String> {
    let mut q = conn
        .prepare("SELECT band, dismissed FROM triage WHERE dismissed > 0 ORDER BY band")
        .map_err(sql)?;
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

/// MNT-5: the breaches of `band` at `diagnose` once its draft is open → `done`, with
/// `breach_to_intent.duration` (MET-27) and, when the diagnosis named a merged PR it was
/// given as the cause, `escapes{where="alert"}`; its draft finished or gone → `done`.
pub fn opened(cx: &Ctx<'_>, band: &str) -> Result<(), String> {
    let conn = cx.db.conn();
    let row = drafts::get(conn, &key(band))?;
    let done = |tx: &Connection| {
        tx.execute(
            "UPDATE breaches SET step = 'done' WHERE band = ?1 AND step = 'diagnose'",
            [band],
        )
        .map(drop)
        .map_err(sql)
    };
    match row {
        Some((rowid, r)) if r.step == "link" || r.step == "open" => {
            let cause = fs::read_to_string(
                cx.home
                    .runs(&format!("draft-{rowid}"))
                    .join(diagnose::CAUSE),
            )
            .unwrap_or_default();
            let ev = Ev {
                intent: r.intent.clone(),
                stage: None,
                pr: r.pr.map(|p| p as u64),
            };
            cx.db.tx(|tx| {
                let ats: Vec<f64> = {
                    let mut q = tx
                        .prepare("SELECT at FROM breaches WHERE band = ?1 AND step = 'diagnose'")
                        .map_err(sql)?;
                    q.query_map([band], |r| r.get(0))
                        .map_err(sql)?
                        .collect::<Result<_, _>>()
                        .map_err(sql)?
                };
                for at in &ats {
                    metrics::observe(
                        Metric::BreachToIntentDuration,
                        (r.updated - at).max(0.0),
                        &[("band", band)],
                        &ev,
                    );
                    if !cause.trim().is_empty() {
                        metrics::add(
                            Metric::Escapes,
                            1.0,
                            &[("repo", &r.repo), ("where", "alert")],
                            &ev,
                        );
                    }
                }
                done(tx)
            })
        }
        Some((_, r)) if !drafts::FINISHED.contains(&r.step.as_str()) => Ok(()),
        _ => done(conn),
    }
}

/// The drafts poll's share (MNT-5, MNT-8), each part tried, the first failure returned:
/// breaches whose draft opened → `done`; `comment` breaches commented on their band's open
/// draft; lessons rows for alert intents done; lessons due written; incident cases written.
pub fn settle(cx: &mut Ctx<'_>) -> Result<(), GhError> {
    let mut errors: Vec<GhError> = Vec::new();
    let bands: Vec<String> = {
        let mut q = cx
            .db
            .conn()
            .prepare("SELECT DISTINCT band FROM breaches WHERE step = 'diagnose' ORDER BY band")
            .map_err(|e| GhError::Failed(sql(e)))?;
        q.query_map([], |r| r.get(0))
            .and_then(|r| r.collect::<Result<_, _>>())
            .map_err(|e| GhError::Failed(sql(e)))?
    };
    for b in bands {
        if let Err(e) = opened(cx, &b) {
            errors.push(GhError::Failed(e));
        }
    }
    for r in [
        comments(cx),
        find_lessons(cx).map_err(GhError::Failed),
        write_lessons(cx),
        incident_cases(cx),
    ] {
        if let Err(e) = r {
            errors.push(e);
        }
    }
    errors.into_iter().next().map_or(Ok(()), Err)
}

/// A breach's comment on its band's draft PR (MNT-5): one line.
pub fn comment_text(
    band: &str,
    tier: &str,
    point: f64,
    value: f64,
    mean: f64,
    sigma: f64,
) -> String {
    format!(
        "Breach: {band} at {tier} · value {} · mean {} · σ {} · {}",
        num(value),
        num(mean),
        num(sigma),
        utc(point)
    )
}

/// MNT-5: each `comment` breach, once its band's draft is open, commented there once → `done`;
/// its draft finished or gone first → `done`; still being opened → later.
fn comments(cx: &Ctx<'_>) -> Result<(), GhError> {
    type Row = (String, String, f64, f64, f64, f64);
    let rows: Vec<Row> = {
        let mut q = cx
            .db
            .conn()
            .prepare(
                "SELECT band, tier, point, value, mean, sigma FROM breaches
                 WHERE step = 'comment' ORDER BY at, band",
            )
            .map_err(|e| GhError::Failed(sql(e)))?;
        q.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .and_then(|r| r.collect::<Result<_, _>>())
        .map_err(|e| GhError::Failed(sql(e)))?
    };
    for (band, tier, point, value, mean, sigma) in rows {
        let row = drafts::get(cx.db.conn(), &key(&band)).map_err(GhError::Failed)?;
        match &row {
            Some((_, r)) if r.step == "link" || r.step == "open" => {
                let Some(pr) = r.pr else { continue };
                let text = comment_text(&band, &tier, point, value, mean, sigma);
                drafts::comment_pr_once(cx, pr as u64, &text)?;
            }
            Some((_, r)) if !drafts::FINISHED.contains(&r.step.as_str()) => continue,
            _ => {}
        }
        cx.db
            .conn()
            .execute(
                "UPDATE breaches SET step = 'done' WHERE band = ?1 AND tier = ?2 AND point = ?3",
                params![band, tier, point],
            )
            .map_err(|e| GhError::Failed(sql(e)))?;
        cx.probe.point();
    }
    Ok(())
}

/// MNT-8: a `lessons` row (`wait`) for each intent with `source: alert:<band>` and
/// `stage: done` that has none: `fixed` = its last mission's `finished` (else the intent's,
/// else now), `pr` = its `pr`.
fn find_lessons(cx: &Ctx<'_>) -> Result<(), String> {
    let listing = cx.store.scan();
    let conn = cx.db.conn();
    for i in listing.done.iter().chain(&listing.open) {
        let Some(band) = i.source().and_then(|s| s.strip_prefix("alert:")) else {
            continue;
        };
        if i.stage() != Some(IStage::Done) {
            continue;
        }
        let known: Option<i64> = conn
            .query_row("SELECT 1 FROM lessons WHERE intent = ?1", [&i.id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sql)?;
        if known.is_some() {
            continue;
        }
        let fixed = mission::for_intent(conn, &i.id)?
            .iter()
            .rev()
            .find_map(|m| m.finished)
            .or_else(|| i.finished().map(|t| t.timestamp() as f64))
            .unwrap_or_else(|| cx.tick.unix());
        conn.execute(
            "INSERT OR IGNORE INTO lessons (intent, band, pr, fixed, step) VALUES (?1, ?2, ?3, ?4, 'wait')",
            params![i.id, band, i.pr(), fixed],
        )
        .map_err(sql)?;
        cx.probe.point();
    }
    Ok(())
}

/// The breach an alert intent came from: its band's latest at or before `started` (none:
/// the latest).
fn anomaly_of(
    conn: &Connection,
    band: &str,
    started: Option<f64>,
) -> Result<Option<lessons::Anomaly>, String> {
    conn.query_row(
        "SELECT tier, point, value, mean, sigma FROM breaches WHERE band = ?1 AND at <= ?2
         ORDER BY at DESC, point DESC LIMIT 1",
        params![band, started.map_or(f64::MAX, |s| s + 1.0)],
        |r| {
            Ok(lessons::Anomaly {
                tier: r.get(0)?,
                point: r.get(1)?,
                value: r.get(2)?,
                mean: r.get(3)?,
                sigma: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(sql)
}

/// MNT-8: each lesson at `write` written to `lessons/<yymmdd>-<slug>.md` on `main` of
/// `intents` (`Store::put`: the same text again commits nothing) → `written`.
fn write_lessons(cx: &Ctx<'_>) -> Result<(), GhError> {
    type Row = (
        String,
        String,
        Option<String>,
        f64,
        Option<f64>,
        Option<f64>,
        Option<bool>,
    );
    let rows: Vec<Row> = {
        let mut q = cx
            .db
            .conn()
            .prepare(
                "SELECT intent, band, pr, fixed, point, value, within FROM lessons
                 WHERE step = 'write' ORDER BY fixed, intent",
            )
            .map_err(|e| GhError::Failed(sql(e)))?;
        q.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .and_then(|r| r.collect::<Result<_, _>>())
        .map_err(|e| GhError::Failed(sql(e)))?
    };
    let listing = cx.store.scan();
    let mut first: Option<GhError> = None;
    for (id, band, pr, fixed, point, value, within) in rows {
        let Some(intent) = listing
            .done
            .iter()
            .chain(&listing.open)
            .find(|i| i.id == id)
        else {
            first.get_or_insert(GhError::Failed(format!("lesson {id}: no such intent")));
            continue;
        };
        let started = intent.started().map(|t| t.timestamp() as f64);
        let lesson = lessons::Lesson {
            id: id.clone(),
            title: intent.title().to_string(),
            band: band.clone(),
            anomaly: anomaly_of(cx.db.conn(), &band, started).map_err(GhError::Failed)?,
            problem: intent.section("Problem").unwrap_or_default(),
            pr,
            after: point.zip(value).map(|(t, v)| (t, v, within)),
        };
        let rel = lessons::path(fixed, &intent.slug, *cx.tick.wall.offset());
        if let Err(e) = cx
            .store
            .put(&rel, &lessons::text(&lesson), &format!("lesson {id}"))
        {
            first.get_or_insert(GhError::Failed(format!("lesson {id}: {e}")));
            continue;
        }
        cx.probe.point();
        cx.db
            .conn()
            .execute(
                "UPDATE lessons SET step = 'written' WHERE intent = ?1",
                [&id],
            )
            .map_err(|e| GhError::Failed(sql(e)))?;
    }
    first.map_or(Ok(()), Err)
}

/// MNT-8: the intent's case is an incident: its source is `alert:*`, or a mission of it had a
/// `red` out of `e2e` (a merged change found broken).
pub fn incident(conn: &Connection, intent: &Intent) -> Result<bool, String> {
    if intent.source().is_some_and(|s| s.starts_with("alert:")) {
        return Ok(true);
    }
    Ok(incident_since(conn, intent)?.is_some())
}

/// When the intent's incident began (MET-27): an alert intent's `started` (the breach), else
/// its first `red` out of `e2e`.
pub fn incident_since(conn: &Connection, intent: &Intent) -> Result<Option<f64>, String> {
    if intent.source().is_some_and(|s| s.starts_with("alert:")) {
        return Ok(intent.started().map(|t| t.timestamp() as f64));
    }
    conn.query_row(
        "SELECT MIN(t.at) FROM transitions t JOIN missions m ON m.id = t.mission
         WHERE m.intent = ?1 AND t.from_stage = 'e2e' AND t.event = 'red'",
        [&intent.id],
        |r| r.get(0),
    )
    .map_err(sql)
}

/// MNT-8: the case of each mission with a `red` out of `e2e` whose `evals/<id>.json` isn't
/// incident yet, written now (`evals::write_case` marks it).
fn incident_cases(cx: &Ctx<'_>) -> Result<(), GhError> {
    let ids: Vec<i64> = {
        let mut q = cx
            .db
            .conn()
            .prepare(
                "SELECT DISTINCT m.id FROM missions m JOIN transitions t ON t.mission = m.id
                 WHERE t.from_stage = 'e2e' AND t.event = 'red' AND m.intent IS NOT NULL
                 ORDER BY m.id",
            )
            .map_err(|e| GhError::Failed(sql(e)))?;
        q.query_map([], |r| r.get(0))
            .and_then(|r| r.collect::<Result<_, _>>())
            .map_err(|e| GhError::Failed(sql(e)))?
    };
    let listing = cx.store.scan();
    let mut first: Option<GhError> = None;
    for id in ids {
        let m = mission::get(cx.db.conn(), id).map_err(GhError::Failed)?;
        let intent = m.intent.clone().unwrap_or_default();
        // A case is written from the open intent (a done one has its case, or never will).
        if !listing.open.iter().any(|i| i.id == intent) {
            continue;
        }
        let case = crate::pipeline::evals::read_case(cx.store, &intent);
        if case.is_some_and(|c| c.incident) {
            continue;
        }
        if let Err(e) = crate::pipeline::evals::write_case(cx, &m) {
            let why = match e {
                crate::handler::StepError::Env(_, w) | crate::handler::StepError::Bug(w) => w,
            };
            first.get_or_insert(GhError::Failed(format!("incident case {intent}: {why}")));
            continue;
        }
        cx.probe.point();
    }
    first.map_or(Ok(()), Err)
}
