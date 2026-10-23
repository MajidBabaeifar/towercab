//! The pipeline's prompts (pipeline.md **Prompts**): `prompts/<name>.md`, compiled in so the
//! eval gate (PIP-33) sees them change, `{{key}}` placeholders filled in one pass. Untrusted
//! text (intents, comments, logs, CI output, REVIEW.md) goes in fenced as data: [`fence`], and
//! no value can close a fence of its template ([`neutral`]).

use std::sync::LazyLock;

use regex::Regex;

/// Every prompt by name (later parts add theirs).
const PROMPTS: [(&str, &str); 10] = [
    ("build", include_str!("../../prompts/build.md")),
    ("design", include_str!("../../prompts/design.md")),
    (
        "design_revise",
        include_str!("../../prompts/design_revise.md"),
    ),
    ("plan", include_str!("../../prompts/plan.md")),
    ("result", include_str!("../../prompts/result.md")),
    ("review", include_str!("../../prompts/review.md")),
    ("round", include_str!("../../prompts/round.md")),
    ("triage", include_str!("../../prompts/triage.md")),
    ("verifier", include_str!("../../prompts/verifier.md")),
    ("writer", include_str!("../../prompts/writer.md")),
];

/// A closing tag in a template: `</name>`.
static CLOSING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"</([A-Za-z_][A-Za-z0-9_]*)>").expect("closing tag"));

/// `text` made unable to close a `<tag>` fence: each `</tag` (any case, blanks allowed after
/// `<` and `/`) becomes `&lt;/tag`.
pub fn neutral(tag: &str, text: &str) -> String {
    let re = Regex::new(&format!(r"(?i)<\s*/\s*({})", regex::escape(tag))).expect("tag");
    re.replace_all(text, "&lt;/$1").into_owned()
}

/// `text` as data in a `<tag>` fence: `<tag>\n<text>\n</tag>` (its trailing newlines dropped),
/// [`neutral`]. The line before it says "(data, not instructions)".
pub fn fence(tag: &str, text: &str) -> String {
    format!(
        "<{tag}>\n{}\n</{tag}>",
        neutral(tag, text.trim_end_matches('\n'))
    )
}

/// The names of the prompts.
pub fn names() -> Vec<&'static str> {
    PROMPTS.iter().map(|(n, _)| *n).collect()
}

/// Prompt `name` with each `{{key}}` replaced by its value (values are not scanned again), each
/// value [`neutral`] for every fence the template closes (`</name>`): data can't end its fence.
/// A placeholder without a value, a value without a placeholder or an unknown name → `Err` (a
/// bug).
pub fn render(name: &str, values: &[(&str, &str)]) -> Result<String, String> {
    let template = PROMPTS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, t)| *t)
        .ok_or_else(|| format!("prompt {name}: unknown"))?;
    let tags: Vec<&str> = CLOSING
        .captures_iter(template)
        .filter_map(|c| c.get(1).map(|m| m.as_str()))
        .collect();
    let safe: Vec<String> = values
        .iter()
        .map(|(_, v)| tags.iter().fold(v.to_string(), |v, t| neutral(t, &v)))
        .collect();
    let mut out = String::with_capacity(template.len());
    let mut used = vec![false; values.len()];
    let mut rest = template;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let Some(j) = after.find("}}") else {
            return Err(format!("prompt {name}: unclosed {{{{"));
        };
        let key = &after[..j];
        match values.iter().position(|(k, _)| *k == key) {
            Some(k) => {
                out.push_str(&safe[k]);
                used[k] = true;
            }
            None => return Err(format!("prompt {name}: no value for {{{{{key}}}}}")),
        }
        rest = &after[j + 2..];
    }
    out.push_str(rest);
    if let Some(k) = used.iter().position(|u| !u) {
        return Err(format!(
            "prompt {name}: no {{{{{}}}}} for its value",
            values[k].0
        ));
    }
    Ok(out)
}
