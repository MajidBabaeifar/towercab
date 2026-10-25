//! `~/.config/towercab/config.toml` (LOOP-1, **Config**): `[intents]` (INT-1), `[agent]`,
//! `[repos.<name>]`, `[github]`, `[telegram]`, `[metrics]`, `[policies]`.
//!
//! A wrong type or range fails every load. A bad `[repos.<name>]` fails only what uses that repo
//! ([`Config::repo`]) and the loop's commands ([`Config::check_loop`]): the Python version's
//! `[repos.<name>]` (no `github`) shares this file, and `add`, `migrate` and `protect intents`
//! never look at `[repos]`. Unknown keys are ignored.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::intents::intent::is_repo;

/// Where the intent home lives and how parked works.
#[derive(Debug, Clone, PartialEq)]
pub struct IntentsConfig {
    /// Clone URL of the `intents` repo; cloned into `path` when that is missing.
    pub remote: Option<String>,
    /// Towercab's own checkout (`~/` expanded).
    pub path: PathBuf,
    /// Priority below this is parked (PRI-5), 1-15.
    pub cutoff: u8,
}

/// A target repo, `[repos.<name>]` (LOOP-1).
#[derive(Debug, Clone, PartialEq)]
pub struct RepoConfig {
    /// The table's name: what `intent.md`'s `repo:` names.
    pub name: String,
    /// `<owner>/<name>` on GitHub.
    pub github: String,
    /// Towercab's own clone (`~/` expanded): only fetched into and pushed from (LOOP-8).
    pub path: PathBuf,
    /// The branch PRs go to (default `main`).
    pub base: String,
    /// Unfinished missions at a time (1-255, default 1).
    pub workers: u8,
    /// Extra worker Bash patterns (PIP-24).
    pub bash: Vec<String>,
}

/// `[agent]`: how the loop runs Claude and the checks (LOOP-1).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentConfig {
    /// Model of an intent without `model` (`opus`).
    pub model: String,
    /// Active children with a slot at a time (1-16, LOOP-4).
    pub parallel: u8,
    /// Model that drafts intents from issues and alerts (`sonnet`, INT-7).
    pub drafter: String,
    /// Run-time bounds (configured in minutes): build 60, review 15, checks 10.
    pub build_timeout: Duration,
    pub review_timeout: Duration,
    pub check_timeout: Duration,
    /// `--max-budget-usd` of a Claude run (above 0, at most 1000; 5).
    pub max_budget_usd: f64,
    /// CI cadence (configured in seconds): poll 30, grace 120, wait 1800.
    pub ci_poll: Duration,
    pub ci_grace: Duration,
    pub ci_wait: Duration,
    /// `PATH` of checks and Claude runs (default: the loop's `PATH`).
    pub path: String,
    /// Toolchain directories runs may use (`~/` expanded, absolute).
    pub toolchain: Vec<PathBuf>,
}

impl Default for AgentConfig {
    /// The defaults; `path` is this process's `PATH`, `toolchain` expanded with `HOME`.
    fn default() -> AgentConfig {
        AgentConfig {
            model: "opus".into(),
            parallel: 1,
            drafter: "sonnet".into(),
            build_timeout: Duration::from_secs(60 * 60),
            review_timeout: Duration::from_secs(15 * 60),
            check_timeout: Duration::from_secs(10 * 60),
            max_budget_usd: 5.0,
            ci_poll: Duration::from_secs(30),
            ci_grace: Duration::from_secs(120),
            ci_wait: Duration::from_secs(1800),
            path: std::env::var_os("PATH")
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            toolchain: DEFAULT_TOOLCHAIN
                .iter()
                .map(|d| expand(d).unwrap_or_else(|_| PathBuf::from(d)))
                .collect(),
        }
    }
}

pub const DEFAULT_TOOLCHAIN: [&str; 3] = ["~/.cargo/bin", "~/.rustup", "~/.local/bin"];

/// `[github]`: the GitHub App Towercab acts as (LOOP-19). `app_id` and `me` are required only
/// by the loop's commands ([`Config::check_loop`]).
#[derive(Debug, Clone, PartialEq)]
pub struct GithubConfig {
    pub app_id: Option<u64>,
    /// My GitHub login: whose PR comments and merges are mine.
    pub me: Option<String>,
    /// No trailing `/` (`https://api.github.com`).
    pub api_base: String,
}

/// `[telegram]` (LOOP-16); absent → no Telegram.
#[derive(Debug, Clone, PartialEq)]
pub struct TelegramConfig {
    pub bot_token: String,
    /// A string or an integer in the file, kept as a string.
    pub chat_id: String,
    /// No trailing `/` (`https://api.telegram.org`).
    pub api_base: String,
}

