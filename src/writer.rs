//! PR text (PIP-11, PIP-14, PIP-15, pipeline.md **PR text**): the initial body at the first
//! publish, `⛔ Not ready` while a PR waits on me before review, the final text at the gate
//! (Haiku from the worker's notes and the review's verdicts), and the plain template whenever
//! the writer fails. All code but the summary and bullets; never blocks an intent.

use rusqlite::params;
use serde_json::Value;

use crate::claude::RunKind;
use crate::db::sql;
use crate::handler::{ChildEnd, Ctx, Progress, StepError};
use crate::mission::Mission;
use crate::outbox::one_line;
use crate::pipeline::data::Data;
use crate::pipeline::runs::{self, Ended, Start, WRITER_MODEL};
use crate::pipeline::schemas::{Concern, DesignResult, OpenQuestion, WRITER, WriterResult};
use crate::pipeline::{gh, prompts};

/// Bullets in the final text.
pub const MAX_CHANGES: usize = 5;

/// The worker's notes given to the writer (characters, head and tail kept).
pub const NOTES_MAX: usize = 8000;

/// Each attempt's notes in [`notes`] (characters, head and tail kept).
pub const ATTEMPT_MAX: usize = 4000;

/// The small footer under every text but the initial one.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Footer {
    pub intent_url: String,
    pub mission: i64,
    /// Over every attempt that pushed into the PR.
    pub cost_usd: f64,
    pub secs: u64,
    pub version: String,
}

impl Footer {
    /// `<sub>🤖 Built by Towercab · [intent](<url>) · mission <id> · $<cost> · <h>h<mm>m</sub>`.
    pub fn render(&self) -> String {
        format!(
            "<sub>🤖 Built by Towercab · [intent]({}) · mission {} · ${:.2} · {}h{:02}m</sub>",
            self.intent_url,
            self.mission,
            self.cost_usd,
            self.secs / 3600,
            (self.secs % 3600) / 60
        )
    }
}

/// The body at the first publish (design, an adoption's first push): spec IDs, concerns, open
/// questions, the plan link once written, the versions in force; nothing else.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Initial {
    pub spec_ids: Vec<String>,
    pub concerns: Vec<Concern>,
    pub open_questions: Vec<OpenQuestion>,
    pub plan_url: Option<String>,
    /// Towercab `--version`.
    pub version: String,
    pub base_sha: String,
    /// `<owner/name>@<sha7>` or `none`.
    pub policies: String,
}

fn ids(spec_ids: &[String]) -> String {
    if spec_ids.is_empty() {
        "none".into()
    } else {
        spec_ids.join(", ")
    }
}

/// The initial body (pipeline.md **PR text**).
pub fn initial(i: &Initial) -> String {
    let mut out = vec![format!("Spec IDs: {}", ids(&i.spec_ids))];
    if !i.concerns.is_empty() {
        let mut s = String::from("**Concerns**");
        for c in &i.concerns {
            s.push_str(&format!("\n- {}: {}", c.what, c.why));
            if let Some(p) = &c.policy {
                s.push_str(&format!(" (policy {p})"));
            }
        }
        out.push(s);
    }
    if !i.open_questions.is_empty() {
        let mut s = String::from("**Open questions**");
        for q in &i.open_questions {
            let a = q.answer.clone().unwrap_or_else(|| "carried".into());
            s.push_str(&format!("\n- {}: {a}", q.question));
        }
        out.push(s);
    }
    if let Some(url) = &i.plan_url {
        out.push(format!("**Plan:** {url}"));
    }
    out.push(format!(
        "<sub>Towercab {} · base {} · policies {}</sub>",
        i.version,
        &i.base_sha[..i.base_sha.len().min(7)],
        i.policies
    ));
    out.join("\n\n") + "\n"
}

/// `⛔ Not ready: <why>` pointing to `intent.md` (PIP-14).
pub fn not_ready(why: &str, intent_url: &str, footer: &Footer) -> String {
    format!(
        "⛔ Not ready: {}\nSee [intent.md]({intent_url}).\n\n{}\n",
        one_line(why),
        footer.render()
    )
}

/// The checks lines of the final text, one line each.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Checks {
    pub verify: String,
    pub proof: String,
    pub ci: String,
    pub verifier: String,
    /// `approved`, or `not approved: <reasons>` (the review's verdicts).
    pub review: String,
}

/// The CI line (PIP-14): `ci.result` `green`, `flaky`, `none` → its words.
pub fn ci_line(result: &str) -> String {
    match result {
        "green" => "green".into(),
        "flaky" => "flaky (green on rerun)".into(),
        "none" => "no CI checks on this repo, nothing ran".into(),
        other => other.into(),
    }
}

/// The review line (PIP-14): `approved`, or `not approved: <reasons, "; ">` (its verdicts).
pub fn review_line(approved: bool, reasons: &[String]) -> String {
    if approved {
        "approved".into()
    } else if reasons.is_empty() {
        "not approved".into()
    } else {
        format!("not approved: {}", reasons.join("; "))
    }
}

