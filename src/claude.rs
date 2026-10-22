//! Claude runs (PIP-13, PIP-24, pipeline.md **Claude runs**): the argv, settings, environment
//! and files of every `claude -p` Towercab starts, and what its result says.
//!
//! No user, project or local settings are loaded (`--setting-sources ""`): a hook in the repo's
//! `.claude/settings.json` would run outside the sandbox. So the base branch's `CLAUDE.md` is
//! appended to the system prompt instead, and the sandbox and the worker's guard come from
//! Towercab's own `--settings` file.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::LazyLock;
use std::time::Duration;

use chrono::{DateTime, FixedOffset};
use regex::Regex;
use serde_json::{Value, json};

use crate::config::Config;
use crate::exes::Exes;
use crate::handler::{ChildEnd, ChildKind, ChildSpec, Session};
use crate::limits::{self, Limit};
use crate::outbox::{cut, one_line};

/// The prompt of a run resumed after a cut-off (a crash, a kill, a limit wait).
pub const CONTINUE: &str = "Continue where you stopped.";

/// What `claude --resume` says when the session is gone.
pub const SESSION_GONE: &str = "No conversation found with session ID";

/// The run's stderr or result says its session is gone.
pub fn session_gone(text: &str) -> bool {
    text.contains(SESSION_GONE)
}

/// The prompt of a new session replacing a gone one (LOOP-7): where the work is.
pub fn fresh_context(
    branch: &str,
    pr: Option<&str>,
    intent_md: &str,
    spec_ids: &[String],
    plan_md: &str,
) -> String {
    let spec = if spec_ids.is_empty() {
        "none yet".to_string()
    } else {
        spec_ids.join(", ")
    };
    format!(
        "Your earlier session is gone; continue the work from the repo.\n\
         Branch: {branch}\n\
         PR: {}\n\
         Intent: {intent_md}\n\
         Spec IDs: {spec}\n\
         Plan: {plan_md}\n\
         Read them, check what is done with git log and git diff, then go on.",
        pr.unwrap_or("none yet")
    )
}

/// The `@playwright/mcp` version the verifier's browser runs (pinned).
pub const PLAYWRIGHT_MCP: &str = "0.0.41";

/// The writer's run-time bound.
pub const WRITER_TIMEOUT: Duration = Duration::from_secs(60);

/// What a run is for; it decides tools, permissions, session, budget, timeout and slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RunKind {
    /// The spec change, the worker session's first run (PIP-25).
    Design,
    /// Read-only plan (PIP-28).
    Plan,
    /// Build, repairs and continues (PIP-1).
    Worker,
    /// PR review (PIP-4).
    Review,
    /// e2e red after my merge (PIP-20).
    Triage,
    /// Exercises the running app (PIP-32).
    Verifier,
    /// PR text (PIP-14).
    Writer,
    /// Intents from issues and alerts (INT-7).
    Drafter,
    /// A band's breach (MNT-5).
    Diagnose,
}

