//! The guard and the test lock (PIP-29, PIP-31): the worker's `PreToolUse` hook and its
//! `denyWrite`, publish's refusals, `unlock`.

mod common;

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::json;
use towercab::autonomy::{self, Ci, Gate, GateIn, Hold, PrKind, Review};
use towercab::machine::Door;
use towercab::pipeline::guard::{self, Rules};

/// The hook's input for `tool` on `path`.
fn input(tool: &str, path: &str) -> String {
    let key = if tool == "NotebookEdit" {
        "notebook_path"
    } else {
        "file_path"
    };
    json!({"tool_name": tool, "tool_input": {key: path, "content": "x"}}).to_string()
}

#[test]
fn test_unlock_goes_to_me() {
    // An intent with `unlock` always goes to me at the gate, even approved at a5.
    let review = Review {
        approved: true,
        door: Door::TwoWay,
        red_lines: false,
    };
    let g = |unlock: bool| {
        autonomy::gate(&GateIn {
            kind: PrKind::Intent,
            frozen: false,
            cap: 5,
            a: Some(5),
            ci: Ci::Green,
            unlock,
            evals_red: false,
            review: Some(review),
        })
    };
    assert_eq!(g(true), Gate::Approval(Hold::Unlock));
    assert_eq!(g(false), Gate::Merge);
    // What it unlocks the guard lets through; the rest of the protected paths stay.
    let rules = Rules {
        checkout: PathBuf::from("/w/c"),
        protected: vec!["CLAUDE.md".into(), "docs/**".into()],
        unlock: vec!["docs/**".into()],
        locked: Vec::new(),
    };
    assert_eq!(guard::decide(&rules, "docs/a.md"), Ok(()));
    assert!(guard::decide(&rules, "CLAUDE.md").is_err());
}

/// `towercab hook guard <rules>` with `stdin` → (exit code, stderr).
fn hook_cli(args: &[&str], stdin: &str) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_towercab"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn test_guard_hook_cli() {
    let tmp = tempfile::tempdir().unwrap();
    let checkout = tmp.path().join("work/c");
    fs::create_dir_all(checkout.join("src")).unwrap();
    let runs = tmp.path().join("runs");
    fs::create_dir_all(&runs).unwrap();
    let rules = Rules {
        checkout: checkout.clone(),
        protected: vec!["CLAUDE.md".into(), ".github/**".into()],
        unlock: Vec::new(),
        locked: vec!["tests/a_test.rs".into()],
    };
    let file = runs.join("guard.json");
    fs::write(&file, rules.to_json().to_string()).unwrap();
    let f = file.to_str().unwrap();
    let c = checkout.display();
    // Allowed → 0, nothing said.
    assert_eq!(
        hook_cli(
            &["hook", "guard", f],
            &input("Write", &format!("{c}/src/a.rs"))
        ),
        (Some(0), String::new())
    );
    // Blocked → 2, the reason on stderr (Claude Code shows it to the worker).
    assert_eq!(
        hook_cli(
            &["hook", "guard", f],
            &input("Edit", &format!("{c}/CLAUDE.md"))
        ),
        (
            Some(2),
            "CLAUDE.md is protected: changes here go through Majid\n".into()
        )
    );
    let (code, err) = hook_cli(
        &["hook", "guard", f],
        &input("Edit", &format!("{c}/tests/a_test.rs")),
    );
    assert_eq!(code, Some(2));
    assert!(err.contains("locked in repair rounds"), "{err}");
    // Fails closed: bad input, a missing rules file, no rules argument.
    assert_eq!(hook_cli(&["hook", "guard", f], "{").0, Some(2));
    let (code, err) = hook_cli(
        &["hook", "guard", "/nonexistent/guard.json"],
        &input("Write", &format!("{c}/src/a.rs")),
    );
    assert_eq!(code, Some(2));
    assert!(err.starts_with("guard: "), "{err}");
    assert_eq!(hook_cli(&["hook", "guard"], "").0, Some(2));
    assert_eq!(
        fs::read_to_string(runs.join("guard-blocks.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}
