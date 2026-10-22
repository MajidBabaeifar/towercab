//! Who Towercab is on GitHub (LOOP-19): the GitHub App `towercab` (an RS256 JWT from
//! `app.pem` → a 1-hour installation token per repo, cached, re-minted when < 10 min remain;
//! commits as `towercab[bot]`). Without `[github].app_id` (only in tests: the loop's commands
//! refuse to start without it) [`Identity::none`]: my own `gh` login and git setup.
//!
//! An [`Identity`] is a handle: clones share one token cache, so the loop, its PR reads and
//! the intent store's git calls mint each token once.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use rsa::RsaPrivateKey;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::{SignatureEncoding, Signer};
use serde_json::{Value, json};
use sha2::Sha256;

use crate::child::GH_TIMEOUT;
use crate::config::Config;
use crate::exes::Exes;
use crate::http::{self, HttpError};
use crate::intents::git::GitAuth;
use crate::intents::intent::is_repo;

/// A failed `gh` or GitHub API call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhError {
    /// Network or auth: retried with backoff (LOOP-10).
    Env(String),
    /// GitHub answered no: the message is the reason.
    Failed(String),
}

impl fmt::Display for GhError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GhError::Env(m) | GhError::Failed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for GhError {}

/// Network and auth failures by their stderr (`env::classify`, LOOP-10).
pub fn is_env_failure(stderr: &str) -> bool {
    crate::env::classify(stderr).is_some()
}

/// A token is re-minted when fewer seconds than this remain.
pub const REMINT: i64 = 600;

/// The JWT's `iat` is this far back (clock drift), its `exp` this far ahead (GitHub allows 600).
pub const JWT_BACK: i64 = 60;
pub const JWT_AHEAD: i64 = 540;

/// The GitHub API version every call asks for.
pub const API_VERSION: &str = "2022-11-28";

/// The App's id and private key.
pub struct App {
    pub app_id: u64,
    key: SigningKey<Sha256>,
}

impl fmt::Debug for App {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("App").field("app_id", &self.app_id).finish()
    }
}

impl App {
    /// The private key at `path`: PKCS#1 (`BEGIN RSA PRIVATE KEY`) or PKCS#8 (`BEGIN PRIVATE
    /// KEY`) PEM. Refused when group or others may read it (mode 0600 wanted).
    pub fn load(path: &Path, app_id: u64) -> Result<App, String> {
        use std::os::unix::fs::PermissionsExt;
        let shown = path.display();
        let meta = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!("{shown}: mode {mode:o}, want 600"));
        }
        let pem = std::fs::read_to_string(path).map_err(|e| format!("{shown}: {e}"))?;
        let key = RsaPrivateKey::from_pkcs1_pem(&pem)
            .or_else(|_| RsaPrivateKey::from_pkcs8_pem(&pem))
            .map_err(|_| format!("{shown}: not an RSA private key (PKCS#1 or PKCS#8 PEM)"))?;
        Ok(App {
            app_id,
            key: SigningKey::<Sha256>::new(key),
        })
    }

    /// The RS256 JWT of App calls: `iat` = now − 60 s, `exp` = now + 540 s, `iss` = the app id.
    pub fn jwt(&self, now: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(json!({"alg": "RS256", "typ": "JWT"}).to_string());
        let claims = json!({"iat": now - JWT_BACK, "exp": now + JWT_AHEAD, "iss": self.app_id});
        let signed = format!("{header}.{}", URL_SAFE_NO_PAD.encode(claims.to_string()));
        let sig = self.key.sign(signed.as_bytes()).to_vec();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig))
    }
}

/// The App's bot user: commits, PRs and comments show as `login`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bot {
    /// `<slug>[bot]`.
    pub login: String,
    pub id: u64,
    /// `<id>+<slug>[bot]@users.noreply.github.com`.
    pub email: String,
}

impl Bot {
    pub fn new(slug: &str, id: u64) -> Bot {
        let login = format!("{slug}[bot]");
        Bot {
            email: format!("{id}+{login}@users.noreply.github.com"),
            login,
            id,
        }
    }

