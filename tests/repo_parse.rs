//! Parsing the repo files (REPO-1..5): `CLAUDE.md` verifying block, `REVIEW.md`, `TOWERCAB.md`.

mod common;

use common::read;
use towercab::repo::review::{DEFAULT_NIT_CAP, DEFAULT_PASSES};
use towercab::repo::towercab::{DEFAULT_TESTS, DEFAULT_TIMEOUT_MIN};
use towercab::repo::{
    Deploy, Live, Pass, Release, RepoError, Review, Rollback, Run, Towercab, Verifying, parse,
};

/// A `CLAUDE.md` whose verifying section is `section`.
fn claude(section: &str) -> String {
    format!(
        "# Repo\n\nSome prose.\n\n## Commands\n\n- `make`\n\n## Verifying your work\n\n{section}\n## After\n\nMore prose.\n"
    )
}

fn verifying(section: &str) -> Result<Verifying, RepoError> {
    Verifying::parse(&claude(section))
}

fn invalid(r: Result<Verifying, RepoError>) -> String {
    match r {
        Err(RepoError::Invalid(e)) => e,
        other => panic!("want Invalid, got {other:?}"),
    }
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

const CHECKS: &str = "```checks\ncargo test\n```\n";

#[test]
fn test_parse_repo_files() {
    let claude_md = claude(&format!(
        "Run these.\n\n```setup\ncargo fetch\n```\n\n{CHECKS}\n```run\nnpm start\nurl: http://localhost:3000\n```\n"
    ));
    let review = "# Review\n\n## Passes\n\n- **Bugs**: wrong things\n\n## Red lines\n\n- `migrations/**`: data\n";
    let towercab = "---\nmax_autonomy: 3\nprotected: [src/machine.rs]\n---\n\n```live\ndeploy: env:production\ne2e: make e2e\n```\n";
    let files = parse(Some(&claude_md), Some(review), Some(towercab)).unwrap();
    assert_eq!(files.claude_md, claude_md, "CLAUDE.md kept as written");
    assert_eq!(
        files.verifying,
        Verifying {
            setup: strings(&["cargo fetch"]),
            checks: strings(&["cargo test"]),
            run: Some(Run {
                command: "npm start".into(),
                url: "http://localhost:3000".into(),
                port: 3000,
                ui: false,
            }),
        }
    );
    assert_eq!(files.review.text, review);
    assert_eq!(
        files.review.passes,
        [Pass {
            name: "Bugs".into(),
            what: "wrong things".into()
        }]
    );
    assert_eq!(files.review.red_lines, ["`migrations/**`: data"]);
    assert_eq!(files.towercab.max_autonomy, 3);
    assert_eq!(files.towercab.protected, ["src/machine.rs"]);
    assert_eq!(
        files.towercab.live.as_ref().map(|l| &l.e2e),
        Some(&"make e2e".to_string())
    );

    // Absent REVIEW.md and TOWERCAB.md → defaults.
    let files = parse(Some(&claude_md), None, None).unwrap();
    assert_eq!(files.review, Review::default());
    assert_eq!(files.towercab, Towercab::default());

    // Every file: a leading BOM and CRLF line ends are fine.
    let crlf = format!("\u{feff}{}", claude_md.replace('\n', "\r\n"));
    let towercab_crlf = format!("\u{feff}{}", towercab.replace('\n', "\r\n"));
    let review_crlf = review.replace('\n', "\r\n");
    let files = parse(Some(&crlf), Some(&review_crlf), Some(&towercab_crlf)).unwrap();
    assert_eq!(files.verifying.checks, ["cargo test"]);
    assert_eq!(files.verifying.run.unwrap().url, "http://localhost:3000");
    assert_eq!(files.review.passes[0].what, "wrong things");
    assert_eq!(files.towercab.max_autonomy, 3);

    // CLAUDE.md, REVIEW.md, TOWERCAB.md in that order; the first error wins.
    let bad_review = "## Passes\n\n- no colon here\n";
    let bad_towercab = "---\nmax_autonomy: 9\n---\n";
    assert_eq!(
        parse(None, Some(bad_review), Some(bad_towercab)),
        Err(RepoError::NoVerifyingBlock)
    );
    assert_eq!(
        parse(Some(&claude_md), Some(bad_review), Some(bad_towercab)),
        Err(RepoError::Invalid(
            "REVIEW.md: ## Passes: want \"<name>: <what>\", got \"no colon here\"".into()
        ))
    );
    assert_eq!(
        parse(Some(&claude_md), Some(review), Some(bad_towercab)),
        Err(RepoError::Invalid(
            "TOWERCAB.md: front matter: max_autonomy must be an integer 1-5".into()
        ))
    );
    assert_eq!(
        RepoError::Invalid("REVIEW.md: x".into()).to_string(),
        "REVIEW.md: x"
    );
    assert_eq!(RepoError::Git("/c: fatal".into()).to_string(), "/c: fatal");

    // Towercab's own files (REPO-6) read as they say.
    let own = parse(
        Some(&read("CLAUDE.md")),
        Some(&read("REVIEW.md")),
        Some(&read("TOWERCAB.md")),
    )
    .unwrap();
    assert_eq!(own.verifying.setup, ["cargo fetch --locked"]);
    assert_eq!(
        own.verifying.checks,
        [
            "cargo fmt --check",
            "cargo clippy --all-targets --locked -- -D warnings",
            "cargo test --locked",
            "python3 -m unittest discover -s tests",
        ]
    );
    assert_eq!(own.verifying.run, None);
    let names: Vec<&str> = own.review.passes.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(
        names,
        DEFAULT_PASSES.map(|(n, _)| n),
        "the default passes, by name"
    );
    assert!(own.review.passes[0].what.starts_with("wrong behaviour"));
    assert_eq!(own.review.nit_cap, 5);
    assert_eq!(own.review.red_lines.len(), 2);
    assert!(own.review.red_lines[0].starts_with("`src/machine.rs`: the state machine"));
    assert!(own.review.red_lines[1].starts_with("`ops/**`"));
    assert!(
        own.review
            .important
            .unwrap()
            .starts_with("A finding is Important")
    );
    assert_eq!(own.review.do_not_report.len(), 3);
    assert_eq!(own.towercab.max_autonomy, 5);
    assert_eq!(own.towercab.protected, ["src/machine.rs", "ops/bands.yaml"]);
    assert_eq!(own.towercab.tests, ["tests/**"]);
    assert_eq!(own.towercab.live, None);
}

#[test]
fn test_towercab_front_matter() {
    let t = |text: &str| Towercab::parse(text);
    let err = |text: &str| t(text).unwrap_err();

    let got = t("---\nmax_autonomy: 2\nprotected: [src/machine.rs, \"ops/**\"]\ntests:\n  - spec/**\n  - \"**/*_spec.rb\"\n---\n\n# Notes\n").unwrap();
    assert_eq!(got.max_autonomy, 2);
    assert_eq!(got.protected, ["src/machine.rs", "ops/**"]);
    assert_eq!(got.tests, ["spec/**", "**/*_spec.rb"]);
    assert_eq!((got.live, got.release, got.rollback), (None, None, None));

    // Defaults: no file, no front matter, an empty one, absent, null or empty values.
    let defaults = Towercab::default();
    assert_eq!(defaults.max_autonomy, 5);
    assert!(defaults.protected.is_empty());
    assert_eq!(defaults.tests, DEFAULT_TESTS);
    assert_eq!(
        DEFAULT_TESTS,
        [
            "tests/**",
            "test/**",
            "**/__tests__/**",
            "**/*_test.*",
            "**/test_*.*",
            "**/*.test.*",
            "**/*.spec.*"
        ],
        "PIP-30's list"
    );
    for text in [
        "",
        "# Towercab\n\nNo front matter.\n",
        "---\n---\n",
        "---\n# just a comment\n---\nbody\n",
        "---\nprotected:\ntests: []\n---\n",
        "\u{feff}---\r\nprotected: []\r\ntests:\r\n---\r\n",
    ] {
        assert_eq!(t(text).unwrap(), defaults, "{text:?}");
    }
    // The opener and closer may carry spaces; blank lines may come first.
    for text in [
        "--- \nmax_autonomy: 2\nprotected: [x]\n---  \n",
        "\n  \n---\nmax_autonomy: 2\nprotected: [x]\n ---\n",
        "\u{feff}\r\n---\t\r\nmax_autonomy: 2\r\nprotected: [x]\r\n---\r\n",
    ] {
        let got = t(text).unwrap();
        assert_eq!(
            (got.max_autonomy, got.protected),
            (2, strings(&["x"])),
            "{text:?}"
        );
    }
    // Keys in fences or indented are prose.
    assert_eq!(
        t("# Notes\n\n```yaml\nmax_autonomy: 3\n```\n\n  protected: [x]\nmax_autonomy_note: y\n")
            .unwrap(),
        defaults
    );
    // One glob string is a one-item list.
    let got = t("---\nprotected: migrations/**\ntests: \"spec/**\"\n---\n").unwrap();
    assert_eq!(
        (got.protected, got.tests),
        (strings(&["migrations/**"]), strings(&["spec/**"]))
    );

    for (text, want) in [
        ("---\nmax_autonomy: 5\n", "front matter: no closing ---"),
        ("\n--- \nmax_autonomy: 5\n", "front matter: no closing ---"),
        // A misplaced front matter never defaults (max_autonomy 5, nothing protected).
        (
            "# Towercab\n\n---\nmax_autonomy: 1\nprotected: [secrets/**]\n---\n",
            "line 4: max_autonomy outside front matter",
        ),
        (
            "<!-- settings -->\n---\nprotected: [secrets/**]\n---\n",
            "line 3: protected outside front matter",
        ),
        (
            "---\nmax_autonomy: 2\n---\n\ntests : [spec/**]\n",
            "line 5: tests outside front matter",
        ),
        (
            "max_autonomy:1\n",
            "line 1: max_autonomy outside front matter",
        ),
        ("---\n- a\n- b\n---\n", "front matter: not a mapping"),
        (
            "---\nmax_autonomy: 5\nmodel: opus\n---\n",
            "front matter: unknown key model",
        ),
        (
            "---\nmax_autonomy: 5\nmax_autonomy: 4\n---\n",
            "front matter: max_autonomy twice",
        ),
        (
            "---\nprotected: [a]\nprotected: [b]\n---\n",
            "front matter: protected twice",
        ),
        ("---\n1: x\n---\n", "front matter: unknown key 1"),
        (
            "---\nmax_autonomy: 0\n---\n",
            "front matter: max_autonomy must be an integer 1-5",
        ),
        (
            "---\nmax_autonomy: 6\n---\n",
            "front matter: max_autonomy must be an integer 1-5",
        ),
        (
            "---\nmax_autonomy: \"3\"\n---\n",
            "front matter: max_autonomy must be an integer 1-5",
        ),
        (
            "---\nmax_autonomy:\n---\n",
            "front matter: max_autonomy must be an integer 1-5",
        ),
        (
            "---\nmax_autonomy: 2.5\n---\n",
            "front matter: max_autonomy must be an integer 1-5",
        ),
        (
            "---\nprotected: 3\n---\n",
            "front matter: protected must be a list of globs",
        ),
        (
            "---\nprotected: [a, 3]\n---\n",
            "front matter: protected must be a list of globs",
        ),
        (
            "---\ntests: {a: b}\n---\n",
            "front matter: tests must be a list of globs",
        ),
        (
            "---\nprotected: [\"../x\"]\n---\n",
            "front matter: protected: bad glob \"../x\"",
        ),
        (
            "---\nprotected: [\"\"]\n---\n",
            "front matter: protected: bad glob \"\"",
        ),
        (
            "---\ntests: \"/\"\n---\n",
            "front matter: tests: bad glob \"/\"",
        ),
        (
            "---\nprotected: [\"src/[a\"]\n---\n",
            "front matter: protected: bad glob \"src/[a\": unclosed character class; missing ']'",
        ),
    ] {
        assert_eq!(err(text), format!("TOWERCAB.md: {want}"), "{text:?}");
    }
    // A YAML error names the front matter.
    assert!(err("---\nprotected: [a\n---\n").starts_with("TOWERCAB.md: front matter: "));
}

#[test]
fn test_checks_block() {
    // Lines trimmed, blank and `#` lines dropped, order kept.
    let v = verifying(
        "Prose about checks.\n\n  ```checks\n  cargo fmt --check\n\n# lint\ncargo clippy -- -D warnings  \n cargo test\n  ```\n",
    )
    .unwrap();
    assert_eq!(
        v.checks,
        [
            "cargo fmt --check",
            "cargo clippy -- -D warnings",
            "cargo test"
        ]
    );
    // The heading matches case-insensitively and trimmed; blocks elsewhere are prose.
    let text = "```checks\nnot this\n```\n\n## verifying YOUR work  \n\n```checks\nmake test\n```\n\n## Other\n\n```checks\nnor this\n```\n";
    assert_eq!(Verifying::parse(text).unwrap().checks, ["make test"]);
    // The section ends at the next `# ` or `## ` line, not `###`; headings inside fences don't count.
    let text = "## Verifying your work\n\n### Sub\n\n```text\n## Not a heading\n```\n\n```checks\nmake\n```\n# Next\n```checks\nother\n```\n";
    assert_eq!(Verifying::parse(text).unwrap().checks, ["make"]);
    let text = "## Verifying your work\n\nNothing here.\n# Next\n\n```checks\nmake\n```\n";
    assert_eq!(Verifying::parse(text), Err(RepoError::NoVerifyingBlock));
    // An empty block is no block, so another one is fine.
    let v = verifying("```checks\n\n# nothing\n```\n\n```checks\nmake\n```\n").unwrap();
    assert_eq!(v.checks, ["make"]);

    assert_eq!(
        invalid(verifying("```checks\na\n```\n```checks\nb\n```\n")),
        "CLAUDE.md: line 14: two ```checks blocks"
    );
    assert_eq!(
        invalid(Verifying::parse(
            "## Verifying your work\n```checks\nmake\n```\n## verifying your work\n```setup\nx\n```\n"
        )),
        "CLAUDE.md: line 5: two ## Verifying your work sections"
    );
    // An unclosed fence anywhere is an error, even in prose.
    assert_eq!(
        invalid(Verifying::parse(&format!(
            "{}\n```text\nnever closed\n",
            claude(CHECKS)
        ))),
        "CLAUDE.md: line 19: unclosed ```text block"
    );
}

#[test]
fn test_setup_block() {
    let v = verifying(&format!(
        "```setup\ncargo fetch --locked\n\nnpm ci --ignore-scripts\n```\n{CHECKS}"
    ))
    .unwrap();
    assert_eq!(v.setup, ["cargo fetch --locked", "npm ci --ignore-scripts"]);
    assert_eq!(v.checks, ["cargo test"]);
    // None, or an empty one → [].
    assert!(verifying(CHECKS).unwrap().setup.is_empty());
    assert!(
        verifying(&format!("```setup\n# later\n```\n{CHECKS}"))
            .unwrap()
            .setup
            .is_empty()
    );
    // Outside the section it is prose.
    let text = format!("```setup\nnot this\n```\n{}", claude(CHECKS));
    assert!(Verifying::parse(&text).unwrap().setup.is_empty());
    assert_eq!(
        invalid(verifying(&format!(
            "```setup\na\n```\n```setup\nb\n```\n{CHECKS}"
        ))),
        "CLAUDE.md: line 14: two ```setup blocks"
    );
}

#[test]
fn test_run_block() {
    let run = |body: &str| verifying(&format!("{CHECKS}```run\n{body}\n```\n"));
    assert_eq!(
        run("url: http://localhost:8080/health\nui: true\nnpm run dev -- --port 8080")
            .unwrap()
            .run,
        Some(Run {
            command: "npm run dev -- --port 8080".into(),
            url: "http://localhost:8080/health".into(),
            port: 8080,
            ui: true,
        })
    );
    assert_eq!(
        run("cargo run -- serve\nurl:http://127.0.0.1:1\nui: false")
            .unwrap()
            .run
            .map(|r| (r.port, r.ui, r.url)),
        Some((1, false, "http://127.0.0.1:1".to_string()))
    );
    assert_eq!(
        run("make serve\nurl: http://localhost:65535")
            .unwrap()
            .run
            .unwrap()
            .port,
        65535
    );
    // No run block → None (no verifier).
    assert_eq!(verifying(CHECKS).unwrap().run, None);

    for (body, want) in [
        ("url: http://localhost:3000", "run: start command missing"),
        (
            "npm start\nnode x.js\nurl: http://localhost:3000",
            "run: one start command, got 2",
        ),
        ("npm start", "run: url must be http://localhost:<port>"),
        (
            "npm start\nurl: https://localhost:3000",
            "run: url must be http://localhost:<port>",
        ),
        (
            "npm start\nurl: http://example.com:3000",
            "run: url must be http://localhost:<port>",
        ),
        (
            "npm start\nurl: http://localhost",
            "run: url must be http://localhost:<port>",
        ),
        (
            "npm start\nurl: http://localhost:0",
            "run: url must be http://localhost:<port>",
        ),
        (
            "npm start\nurl: http://localhost:65536",
            "run: url must be http://localhost:<port>",
        ),
        (
            "npm start\nurl: http://localhost:3000x",
            "run: url must be http://localhost:<port>",
        ),
        (
            "npm start\nurl: http://localhost:3000\nurl: http://localhost:3001",
            "run: url twice",
        ),
        (
            "npm start\nurl: http://localhost:3000\nui: yes",
            "run: ui must be true or false",
        ),
        (
            "npm start\nurl: http://localhost:3000\nui: true\nui: true",
            "run: ui twice",
        ),
    ] {
        assert_eq!(invalid(run(body)), format!("CLAUDE.md: {want}"), "{body:?}");
    }
}

#[test]
fn test_live_block() {
    let t = |block: &str| Towercab::parse(&format!("# Notes\n\n```live\n{block}\n```\n"));
    assert_eq!(
        t("deploy: env:production\ntimeout: 30\ne2e: npm run e2e -- --base https://x.dev")
            .unwrap()
            .live,
        Some(Live {
            deploy: Deploy::Env("production".into()),
            timeout_min: 30,
            e2e: "npm run e2e -- --base https://x.dev".into(),
        })
    );
    // url:, spaces after the second `:`, default timeout, comments and blank lines.
    assert_eq!(
        t("# where it shows the sha\ndeploy:  url:  https://example.com/version\n\ne2e: make e2e")
            .unwrap()
            .live,
        Some(Live {
            deploy: Deploy::Url("https://example.com/version".into()),
            timeout_min: DEFAULT_TIMEOUT_MIN,
            e2e: "make e2e".into(),
        })
    );
    assert_eq!(DEFAULT_TIMEOUT_MIN, 15);
    assert_eq!(
        t("deploy: env: staging\ntimeout: 1440\ne2e: x")
            .unwrap()
            .live
            .unwrap()
            .deploy,
        Deploy::Env("staging".into())
    );
    // After front matter too; none → None (merged means done).
    let got = Towercab::parse(
        "---\nmax_autonomy: 4\n---\n\n```live\ndeploy: url:http://x.test/v\ne2e: x\n```\n",
    )
    .unwrap();
    assert_eq!(
        got.live.unwrap().deploy,
        Deploy::Url("http://x.test/v".into())
    );
    assert_eq!(Towercab::parse("# No blocks\n").unwrap().live, None);
    assert_eq!(t("").unwrap().live, None, "an empty block is no block");

    for (block, want) in [
        ("deploy: env:prod", "live: e2e is required"),
        ("e2e: make e2e", "live: deploy is required"),
        (
            "deploy: production\ne2e: x",
            "live: deploy must be env:<name> or url:<http(s) URL>",
        ),
        (
            "deploy: env:\ne2e: x",
            "live: deploy must be env:<name> or url:<http(s) URL>",
        ),
        (
            "deploy: url:ftp://x\ne2e: x",
            "live: deploy must be env:<name> or url:<http(s) URL>",
        ),
        (
            "deploy: url:https://\ne2e: x",
            "live: deploy must be env:<name> or url:<http(s) URL>",
        ),
        (
            "deploy: env:a\ntimeout: 0\ne2e: x",
            "live: timeout must be minutes 1-1440",
        ),
        (
            "deploy: env:a\ntimeout: 1441\ne2e: x",
            "live: timeout must be minutes 1-1440",
        ),
        (
            "deploy: env:a\ntimeout: 10m\ne2e: x",
            "live: timeout must be minutes 1-1440",
        ),
        ("deploy: env:a\ne2e: x\nsmoke: y", "live: unknown key smoke"),
        ("deploy: env:a\ne2e:", "live: e2e is empty"),
        ("deploy: env:a\ne2e: x\ne2e: y", "live: e2e twice"),
        (
            "deploy: env:a\nmake e2e",
            "live: want \"<key>: <value>\", got \"make e2e\"",
        ),
    ] {
        assert_eq!(
            t(block).unwrap_err(),
            format!("TOWERCAB.md: {want}"),
            "{block:?}"
        );
    }
    assert_eq!(
        Towercab::parse(
            "```live\ndeploy: env:a\ne2e: x\n```\n\n```live\ndeploy: env:b\ne2e: y\n```\n"
        )
        .unwrap_err(),
        "TOWERCAB.md: line 6: two ```live blocks"
    );
    assert_eq!(
        Towercab::parse("---\nmax_autonomy: 5\n---\n```live\ndeploy: env:a\n").unwrap_err(),
        "TOWERCAB.md: line 4: unclosed ```live block"
    );
}

#[test]
fn test_release_and_rollback_blocks() {
    let text = "```live\ndeploy: env:staging\ne2e: make e2e\n```\n\n```release\ncommand: gh workflow run deploy.yml -f env=production -f ref=<sha>\ndeploy: url:https://example.com/version\ntimeout: 60\ne2e: make e2e-prod\n```\n\n```rollback\ncommand: ./ops/rollback.sh <sha>\nrehearse: ./ops/rollback.sh --staging <sha>\n```\n";
    let got = Towercab::parse(text).unwrap();
    assert_eq!(
        got.release,
        Some(Release {
            command: "gh workflow run deploy.yml -f env=production -f ref=<sha>".into(),
            deploy: Deploy::Url("https://example.com/version".into()),
            timeout_min: 60,
            e2e: Some("make e2e-prod".into()),
        }),
        "commands kept verbatim, <sha> included"
    );
    assert_eq!(
        got.rollback,
        Some(Rollback {
            command: "./ops/rollback.sh <sha>".into(),
            rehearse: "./ops/rollback.sh --staging <sha>".into(),
        })
    );
    // `e2e` optional in release, timeout default 15.
    let got = Towercab::parse("```release\ncommand: make release\ndeploy: env:production\n```\n")
        .unwrap();
    assert_eq!(
        got.release,
        Some(Release {
            command: "make release".into(),
            deploy: Deploy::Env("production".into()),
            timeout_min: 15,
            e2e: None,
        })
    );
    // Without ```live they are kept (PIP-34 ignores them, doctor warns).
    assert_eq!(got.live, None);
    assert_eq!(Towercab::default().release, None);
    assert_eq!(Towercab::default().rollback, None);

    let err = |block: &str| Towercab::parse(block).unwrap_err();
    for (block, want) in [
        (
            "```release\ndeploy: env:p\n```\n",
            "release: command is required",
        ),
        (
            "```release\ncommand: x\n```\n",
            "release: deploy is required",
        ),
        (
            "```release\ncommand: x\ndeploy: p\n```\n",
            "release: deploy must be env:<name> or url:<http(s) URL>",
        ),
        (
            "```release\ncommand: x\ndeploy: env:p\ntimeout: -1\n```\n",
            "release: timeout must be minutes 1-1440",
        ),
        (
            "```release\ncommand: x\ndeploy: env:p\nwhen: now\n```\n",
            "release: unknown key when",
        ),
        (
            "```rollback\ncommand: x\n```\n",
            "rollback: rehearse is required",
        ),
        (
            "```rollback\nrehearse: x\n```\n",
            "rollback: command is required",
        ),
        (
            "```rollback\ncommand: x\nrehearse:\n```\n",
            "rollback: rehearse is empty",
        ),
        (
            "```rollback\ncommand: x\nrehearse: y\ncommand: z\n```\n",
            "rollback: command twice",
        ),
        (
            "```rollback\ncommand: a\nrehearse: b\n```\n```rollback\ncommand: c\nrehearse: d\n```\n",
            "line 5: two ```rollback blocks",
        ),
    ] {
        assert_eq!(err(block), format!("TOWERCAB.md: {want}"), "{block:?}");
    }
}

#[test]
fn test_review_md() {
    let text = "# Review\n\nIntro.\n\n## passes\n\n- **Bugs**: wrong behaviour,\n  unhandled errors.\n* **Security:** secrets\n+ _Spec_: rows built\n\nNot a bullet.\n\n## What IMPORTANT means here\n\nLoses data.\n\nOr merges the wrong thing.\n\n## Cap the nits\n\nShow 3 nits, then 10 more never.\n\n## Do not report\n\n- Style.\n- Docs on\n  private items.\n\n```text\n- not a bullet\n## not a section\n```\n\n## Red Lines\n\n- `migrations/**`: schema\n- auth\n\n## Other\n\n- ignored\n";
    let r = Review::parse(text).unwrap();
    assert_eq!(r.text, text);
    assert_eq!(
        r.passes,
        [
            Pass {
                name: "Bugs".into(),
                what: "wrong behaviour, unhandled errors.".into()
            },
            Pass {
                name: "Security".into(),
                what: "secrets".into()
            },
            Pass {
                name: "Spec".into(),
                what: "rows built".into()
            },
        ]
    );
    assert_eq!(
        r.important.as_deref(),
        Some("Loses data.\n\nOr merges the wrong thing.")
    );
    assert_eq!(r.nit_cap, 3, "the first number");
    assert_eq!(r.do_not_report, ["Style.", "Docs on private items."]);
    assert_eq!(r.red_lines, ["`migrations/**`: schema", "auth"]);

    let err = |text: &str| Review::parse(text).unwrap_err();
    for (text, want) in [
        (
            "## Passes\n\n- Bugs\n",
            "## Passes: want \"<name>: <what>\", got \"Bugs\"",
        ),
        (
            "## Passes\n\n- **Bugs**:\n",
            "## Passes: want \"<name>: <what>\", got \"**Bugs**:\"",
        ),
        (
            "## Passes\n\n- : what\n",
            "## Passes: want \"<name>: <what>\", got \": what\"",
        ),
        (
            "## Passes\n\n- Bugs: a\n- **bugs**: b\n",
            "## Passes: pass bugs twice",
        ),
        (
            "## Red lines\n\n- a\n\n## RED LINES\n\n- b\n",
            "line 5: two ## Red lines sections",
        ),
        (
            "## Cap the nits\n\n99999999999 nits\n",
            "## Cap the nits: 99999999999 is too large",
        ),
        ("## Passes\n\n```\n- a: b\n", "line 3: unclosed ``` block"),
    ] {
        assert_eq!(err(text), format!("REVIEW.md: {want}"), "{text:?}");
    }
}

#[test]
fn test_review_defaults() {
    let defaults = Review::default();
    assert_eq!(defaults.text, "");
    assert_eq!(
        defaults
            .passes
            .iter()
            .map(|p| (p.name.as_str(), p.what.as_str()))
            .collect::<Vec<_>>(),
        DEFAULT_PASSES
    );
    assert_eq!(
        DEFAULT_PASSES.map(|(n, _)| n),
        [
            "Bugs",
            "Security",
            "Compliance with the spec rows and `plan.md`"
        ]
    );
    assert_eq!((defaults.nit_cap, DEFAULT_NIT_CAP), (5, 5));
    assert_eq!(defaults.important, None);
    assert!(defaults.do_not_report.is_empty() && defaults.red_lines.is_empty());

    // Missing sections, a Passes section without bullets, a cap without a number.
    let text = "# Review\n\n## Passes\n\nThe usual ones.\n\n## Cap the nits\n\nA few.\n\n## What Important means here\n\n\n";
    let r = Review::parse(text).unwrap();
    assert_eq!(
        r,
        Review {
            text: text.into(),
            ..Review::default()
        }
    );
    let r = Review::parse("Just prose, no sections.\n").unwrap();
    assert_eq!(r.passes, defaults.passes);
    assert_eq!(r.nit_cap, 5);
    assert_eq!(Review::parse("## Cap the nits\n\n0\n").unwrap().nit_cap, 0);
}

#[test]
fn test_missing_verifying_block() {
    let no = RepoError::NoVerifyingBlock;
    // No CLAUDE.md, no section, no checks, an empty checks block, checks outside the section.
    assert_eq!(parse(None, None, None).unwrap_err(), no);
    for text in [
        "# Repo\n\n## Commands\n\n```checks\nmake\n```\n".to_string(),
        claude("Run the tests.\n\n```setup\nmake deps\n```\n"),
        claude("```checks\n\n# nothing yet\n```\n"),
        format!("{CHECKS}\n{}", claude("No block here.")),
    ] {
        assert_eq!(parse(Some(&text), None, None).unwrap_err(), no, "{text:?}");
        assert_eq!(Verifying::parse(&text).unwrap_err(), no);
    }
    assert_eq!(
        RepoError::NoVerifyingBlock.to_string(),
        "add CLAUDE.md verifying block"
    );
    // REVIEW.md and TOWERCAB.md are optional.
    let files = parse(Some(&claude(CHECKS)), None, None).unwrap();
    assert_eq!(files.verifying.checks, ["cargo test"]);
    assert_eq!(
        (files.review, files.towercab),
        (Review::default(), Towercab::default())
    );
}
