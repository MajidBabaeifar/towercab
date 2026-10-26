//! Network, auth and tool failures (LOOP-10): [`classify`], the `faults` rows, `env_blocked`
//! episodes and the start-up [`preflight`].
//!
//! A fault opens on the first failure of its kind. One a mission's step hit (`missions.fault`,
//! "held") closes when that step next succeeds; one no mission holds (the preflight's, the
//! loop's own PR reads and `intents` polls, or one whose mission moved on) is rechecked with
//! [`check`] every [`RECHECK`] seconds and closes when that passes. A fault open for
//! [`BLOCK_AFTER`] seconds starts an episode ([`episode`]): no picks, no wait timeouts, one
//! message; the last fault closing ends it.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::process::Command;
use std::str::FromStr;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};

use crate::config::Config;
use crate::db::{FaultRow, del_meta, get_meta, set_meta, sql};
use crate::exes::Exes;
use crate::github::Identity;
use crate::intents::git::GitAuth;
use crate::outbox::{self, Notice, cut, one_line};

/// A fault open this long (seconds) → `env_blocked`.
pub const BLOCK_AFTER: f64 = 900.0;

/// Unheld faults are rechecked, and steps retried while blocked, this often (seconds).
pub const RECHECK: f64 = 300.0;

/// A check that runs longer is killed and fails.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// What failed: a `faults` row's kind.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Fault {
    Github,
    Claude,
    /// A program missing or failing on the unit's `PATH`.
    Tool(String),
    Sandbox,
    /// `~/.config/towercab/secrets/<repo>.env` refused.
    Secrets(String),
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Fault::Github => f.write_str("github"),
            Fault::Claude => f.write_str("claude"),
            Fault::Tool(exe) => write!(f, "tool:{exe}"),
            Fault::Sandbox => f.write_str("sandbox"),
            Fault::Secrets(repo) => write!(f, "secrets:{repo}"),
        }
    }
}

impl FromStr for Fault {
    type Err = String;

    fn from_str(s: &str) -> Result<Fault, String> {
        match s {
            "github" => Ok(Fault::Github),
            "claude" => Ok(Fault::Claude),
            "sandbox" => Ok(Fault::Sandbox),
            _ => match s.split_once(':') {
                Some(("tool", exe)) if !exe.is_empty() => Ok(Fault::Tool(exe.into())),
                Some(("secrets", repo)) if !repo.is_empty() => Ok(Fault::Secrets(repo.into())),
                _ => Err(format!("unknown fault kind {s}")),
            },
        }
    }
}

impl Fault {
    /// What I do about it (the env blocked message's `fix:` line, loop.md **Messages**).
    pub fn fix(&self) -> String {
        match self {
            Fault::Github => "check the network and the GitHub App (ops/github-app.json, ~/.config/towercab/app.pem)".into(),
            Fault::Claude => "run claude and /login, or check the network".into(),
            Fault::Tool(exe) => format!("install {exe} on the unit's PATH"),
            Fault::Sandbox => "the sandbox can't start: on Ubuntu set [agent] sandbox_unix_sockets = true (towercab doctor), else check bwrap".into(),
            Fault::Secrets(repo) => {
                format!("chmod 600 ~/.config/towercab/secrets/{repo}.env")
            }
        }
    }
}

/// A failed call's class (by its stderr).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultClass {
    /// DNS, refused, reset, timeout, TLS, HTTP 5xx.
    Network,
    /// HTTP 401, `Bad credentials`, claude `/login`.
    Auth,
}

static AUTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\bhttp(?:/[0-9.]+)?:? 401\b|\b401 unauthorized|status(?: code)?:? 401\b|returned error: 401\b|bad credentials|authentication failed|/login\b|invalid api key|oauth token (?:has )?expired",
    )
    .expect("auth regex")
});

static NETWORK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)could not resolve (?:host|proxy)|name resolution|name or service not known|no address associated|connection (?:refused|reset|timed out|closed)|network is unreachable|no route to host|timed? ?out\b|tls handshake|handshake (?:failed|failure)|ssl certificate problem|certificate verify failed|ssl_(?:connect|read|write|error)|ssl routines|tls connection|ssl connection|unexpected eof|early eof|\bhttp(?:/[0-9.]+)?:? 5[0-9]{2}\b|\b5[0-9]{2} (?:internal server error|bad gateway|service unavailable|gateway time-?out)|status(?: code)?:? 5[0-9]{2}\b|returned error: 5[0-9]{2}\b|api error: 5[0-9]{2}|error connecting|failed to connect to|could(?: not|n't) connect to server|econn(?:refused|reset)|etimedout|enotfound|eai_again|fetch failed|socket hang up",
    )
    .expect("network regex")
});

