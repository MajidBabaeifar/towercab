//! The `--json-schema`s of the pipeline's Claude runs and their hand-written parsers
//! (pipeline.md **Schemas**). Every object `additionalProperties: false`, every listed key
//! required; a parser refuses a missing, mistyped or out-of-range field with why.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::machine::Door;
use crate::outbox::one_line;

/// Conventional Commit types (PIP-2).
pub const TYPES: [&str; 11] = [
    "feat", "fix", "perf", "revert", "refactor", "docs", "test", "build", "ci", "chore", "style",
];

fn s() -> Value {
    json!({"type": "string"})
}

fn s_or_null() -> Value {
    json!({"type": ["string", "null"]})
}

fn strings() -> Value {
    json!({"type": "array", "items": {"type": "string"}})
}

/// An object with exactly these properties, all required.
fn object(props: Value) -> Value {
    let keys: Vec<Value> = props
        .as_object()
        .map(|o| o.keys().map(|k| Value::from(k.as_str())).collect())
        .unwrap_or_default();
    json!({
        "type": "object",
        "properties": props,
        "required": keys,
        "additionalProperties": false,
    })
}

fn plan_props() -> Value {
    json!({"files": strings(), "order": strings(), "risks": strings(), "proof": strings()})
}

fn red_lines() -> Value {
    json!({"type": "array", "items": object(json!({"line": s(), "file": s()}))})
}

pub static DESIGN: LazyLock<Value> = LazyLock::new(|| {
    object(json!({
        "type": {"type": "string", "enum": TYPES},
        "scope": s(),
        "breaking": {"type": "boolean"},
        "spec_ids": {"type": "array", "items": {"type": "string", "pattern": "^[A-Z]+-[0-9]+$"}},
        "concerns": {"type": "array", "items": object(json!({
            "what": s(), "why": s(), "policy": s_or_null(),
        }))},
        "open_questions": {"type": "array", "items": object(json!({
            "question": s(), "answer": s_or_null(), "carried": {"type": "boolean"},
        }))},
        "summary": s(),
    }))
});

pub static PLAN: LazyLock<Value> = LazyLock::new(|| object(plan_props()));

pub static WORKER: LazyLock<Value> = LazyLock::new(|| {
    object(json!({
        "status": {"type": "string", "enum": ["done", "blocked"]},
        "question": s_or_null(),
        "notes": s(),
        "plan": {"anyOf": [object(plan_props()), {"type": "null"}]},
        "plan_why": s_or_null(),
        "lower_a": {"type": ["integer", "null"], "minimum": 1, "maximum": 5},
        "lower_why": s_or_null(),
    }))
});

pub static REVIEW: LazyLock<Value> = LazyLock::new(|| {
    object(json!({
        "approved": {"type": "boolean"},
        "outcomes": {"type": "array", "items": object(json!({
            "bullet": s(), "met": {"type": "boolean"}, "why": s(),
        }))},
        "tests_weakened": object(json!({"weakened": {"type": "boolean"}, "where": s()})),
        "plan_followed": object(json!({"followed": {"type": "boolean"}, "where": s()})),
        "findings": {"type": "array", "items": object(json!({
            "pass": s(),
            "severity": {"type": "string", "enum": ["important", "nit"]},
            "file": s(),
            "line": {"type": ["integer", "null"]},
            "what": s(),
            "rule": s_or_null(),
            "policy": s_or_null(),
        }))},
        "door": {"type": ["string", "null"], "enum": ["one-way", "two-way", null]},
        "red_lines": red_lines(),
        "why": s(),
    }))
});

pub static TRIAGE: LazyLock<Value> = LazyLock::new(|| {
    object(json!({
        "door": {"type": "string", "enum": ["one-way", "two-way"]},
        "red_lines": red_lines(),
        "why": s(),
    }))
});

pub static VERIFIER: LazyLock<Value> = LazyLock::new(|| {
    object(json!({
        "ran": {"type": "boolean"},
        "saw": s(),
        "mismatches": {"type": "array", "items": object(json!({"expected": s(), "observed": s()}))},
    }))
});

pub static WRITER: LazyLock<Value> =
    LazyLock::new(|| object(json!({"summary": s(), "changes": strings()})));

// Field readers: a missing or mistyped field → why.

