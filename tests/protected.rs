//! Protected paths (REPO-8): what the guard blocks and what the sandbox denies.

mod common;

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use common::write;
use towercab::repo::Protected;
use towercab::repo::protected::{CONTROL, glob};

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn protected(p: &[&str], unlock: &[&str]) -> Protected {
    Protected::new(&strings(p), &strings(unlock)).unwrap()
}

#[test]
fn test_protected_paths() {
    assert_eq!(
        CONTROL,
        [
            "CLAUDE.md",
            "REVIEW.md",
            "TOWERCAB.md",
            ".github/**",
            ".claude/**"
        ]
    );
    let p = protected(
        &[
            "src/machine.rs",
            "migrations/**",
            "db/*.sql",
            "./ops/",
            "/docs/{api,auth}/**",
            "v?.txt",
            "[ab].lock",
        ],
        &[],
    );
    for rel in [
        // Control files, wherever a path points into them.
        "CLAUDE.md",
        "REVIEW.md",
        "TOWERCAB.md",
        ".github",
        ".github/workflows/ci.yml",
        ".claude/settings.json",
        "./CLAUDE.md",
        "src//machine.rs",
        // `protected` globs; a match on a directory covers what is under it.
        "src/machine.rs",
        "migrations",
        "migrations/001.sql",
        "migrations/a/b/c.sql",
        "db/a.sql",
        "ops",
        "ops/bands.yaml",
        "docs/api/v1.md",
        "docs/auth",
        "v1.txt",
        "a.lock",
        // Absolute paths and `..` are always blocked.
        "/etc/passwd",
        "../outside",
        "src/../CLAUDE.md",
    ] {
        assert!(p.blocks(rel), "{rel} blocked");
    }
    for rel in [
        "docs/CLAUDE.md",
        "claude.md",
        "src/main.rs",
        "src/machine.rs.bak",
        "db/sub/a.sql",
        "db/a.sqlx",
        "docs/other/x.md",
        "v10.txt",
        "c.lock",
        ".githubx",
        "",
    ] {
        assert!(!p.blocks(rel), "{rel} not blocked");
    }

    // `unlock` frees what it matches (and what is under it), nothing else.
    let p = protected(
        &["migrations/**", "db/*.sql"],
        &[".github/workflows/ci.yml", "migrations/**", "**/b.sql"],
    );
    assert!(!p.blocks(".github/workflows/ci.yml"));
    assert!(p.blocks(".github/workflows/release.yml"));
    assert!(p.blocks(".github"));
    assert!(!p.blocks("migrations") && !p.blocks("migrations/x/y.sql"));
    assert!(!p.blocks("db/b.sql") && p.blocks("db/a.sql"));
    assert!(p.blocks("CLAUDE.md"));
    assert!(
        p.blocks("/abs/.github/workflows/ci.yml"),
        "absolute stays blocked"
    );

    // Globs: `*` stays in a component, `**` spans them, `P/**` also matches `P`.
    let m = glob("src/**").unwrap();
    assert!(m.is_match("src") && m.is_match("src/a") && m.is_match("src/a/b"));
    assert!(!m.is_match("srcx") && !m.is_match("x/src"));
    let m = glob("*.rs").unwrap();
    assert!(m.is_match("main.rs") && !m.is_match("src/main.rs"));
    let m = glob("**/*.rs").unwrap();
    assert!(m.is_match("main.rs") && m.is_match("src/a/main.rs"));
    let m = glob("{src,lib}/*/**").unwrap();
    assert!(m.is_match("src/a") && m.is_match("lib/a/b") && !m.is_match("src"));
    assert!(!glob("Src/**").unwrap().is_match("src/a"), "case-sensitive");
    assert!(glob("./a/b/").unwrap().is_match("a/b"));

    // `\` escapes: a literal `*`.
    let m = glob("weird/a\\*b.txt").unwrap();
    assert!(m.is_match("weird/a*b.txt") && !m.is_match("weird/axb.txt"));
    // Alternation: nested groups and empty alternates.
    let m = glob("{a,{b,c}}/x{,.bak}").unwrap();
    assert!(m.is_match("c/x") && m.is_match("a/x.bak") && !m.is_match("d/x"));
    for (g, want) in [
        ("", "bad glob \"\""),
        ("/", "bad glob \"/\""),
        ("./", "bad glob \"./\""),
        ("../x", "bad glob \"../x\""),
        ("a/../b", "bad glob \"a/../b\""),
        // Paths have no empty or `.` components: such a glob would protect nothing.
        ("a//b", "bad glob \"a//b\""),
        ("src//secrets/**", "bad glob \"src//secrets/**\""),
        ("a/./b", "bad glob \"a/./b\""),
        (".", "bad glob \".\""),
        // Shown as written, not escaped.
        ("a\\", "bad glob \"a\\\": dangling '\\'"),
        (
            "a/[b",
            "bad glob \"a/[b\": unclosed character class; missing ']'",
        ),
        (
            "{a,b",
            "bad glob \"{a,b\": unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)",
        ),
    ] {
        assert_eq!(glob(g).unwrap_err(), want, "{g:?}");
    }
    let err = |p: &[&str], u: &[&str]| Protected::new(&strings(p), &strings(u)).unwrap_err();
    assert_eq!(err(&["ok/**", "../x"], &[]), "protected: bad glob \"../x\"");
    assert_eq!(
        err(&[], &["a/[b"]),
        "unlock: bad glob \"a/[b\": unclosed character class; missing ']'"
    );
}

