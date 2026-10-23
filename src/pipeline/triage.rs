//! Triage of e2e red after my merge (PIP-20): the model classifies (`door`, `red_lines`,
//! `why`); code decides whether Towercab reverts.

use crate::machine::Door;

use super::prompts;
use super::schemas::TriageResult;

/// The call in code: a two-way door with a red line touched → `None` (revert, PIP-19);
/// otherwise no revert: `Some(door)` for `waiting: e2e red after your merge (<door>)`.
pub fn decide(t: &TriageResult) -> Option<Door> {
    if t.door == Door::TwoWay && !t.red_lines.is_empty() {
        None
    } else {
        Some(t.door)
    }
}

/// `prompts/triage.md`: the diff command, the e2e log (redacted, last 16k) and the base
/// branch's `## Red lines`.
pub fn prompt(diff_cmd: &str, log: &str, red_lines: &[String]) -> Result<String, String> {
    let lines = if red_lines.is_empty() {
        "(none listed)".to_string()
    } else {
        red_lines
            .iter()
            .map(|l| format!("- {l}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    prompts::render(
        "triage",
        &[
            ("diff_cmd", diff_cmd),
            ("log", log.trim_end()),
            ("red_lines", &lines),
        ],
    )
}