fn field<'a>(v: &'a Value, k: &str) -> Result<&'a Value, String> {
    v.get(k).ok_or_else(|| format!("{k} is missing"))
}

fn text(v: &Value, k: &str) -> Result<String, String> {
    field(v, k)?
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("{k} must be a string"))
}

fn text_or_null(v: &Value, k: &str) -> Result<Option<String>, String> {
    match field(v, k)? {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
        _ => Err(format!("{k} must be a string or null")),
    }
}

fn flag(v: &Value, k: &str) -> Result<bool, String> {
    field(v, k)?
        .as_bool()
        .ok_or_else(|| format!("{k} must be true or false"))
}

fn items<'a>(v: &'a Value, k: &str) -> Result<&'a Vec<Value>, String> {
    field(v, k)?
        .as_array()
        .ok_or_else(|| format!("{k} must be a list"))
}

/// A list of strings, each one-lined, empty ones dropped.
fn lines(v: &Value, k: &str) -> Result<Vec<String>, String> {
    items(v, k)?
        .iter()
        .map(|x| {
            x.as_str()
                .map(one_line)
                .ok_or_else(|| format!("{k} must be a list of strings"))
        })
        .filter(|r| r.as_ref().map_or(true, |s| !s.is_empty()))
        .collect()
}

fn each<T>(v: &Value, k: &str, f: impl Fn(&Value) -> Result<T, String>) -> Result<Vec<T>, String> {
    items(v, k)?
        .iter()
        .enumerate()
        .map(|(i, x)| f(x).map_err(|e| format!("{k}[{i}]: {e}")))
        .collect()
}

static SPEC_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Z]+-\d+$").expect("spec id regex"));

/// A concern the design raises (PIP-26).
#[derive(Debug, Clone, PartialEq)]
pub struct Concern {
    pub what: String,
    pub why: String,
    pub policy: Option<String>,
}

/// An `## Open questions` bullet and the design's answer.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenQuestion {
    pub question: String,
    pub answer: Option<String>,
    pub carried: bool,
}

/// The design's result (PIP-25).
#[derive(Debug, Clone, PartialEq)]
pub struct DesignResult {
    /// The Conventional Commit type (`feat`, `fix`, …).
    pub kind: String,
    pub scope: String,
    pub breaking: bool,
    pub spec_ids: Vec<String>,
    pub concerns: Vec<Concern>,
    pub open_questions: Vec<OpenQuestion>,
    pub summary: String,
}

impl DesignResult {
    /// Also: a `type` outside [`TYPES`], a spec ID not `^[A-Z]+-\d+$`, an open question with
    /// both or neither of `answer` and `carried` → why. Extra keys are ignored (`data.design`).
    pub fn from_json(v: &Value) -> Result<DesignResult, String> {
        let kind = text(v, "type")?;
        if !TYPES.contains(&kind.as_str()) {
            return Err(format!("type must be one of {}", TYPES.join(", ")));
        }
        let scope = one_line(&text(v, "scope")?);
        if scope.contains(['(', ')', ':']) {
            return Err("scope must not contain (, ) or :".into());
        }
        let spec_ids = lines(v, "spec_ids")?;
        if let Some(bad) = spec_ids.iter().find(|i| !SPEC_ID.is_match(i)) {
            return Err(format!("spec_ids: {bad} is not like PIP-12"));
        }
        let concerns = each(v, "concerns", |c| {
            Ok(Concern {
                what: one_line(&text(c, "what")?),
                why: one_line(&text(c, "why")?),
                policy: text_or_null(c, "policy")?.map(|p| one_line(&p)),
            })
        })?;
        let open_questions = each(v, "open_questions", |q| {
            let answer = text_or_null(q, "answer")?.map(|a| one_line(&a));
            let carried = flag(q, "carried")?;
            if answer.is_some() == carried {
                return Err("answer xor carried".into());
            }
            Ok(OpenQuestion {
                question: one_line(&text(q, "question")?),
                answer,
                carried,
            })
        })?;
        Ok(DesignResult {
            kind,
            scope,
            breaking: flag(v, "breaking")?,
            spec_ids,
            concerns,
            open_questions,
            summary: text(v, "summary")?,
        })
    }