impl RunKind {
    pub const ALL: [RunKind; 9] = [
        RunKind::Design,
        RunKind::Plan,
        RunKind::Worker,
        RunKind::Review,
        RunKind::Triage,
        RunKind::Verifier,
        RunKind::Writer,
        RunKind::Drafter,
        RunKind::Diagnose,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RunKind::Design => "design",
            RunKind::Plan => "plan",
            RunKind::Worker => "worker",
            RunKind::Review => "review",
            RunKind::Triage => "triage",
            RunKind::Verifier => "verifier",
            RunKind::Writer => "writer",
            RunKind::Drafter => "drafter",
            RunKind::Diagnose => "diagnose",
        }
    }

    /// `--tools`: a comma list, or `""` (none).
    pub fn tools(self) -> &'static str {
        match self {
            RunKind::Design => "Read,Glob,Grep,Edit,Write,Skill",
            RunKind::Plan => "Read,Glob,Grep,Bash,Skill",
            RunKind::Worker => "Read,Edit,Write,Glob,Grep,Bash,Skill",
            RunKind::Review | RunKind::Triage | RunKind::Verifier => "Read,Grep,Glob,Bash,Skill",
            RunKind::Writer | RunKind::Drafter | RunKind::Diagnose => "",
        }
    }

    /// Gets the policy skills (`--plugin-dir <runs>/policies`, PIP-27).
    pub fn policies(self) -> bool {
        !self.toolless()
    }

    /// Bounded by `--max-budget-usd` (`[agent].max_budget_usd`).
    pub fn budgeted(self) -> bool {
        matches!(self, RunKind::Design | RunKind::Plan | RunKind::Worker)
    }

    /// No tools; runs in `<runs>`, not the checkout.
    pub fn toolless(self) -> bool {
        matches!(self, RunKind::Writer | RunKind::Drafter | RunKind::Diagnose)
    }

    /// Counts toward `[agent].parallel` (LOOP-4): all but the writer.
    pub fn slot(self) -> bool {
        self != RunKind::Writer
    }

    /// `build_timeout` (design, plan, worker), `review_timeout` (review, triage, verifier,
    /// drafter, diagnose), 60 s (writer).
    pub fn timeout(self, config: &Config) -> Duration {
        match self {
            RunKind::Design | RunKind::Plan | RunKind::Worker => config.agent.build_timeout,
            RunKind::Writer => WRITER_TIMEOUT,
            _ => config.agent.review_timeout,
        }
    }

    /// The `agent` of its metrics (MET-16): design, plan and worker runs are `worker`.
    pub fn agent(self) -> &'static str {
        match self {
            RunKind::Design | RunKind::Plan | RunKind::Worker => "worker",
            k => k.as_str(),
        }
    }
}

/// The verifier's app: the sandbox lets it reach `localhost:<port>` (PIP-32).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierNet {
    pub port: u16,
    pub url: String,
    /// A Playwright MCP server limited to `url`.
    pub ui: bool,
}

/// The session flag of a run (PIP-13, LOOP-7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionArg {
    /// `--session-id <uuid>`: the session's first run.
    New(String),
    /// `--resume <uuid>`.
    Resume(String),
    /// Neither (writer, drafter, diagnose).
    None,
}

impl From<Session> for SessionArg {
    fn from(s: Session) -> SessionArg {
        match s {
            Session::New(u) => SessionArg::New(u),
            Session::Resume(u) => SessionArg::Resume(u),
        }
    }
}

/// One `claude -p` run.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub kind: RunKind,
    pub model: String,
    /// The mission checkout (writer, drafter, diagnose: `runs`).
    pub cwd: PathBuf,
    /// `<home>/runs/<id>/`: its files, `CLAUDE.md`, `policies/`.
    pub runs: PathBuf,
    /// Its number among this kind's runs: `<kind>-<n>.*`.
    pub n: u32,
    pub session: SessionArg,
    /// On stdin.
    pub prompt: String,
    /// `--json-schema`.
    pub schema: Option<Value>,
    /// `--max-budget-usd` (design, plan, worker).
    pub budget_usd: Option<f64>,
    /// The base branch's ` ```setup ` and ` ```checks ` commands: `Bash(<cmd>:*)` for the worker.
    pub setup_checks: Vec<String>,
    /// `[repos.<r>].bash` patterns: `Bash(<pattern>)` for the worker.
    pub bash: Vec<String>,
    pub verifier: Option<VerifierNet>,
    /// `sandbox.filesystem.denyWrite` (the worker: protected and locked paths, PIP-29, PIP-31).
    pub deny_write: Vec<PathBuf>,
    /// The worker's `PreToolUse` guard hook (PIP-29).
    pub guard: bool,
    /// An eval's run (PIP-33): same argv, metrics agent `eval`.
    pub eval: bool,
}

