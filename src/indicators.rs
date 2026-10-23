//! Where each metric comes from (metrics.md **Code**): the transitions `machine::apply` writes,
//! the entry effects `machine::enter` runs (git), a Claude run's result, and the loop's gauges.
//! Every function here only records (`src/metrics.rs`); a failure to derive a value is the
//! caller's to log, never the loop's to stop on.

use std::collections::BTreeSet;
use std::path::Path;

use chrono::{DateTime, FixedOffset};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::autonomy::{Gate, Hold};
use crate::claude::ClaudeResult;
use crate::db::sql;
use crate::handler::{Ctx, Outcome};
use crate::intents::{Intent, Listing};
use crate::machine::{Apply, Event, Stage, Waiting};
use crate::metrics::{self, Ev, Metric};
use crate::mission::{self, Kind, Mission};
use crate::priority;

/// The kind of an intent's `source` (MET-15, MET-23): `me`, `issue`, `alert`, `review`; none or
/// not listed → `me`.
pub fn source_kind(source: Option<&str>) -> &'static str {
    let s = source.unwrap_or("me");
    ["issue", "alert", "review"]
        .into_iter()
        .find(|k| s == *k || s.starts_with(&format!("{k}:")))
        .unwrap_or("me")
}

/// `data.gate.label` (metrics.md **Gate labels**): a merge `a<n>` (effective `a`) or
/// `risk_low`; a hold its kind.
pub fn gate_label(g: &Gate, a: Option<u8>) -> String {
    match g {
        Gate::Merge => a.map_or_else(|| "risk_low".into(), |a| format!("a{a}")),
        Gate::Approval(h) => match h {
            Hold::Frozen => "frozen".into(),
            Hold::CiNotGreen => "ci_red".into(),
            Hold::NoCi => "no_ci".into(),
            Hold::Unlock => "unlock".into(),
            Hold::EvalsRed => "evals_red".into(),
            Hold::Cap(_) => "capped".into(),
            Hold::A(n) => format!("a{n}"),
            Hold::NotApproved => "not_approved".into(),
            Hold::RiskHigh => "risk_high".into(),
        },
    }
}

/// Events that end a segment of a stage without moving it (MET-14).
const ENDS: [&str; 8] = [
    "ok",
    "red",
    "blocked",
    "timeout",
    "bad_result",
    "limit",
    "crash",
    "interrupted",
];

/// MET-14's `result` of `event` at a driven stage (`moves`: it leaves the stage; `unexpected`:
/// the machine took it as a bug); `None`: no segment ends.
fn segment_result(event: Event, moves: bool, unexpected: bool) -> Option<&'static str> {
    if unexpected {
        return Some("crash");
    }
    Some(match event {
        Event::Ok => "ok",
        Event::Red => "red",
        Event::Blocked => "blocked",
        Event::Timeout | Event::BadResult => "timeout",
        Event::Limit => "limit",
        Event::Crash => "crash",
        Event::Interrupted => "interrupted",
        Event::EnvFail | Event::Pause | Event::Resume => return None,
        _ if moves => "interrupted",
        _ => return None,
    })
}