/// Network or auth by a failed call's stderr (git, gh, the GitHub API, Telegram, OTLP,
/// `claude`); anything else is the call's own failure.
pub fn classify(stderr: &str) -> Option<FaultClass> {
    if AUTH.is_match(stderr) {
        Some(FaultClass::Auth)
    } else if NETWORK.is_match(stderr) {
        Some(FaultClass::Network)
    } else {
        None
    }
}

/// The retry delay after the n-th failure of a step: 30 s, 60 s, 120 s, 240 s, then 300 s.
pub fn backoff(retries: u32) -> Duration {
    let secs = 30u64 << retries.saturating_sub(1).min(4);
    Duration::from_secs(secs.min(300))
}

/// Opens `fault` (a new row: `since` = now) or records another failure (`last`, `error`);
/// next recheck in [`RECHECK`]. True when it is new.
pub fn open(conn: &Connection, fault: &Fault, error: &str, now: f64) -> Result<bool, String> {
    let error = cut(&one_line(error), outbox::WHY_MAX);
    let new = conn
        .execute(
            "INSERT OR IGNORE INTO faults (kind, since, last, error, next_try) VALUES (?1, ?2, ?2, ?3, ?4)",
            params![fault.to_string(), now, error, now + RECHECK],
        )
        .map_err(sql)?
        == 1;
    if !new {
        conn.execute(
            "UPDATE faults SET last = ?2, error = ?3, next_try = ?4 WHERE kind = ?1",
            params![fault.to_string(), now, error, now + RECHECK],
        )
        .map_err(sql)?;
    }
    Ok(new)
}

/// Closes the fault of kind `kind`; true when it was open.
pub fn close(conn: &Connection, kind: &str) -> Result<bool, String> {
    conn.execute("DELETE FROM faults WHERE kind = ?1", [kind])
        .map(|n| n == 1)
        .map_err(sql)
}

/// A mission's step succeeded: the fault it held closes (`missions.fault` cleared).
pub fn settle(conn: &Connection, mission: i64) -> Result<(), String> {
    let held: Option<String> = conn
        .query_row("SELECT fault FROM missions WHERE id = ?1", [mission], |r| {
            r.get(0)
        })
        .optional()
        .map_err(sql)?
        .flatten();
    if let Some(kind) = held {
        close(conn, &kind)?;
        conn.execute("UPDATE missions SET fault = NULL WHERE id = ?1", [mission])
            .map_err(sql)?;
    }
    Ok(())
}

/// Open faults, oldest first.
pub fn faults(conn: &Connection) -> Result<Vec<FaultRow>, String> {
    let mut q = conn
        .prepare("SELECT * FROM faults ORDER BY since, kind")
        .map_err(sql)?;
    q.query_map([], FaultRow::from_row)
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

/// Fault kinds unfinished missions hold.
pub fn held(conn: &Connection) -> Result<BTreeSet<String>, String> {
    let mut q = conn
        .prepare(
            "SELECT DISTINCT fault FROM missions WHERE fault IS NOT NULL AND stage NOT IN ('done', 'stopped')",
        )
        .map_err(sql)?;
    q.query_map([], |r| r.get(0))
        .map_err(sql)?
        .collect::<Result<_, _>>()
        .map_err(sql)
}

/// An `env_blocked` episode is open (`meta.env_episode`).
pub fn blocked(conn: &Connection) -> Result<bool, String> {
    Ok(get_meta(conn, "env_episode")?.is_some())
}

/// Starts or ends the episode; call inside one transaction. None open and a fault open
/// [`BLOCK_AFTER`] → a new one: `meta.env_episode` = now (unix s, its key) and its message
/// (outbox `loop`, `env_blocked`, episode; the oldest such fault). Open and no fault left →
/// ended. Returns whether blocked.
pub fn episode(conn: &Connection, now: f64) -> Result<bool, String> {
    let open = faults(conn)?;
    let current = get_meta(conn, "env_episode")?;
    if open.is_empty() {
        if current.is_some() {
            del_meta(conn, "env_episode")?;
        }
        return Ok(false);
    }
    if current.is_some() {
        return Ok(true);
    }
    let Some(f) = open.iter().find(|f| now - f.since >= BLOCK_AFTER) else {
        return Ok(false);
    };
    let id = (now.floor() as i64).to_string();
    set_meta(conn, "env_episode", &id)?;
    let fix = f.kind.parse::<Fault>().map(|k| k.fix()).unwrap_or_default();
    let notice = Notice::EnvBlocked {
        kind: f.kind.clone(),
        error: f.error.clone(),
        fix,
    };
    outbox::notify(conn, &notice, &id, now)?;
    Ok(true)
}

/// Why a check failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckError {
    /// The program isn't there.
    Missing(String),
    Failed(String),
}