impl Run {
    /// A run of `kind` on `model`: cwd `cwd` (toolless kinds: `runs`), no session, the
    /// budget of `[agent].max_budget_usd` for budgeted kinds, nothing else.
    pub fn new(
        kind: RunKind,
        model: &str,
        cwd: &Path,
        runs: &Path,
        n: u32,
        prompt: impl Into<String>,
        config: &Config,
    ) -> Run {
        Run {
            kind,
            model: model.to_string(),
            cwd: if kind.toolless() {
                runs.to_path_buf()
            } else {
                cwd.to_path_buf()
            },
            runs: runs.to_path_buf(),
            n,
            session: SessionArg::None,
            prompt: prompt.into(),
            schema: None,
            budget_usd: kind.budgeted().then_some(config.agent.max_budget_usd),
            setup_checks: Vec::new(),
            bash: Vec::new(),
            verifier: None,
            deny_write: Vec::new(),
            guard: false,
            eval: false,
        }
    }

    /// The metrics agent (MET-16).
    pub fn agent(&self) -> &'static str {
        if self.eval { "eval" } else { self.kind.agent() }
    }

    /// Its files under `runs`.
    pub fn files(&self) -> RunFiles {
        let base = format!("{}-{}", self.kind.as_str(), self.n);
        RunFiles {
            prompt: self.runs.join(format!("{base}.prompt")),
            stdout: self.runs.join(format!("{base}.json")),
            stderr: self.runs.join(format!("{base}.err")),
            settings: self
                .runs
                .join(format!("settings-{}.json", self.kind.as_str())),
            claude_md: self.runs.join("CLAUDE.md"),
            policies: self.runs.join("policies"),
            mcp: self.runs.join("mcp-verifier.json"),
        }
    }
}

/// A run's files (all under `runs/<id>/`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFiles {
    /// `<kind>-<n>.prompt`: stdin.
    pub prompt: PathBuf,
    /// `<kind>-<n>.json`: stdout, the JSON result.
    pub stdout: PathBuf,
    /// `<kind>-<n>.err`.
    pub stderr: PathBuf,
    /// `settings-<kind>.json`: `--settings`.
    pub settings: PathBuf,
    /// The base branch's `CLAUDE.md`: `--append-system-prompt-file`.
    pub claude_md: PathBuf,
    /// The policy plugin (PIP-27): `--plugin-dir`.
    pub policies: PathBuf,
    /// The verifier's Playwright MCP config: `--mcp-config`.
    pub mcp: PathBuf,
}

/// Secret paths under `HOME` no run may read (PIP-24): (path, is a directory).
pub const SECRETS: [(&str, bool); 9] = [
    (".ssh", true),
    (".config/gh", true),
    (".aws", true),
    (".gnupg", true),
    (".config/towercab", true),
    (".claude/.credentials.json", false),
    (".codex/auth.json", false),
    (".netrc", false),
    (".git-credentials", false),
];

/// The loop's `HOME` (every run's too).
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// [`SECRETS`] as absolute paths under `home`.
pub fn secret_paths(home: &Path) -> Vec<PathBuf> {
    SECRETS.iter().map(|(p, _)| home.join(p)).collect()
}

/// `--disallowedTools` of every run: no push, remote or config change, no `gh`, `curl`,
/// `wget`, `ssh`, `sudo`, no web, no secret path or `.env` file read. The verifier keeps
/// `curl` (its app).
pub fn disallowed(kind: RunKind) -> Vec<String> {
    let mut d: Vec<String> = [
        "Bash(git push:*)",
        "Bash(git remote:*)",
        "Bash(git config:*)",
        "Bash(gh:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "Bash(ssh:*)",
        "Bash(sudo:*)",
        "WebFetch",
        "WebSearch",
    ]
    .into_iter()
    .filter(|p| kind != RunKind::Verifier || *p != "Bash(curl:*)")
    .map(str::to_string)
    .collect();
    for (p, dir) in SECRETS {
        d.push(if dir {
            format!("Read(~/{p}/**)")
        } else {
            format!("Read(~/{p})")
        });
    }
    d.push("Read(**/.env*)".into());
    d
}