/// What the final text is made of.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Inputs {
    /// The PR title (the template's summary).
    pub title: String,
    /// The worker's notes over every attempt ([`notes`]).
    pub notes: String,
    /// One per `Proposed outcome` bullet: `<bullet>: met|not met: <why>`.
    pub verdicts: Vec<String>,
    pub spec_ids: Vec<String>,
    pub checks: Checks,
    pub plan_url: Option<String>,
    /// `Closes <issue>` (an intent drafted from an issue).
    pub closes: Option<String>,
    pub footer: Footer,
}

/// The final text: summary, changes (≤ 5), spec IDs, checks, plan link, footer.
pub fn final_text(w: &WriterResult, i: &Inputs) -> String {
    let mut out = vec![one_line(&w.summary)];
    let changes: Vec<String> = w
        .changes
        .iter()
        .take(MAX_CHANGES)
        .map(|c| format!("- {}", one_line(c)))
        .collect();
    if !changes.is_empty() {
        out.push(changes.join("\n"));
    }
    out.push(format!("Spec IDs: {}", ids(&i.spec_ids)));
    let c = &i.checks;
    out.push(format!(
        "**Checks**\n- verify: {}\n- red→green proof: {}\n- CI: {}\n- verifier: {}\n- review: {}",
        one_line(&c.verify),
        one_line(&c.proof),
        one_line(&c.ci),
        one_line(&c.verifier),
        one_line(&c.review)
    ));
    let mut tail = Vec::new();
    if let Some(url) = &i.plan_url {
        tail.push(format!("**Plan:** {url}"));
    }
    if let Some(issue) = &i.closes {
        tail.push(format!("Closes {issue}"));
    }
    if !tail.is_empty() {
        out.push(tail.join("\n"));
    }
    out.push(i.footer.render());
    out.join("\n\n") + "\n"
}

/// The fallback (PIP-15): [`final_text`] with the title as summary and the verdicts as bullets.
pub fn template(i: &Inputs) -> String {
    final_text(
        &WriterResult {
            summary: i.title.clone(),
            changes: i.verdicts.clone(),
        },
        i,
    )
}

