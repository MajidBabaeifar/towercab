//! Evals (PIP-33): every intent that reaches `done` through `release` leaves a case
//! (`evals/<id>.json` on `intents`); `towercab eval` replays the newest 20 (plus every incident
//! case) with the build under test: each case a [`Loop`] in `Mode::Eval` on a scratch home,
//! design → … → review, never publishing. The loop posts `towercab/evals` on each Towercab PR
//! head ([`poll`]) and runs a baseline weekly, after a policies change or a model change.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use crate::checkout;
use crate::config::{Config, RepoConfig};
use crate::db::{Db, get_meta, set_meta};
use crate::exes::{self, Exes};
use crate::github::{GhError, Identity};
use crate::handler::{ChildEnd, ChildKind, ChildSpec, Ctx, Handler, Progress, StepError};
use crate::home::Home;
use crate::intents::store::rfc3339;
use crate::intents::{Intent, Store, id};
use crate::machine::Stage;
use crate::mission::{self, Mission};
use crate::outbox::{self, Notice, one_line};
use crate::pick;
use crate::runloop::{Loop, LoopOpts, Tick};

use super::data::Data;
use super::{EvalCases, Mode, design, plan, policies, store_failed};

/// Cases a run needs before a comparison means anything (my call: fewer can't tell a
/// regression from noise).
pub const CASES: usize = 20;
/// A drop this many points below the baseline (with a case that passed there failing twice)
/// is red.
pub const DROP: f64 = 10.0;
/// The status context.
pub const CONTEXT: &str = "towercab/evals";
/// An eval child's bound.
pub const BOUND: Duration = Duration::from_secs(12 * 3600);
/// The weekly baseline.
pub const WEEK: f64 = 7.0 * 86400.0;
/// A case's loop stopped by SIGTERM or SIGINT: the run stops too.
pub const INTERRUPTED: &str = "eval interrupted";
/// Passes of a case's loop.
pub const PASS: Duration = Duration::from_secs(1);

/// An eval case (`evals/<id>.json`).
#[derive(Debug, Clone, PartialEq)]
pub struct Case {
    pub id: String,
    pub repo: String,
    pub base_sha: String,
    /// `intent.md` as I wrote it (`design::mine`).
    pub intent_md: String,
    pub spec_ids: Vec<String>,
    pub model: String,
    /// The base's ` ```checks ` lines.
    pub checks: Vec<String>,
    pub merge_sha: String,
    /// RFC 3339.
    pub added: String,
    pub incident: bool,
}

impl Case {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "repo": self.repo, "base_sha": self.base_sha,
            "intent_md": self.intent_md, "spec_ids": self.spec_ids, "model": self.model,
            "checks": self.checks, "merge_sha": self.merge_sha, "added": self.added,
            "incident": self.incident,
        })
    }

    /// A missing or mistyped field → why.
    pub fn from_json(v: &Value) -> Result<Case, String> {
        let s = |k: &str| -> Result<String, String> {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("{k} must be a string"))
        };
        let list = |k: &str| -> Result<Vec<String>, String> {
            v.get(k)
                .and_then(Value::as_array)
                .and_then(|a| a.iter().map(|x| x.as_str().map(str::to_string)).collect())
                .ok_or_else(|| format!("{k} must be a list of strings"))
        };
        let case = Case {
            id: s("id")?,
            repo: s("repo")?,
            base_sha: s("base_sha")?,
            intent_md: s("intent_md")?,
            spec_ids: list("spec_ids")?,
            model: s("model")?,
            checks: list("checks")?,
            merge_sha: s("merge_sha")?,
            added: s("added")?,
            incident: v.get("incident").and_then(Value::as_bool).unwrap_or(false),
        };
        if id::split_dir(&format!("{}-x", case.id)).is_none() || case.base_sha.is_empty() {
            return Err(format!("{}: not an intent id with a base sha", case.id));
        }
        Ok(case)
    }
}

/// The case of an intent `release` brings to `done` (Mode::Live): `evals/<id>.json` on
/// `intents` (`Store::put`, commit `towercab: eval <id>`).
pub fn write_case(cx: &Ctx<'_>, m: &Mission) -> Result<(), StepError> {
    let intent = super::intent(cx, m)?;
    let checks = super::files(cx, m)
        .map(|f| f.verifying.checks)
        .unwrap_or_default();
    let rel = format!("evals/{}.json", intent.id);
    let merge_sha = m.merge_sha.clone().unwrap_or_default();
    // Written again (a re-entry after a crash): the same text, no second commit; an incident
    // mark kept.
    let earlier = fs::read_to_string(cx.store.path().join(&rel))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| Case::from_json(&v).ok())
        .filter(|c| c.merge_sha == merge_sha);
    let case = Case {
        id: intent.id.clone(),
        repo: m.repo.clone(),
        base_sha: m.base_sha.clone().unwrap_or_default(),
        intent_md: design::mine(&intent).render(),
        spec_ids: plan::spec_ids(&Data::of(m)),
        model: m.model.clone(),
        checks,
        merge_sha,
        added: earlier
            .as_ref()
            .map_or_else(|| rfc3339(cx.tick.wall), |c| c.added.clone()),
        incident: earlier.is_some_and(|c| c.incident),
    };
    let text = serde_json::to_string_pretty(&case.to_json()).map_err(|e| e.to_string())? + "\n";
    cx.store
        .put(&rel, &text, &format!("eval {}", case.id))
        .map(drop)
        .map_err(store_failed)
}