const READ_ONLY_GIT: [&str; 3] = ["Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];

/// `--allowedTools` of a run (`Skill` wherever it is a tool: `dontAsk` denies the rest).
pub fn allowed(run: &Run) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut a = match run.kind {
        RunKind::Design => s(&["Read", "Glob", "Grep", "Skill", "Edit(specs/**)"]),
        RunKind::Plan => {
            let mut a = s(&["Read", "Glob", "Grep", "Skill", "Bash(git status:*)"]);
            a.extend(s(&READ_ONLY_GIT));
            a
        }
        RunKind::Worker => {
            let mut a = s(&["Read", "Edit", "Write", "Glob", "Grep", "Skill"]);
            for cmd in &run.setup_checks {
                let cmd = cmd.trim();
                if !cmd.is_empty() {
                    a.push(format!("Bash({cmd}:*)"));
                }
            }
            a.push("Bash(git status:*)".into());
            a.extend(s(&READ_ONLY_GIT));
            a.extend(run.bash.iter().map(|p| format!("Bash({p})")));
            a
        }
        RunKind::Review | RunKind::Triage | RunKind::Verifier => {
            let mut a = s(&["Read", "Grep", "Glob", "Skill"]);
            a.extend(s(&READ_ONLY_GIT));
            a
        }
        RunKind::Writer | RunKind::Drafter | RunKind::Diagnose => Vec::new(),
    };
    if run.kind == RunKind::Verifier {
        a.push("Bash(curl *)".into());
        if run.verifier.as_ref().is_some_and(|v| v.ui) {
            a.push("mcp__playwright".into());
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    a.retain(|x| seen.insert(x.clone()));
    a
}

/// The argv (PIP-24's order): the common flags, `--tools`, `--allowedTools` and
/// `--disallowedTools` (each pattern its own argument), `--plugin-dir`, the session flag,
/// `--max-budget-usd`, `--json-schema`, `--mcp-config`. The prompt goes on stdin.
pub fn argv(run: &Run, exes: &Exes) -> Vec<OsString> {
    let f = run.files();
    let mut a: Vec<OsString> = vec![
        exes.claude.clone(),
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--permission-mode".into(),
        "dontAsk".into(),
        "--strict-mcp-config".into(),
        "--setting-sources".into(),
        "".into(),
        "--append-system-prompt-file".into(),
        f.claude_md.into(),
        "--settings".into(),
        f.settings.into(),
        "--model".into(),
        run.model.clone().into(),
        "--tools".into(),
        run.kind.tools().into(),
    ];
    let allowed = allowed(run);
    if !allowed.is_empty() {
        a.push("--allowedTools".into());
        a.extend(allowed.into_iter().map(OsString::from));
    }
    a.push("--disallowedTools".into());
    a.extend(disallowed(run.kind).into_iter().map(OsString::from));
    if run.kind.policies() {
        a.push("--plugin-dir".into());
        a.push(f.policies.into());
    }
    match &run.session {
        SessionArg::New(u) => a.extend(["--session-id".into(), u.into()]),
        SessionArg::Resume(u) => a.extend(["--resume".into(), u.into()]),
        SessionArg::None => {}
    }
    if let (true, Some(b)) = (run.kind.budgeted(), run.budget_usd) {
        a.extend(["--max-budget-usd".into(), b.to_string().into()]);
    }
    if let Some(schema) = &run.schema {
        a.extend(["--json-schema".into(), schema.to_string().into()]);
    }
    if run.kind == RunKind::Verifier && run.verifier.as_ref().is_some_and(|v| v.ui) {
        a.extend(["--mcp-config".into(), f.mcp.into()]);
    }
    a
}

/// The `--settings` file: the sandbox (secret paths unreadable, `deny_write` unwritable, the
/// verifier's app its only network), plus the worker's guard hook (`'<towercab>' hook guard`).
pub fn settings(run: &Run, home: &Path, towercab: &Path) -> Value {
    let paths = |v: &[PathBuf]| -> Vec<String> {
        v.iter().map(|p| p.to_string_lossy().into_owned()).collect()
    };
    let mut sandbox = json!({
        "enabled": true,
        "failIfUnavailable": true,
        "allowUnsandboxedCommands": false,
        "filesystem": {
            "denyRead": paths(&secret_paths(home)),
            "denyWrite": paths(&run.deny_write),
        },
    });
    if let (RunKind::Verifier, Some(v)) = (run.kind, &run.verifier) {
        sandbox["network"] = json!({
            "allowedDomains": [format!("localhost:{}", v.port), format!("127.0.0.1:{}", v.port)],
        });
    }
    let mut s = json!({ "sandbox": sandbox });
    if run.guard {
        let exe = towercab.to_string_lossy().replace('\'', r"'\''");
        s["hooks"] = json!({
            "PreToolUse": [{
                "matcher": "Edit|Write|NotebookEdit",
                "hooks": [{"type": "command", "command": format!("'{exe}' hook guard")}],
            }],
        });
    }
    s
}

/// The verifier's `--mcp-config`: Playwright limited to its app's `url`.
pub fn mcp_config(v: &VerifierNet) -> Value {
    json!({
        "mcpServers": {
            "playwright": {
                "command": "npx",
                "args": [
                    "--yes",
                    format!("@playwright/mcp@{PLAYWRIGHT_MCP}"),
                    "--allowed-origins",
                    v.url,
                ],
            },
        },
    })
}

/// A run's whole environment: `HOME`, `PATH` = `[agent].path`, `LANG` (the loop's, else
/// `C.UTF-8`) and Claude Code's telemetry (MET-12). Never a GitHub token (LOOP-19).
pub fn env(config: &Config) -> Vec<(OsString, OsString)> {
    let lang = std::env::var_os("LANG")
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "C.UTF-8".into());
    let mut e: Vec<(OsString, OsString)> = vec![
        ("HOME".into(), home().into()),
        ("PATH".into(), config.agent.path.clone().into()),
        ("LANG".into(), lang),
    ];
    for (k, v) in [
        ("CLAUDE_CODE_ENABLE_TELEMETRY", "1"),
        ("OTEL_METRICS_EXPORTER", "otlp"),
        ("OTEL_LOGS_EXPORTER", "otlp"),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"),
        (
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            config.metrics.endpoint.as_str(),
        ),
        ("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta"),
        ("OTEL_METRIC_EXPORT_INTERVAL", "30000"),
        ("OTEL_SERVICE_NAME", "towercab"),
    ] {
        e.push((k.into(), v.into()));
    }
    e
}

/// The child (LOOP-12): the argv, cwd, [`env`], prompt on stdin, stdout and stderr to its
/// files, its kind's timeout, a slot for all but the writer.
pub fn spec(run: &Run, config: &Config, exes: &Exes) -> ChildSpec {
    let f = run.files();
    ChildSpec {
        kind: ChildKind::Claude,
        argv: argv(run, exes),
        cwd: run.cwd.clone(),
        env: env(config),
        stdin: Some(f.prompt),
        stdout: f.stdout,
        stderr: f.stderr,
        timeout: Some(run.kind.timeout(config)),
        slot: run.kind.slot(),
        model: Some(run.model.clone()),
    }
}

/// Writes the run's files (the prompt, `--settings`, `CLAUDE.md` = `claude_md`, the base
/// branch's or empty without a repo, the verifier's MCP config), then its [`spec`].
pub fn prepare(
    run: &Run,
    claude_md: &str,
    config: &Config,
    exes: &Exes,
) -> Result<ChildSpec, String> {
    let f = run.files();
    fs::create_dir_all(&run.runs).map_err(|e| format!("{}: {e}", run.runs.display()))?;
    let towercab = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("towercab"));
    let mut files = vec![
        (f.prompt.clone(), run.prompt.clone()),
        (
            f.settings.clone(),
            settings(run, &home(), &towercab).to_string(),
        ),
        (f.claude_md.clone(), claude_md.to_string()),
    ];
    if let (RunKind::Verifier, Some(v)) = (run.kind, &run.verifier)
        && v.ui
    {
        files.push((f.mcp.clone(), mcp_config(v).to_string()));
    }
    for (path, text) in files {
        fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(spec(run, config, exes))
}

/// Token counts and cost of one model in a run (`modelUsage`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cost_usd: f64,
}

