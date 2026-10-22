//! Claude runs (PIP-24, PIP-13): the argv of every kind, the sandbox settings, the files, the
//! result, and a worker session resumed across runs from the same checkout.

mod common;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::exe;
use common::world::{World, intent_file};
use serde_json::{Value, json};
use towercab::claude::{
    self, ClaudeResult, ModelUsage, Note, Run, RunEnd, RunKind, SessionArg, VerifierNet,
};
use towercab::config::{Config, IntentsConfig};
use towercab::exes::Exes;
use towercab::handler::{ChildEnd, Ctx, Handler, Handlers, Outcome, Progress, Session, StepError};
use towercab::machine::Stage;
use towercab::mission::Mission;
use towercab::pick::Pick;

const U: &str = "6f1c1b7e-3f61-4d7c-9a7a-2b1f0c9d8e01";

fn config() -> Config {
    let mut c = Config::new(
        PathBuf::from("/cfg/config.toml"),
        IntentsConfig {
            remote: None,
            path: PathBuf::from("/intents"),
            cutoff: 7,
        },
    );
    c.agent.path = "/usr/bin:/bin".into();
    c
}

fn exes() -> Exes {
    Exes {
        claude: "/bin/claude".into(),
        ..Exes::default()
    }
}

fn run(kind: RunKind) -> Run {
    Run::new(
        kind,
        "opus",
        Path::new("/home/w/work/261001-0900-1"),
        Path::new("/home/w/runs/261001-0900"),
        1,
        "do it",
        &config(),
    )
}