/// `[metrics]`: OTLP endpoint (MET-13) and Prometheus (MNT-1).
#[derive(Debug, Clone, PartialEq)]
pub struct MetricsConfig {
    pub endpoint: String,
    pub prometheus: String,
}

impl Default for MetricsConfig {
    fn default() -> MetricsConfig {
        MetricsConfig {
            endpoint: "http://localhost:4318".into(),
            prometheus: "http://localhost:9090".into(),
        }
    }
}

/// `[policies]`: the shared agent instructions (PIP-27); no `github` → none.
#[derive(Debug, Clone, PartialEq)]
pub struct PoliciesConfig {
    pub github: Option<String>,
    pub base: String,
}

impl Default for PoliciesConfig {
    fn default() -> PoliciesConfig {
        PoliciesConfig {
            github: None,
            base: "main".into(),
        }
    }
}

/// `[ui]`: the local web page (UI-1).
#[derive(Debug, Clone, PartialEq)]
pub struct UiConfig {
    /// `127.0.0.1:<port>`; 0 = off.
    pub port: u16,
}

pub const DEFAULT_UI_PORT: u16 = 7311;

impl Default for UiConfig {
    fn default() -> UiConfig {
        UiConfig {
            port: DEFAULT_UI_PORT,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// The file this was read from.
    pub file: PathBuf,
    pub intents: IntentsConfig,
    /// `[repos.<name>]` by name, or why the table is bad (`config: <file>: repos.<name>…`);
    /// read through [`Config::repo`].
    pub repos: BTreeMap<String, Result<RepoConfig, String>>,
    pub agent: AgentConfig,
    pub github: Option<GithubConfig>,
    pub telegram: Option<TelegramConfig>,
    pub metrics: MetricsConfig,
    pub policies: PoliciesConfig,
    pub ui: UiConfig,
}

pub const DEFAULT_INTENTS_PATH: &str = "~/.local/share/towercab/intents";
pub const DEFAULT_CUTOFF: u8 = 7;
pub const GITHUB_API: &str = "https://api.github.com";
pub const TELEGRAM_API: &str = "https://api.telegram.org";

impl Config {
    /// `file` and `[intents]`, every other section at its defaults (no `[repos]`, `[github]`,
    /// `[telegram]`).
    pub fn new(file: PathBuf, intents: IntentsConfig) -> Config {
        Config {
            file,
            intents,
            repos: BTreeMap::new(),
            agent: AgentConfig::default(),
            github: None,
            telegram: None,
            metrics: MetricsConfig::default(),
            policies: PoliciesConfig::default(),
            ui: UiConfig::default(),
        }
    }

    /// Reads `--config` (`file`), else `TOWERCAB_CONFIG`, else `~/.config/towercab/config.toml`.
    /// Errors read `config: <file>: <key or TOML error>`.
    pub fn load(file: Option<&Path>) -> Result<Config, String> {
        let file = match file {
            Some(f) => expand(&f.to_string_lossy())?,
            None => match std::env::var_os("TOWERCAB_CONFIG") {
                Some(f) if !f.is_empty() => expand(&f.to_string_lossy())?,
                _ => expand("~/.config/towercab/config.toml")?,
            },
        };
        let shown = file.display().to_string();
        let err = |what: &str| format!("config: {shown}: {what}");
        let text = std::fs::read_to_string(&file).map_err(|e| err(&e.to_string()))?;
        let table: toml::Table = text
            .parse()
            .map_err(|e: toml::de::Error| err(e.message().trim()))?;
        let (name, section) = match (table.get("intents"), table.get("tasks")) {
            (Some(s), _) => ("intents", s),
            (None, Some(s)) => ("tasks", s),
            (None, None) => return Err(err("[intents] is missing")),
        };
        let section = section
            .as_table()
            .ok_or_else(|| err(&format!("{name} must be a table")))?;
        let string = |key: &str| -> Result<Option<String>, String> {
            match section.get(key) {
                None => Ok(None),
                Some(toml::Value::String(s)) => Ok(Some(s.clone())),
                Some(_) => Err(err(&format!("{name}.{key} must be a string"))),
            }
        };
        let remote = string("remote")?;
        let path = string("path")?;
        if remote.is_none() && path.is_none() {
            return Err(err(&format!("{name}.remote or {name}.path is required")));
        }
        let path = expand(path.as_deref().unwrap_or(DEFAULT_INTENTS_PATH))
            .map_err(|e| err(&format!("{name}.path: {e}")))?;
        let cutoff = match section.get("cutoff") {
            None => DEFAULT_CUTOFF,
            Some(toml::Value::Integer(n)) if (1..=15).contains(n) => *n as u8,
            Some(_) => return Err(err(&format!("{name}.cutoff must be an integer 1-15"))),
        };
        let repos = match table.get("repos") {
            None => BTreeMap::new(),
            Some(toml::Value::Table(t)) => t
                .iter()
                .map(|(name, v)| (name.clone(), repo(name, v).map_err(|e| err(&e))))
                .collect(),
            Some(_) => return Err(err("repos must be a table")),
        };
        let sections = || -> Result<_, String> {
            Ok((
                agent(&Section::of(&table, "agent")?)?,
                github(&Section::of(&table, "github")?)?,
                telegram(&Section::of(&table, "telegram")?)?,
                metrics(&Section::of(&table, "metrics")?)?,
                policies(&Section::of(&table, "policies")?)?,
                ui(&Section::of(&table, "ui")?)?,
            ))
        };
        let (agent, github, telegram, metrics, policies, ui) = sections().map_err(|e| err(&e))?;
        Ok(Config {
            file,
            intents: IntentsConfig {
                remote,
                path,
                cutoff,
            },
            repos,
            agent,
            github,
            telegram,
            metrics,
            policies,
            ui,
        })
    }

    /// `[repos.<name>]`: absent → `unknown repo <name>`; a bad table → its error.
    pub fn repo(&self, name: &str) -> Result<&RepoConfig, String> {
        match self.repos.get(name) {
            None => Err(format!("unknown repo {name}")),
            Some(r) => r.as_ref().map_err(Clone::clone),
        }
    }

    /// The GitHub App's private key: `app.pem` next to the config file
    /// (`~/.config/towercab/app.pem`, LOOP-19).
    pub fn app_key(&self) -> PathBuf {
        self.file.parent().unwrap_or(Path::new(".")).join("app.pem")
    }

    /// What `run`, `step`, `up` and `doctor` need beyond a loadable file: `[github]` `app_id`
    /// and `me`, and every `[repos]` table valid. Errors read like [`Config::load`]'s.
    pub fn check_loop(&self) -> Result<(), String> {
        let err = |what: &str| format!("config: {}: {what}", self.file.display());
        let github = self.github.as_ref();
        if github.and_then(|g| g.app_id).is_none() {
            return Err(err("github.app_id is required"));
        }
        if github.and_then(|g| g.me.as_ref()).is_none() {
            return Err(err("github.me is required"));
        }
        for r in self.repos.values() {
            r.as_ref().map_err(Clone::clone)?;
        }
        Ok(())
    }
}

/// One top-level `[section]`: typed reads whose errors read `<section>.<key> …`.
struct Section<'a> {
    name: &'static str,
    table: Option<&'a toml::Table>,
}

impl<'a> Section<'a> {
    fn of(top: &'a toml::Table, name: &'static str) -> Result<Section<'a>, String> {
        match top.get(name) {
            None => Ok(Section { name, table: None }),
            Some(toml::Value::Table(t)) => Ok(Section {
                name,
                table: Some(t),
            }),
            Some(_) => Err(format!("{name} must be a table")),
        }
    }