/// The `-p` JSON result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClaudeResult {
    /// `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, ….
    pub subtype: String,
    pub is_error: bool,
    pub result: String,
    pub session_id: String,
    pub total_cost_usd: f64,
    pub duration_ms: u64,
    /// By model.
    pub model_usage: BTreeMap<String, ModelUsage>,
    /// The `--json-schema` answer.
    pub structured_output: Option<Value>,
    pub permission_denials: Vec<Value>,
}

/// How a run ended, first match wins.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEnd {
    /// `No conversation found with session ID` (LOOP-7): a new session.
    SessionGone,
    /// A usage limit (LOOP-9).
    Limit(Limit),
    /// Network or auth (LOOP-10): the text.
    Env(String),
    /// `error_max_budget_usd`.
    Budget(ClaudeResult),
    /// A denied `git push` or secret path read: the stage fails (PIP-24).
    Denied(ClaudeResult),
    /// No result, or not JSON.
    NoResult(String),
    /// `is_error` (or a failed exit) otherwise: why.
    Failed(String),
    Ok(ClaudeResult),
}

fn num(v: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_u64))
        .unwrap_or(0)
}

fn float(v: &Value, keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_f64))
        .unwrap_or(0.0)
}

fn text(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

impl ClaudeResult {
    /// From a `{"type": "result", …}` object (`modelUsage` keys camelCase, as Claude Code
    /// writes them, or snake_case).
    pub fn from_json(v: &Value) -> ClaudeResult {
        let usage = |u: &Value| ModelUsage {
            input_tokens: num(u, &["inputTokens", "input_tokens"]),
            output_tokens: num(u, &["outputTokens", "output_tokens"]),
            cache_read_input_tokens: num(u, &["cacheReadInputTokens", "cache_read_input_tokens"]),
            cache_creation_input_tokens: num(
                u,
                &["cacheCreationInputTokens", "cache_creation_input_tokens"],
            ),
            cost_usd: float(u, &["costUSD", "cost_usd"]),
        };
        ClaudeResult {
            subtype: text(v, "subtype"),
            is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            result: text(v, "result"),
            session_id: text(v, "session_id"),
            total_cost_usd: float(v, &["total_cost_usd"]),
            duration_ms: num(v, &["duration_ms"]),
            model_usage: v
                .get("modelUsage")
                .and_then(Value::as_object)
                .map(|m| m.iter().map(|(k, u)| (k.clone(), usage(u))).collect())
                .unwrap_or_default(),
            structured_output: v.get("structured_output").filter(|s| !s.is_null()).cloned(),
            permission_denials: v
                .get("permission_denials")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// The last stdout line that is a JSON object with `type: "result"` (or all of stdout, when it
/// is one such object over several lines).
fn result_of(stdout: &str) -> Result<ClaudeResult, String> {
    let is_result =
        |v: &Value| v.is_object() && v.get("type").and_then(Value::as_str) == Some("result");
    let found = stdout
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .find(is_result)
        .or_else(|| {
            serde_json::from_str::<Value>(stdout.trim())
                .ok()
                .filter(is_result)
        });
    match found {
        Some(v) => Ok(ClaudeResult::from_json(&v)),
        None if stdout.trim().is_empty() => Err("no result".into()),
        None => Err(format!(
            "no JSON result: {}",
            cut(&one_line(stdout.trim()), 300)
        )),
    }
}

static GIT_PUSH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[\s;&|(`])git\s+(?:-\S+\s+(?:\S+\s+)?)*push\b").expect("push regex")
});

/// Every string in a JSON value.
fn strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        Value::Object(o) => o.values().for_each(|x| strings(x, out)),
        _ => {}
    }
}

/// A `permission_denials` entry that fails the stage: a `git push`, or a secret path
/// (absolute under `home`, or `~/…`).
pub fn is_fatal_denial(d: &Value, home: &Path) -> bool {
    let mut texts = Vec::new();
    strings(d.get("tool_input").unwrap_or(d), &mut texts);
    let bash = text(d, "tool_name") == "Bash";
    texts.iter().any(|t| {
        (bash && GIT_PUSH.is_match(t))
            || SECRETS.iter().any(|(p, _)| {
                let abs = home.join(p);
                t.contains(abs.to_string_lossy().as_ref()) || t.contains(&format!("~/{p}"))
            })
    })
}

/// What a run's stdout, stderr and exit say (pipeline.md **Claude runs**), first match:
/// session gone, a limit on `model` (reset parsed at `now`), network or auth, budget, a fatal
/// denial, no result, an error, else ok. `status` `None`: killed or lost (failed).
pub fn parse(
    model: &str,
    stdout: &str,
    stderr: &str,
    status: Option<ExitStatus>,
    now: DateTime<FixedOffset>,
) -> RunEnd {
    if session_gone(stderr) {
        return RunEnd::SessionGone;
    }
    let result = result_of(stdout);
    let exit_failed = !status.is_some_and(|s| s.success());
    let failed = exit_failed || result.as_ref().is_ok_and(|r| r.is_error);
    let said = result.as_ref().map(|r| r.result.as_str()).unwrap_or("");
    if let Some(limit) = limits::of_run(model, failed, said, stderr, now) {
        return RunEnd::Limit(limit);
    }
    if failed
        && let Some(t) = [said, stderr]
            .into_iter()
            .find(|t| crate::env::classify(t).is_some())
    {
        return RunEnd::Env(cut(&one_line(t), 300));
    }
    let r = match result {
        Ok(r) => r,
        Err(e) => {
            return RunEnd::NoResult(
                match stderr.lines().map(str::trim).find(|l| !l.is_empty()) {
                    Some(l) => format!("{e}; stderr: {}", cut(l, 300)),
                    None => e,
                },
            );
        }
    };
    if r.subtype == "error_max_budget_usd" {
        return RunEnd::Budget(r);
    }
    let home = home();
    if r.permission_denials
        .iter()
        .any(|d| is_fatal_denial(d, &home))
    {
        return RunEnd::Denied(r);
    }
    if failed {
        let why = if !r.result.trim().is_empty() {
            r.result.clone()
        } else if !r.subtype.is_empty() && r.subtype != "success" {
            r.subtype.clone()
        } else {
            stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map_or_else(|| "claude failed".to_string(), str::to_string)
        };
        return RunEnd::Failed(cut(&one_line(&why), 300));
    }
    RunEnd::Ok(r)
}

/// [`parse`] of an ended run's files.
pub fn end(run: &Run, end: &ChildEnd, now: DateTime<FixedOffset>) -> RunEnd {
    let read = |p: &Path| fs::read_to_string(p).unwrap_or_default();
    parse(
        &run.model,
        &read(&end.stdout),
        &read(&end.stderr),
        end.status,
        now,
    )
}

/// A repair's short prompt (PIP-13): `<what>:` and the findings when they are 20 lines or
/// fewer, else `<what>: the output is in <log>` (absolute, under `runs/<id>/`).
pub fn repair_prompt(what: &str, findings: &str, log: &Path) -> String {
    let findings = findings.trim_end();
    if findings.lines().count() <= 20 {
        format!("{what}:\n{findings}")
    } else {
        let log = std::path::absolute(log).unwrap_or_else(|_| log.to_path_buf());
        format!("{what}: the output is in {}", log.display())
    }
}

/// Whose notes go into `runs/<id>/build.txt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Note {
    /// The first build's final result: the file (written over by its continue).
    Build,
    /// A repair's result: appended as `\n\nRepair: <result>`.
    Repair,
}

/// `build.txt` (PIP-13): the first build's summary leads, each repair's result follows.
pub fn append_notes(path: &Path, note: Note, text: &str) -> Result<(), String> {
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    let text = text.trim();
    match note {
        Note::Build => fs::write(path, text).map_err(err),
        Note::Repair => {
            let mut all = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(err(e)),
            };
            if !all.is_empty() {
                all.push_str("\n\n");
            }
            all.push_str("Repair: ");
            all.push_str(text);
            fs::write(path, all).map_err(err)
        }
    }
}