/// `rels` under `root`, as `deny_write` returns them.
fn abs(root: &Path, rels: &[&str]) -> Vec<PathBuf> {
    rels.iter().map(|r| root.join(r)).collect()
}

#[test]
fn test_deny_write_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("checkout");
    for rel in [
        "CLAUDE.md",
        "REVIEW.md",
        ".github/CODEOWNERS",
        ".github/ISSUE_TEMPLATE/bug.md",
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
        ".git/config",
        ".git/index.lock",
        "src/machine.rs",
        "src/main.rs",
        "db/a.sql",
        "db/b.sql",
        "db/readme.md",
        "db/sub/c.sql",
        "db/dir.sql/inner.sql",
        "migrations/001.sql",
        "Cargo.lock",
        "sub/pkg/x.lock",
        "weird/a*b.txt",
        "weird/ok.txt",
    ] {
        write(&root, rel, "x\n");
    }
    symlink("/etc/passwd", root.join("db/link.sql")).unwrap();
    symlink("../src", root.join("db/srclink")).unwrap();
    let globs = [
        "src/machine.rs",
        "migrations/**",
        "db/*.sql",
        "ops/bands.yaml",
        "**/*.lock",
        "weird/*.txt",
        "db/srclink/**",
    ];

    let got = protected(&globs, &[]).deny_write(&root);
    assert_eq!(
        got,
        abs(
            &root,
            &[
                // Literal paths and `P` for `P/**`: only existing ones (no TOWERCAB.md, .claude,
                // ops/bands.yaml).
                ".github",
                "CLAUDE.md",
                "Cargo.lock",
                "REVIEW.md",
                // Matches under the literal prefix: a matched directory not entered, a
                // symlink itself (never followed), `.git` skipped.
                "db/a.sql",
                "db/b.sql",
                "db/dir.sql",
                "db/link.sql",
                "db/srclink",
                "migrations",
                "src/machine.rs",
                "sub/pkg/x.lock",
                // `weird/a*b.txt` can't be a sandbox entry: left to the guard and publish.
                "weird/ok.txt",
            ]
        )
    );
    for p in &got {
        assert!(p.is_absolute());
        assert!(!p.to_string_lossy().contains(['*', '?', '[']), "{p:?}");
    }

    // Unlocked entries dropped; a directory an unlock glob may reach into is split, recursively.
    let got = protected(
        &globs,
        &[".github/workflows/ci.yml", "migrations/**", "db/a.sql"],
    )
    .deny_write(&root);
    assert_eq!(
        got,
        abs(
            &root,
            &[
                ".github/CODEOWNERS",
                ".github/ISSUE_TEMPLATE",
                ".github/workflows/release.yml",
                "CLAUDE.md",
                "Cargo.lock",
                "REVIEW.md",
                "db/b.sql",
                "db/dir.sql",
                "db/link.sql",
                "db/srclink",
                "src/machine.rs",
                "sub/pkg/x.lock",
                "weird/ok.txt",
            ]
        )
    );
    // An unlock glob with no literal prefix reaches into every protected directory.
    let got = protected(&["db/**"], &["**/*.md"]).deny_write(&root);
    assert_eq!(
        got,
        abs(
            &root,
            &[
                ".github/CODEOWNERS",
                ".github/workflows/ci.yml",
                ".github/workflows/release.yml",
                "db/a.sql",
                "db/b.sql",
                "db/dir.sql/inner.sql",
                "db/link.sql",
                "db/srclink",
                "db/sub/c.sql",
            ]
        )
    );
    // None inside another; duplicates once.
    let got = protected(&["src/**", "src/machine.rs", "./src/"], &[]).deny_write(&root);
    assert_eq!(
        got,
        abs(&root, &[".github", "CLAUDE.md", "REVIEW.md", "src"])
    );
    // Nothing exists → nothing to deny.
    let empty = tmp.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    assert!(protected(&globs, &[]).deny_write(&empty).is_empty());
}
