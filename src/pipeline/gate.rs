//! Gate (PIP-7, PIP-14's final text, PIP-15): after the review, the PR text is written (the
//! writer, else the template; never blocks), then `autonomy::gate` decides in code: merge, or
//! `review and merge PR` with the review's findings as one PR comment per head.

use serde_json::{Value, json};

use crate::autonomy::{self, Ci, GateIn, PrKind, RepoState};
use crate::handler::{ChildEnd, Ctx, Handler, Outcome, Progress, StepError};
use crate::indicators;
use crate::machine::{Door, Waiting};
use crate::metrics::{self, Ev, Metric};
use crate::mission::Mission;
use crate::writer::{self, Checks, Inputs};

use super::data::Data;
use super::plan::spec_ids;
use super::schemas::ReviewResult;
use super::{Mode, conventional, files, gh, intent, never_published};

/// How long the gate waits for a `towercab/evals` status on a Towercab PR.
pub const EVALS_POLL: std::time::Duration = std::time::Duration::from_secs(60);

/// The findings comment (pipeline.md **PR text**): `**Review findings**: <i> important, <k>
/// nits`, the important ones first, at most `nit_cap` nits, `<rest> more nits.`; no findings →
/// none.
pub fn findings_comment(r: &ReviewResult, nit_cap: u32) -> Option<String> {
    if r.findings.is_empty() {
        return None;
    }
    let important: Vec<_> = r.findings.iter().filter(|f| f.important).collect();
    let nits: Vec<_> = r.findings.iter().filter(|f| !f.important).collect();
    let s = |n: usize| if n == 1 { "" } else { "s" };
    let mut out = vec![format!(
        "**Review findings**: {} important, {} nit{}",
        important.len(),
        nits.len(),
        s(nits.len())
    )];
    let item = |f: &super::schemas::Finding| {
        let at = match f.line {
            Some(l) => format!("{}:{l}", f.file),
            None => f.file.clone(),
        };
        let mut why = f.pass.clone();
        if let Some(r) = &f.rule {
            why.push_str(&format!("; rule: {r}"));
        }
        if let Some(p) = &f.policy {
            why.push_str(&format!("; policy: {p}"));
        }
        let sev = if f.important { "**important**" } else { "nit" };
        format!("- {sev} `{at}` {} ({why})", f.what)
    };
    out.extend(important.iter().map(|f| item(f)));
    let cap = nit_cap as usize;
    out.extend(nits.iter().take(cap).map(|f| item(f)));
    if nits.len() > cap {
        let rest = nits.len() - cap;
        out.push(format!("{rest} more nit{}.", s(rest)));
    }
    Some(out.join("\n") + "\n")
}

/// The gate's CI from `data.ci.result`.
pub fn ci_of(data: &Data) -> Ci {
    match data
        .get("ci")
        .and_then(|c| c.get("result"))
        .and_then(Value::as_str)
    {
        Some("green" | "flaky") => Ci::Green,
        Some("none") => Ci::None,
        _ => Ci::NotGreen,
    }
}

/// The review as the gate sees it (`data.review`; none or failed → not approved).
pub fn review_of(data: &Data) -> Option<autonomy::Review> {
    let r = data.get("review")?;
    let result = r
        .get("result")
        .and_then(|x| ReviewResult::from_json(x).ok());
    Some(autonomy::Review {
        approved: r.get("approved").and_then(Value::as_bool).unwrap_or(false),
        door: result
            .as_ref()
            .and_then(|x| x.door)
            .unwrap_or(Door::Unknown),
        red_lines: result.as_ref().is_some_and(|x| !x.red_lines.is_empty()),
    })
}

/// The `gate` stage.
pub struct Gate {
    mode: Mode,
}

impl Gate {
    pub fn new(mode: Mode) -> Gate {
        Gate { mode }
    }

