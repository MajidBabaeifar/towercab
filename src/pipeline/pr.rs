//! PR reads in a step (PIP-21): the loop's reads raise the events (`events::pr_events`, LOOP-18);
//! the rounds they start read the PR again here for what to tell the worker, and the merge step
//! reads it for my unhandled feedback (PIP-22).

use crate::env::Fault;
use crate::events::{GhPrs, PrSource, PrState, new_feedback};
use crate::github::GhError;
use crate::handler::{Ctx, StepError};
use crate::mission::Mission;

use super::gh;

/// `[github].me` (empty: none).
pub fn me(cx: &Ctx<'_>) -> String {
    cx.config
        .github
        .as_ref()
        .and_then(|g| g.me.clone())
        .unwrap_or_default()
}

/// The mission's PR as `events::GhPrs` reads it (as the App): `gh pr view --json
/// state,mergedAt,mergeCommit,headRefOid,mergeable,comments,reviews` + the review comments.
pub fn read(cx: &Ctx<'_>, m: &Mission, pr: u64) -> Result<PrState, StepError> {
    let github = gh::github(cx, m)?;
    let mut prs = GhPrs {
        identity: cx.identity.clone(),
    };
    prs.read(&github, pr).map_err(|e| match e {
        GhError::Env(e) => StepError::Env(Fault::Github, e),
        GhError::Failed(e) if gh::throttled(&e) => StepError::Env(Fault::Github, e),
        GhError::Failed(e) => StepError::Bug(e),
    })
}

/// My comments and reviews with text newer than `feedback_seen` (Towercab's own and other
/// authors' never count), as data lines `- <author> at <time>: <text>` (none: `(none)`), and the
/// newest one's time for `feedback_seen`.
pub fn feedback_text(pr: &PrState, m: &Mission, me: &str) -> (String, Option<String>) {
    let new = new_feedback(m, pr, me);
    let text = new
        .iter()
        .map(|c| format!("- {} at {}: {}", c.author, c.at, c.body.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let seen = new.iter().map(|c| c.at.clone()).max();
    (
        if text.is_empty() {
            "(none)".into()
        } else {
            text
        },
        seen,
    )
}