/// The `*.json` cases in `dir` (unreadable ones skipped, logged), newest first.
pub fn read_dir(dir: &Path) -> Vec<Case> {
    let mut out: Vec<Case> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| {
            let text = fs::read_to_string(&p).ok()?;
            match serde_json::from_str::<Value>(&text)
                .map_err(|e| e.to_string())
                .and_then(|v| Case::from_json(&v))
            {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("towercab: eval case {}: {e}", p.display());
                    None
                }
            }
        })
        .collect();
    out.sort_by(|a, b| b.added.cmp(&a.added).then(a.id.cmp(&b.id)));
    out
}

/// The cases a run replays: the newest [`CASES`] by `added`, plus every `incident: true`
/// (the store's working tree as it is), newest first.
pub fn cases(store: &Store) -> Vec<Case> {
    let all = read_dir(&store.path().join("evals"));
    all.iter()
        .enumerate()
        .filter(|(i, c)| *i < CASES || c.incident)
        .map(|(_, c)| c.clone())
        .collect()
}

/// One case's outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct CaseResult {
    pub pass: bool,
    pub tries: u32,
    pub why: String,
}

/// A run's `result.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct RunResult {
    /// `yymmdd-hhmmss`.
    pub run: String,
    pub version: String,
    pub cases: BTreeMap<String, CaseResult>,
    pub passed: usize,
    pub total: usize,
    /// Percent passed (0 without cases).
    pub rate: f64,
}

impl RunResult {
    pub fn new(run: &str, cases: BTreeMap<String, CaseResult>) -> RunResult {
        let total = cases.len();
        let passed = cases.values().filter(|c| c.pass).count();
        RunResult {
            run: run.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            rate: if total == 0 {
                0.0
            } else {
                passed as f64 * 100.0 / total as f64
            },
            cases,
            passed,
            total,
        }
    }

    pub fn to_json(&self) -> Value {
        let cases: serde_json::Map<String, Value> = self
            .cases
            .iter()
            .map(|(k, c)| {
                (
                    k.clone(),
                    json!({"pass": c.pass, "tries": c.tries, "why": c.why}),
                )
            })
            .collect();
        json!({"run": self.run, "version": self.version, "cases": cases,
               "passed": self.passed, "total": self.total, "rate": self.rate})
    }