    /// Its JSON (the schema's keys), for `data.design`.
    pub fn to_json(&self) -> Value {
        json!({
            "type": self.kind,
            "scope": self.scope,
            "breaking": self.breaking,
            "spec_ids": self.spec_ids,
            "concerns": self.concerns.iter().map(|c| json!({
                "what": c.what, "why": c.why, "policy": c.policy,
            })).collect::<Vec<_>>(),
            "open_questions": self.open_questions.iter().map(|q| json!({
                "question": q.question, "answer": q.answer, "carried": q.carried,
            })).collect::<Vec<_>>(),
            "summary": self.summary,
        })
    }

    /// One `open_questions` entry per `## Open questions` bullet of the intent (PIP-25).
    pub fn check_questions(&self, bullets: &[String]) -> Result<(), String> {
        if self.open_questions.len() != bullets.len() {
            return Err(format!(
                "open_questions: {} entries for {} ## Open questions bullets",
                self.open_questions.len(),
                bullets.len()
            ));
        }
        Ok(())
    }
}

/// The plan (PIP-28).
#[derive(Debug, Clone, PartialEq)]
pub struct PlanResult {
    pub files: Vec<String>,
    pub order: Vec<String>,
    pub risks: Vec<String>,
    pub proof: Vec<String>,
}

impl PlanResult {
    pub fn from_json(v: &Value) -> Result<PlanResult, String> {
        if !v.is_object() {
            return Err("plan must be an object".into());
        }
        Ok(PlanResult {
            files: lines(v, "files")?,
            order: lines(v, "order")?,
            risks: lines(v, "risks")?,
            proof: lines(v, "proof")?,
        })
    }

    pub fn to_json(&self) -> Value {
        json!({"files": self.files, "order": self.order, "risks": self.risks, "proof": self.proof})
    }
}

/// A build or repair's result (PIP-1).
#[derive(Debug, Clone, PartialEq)]
pub struct WorkerResult {
    /// `done` (true) or `blocked`.
    pub done: bool,
    pub question: Option<String>,
    pub notes: String,
    pub plan: Option<PlanResult>,
    pub plan_why: Option<String>,
    pub lower_a: Option<u8>,
    pub lower_why: Option<String>,
}

impl WorkerResult {
    /// Also: `blocked` without a question, a `plan` without `plan_why` → why.
    pub fn from_json(v: &Value) -> Result<WorkerResult, String> {
        let done = match text(v, "status")?.as_str() {
            "done" => true,
            "blocked" => false,
            _ => return Err("status must be done or blocked".into()),
        };
        let question = text_or_null(v, "question")?;
        if !done && question.is_none() {
            return Err("blocked needs a question".into());
        }
        let plan = match field(v, "plan")? {
            Value::Null => None,
            p => Some(PlanResult::from_json(p).map_err(|e| format!("plan: {e}"))?),
        };
        let plan_why = text_or_null(v, "plan_why")?;
        if plan.is_some() && plan_why.is_none() {
            return Err("plan needs plan_why".into());
        }
        let lower_a = match field(v, "lower_a")? {
            Value::Null => None,
            n => Some(
                n.as_u64()
                    .filter(|n| (1..=5).contains(n))
                    .ok_or("lower_a must be 1-5 or null")? as u8,
            ),
        };
        Ok(WorkerResult {
            done,
            question,
            notes: text(v, "notes")?,
            plan,
            plan_why,
            lower_a,
            lower_why: text_or_null(v, "lower_why")?,
        })
    }
}

/// A `Proposed outcome` bullet's verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub bullet: String,
    pub met: bool,
    pub why: String,
}

/// A review finding (PIP-5).
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub pass: String,
    pub important: bool,
    pub file: String,
    pub line: Option<u64>,
    pub what: String,
    pub rule: Option<String>,
    pub policy: Option<String>,
}

/// A red line touched, with the file.
#[derive(Debug, Clone, PartialEq)]
pub struct RedLine {
    pub line: String,
    pub file: String,
}

fn red_lines_of(v: &Value) -> Result<Vec<RedLine>, String> {
    each(v, "red_lines", |r| {
        Ok(RedLine {
            line: one_line(&text(r, "line")?),
            file: one_line(&text(r, "file")?),
        })
    })
}

fn door(s: &str) -> Result<Door, String> {
    match s {
        "one-way" => Ok(Door::OneWay),
        "two-way" => Ok(Door::TwoWay),
        _ => Err("door must be one-way or two-way".into()),
    }
}

