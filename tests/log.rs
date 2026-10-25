//! LOOP-21: one journal line per message; the full text of a long one in `towercab.log`.

use towercab::log;

const GH_USAGE: &str = "towercab: 0409: PR 17: unknown flag: --slurp\n\nUsage:  gh api <endpoint> [flags]\n\nFlags:\n      --cache duration   Cache the response\n  -X, --method string    The HTTP method\n";

#[test]
fn test_log_one_line() {
    assert_eq!(
        log::line(GH_USAGE),
        "towercab: 0409: PR 17: unknown flag: --slurp (+4 lines)"
    );
    assert_eq!(log::line("towercab: plain"), "towercab: plain");
    // A message that starts with usage text still says something.
    assert_eq!(log::line("Usage: x\nreal error"), "real error (+1 lines)");
    // Control characters never break the line; long ones are cut.
    assert_eq!(log::line("a\tb\u{1b}c"), "a b c");
    let long = "x".repeat(1000);
    assert_eq!(log::line(&long).chars().count(), log::MAX);
}

#[test]
fn test_log_full_text_in_file() {
    let tmp = tempfile::tempdir().unwrap();
    log::init(tmp.path());
    log::emit("towercab: short");
    log::emit(GH_USAGE);
    let text = std::fs::read_to_string(tmp.path().join("towercab.log")).unwrap();
    assert!(!text.contains("towercab: short"), "{text}");
    assert!(
        text.contains("unknown flag: --slurp\n\nUsage:  gh api"),
        "{text}"
    );
    assert!(text.starts_with("--- "), "{text}");
}