/// A mission's earlier transitions: (from, event, to, at), oldest first.
fn history(tx: &Connection, id: i64) -> Result<Vec<(String, String, String, f64)>, String> {
    let mut q = tx
        .prepare("SELECT from_stage, event, to_stage, at FROM transitions WHERE mission = ?1 ORDER BY id")
        .map_err(sql)?;
    q.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

/// The first exit from `stage` (to another stage): its time.
fn first_exit(h: &[(String, String, String, f64)], stage: &str) -> Option<f64> {
    h.iter()
        .find(|(f, _, t, _)| f == stage && t != stage)
        .map(|r| r.3)
}

fn data_of(m: &Mission) -> Value {
    serde_json::from_str(&m.data).unwrap_or(Value::Null)
}

/// An intent's created time: `started`, else its id's time (in `offset`).
fn created(i: Option<&Intent>, id: &str, offset: FixedOffset) -> Option<DateTime<FixedOffset>> {
    i.and_then(Intent::started)
        .or_else(|| priority::id_time(id, offset))
}

fn unix(t: DateTime<FixedOffset>) -> f64 {
    t.timestamp_micros() as f64 / 1e6
}

/// What a transition says (from `machine::apply_tx`, in its transaction, before its
/// `transitions` row): MET-14, 15, 17; MET-24 at the merge; MET-25's escapes; MET-26's
/// review.first, feedback.rounds, gate.wait, ci.triage, restore.
pub fn transition(
    tx: &Connection,
    ax: &Apply,
    cur: &Mission,
    o: &Outcome,
    to: Stage,
    unexpected: bool,
    stored: &Mission,
) -> Result<(), String> {
    let now = ax.tick.unix();
    let ev = Ev::of(cur);
    let repo = cur.repo.as_str();
    let stage = cur.stage.as_str();
    let moves = to != cur.stage;
    let h = history(tx, cur.id)?;
    let waiting = stored.waiting.as_deref().and_then(Waiting::parse);
    let entered_wait = moves && to == Stage::Blocked;

    // MET-14: a segment of a driven stage ends.
    if cur.stage.driven()
        && let Some(result) = segment_result(o.event, moves, unexpected)
    {
        let start = h
            .iter()
            .rev()
            .find(|(f, e, t, _)| t == stage && (f != stage || ENDS.contains(&e.as_str())))
            .map_or(cur.created, |r| r.3);
        metrics::observe(
            Metric::StageDuration,
            (now - start).max(0.0),
            &[("repo", repo), ("stage", stage), ("result", result)],
            &ev,
        );
    }

    // MET-17: CI.
    if cur.stage == Stage::Ci && !unexpected {
        let result = match (o.event, waiting) {
            (Event::Ok, _) => Some(
                data_of(stored)["ci"]["result"]
                    .as_str()
                    .filter(|r| ["green", "flaky", "none"].contains(r))
                    .unwrap_or("green")
                    .to_string(),
            ),
            (Event::Red, _) => Some("red".into()),
            (Event::Blocked, Some(Waiting::CiRed)) => Some("red".into()),
            (Event::Blocked, Some(Waiting::CiStuck | Waiting::NoCiChecks)) => {
                Some("timeout".into())
            }
            _ => None,
        };
        if let Some(result) = result {
            let before = h
                .iter()
                .any(|(f, e, _, _)| f == "ci" && ["ok", "red", "blocked"].contains(&e.as_str()));
            let first = if before { "no" } else { "yes" };
            metrics::add(
                Metric::CiResult,
                1.0,
                &[("repo", repo), ("result", &result), ("first", first)],
                &ev,
            );
        }
        match (o.event, waiting) {
            (Event::Red, _) => {
                metrics::add(Metric::CiRepairs, 1.0, &[("repo", repo)], &ev);
                metrics::add(
                    Metric::CiTriage,
                    1.0,
                    &[("repo", repo), ("by", "worker")],
                    &ev,
                );
            }
            (Event::Blocked, Some(Waiting::CiRed)) => {
                metrics::add(Metric::CiTriage, 1.0, &[("repo", repo), ("by", "me")], &ev)
            }
            _ => {}
        }
    }

    // MET-26: the first review after the PR was ready.
    if cur.stage == Stage::Review
        && o.event == Event::Ok
        && !h.iter().any(|(f, e, _, _)| f == "review" && e == "ok")
        && let Some(ready) = first_exit(&h, "publish")
    {
        metrics::observe(
            Metric::ReviewFirstDuration,
            (now - ready).max(0.0),
            &[("repo", repo)],
            &ev,
        );
    }

    // MET-26: a wait on me ends.
    if cur.stage.waits() && moves {
        let gate = match cur.stage {
            Stage::ApprovalSpec => "spec",
            Stage::ApprovalMerge => "merge",
            Stage::ApprovalRelease => "release",
            _ => match cur.waiting.as_deref().and_then(Waiting::parse) {
                Some(Waiting::AnswerTheQuestion) => "answer",
                Some(Waiting::ProtectedPathChanged) => "protected",
                _ => "other",
            },
        };
        let since = h
            .iter()
            .rev()
            .find(|(f, _, t, _)| t == stage && f != stage)
            .map_or(cur.updated, |r| r.3);
        metrics::observe(
            Metric::GateWaitDuration,
            (now - since).max(0.0),
            &[("repo", repo), ("gate", gate)],
            &ev,
        );
    }

    // MET-25: a merged change found broken.
    let escaped = (cur.stage == Stage::E2e && o.event == Event::Red)
        || (entered_wait
            && matches!(
                waiting,
                Some(Waiting::E2eRedAfterYourMerge(_) | Waiting::ProductionE2eRed)
            ));
    if escaped && !unexpected {
        metrics::add(
            Metric::Escapes,
            1.0,
            &[("repo", repo), ("where", "e2e")],
            &ev,
        );
    }

    // MET-17, MET-26: a revert's end.
    let merged_by = cur.merged_by.as_deref().unwrap_or("none");
    let revert_end = match waiting {
        Some(Waiting::RevertedRefine) if entered_wait => Some("ok"),
        Some(Waiting::RevertFailed) if entered_wait && cur.stage.kind() == Kind::Revert => {
            Some("failed")
        }
        _ => None,
    };
    if let Some(result) = revert_end {
        metrics::add(
            Metric::Reverts,
            1.0,
            &[("repo", repo), ("merged_by", merged_by), ("result", result)],
            &ev,
        );
        if result == "ok"
            && let Some(red) = h
                .iter()
                .rev()
                .find(|(f, _, t, _)| f == "e2e" && t == "rollback")
        {
            metrics::observe(
                Metric::RestoreDuration,
                (now - red.3).max(0.0),
                &[("repo", repo)],
                &ev,
            );
        }
    }

    // MET-24, MET-26: the merge.
    let merged = to == Stage::Deploy
        && cur.stage != Stage::Deploy
        && (o.event == Event::PrMerged || (o.event == Event::Ok && cur.stage == Stage::Merge));
    if merged && cur.kind == Kind::Intent {
        merge_set(&h, cur, stored, now, &ev);
    }

    // MET-15: a mission of an intent ends.
    if let Some(id) = cur.intent.as_deref()
        && cur.kind != Kind::Rehearsal
    {
        let after_revert = matches!(
            cur.waiting.as_deref().and_then(Waiting::parse),
            Some(Waiting::RevertedRefine | Waiting::RevertFailed)
        ) && cur.stage == Stage::Blocked;
        let outcome = match to {
            _ if !moves => None,
            Stage::Done => Some("done"),
            Stage::Stopped if after_revert => None,
            Stage::Stopped if o.event == Event::PrClosed => Some("closed"),
            Stage::Stopped => Some("stopped"),
            _ => revert_end.map(|r| {
                if r == "ok" {
                    "reverted"
                } else {
                    "revert_failed"
                }
            }),
        };
        if let Some(outcome) = outcome {
            intent_end(tx, ax, cur, stored, id, outcome, now, &ev)?;
        }
    }
    Ok(())
}

/// MET-24's values and MET-26's feedback rounds at the merge, from the mission's transitions.
fn merge_set(
    h: &[(String, String, String, f64)],
    cur: &Mission,
    stored: &Mission,
    now: f64,
    ev: &Ev,
) {
    let repo = cur.repo.as_str();
    let round = |(f, e, t, _): &(String, String, String, f64)| {
        t == "build" && f != "build" && ["red", "feedback", "conflict"].contains(&e.as_str())
    };
    let repaired = h.iter().any(|(f, e, _, _)| {
        (e == "red" && ["verify", "proof", "ci"].contains(&f.as_str()))
            || e == "feedback"
            || e == "conflict"
    });
    metrics::add(
        Metric::FirstPass,
        1.0,
        &[
            ("repo", repo),
            ("result", if repaired { "no" } else { "yes" }),
        ],
        ev,
    );
    metrics::observe(
        Metric::ReworkCycles,
        h.iter().filter(|r| round(r)).count() as f64,
        &[("repo", repo)],
        ev,
    );
    if let Some(plan) = first_exit(h, "plan") {
        metrics::observe(
            Metric::PlanToMergeDuration,
            (now - plan).max(0.0),
            &[("repo", repo)],
            ev,
        );
    }
    let data = data_of(stored);
    let result = if data["review"]["result"]["plan_followed"]["followed"] == Value::Bool(false) {
        "drifted"
    } else if data["plan_updated"] == Value::Bool(true) {
        "updated"
    } else {
        "followed"
    };
    metrics::add(
        Metric::PlanResult,
        1.0,
        &[("repo", repo), ("result", result)],
        ev,
    );
    // Each feedback round: mine when I pushed (head_moved) before the next round or the merge.
    let events: Vec<&str> = h.iter().map(|r| r.1.as_str()).collect();
    for (i, _) in events.iter().enumerate().filter(|(_, e)| **e == "feedback") {
        let mine = events[i + 1..]
            .iter()
            .take_while(|e| **e != "feedback")
            .any(|e| *e == "head_moved");
        metrics::add(
            Metric::FeedbackRounds,
            1.0,
            &[
                ("repo", repo),
                ("resolved_by", if mine { "me" } else { "worker" }),
            ],
            ev,
        );
    }
}

/// MET-15: `intent.duration` (lead, cycle) and `intent.cost` of a mission's end.
#[allow(clippy::too_many_arguments)]
fn intent_end(
    tx: &Connection,
    ax: &Apply,
    cur: &Mission,
    stored: &Mission,
    id: &str,
    outcome: &str,
    now: f64,
    ev: &Ev,
) -> Result<(), String> {
    let intent = ax
        .listing
        .and_then(|l| l.open.iter().chain(&l.done).find(|i| i.id == id));
    let source = source_kind(intent.and_then(Intent::source));
    let merged_by = stored.merged_by.as_deref().unwrap_or("none");
    let data = data_of(stored);
    let gate = data["gate"]["label"].as_str().unwrap_or("none");
    let picked: f64 = tx
        .query_row(
            "SELECT MIN(created) FROM missions WHERE intent = ?1",
            [id],
            |r| r.get::<_, Option<f64>>(0),
        )
        .optional()
        .map_err(sql)?
        .flatten()
        .unwrap_or(cur.created);
    let mut kinds = vec![("cycle", now - picked)];
    if let Some(c) = created(intent, id, *ax.tick.wall.offset()) {
        kinds.insert(0, ("lead", now - unix(c)));
    }
    for (kind, secs) in kinds {
        metrics::observe(
            Metric::IntentDuration,
            secs.max(0.0),
            &[
                ("repo", &cur.repo),
                ("source", source),
                ("outcome", outcome),
                ("merged_by", merged_by),
                ("gate", gate),
                ("kind", kind),
            ],
            ev,
        );
    }
    metrics::observe(
        Metric::IntentCost,
        stored.cost_usd,
        &[("repo", &cur.repo), ("outcome", outcome)],
        ev,
    );
    Ok(())
}

/// MET-16: one sample per `modelUsage` key of a Claude run's result.
pub fn run_usage(repo: &str, agent: &str, stage: &str, r: &ClaudeResult, ev: &Ev) {
    for (model, u) in &r.model_usage {
        let labels = [
            ("repo", repo),
            ("agent", agent),
            ("model", model.as_str()),
            ("stage", stage),
        ];
        metrics::add(Metric::CostUsd, u.cost_usd, &labels, ev);
        for (kind, n) in [
            ("input", u.input_tokens),
            ("output", u.output_tokens),
            ("cache_read", u.cache_read_input_tokens),
            ("cache_creation", u.cache_creation_input_tokens),
        ] {
            let mut l = labels.to_vec();
            l.push(("type", kind));
            metrics::add(Metric::Tokens, n as f64, &l, ev);
        }
    }
}

/// MET-26: the guard's blocks since the last count (`<runs>/guard-blocks.jsonl` lines past the
/// number in `guard-blocks.seen`), by `kind`.
pub fn guard_blocks(runs: &Path, repo: &str, ev: &Ev) -> Result<(), String> {
    let log = runs.join("guard-blocks.jsonl");
    let seen_file = runs.join("guard-blocks.seen");
    let Ok(text) = std::fs::read_to_string(&log) else {
        return Ok(());
    };
    let seen: usize = std::fs::read_to_string(&seen_file)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    for l in lines.iter().skip(seen) {
        let kind = serde_json::from_str::<Value>(l)
            .ok()
            .and_then(|v| v["kind"].as_str().map(str::to_string))
            .filter(|k| k == "protected" || k == "test_lock")
            .unwrap_or_else(|| "protected".into());
        metrics::add(
            Metric::GuardBlocks,
            1.0,
            &[("repo", repo), ("kind", &kind)],
            ev,
        );
    }
    if lines.len() != seen {
        std::fs::write(&seen_file, lines.len().to_string())
            .map_err(|e| format!("{}: {e}", seen_file.display()))?;
    }
    Ok(())
}

/// `git <args>` in a mission checkout, after `checkout::sane` (nothing a run planted in its
/// `.git` runs as Towercab, LOOP-8) → stdout.
fn git(cx: &Ctx<'_>, dir: &Path, args: &[&str]) -> Result<String, String> {
    crate::checkout::git_sane(&cx.exes.git, dir, args, None)
}

/// The committer time of the oldest first-parent commit on the intents checkout's `main` that
/// added the intent's `intent.md` (MET-23).
fn on_main(cx: &Ctx<'_>, dir: &str) -> Result<Option<f64>, String> {
    let rel = format!("{dir}/intent.md");
    let out = cx.store.checkout().git(&[
        "log",
        "--first-parent",
        "--diff-filter=A",
        "--format=%ct",
        "HEAD",
        "--",
        &rel,
    ])?;
    Ok(out.lines().last().and_then(|l| l.trim().parse().ok()))
}

/// An intent's text for MET-23's edits: (body without `## Towercab`, u, i, a, repo, unlock).
type Mine = (
    String,
    Option<u8>,
    Option<u8>,
    Option<u8>,
    String,
    Vec<String>,
);

fn mine(text: &str) -> Option<Mine> {
    let mut i = Intent::parse(text).ok()?;
    i.set_section("Towercab", "").ok()?;
    Some((
        i.body().trim().to_string(),
        i.u(),
        i.i(),
        i.a(),
        i.repo().to_string(),
        i.unlock().to_vec(),
    ))
}

/// After `machine::enter`'s intent write (once per entry: its mark makes a re-run skip it),
/// what needs git (MET-23, MET-24, MET-26): at `design` from `pick` on attempt 1 the time to
/// intent; at the entry after the design's first exit the spec lead; at the merge's `deploy`
/// entry the edits after the spec, spec rework, `CLAUDE.md` updates and gate violations.
pub fn entered(cx: &mut Ctx<'_>, m: &Mission) -> Result<(), String> {
    let Some(id) = m.intent.as_deref() else {
        return Ok(());
    };
    if m.kind != Kind::Intent {
        return Ok(());
    }
    let h = history(cx.db.conn(), m.id)?;
    let Some(last) = h.last().cloned() else {
        return Ok(());
    };
    let ev = Ev::of(m);
    let repo = m.repo.as_str();
    let (from, event, to, at) = (last.0.as_str(), last.1.as_str(), last.2.as_str(), last.3);
    let picked = to == "design" && from == "pick" && m.attempt == 1;
    let design_exits = h
        .iter()
        .filter(|(f, _, t, _)| f == "design" && t != "design")
        .count();
    let has_spec = data_of(m)["design"]["spec_ids"]
        .as_array()
        .is_some_and(|ids| !ids.is_empty());
    let specced = from == "design" && to != "design" && design_exits == 1 && has_spec;
    let merged = to == "deploy" && (event == "pr_merged" || (event == "ok" && from == "merge"));
    if !(picked || specced || merged) {
        return Ok(());
    }
    let intent = cx.store.get(id).map_err(|e| e.to_string())?;
    if picked {
        if let (Some(started), Some(main)) = (intent.started(), on_main(cx, &intent.dir)?) {
            metrics::observe(
                Metric::TimeToIntent,
                (main - unix(started)).max(0.0),
                &[("source", source_kind(intent.source()))],
                &ev,
            );
        }
        return Ok(());
    }
    if specced {
        if let Some(main) = on_main(cx, &intent.dir)? {
            metrics::observe(
                Metric::SpecLeadDuration,
                (at - main).max(0.0),
                &[("repo", repo)],
                &ev,
            );
        }
        return Ok(());
    }
    // The merge's entry. My edits to intent.md after the spec (Towercab's own commits are `towercab: …`).
    if let Some(spec) = first_exit(&h, "design") {
        let rel = format!("{}/intent.md", intent.dir);
        let store = cx.store.checkout();
        let log = store.git(&[
            "log",
            "--first-parent",
            "--format=%H %ct %s",
            "HEAD",
            "--",
            &rel,
        ])?;
        let mut edits = 0;
        for line in log.lines() {
            let mut parts = line.splitn(3, ' ');
            let (Some(sha), Some(ct), subject) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            let ct: f64 = ct.parse().unwrap_or(0.0);
            // Commit times are whole seconds.
            if ct < spec.floor() || subject.unwrap_or_default().starts_with("towercab: ") {
                continue;
            }
            let show = |rev: &str| store.git(&["show", &format!("{rev}:{rel}")]).ok();
            let (old, new) = (show(&format!("{sha}^")), show(sha));
            // The commit that added it is no edit.
            if old.is_some() && old.as_deref().and_then(mine) != new.as_deref().and_then(mine) {
                edits += 1;
            }
        }
        metrics::add(
            Metric::EditsAfterSpec,
            f64::from(edits),
            &[("repo", repo)],
            &ev,
        );
    }
    // The PR's diff in the mission checkout.
    let dir = cx.checkout(m);
    let (Some(head), Ok(rc)) = (m.head.as_deref(), cx.repo(m)) else {
        return Ok(());
    };
    let base = format!("refs/remotes/origin/{}", rc.base);
    let mb = git(cx, &dir, &["merge-base", head, &base])?
        .trim()
        .to_string();
    let range = format!("{mb}..{head}");
    let changed: BTreeSet<String> = git(
        cx,
        &dir,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "--no-renames",
            &mb,
            head,
        ],
    )?
    .lines()
    .map(str::to_string)
    .collect();
    if let Some(plan) = first_exit(&h, "plan") {
        // The design's own spec commits (`docs(specs): …`) aside; commit times are seconds.
        let log = git(cx, &dir, &["log", "--format=%ct %s", &range, "--", "specs"])?;
        let n = log
            .lines()
            .filter_map(|l| l.split_once(' '))
            .filter(|(_, s)| !s.starts_with("docs(specs): "))
            .filter_map(|(ct, _)| ct.parse::<f64>().ok())
            .filter(|ct| *ct >= plan.floor())
            .count();
        metrics::add(Metric::SpecRework, n as f64, &[("repo", repo)], &ev);
    }
    let claude_md = changed.contains("CLAUDE.md");
    metrics::add(
        Metric::ClaudeMdUpdates,
        if claude_md { 1.0 } else { 0.0 },
        &[("repo", repo)],
        &ev,
    );
    if m.merged_by.as_deref() == Some("towercab") {
        let files = crate::repo::load(&rc.path, &rc.base).map_err(|e| e.to_string())?;
        let p = crate::repo::protected::Protected::new(&files.towercab.protected, intent.unlock())?;
        let violated = changed.iter().any(|f| p.blocks(f));
        metrics::add(
            Metric::GateViolations,
            if violated { 1.0 } else { 0.0 },
            &[("repo", repo)],
            &ev,
        );
    }
    Ok(())
}