    fn get(&self, key: &str) -> Option<&'a toml::Value> {
        self.table.and_then(|t| t.get(key))
    }

    fn must(&self, key: &str, what: &str) -> String {
        format!("{}.{key} must be {what}", self.name)
    }

    fn required(&self, key: &str) -> String {
        format!("{}.{key} is required", self.name)
    }

    /// An integer in `lo..=hi`; `unit` ends the error (` (minutes)`).
    fn int(&self, key: &str, lo: i64, hi: i64, default: i64, unit: &str) -> Result<i64, String> {
        match self.get(key) {
            None => Ok(default),
            Some(toml::Value::Integer(n)) if (lo..=hi).contains(n) => Ok(*n),
            Some(_) => Err(self.must(key, &format!("an integer {lo}-{hi}{unit}"))),
        }
    }

    fn secs(&self, key: &str, lo: i64, hi: i64, default: i64) -> Result<Duration, String> {
        Ok(Duration::from_secs(
            self.int(key, lo, hi, default, " (seconds)")? as u64,
        ))
    }

    fn mins(&self, key: &str, default: i64) -> Result<Duration, String> {
        Ok(Duration::from_secs(
            self.int(key, 1, 1440, default, " (minutes)")? as u64 * 60,
        ))
    }

    /// A string accepted by `ok`, else `<key> must be <what>`.
    fn string(
        &self,
        key: &str,
        what: &str,
        ok: impl Fn(&str) -> bool,
    ) -> Result<Option<String>, String> {
        match self.get(key) {
            None => Ok(None),
            Some(toml::Value::String(s)) if ok(s) => Ok(Some(s.clone())),
            Some(_) => Err(self.must(key, what)),
        }
    }

    /// A model name: non-empty, no whitespace.
    fn model(&self, key: &str, default: &str) -> Result<String, String> {
        let ok = |s: &str| !s.is_empty() && !s.chars().any(char::is_whitespace);
        Ok(self
            .string(key, "a non-empty string without whitespace", ok)?
            .unwrap_or_else(|| default.to_string()))
    }

    /// An `http://` or `https://` URL, trailing `/` dropped.
    fn url(&self, key: &str, default: &str) -> Result<String, String> {
        let url = self.string(key, "an http:// or https:// URL", is_url)?;
        Ok(url
            .as_deref()
            .unwrap_or(default)
            .trim_end_matches('/')
            .to_string())
    }
}