    pub fn from_json(v: &Value) -> Result<RunResult, String> {
        let cases = v
            .get("cases")
            .and_then(Value::as_object)
            .ok_or("cases must be an object")?
            .iter()
            .map(|(k, c)| {
                Ok((
                    k.clone(),
                    CaseResult {
                        pass: c.get("pass").and_then(Value::as_bool).ok_or("pass")?,
                        tries: c.get("tries").and_then(Value::as_u64).unwrap_or(1) as u32,
                        why: c
                            .get("why")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>, &str>>()
            .map_err(|k| format!("a case without {k}"))?;
        let run = v.get("run").and_then(Value::as_str).unwrap_or_default();
        let mut r = RunResult::new(run, cases);
        if let Some(ver) = v.get("version").and_then(Value::as_str) {
            r.version = ver.to_string();
        }
        Ok(r)
    }

    /// `<passed>/<total> (<rate>%)`.
    pub fn summary(&self) -> String {
        format!("{}/{} ({:.0}%)", self.passed, self.total, self.rate)
    }

    pub fn read(path: &Path) -> Result<RunResult, String> {
        let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        RunResult::from_json(&v).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn write(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let text = serde_json::to_string_pretty(&self.to_json()).map_err(|e| e.to_string())?;
        fs::write(path, text + "\n").map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// A `towercab/evals` status.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// `success`, `failure` or `error`.
    pub state: &'static str,
    /// ≤ 140 characters.
    pub description: String,
}

impl Verdict {
    pub fn new(state: &'static str, description: &str) -> Verdict {
        Verdict {
            state,
            description: outbox::cut(&one_line(description), 140),
        }
    }
}

/// The PR touches what the evals measure: `prompts/**` or `src/claude.rs`.
pub fn affected(files: &[String]) -> bool {
    // `gh pr view --json files` lists at most 100: a longer list can't say "not affected".
    files.len() >= FILES_SHOWN
        || files
            .iter()
            .any(|f| f.starts_with("prompts/") || f == "src/claude.rs")
}

/// The most files `gh pr view --json files` lists.
pub const FILES_SHOWN: usize = 100;

/// The statuses that need no run: unaffected → success `not affected`; fewer than [`CASES`]
/// cases → success `<n>/20 cases`.
pub fn cheap(files: &[String], cases: usize) -> Option<Verdict> {
    if !affected(files) {
        return Some(Verdict::new("success", "not affected"));
    }
    (cases < CASES).then(|| Verdict::new("success", &format!("{cases}/{CASES} cases")))
}

/// A run against the baseline: fewer than [`CASES`] cases → success `<n>/20 cases`; a case
/// that passed in the baseline failing both tries and the rate ≥ [`DROP`] points below it →
/// failure `dropped <d> points: <ids>`; else success `<rate>% (baseline <b>%)`.
pub fn compare(r: &RunResult, baseline: Option<&RunResult>) -> Verdict {
    if r.total < CASES {
        return Verdict::new("success", &format!("{}/{CASES} cases", r.total));
    }
    let Some(b) = baseline else {
        return Verdict::new("success", &format!("{:.0}% (no baseline)", r.rate));
    };
    let regressed: Vec<&str> = r
        .cases
        .iter()
        .filter(|(id, c)| !c.pass && c.tries >= 2 && b.cases.get(*id).is_some_and(|bc| bc.pass))
        .map(|(id, _)| id.as_str())
        .collect();
    if !regressed.is_empty() && r.rate <= b.rate - DROP {
        return Verdict::new(
            "failure",
            &format!(
                "dropped {:.0} points: {}",
                b.rate - r.rate,
                regressed.join(", ")
            ),
        );
    }
    Verdict::new(
        "success",
        &format!("{:.0}% (baseline {:.0}%)", r.rate, b.rate),
    )
}

/// `api -X POST repos/<r>/statuses/<sha> -f state -f context=towercab/evals -f description`.
pub fn post(identity: &Identity, github: &str, sha: &str, v: &Verdict) -> Result<(), GhError> {
    identity
        .gh(
            github,
            &[
                "api",
                "-X",
                "POST",
                &format!("repos/{github}/statuses/{sha}"),
                "-f",
                &format!("state={}", v.state),
                "-f",
                &format!("context={CONTEXT}"),
                "-f",
                &format!("description={}", v.description),
            ],
        )
        .map(drop)
}

/// The `[repos]` repo whose `github` name is `towercab`.
pub fn towercab_repo(config: &Config) -> Option<RepoConfig> {
    config
        .repos
        .values()
        .filter_map(|r| r.as_ref().ok())
        .find(|r| r.github.rsplit('/').next() == Some("towercab"))
        .cloned()
}

/// `yymmdd-hhmmss`.
pub fn run_name(tick: Tick) -> String {
    tick.wall.format("%y%m%d-%H%M%S").to_string()
}

/// `<home>/evals`.
pub fn dir(home: &Home) -> PathBuf {
    home.root.join("evals")
}

/// The baseline run's result (`meta.eval_baseline`), if any.
pub fn baseline_of(db: &Db, home: &Home) -> Result<Option<RunResult>, String> {
    let Some(run) = db.meta("eval_baseline")? else {
        return Ok(None);
    };
    RunResult::read(&dir(home).join(run).join("result.json")).map(Some)
}

/// The evals' pick (`Mode::Eval`): no fetch; the scratch clone's `origin/<base>` pinned at the
/// case's base sha, then [`pick::prepare`]: the checkout starts there and every handler sees
/// that base.
pub struct EvalPick {
    cases: EvalCases,
}

impl EvalPick {
    pub fn new(cases: EvalCases) -> EvalPick {
        EvalPick { cases }
    }
}

impl Handler for EvalPick {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let id = m.intent.clone().unwrap_or_default();
        let sha = self
            .cases
            .get(&id)
            .ok_or_else(|| StepError::Bug(format!("{id}: not an eval case")))?;
        let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
        checkout::git(
            &cx.exes.git,
            &repo.path,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{}", repo.base),
                sha,
            ],
            None,
        )
        .map_err(StepError::Bug)?;
        pick::prepare(cx, m)
    }

    fn finish(&mut self, _: &mut Ctx<'_>, m: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Err(StepError::Bug(format!("{}: pick runs no child", m.label())))
    }
}

/// `git` in `dir` without the App (local paths only).
fn git(exes: &Exes, dir: &Path, args: &[&str]) -> Result<String, String> {
    checkout::git(&exes.git, dir, args, None)
}

/// A run's clone of `repo`: `<run>/clones/<name>`, cloned from Towercab's clone (no network)
/// with its `refs/remotes/origin/*`; nothing fetches it (each case pins its base).
fn run_clone(exes: &Exes, repo: &RepoConfig, run: &Path) -> Result<PathBuf, String> {
    let dest = run.join("clones").join(&repo.name);
    if dest.join(".git").exists() {
        return Ok(dest);
    }
    let parent = dest.parent().ok_or("clones: no parent")?;
    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let (from, to) = (repo.path.to_string_lossy(), dest.to_string_lossy());
    git(
        exes,
        parent,
        &["clone", "--quiet", "--no-checkout", "--", &from, &to],
    )?;
    git(
        exes,
        &dest,
        &[
            "fetch",
            "--quiet",
            &from,
            "+refs/remotes/origin/*:refs/remotes/origin/*",
        ],
    )?;
    Ok(dest)
}

/// The scratch intents of a case: a bare `<home>/intents.git` whose `main` holds
/// `intents/<id>-<slug>/intent.md` (without `after`: the others aren't there).
fn scratch_intents(exes: &Exes, home: &Path, case: &Case) -> Result<PathBuf, String> {
    let mut intent = Intent::parse(&case.intent_md)?;
    let _ = intent.remove("after");
    let bare = home.join("intents.git");
    fs::create_dir_all(&bare).map_err(|e| format!("{}: {e}", bare.display()))?;
    git(exes, &bare, &["init", "--quiet", "--bare", "-b", "main"])?;
    let seed = home.join("seed");
    let (from, to) = (bare.to_string_lossy(), seed.to_string_lossy());
    git(exes, home, &["clone", "--quiet", "--", &from, &to])?;
    let rel = format!("intents/{}-{}/intent.md", case.id, id::slug(intent.title()));
    let path = seed.join(&rel);
    fs::create_dir_all(path.parent().unwrap_or(&seed)).map_err(|e| e.to_string())?;
    fs::write(&path, intent.render()).map_err(|e| format!("{}: {e}", path.display()))?;
    git(exes, &seed, &["add", "-A"])?;
    git(
        exes,
        &seed,
        &[
            "-c",
            "user.name=Towercab",
            "-c",
            "user.email=towercab@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "-m",
            &format!("eval {}", case.id),
        ],
    )?;
    git(exes, &seed, &["push", "--quiet", "origin", "HEAD:main"])?;
    checkout::remove(&seed)?;
    Ok(bare)
}

/// One try of a case in `home` (made anew): its own `towercab.db` and intents, the config
/// with `[intents]` pointed there, no `[telegram]` and only the case's repo (its clone `clone`);
/// `Loop::open(…, pipeline::handlers(Mode::Eval))` on the case until its mission ends. Pass =
/// `done` with verify green, the proof red on base or skipped, the review approved.
pub fn replay(
    config: &Config,
    exes: &Exes,
    case: &Case,
    clone: &Path,
    home: &Path,
    pass: Duration,
) -> Result<CaseResult, String> {
    // Its stages are no real intent's: only its runs' cost and tokens count (MET-16).
    let _scope = crate::metrics::eval_scope();
    checkout::remove(home)?;
    fs::create_dir_all(home).map_err(|e| format!("{}: {e}", home.display()))?;
    let bare = scratch_intents(exes, home, case)?;
    let mut c = config.clone();
    c.intents.remote = Some(bare.to_string_lossy().into_owned());
    c.intents.path = home.join("intents");
    c.telegram = None;
    let mut repo = config.repo(&case.repo)?.clone();
    repo.path = clone.to_path_buf();
    c.repos = BTreeMap::from([(case.repo.clone(), Ok(repo))]);
    let h = Home::resolve(Some(home))?;
    let mode = Mode::Eval(BTreeMap::from([(case.id.clone(), case.base_sha.clone())]));
    let opts = LoopOpts {
        intent: Some(case.id.clone()),
        pass,
        ..LoopOpts::default()
    };
    let lp = Loop::open(c, h.clone(), super::handlers(mode), exes.clone(), opts)?;
    let stop = lp.stop_flag();
    let ran = lp.run();
    if stop.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(INTERRUPTED.into());
    }
    let db = Db::open(&h.db())?;
    let m = mission::for_intent(db.conn(), &case.id)?.pop();
    let fail = |why: String| CaseResult {
        pass: false,
        tries: 1,
        why,
    };
    let Some(m) = m else {
        return Ok(fail(ran.err().unwrap_or_else(|| "never picked".into())));
    };
    Ok(judge(&m))
}

/// Pass = `done` with verify green, the proof red on base or skipped, the review approved.
pub fn judge(m: &Mission) -> CaseResult {
    let data = Data::of(m);
    let line = |k: &str| {
        data.get(k)
            .and_then(|v| v.get("line"))
            .and_then(Value::as_str)
            .unwrap_or("not run")
            .to_string()
    };
    let why = if m.stage != Stage::Done {
        let mut w = format!("ended at {}", m.stage);
        if let Some(x) = &m.waiting {
            w.push_str(&format!(" · {x}"));
        }
        if let Some(x) = &m.why {
            w.push_str(&format!(": {x}"));
        }
        Some(w)
    } else if !line("verify").starts_with("green") {
        Some(format!("verify: {}", line("verify")))
    } else if !(line("proof").starts_with("red on base") || line("proof").starts_with("skipped")) {
        Some(format!("proof: {}", line("proof")))
    } else {
        let review = data.get("review");
        let approved = review
            .and_then(|r| r.get("approved"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        (!approved).then(|| {
            let reasons: Vec<String> = review
                .and_then(|r| r.get("reasons"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            format!("review: not approved: {}", reasons.join("; "))
        })
    };
    CaseResult {
        pass: why.is_none(),
        tries: 1,
        why: why.unwrap_or_else(|| "pass".into()),
    }
}

/// Every case in `<dir>/<id>-<try>/` (a failed one once more, `tries` 2) → the run's result
/// (named after `dir`).
pub fn run_cases(
    config: &Config,
    exes: &Exes,
    cases: &[Case],
    dir: &Path,
    pass: Duration,
) -> Result<RunResult, String> {
    let mut out = BTreeMap::new();
    for case in cases {
        // A case that can't be set up fails alone (its repo left `[repos]`, its clone failed):
        // the run and every other case go on.
        let clone = match config
            .repo(&case.repo)
            .and_then(|repo| run_clone(exes, repo, dir))
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("towercab: eval {}: {e}", case.id);
                out.insert(
                    case.id.clone(),
                    CaseResult {
                        pass: false,
                        tries: 0,
                        why: format!("not set up: {e}"),
                    },
                );
                continue;
            }
        };
        let mut r = CaseResult {
            pass: false,
            tries: 0,
            why: String::new(),
        };
        for t in 1..=2u32 {
            let home = dir.join(format!("{}-{t}", case.id));
            r = match replay(config, exes, case, &clone, &home, pass) {
                Ok(r) => r,
                Err(e) if e == INTERRUPTED => return Err(e),
                Err(e) => CaseResult {
                    pass: false,
                    tries: 1,
                    why: e,
                },
            };
            r.tries = t;
            eprintln!("towercab: eval {} try {t}: {}", case.id, r.why);
            if r.pass {
                break;
            }
        }
        out.insert(case.id.clone(), r);
    }
    let run = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(RunResult::new(&run, out))
}

/// `towercab eval [--reason <change>]`: the cases with this binary → `<home>/evals/<run>/`
/// `result.json`, `meta.eval_baseline` = run; with `reason` and the last baseline ≥ [`DROP`]
/// points higher → `Notice::EvalsDropped`. Returns `evals: <passed>/<total> (<rate>%)`.
pub fn baseline(
    config: &Config,
    home: &Home,
    exes: &Exes,
    reason: Option<&str>,
) -> Result<String, String> {
    let store = Store::open(config).map_err(|e| e.to_string())?;
    store.list().map_err(|e| e.to_string())?;
    let cases = cases(&store);
    let tick = Tick::now();
    let run = run_name(tick);
    let out = dir(home).join(&run);
    let result = run_cases(config, exes, &cases, &out, PASS)?;
    result.write(&out.join("result.json"))?;
    pass_rate(&result, "baseline");
    let db = Db::open(&home.db())?;
    let before = baseline_of(&db, home).ok().flatten();
    db.set_meta("eval_baseline", &run)?;
    if let (Some(change), Some(b)) = (reason, before)
        && b.rate - result.rate >= DROP
    {
        outbox::notify(
            db.conn(),
            &Notice::EvalsDropped {
                points: (b.rate - result.rate).round(),
                change: change.to_string(),
            },
            &run,
            tick.unix(),
        )?;
    }
    Ok(format!("evals: {}", result.summary()))
}

/// `towercab.eval.pass_rate` of a run, 0–1 (MET-25); none without cases.
fn pass_rate(r: &RunResult, kind: &str) {
    if r.total > 0 {
        let m = crate::metrics::Metric::EvalPassRate;
        crate::metrics::gauge(m, r.rate / 100.0, &[("kind", kind)]);
    }
}

/// `towercab eval --cases <dir> --out <file>`: those cases with this binary (scratch homes next
/// to `out`).
pub fn inner(config: &Config, exes: &Exes, cases_dir: &Path, out: &Path) -> Result<String, String> {
    let cases = read_dir(cases_dir);
    let dir = out.parent().ok_or("--out: no parent directory")?;
    let result = run_cases(config, exes, &cases, dir, PASS)?;
    result.write(out)?;
    Ok(format!("evals: {}", result.summary()))
}

/// What `eval --pr` needs of a PR (`gh pr view <n> --json headRefOid,files,isCrossRepository,author,commits`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PrInfo {
    pub head: String,
    pub files: Vec<String>,
    /// From a fork.
    pub cross: bool,
    /// The PR's author login (`app/<slug>` for an App).
    pub author: String,
    /// Each head commit: (sha, its authors' (login, email)).
    pub commits: Vec<(String, Vec<(String, String)>)>,
}

/// The `--json` fields of [`pr_info`].
pub const PR_INFO_FIELDS: &str = "headRefOid,files,isCrossRepository,author,commits";

/// PR `n` of `github` ([`PrInfo`]).
pub fn pr_info(identity: &Identity, github: &str, n: u64) -> Result<PrInfo, GhError> {
    let out = identity.gh(
        github,
        &[
            "pr",
            "view",
            &n.to_string(),
            "-R",
            github,
            "--json",
            PR_INFO_FIELDS,
        ],
    )?;
    let v: Value =
        serde_json::from_str(&out).map_err(|e| GhError::Failed(format!("gh pr view {n}: {e}")))?;
    let s = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let arr = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    Ok(PrInfo {
        head: s(&v, "headRefOid"),
        files: arr(&v, "files")
            .iter()
            .map(|f| s(f, "path"))
            .filter(|p| !p.is_empty())
            .collect(),
        cross: v
            .get("isCrossRepository")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        author: v.get("author").map(|a| s(a, "login")).unwrap_or_default(),
        commits: arr(&v, "commits")
            .iter()
            .map(|c| {
                let who = arr(c, "authors")
                    .iter()
                    .map(|a| (s(a, "login"), s(a, "email")))
                    .collect();
                (s(c, "oid"), who)
            })
            .collect(),
    })
}

/// A login without `app/` and `[bot]` (`app/towercab`, `towercab[bot]` → `towercab`).
fn bare_login(login: &str) -> &str {
    let l = login.strip_prefix("app/").unwrap_or(login);
    l.strip_suffix("[bot]").unwrap_or(l)
}

/// Whether `eval --pr` may build PR `info` (its head runs as me, outside any sandbox: see
/// pipeline.md **Evals**): from the repo itself, not a fork; opened by `me` or the App's bot;
/// every head commit authored by one of them (login, or the bot's email). `Err`: why not.
pub fn trusted(info: &PrInfo, me: Option<&str>, bot: Option<(&str, &str)>) -> Result<(), String> {
    if info.cross {
        return Err("a fork's PR".into());
    }
    let ok_login = |l: &str| {
        !l.is_empty()
            && (me.is_some_and(|m| m == l)
                || bot.is_some_and(|(b, _)| bare_login(b) == bare_login(l)))
    };
    if !ok_login(&info.author) {
        return Err(format!(
            "opened by {}",
            if info.author.is_empty() {
                "nobody known"
            } else {
                &info.author
            }
        ));
    }
    for (sha, who) in &info.commits {
        let mine = !who.is_empty()
            && who
                .iter()
                .all(|(l, e)| ok_login(l) || bot.is_some_and(|(_, be)| !e.is_empty() && be == e));
        if !mine {
            let names: Vec<&str> = who
                .iter()
                .map(|(l, e)| if l.is_empty() { e.as_str() } else { l.as_str() })
                .collect();
            return Err(format!(
                "commit {} by {}",
                &sha[..sha.len().min(7)],
                if names.is_empty() {
                    "nobody known".into()
                } else {
                    names.join(", ")
                }
            ));
        }
    }
    Ok(())
}

/// A bot's (login, email).
type Login = (String, String);

/// Who [`trusted`] trusts: `[github].me` and the App's bot (login, email; no App: none).
fn trusted_people(
    config: &Config,
    identity: &Identity,
) -> Result<(Option<String>, Option<Login>), GhError> {
    let me = config.github.as_ref().and_then(|g| g.me.clone());
    let bot = if identity.is_app() {
        let b = identity.bot()?;
        Some((b.login, b.email))
    } else {
        None
    };
    Ok((me, bot))
}

/// The status of a PR not built: `error` `not evaluated: <why>`.
fn untrusted(why: &str) -> Verdict {
    Verdict::new("error", &format!("not evaluated: {why}"))
}

/// `towercab eval --pr <n>`: the Towercab repo's PR `n`; the cheap statuses inline; else its
/// head into `<home>/evals/build-<n>/` (`git fetch origin pull/<n>/head` in the clone),
/// `cargo build --locked`, `<that>/target/debug/towercab --config <same> --home <same> eval
/// --cases <dir> --out <file>`, compared with the baseline, posted as `towercab/evals`. A
/// failed build or run posts `error`.
pub fn pr(config: &Config, home: &Home, exes: &Exes, n: u64) -> Result<String, String> {
    let repo = towercab_repo(config).ok_or("no [repos] entry whose github name is towercab")?;
    let identity = Identity::from_config(config, exes);
    let gh = |e: GhError| e.to_string();
    let info = pr_info(&identity, &repo.github, n).map_err(gh)?;
    let head = info.head.clone();
    let store = Store::open(config).map_err(|e| e.to_string())?;
    store.list().map_err(|e| e.to_string())?;
    let cases = cases(&store);
    if let Some(v) = cheap(&info.files, cases.len()) {
        post(&identity, &repo.github, &head, &v).map_err(gh)?;
        return Ok(format!("evals: {}", v.description));
    }
    let (me, bot) = trusted_people(config, &identity).map_err(gh)?;
    let bot = bot.as_ref().map(|(l, e)| (l.as_str(), e.as_str()));
    if let Err(why) = trusted(&info, me.as_deref(), bot) {
        let v = untrusted(&why);
        post(&identity, &repo.github, &head, &v).map_err(gh)?;
        return Err(v.description);
    }
    let failed = |why: String| {
        let v = Verdict::new("error", &why);
        let _ = post(&identity, &repo.github, &head, &v);
        why
    };
    let build = dir(home).join(format!("build-{n}"));
    let built = build_head(config, exes, &identity, &repo, n, &head, &build);
    let exe = built.map_err(failed)?;
    let tick = Tick::now();
    let run = run_name(tick);
    let out = dir(home).join(&run);
    let cases_dir = out.join("cases");
    fs::create_dir_all(&cases_dir).map_err(|e| format!("{}: {e}", cases_dir.display()))?;
    let scratch = scratch_config(&config.file, &out).map_err(failed)?;
    let scratch_home = out.join("home");
    let mirror = policies_mirror(config, home, exes, &identity).map_err(failed)?;
    for c in &cases {
        let text = serde_json::to_string_pretty(&c.to_json()).map_err(|e| e.to_string())?;
        fs::write(cases_dir.join(format!("{}.json", c.id)), text).map_err(|e| e.to_string())?;
    }
    let file = out.join("result.json");
    let mut inner = Command::new(&exe);
    inner
        .arg("--config")
        .arg(&scratch)
        .arg("--home")
        .arg(&scratch_home)
        .arg("eval")
        .arg("--cases")
        .arg(&cases_dir)
        .arg("--out")
        .arg(&file)
        .current_dir(&out)
        .env_clear()
        .envs(inner_env(mirror.as_ref()));
    let status = inner
        .status()
        .map_err(|e| failed(format!("{}: {e}", exe.display())))?;
    if !status.success() {
        return Err(failed(format!("eval run failed: {status}")));
    }
    let result = RunResult::read(&file).map_err(failed)?;
    pass_rate(&result, "pr");
    let db = Db::open(&home.db())?;
    let base = baseline_of(&db, home).ok().flatten();
    let v = compare(&result, base.as_ref());
    post(&identity, &repo.github, &head, &v).map_err(gh)?;
    Ok(format!(
        "evals: {}: {} {}",
        result.summary(),
        v.state,
        v.description
    ))
}

/// What the inner run gets of the environment: `HOME` (its Claude runs need my Claude login),
/// `PATH`, `LANG`; with `[policies]` `url.<mirror>.insteadOf <policies url>` (`GIT_CONFIG_*`):
/// it clones the policies from [`policies_mirror`], no App needed.
fn inner_env(mirror: Option<&(String, PathBuf)>) -> Vec<(OsString, OsString)> {
    let mut v: Vec<(OsString, OsString)> = ["HOME", "PATH", "LANG"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(|x| (OsString::from(k), x)))
        .collect();
    if let Some((url, path)) = mirror {
        v.push(("GIT_CONFIG_COUNT".into(), "1".into()));
        v.push((
            "GIT_CONFIG_KEY_0".into(),
            format!("url.{}.insteadOf", path.display()).into(),
        ));
        v.push(("GIT_CONFIG_VALUE_0".into(), url.into()));
    }
    v
}

/// The inner run's config: `--config`'s text without `[telegram]` and `[github]` (no Telegram
/// token, no App: its `app.pem` lives next to the config file, and none is next to this copy),
/// at `<run>/config.toml` (mode 0600).
pub fn scratch_config(file: &Path, run: &Path) -> Result<PathBuf, String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let text = fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let mut t: toml::Table = text
        .parse()
        .map_err(|e| format!("{}: {e}", file.display()))?;
    t.remove("telegram");
    t.remove("github");
    let out = run.join("config.toml");
    let body = toml::to_string(&t).map_err(|e| format!("{}: {e}", out.display()))?;
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&out)
        .and_then(|mut f| f.write_all(body.as_bytes()))
        .map_err(|e| format!("{}: {e}", out.display()))?;
    Ok(out)
}

/// A bare mirror of `[policies].github` at `<home>/evals/policies.git` (cloned, else fetched,
/// as the App) for the inner run → (its `https://github.com/` url, path); none without
/// `[policies]`.
fn policies_mirror(
    config: &Config,
    home: &Home,
    exes: &Exes,
    identity: &Identity,
) -> Result<Option<(String, PathBuf)>, String> {
    let Some(github) = config.policies.github.clone() else {
        return Ok(None);
    };
    let url = format!("https://github.com/{github}.git");
    let auth = identity.auth_for_url(&url).map_err(|e| e.to_string())?;
    let path = dir(home).join("policies.git");
    if path.join("HEAD").exists() {
        checkout::git(
            &exes.git,
            &path,
            &[
                "fetch",
                "--quiet",
                "--prune",
                "origin",
                "+refs/heads/*:refs/heads/*",
            ],
            Some(&auth),
        )?;
    } else {
        checkout::remove(&path)?;
        fs::create_dir_all(dir(home)).map_err(|e| format!("{}: {e}", dir(home).display()))?;
        let to = path.to_string_lossy();
        checkout::git(
            &exes.git,
            &dir(home),
            &["clone", "--quiet", "--bare", "--", &url, &to],
            Some(&auth),
        )?;
    }
    Ok(Some((url, path)))
}

/// The build's environment variables passed on from mine (a compiler setup): `CC`, `CXX`, `AR`,
/// `CFLAGS`, `CXXFLAGS`, `LDFLAGS`, `RUSTFLAGS`, `CRATE_CC_NO_DEFAULTS`.
const BUILD_ENV: [&str; 8] = [
    "CC",
    "CXX",
    "AR",
    "CFLAGS",
    "CXXFLAGS",
    "LDFLAGS",
    "RUSTFLAGS",
    "CRATE_CC_NO_DEFAULTS",
];

/// `s` single-quoted for `sh`.
fn quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// PR `n`'s head checked out in `dir` (kept between runs: its `target/` too) and built in the
/// **Sandbox** (network, `CARGO_HOME` in `<home>/evals/cache`, writable; env the sandbox's +
/// [`BUILD_ENV`]) → its `target/debug/towercab`.
fn build_head(
    config: &Config,
    exes: &Exes,
    identity: &Identity,
    repo: &RepoConfig,
    n: u64,
    head: &str,
    dir: &Path,
) -> Result<PathBuf, String> {
    let auth = identity
        .auth_for_url(&checkout::origin_url(&exes.git, repo))
        .map_err(|e| e.to_string())?;
    checkout::ensure_clone(&exes.git, repo, Some(&auth))?;
    let pr_ref = format!("refs/remotes/origin/pr/{n}");
    checkout::ensure(&exes.git, &repo.path, dir, &repo.base, "eval")?;
    // Fetched into the build's own checkout, never the clone the loop pushes from: this
    // process runs beside the loop (ref locks, `FETCH_HEAD`).
    let url = checkout::origin_url(&exes.git, repo);
    checkout::git(
        &exes.git,
        dir,
        &[
            "fetch",
            "--quiet",
            &url,
            &format!("+refs/pull/{n}/head:{pr_ref}"),
        ],
        Some(&auth),
    )?;
    checkout::git_sane(
        &exes.git,
        dir,
        &["checkout", "--quiet", "--force", "-B", "eval", &pr_ref],
        None,
    )?;
    let at = checkout::rev(&exes.git, dir, "HEAD")?;
    if at != head {
        return Err(format!("PR #{n} head is {at}, not {head}"));
    }
    let home = crate::claude::home()?;
    let cache = dir
        .parent()
        .ok_or("build: no parent directory")?
        .join("cache");
    fs::create_dir_all(&cache).map_err(|e| format!("{}: {e}", cache.display()))?;
    let cache = super::sandbox::Cache::Write(&cache);
    let line = format!("{} build --locked", quoted(&exes.cargo.to_string_lossy()));
    let argv = super::sandbox::checks_argv(exes, config, &home, dir, &line, true, cache);
    let mut env = super::sandbox::env(config, &home, cache);
    env.extend(
        BUILD_ENV
            .iter()
            .filter_map(|k| std::env::var_os(k).map(|v| (OsString::from(k), v))),
    );
    let out = Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(dir)
        .env_clear()
        .envs(env)
        .output()
        .map_err(|e| format!("{}: {e}", argv[0].to_string_lossy()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        return Err(format!("cargo build failed: {}", last.trim()));
    }
    Ok(dir.join("target/debug/towercab"))
}

/// An eval child the loop runs (one at a time, a slot).
#[derive(Debug, Clone, PartialEq)]
pub enum Job {
    /// `towercab eval --pr <n>` for this head.
    Pr { n: u64, head: String },
    /// `towercab eval --reason <reason>`; the metas it sets at its end.
    Baseline {
        reason: String,
        policies: String,
        model: String,
    },
}

/// The child for `job`: this binary, `--config`/`--home` as the loop's, the loop's
/// environment; output in `<home>/evals/eval-<pr n | baseline>.log` (`.err`); [`BOUND`].
pub fn spec(cx: &Ctx<'_>, job: &Job) -> Result<ChildSpec, String> {
    let exe = exes::towercab(cx.exes)?;
    let mut argv: Vec<OsString> = vec![
        exe.into(),
        "--config".into(),
        cx.config.file.clone().into(),
        "--home".into(),
        cx.home.root.clone().into(),
        "eval".into(),
    ];
    let name = match job {
        Job::Pr { n, .. } => {
            argv.extend(["--pr".into(), n.to_string().into()]);
            format!("eval-pr-{n}")
        }
        Job::Baseline { reason, .. } => {
            argv.extend(["--reason".into(), reason.into()]);
            "eval-baseline".into()
        }
    };
    let logs = dir(cx.home);
    fs::create_dir_all(&logs).map_err(|e| format!("{}: {e}", logs.display()))?;
    Ok(ChildSpec {
        kind: ChildKind::Command,
        argv,
        cwd: cx.home.root.clone(),
        env: std::env::vars_os().collect(),
        stdin: None,
        stdout: logs.join(format!("{name}.log")),
        stderr: logs.join(format!("{name}.err")),
        timeout: Some(BOUND),
        slot: true,
        model: None,
    })
}

/// Whether `sha` has a `towercab/evals` status (`api repos/<r>/commits/<sha>/status`).
fn has_status(identity: &Identity, github: &str, sha: &str) -> Result<bool, GhError> {
    let out = identity.gh(
        github,
        &["api", &format!("repos/{github}/commits/{sha}/status")],
    )?;
    let v: Value =
        serde_json::from_str(&out).map_err(|e| GhError::Failed(format!("commit status: {e}")))?;
    Ok(v.get("statuses")
        .and_then(Value::as_array)
        .is_some_and(|a| {
            a.iter()
                .any(|s| s.get("context").and_then(Value::as_str) == Some(CONTEXT))
        }))
}

/// The `[policies].github` `policies/` tree sha at its base (`none` without policies).
fn policies_tree(cx: &Ctx<'_>) -> Result<String, GhError> {
    policies::tree(cx).map_err(|e| match e {
        StepError::Env(_, m) => GhError::Env(m),
        StepError::Bug(m) => GhError::Failed(m),
    })
}

/// Every 300 s with the drafts poll (not with `--intent`, nor while an eval child runs): each
/// open PR head of the Towercab repo without a `towercab/evals` status gets the cheap statuses
/// inline, else the first one an eval child. When `idle` and no PR needs one: weekly
/// (`meta.eval_at`), the `[policies].github` `policies` tree ≠ `meta.eval_policies` or
/// `[agent].model` ≠ `meta.eval_model` → a baseline (`reason` `weekly`, `policies <sha7>`,
/// `model <m>`); with fewer than [`CASES`] cases the metas are set and nothing runs.
pub fn poll(cx: &mut Ctx<'_>, idle: bool) -> Result<Option<Job>, GhError> {
    let n_cases = cases(cx.store).len();
    if let Some(repo) = towercab_repo(cx.config) {
        let g = repo.github.clone();
        let out = cx.identity.gh(
            &g,
            &[
                "pr",
                "list",
                "-R",
                &g,
                "--state",
                "open",
                "--json",
                "number,headRefOid",
            ],
        )?;
        let prs: Value =
            serde_json::from_str(&out).map_err(|e| GhError::Failed(format!("gh pr list: {e}")))?;
        for p in prs.as_array().into_iter().flatten() {
            let (Some(n), Some(head)) = (
                p.get("number").and_then(Value::as_u64),
                p.get("headRefOid").and_then(Value::as_str),
            ) else {
                continue;
            };
            if has_status(cx.identity, &g, head)? {
                continue;
            }
            let info = pr_info(cx.identity, &g, n)?;
            if let Some(v) = cheap(&info.files, n_cases) {
                post(cx.identity, &g, head, &v)?;
                continue;
            }
            let (me, bot) = trusted_people(cx.config, cx.identity)?;
            let bot = bot.as_ref().map(|(l, e)| (l.as_str(), e.as_str()));
            if let Err(why) = trusted(&info, me.as_deref(), bot) {
                post(cx.identity, &g, head, &untrusted(&why))?;
                continue;
            }
            return Ok(Some(Job::Pr {
                n,
                head: head.to_string(),
            }));
        }
    }
    if !idle {
        return Ok(None);
    }
    let conn = cx.db.conn();
    let meta = |k: &str| get_meta(conn, k).map_err(GhError::Failed);
    let now = cx.tick.unix();
    let at: Option<f64> = meta("eval_at")?.and_then(|v| v.parse().ok());
    let policies = policies_tree(cx)?;
    let model = cx.config.agent.model.clone();
    let reason = if at.is_none_or(|t| now - t >= WEEK || now < t) {
        Some("weekly".to_string())
    } else if meta("eval_policies")?.as_deref() != Some(policies.as_str()) {
        Some(format!("policies {}", &policies[..policies.len().min(7)]))
    } else if meta("eval_model")?.as_deref() != Some(model.as_str()) {
        Some(format!("model {model}"))
    } else {
        None
    };
    let Some(reason) = reason else {
        return Ok(None);
    };
    let job = Job::Baseline {
        reason,
        policies,
        model,
    };
    if n_cases < CASES {
        ended(cx, &job, None)?;
        return Ok(None);
    }
    Ok(Some(job))
}

/// An eval child's end (`None`: nothing ran): a PR's that timed out or failed → status `error`
/// (its own run posts the rest); a baseline's → `meta.eval_at`, `eval_policies`, `eval_model`.
pub fn ended(cx: &Ctx<'_>, job: &Job, end: Option<&ChildEnd>) -> Result<(), GhError> {
    match job {
        Job::Pr { head, .. } => {
            let Some(end) = end else { return Ok(()) };
            let why = if end.timed_out {
                Some(format!("eval timed out after {} h", BOUND.as_secs() / 3600))
            } else if end.status.and_then(|s| s.code()) != Some(0) {
                let err = fs::read_to_string(&end.stderr).unwrap_or_default();
                let last = err
                    .lines()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("eval failed")
                    .to_string();
                Some(last)
            } else {
                None
            };
            if let (Some(why), Some(repo)) = (why, towercab_repo(cx.config)) {
                post(
                    cx.identity,
                    &repo.github,
                    head,
                    &Verdict::new("error", &why),
                )?;
            }
            Ok(())
        }
        Job::Baseline {
            policies, model, ..
        } => {
            let conn = cx.db.conn();
            let set = |k: &str, v: &str| set_meta(conn, k, v).map_err(GhError::Failed);
            set("eval_at", &cx.tick.unix().to_string())?;
            set("eval_policies", policies)?;
            set("eval_model", model)
        }
    }
}
