//! `REVIEW.md`: the review policy (REPO-4, playbook p.38-39).

use super::markdown::{bullets, items, lines, sections, text};

/// The passes when `## Passes` is missing or has no bullets: (name, one-line what).
pub const DEFAULT_PASSES: [(&str, &str); 3] = [
    (
        "Bugs",
        "wrong behaviour, unhandled errors, edge cases, tests that don't check the behaviour",
    ),
    (
        "Security",
        "secrets in code or logs, injection, unsafe input handling, access checks",
    ),
    (
        "Compliance with the spec rows and `plan.md`",
        "every changed row is built and its tests check it; nothing outside the plan",
    ),
];

/// Nits shown per review when `## Cap the nits` has no number.
pub const DEFAULT_NIT_CAP: u32 = 5;

const SECTIONS: [&str; 5] = [
    "Passes",
    "What Important means here",
    "Cap the nits",
    "Do not report",
    "Red lines",
];

/// One review pass: `name: what`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pass {
    pub name: String,
    pub what: String,
}

/// `REVIEW.md`, read from the base branch.
#[derive(Debug, Clone, PartialEq)]
pub struct Review {
    /// The whole file, given to the review (PIP-4); empty without one.
    pub text: String,
    pub passes: Vec<Pass>,
    /// `## What Important means here`, trimmed.
    pub important: Option<String>,
    /// Nits shown per review (`## Cap the nits`).
    pub nit_cap: u32,
    /// `## Do not report` bullets.
    pub do_not_report: Vec<String>,
    /// `## Red lines` bullets: what makes a PR high blast radius.
    pub red_lines: Vec<String>,
}

impl Default for Review {
    /// No `REVIEW.md`.
    fn default() -> Review {
        Review {
            text: String::new(),
            passes: default_passes(),
            important: None,
            nit_cap: DEFAULT_NIT_CAP,
            do_not_report: Vec::new(),
            red_lines: Vec::new(),
        }
    }
}

fn default_passes() -> Vec<Pass> {
    DEFAULT_PASSES
        .iter()
        .map(|(name, what)| Pass {
            name: name.to_string(),
            what: what.to_string(),
        })
        .collect()
}

impl Review {
    /// `REVIEW.md`'s text → the policy; errors read `REVIEW.md: <where>: <what>`.
    pub fn parse(file: &str) -> Result<Review, String> {
        Self::read(file).map_err(|e| format!("REVIEW.md: {e}"))
    }

    fn read(file: &str) -> Result<Review, String> {
        let items = items(&lines(file), 1)?;
        let [passes, important, cap, do_not_report, red_lines] = sections(&items, &SECTIONS)?[..]
        else {
            unreachable!("five titles")
        };
        let passes = match passes.map(bullets).unwrap_or_default() {
            b if b.is_empty() => default_passes(),
            b => parse_passes(&b)?,
        };
        let important = important
            .map(|s| text(s).trim().to_string())
            .filter(|s| !s.is_empty());
        let nit_cap = match cap.map(text) {
            None => DEFAULT_NIT_CAP,
            Some(t) => {
                let digits: String = t
                    .chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(char::is_ascii_digit)
                    .collect();
                if digits.is_empty() {
                    DEFAULT_NIT_CAP
                } else {
                    digits
                        .parse()
                        .map_err(|_| format!("## Cap the nits: {digits} is too large"))?
                }
            }
        };
        Ok(Review {
            text: file.to_string(),
            passes,
            important,
            nit_cap,
            do_not_report: do_not_report.map(bullets).unwrap_or_default(),
            red_lines: red_lines.map(bullets).unwrap_or_default(),
        })
    }
}

/// `<name>: <what>` bullets, split at the first `:`; spaces, `*` and `_` trimmed from both
/// ends of each part.
fn parse_passes(bullets: &[String]) -> Result<Vec<Pass>, String> {
    fn trim(s: &str) -> &str {
        s.trim_matches(|c: char| c.is_whitespace() || c == '*' || c == '_')
    }
    let mut passes: Vec<Pass> = Vec::new();
    for b in bullets {
        let (name, what) = b
            .split_once(':')
            .map(|(n, w)| (trim(n), trim(w)))
            .filter(|(n, w)| !n.is_empty() && !w.is_empty())
            .ok_or_else(|| format!("## Passes: want \"<name>: <what>\", got \"{b}\""))?;
        if passes.iter().any(|p| p.name.eq_ignore_ascii_case(name)) {
            return Err(format!("## Passes: pass {name} twice"));
        }
        passes.push(Pass {
            name: name.to_string(),
            what: what.to_string(),
        });
    }
    Ok(passes)
}