/// `http://` or `https://` and a host, no whitespace or control characters.
pub fn is_url(s: &str) -> bool {
    let rest = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"));
    rest.is_some_and(|r| {
        !r.split('/').next().unwrap_or("").is_empty()
            && !r.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}

/// A GitHub login as `[github].me` takes it: `[A-Za-z0-9-]+`.
pub fn is_login(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn agent(s: &Section) -> Result<AgentConfig, String> {
    let d = AgentConfig::default();
    let budget = match s.get("max_budget_usd") {
        None => d.max_budget_usd,
        Some(toml::Value::Integer(n)) if (1..=1000).contains(n) => *n as f64,
        Some(toml::Value::Float(f)) if *f > 0.0 && *f <= 1000.0 => *f,
        Some(_) => return Err(s.must("max_budget_usd", "a number above 0, at most 1000")),
    };
    let path = s
        .string("path", "a non-empty string", |p| !p.is_empty())?
        .unwrap_or(d.path);
    let toolchain = match s.get("toolchain") {
        None => d.toolchain,
        Some(toml::Value::Array(items)) => items
            .iter()
            .map(|i| match i {
                toml::Value::String(p) if !p.is_empty() => {
                    expand(p).ok().filter(|p| p.is_absolute())
                }
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| s.must("toolchain", "a list of absolute paths (or ~/…)"))?,
        Some(_) => return Err(s.must("toolchain", "a list of absolute paths (or ~/…)")),
    };
    Ok(AgentConfig {
        model: s.model("model", &d.model)?,
        parallel: s.int("parallel", 1, 16, 1, "")? as u8,
        drafter: s.model("drafter", &d.drafter)?,
        build_timeout: s.mins("build_timeout", 60)?,
        review_timeout: s.mins("review_timeout", 15)?,
        check_timeout: s.mins("check_timeout", 10)?,
        max_budget_usd: budget,
        ci_poll: s.secs("ci_poll", 5, 3600, 30)?,
        ci_grace: s.secs("ci_grace", 0, 3600, 120)?,
        ci_wait: s.secs("ci_wait", 60, 86400, 1800)?,
        path,
        toolchain,
    })
}

fn github(s: &Section) -> Result<Option<GithubConfig>, String> {
    if s.table.is_none() {
        return Ok(None);
    }
    let app_id = match s.get("app_id") {
        None => None,
        Some(toml::Value::Integer(n)) if *n >= 1 => Some(*n as u64),
        Some(_) => return Err(s.must("app_id", "an integer >= 1")),
    };
    Ok(Some(GithubConfig {
        app_id,
        me: s.string("me", "a GitHub login ([A-Za-z0-9-])", is_login)?,
        api_base: s.url("api_base", GITHUB_API)?,
    }))
}

fn telegram(s: &Section) -> Result<Option<TelegramConfig>, String> {
    if s.table.is_none() {
        return Ok(None);
    }
    let bot_token = s
        .string("bot_token", "a non-empty string", |t| !t.is_empty())?
        .ok_or_else(|| s.required("bot_token"))?;
    let chat_id = match s.get("chat_id") {
        None => return Err(s.required("chat_id")),
        Some(toml::Value::String(c)) if !c.is_empty() => c.clone(),
        Some(toml::Value::Integer(n)) => n.to_string(),
        Some(_) => return Err(s.must("chat_id", "a non-empty string or an integer")),
    };
    Ok(Some(TelegramConfig {
        bot_token,
        chat_id,
        api_base: s.url("api_base", TELEGRAM_API)?,
    }))
}

fn metrics(s: &Section) -> Result<MetricsConfig, String> {
    let d = MetricsConfig::default();
    Ok(MetricsConfig {
        endpoint: s.url("endpoint", &d.endpoint)?,
        prometheus: s.url("prometheus", &d.prometheus)?,
    })
}

fn policies(s: &Section) -> Result<PoliciesConfig, String> {
    Ok(PoliciesConfig {
        github: s.string("github", "\"<owner>/<name>\"", is_github)?,
        base: s
            .string("base", "a branch name ([A-Za-z0-9._/-])", is_branch)?
            .unwrap_or_else(|| "main".into()),
    })
}

fn ui(s: &Section) -> Result<UiConfig, String> {
    Ok(UiConfig {
        port: s.int("port", 0, 65535, i64::from(DEFAULT_UI_PORT), "")? as u16,
    })
}

/// A branch name Towercab accepts as `base` (within `git check-ref-format --branch`):
/// `[A-Za-z0-9._/-]+`, not `HEAD`, not starting with `-` or ending with `.`, no `..`; each
/// `/`-separated component non-empty, not starting with `.` or ending with `.lock`.
pub fn is_branch(s: &str) -> bool {
    s != "HEAD"
        && !s.starts_with('-')
        && !s.ends_with('.')
        && !s.contains("..")
        && s.split('/')
            .all(|c| !c.is_empty() && !c.starts_with('.') && !c.ends_with(".lock"))
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
}

/// `<owner>/<name>`, each a repo name.
pub fn is_github(s: &str) -> bool {
    s.split_once('/')
        .is_some_and(|(o, n)| is_repo(o) && is_repo(n))
}

/// `[repos.<name>]`; errors read `repos.<name>[.<key>] …` (a bad name shown as a quoted TOML
/// key). Other keys are ignored (the Python version's `verify`, `remote`).
fn repo(name: &str, value: &toml::Value) -> Result<RepoConfig, String> {
    if !is_repo(name) {
        return Err(format!(
            "repos.{name:?} is not a repo name ([A-Za-z0-9._-], no leading -)"
        ));
    }
    let at = format!("repos.{name}");
    if name == "intents" {
        return Err(format!(
            "{at} is reserved: `protect intents` is the intent home"
        ));
    }
    let t = value
        .as_table()
        .ok_or_else(|| format!("{at} must be a table"))?;
    let string = |key: &str| -> Result<Option<&str>, String> {
        match t.get(key) {
            None => Ok(None),
            Some(toml::Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(format!("{at}.{key} must be a string")),
        }
    };
    let github = string("github")?.ok_or_else(|| format!("{at}.github is required"))?;
    if !is_github(github) {
        return Err(format!("{at}.github must be \"<owner>/<name>\""));
    }
    let path = string("path")?.ok_or_else(|| format!("{at}.path is required"))?;
    if path.is_empty() {
        return Err(format!("{at}.path is empty"));
    }
    let path = expand(path).map_err(|e| format!("{at}.path: {e}"))?;
    if !path.is_absolute() {
        return Err(format!("{at}.path must be absolute or start with ~/"));
    }
    let base = string("base")?.unwrap_or("main");
    if !is_branch(base) {
        return Err(format!("{at}.base must be a branch name ([A-Za-z0-9._/-])"));
    }
    let workers = match t.get("workers") {
        None => 1,
        Some(toml::Value::Integer(n)) if (1..=255).contains(n) => *n as u8,
        Some(_) => return Err(format!("{at}.workers must be an integer 1-255")),
    };
    let bash = match t.get("bash") {
        None => Vec::new(),
        Some(toml::Value::Array(items)) => items
            .iter()
            .map(|i| match i {
                toml::Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| format!("{at}.bash must be a list of non-empty strings"))?,
        Some(_) => return Err(format!("{at}.bash must be a list of non-empty strings")),
    };
    Ok(RepoConfig {
        name: name.to_string(),
        github: github.to_string(),
        path,
        base: base.to_string(),
        workers,
        bash,
    })
}

/// `~` and `~/…` → `$HOME/…`; anything else unchanged.
pub fn expand(path: &str) -> Result<PathBuf, String> {
    if path == "~" || path.starts_with("~/") {
        let home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .ok_or("HOME is not set")?;
        let mut out = PathBuf::from(home);
        if let Some(rest) = path.strip_prefix("~/") {
            out.push(rest);
        }
        Ok(out)
    } else {
        Ok(PathBuf::from(path))
    }
}
