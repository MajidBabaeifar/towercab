//! `towercab protect <repo>` (REPO-7), against a fake `gh`.

mod common;

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::FakeGh;
use serde_json::{Value, json};
use towercab::config::{Config, IntentsConfig, RepoConfig};
use towercab::repo::protect::{Target, find_ruleset, protect, ruleset};

const RULESETS: &str = "repos/me/web/rulesets?includes_parents=false&per_page=100";
const RUNS: &str = "repos/me/web/actions/runs?branch=main&event=push&status=success&per_page=1";

fn web() -> Target {
    Target {
        github: "me/web".into(),
        base: "main".into(),
        intent_home: false,
    }
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn strings(v: &[&str]) -> Vec<String> {
    args(v)
}

/// A fake `gh` answer: stdout, stderr, exit code.
type Response<'a> = (&'a str, &'a str, i32);

fn ok(out: &str) -> Response<'_> {
    (out, "", 0)
}

fn gh(fake: &FakeGh) -> &OsStr {
    fake.bin.as_os_str()
}

fn sent(fake: &FakeGh, n: usize) -> Value {
    serde_json::from_str(&fake.stdin(n)).expect("JSON on stdin")
}

/// The rules every `[repos]` ruleset starts with.
fn pull_request() -> Value {
    json!({
        "type": "pull_request",
        "parameters": {
            "required_approving_review_count": 0,
            "dismiss_stale_reviews_on_push": false,
            "require_code_owner_review": false,
            "require_last_push_approval": false,
            "required_review_thread_resolution": false
        }
    })
}

fn status_checks(checks: &[&str]) -> Value {
    let contexts: Vec<Value> = checks.iter().map(|c| json!({ "context": c })).collect();
    json!({
        "type": "required_status_checks",
        "parameters": {
            "strict_required_status_checks_policy": false,
            "required_status_checks": contexts
        }
    })
}

fn payload(base: &str, rules: Vec<Value>) -> Value {
    json!({
        "name": "towercab",
        "target": "branch",
        "enforcement": "active",
        "bypass_actors": [],
        "conditions": {"ref_name": {"include": [format!("refs/heads/{base}")], "exclude": []}},
        "rules": rules
    })
}

fn tail_rules() -> [Value; 2] {
    [
        json!({"type": "non_fast_forward"}),
        json!({"type": "deletion"}),
    ]
}