/// The oldest commit's committer time in `merge-base(head, origin/<base>)..head` of the
/// mission checkout (MET-26's change lead time), if any.
pub fn first_commit(cx: &Ctx<'_>, m: &Mission) -> Option<f64> {
    let head = m.head.as_deref()?;
    let rc = cx.repo(m).ok()?;
    let dir = cx.checkout(m);
    let base = format!("refs/remotes/origin/{}", rc.base);
    let mb = git(cx, &dir, &["merge-base", head, &base]).ok()?;
    let log = git(
        cx,
        &dir,
        &[
            "log",
            "--reverse",
            "--format=%ct",
            &format!("{}..{head}", mb.trim()),
        ],
    )
    .ok()?;
    log.lines().next()?.trim().parse().ok()
}

/// MET-26: a deploy of the mission's merge seen in `env` (`staging`, `production`); the
/// production one also ends the change's lead time.
pub fn deployed(cx: &Ctx<'_>, m: &Mission, env: &str) {
    let ev = Ev::of(m);
    metrics::add(
        Metric::Deploys,
        1.0,
        &[("repo", &m.repo), ("env", env)],
        &ev,
    );
    if env == "production"
        && let Some(first) = first_commit(cx, m)
    {
        metrics::observe(
            Metric::ChangeLeadDuration,
            (cx.tick.unix() - first).max(0.0),
            &[("repo", &m.repo)],
            &ev,
        );
    }
}

