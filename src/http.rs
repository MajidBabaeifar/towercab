//! Blocking JSON over HTTP(S) for the Telegram Bot API and, with the App identity, the GitHub
//! API (`ureq`, rustls; no async). A bot token in a URL (`/bot<token>/`) never reaches an error.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

/// Every call's timeout.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// A failed call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    /// No answer: DNS, refused, reset, timeout, TLS (`env::classify` reads it as network).
    Net(String),
    /// An answer that isn't a 2xx with a JSON body: the status and the body (or why it isn't
    /// JSON).
    Status(u16, String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Net(m) => f.write_str(m),
            HttpError::Status(code, m) => write!(f, "HTTP {code}: {m}"),
        }
    }
}

impl std::error::Error for HttpError {}

static BOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/bot[^/\s]+").expect("bot regex"));

/// `/bot<token>` → `/bot<token>` with the token replaced by the literal `<token>`.
pub fn mask(s: &str) -> String {
    BOT.replace_all(s, "/bot<token>").into_owned()
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

fn answer(
    method: &str,
    url: &str,
    r: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
) -> Result<(u16, Value), HttpError> {
    let shown = mask(url);
    let net = |e: ureq::Error| HttpError::Net(mask(&format!("{method} {shown}: {e}")));
    let mut resp = r.map_err(net)?;
    let status = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().map_err(net)?;
    let body = crate::outbox::cut(&crate::outbox::one_line(&mask(&text)), 300);
    if !(200..300).contains(&status) {
        return Err(HttpError::Status(status, body));
    }
    serde_json::from_str(&text)
        .map(|v| (status, v))
        .map_err(|e| HttpError::Status(status, format!("not JSON ({e}): {body}")))
}

/// `GET url` with `headers` → (status, JSON body) of a 2xx answer.
pub fn get_json(
    url: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<(u16, Value), HttpError> {
    let mut req = agent(timeout).get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    answer("GET", url, req.call())
}

/// `GET url` → (status, body) of any answer (PIP-32's app check, PIP-8's `url:` deploy);
/// no answer → `Net`.
pub fn get_text(url: &str, timeout: Duration) -> Result<(u16, String), HttpError> {
    let net = |e: ureq::Error| HttpError::Net(mask(&format!("GET {}: {e}", mask(url))));
    let mut resp = agent(timeout).get(url).call().map_err(net)?;
    let status = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().map_err(net)?;
    Ok((status, text))
}

/// `POST url` with `headers` and `body` as JSON → (status, JSON body) of a 2xx answer.
pub fn post_json(
    url: &str,
    headers: &[(&str, &str)],
    body: &Value,
    timeout: Duration,
) -> Result<(u16, Value), HttpError> {
    let mut req = agent(timeout)
        .post(url)
        .header("Content-Type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    answer("POST", url, req.send(body.to_string()))
}