#[test]
fn test_protect_payload() {
    // The exact ruleset: PR, the checks deduplicated in order, no force push, no deletion.
    let [nff, del] = tail_rules();
    assert_eq!(
        ruleset(&web(), Some(&strings(&["rust", "python", "rust"]))),
        payload(
            "main",
            vec![
                pull_request(),
                status_checks(&["rust", "python"]),
                nff.clone(),
                del.clone()
            ]
        )
    );
    // No checks → no status-checks rule.
    let no_checks = payload("main", vec![pull_request(), nff.clone(), del.clone()]);
    assert_eq!(ruleset(&web(), None), no_checks);
    assert_eq!(ruleset(&web(), Some(&[])), no_checks);
    // The Towercab repo also requires towercab/evals, only next to other checks.
    let towercab = Target {
        github: "Me/Towercab".into(),
        base: "main".into(),
        intent_home: false,
    };
    assert_eq!(
        ruleset(&towercab, Some(&strings(&["rust", "python"]))),
        payload(
            "main",
            vec![
                pull_request(),
                status_checks(&["rust", "python", "towercab/evals"]),
                nff.clone(),
                del.clone()
            ]
        )
    );
    assert_eq!(ruleset(&towercab, None), no_checks);
    let other = Target {
        github: "me/towercab-web".into(),
        ..towercab
    };
    assert_eq!(
        ruleset(&other, Some(&strings(&["rust"])))["rules"][1],
        status_checks(&["rust"])
    );

    // The whole run: list rulesets, the last green push run's jobs, then create.
    let tmp = tempfile::tempdir().unwrap();
    let fake = FakeGh::new(
        tmp.path(),
        &[
            ok(r#"[{"id": 5, "name": "release", "target": "branch"}]"#),
            ok(r#"{"total_count": 9, "workflow_runs": [{"id": 42, "name": "CI"}]}"#),
            ok(
                r#"{"total_count": 3, "jobs": [{"name": "rust"}, {"name": "python"}, {"name": "rust"}]}"#,
            ),
            ok(r#"{"id": 7, "name": "towercab"}"#),
        ],
    );
    let out = protect(&web(), gh(&fake)).unwrap();
    assert_eq!(
        fake.calls(),
        [
            args(&["api", RULESETS]),
            args(&["api", RUNS]),
            args(&["api", "repos/me/web/actions/runs/42/jobs?per_page=100"]),
            args(&[
                "api",
                "--method",
                "POST",
                "repos/me/web/rulesets",
                "--input",
                "-"
            ]),
        ]
    );
    assert_eq!(
        sent(&fake, 4),
        ruleset(&web(), Some(&strings(&["rust", "python"])))
    );
    assert_eq!(fake.stdin(1), "", "reads send nothing");
    assert_eq!(
        out,
        "me/web: created ruleset towercab 7 on refs/heads/main\n\
         rules: pull_request, required_status_checks (rust, python), non_fast_forward, deletion"
    );

    // gh failing or printing other JSON → `gh api <path>: <stderr, or unexpected output>`.
    let cases: [(&[Response], String); 6] = [
        (
            &[("", "HTTP 403: Must have admin rights to Repository.", 1)],
            format!("gh api {RULESETS}: HTTP 403: Must have admin rights to Repository."),
        ),
        (
            &[("", "", 4)],
            format!("gh api {RULESETS}: gh exited with exit status: 4"),
        ),
        (
            &[ok("not json")],
            format!("gh api {RULESETS}: unexpected output"),
        ),
        (
            &[ok(r#"{"id": 1}"#)],
            format!("gh api {RULESETS}: unexpected output"),
        ),
        (
            &[ok("[]"), ok(r#"{"runs": []}"#)],
            format!("gh api {RUNS}: unexpected output"),
        ),
        (
            &[
                ok("[]"),
                ok(r#"{"workflow_runs": []}"#),
                ok(r#"{"message": "Validation Failed"}"#),
            ],
            "gh api repos/me/web/rulesets: unexpected output".to_string(),
        ),
    ];
    for (i, (responses, want)) in cases.iter().enumerate() {
        let dir = tmp.path().join(format!("case-{i}"));
        let fake = FakeGh::new(&dir, responses);
        assert_eq!(protect(&web(), gh(&fake)).unwrap_err(), *want, "case {i}");
    }
    // A write gh refuses → its stderr.
    let dir = tmp.path().join("refused");
    let fake = FakeGh::new(
        &dir,
        &[
            ok("[]"),
            ok(r#"{"workflow_runs": []}"#),
            ("", "HTTP 422: Invalid rule", 1),
        ],
    );
    assert_eq!(
        protect(&web(), gh(&fake)).unwrap_err(),
        "gh api repos/me/web/rulesets: HTTP 422: Invalid rule"
    );
    // No gh at all.
    let missing = tmp.path().join("no-gh");
    assert!(
        protect(&web(), missing.as_os_str())
            .unwrap_err()
            .starts_with(&format!("gh api {RULESETS}: "))
    );
}

fn config(remote: Option<&str>, repos: &[(&str, &str, &str)]) -> Config {
    Config {
        file: PathBuf::from("/c/config.toml"),
        intents: IntentsConfig {
            remote: remote.map(str::to_string),
            path: PathBuf::from("/c/intents"),
            cutoff: 7,
        },
        repos: repos
            .iter()
            .map(|(name, github, base)| {
                (
                    name.to_string(),
                    Ok(RepoConfig {
                        name: name.to_string(),
                        github: github.to_string(),
                        path: PathBuf::from("/c").join(name),
                        base: base.to_string(),
                        workers: 1,
                        bash: vec![],
                    }),
                )
            })
            .collect::<BTreeMap<_, _>>(),
    }
}

#[test]
fn test_protect_intents_repo() {
    // `intents` = the intent home, from [intents].remote; base main.
    for url in [
        "https://github.com/Me/intents.git",
        "https://github.com/Me/intents",
        "https://x-access-token:ghs_secret@github.com/Me/intents.git",
        "https://me@github.com/Me/intents",
        "git@github.com:Me/intents.git",
        "git@github.com:Me/intents",
        "ssh://git@github.com/Me/intents.git",
    ] {
        assert_eq!(
            Target::resolve(&config(Some(url), &[]), "intents"),
            Ok(Target {
                github: "Me/intents".into(),
                base: "main".into(),
                intent_home: true,
            }),
            "{url}"
        );
    }
    for url in [
        Some("https://gitlab.com/Me/intents.git"),
        Some("https://ghs_secret@github.com/Me"),
        Some("https://github.com/Me/intents/extra"),
        Some("/srv/git/intents.git"),
        Some("git@github.com:-x/intents.git"),
        None,
    ] {
        let err = Target::resolve(&config(url, &[]), "intents").unwrap_err();
        assert_eq!(err, "[intents].remote is not a GitHub repo URL", "{url:?}");
        assert!(!err.contains("secret"), "the URL is never echoed");
    }
    // A [repos] name: its github and base; anything else is unknown.
    let c = config(None, &[("web", "me/web", "release/2.x")]);
    assert_eq!(
        Target::resolve(&c, "web"),
        Ok(Target {
            github: "me/web".into(),
            base: "release/2.x".into(),
            intent_home: false,
        })
    );
    assert_eq!(Target::resolve(&c, "nope"), Err("unknown repo nope".into()));

    // Only non_fast_forward and deletion, no run lookup: Towercab pushes there directly.
    let home = Target::resolve(
        &config(Some("git@github.com:Me/intents.git"), &[]),
        "intents",
    )
    .unwrap();
    let [nff, del] = tail_rules();
    assert_eq!(
        ruleset(&home, Some(&strings(&["rust"]))),
        payload("main", vec![nff, del])
    );
    let tmp = tempfile::tempdir().unwrap();
    let fake = FakeGh::new(tmp.path(), &[ok("[]"), ok(r#"{"id": 11}"#)]);
    let out = protect(&home, gh(&fake)).unwrap();
    assert_eq!(
        fake.calls(),
        [
            args(&[
                "api",
                "repos/Me/intents/rulesets?includes_parents=false&per_page=100"
            ]),
            args(&[
                "api",
                "--method",
                "POST",
                "repos/Me/intents/rulesets",
                "--input",
                "-"
            ]),
        ]
    );
    assert_eq!(sent(&fake, 2), ruleset(&home, None));
    assert_eq!(
        out,
        "Me/intents: created ruleset towercab 11 on refs/heads/main\nrules: non_fast_forward, deletion"
    );
}

#[test]
fn test_protect_updates_existing() {
    let tmp = tempfile::tempdir().unwrap();
    let towercab = Target {
        github: "me/towercab".into(),
        base: "main".into(),
        intent_home: false,
    };
    let list = r#"[{"id": 3, "name": "towercab-old"}, {"id": 99, "name": "towercab", "source_type": "Repository"}]"#;
    let fake = FakeGh::new(
        tmp.path(),
        &[
            ok(list),
            ok(r#"{"workflow_runs": [{"id": 8}]}"#),
            ok(r#"{"jobs": [{"name": "rust"}, {"name": "python"}]}"#),
            ok(r#"{"id": 99, "name": "towercab"}"#),
        ],
    );
    let out = protect(&towercab, gh(&fake)).unwrap();
    let calls = fake.calls();
    assert_eq!(
        calls[3],
        args(&[
            "api",
            "--method",
            "PUT",
            "repos/me/towercab/rulesets/99",
            "--input",
            "-"
        ]),
        "PUT the existing one, never a second ruleset"
    );
    assert_eq!(calls.len(), 4);
    assert_eq!(
        sent(&fake, 4),
        ruleset(&towercab, Some(&strings(&["rust", "python"])))
    );
    assert_eq!(
        out,
        "me/towercab: updated ruleset towercab 99 on refs/heads/main\n\
         rules: pull_request, required_status_checks (rust, python, towercab/evals), non_fast_forward, deletion"
    );

    // find_ruleset (for doctor later): the id by name, or none.
    let fake = FakeGh::new(&tmp.path().join("find"), &[ok(list), ok("[]")]);
    assert_eq!(find_ruleset(gh(&fake), "me/towercab"), Ok(Some(99)));
    assert_eq!(find_ruleset(gh(&fake), "me/towercab"), Ok(None));
    let fake = FakeGh::new(
        &tmp.path().join("bad"),
        &[ok(r#"[{"id": "x", "name": "towercab"}]"#)],
    );
    assert_eq!(
        find_ruleset(gh(&fake), "me/towercab"),
        Err(
            "gh api repos/me/towercab/rulesets?includes_parents=false&per_page=100: unexpected output"
                .into()
        )
    );
}

#[test]
fn test_protect_no_green_run() {
    let tmp = tempfile::tempdir().unwrap();
    let target = Target {
        github: "me/towercab".into(),
        base: "release/2.x".into(),
        intent_home: false,
    };
    let fake = FakeGh::new(
        tmp.path(),
        &[
            ok("[]"),
            ok(r#"{"total_count": 0, "workflow_runs": []}"#),
            ok(r#"{"id": 12}"#),
        ],
    );
    let out = protect(&target, gh(&fake)).unwrap();
    let calls = fake.calls();
    assert_eq!(
        calls[1],
        args(&[
            "api",
            "repos/me/towercab/actions/runs?branch=release/2.x&event=push&status=success&per_page=1"
        ])
    );
    assert_eq!(calls.len(), 3, "no jobs lookup");
    let [nff, del] = tail_rules();
    assert_eq!(
        sent(&fake, 3),
        payload("release/2.x", vec![pull_request(), nff, del]),
        "no status-checks rule, no towercab/evals alone"
    );
    assert_eq!(
        out,
        "me/towercab: created ruleset towercab 12 on refs/heads/release/2.x\n\
         rules: pull_request, non_fast_forward, deletion\n\
         no green run on release/2.x: no required status checks"
    );
}

fn towercab_bin(cfg: &Path, path: &Path, args: &[&str]) -> std::process::Output {
    let mut p = std::ffi::OsString::from(path);
    p.push(":");
    p.push(std::env::var_os("PATH").unwrap_or_default());
    Command::new(env!("CARGO_BIN_EXE_towercab"))
        .arg("--config")
        .arg(cfg)
        .args(args)
        .env("PATH", p)
        .env_remove("TOWERCAB_CONFIG")
        .output()
        .unwrap()
}

#[test]
fn test_protect_command() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = tmp.path().join("config.toml");
    std::fs::write(
        &cfg,
        "[intents]\nremote = \"git@github.com:me/intents.git\"\n\n[repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n",
    )
    .unwrap();
    // `gh` from PATH; nothing Towercab holds.
    let fake = FakeGh::new(
        &tmp.path().join("gh"),
        &[
            ok("[]"),
            ok(r#"{"workflow_runs": [{"id": 1}]}"#),
            ok(r#"{"jobs": [{"name": "test"}]}"#),
            ok(r#"{"id": 5}"#),
        ],
    );
    let bin_dir = fake.bin.parent().unwrap();
    let out = towercab_bin(&cfg, bin_dir, &["protect", "web"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "me/web: created ruleset towercab 5 on refs/heads/main\n\
         rules: pull_request, required_status_checks (test), non_fast_forward, deletion\n"
    );
    assert_eq!(fake.calls().len(), 4);

    let fail = |args: &[&str]| {
        let out = towercab_bin(&cfg, bin_dir, args);
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        String::from_utf8_lossy(&out.stderr).into_owned()
    };
    assert_eq!(fail(&["protect", "nope"]), "towercab: unknown repo nope\n");
    // gh has no 5th response: its failure is reported.
    assert_eq!(
        fail(&["protect", "intents"]),
        "towercab: gh api repos/me/intents/rulesets?includes_parents=false&per_page=100: fake gh: unexpected call 5\n"
    );
    // The Python version's `[repos.<name>]` (no `github`) fails only `protect <name>`.
    std::fs::write(
        &cfg,
        "[intents]\nremote = \"git@github.com:me/intents.git\"\n\n[repos.web]\npath = \"/srv/web\"\n\
         verify = [\"make test\"]\nbash = [\"make *\"]\n",
    )
    .unwrap();
    assert_eq!(
        fail(&["protect", "web"]),
        format!(
            "towercab: config: {}: repos.web.github is required\n",
            cfg.display()
        )
    );
    let fake = FakeGh::new(&tmp.path().join("gh2"), &[ok("[]"), ok(r#"{"id": 6}"#)]);
    let out = towercab_bin(&cfg, fake.bin.parent().unwrap(), &["protect", "intents"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "me/intents: created ruleset towercab 6 on refs/heads/main\nrules: non_fast_forward, deletion\n"
    );
    let out = towercab_bin(&cfg, bin_dir, &["protect"]);
    assert_eq!(out.status.code(), Some(2), "a missing argument");
}
