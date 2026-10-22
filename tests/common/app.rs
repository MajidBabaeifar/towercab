//! The GitHub App in tests (LOOP-19): a private key generated at test time and a fake GitHub
//! API on 127.0.0.1 that hands out installation tokens and knows the bot.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::{EncodePrivateKey, LineEnding};
use rsa::signature::Verifier;
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde_json::{Value, json};
use sha2::Sha256;

use super::http::{FakeHttp, Request};

/// The bot the fake API knows: `towercab[bot]`, user id 42.
pub const BOT_ID: u64 = 42;
pub const BOT: &str = "towercab[bot]";
pub const BOT_EMAIL: &str = "42+towercab[bot]@users.noreply.github.com";

/// A new 2048-bit key written to `path` as PKCS#1 (or PKCS#8) PEM, mode 0600; its public half.
pub fn key(path: &Path, pkcs8: bool) -> RsaPublicKey {
    use std::os::unix::fs::PermissionsExt;
    let key = RsaPrivateKey::new(&mut rand::thread_rng(), 2048).expect("key");
    let pem = if pkcs8 {
        key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string()
    } else {
        key.to_pkcs1_pem(LineEnding::LF).unwrap().to_string()
    };
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, pem).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    RsaPublicKey::from(&key)
}

/// A JWT's claims after its RS256 signature checked out with `public`.
pub fn verify_jwt(jwt: &str, public: &RsaPublicKey) -> Value {
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3, "{jwt}");
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(header, json!({"alg": "RS256", "typ": "JWT"}));
    let sig = Signature::try_from(URL_SAFE_NO_PAD.decode(parts[2]).unwrap().as_slice()).unwrap();
    VerifyingKey::<Sha256>::new(public.clone())
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
        .expect("signed with the App's key");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap()
}

#[derive(Debug, Default)]
pub struct GhState {
    /// `owner/name` → installation id; others answer 404.
    pub installs: BTreeMap<String, u64>,
    /// Tokens handed out, in order: (installation, token).
    pub tokens: Vec<(u64, String)>,
    /// A token's lifetime (s); default 3600.
    pub lifetime: Option<i64>,
    /// Every call answers this status.
    pub down: Option<u16>,
}

/// The fake GitHub API: `GET /repos/<o>/<n>/installation`, `POST
/// /app/installations/<id>/access_tokens` (token `tok-<id>-<n>`), `GET /app` (slug
/// `towercab`), `GET /users/towercab%5Bbot%5D` (id 42).
pub struct FakeGithub {
    pub http: FakeHttp,
    pub state: Arc<Mutex<GhState>>,
}

impl FakeGithub {
    /// Installed on each of `repos` (`owner/name`), ids 11, 12, ….
    pub fn start(repos: &[&str]) -> FakeGithub {
        let state = Arc::new(Mutex::new(GhState {
            installs: repos
                .iter()
                .enumerate()
                .map(|(i, r)| (r.to_string(), 11 + i as u64))
                .collect(),
            ..GhState::default()
        }));
        let st = Arc::clone(&state);
        let http = FakeHttp::start(move |req| {
            let mut s = st.lock().unwrap();
            if let Some(code) = s.down {
                return (code, json!({"message": "down"}).to_string());
            }
            let path = req.path.as_str();
            if let Some(repo) = path
                .strip_prefix("/repos/")
                .and_then(|p| p.strip_suffix("/installation"))
            {
                return match s.installs.get(repo) {
                    Some(id) => (200, json!({"id": id}).to_string()),
                    None => (404, json!({"message": "Not Found"}).to_string()),
                };
            }
            if let Some(id) = path
                .strip_prefix("/app/installations/")
                .and_then(|p| p.strip_suffix("/access_tokens"))
            {
                let id: u64 = id.parse().unwrap();
                let token = format!("tok-{id}-{}", s.tokens.len() + 1);
                s.tokens.push((id, token.clone()));
                let at =
                    chrono::Utc::now() + chrono::TimeDelta::seconds(s.lifetime.unwrap_or(3600));
                return (
                    201,
                    json!({"token": token, "expires_at": at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)})
                        .to_string(),
                );
            }
            match path {
                "/app" => (200, json!({"id": 1, "slug": "towercab"}).to_string()),
                "/users/towercab%5Bbot%5D" => {
                    (200, json!({"login": BOT, "id": BOT_ID}).to_string())
                }
                _ => (404, json!({"message": "Not Found"}).to_string()),
            }
        });
        FakeGithub { http, state }
    }

    pub fn requests(&self) -> Vec<Request> {
        self.http.requests.lock().unwrap().clone()
    }

    /// Tokens handed out: (installation, token).
    pub fn tokens(&self) -> Vec<(u64, String)> {
        self.state.lock().unwrap().tokens.clone()
    }

    pub fn lifetime(&self, secs: i64) {
        self.state.lock().unwrap().lifetime = Some(secs);
    }

    pub fn down(&self, code: Option<u16>) {
        self.state.lock().unwrap().down = code;
    }
}

/// `<dir>/app.pem`: where `Config::app_key` looks next to `<dir>/config.toml`.
pub fn key_path(dir: &Path) -> PathBuf {
    dir.join("app.pem")
}
