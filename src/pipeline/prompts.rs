//! The pipeline's prompts (pipeline.md **Prompts**): `prompts/<name>.md`, compiled in so the
//! eval gate (PIP-33) sees them change, `{{key}}` placeholders filled in one pass.

/// Every prompt by name (later parts add theirs).
const PROMPTS: [(&str, &str); 7] = [
    ("build", include_str!("../../prompts/build.md")),
    ("design", include_str!("../../prompts/design.md")),
    (
        "design_revise",
        include_str!("../../prompts/design_revise.md"),
    ),
    ("plan", include_str!("../../prompts/plan.md")),
    ("result", include_str!("../../prompts/result.md")),
    ("round", include_str!("../../prompts/round.md")),
    ("writer", include_str!("../../prompts/writer.md")),
];

/// The names of the prompts.
pub fn names() -> Vec<&'static str> {
    PROMPTS.iter().map(|(n, _)| *n).collect()
}

/// Prompt `name` with each `{{key}}` replaced by its value (values are not scanned again). A
/// placeholder without a value, a value without a placeholder or an unknown name → `Err` (a
/// bug).
pub fn render(name: &str, values: &[(&str, &str)]) -> Result<String, String> {
    let template = PROMPTS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, t)| *t)
        .ok_or_else(|| format!("prompt {name}: unknown"))?;
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
                out.push_str(values[k].1);
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
