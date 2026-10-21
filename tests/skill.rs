//! The `/intent` skill and its install (INT-9).

mod common;

use std::fs;
use std::process::Command;

use common::{read, root};
use yaml_rust2::YamlLoader;

#[test]
fn test_intent_skill() {
    let skill = read("skills/intent/SKILL.md");
    let front: Vec<&str> = skill.lines().skip(1).take_while(|l| *l != "---").collect();
    assert!(skill.starts_with("---\n"));
    let meta = YamlLoader::load_from_str(&front.join("\n")).unwrap();
    assert_eq!(meta[0]["name"].as_str(), Some("intent"));
    let description = meta[0]["description"].as_str().unwrap_or_default();
    assert!(
        description.contains("intent") && description.len() > 40,
        "{description}"
    );

    // The steps INT-9 names, and the template INT-2 defines.
    for must in [
        "scope",
        "success",
        "## Problem",
        "## Proposed outcome",
        "## Affected users and systems",
        "## Constraints",
        "## Open questions",
        "# Intent: ",
        "priority.md",
        "source: me",
        "started:",
        "YYMMDD-HHMM",
        "-2",
        "48",
        "docs(intents): add <id> <title>",
        "git pull --rebase",
        "main",
        "connector",
        "intents/<id>-<slug>/intent.md",
    ] {
        let lower = skill.to_lowercase();
        assert!(
            lower.contains(&must.to_lowercase()),
            "SKILL.md lacks {must:?}"
        );
    }
    assert!(skill.contains("Leave `a` out"), "a only when I give it");

    // install.sh links it into ~/.claude/skills/intent (run here with a temp HOME).
    let install = read("install.sh");
    assert!(install.contains("ln -sfn"));
    let home = tempfile::tempdir().unwrap();
    let out = Command::new("bash")
        .arg(root().join("install.sh"))
        .env("HOME", home.path())
        .env("XDG_BIN_HOME", home.path().join("bin"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let link = home.path().join(".claude/skills/intent");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::canonicalize(&link).unwrap(),
        fs::canonicalize(root().join("skills/intent")).unwrap()
    );
    assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), skill);
    // Running it again replaces the link instead of nesting one inside it.
    let again = Command::new("bash")
        .arg(root().join("install.sh"))
        .env("HOME", home.path())
        .env("XDG_BIN_HOME", home.path().join("bin"))
        .output()
        .unwrap();
    assert!(again.status.success());
    assert!(!root().join("skills/intent/intent").exists());
}