/// The PR review's result (PIP-5); `approved` and risk are computed in code from it.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewResult {
    pub approved: bool,
    pub outcomes: Vec<Verdict>,
    pub tests_weakened: bool,
    pub weakened_where: String,
    pub plan_followed: bool,
    pub not_followed_where: String,
    pub findings: Vec<Finding>,
    pub door: Option<Door>,
    pub red_lines: Vec<RedLine>,
    pub why: String,
}

impl ReviewResult {
    pub fn from_json(v: &Value) -> Result<ReviewResult, String> {
        let tw = field(v, "tests_weakened")?;
        let pf = field(v, "plan_followed")?;
        let door = match field(v, "door")? {
            Value::Null => None,
            Value::String(s) => Some(door(s)?),
            _ => return Err("door must be one-way, two-way or null".into()),
        };
        Ok(ReviewResult {
            approved: flag(v, "approved")?,
            outcomes: each(v, "outcomes", |o| {
                Ok(Verdict {
                    bullet: one_line(&text(o, "bullet")?),
                    met: flag(o, "met")?,
                    why: one_line(&text(o, "why")?),
                })
            })?,
            tests_weakened: flag(tw, "weakened").map_err(|e| format!("tests_weakened: {e}"))?,
            weakened_where: text(tw, "where").map_err(|e| format!("tests_weakened: {e}"))?,
            plan_followed: flag(pf, "followed").map_err(|e| format!("plan_followed: {e}"))?,
            not_followed_where: text(pf, "where").map_err(|e| format!("plan_followed: {e}"))?,
            findings: each(v, "findings", |f| {
                let important = match text(f, "severity")?.as_str() {
                    "important" => true,
                    "nit" => false,
                    _ => return Err("severity must be important or nit".into()),
                };
                let line = match field(f, "line")? {
                    Value::Null => None,
                    n => Some(n.as_u64().ok_or("line must be an integer or null")?),
                };
                Ok(Finding {
                    pass: one_line(&text(f, "pass")?),
                    important,
                    file: one_line(&text(f, "file")?),
                    line,
                    what: one_line(&text(f, "what")?),
                    rule: text_or_null(f, "rule")?.map(|r| one_line(&r)),
                    policy: text_or_null(f, "policy")?.map(|p| one_line(&p)),
                })
            })?,
            door,
            red_lines: red_lines_of(v)?,
            why: text(v, "why")?,
        })
    }
}

/// Triage of e2e red after my merge (PIP-20).
#[derive(Debug, Clone, PartialEq)]
pub struct TriageResult {
    pub door: Door,
    pub red_lines: Vec<RedLine>,
    pub why: String,
}

impl TriageResult {
    pub fn from_json(v: &Value) -> Result<TriageResult, String> {
        Ok(TriageResult {
            door: door(&text(v, "door")?)?,
            red_lines: red_lines_of(v)?,
            why: text(v, "why")?,
        })
    }
}

/// A verifier mismatch.
#[derive(Debug, Clone, PartialEq)]
pub struct Mismatch {
    pub expected: String,
    pub observed: String,
}

/// The verifier's report (PIP-32).
#[derive(Debug, Clone, PartialEq)]
pub struct VerifierReport {
    pub ran: bool,
    pub saw: String,
    pub mismatches: Vec<Mismatch>,
}

impl VerifierReport {
    pub fn from_json(v: &Value) -> Result<VerifierReport, String> {
        Ok(VerifierReport {
            ran: flag(v, "ran")?,
            saw: text(v, "saw")?,
            mismatches: each(v, "mismatches", |m| {
                Ok(Mismatch {
                    expected: one_line(&text(m, "expected")?),
                    observed: one_line(&text(m, "observed")?),
                })
            })?,
        })
    }
}

/// The PR writer's text (PIP-11).
#[derive(Debug, Clone, PartialEq)]
pub struct WriterResult {
    pub summary: String,
    /// At most 5.
    pub changes: Vec<String>,
}

impl WriterResult {
    /// An empty summary → why; `changes` trimmed to 5.
    pub fn from_json(v: &Value) -> Result<WriterResult, String> {
        let summary = one_line(&text(v, "summary")?);
        if summary.is_empty() {
            return Err("summary is empty".into());
        }
        let mut changes = lines(v, "changes")?;
        changes.truncate(5);
        Ok(WriterResult { summary, changes })
    }
}
