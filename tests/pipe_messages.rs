//! PIP-16: messages are code templates (LOOP-14's), no model; each wait the pipeline writes
//! has its text pinned here.

mod common;

use common::pipe::{FakeClaude, Pipe, design, writes};
use common::world::intent_file;
use towercab::config::{Config, IntentsConfig};
use towercab::machine::{Door, Stage, Waiting};
use towercab::outbox::{Subject, render_waiting};

fn config() -> Config {
    Config::new(
        "/x/config.toml".into(),
        IntentsConfig {
            remote: Some("https://github.com/me/intents.git".into()),
            path: "/x/intents".into(),
            cutoff: 7,
        },
    )
}

/// Every `Waiting` the pipeline's handlers write, with its first line.
const PIPELINE: [(Waiting, &str); 22] = [
    (Waiting::ApproveSpec, "approve spec: approve 261001-0900"),
    (Waiting::ReviewAndMergePr, "review and merge PR"),
    (
        Waiting::AuthorizeRelease,
        "authorize release: release 261001-0900",
    ),
    (Waiting::AnswerTheQuestion, "answer the question"),
    (Waiting::CiRed, "CI red"),
    (Waiting::ChecksRed, "checks red"),
    (Waiting::TestsDontProve, "tests don't prove the change"),
    (Waiting::NoCiChecks, "no CI checks appeared"),
    (Waiting::CiStuck, "CI stuck"),
    (Waiting::WorkerTimeout, "worker timeout"),
    (Waiting::WorkerBudget, "worker budget"),
    (Waiting::NoResult, "no result"),
    (Waiting::NoChanges, "no changes"),
    (Waiting::PrStateUnknown, "PR state unknown"),
    (Waiting::MergeFailed, "merge failed"),
    (Waiting::NeverPublished, "never published"),
    (Waiting::ProtectedPathChanged, "protected path changed"),
    (Waiting::RevertedRefine, "reverted, refine"),
    (
        Waiting::E2eRedAfterYourMerge(Door::TwoWay),
        "e2e red after your merge (two-way): approve 261001-0900 to keep it, or retry --fresh 261001-0900 to fix forward",
    ),
    (Waiting::DeployNotSeen, "deploy not seen"),
    (Waiting::RevertFailed, "revert failed"),
    (Waiting::ReleaseFailed, "release failed"),
];

#[test]
fn test_telegram_templates() {
    let s = Subject {
        id: "261001-0900".into(),
        repo: "web".into(),
        title: "Add login".into(),
        slug: "login".into(),
        pr_url: Some("https://github.com/me/web/pull/7".into()),
        why: Some("3 repairs".into()),
    };
    for (w, first) in PIPELINE {
        assert_eq!(
            render_waiting(&w, &s, &config()),
            format!(
                "{first}\n261001-0900 web: Add login\n3 repairs\nPR https://github.com/me/web/pull/7\n\
                 intent https://github.com/me/intents/blob/main/intents/261001-0900-login/intent.md"
            ),
            "{w}"
        );
    }
    assert_eq!(
        render_waiting(&Waiting::ProductionE2eRed, &s, &config())
            .lines()
            .next(),
        Some("production e2e red")
    );
    // `PR closed` sends none.
    assert_eq!(render_waiting(&Waiting::PrClosed, &s, &config()), "");
    // A wait a handler returns reaches the outbox as that text, in its transition.
    let mut p = Pipe::new(
        &[intent_file(
            "261001-0900-login",
            "web",
            "a: 2\n",
            "Add login",
        )],
        &["web"],
    );
    p.claude
        .script(1, &writes("specs/web.md", "| WEB-1 | x | test_x |\n"))
        .answer(1, &FakeClaude::result(design(&["WEB-1"], &[])));
    p.gh.on("pr list *", &[("[]", "", 0)]).on(
        "pr create *",
        &[("https://github.com/me/web/pull/7\n", "", 0)],
    );
    p.step_to("261001-0900", Stage::ApprovalSpec, 3);
    let rows: Vec<_> =
        p.w.outbox()
            .into_iter()
            .filter(|r| r.1 == "approve_spec")
            .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].3,
        "approve spec: approve 261001-0900\n261001-0900 web: Add login\na2\n\
         PR https://github.com/me/web/pull/7\nintent intents/261001-0900-login/intent.md"
    );
}
