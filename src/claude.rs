//! Claude runs (PIP-13, PIP-24, pipeline.md **Claude runs**).
//!
//! So far the session pieces LOOP-7 needs (loop-runner part 2); the argv, settings and
//! results come with part 5.

/// The prompt of a run resumed after a cut-off (a crash, a kill, a limit wait).
pub const CONTINUE: &str = "Continue where you stopped.";

/// What `claude --resume` says when the session is gone.
pub const SESSION_GONE: &str = "No conversation found with session ID";

/// The run's stderr or result says its session is gone.
pub fn session_gone(text: &str) -> bool {
    text.contains(SESSION_GONE)
}

/// The prompt of a new session replacing a gone one (LOOP-7): where the work is.
pub fn fresh_context(
    branch: &str,
    pr: Option<&str>,
    intent_md: &str,
    spec_ids: &[String],
    plan_md: &str,
) -> String {
    let spec = if spec_ids.is_empty() {
        "none yet".to_string()
    } else {
        spec_ids.join(", ")
    };
    format!(
        "Your earlier session is gone; continue the work from the repo.\n\
         Branch: {branch}\n\
         PR: {}\n\
         Intent: {intent_md}\n\
         Spec IDs: {spec}\n\
         Plan: {plan_md}\n\
         Read them, check what is done with git log and git diff, then go on.",
        pr.unwrap_or("none yet")
    )
}