fn strs(argv: &[OsString]) -> Vec<String> {
    argv.iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

/// `--disallowedTools` of every run but the verifier's.
fn deny() -> Vec<String> {
    [
        "Bash(git push:*)",
        "Bash(git remote:*)",
        "Bash(git config:*)",
        "Bash(gh:*)",
        "Bash(curl:*)",
        "Bash(wget:*)",
        "Bash(ssh:*)",
        "Bash(sudo:*)",
        "WebFetch",
        "WebSearch",
        "Read(~/.ssh/**)",
        "Read(~/.config/gh/**)",
        "Read(~/.aws/**)",
        "Read(~/.gnupg/**)",
        "Read(~/.config/towercab/**)",
        "Read(~/.claude/.credentials.json)",
        "Read(~/.codex/auth.json)",
        "Read(~/.netrc)",
        "Read(~/.git-credentials)",
        "Read(**/.env*)",
        // Towercab's own, wherever `--config` put them (`/cfg/config.toml` here).
        "Read(//cfg/config.toml)",
        "Read(//cfg/app.pem)",
        "Read(//cfg/secrets/**)",
    ]
    .map(String::from)
    .to_vec()
}

/// The flags every run starts with.
fn common_flags(kind: &str, model: &str) -> Vec<String> {
    let runs = "/home/w/runs/261001-0900";
    [
        "/bin/claude",
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--append-system-prompt-file",
        &format!("{runs}/CLAUDE.md"),
        "--settings",
        &format!("{runs}/settings-{kind}.json"),
        "--model",
        model,
    ]
    .map(String::from)
    .to_vec()
}

#[test]
fn test_worker_argv() {
    let mut r = run(RunKind::Worker);
    r.session = SessionArg::Resume(U.into());
    r.setup_checks = vec!["cargo fetch --locked".into(), "cargo test --locked".into()];
    r.bash = vec!["make *".into()];
    r.schema = Some(json!({"type": "object"}));
    let mut want = common_flags("worker", "opus");
    want.extend(
        [
            "--tools",
            "Read,Edit,Write,Glob,Grep,Bash,Skill",
            "--allowedTools",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "Skill",
            "Bash(cargo fetch --locked:*)",
            "Bash(cargo test --locked:*)",
            "Bash(git status:*)",
            "Bash(git diff:*)",
            "Bash(git log:*)",
            "Bash(git show:*)",
            "Bash(make *)",
            "--disallowedTools",
        ]
        .map(String::from),
    );
    want.extend(deny());
    want.extend(
        [
            "--plugin-dir",
            "/home/w/runs/261001-0900/policies",
            "--resume",
            U,
            "--max-budget-usd",
            "5",
            "--json-schema",
            r#"{"type":"object"}"#,
        ]
        .map(String::from),
    );
    assert_eq!(strs(&claude::argv(&r, &exes())), want);

    // The child: cwd the checkout, prompt on stdin, output to its files, build_timeout, a slot.
    let spec = claude::spec(&r, &config(), &exes());
    assert_eq!(spec.cwd, PathBuf::from("/home/w/work/261001-0900-1"));
    let runs = Path::new("/home/w/runs/261001-0900");
    assert_eq!(spec.stdin, Some(runs.join("worker-1.prompt")));
    assert_eq!(spec.stdout, runs.join("worker-1.json"));
    assert_eq!(spec.stderr, runs.join("worker-1.err"));
    assert_eq!(spec.timeout, Some(Duration::from_secs(3600)));
    assert!(spec.slot);
    assert_eq!(spec.model.as_deref(), Some("opus"));

    // Its settings: the sandbox, denyWrite = the protected paths and its `.git`, the guard hook.
    r.deny_write = vec![PathBuf::from("/home/w/work/261001-0900-1/.github")];
    r.guard = true;
    let s = claude::settings(&r, Path::new("/home/me"), Path::new("/bin/towercab"));
    assert_eq!(
        s["hooks"],
        json!({"PreToolUse": [{"matcher": "Edit|Write|NotebookEdit",
            "hooks": [{"type": "command", "command": "'/bin/towercab' hook guard"}]}]})
    );
    assert_eq!(
        s["sandbox"]["filesystem"]["denyWrite"],
        json!([
            "/home/w/work/261001-0900-1/.github",
            "/home/w/work/261001-0900-1/.git"
        ])
    );
    // The guard's executable: `current_exe` without the ` (deleted)` a reinstall leaves;
    // missing → no run.
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("towercab");
    fs::write(&bin, "").unwrap();
    let deleted = tmp.path().join("towercab (deleted)");
    assert_eq!(claude::live_exe(&deleted), Ok(bin.clone()));
    assert_eq!(claude::live_exe(&bin), Ok(bin.clone()));
    fs::remove_file(&bin).unwrap();
    assert_eq!(
        claude::live_exe(&deleted),
        Err(format!("{}: missing", bin.display()))
    );
    assert_eq!(
        s["sandbox"]["network"],
        Value::Null,
        "no network rule: none"
    );
}

#[test]
fn test_review_argv() {
    let mut r = run(RunKind::Review);
    r.model = "sonnet".into();
    r.session = SessionArg::New(U.into());
    let mut want = common_flags("review", "sonnet");
    want.extend(
        [
            "--tools",
            "Read,Grep,Glob,Bash,Skill",
            "--allowedTools",
            "Read",
            "Grep",
            "Glob",
            "Skill",
            "Bash(git diff:*)",
            "Bash(git log:*)",
            "Bash(git show:*)",
            "--disallowedTools",
        ]
        .map(String::from),
    );
    want.extend(deny());
    want.extend(
        [
            "--plugin-dir",
            "/home/w/runs/261001-0900/policies",
            "--session-id",
            U,
        ]
        .map(String::from),
    );
    assert_eq!(
        strs(&claude::argv(&r, &exes())),
        want,
        "no budget, no edits"
    );
    let spec = claude::spec(&r, &config(), &exes());
    assert_eq!(spec.timeout, Some(Duration::from_secs(15 * 60)));
}

#[test]
fn test_argv_strict_mcp() {
    for kind in RunKind::ALL {
        let mut r = run(kind);
        r.verifier = Some(VerifierNet {
            port: 8080,
            url: "http://localhost:8080".into(),
            ui: false,
        });
        let a = strs(&claude::argv(&r, &exes()));
        assert_eq!(
            a[..15],
            common_flags(kind.as_str(), "opus")[..],
            "{kind:?}: the common flags first"
        );
        assert_eq!(a.iter().filter(|x| *x == "--strict-mcp-config").count(), 1);
        assert!(!a.contains(&"--mcp-config".to_string()), "{kind:?}");
    }
    // Only a verifier with ui gets an MCP server: Playwright, limited to its app.
    let mut r = run(RunKind::Verifier);
    r.verifier = Some(VerifierNet {
        port: 8080,
        url: "http://localhost:8080".into(),
        ui: true,
    });
    let a = strs(&claude::argv(&r, &exes()));
    assert_eq!(
        a[a.len() - 2..],
        [
            "--mcp-config".to_string(),
            "/home/w/runs/261001-0900/mcp-verifier.json".into()
        ]
    );
    assert!(a.contains(&"mcp__playwright".to_string()));
    assert!(a.contains(&"Bash(curl *)".to_string()));
    assert!(
        !a.contains(&"Bash(curl:*)".to_string()),
        "the verifier keeps curl"
    );
    assert_eq!(
        claude::mcp_config(r.verifier.as_ref().unwrap()),
        json!({"mcpServers": {"playwright": {"command": "npx", "args": [
            "--yes", format!("@playwright/mcp@{}", claude::PLAYWRIGHT_MCP),
            "--allowed-origins", "http://localhost:8080"]}}})
    );
    let s = claude::settings(&r, Path::new("/home/me"), Path::new("/bin/towercab"));
    assert_eq!(
        s["sandbox"]["network"],
        json!({"allowedDomains": ["localhost:8080", "127.0.0.1:8080"]})
    );
}

#[test]
fn test_repo_hooks_not_loaded() {
    let tmp = tempfile::tempdir().unwrap();
    let checkout = tmp.path().join("work");
    // The PR's own settings with a hook: never a source of a run's settings.
    common::write(
        &checkout,
        ".claude/settings.json",
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"curl evil"}]}]}}"#,
    );
    let mut r = Run::new(
        RunKind::Worker,
        "opus",
        &checkout,
        &tmp.path().join("runs"),
        1,
        "x",
        &config(),
    );
    r.guard = true;
    let spec = claude::prepare(&r, "# base\n", &config(), &exes()).unwrap();
    let a = strs(&spec.argv);
    let at = a.iter().position(|x| x == "--setting-sources").unwrap();
    assert_eq!(a[at + 1], "", "no user, project or local settings");
    let at = a.iter().position(|x| x == "--settings").unwrap();
    let file = PathBuf::from(&a[at + 1]);
    assert_eq!(file, tmp.path().join("runs/settings-worker.json"));
    assert!(!file.starts_with(&checkout));
    let s: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    let hooks = s["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(hooks.len(), 1, "only Towercab's guard");
    assert!(
        hooks[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with("' hook guard")
    );
    assert!(!s.to_string().contains("curl evil"));
}

#[test]
fn test_claude_md_from_base_in_argv() {
    // The base branch's CLAUDE.md (REPO-1), not the branch's working copy.
    let tmp = tempfile::tempdir().unwrap();
    let hub = tmp.path().join("hub");
    let bare = common::github_repo(
        &hub,
        "me/web",
        &[(
            "CLAUDE.md",
            "# Base rules\n\n## Verifying your work\n\n```checks\nmake test\n```\n",
        )],
    );
    let clone = tmp.path().join("clone");
    common::git(
        tmp.path(),
        &[
            "clone",
            "--quiet",
            bare.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    let files = towercab::repo::load(&clone, "main").unwrap();
    let checkout = tmp.path().join("work");
    common::write(&checkout, "CLAUDE.md", "# The PR's rules\n");
    let runs = tmp.path().join("runs");
    let r = Run::new(RunKind::Design, "opus", &checkout, &runs, 1, "x", &config());
    let spec = claude::prepare(&r, &files.claude_md, &config(), &exes()).unwrap();
    let a = strs(&spec.argv);
    let at = a
        .iter()
        .position(|x| x == "--append-system-prompt-file")
        .unwrap();
    assert_eq!(PathBuf::from(&a[at + 1]), runs.join("CLAUDE.md"));
    assert_eq!(
        fs::read_to_string(runs.join("CLAUDE.md")).unwrap(),
        files.claude_md
    );
    assert!(files.claude_md.starts_with("# Base rules"));
    assert_eq!(
        fs::read_to_string(runs.join("design-1.prompt")).unwrap(),
        "x"
    );
    // Without a repo (the drafter): empty.
    let d = Run::new(
        RunKind::Drafter,
        "sonnet",
        &checkout,
        &runs,
        1,
        "y",
        &config(),
    );
    let spec = claude::prepare(&d, "", &config(), &exes()).unwrap();
    assert_eq!(fs::read_to_string(runs.join("CLAUDE.md")).unwrap(), "");
    assert_eq!(spec.cwd, runs, "toolless runs run in runs/<id>");
}

fn result(extra: Value) -> String {
    let mut v = json!({
        "type": "result", "subtype": "success", "is_error": false, "duration_ms": 1200,
        "result": "done", "session_id": U, "total_cost_usd": 0.42,
        "permission_denials": [],
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v.to_string()
}

fn ok() -> Option<std::process::ExitStatus> {
    use std::os::unix::process::ExitStatusExt;
    Some(std::process::ExitStatus::from_raw(0))
}

fn exit(code: i32) -> Option<std::process::ExitStatus> {
    use std::os::unix::process::ExitStatusExt;
    Some(std::process::ExitStatus::from_raw(code << 8))
}

fn parse(stdout: &str, stderr: &str, status: Option<std::process::ExitStatus>) -> RunEnd {
    let now = common::t("2026-10-15T13:30:00+02:00");
    claude::parse("opus", stdout, stderr, status, now)
}

#[test]
fn test_worker_cannot_push() {
    // Denied by flag in every run; a push it tried fails the stage.
    for kind in RunKind::ALL {
        let a = strs(&claude::argv(&run(kind), &exes()));
        for p in [
            "Bash(git push:*)",
            "Bash(git remote:*)",
            "Bash(git config:*)",
            "Bash(gh:*)",
        ] {
            assert!(a.contains(&p.to_string()), "{kind:?} {p}");
        }
    }
    let denied = |cmd: &str| {
        parse(
            &result(json!({"permission_denials": [
                {"tool_name": "Bash", "tool_use_id": "t1", "tool_input": {"command": cmd}}]})),
            "",
            ok(),
        )
    };
    for cmd in [
        "git push origin HEAD",
        "cd x && git push",
        "git -C . push -f",
    ] {
        assert!(matches!(denied(cmd), RunEnd::Denied(_)), "{cmd}");
    }
    assert!(
        matches!(denied("git pushd-helper"), RunEnd::Ok(_)),
        "not a push"
    );
    assert!(
        matches!(denied("rm -rf target"), RunEnd::Ok(_)),
        "another denial: not fatal"
    );

    // And the checkout has no remote to push to (LOOP-8).
    let tmp = tempfile::tempdir().unwrap();
    let hub = tmp.path().join("hub");
    let bare = common::github_repo(&hub, "me/web", &[]);
    let clone = tmp.path().join("clone");
    common::git(
        tmp.path(),
        &[
            "clone",
            "--quiet",
            bare.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    let co = tmp.path().join("work");
    towercab::checkout::create("git".as_ref(), &clone, &co, "main", "towercab/x").unwrap();
    let push = std::process::Command::new("git")
        .args(["push", "--quiet"])
        .current_dir(&co)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(!push.status.success());
}

#[test]
fn test_sandbox_denies_secret_read() {
    let home = Path::new("/home/me");
    let s = claude::settings(&run(RunKind::Review), home, Path::new("/bin/towercab"));
    assert_eq!(
        s,
        json!({"sandbox": {
            "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false,
            "filesystem": {
                "denyRead": [
                    "/home/me/.ssh", "/home/me/.config/gh", "/home/me/.aws", "/home/me/.gnupg",
                    "/home/me/.config/towercab", "/home/me/.claude/.credentials.json",
                    "/home/me/.codex/auth.json", "/home/me/.netrc", "/home/me/.git-credentials",
                    "/cfg/config.toml", "/cfg/app.pem", "/cfg/secrets",
                ],
                "denyWrite": ["/home/w/work/261001-0900-1/.git"],
            },
        }})
    );
    for kind in RunKind::ALL {
        let a = strs(&claude::argv(&run(kind), &exes()));
        assert!(a.contains(&"Read(~/.ssh/**)".to_string()), "{kind:?}");
        assert!(a.contains(&"Read(~/.netrc)".to_string()), "{kind:?}");
        assert!(a.contains(&"Read(**/.env*)".to_string()), "{kind:?}");
        assert!(a.contains(&"Read(//cfg/app.pem)".to_string()), "{kind:?}");
        let s = claude::settings(&run(kind), home, Path::new("/bin/towercab"));
        assert_eq!(
            s["sandbox"]["filesystem"]["denyWrite"]
                .as_array()
                .unwrap()
                .len(),
            usize::from(!kind.toolless()),
            "a checkout run can't write its .git: {kind:?}"
        );
    }
    // A denied secret read fails the stage; the run's HOME is the loop's.
    let real = claude::home().unwrap();
    let denial = |tool: &str, input: Value| {
        parse(
            &result(json!({"permission_denials": [{"tool_name": tool, "tool_input": input}]})),
            "",
            ok(),
        )
    };
    let abs = real.join(".ssh/id_ed25519").display().to_string();
    assert!(matches!(
        denial("Read", json!({"file_path": abs})),
        RunEnd::Denied(_)
    ));
    assert!(matches!(
        denial("Bash", json!({"command": "cat ~/.config/gh/hosts.yml"})),
        RunEnd::Denied(_)
    ));
    assert!(matches!(
        denial("Read", json!({"file_path": "/repo/src/main.rs"})),
        RunEnd::Ok(_)
    ));
}

#[test]
fn test_every_kind_argv() {
    // kind → (tools, allowed, plugin dir, budget, timeout s, slot, runs in runs/<id>)
    type Row<'a> = (RunKind, &'a str, &'a [&'a str], bool, bool, u64, bool, bool);
    let table: [Row; 9] = [
        (
            RunKind::Design,
            "Read,Glob,Grep,Edit,Write,Skill",
            &["Read", "Glob", "Grep", "Skill", "Edit(specs/**)"],
            true,
            true,
            3600,
            true,
            false,
        ),
        (
            RunKind::Plan,
            "Read,Glob,Grep,Bash,Skill",
            &[
                "Read",
                "Glob",
                "Grep",
                "Skill",
                "Bash(git status:*)",
                "Bash(git diff:*)",
                "Bash(git log:*)",
                "Bash(git show:*)",
            ],
            true,
            true,
            3600,
            true,
            false,
        ),
        (
            RunKind::Worker,
            "Read,Edit,Write,Glob,Grep,Bash,Skill",
            &[
                "Read",
                "Edit",
                "Write",
                "Glob",
                "Grep",
                "Skill",
                "Bash(git status:*)",
                "Bash(git diff:*)",
                "Bash(git log:*)",
                "Bash(git show:*)",
            ],
            true,
            true,
            3600,
            true,
            false,
        ),
        (
            RunKind::Review,
            "Read,Grep,Glob,Bash,Skill",
            &[
                "Read",
                "Grep",
                "Glob",
                "Skill",
                "Bash(git diff:*)",
                "Bash(git log:*)",
                "Bash(git show:*)",
            ],
            true,
            false,
            900,
            true,
            false,
        ),
        (
            RunKind::Triage,
            "Read,Grep,Glob,Bash,Skill",
            &[
                "Read",
                "Grep",
                "Glob",
                "Skill",
                "Bash(git diff:*)",
                "Bash(git log:*)",
                "Bash(git show:*)",
            ],
            true,
            false,
            900,
            true,
            false,
        ),
        (
            RunKind::Verifier,
            "Read,Grep,Glob,Bash,Skill",
            &[
                "Read",
                "Grep",
                "Glob",
                "Skill",
                "Bash(git diff:*)",
                "Bash(git log:*)",
                "Bash(git show:*)",
                "Bash(curl *)",
            ],
            true,
            false,
            900,
            true,
            false,
        ),
        (RunKind::Writer, "", &[], false, false, 60, false, true),
        (RunKind::Drafter, "", &[], false, false, 900, true, true),
        (RunKind::Diagnose, "", &[], false, false, 900, true, true),
    ];
    for (kind, tools, allowed, plugins, budget, timeout, slot, in_runs) in table {
        let mut r = run(kind);
        // The session flag each kind takes (pipeline.md **Claude runs**).
        r.session = match kind {
            RunKind::Design | RunKind::Review | RunKind::Triage | RunKind::Verifier => {
                SessionArg::New(U.into())
            }
            RunKind::Plan | RunKind::Worker => SessionArg::Resume(U.into()),
            _ => SessionArg::None,
        };
        let a = strs(&claude::argv(&r, &exes()));
        let flag = |f: &str| a.iter().position(|x| x == f);
        let at = flag("--tools").unwrap();
        assert_eq!(a[at + 1], tools, "{kind:?}");
        let between = |from: &str, to: &str| -> Vec<String> {
            match flag(from) {
                None => Vec::new(),
                Some(i) => a[i + 1..flag(to).unwrap()].to_vec(),
            }
        };
        assert_eq!(
            between("--allowedTools", "--disallowedTools"),
            allowed,
            "{kind:?}"
        );
        assert_eq!(flag("--allowedTools").is_some(), !allowed.is_empty());
        assert_eq!(flag("--plugin-dir").is_some(), plugins, "{kind:?}");
        assert_eq!(flag("--max-budget-usd").is_some(), budget, "{kind:?}");
        assert_eq!(
            (flag("--session-id").is_some(), flag("--resume").is_some()),
            match &r.session {
                SessionArg::New(_) => (true, false),
                SessionArg::Resume(_) => (false, true),
                SessionArg::None => (false, false),
            },
            "{kind:?}"
        );
        let spec = claude::spec(&r, &config(), &exes());
        assert_eq!(spec.timeout, Some(Duration::from_secs(timeout)), "{kind:?}");
        assert_eq!(spec.slot, slot, "{kind:?}");
        assert_eq!(spec.cwd == r.runs, in_runs, "{kind:?}");
        assert_eq!(
            spec.stdout,
            r.runs.join(format!("{}-1.json", kind.as_str()))
        );
        assert_eq!(
            r.agent(),
            if kind as u8 <= 2 {
                "worker"
            } else {
                kind.as_str()
            }
        );
    }
    let mut e = run(RunKind::Worker);
    e.eval = true;
    assert_eq!(e.agent(), "eval");
    assert_eq!(
        claude::argv(&e, &exes()),
        claude::argv(&run(RunKind::Worker), &exes()),
        "an eval's argv is the build's"
    );
}

#[test]
fn test_claude_result() {
    let full = result(json!({
        "modelUsage": {"claude-opus-4-1": {"inputTokens": 10, "outputTokens": 20,
            "cacheReadInputTokens": 30, "cacheCreationInputTokens": 40, "costUSD": 0.4}},
        "structured_output": {"status": "done"},
    }));
    let stdout = format!("{{\"type\":\"system\",\"subtype\":\"init\"}}\nnot json\n{full}\n");
    let RunEnd::Ok(r) = parse(&stdout, "", ok()) else {
        panic!("ok")
    };
    assert_eq!(
        r,
        ClaudeResult {
            subtype: "success".into(),
            is_error: false,
            result: "done".into(),
            session_id: U.into(),
            total_cost_usd: 0.42,
            duration_ms: 1200,
            model_usage: [(
                "claude-opus-4-1".to_string(),
                ModelUsage {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_read_input_tokens: 30,
                    cache_creation_input_tokens: 40,
                    cost_usd: 0.4,
                }
            )]
            .into(),
            structured_output: Some(json!({"status": "done"})),
            permission_denials: vec![],
        }
    );
    // A pretty-printed result (several lines) reads too.
    let pretty =
        serde_json::to_string_pretty(&serde_json::from_str::<Value>(&full).unwrap()).unwrap();
    assert!(matches!(parse(&pretty, "", ok()), RunEnd::Ok(_)));

    // First match wins: session gone > limit > env > budget > denial > no result > failed.
    assert_eq!(
        parse(&full, "No conversation found with session ID: x", exit(1)),
        RunEnd::SessionGone
    );
    let limit = result(json!({"is_error": true,
        "result": "You've hit your limit · resets 3pm (Europe/Berlin)"}));
    let RunEnd::Limit(l) = parse(&limit, "", exit(1)) else {
        panic!("limit")
    };
    assert_eq!(l.model, "opus");
    assert_eq!(
        l.reset.map(|t| t.to_rfc3339()),
        Some("2026-10-15T13:00:00+00:00".into())
    );
    assert_eq!(
        parse("", "API Error: Connection error: ECONNREFUSED", exit(1)),
        RunEnd::Env("API Error: Connection error: ECONNREFUSED".into())
    );
    assert_eq!(
        parse("", "Invalid API key · Please run /login", exit(1)),
        RunEnd::Env("Invalid API key · Please run /login".into())
    );
    assert!(matches!(
        parse(
            &result(json!({"subtype": "error_max_budget_usd", "is_error": true, "result": ""})),
            "",
            exit(1)
        ),
        RunEnd::Budget(_)
    ));
    assert_eq!(parse("", "", exit(1)), RunEnd::NoResult("no result".into()));
    assert_eq!(
        parse("garbage", "boom", exit(1)),
        RunEnd::NoResult("no JSON result: garbage; stderr: boom".into())
    );
    assert_eq!(parse("", "", None), RunEnd::NoResult("no result".into()));
    assert_eq!(
        parse(
            &result(json!({"is_error": true, "subtype": "error_during_execution", "result": ""})),
            "",
            exit(1)
        ),
        RunEnd::Failed("error_during_execution".into())
    );
    assert_eq!(
        parse(
            &result(json!({"is_error": true, "result": "it broke"})),
            "",
            ok()
        ),
        RunEnd::Failed("it broke".into())
    );
    // Each ends in one short line (a draft's failed try logs it).
    assert_eq!(
        RunEnd::Failed("it broke".into()).to_string(),
        "failed: it broke"
    );
    assert_eq!(
        RunEnd::Budget(ClaudeResult::default()).to_string(),
        "budget used up"
    );
    // A successful result that mentions a network word is not a failure.
    assert!(matches!(
        parse(
            &result(json!({"result": "fixed the connection refused test"})),
            "",
            ok()
        ),
        RunEnd::Ok(_)
    ));
    // The files read lossily: a stray invalid byte doesn't hide the network failure.
    let tmp = tempfile::tempdir().unwrap();
    let (out, err) = (tmp.path().join("o.json"), tmp.path().join("o.err"));
    fs::write(&out, b"\xff\n").unwrap();
    fs::write(&err, b"\xfe Could not resolve host: api.anthropic.com\n").unwrap();
    let end = ChildEnd {
        status: exit(1),
        timed_out: false,
        run: Duration::from_secs(1),
        stdout: out,
        stderr: err,
    };
    let now = common::t("2026-10-15T13:30:00+02:00");
    assert!(
        matches!(
            claude::end(&run(RunKind::Review), &end, now),
            RunEnd::Env(_)
        ),
        "network"
    );
}

#[test]
fn test_resume_argv() {
    let mut r = run(RunKind::Worker);
    let session = |a: &[String]| -> Vec<String> {
        a.iter()
            .enumerate()
            .filter(|(_, x)| *x == "--session-id" || *x == "--resume")
            .flat_map(|(i, x)| [x.clone(), a[i + 1].clone()])
            .collect()
    };
    r.session = Session::New(U.into()).into();
    assert_eq!(
        session(&strs(&claude::argv(&r, &exes()))),
        ["--session-id", U]
    );
    r.session = Session::Resume(U.into()).into();
    assert_eq!(session(&strs(&claude::argv(&r, &exes()))), ["--resume", U]);
    r.session = SessionArg::None;
    assert!(session(&strs(&claude::argv(&r, &exes()))).is_empty());
    assert_eq!(claude::CONTINUE, "Continue where you stopped.");
}

/// A fake `claude` logging each run's cwd, argv and stdin to `dir` and answering a result.
fn fake_claude(dir: &Path) -> PathBuf {
    let path = dir.join("claude");
    exe(
        &path,
        &format!(
            "[ \"$1\" = --version ] && echo '2.1.0 (Claude Code)' && exit 0\n\
             d='{d}'\n\
             n=$(($(cat \"$d/count\" 2>/dev/null || echo 0) + 1))\n\
             pwd > \"$d/cwd-$n\"\n\
             : > \"$d/argv-$n\"\n\
             for a in \"$@\"; do printf '%s\\n' \"$a\" >> \"$d/argv-$n\"; done\n\
             cat > \"$d/stdin-$n\"\n\
             echo '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"run '$n'\",\"session_id\":\"s\"}}'\n\
             echo \"$n\" > \"$d/count\"\n",
            d = dir.display()
        ),
    );
    path
}

/// A worker step: one Claude run of `kind` in the mission's session; `ok` when it ends well.
struct Worker {
    kind: RunKind,
    prompt: fn(&Ctx<'_>, &Mission) -> String,
}

impl Handler for Worker {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let (m, session) = cx.session(m, "run")?;
        let mut r = Run::new(
            self.kind,
            &m.model,
            &cx.checkout(&m),
            &cx.runs(&m),
            1,
            (self.prompt)(cx, &m),
            cx.config,
        );
        r.session = session.into();
        Ok(Progress::Spawn(claude::prepare(
            &r, "", cx.config, cx.exes,
        )?))
    }

    fn finish(
        &mut self,
        cx: &mut Ctx<'_>,
        m: &Mission,
        end: ChildEnd,
    ) -> Result<Progress, StepError> {
        let r = Run::new(
            self.kind,
            &m.model,
            &cx.checkout(m),
            &cx.runs(m),
            1,
            "",
            cx.config,
        );
        match claude::end(&r, &end, cx.tick.wall) {
            RunEnd::Ok(_) => Ok(Progress::Done(Outcome::ok())),
            other => Ok(Progress::Done(Outcome::bad_result(format!("{other:?}")))),
        }
    }
}

#[test]
fn test_repair_resumes_session() {
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    let log = w.root.join("claude-log");
    fs::create_dir_all(&log).unwrap();
    let exes = Exes {
        claude: fake_claude(&log).into(),
        ..w.exes()
    };
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(
        Stage::Design,
        Box::new(Worker {
            kind: RunKind::Design,
            prompt: |_, _| "write the spec".into(),
        }),
    );
    // The repair: the checks' findings, short ones inline, else the log's path.
    h.set(
        Stage::Build,
        Box::new(Worker {
            kind: RunKind::Worker,
            prompt: |cx, m| {
                let log = cx.runs(m).join("verify-1.log");
                let long: String = (1..=30).map(|i| format!("error {i}\n")).collect();
                claude::repair_prompt("checks red", &long, &log)
            },
        }),
    );
    let mut lp = w.open_with(h, exes, Default::default());
    w.wait_for(&mut lp, 30, |w, _| {
        w.stage("261001-0900") == Some(Stage::Done)
    });
    let m = w.mission("261001-0900");
    let read = |n: u32, what: &str| fs::read_to_string(log.join(format!("{what}-{n}"))).unwrap();
    let argv = |n: u32| -> Vec<String> { read(n, "argv").lines().map(str::to_string).collect() };
    let flag = |a: &[String], f: &str| a.iter().position(|x| x == f).map(|i| a[i + 1].clone());

    // Design starts the session; the repair resumes it, from the same checkout.
    let (design, repair) = (argv(1), argv(2));
    assert_eq!(flag(&design, "--session-id"), Some(m.session.clone()));
    assert_eq!(flag(&design, "--resume"), None);
    assert_eq!(flag(&repair, "--resume"), Some(m.session.clone()));
    assert_eq!(
        flag(&repair, "--session-id"),
        None,
        "never --session-id twice"
    );
    // (Gone now: the mission is done.)
    let checkout = w.home.root.canonicalize().unwrap().join(&m.checkout);
    assert_eq!(PathBuf::from(read(1, "cwd").trim()), checkout);
    assert_eq!(PathBuf::from(read(2, "cwd").trim()), checkout);
    assert!(m.session_used);
    assert_eq!(read(1, "stdin"), "write the spec");
    assert_eq!(
        read(2, "stdin"),
        format!(
            "checks red: the output is in {}",
            w.home.runs("261001-0900").join("verify-1.log").display()
        )
    );
    let short = claude::repair_prompt("CI red", "test a failed\n", Path::new("/x/ci-1.log"));
    assert_eq!(short, "CI red:\ntest a failed");
}

#[test]
fn test_build_notes_keep_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let notes = tmp.path().join("build.txt");
    claude::append_notes(&notes, Note::Build, "Summary: added the loop.\n").unwrap();
    claude::append_notes(&notes, Note::Repair, "fixed the flaky test").unwrap();
    claude::append_notes(&notes, Note::Repair, "merged main").unwrap();
    assert_eq!(
        fs::read_to_string(&notes).unwrap(),
        "Summary: added the loop.\n\nRepair: fixed the flaky test\n\nRepair: merged main"
    );
    // A repair without notes yet still starts the file.
    let other = tmp.path().join("other.txt");
    claude::append_notes(&other, Note::Repair, "r").unwrap();
    assert_eq!(fs::read_to_string(&other).unwrap(), "Repair: r");
}