    /// The final text's inputs (PIP-14).
    pub fn inputs(cx: &Ctx<'_>, m: &Mission) -> Result<Inputs, StepError> {
        let data = Data::of(m);
        let intent = intent(cx, m)?;
        let title = data
            .get("design")
            .and_then(|d| d.get("title"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| conventional("feat", "", false, intent.title()));
        let line = |k: &str| {
            data.get(k)
                .and_then(|v| v.get("line"))
                .and_then(Value::as_str)
                .unwrap_or("not run")
                .to_string()
        };
        let review = data.get("review");
        let result = review
            .and_then(|r| r.get("result"))
            .and_then(|x| ReviewResult::from_json(x).ok());
        let verdicts = result
            .as_ref()
            .map(|r| {
                r.outcomes
                    .iter()
                    .map(|v| {
                        let met = if v.met { "met" } else { "not met" };
                        format!("{}: {met}: {}", v.bullet, v.why)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let approved = review
            .and_then(|r| r.get("approved"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let reasons: Vec<String> = review
            .and_then(|r| r.get("reasons"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_else(|| vec!["no review".into()]);
        let ci = data
            .get("ci")
            .and_then(|c| c.get("result"))
            .and_then(Value::as_str)
            .map(writer::ci_line)
            .unwrap_or_else(|| "not run".into());
        Ok(Inputs {
            title,
            notes: writer::notes(cx, m),
            verdicts,
            spec_ids: spec_ids(&data),
            checks: Checks {
                verify: line("verify"),
                proof: line("proof"),
                ci,
                verifier: line("verifier"),
                review: writer::review_line(approved, &reasons),
            },
            plan_url: data.str("plan_url").map(str::to_string),
            closes: intent
                .source()
                .and_then(|s| s.strip_prefix("issue:"))
                .map(|s| s.trim().to_string()),
            footer: writer::footer(cx, m),
        })
    }

    /// The PR is the Towercab repo's (`[repos]`' entry named `towercab`, PIP-33).
    fn towercab_pr(cx: &Ctx<'_>, m: &Mission) -> Result<bool, StepError> {
        let github = gh::github(cx, m)?;
        Ok(super::evals::towercab_repo(cx.config).is_some_and(|r| r.github == github))
    }

    /// The gate's first decision on a head (MET-25, MET-26): each review finding by `path`
    /// (`auto`: it merges), and a Towercab PR's evals as read (`pass`/`drop`).
    fn count(m: &Mission, data: &Data, g: &autonomy::Gate, evals: Option<bool>) {
        let ev = Ev::of(m);
        let path = match g {
            autonomy::Gate::Merge => "auto",
            autonomy::Gate::Approval(_) => "approval",
        };
        let findings = data
            .get("review")
            .and_then(|r| r.get("result"))
            .and_then(|r| r.get("findings"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for f in findings {
            let s = |k: &str| {
                f.get(k)
                    .and_then(Value::as_str)
                    .unwrap_or("none")
                    .to_string()
            };
            let (pass, policy, severity) = (s("pass"), s("policy"), s("severity"));
            metrics::add(
                Metric::ReviewFindings,
                1.0,
                &[
                    ("repo", &m.repo),
                    ("pass", &pass),
                    ("policy", &policy),
                    ("severity", &severity),
                    ("path", path),
                ],
                &ev,
            );
        }
        if let Some(red) = evals {
            let result = if red { "drop" } else { "pass" };
            metrics::add(Metric::EvalGate, 1.0, &[("result", result)], &ev);
        }
    }

    /// `towercab/evals` red on the head (PIP-33): only on the Towercab repo (`[repos]`' entry
    /// named `towercab`); absent or pending → `None` (poll).
    fn evals_red(cx: &Ctx<'_>, m: &Mission) -> Result<Option<bool>, StepError> {
        let github = gh::github(cx, m)?;
        if super::evals::towercab_repo(cx.config).is_none_or(|r| r.github != github) {
            return Ok(Some(false));
        }
        let head = m.head.clone().unwrap_or_default();
        let out = gh::gh(
            cx,
            m,
            &["api", &format!("repos/{github}/commits/{head}/status")],
        )?;
        let v: Value = serde_json::from_str(&out)
            .map_err(|e| StepError::Bug(format!("gh api status: {e}")))?;
        let state = v
            .get("statuses")
            .and_then(Value::as_array)
            .and_then(|a| {
                a.iter()
                    .find(|s| s.get("context").and_then(Value::as_str) == Some("towercab/evals"))
            })
            .and_then(|s| s.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("");
        Ok(match state {
            "failure" | "error" => Some(true),
            "success" => Some(false),
            _ => None,
        })
    }

    /// `autonomy::gate` (PIP-7): merge → `ok` (`gate.head`, `gate.verdict`); approval → the
    /// findings comment once per head, `review and merge PR`.
    fn decide(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let repo_files = match files(cx, m) {
            Ok(f) => f,
            Err(o) => return Ok(Progress::Done(o)),
        };
        let intent = intent(cx, m)?;
        let state = RepoState::read(cx.db.conn(), &m.repo, &repo_files.towercab)?;
        let cap = state.cap();
        let a = autonomy::effective(m.a_at_pick, intent.a(), cap);
        let mut data = Data::of(m);
        let review = review_of(&data);
        let gin = GateIn {
            kind: PrKind::Intent,
            frozen: state.frozen,
            cap,
            a,
            ci: ci_of(&data),
            unlock: !intent.unlock().is_empty(),
            evals_red: false,
            review,
        };
        let mut g = autonomy::gate(&gin);
        let head = m.head.clone().unwrap_or_default();
        let old = data.get("gate").cloned().unwrap_or(Value::Null);
        let commented = old.get("commented").cloned().unwrap_or(Value::Null);
        let mut hold_why = None;
        // The Towercab PR's `towercab/evals` as read (MET-25).
        let mut evals_read = None;
        // `towercab/evals` only matters for a merge: a gate that goes to me anyway doesn't
        // wait for it. Absent or pending → poll, at most `evals::BOUND` on this head.
        if matches!(g, autonomy::Gate::Merge) {
            match Self::evals_red(cx, m)? {
                Some(red) => {
                    if Self::towercab_pr(cx, m)? {
                        evals_read = Some(red);
                    }
                    g = autonomy::gate(&GateIn {
                        evals_red: red,
                        ..gin
                    })
                }
                None => {
                    let now = cx.tick.unix();
                    let since = old
                        .get("evals_since")
                        .and_then(Value::as_f64)
                        .filter(|_| old.get("head").and_then(Value::as_str) == Some(&head))
                        .unwrap_or(now);
                    let bound = super::evals::BOUND.as_secs_f64();
                    if !(cx.timeouts && now - since >= bound) {
                        data.set(
                            "gate",
                            json!({"head": head, "evals_since": since, "commented": commented,
                                   "counted": old.get("counted").cloned().unwrap_or(Value::Null)}),
                        );
                        cx.record(m, "decide", &[("data", data.text().into())])?;
                        return Ok(Progress::Poll { after: EVALS_POLL });
                    }
                    hold_why = Some(format!(
                        "towercab/evals not posted after {} h",
                        super::evals::BOUND.as_secs() / 3600
                    ));
                    g = autonomy::Gate::Approval(autonomy::Hold::EvalsRed);
                }
            }
        }
        let label = indicators::gate_label(&g, a);
        // Counted once per head (my continue re-runs the gate on it).
        if old.get("counted").and_then(Value::as_str) != Some(head.as_str()) {
            Self::count(m, &data, &g, evals_read);
        }
        match g {
            autonomy::Gate::Merge => {
                let verdict = match a {
                    Some(a) => format!("a{a} approved"),
                    None => "approved, risk low".into(),
                };
                data.set(
                    "gate",
                    json!({"head": head, "verdict": verdict, "commented": commented,
                           "label": label, "counted": head}),
                );
                Ok(Progress::Done(Outcome::ok().with("data", data.text())))
            }
            autonomy::Gate::Approval(hold) => {
                let hold = hold_why.unwrap_or_else(|| hold.to_string());
                data.set(
                    "gate",
                    json!({"head": head, "hold": hold, "commented": commented,
                           "label": label, "counted": head}),
                );
                let m = cx.record(m, "comment", &[("data", data.text().into())])?;
                self.comment(cx, &m)
            }
        }
    }

    /// The findings as one PR comment, once per head (`gate.commented`), then the wait.
    fn comment(&self, cx: &Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        let mut gate = data.get("gate").cloned().unwrap_or(json!({}));
        let head = m.head.clone().unwrap_or_default();
        let hold = gate
            .get("hold")
            .and_then(Value::as_str)
            .unwrap_or("not approved")
            .to_string();
        if gate.get("commented").and_then(Value::as_str) != Some(head.as_str()) {
            // Recorded before it is posted: a crash in between loses the comment rather than
            // posting it twice on this head (PIP-7, LOOP-6).
            gate["commented"] = json!(head);
            data.set("gate", gate.clone());
            let m = &cx.record(m, "comment", &[("data", data.text().into())])?;
            let result = data
                .get("review")
                .and_then(|r| r.get("result"))
                .and_then(|x| ReviewResult::from_json(x).ok());
            let nit_cap = match files(cx, m) {
                Ok(f) => f.review.nit_cap,
                Err(_) => crate::repo::review::DEFAULT_NIT_CAP,
            };
            if let Some(text) = result.as_ref().and_then(|r| findings_comment(r, nit_cap)) {
                let file = cx
                    .runs(m)
                    .join(format!("findings-{}.md", &head[..head.len().min(7)]));
                std::fs::create_dir_all(cx.runs(m))
                    .and_then(|()| std::fs::write(&file, &text))
                    .map_err(|e| StepError::Bug(format!("{}: {e}", file.display())))?;
                let github = gh::github(cx, m)?;
                let n = m.pr.unwrap_or_default().to_string();
                let f = file.to_string_lossy().into_owned();
                if let Err(e) = gh::try_gh(
                    cx,
                    m,
                    &["pr", "comment", &n, "-R", &github, "--body-file", &f],
                )? {
                    eprintln!(
                        "towercab: {}: findings comment: {}",
                        m.label(),
                        crate::outbox::one_line(&e)
                    );
                }
            }
        }
        Ok(Progress::Done(
            Outcome::wait(Waiting::ReviewAndMergePr, hold).with("data", data.text()),
        ))
    }

    /// `text:patch`: the body set (never blocks), then `decide`.
    fn patched(&self, cx: &Ctx<'_>, m: &Mission, body: &str) -> Result<Progress, StepError> {
        writer::patch(cx, m, body);
        let m = cx.record(m, "decide", &[])?;
        self.decide(cx, &m)
    }
}

impl Handler for Gate {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        if self.mode.eval() {
            return Ok(Progress::Done(Outcome::ok()));
        }
        if let Some(p) = never_published(m) {
            return Ok(p);
        }
        match m.step.as_str() {
            "decide" => self.decide(cx, m),
            "comment" => self.comment(cx, m),
            "text:run" => super::runs::restart(cx, m),
            _ => {
                let i = Self::inputs(cx, m)?;
                match writer::start(cx, m, &i, false)? {
                    Ok(p) => Ok(p),
                    Err(template) => {
                        let m = cx.record(m, "text:patch", &[])?;
                        self.patched(cx, &m, &template)
                    }
                }
            }
        }
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        let i = Self::inputs(cx, m)?;
        let body = writer::finish(cx, m, &end, &i)?;
        let m = cx.record(m, "text:patch", &[])?;
        self.patched(cx, &m, &body)
    }
}
