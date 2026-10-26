//! What a public repo shows (PUB-1..6): plain reads from the crate root.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::{read, root};
use regex::Regex;

const SPEC_ROW: &str = r"^\| \[([a-z_]+\.md)\]\([^)]*\) \| [A-Z]+ \| (.*) \|$";
const COPYRIGHT: &str = r"(?m)^Copyright \(c\) \d{4} \S.*$";
const SUBCOMMAND: &str = r"\btowercab ([a-z][a-z-]*)";
const LINK: &str = r"\]\(([^)\s]+)\)";
const NAME: &str = r"(?i)\bmajid\b";
const IMAGES: [&str; 7] = ["png", "jpg", "jpeg", "gif", "svg", "ico", "webp"];

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

/// The `## ` sections of a Markdown file, outside code fences: (lowercase title, body).
fn sections(md: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut fenced = false;
    for line in md.lines() {
        if line.starts_with("```") {
            fenced = !fenced;
        }
        match line.strip_prefix("## ") {
            Some(title) if !fenced => out.push((title.trim().to_lowercase(), String::new())),
            _ => {
                if let Some((_, body)) = out.last_mut() {
                    body.push_str(line);
                    body.push('\n');
                }
            }
        }
    }
    out
}

fn section(md: &str, title: &str) -> String {
    let all = sections(md);
    let found = all.into_iter().find(|(t, _)| t == title);
    found.unwrap_or_else(|| panic!("no `## {title}` section")).1
}

/// `towercab --help`, run from the test binary's own build.
fn help() -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_towercab"))
        .arg("--help")
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap()
}

/// The subcommands `towercab --help` lists.
fn subcommands() -> Vec<String> {
    let help = help();
    let lines = help.lines().skip_while(|l| *l != "Commands:").skip(1);
    lines
        .take_while(|l| l.starts_with("  "))
        .filter_map(|l| l.split_whitespace().next())
        .map(String::from)
        .collect()
}

/// `(file, removed)` for each row of the spec index in `specs/README.md`.
fn spec_index() -> Vec<(String, bool)> {
    let row = re(SPEC_ROW);
    let text = read("specs/README.md");
    let rows = text.lines().filter_map(|l| row.captures(l));
    rows.map(|c| (c[1].to_string(), c[2].starts_with("Removed")))
        .collect()
}

fn files_under(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_file() {
        out.push(path.to_path_buf());
        return;
    }
    // A broken symlink or a folder the run cannot read holds no file to check.
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for e in entries {
        files_under(&e.unwrap().path(), out);
    }
}

