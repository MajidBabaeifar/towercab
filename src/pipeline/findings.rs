//! Findings feed `CLAUDE.md` (PIP-36): a review finding's `rule` (the one-line convention it
//! breaks) is kept per repo and PR in the `findings` table; the same rule (lowercased) in the
//! reviews of two PRs of one repo → one draft intent PR on `intents` ([INT-8](intents.md)):
//! "update CLAUDE.md: <rule>", `unlock: [CLAUDE.md]`, `source: review:<pr>,<pr>`. Once per
//! rule (drafts key `review:<rule>`, never repeated).

use rusqlite::{Connection, params};

use crate::db::sql;
use crate::drafts::{self, Draft};
use crate::github::GhError;
use crate::handler::Ctx;
use crate::intents::Intent;
use crate::intents::intent::{Value as IValue, format_value};
use crate::intents::store::rfc3339;
use crate::outbox::one_line;

use super::schemas::ReviewResult;

/// A finding's rule as the table keeps it: one line, trimmed, lowercased; empty → none.
pub fn rule_key(rule: &str) -> Option<String> {
    let r = one_line(rule).to_lowercase();
    (!r.is_empty()).then_some(r)
}

/// Keeps each finding of `review` that names a `rule`: one row per (repo, rule, PR), the first
/// one seen kept (`INSERT OR IGNORE`). Returns the rows added.
pub fn record(
    conn: &Connection,
    repo: &str,
    pr: u64,
    mission: i64,
    review: &ReviewResult,
    at: f64,
) -> Result<usize, String> {
    let mut added = 0;
    for f in &review.findings {
        let Some(rule) = f.rule.as_deref().and_then(rule_key) else {
            continue;
        };
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO findings (repo, rule, pr, mission, at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![repo, rule, pr as i64, mission, at],
            )
            .map_err(sql)?;
        if n > 0 {
            // The same mistake in another PR (MET-24).
            let ev = crate::metrics::Ev {
                pr: Some(pr),
                ..crate::metrics::Ev::none()
            };
            if let Err(e) = crate::indicators::repeated(conn, repo, &rule, pr, &ev) {
                crate::tlog!("towercab: {repo}#{pr}: metrics: {e}");
            }
        }
        added += n;
    }
    Ok(added)
}

/// Rules found in the reviews of two or more PRs of one repo: (repo, rule, the PRs, lowest
/// first).
pub fn repeated(conn: &Connection) -> Result<Vec<(String, String, Vec<u64>)>, String> {
    let mut q = conn
        .prepare(
            "SELECT repo, rule, pr FROM findings WHERE (repo, rule) IN
               (SELECT repo, rule FROM findings GROUP BY repo, rule HAVING count(*) >= 2)
             ORDER BY repo, rule, pr",
        )
        .map_err(sql)?;
    let rows: Vec<(String, String, i64)> = q
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)?;
    let mut out: Vec<(String, String, Vec<u64>)> = Vec::new();
    for (repo, rule, pr) in rows {
        match out.last_mut() {
            Some((r, u, prs)) if *r == repo && *u == rule => prs.push(pr as u64),
            _ => out.push((repo, rule, vec![pr as u64])),
        }
    }
    Ok(out)
}

/// The draft for a repeated rule: `intent.md` (`repo`, `unlock: [CLAUDE.md]`,
/// `source: review:<a>,<b>`, `started`), its title and PR body.
pub fn draft(repo: &str, github: &str, rule: &str, prs: &[u64], started: &str) -> Draft {
    let s = |v: &str| format_value(&IValue::Str(v.to_string()));
    let two: Vec<String> = prs.iter().take(2).map(u64::to_string).collect();
    let source = format!("review:{}", two.join(","));
    let title = format!("update CLAUDE.md: {rule}");
    let links: Vec<String> = prs
        .iter()
        .map(|n| format!("https://github.com/{github}/pull/{n}"))
        .collect();
    let intent_md = format!(
        "---\nrepo: {}\nunlock: [CLAUDE.md]\nsource: {}\nstarted: {}\n---\n\n# Intent: {title}\n\n\
         ## Problem\n\nPR reviews of {repo} found the same broken convention in {} PRs: {rule}\n\n\
         ## Proposed outcome\n\n- CLAUDE.md states the convention, so the worker follows it: {rule}\n",
        s(repo),
        s(&source),
        s(started),
        prs.len(),
    );
    let pr_body = format!(
        "Drafted by Towercab from repeated review findings (PIP-36): `{rule}` in {}.\n\n\
         Merge to accept, close to reject.",
        links.join(", ")
    );
    Draft {
        key: format!("review:{rule}"),
        repo: repo.to_string(),
        source,
        title,
        intent_md,
        pr_body,
        repeat: false,
    }
}

/// In the drafts poll (every 300 s): a draft intent PR for each repeated rule without a
/// `drafts` row yet (`review:<rule>`: once, never again). The first failure is returned after
/// the others are tried.
pub fn draft_due(cx: &mut Ctx<'_>) -> Result<(), GhError> {
    let due = repeated(cx.db.conn()).map_err(GhError::Failed)?;
    let mut first: Option<GhError> = None;
    for (repo, rule, prs) in due {
        let key = format!("review:{rule}");
        if drafts::get(cx.db.conn(), &key)
            .map_err(GhError::Failed)?
            .is_some()
        {
            continue;
        }
        let github = match cx.config.repo(&repo) {
            Ok(r) => r.github.clone(),
            Err(_) => continue,
        };
        let d = draft(&repo, &github, &rule, &prs, &rfc3339(cx.tick.wall));
        if let Err(e) = Intent::parse(&d.intent_md) {
            first.get_or_insert(GhError::Failed(format!("{key}: {e}")));
            continue;
        }
        if let Err(e) = drafts::open(cx, &d) {
            first.get_or_insert(e);
        }
    }
    first.map_or(Ok(()), Err)
}