impl From<CheckError> for String {
    fn from(e: CheckError) -> String {
        match e {
            CheckError::Missing(s) | CheckError::Failed(s) => s,
        }
    }
}

/// Runs `exe args` in its own process group from `/`, stdin from `/dev/null`, for at most
/// [`CHECK_TIMEOUT`]: exit 0 → ok; else its stderr's first line (or the exit) as the reason.
pub fn run_check(exe: &OsStr, args: &[&OsStr]) -> Result<(), CheckError> {
    run_check_as(exe, args, &GitAuth::default())
}

/// [`run_check`] of a git call as the App: `auth`'s `-c` args first, its env set (LOOP-19).
pub fn run_check_as(exe: &OsStr, args: &[&OsStr], auth: &GitAuth) -> Result<(), CheckError> {
    let shown = std::iter::once(exe)
        .chain(args.iter().copied())
        .map(|a| a.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = Command::new(exe);
    cmd.args(&auth.args)
        .envs(auth.env.iter().map(|(k, v)| (k, v)))
        .args(args)
        .current_dir("/")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1");
    let out = crate::child::output(&mut cmd, CHECK_TIMEOUT).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            CheckError::Missing(format!("{}: not found", exe.to_string_lossy()))
        }
        _ => CheckError::Failed(format!("{shown}: {e}")),
    })?;
    let status = out.status;
    if status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let line = err.lines().map(str::trim).find(|l| !l.is_empty());
    Err(CheckError::Failed(match line {
        Some(l) => format!("{shown}: {}", cut(l, outbox::WHY_MAX)),
        None => format!("{shown}: {status}"),
    }))
}

/// The URLs the `github` checks `git ls-remote`: each valid repo's clone's `origin` (else
/// `https://github.com/<github>.git`, `checkout::origin_url`), then `[intents].remote`.
pub fn github_urls(config: &Config, exes: &Exes) -> Vec<String> {
    let mut urls: Vec<String> = config
        .repos
        .values()
        .filter_map(|r| r.as_ref().ok())
        .map(|r| crate::checkout::origin_url(&exes.git, r))
        .collect();
    urls.extend(config.intents.remote.clone());
    urls
}

/// `git ls-remote <url> HEAD`, as the App on a `https://github.com/` URL: its token for that
/// repo is minted first (LOOP-19); a failed mint is the check's failure.
fn ls_remote(exes: &Exes, identity: &Identity, url: &str) -> Result<(), CheckError> {
    let auth = identity
        .auth_for_url(url)
        .map_err(|e| CheckError::Failed(format!("{url}: GitHub App: {e}")))?;
    let url = OsString::from(url);
    run_check_as(
        &exes.git,
        &[OsStr::new("ls-remote"), url.as_os_str(), OsStr::new("HEAD")],
        &auth,
    )
}

/// `<exe> --version`.
fn version(exe: &OsStr) -> Result<(), CheckError> {
    run_check(exe, &[OsStr::new("--version")])
}

/// The program of a `tool:<exe>` fault: Towercab's own by name, else `exe` itself.
fn tool<'a>(exes: &'a Exes, exe: &'a str) -> &'a OsStr {
    match exe {
        "git" => &exes.git,
        "gh" => &exes.gh,
        "claude" => &exes.claude,
        "cargo" => &exes.cargo,
        "bwrap" => &exes.bwrap,
        "systemd-inhibit" => &exes.systemd_inhibit,
        "systemctl" => &exes.systemctl,
        "journalctl" => &exes.journalctl,
        _ => OsStr::new(exe),
    }
}

/// Rechecks a fault no mission holds: `github` = every [`github_urls`] answers `ls-remote`
/// (as the App: with its token for that repo); `claude`, `tool:<exe>`, `sandbox` (bwrap) =
/// `--version` exits 0; `secrets:<repo>` = the file is absent or not readable by others.
pub fn check(
    fault: &Fault,
    config: &Config,
    exes: &Exes,
    identity: &mut Identity,
) -> Result<(), String> {
    match fault {
        Fault::Github => github_urls(config, exes)
            .iter()
            .try_for_each(|u| ls_remote(exes, identity, u).map_err(String::from)),
        Fault::Claude => version(&exes.claude).map_err(String::from),
        Fault::Tool(exe) => version(tool(exes, exe)).map_err(String::from),
        Fault::Sandbox => version(&exes.bwrap).map_err(String::from),
        Fault::Secrets(repo) => secrets(config, repo),
    }
}

