//! Towercab's own repo files (REPO-6).

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::{read, root};

/// The lines of the first fenced block opened with "```<name>".
fn fenced(text: &str, name: &str) -> Vec<String> {
    let open = format!("```{name}");
    text.lines()
        .skip_while(|l| l.trim() != open)
        .skip(1)
        .take_while(|l| l.trim() != "```")
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// `## <title>` section body (up to the next `## `).
fn section(text: &str, title: &str) -> String {
    let head = format!("## {title}");
    text.lines()
        .skip_while(|l| l.trim() != head)
        .skip(1)
        .take_while(|l| !l.starts_with("## "))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn test_own_repo_files() {
    let claude = read("CLAUDE.md");
    assert!(
        claude.lines().count() <= 60,
        "CLAUDE.md is read by every session: keep it to a page"
    );
    for heading in [
        "## Commands",
        "## Conventions",
        "## Architecture",
        "## Things Claude gets wrong here",
    ] {
        assert!(
            claude.contains(&format!("\n{heading}\n")),
            "CLAUDE.md: {heading}"
        );
    }
    let verifying = section(&claude, "Verifying your work");
    assert_eq!(fenced(&verifying, "setup"), ["cargo fetch --locked"]);
    assert_eq!(
        fenced(&verifying, "checks"),
        [
            "cargo fmt --check",
            "cargo clippy --all-targets --locked -- -D warnings",
            "cargo test --locked",
            "python3 -m unittest discover -s tests",
        ]
    );

    let review = read("REVIEW.md");
    for heading in [
        "Passes",
        "What Important means here",
        "Cap the nits",
        "Do not report",
        "Red lines",
    ] {
        assert!(
            review.contains(&format!("\n## {heading}\n")),
            "REVIEW.md: {heading}"
        );
    }
    let passes = section(&review, "Passes");
    for pass in [
        "**Bugs**",
        "**Security**",
        "**Compliance with the spec rows and `plan.md`**",
    ] {
        assert!(
            passes.lines().any(|l| l.starts_with(&format!("- {pass}"))),
            "pass {pass}"
        );
    }
    let red = section(&review, "Red lines");
    let red: Vec<&str> = red.lines().filter(|l| l.starts_with("- ")).collect();
    assert_eq!(red.len(), 2);
    assert!(red[0].starts_with("- `src/machine.rs`") && red[1].starts_with("- `ops/**`"));
    assert!(section(&review, "Cap the nits").trim().starts_with('5'));

    let towercab = read("TOWERCAB.md");
    let front: Vec<&str> = towercab
        .lines()
        .skip(1)
        .take_while(|l| *l != "---")
        .collect();
    assert!(towercab.starts_with("---\n"));
    assert_eq!(
        front,
        [
            "max_autonomy: 5",
            "protected: [src/machine.rs, ops/bands.yaml]",
            "tests: [tests/**]"
        ]
    );
    assert!(!towercab.contains("```live"), "no live block");

    // Code in src/lib.rs modules, a thin main, tests only in tests/.
    let main = read("src/main.rs");
    assert!(main.contains("towercab::cli::run("));
    assert_eq!(
        main.matches("fn ").count(),
        1,
        "main.rs only calls towercab::cli::run"
    );
    assert!(!main.contains("mod ") && !main.contains("use "));
    assert!(read("src/lib.rs").contains("pub mod cli;"));
    let mut files = Vec::new();
    rust_files(&root().join("src"), &mut files);
    for f in files {
        let text = fs::read_to_string(&f).unwrap();
        assert!(
            !text.contains("#[cfg(test)]") && !text.contains("#[test]"),
            "{}: tests go in tests/",
            f.display()
        );
    }
}