#[test]
fn test_license_and_security() {
    let license = read("LICENSE");
    assert_eq!(license.lines().next(), Some("MIT License"));
    assert!(
        re(COPYRIGHT).is_match(&license),
        "Copyright (c), year, holder"
    );
    assert!(license.contains("Permission is hereby granted, free of charge"));
    let cargo = read("Cargo.toml");
    assert!(cargo.lines().any(|l| l.trim() == r#"license = "MIT""#));

    let security = read("SECURITY.md");
    let lower = security.to_lowercase();
    assert!(security.contains("Security") && security.contains("Report a vulnerability"));
    assert!(lower.contains("privately") && lower.contains("public issue"));
    assert!(security.contains("latest release") && security.contains("`main`"));
}

#[test]
fn test_readme_sections() {
    let readme = read("README.md");
    let titles: Vec<String> = sections(&readme).into_iter().map(|(t, _)| t).collect();
    // The opening (before any `## `) says what Towercab is; the sections follow in order.
    let mut at = 0;
    let wanted = [
        "playbook",
        "requirements",
        "quickstart",
        "safety",
        "status",
        "docs",
    ];
    for want in wanted {
        let Some(i) = titles[at..].iter().position(|t| t == want) else {
            panic!("`## {want}` missing or out of order in {titles:?}");
        };
        at += i + 1;
    }
    let intro = readme.split("\n## ").next().unwrap().to_lowercase();
    for word in ["orchestrator", "claude code", "intents", "prs"] {
        assert!(intro.contains(word), "the opening says what it is: {word}");
    }

    let playbook = section(&readme, "playbook");
    let table_lines = playbook.lines().filter(|l| l.starts_with('|'));
    assert!(table_lines.count() >= 4, "a table of stages");
    assert!(playbook.contains("](specs/pipeline.md"));

    let requirements = section(&readme, "requirements");
    let needs = [
        "Linux",
        "systemd",
        "bwrap",
        "gh",
        "2.46",
        "Claude Code",
        "GitHub App",
    ];
    for need in needs {
        assert!(requirements.contains(need), "requirements name {need}");
    }

    let quickstart = section(&readme, "quickstart");
    assert!(quickstart.contains("ops/github-app.json"));
    let known = subcommands();
    let named: Vec<String> = re(SUBCOMMAND)
        .captures_iter(&quickstart)
        .map(|c| c[1].to_string())
        .collect();
    for must in ["migrate", "up", "ui"] {
        assert!(
            named.iter().any(|n| n == must),
            "the quickstart runs {must}"
        );
    }
    for n in &named {
        assert!(known.contains(n), "`towercab {n}` is not one of {known:?}");
    }

    let safety = section(&readme, "safety").to_lowercase();
    for word in ["sandbox", "guard", "gate", "autonomy"] {
        assert!(safety.contains(word), "safety names {word}");
    }
    let status = section(&readme, "status").to_lowercase();
    assert!(status.contains("early") && status.contains("single"));
}

#[test]
fn test_readme_not_affiliated() {
    let readme = read("README.md");
    let words: Vec<&str> = readme.split_whitespace().collect();
    let flat = words.join(" ").to_lowercase();
    assert!(flat.contains("not affiliated with or endorsed by anthropic"));
    assert!(flat.contains("playbook") && flat.contains("claude code"));
    assert!(
        !readme.contains("<img") && !readme.contains("!["),
        "no images"
    );

    let mut all = Vec::new();
    for e in fs::read_dir(root()).unwrap() {
        let path = e.unwrap().path();
        if !path.ends_with("target") && !path.ends_with(".git") {
            files_under(&path, &mut all);
        }
    }
    let is_image = |p: &&PathBuf| {
        let ext = p.extension().and_then(|x| x.to_str());
        ext.is_some_and(|x| IMAGES.contains(&x))
    };
    let images: Vec<_> = all.iter().filter(is_image).collect();
    assert!(images.is_empty(), "no image files: {images:?}");
}

#[test]
fn test_readme_docs_index() {
    let readme = read("README.md");
    let docs = section(&readme, "docs");
    let link = re(LINK);
    let in_docs: Vec<String> = link
        .captures_iter(&docs)
        .map(|c| c[1].to_string())
        .collect();
    assert!(
        in_docs.iter().any(|l| l == "specs/README.md"),
        "{in_docs:?}"
    );

    let index = spec_index();
    assert!(
        index
            .iter()
            .any(|(f, removed)| f == "pipeline.md" && !removed)
    );
    assert!(
        index
            .iter()
            .any(|(f, removed)| f == "scheduler.md" && *removed)
    );
    for (file, removed) in &index {
        let want = format!("specs/{file}");
        let listed = in_docs.iter().filter(|l| **l == want).count();
        let expect = if *removed { 0 } else { 1 };
        assert_eq!(
            listed, expect,
            "{want} (removed: {removed}) in the Docs list"
        );
    }
    // A spec on disk without a row in the index is a gap too (README and `_` files aside).
    for e in fs::read_dir(root().join("specs")).unwrap() {
        let name = e.unwrap().file_name().to_string_lossy().into_owned();
        if name.ends_with(".md") && name != "README.md" && !name.starts_with('_') {
            let indexed = index.iter().any(|(f, _)| *f == name);
            assert!(indexed, "specs/{name} is not in specs/README.md");
        }
    }

    for c in link.captures_iter(&readme) {
        let target = c[1].split('#').next().unwrap();
        if target.is_empty() || target.contains("://") || target.starts_with("mailto:") {
            continue;
        }
        assert!(
            root().join(target).exists(),
            "README links a missing file: {target}"
        );
    }
}

#[test]
fn test_no_personal_names() {
    let name = re(NAME);
    let mut files: Vec<PathBuf> = ["README.md", "Cargo.toml", "CLAUDE.md", "TOWERCAB.md"]
        .iter()
        .map(|rel| root().join(rel))
        .collect();
    for dir in ["prompts", "skills", "src", "ops", "specs"] {
        files_under(&root().join(dir), &mut files);
    }
    let mut hits = Vec::new();
    for f in &files {
        let Ok(text) = fs::read_to_string(f) else {
            continue;
        };
        for (n, line) in text.lines().enumerate() {
            if name.is_match(line) {
                let rel = f.strip_prefix(root()).unwrap();
                hits.push(format!("{}:{}", rel.display(), n + 1));
            }
        }
    }
    assert!(hits.is_empty(), "a personal name ships in: {hits:?}");
    assert!(!name.is_match(&help()), "the CLI `about` names no one");
}

#[test]
fn test_manifest_stays_private() {
    let manifest = read("ops/github-app.json");
    let m: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(m["public"], false);
    assert!(!re(r#""public"\s*:\s*true"#).is_match(&manifest));
    assert!(m["description"].as_str().unwrap().contains("the owner"));
    // What the PR ships calls nothing that changes a GitHub setting or the visibility.
    for rel in ["README.md", "SECURITY.md", "ops/github-app.json"] {
        let text = read(rel);
        assert!(
            !text.contains("gh repo edit") && !text.contains("gh api"),
            "{rel}"
        );
    }
}