/// `secrets/<repo>.env` next to the config file: absent, or mode without group/other bits.
fn secrets(config: &Config, repo: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = config
        .file
        .parent()
        .map(|d| d.join("secrets"))
        .unwrap_or_default();
    let path = dir.join(format!("{repo}.env"));
    match std::fs::metadata(&path) {
        Err(_) => Ok(()),
        Ok(m) if m.permissions().mode() & 0o077 == 0 => Ok(()),
        Ok(m) => Err(format!(
            "{}: mode {:o}, readable by others",
            path.display(),
            m.permissions().mode() & 0o777
        )),
    }
}

/// The start-up checks on the unit's `PATH`, each with the fault its failure opens: `git
/// ls-remote <url> HEAD` per [`github_urls`] (`github`; the first failure ends them), `claude
/// --version` (`claude`), `cargo --version` (`tool:cargo`), `bwrap --version` (`sandbox`),
/// `systemd-inhibit --version` (`tool:systemd-inhibit`); a missing program → `tool:<name>`.
/// A passed check also reports `tool:<name>` passed. As the GitHub App (LOOP-19) each
/// `https://github.com/` URL's installation token is minted first (a failure: `github`).
pub fn preflight(
    config: &Config,
    exes: &Exes,
    identity: &mut Identity,
) -> Vec<(Fault, Result<(), String>)> {
    let mut out = Vec::new();
    for url in github_urls(config, exes) {
        match ls_remote(exes, identity, &url) {
            Ok(()) => out.push((Fault::Github, Ok(()))),
            Err(CheckError::Missing(e)) => {
                out.push((Fault::Tool("git".into()), Err(e)));
                break;
            }
            Err(CheckError::Failed(e)) => {
                out.push((Fault::Github, Err(e)));
                break;
            }
        }
    }
    let tools: [(&OsStr, &str, Fault); 4] = [
        (&exes.claude, "claude", Fault::Claude),
        (&exes.cargo, "cargo", Fault::Tool("cargo".into())),
        (&exes.bwrap, "bwrap", Fault::Sandbox),
        (
            &exes.systemd_inhibit,
            "systemd-inhibit",
            Fault::Tool("systemd-inhibit".into()),
        ),
    ];
    for (exe, name, failing) in tools {
        let missing = Fault::Tool(name.into());
        match version(exe) {
            Ok(()) => {
                if missing != failing {
                    out.push((missing, Ok(())));
                }
                out.push((failing, Ok(())));
            }
            Err(CheckError::Missing(e)) => out.push((missing, Err(e))),
            Err(CheckError::Failed(e)) => out.push((failing, Err(e))),
        }
    }
    out
}

/// Records checks' results (call inside one transaction): each failure opens (or renews) its
/// fault; a kind whose checks all passed closes unless a mission holds it. Returns the
/// failures that opened a fault, for the log.
pub fn record(
    conn: &Connection,
    results: &[(Fault, Result<(), String>)],
    now: f64,
) -> Result<Vec<(Fault, String)>, String> {
    let failed: BTreeSet<&Fault> = results
        .iter()
        .filter(|(_, r)| r.is_err())
        .map(|(f, _)| f)
        .collect();
    let held = held(conn)?;
    let mut opened = Vec::new();
    for (fault, r) in results {
        match r {
            Err(e) => {
                if open(conn, fault, e, now)? {
                    opened.push((fault.clone(), e.clone()));
                }
            }
            Ok(()) if !failed.contains(fault) && !held.contains(&fault.to_string()) => {
                close(conn, &fault.to_string())?;
            }
            Ok(()) => {}
        }
    }
    Ok(opened)
}

/// An environment failure in a run's text (a worker's question, a setup log), not a question
/// for me (LOOP-10): Claude Code's sandbox not starting → `sandbox`; `sh: 1: <exe>: not found`
/// or `<exe>: command not found` → `tool:<exe>`. The reason is the matching line.
pub fn classify_run(text: &str) -> Option<(Fault, String)> {
    let line = |pat: &dyn Fn(&str) -> bool| {
        text.lines()
            .find(|l| pat(l))
            .map(|l| crate::outbox::cut(l.trim(), 200))
    };
    if let Some(l) = line(&|l: &str| {
        l.contains("apply-seccomp")
            || l.contains("bwrap:")
            || (l.contains("setgroups") && l.contains("Permission denied"))
    }) {
        return Some((Fault::Sandbox, l));
    }
    let re = regex::Regex::new(
        r"(?:\bsh: \d+: ([A-Za-z0-9._+-]+): not found|\b([A-Za-z0-9._+-]+): command not found|: \d+: exec: (?:\S*/)?([A-Za-z0-9._+-]+): not found)",
    )
    .expect("static regex");
    let caps = re.captures(text)?;
    let exe = caps
        .get(1)
        .or(caps.get(2))
        .or(caps.get(3))?
        .as_str()
        .to_string();
    let why = crate::outbox::cut(caps.get(0)?.as_str(), 200);
    Some((Fault::Tool(exe), why))
}