/// The writer's prompt (`prompts/writer.md`).
pub fn writer_prompt(i: &Inputs) -> Result<String, String> {
    let verdicts = if i.verdicts.is_empty() {
        "none".to_string()
    } else {
        i.verdicts
            .iter()
            .map(|v| format!("- {v}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    prompts::render(
        "writer",
        &[
            ("title", &i.title),
            ("notes", &head_and_tail(&i.notes, NOTES_MAX)),
            ("verdicts", &verdicts),
        ],
    )
}

/// `notes` within `n` characters: its start and its end with `\n…\n` between (the first
/// build's summary leads, the last repair's result ends).
pub fn head_and_tail(notes: &str, n: usize) -> String {
    let count = notes.chars().count();
    if count <= n {
        return notes.to_string();
    }
    let half = n.saturating_sub(3) / 2;
    let head: String = notes.chars().take(half).collect();
    let tail: String = notes.chars().skip(count - half).collect();
    format!("{head}\n…\n{tail}")
}

/// The missions of `m`'s intent that pushed into its PR (`m` alone without one), by attempt.
fn with_pr(cx: &Ctx<'_>, m: &Mission) -> Result<Vec<Mission>, String> {
    let Some(intent) = m.intent.as_deref() else {
        return Ok(vec![m.clone()]);
    };
    let mut all = crate::mission::for_intent(cx.db.conn(), intent)?;
    all.retain(|x| x.id == m.id || (m.pr.is_some() && x.pr == m.pr && x.head.is_some()));
    if !all.iter().any(|x| x.id == m.id) {
        all.push(m.clone());
    }
    all.sort_by_key(|x| x.attempt);
    Ok(all)
}

/// The worker's notes of every attempt with this PR (`build.txt`, `build-<attempt>.txt`), each
/// with its own start and end; several are headed `Attempt <n>:`.
pub fn notes(cx: &Ctx<'_>, m: &Mission) -> String {
    let all = with_pr(cx, m).unwrap_or_else(|_| vec![m.clone()]);
    let runs = cx.runs(m);
    let parts: Vec<(u32, String)> = all
        .iter()
        .filter_map(|x| {
            let file = if x.attempt <= 1 {
                "build.txt".to_string()
            } else {
                format!("build-{}.txt", x.attempt)
            };
            let text = std::fs::read_to_string(runs.join(file)).ok()?;
            let text = text.trim();
            (!text.is_empty()).then(|| (x.attempt, head_and_tail(text, ATTEMPT_MAX)))
        })
        .collect();
    match parts.as_slice() {
        [] => String::new(),
        [(_, one)] => one.clone(),
        many => many
            .iter()
            .map(|(a, t)| format!("Attempt {a}:\n{t}"))
            .collect::<Vec<_>>()
            .join("\n\n"),
    }
}

/// The footer: cost and time over every attempt that pushed into the PR.
pub fn footer(cx: &Ctx<'_>, m: &Mission) -> Footer {
    let all = with_pr(cx, m).unwrap_or_else(|_| vec![m.clone()]);
    // Read again: a run's cost is added after the caller's copy was read.
    let fresh: Vec<Mission> = all
        .iter()
        .map(|x| crate::mission::get(cx.db.conn(), x.id).unwrap_or_else(|_| x.clone()))
        .collect();
    Footer {
        intent_url: crate::pipeline::intent_url(cx, m),
        mission: m.id,
        cost_usd: fresh.iter().map(|x| x.cost_usd).sum(),
        secs: fresh.iter().map(|x| x.agent_secs).sum::<f64>().round() as u64,
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// The initial body from `data.design` and `data.plan_url` (PIP-14).
pub fn initial_of(m: &Mission) -> String {
    let data = Data::of(m);
    let design = data
        .get("design")
        .and_then(|d| DesignResult::from_json(d).ok());
    let versions = data.get("design").and_then(|d| d.get("versions"));
    let v = |k: &str| {
        versions
            .and_then(|x| x.get(k))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    initial(&Initial {
        spec_ids: design
            .as_ref()
            .map(|d| d.spec_ids.clone())
            .unwrap_or_default(),
        concerns: design
            .as_ref()
            .map(|d| d.concerns.clone())
            .unwrap_or_default(),
        open_questions: design.map(|d| d.open_questions).unwrap_or_default(),
        plan_url: data.str("plan_url").map(str::to_string),
        version: Some(v("towercab"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        base_sha: Some(v("base"))
            .filter(|s| !s.is_empty())
            .or_else(|| m.base_sha.clone())
            .unwrap_or_default(),
        policies: Some(v("policies"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "none".into()),
    })
}

/// The PR body set to `body` (`gh api -X PATCH repos/<r>/pulls/<n> -F body=@<runs>/pr-body.md`:
/// `gh pr edit` fails on gh 2.46). Never an error: a failure is logged → `false` (PIP-15).
pub fn patch(cx: &Ctx<'_>, m: &Mission, body: &str) -> bool {
    let Some(pr) = m.pr else {
        return false;
    };
    let failed = |e: String| {
        eprintln!(
            "towercab: {}: PR text not updated: {}",
            m.label(),
            one_line(&e)
        );
        false
    };
    let file = cx.runs(m).join("pr-body.md");
    if let Err(e) = std::fs::create_dir_all(cx.runs(m)).and_then(|()| std::fs::write(&file, body)) {
        return failed(format!("{}: {e}", file.display()));
    }
    let github = match gh::github(cx, m) {
        Ok(g) => g,
        Err(e) => return failed(format!("{e:?}")),
    };
    let path = format!("repos/{github}/pulls/{pr}");
    let body_arg = format!("body=@{}", file.display());
    match cx
        .identity
        .gh(&github, &["api", "-X", "PATCH", &path, "-F", &body_arg])
    {
        Ok(_) => true,
        Err(e) => failed(e.to_string()),
    }
}

/// The writer's run (`text:run`, PIP-14): `claude -p --model haiku --tools ""`, no slot, 60 s.
/// `Ok(Err(template))` when it can't start (no `claude` on the way, a prompt bug): the writer
/// never waits.
pub fn start(
    cx: &Ctx<'_>,
    m: &Mission,
    i: &Inputs,
    eval: bool,
) -> Result<Result<Progress, String>, StepError> {
    let prompt = match writer_prompt(i) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("towercab: {}: writer: {e}", m.label());
            return Ok(Err(template(i)));
        }
    };
    if crate::exes::which(&cx.exes.claude).is_none() {
        eprintln!(
            "towercab: {}: writer: {} not found",
            m.label(),
            cx.exes.claude.to_string_lossy()
        );
        return Ok(Err(template(i)));
    }
    let mut st = Start::new(RunKind::Writer, "text:run", WRITER_MODEL, prompt);
    st.schema = Some(WRITER.clone());
    st.eval = eval;
    runs::start(cx, m, st).map(Ok)
}

/// The writer's run ended → the final text, or the template on any failure (PIP-15).
pub fn finish(cx: &Ctx<'_>, m: &Mission, end: &ChildEnd, i: &Inputs) -> Result<String, StepError> {
    let why = match runs::finish(cx, m, end)? {
        Ended::Ok(r) => match r.structured_output.as_ref().map(WriterResult::from_json) {
            Some(Ok(w)) => return Ok(final_text(&w, i)),
            Some(Err(e)) => e,
            None => "no structured_output".into(),
        },
        Ended::Failed(why) => why,
        Ended::Out(p) => format!("{p:?}"),
    };
    eprintln!(
        "towercab: {}: writer: {}: the template",
        m.label(),
        one_line(&why)
    );
    Ok(template(i))
}

/// Total cost and time of the intent's missions with `pr` (tests, status).
pub fn totals(conn: &rusqlite::Connection, intent: &str, pr: u64) -> Result<(f64, f64), String> {
    conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0), COALESCE(SUM(agent_secs), 0) FROM missions
         WHERE intent = ?1 AND pr = ?2",
        params![intent, pr as i64],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(sql)
}