    /// `meta.bot`: `<slug> <user id>`.
    pub fn meta(&self) -> String {
        format!("{} {}", self.slug(), self.id)
    }

    pub fn from_meta(s: &str) -> Option<Bot> {
        let (slug, id) = s.trim().split_once(' ')?;
        let id = id.parse().ok()?;
        is_repo(slug).then(|| Bot::new(slug, id))
    }

    pub fn slug(&self) -> &str {
        self.login.trim_end_matches("[bot]")
    }
}

/// An installation token and when it expires (unix s).
#[derive(Debug, Clone)]
struct Token {
    token: String,
    expires: i64,
}

#[derive(Debug)]
struct AppState {
    /// The App, or why its key didn't load (every call fails with it).
    app: Result<App, String>,
    api_base: String,
    /// By `owner/name`, lowercased.
    tokens: BTreeMap<String, Token>,
    installs: BTreeMap<String, u64>,
    bot: Option<Bot>,
    /// GitHub API calls made (tests count them).
    calls: u64,
}

/// The identity Towercab's own `gh` and `git` calls use.
#[derive(Debug, Clone)]
pub struct Identity {
    app: Option<Arc<Mutex<AppState>>>,
    gh: OsString,
    /// Each `gh` call is killed after this ([`crate::child::GH_TIMEOUT`]).
    timeout: Duration,
}

impl Default for Identity {
    fn default() -> Identity {
        Identity::none()
    }
}

/// `owner/name` of a `https://github.com/<owner>/<name>[.git][/]` URL: the only URLs the App
/// token is used for (git asks credential helpers only over HTTPS).
pub fn github_of(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://github.com/")?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    (is_repo(owner) && is_repo(name)).then(|| format!("{owner}/{name}"))
}

/// An API answer that isn't a token: network, 401 and 5xx are `Env` (LOOP-10).
fn api_error(what: &str, e: HttpError) -> GhError {
    match e {
        HttpError::Net(m) => GhError::Env(m),
        HttpError::Status(code, body) if code == 401 || code >= 500 => {
            GhError::Env(format!("{what}: HTTP {code}: {body}"))
        }
        HttpError::Status(code, body) => GhError::Failed(format!("{what}: HTTP {code}: {body}")),
    }
}

/// Headers of an App call (`Authorization: Bearer <JWT>`; none for a public read).
fn headers(auth: Option<&str>) -> Vec<(&str, &str)> {
    let mut h = vec![
        ("Accept", "application/vnd.github+json"),
        ("X-GitHub-Api-Version", API_VERSION),
        ("User-Agent", "towercab"),
    ];
    if let Some(a) = auth {
        h.push(("Authorization", a));
    }
    h
}

impl Identity {
    /// My `gh` login and git setup, no token.
    pub fn none() -> Identity {
        Identity {
            app: None,
            gh: "gh".into(),
            timeout: GH_TIMEOUT,
        }
    }

    /// The App (or why its key didn't load) at `api_base`.
    pub fn app(app: Result<App, String>, api_base: &str) -> Identity {
        Identity {
            app: Some(Arc::new(Mutex::new(AppState {
                app,
                api_base: api_base.trim_end_matches('/').to_string(),
                tokens: BTreeMap::new(),
                installs: BTreeMap::new(),
                bot: None,
                calls: 0,
            }))),
            gh: "gh".into(),
            timeout: GH_TIMEOUT,
        }
    }

    /// `[github].app_id` set → the App with the key at `Config::app_key` (one that doesn't
    /// load fails every call with why, a `github` fault); else [`Identity::none`]. Its `gh`
    /// is `exes.gh`.
    pub fn from_config(config: &Config, exes: &Exes) -> Identity {
        let id = match config.github.as_ref() {
            Some(g) => match g.app_id {
                Some(app_id) => Identity::app(App::load(&config.app_key(), app_id), &g.api_base),
                None => Identity::none(),
            },
            None => Identity::none(),
        };
        id.with_gh(&exes.gh)
    }

