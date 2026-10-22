//! Network, auth and tool failures (LOOP-10).
//!
//! So far what the machine's `Backoff` needs: [`Fault`] and [`backoff`] (loop-runner part 2).
//! `classify`, the `faults` rows, `env_blocked` and the preflight come with part 3.

use std::fmt;
use std::time::Duration;

/// What failed: a `faults` row's kind.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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

/// The retry delay after the n-th failure of a step: 30 s, 60 s, 120 s, 240 s, then 300 s.
pub fn backoff(retries: u32) -> Duration {
    let secs = 30u64 << retries.saturating_sub(1).min(4);
    Duration::from_secs(secs.min(300))
}
