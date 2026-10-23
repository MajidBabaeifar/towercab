//! Lessons (MNT-8): what an alert intent's fix taught, written by code on `main` of `intents`
//! for the next diagnoses to read.

use chrono::{DateTime, FixedOffset};

use crate::outbox::{cut, num, one_line};

use super::diagnose::utc;

/// A breach as a lesson tells it.
#[derive(Debug, Clone, PartialEq)]
pub struct Anomaly {
    pub tier: String,
    pub point: f64,
    pub value: f64,
    pub mean: f64,
    pub sigma: f64,
}

/// Everything a lesson says.
#[derive(Debug, Clone, PartialEq)]
pub struct Lesson {
    pub id: String,
    pub title: String,
    pub band: String,
    pub anomaly: Option<Anomaly>,
    /// The intent's `## Problem`.
    pub problem: String,
    pub pr: Option<String>,
    /// The band's first point after the fix: (period end, value), back within 1σ (unknown
    /// without a baseline).
    pub after: Option<(f64, f64, Option<bool>)>,
}

/// `lessons/<yymmdd of fixed>-<slug>.md` (`fixed` in `offset`'s local time).
pub fn path(fixed: f64, slug: &str, offset: FixedOffset) -> String {
    let day = DateTime::from_timestamp(fixed as i64, 0)
        .map(|t| t.with_timezone(&offset).format("%y%m%d").to_string())
        .unwrap_or_else(|| "000000".into());
    format!("lessons/{day}-{slug}.md")
}

/// The first paragraph of `text`, one line, at most 300 characters.
fn first_paragraph(text: &str) -> String {
    let para: Vec<&str> = text
        .trim()
        .lines()
        .take_while(|l| !l.trim().is_empty())
        .collect();
    cut(&one_line(&para.join(" ")), 300)
}

/// The lesson's text (maintain.md **Lesson**).
pub fn text(l: &Lesson) -> String {
    let anomaly = match &l.anomaly {
        Some(a) => format!(
            "{} at {} on {}: value {} · mean {} · σ {}",
            l.band,
            a.tier,
            utc(a.point),
            num(a.value),
            num(a.mean),
            num(a.sigma)
        ),
        None => format!("{}: no breach recorded", l.band),
    };
    let after = match l.after {
        Some((t, v, within)) => format!(
            "{} on {}, back within 1σ: {}",
            num(v),
            utc(t),
            match within {
                Some(true) => "yes",
                Some(false) => "no",
                None => "unknown",
            }
        ),
        None => "no value".into(),
    };
    let cause = first_paragraph(&l.problem);
    format!(
        "# Lesson: {}\n\n- Intent: {} (source: alert:{})\n- Anomaly: {}\n- Cause: {}\n- Fix: {}\n- After the fix: {}\n- Eval case: evals/{}.json (incident)\n",
        one_line(&l.title),
        l.id,
        l.band,
        anomaly,
        if cause.is_empty() {
            "unknown".into()
        } else {
            cause
        },
        l.pr.as_deref()
            .map(one_line)
            .unwrap_or_else(|| "none".into()),
        after,
        l.id
    )
}