    /// The `gh` executable its calls and the git credential helper run.
    pub fn with_gh(mut self, gh: &OsStr) -> Identity {
        self.gh = gh.to_os_string();
        self
    }

    /// Its `gh` calls are killed after `timeout` (tests).
    pub fn with_timeout(mut self, timeout: Duration) -> Identity {
        self.timeout = timeout;
        self
    }

    pub fn is_app(&self) -> bool {
        self.app.is_some()
    }

    /// GitHub API calls made so far (tests).
    pub fn api_calls(&self) -> u64 {
        self.state().map_or(0, |s| s.calls)
    }

    fn state(&self) -> Option<MutexGuard<'_, AppState>> {
        self.app
            .as_ref()
            .map(|a| a.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// A 1-hour installation token for `github` (`owner/name`): cached, re-minted when fewer
    /// than [`REMINT`] seconds remain at `now` (unix s). `GET /repos/<github>/installation`
    /// (JWT) → `POST /app/installations/<id>/access_tokens` `{repositories: [<name>]}`.
    pub fn token(&self, github: &str, now: i64) -> Result<String, GhError> {
        let Some(mut s) = self.state() else {
            return Err(GhError::Failed("no GitHub App configured".into()));
        };
        let key = github.to_ascii_lowercase();
        if let Some(t) = s.tokens.get(&key)
            && t.expires - now >= REMINT
        {
            return Ok(t.token.clone());
        }
        let auth = match &s.app {
            Ok(app) => format!("Bearer {}", app.jwt(now)),
            Err(e) => return Err(GhError::Env(e.clone())),
        };
        let base = s.api_base.clone();
        let install = match s.installs.get(&key) {
            Some(id) => *id,
            None => {
                s.calls += 1;
                let what = format!("GET /repos/{github}/installation");
                let url = format!("{base}/repos/{github}/installation");
                let (_, v) = http::get_json(&url, &headers(Some(&auth)), http::TIMEOUT).map_err(
                    |e| match e {
                        HttpError::Status(404, _) => {
                            GhError::Failed(format!("the GitHub App isn't installed on {github}"))
                        }
                        e => api_error(&what, e),
                    },
                )?;
                let id = v
                    .get("id")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| GhError::Failed(format!("{what}: no id")))?;
                s.installs.insert(key.clone(), id);
                id
            }
        };
        let name = github.split_once('/').map_or(github, |(_, n)| n);
        s.calls += 1;
        let what = format!("POST /app/installations/{install}/access_tokens");
        let url = format!("{base}/app/installations/{install}/access_tokens");
        let body = json!({"repositories": [name]});
        let (_, v) = http::post_json(&url, &headers(Some(&auth)), &body, http::TIMEOUT)
            .map_err(|e| api_error(&what, e))?;
        let token = v
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| GhError::Failed(format!("{what}: no token")))?
            .to_string();
        let expires = v
            .get("expires_at")
            .and_then(Value::as_str)
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map_or(now + 3600, |t| t.timestamp());
        s.tokens.insert(
            key,
            Token {
                token: token.clone(),
                expires,
            },
        );
        Ok(token)
    }

    /// The App's bot user (cached; the loop keeps it in `meta.bot`): `GET /app` (JWT) → slug,
    /// `GET /users/<slug>[bot]` → id.
    pub fn bot(&self) -> Result<Bot, GhError> {
        let Some(mut s) = self.state() else {
            return Err(GhError::Failed("no GitHub App configured".into()));
        };
        if let Some(b) = &s.bot {
            return Ok(b.clone());
        }
        let auth = match &s.app {
            Ok(app) => format!("Bearer {}", app.jwt(chrono::Utc::now().timestamp())),
            Err(e) => return Err(GhError::Env(e.clone())),
        };
        let base = s.api_base.clone();
        s.calls += 1;
        let (_, app) = http::get_json(&format!("{base}/app"), &headers(Some(&auth)), http::TIMEOUT)
            .map_err(|e| api_error("GET /app", e))?;
        let slug = app
            .get("slug")
            .and_then(Value::as_str)
            .filter(|s| is_repo(s))
            .ok_or_else(|| GhError::Failed("GET /app: no slug".into()))?
            .to_string();
        s.calls += 1;
        let what = format!("GET /users/{slug}[bot]");
        let url = format!("{base}/users/{slug}%5Bbot%5D");
        let (_, user) =
            http::get_json(&url, &headers(None), http::TIMEOUT).map_err(|e| api_error(&what, e))?;
        let id = user
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| GhError::Failed(format!("{what}: no id")))?;
        let bot = Bot::new(&slug, id);
        s.bot = Some(bot.clone());
        Ok(bot)
    }

    /// The bot already known (looked up, or from `meta.bot`).
    pub fn cached_bot(&self) -> Option<Bot> {
        self.state().and_then(|s| s.bot.clone())
    }

    /// The bot from `meta.bot`: no lookup needed.
    pub fn seed_bot(&self, bot: Bot) {
        if let Some(mut s) = self.state() {
            s.bot = Some(bot);
        }
    }

    /// `gh <args>` on repo `github` → stdout; a non-zero exit → [`GhError`] by its stderr;
    /// still running after [`GH_TIMEOUT`] → killed, `Env` (`gh <arg>: timed out after 120 s`).
    /// As the App: `GH_TOKEN` = its token for `github`; else my `gh` login.
    pub fn gh(&self, github: &str, args: &[&str]) -> Result<String, GhError> {
        let mut cmd = Command::new(&self.gh);
        cmd.args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1");
        if self.is_app() {
            let token = self.token(github, chrono::Utc::now().timestamp())?;
            cmd.env_remove("GITHUB_TOKEN").env("GH_TOKEN", token);
        }
        let out = crate::child::output(&mut cmd, self.timeout).map_err(|e| {
            GhError::Env(match e.kind() {
                std::io::ErrorKind::TimedOut => {
                    format!("gh {}: {e}", args.first().unwrap_or(&""))
                }
                _ => format!("{}: {e}", self.gh.to_string_lossy()),
            })
        })?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err = if err.is_empty() {
            format!("gh {} failed", args.first().unwrap_or(&""))
        } else {
            err
        };
        Err(if is_env_failure(&err) {
            GhError::Env(err)
        } else {
            GhError::Failed(err)
        })
    }

    /// What git adds to act as the App on `github` (`owner/name`): `-c credential.helper=`
    /// (mine dropped), `-c credential.helper=!'<gh>' auth git-credential` with `GH_TOKEN`
    /// (git ignores `GH_TOKEN` itself), and the bot as `user.name`/`user.email` (author and
    /// committer). [`Identity::none`]: nothing (my own git setup).
    pub fn git_auth(&self, github: &str) -> Result<GitAuth, GhError> {
        if !self.is_app() {
            return Ok(GitAuth::default());
        }
        let token = self.token(github, chrono::Utc::now().timestamp())?;
        let bot = self.bot()?;
        let gh = self.gh.to_string_lossy().replace('\'', r"'\''");
        Ok(GitAuth {
            args: vec![
                "-c".into(),
                "credential.helper=".into(),
                "-c".into(),
                format!("credential.helper=!'{gh}' auth git-credential"),
                "-c".into(),
                format!("user.name={}", bot.login),
                "-c".into(),
                format!("user.email={}", bot.email),
            ],
            env: vec![("GH_TOKEN".into(), token)],
        })
    }

    /// [`Identity::git_auth`] for a remote URL on `https://github.com/`; any other (ssh, a
    /// path) → nothing: the App token can't be used there.
    pub fn auth_for_url(&self, url: &str) -> Result<GitAuth, GhError> {
        match github_of(url) {
            Some(github) => self.git_auth(&github),
            None => Ok(GitAuth::default()),
        }
    }
}