/// MET-20, MET-24: the gauges, every value (0 too). `state`: the loop's (`paused`,
/// `env_blocked`, `running`, `limit`, `idle`); `active`: its children.
pub fn gauges(
    conn: &Connection,
    listing: Option<&Listing>,
    cutoff: u8,
    state: &str,
    active: usize,
) -> Result<(), String> {
    let unfinished = mission::unfinished(conn)?;
    let with_mission: BTreeSet<&str> = unfinished
        .iter()
        .filter_map(|m| m.intent.as_deref())
        .collect();
    let on_me = |m: &&Mission| m.stage.waits();
    let mut n = [0usize; 5];
    n[2] = unfinished
        .iter()
        .filter(|m| m.kind != Kind::Rehearsal && !on_me(m))
        .count();
    n[3] = unfinished.iter().filter(on_me).count();
    if let Some(l) = listing {
        let order = priority::pick_order(l, cutoff);
        n[0] = order
            .iter()
            .filter(|i| !priority::parked(priority::priority(i.u(), i.i()), cutoff))
            .count();
        n[1] = order.len() - n[0];
        let done = l.done_ids();
        for i in &l.open {
            if i.waiting().is_some() && !with_mission.contains(i.id.as_str()) {
                n[3] += 1;
            } else if priority::queued(i) && i.after().iter().any(|a| !done.contains(a)) {
                n[4] += 1;
            }
        }
    }
    for (s, v) in [
        "runnable",
        "parked",
        "in_flight",
        "waiting_on_me",
        "blocked",
    ]
    .iter()
    .zip(n)
    {
        metrics::gauge(Metric::Backlog, v as f64, &[("state", s)]);
    }
    for s in ["running", "idle", "paused", "env_blocked", "limit"] {
        metrics::gauge(
            Metric::LoopState,
            if s == state { 1.0 } else { 0.0 },
            &[("state", s)],
        );
    }
    metrics::gauge(Metric::Active, active as f64, &[]);
    Ok(())
}

/// MET-17: `limits::cool` starting or lengthening `model`'s wait (`old_until`: the running
/// cooldown's end, if any) to `until` at `now`.
pub fn cooled(model: &str, old_until: Option<f64>, until: f64, now: f64) {
    let running = old_until.filter(|u| *u > now);
    if running.is_none() {
        metrics::add(
            Metric::UsageLimitWaits,
            1.0,
            &[("model", model)],
            &Ev::none(),
        );
    }
    let added = until - running.unwrap_or(now);
    if added > 0.0 {
        metrics::add(
            Metric::UsageLimitWaitDuration,
            added,
            &[("model", model)],
            &Ev::none(),
        );
    }
}

/// The repeated rule rows `findings::record` just added (MET-24): `(repo, rule)` already in
/// another PR.
pub fn repeated(conn: &Connection, repo: &str, rule: &str, pr: u64, ev: &Ev) -> Result<(), String> {
    let again: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM findings WHERE repo = ?1 AND rule = ?2 AND pr != ?3)",
            params![repo, rule, pr as i64],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if again {
        metrics::add(Metric::FindingsRepeated, 1.0, &[("repo", repo)], ev);
    }
    Ok(())
}
