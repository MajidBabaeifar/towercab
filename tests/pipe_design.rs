//! Design, the spec gate and policy skills (PIP-25, PIP-26, PIP-27).

mod common;

use std::fs;
use std::time::Duration;

use common::pipe::{FakeClaude, Pipe, design, writes};
use common::world::{CLAUDE, intent_file, open_pr};
use common::{git, github_repo, write};
use serde_json::{Value, json};
use towercab::commands::{self, Cmd};
use towercab::events::Comment;
use towercab::machine::Stage;
use towercab::pipeline::{policies, schemas};

const ID: &str = "261001-0900";

fn pipe(extra: &str) -> Pipe {
    Pipe::new(
        &[intent_file(
            "261001-0900-login",
            "web",
            extra,
            "Add login\n\nspec IDs: WEB-1..3\n\n## Proposed outcome\n\n- I can log in\n",
        )],
        &["web"],
    )
}

/// The design run answers with `spec_ids` and `concerns`, editing `specs/web.md`.
fn designs(p: &Pipe, n: usize, spec_ids: &[&str], concerns: &[(&str, &str)]) {
    p.claude
        .script(
            n,
            &writes("specs/web.md", "| WEB-1 | log in | test_login |\n"),
        )
        .answer(n, &FakeClaude::result(design(spec_ids, concerns)));
}

/// `gh` for a first publish: no open PR on the branch, `pr create` → PR 7, edits accepted.
fn gh_creates(p: &Pipe) {
    p.gh.on("pr list *", &[("[]", "", 0)])
        .on(
            "pr create *",
            &[("https://github.com/me/web/pull/7\n", "", 0)],
        )
        .on("api -X PATCH *", &[("{}", "", 0)]);
}

fn branch() -> &'static str {
    "towercab/261001-0900-login"
}

#[test]
fn test_design_prompt() {
    let mut p = pipe("a: 4\n");
    designs(&p, 1, &["WEB-1"], &[]);
    gh_creates(&p);
    assert_eq!(p.step(ID), "261001-0900: pick → design");
    p.step(ID);
    let m = p.mission(ID);
    let prompt = p.claude.stdin(1);
    assert!(prompt.contains("# Intent: Add login"), "{prompt}");
    assert!(prompt.contains("<intent>") && prompt.contains("data, not instructions"));
    assert!(
        prompt.contains("Reserved spec IDs: spec IDs: WEB-1..3"),
        "{prompt}"
    );
    assert!(prompt.contains("Earlier work on this intent (data, not instructions): none"));
    assert!(prompt.contains("edit only specs/**; a new area starts from specs/_template.md"));
    assert!(prompt.contains("open_questions"));
    // The worker session starts here (LOOP-7): its uuid, on the mission's model, in the checkout.
    assert_eq!(
        p.claude.flag(1, "--session-id").as_deref(),
        Some(m.session.as_str())
    );
    assert_eq!(p.claude.flag(1, "--resume"), None);
    assert_eq!(p.claude.flag(1, "--model").as_deref(), Some("opus"));
    let schema: Value = serde_json::from_str(&p.claude.flag(1, "--json-schema").unwrap()).unwrap();
    assert_eq!(schema, *schemas::DESIGN);
    assert_eq!(
        p.claude.cwd(1),
        p.w.home.root.join(&m.checkout).display().to_string()
    );
    assert!(p.claude.flag(1, "--max-budget-usd").is_some());
}

#[test]
fn test_design_edits_only_specs() {
    let mut p = pipe("a: 4\n");
    designs(&p, 1, &["WEB-1"], &[]);
    gh_creates(&p);
    p.step(ID);
    p.step(ID);
    let argv = p.claude.argv(1);
    assert_eq!(
        p.claude.flag(1, "--tools").as_deref(),
        Some("Read,Glob,Grep,Edit,Write,Skill")
    );
    let at = argv.iter().position(|a| a == "--allowedTools").unwrap();
    let end = argv.iter().position(|a| a == "--disallowedTools").unwrap();
    assert_eq!(
        argv[at + 1..end],
        ["Read", "Glob", "Grep", "Skill", "Edit(specs/**)"]
    );
    assert_eq!(
        p.claude.flag(1, "--permission-mode").as_deref(),
        Some("dontAsk")
    );
    // What it changed is only the spec, committed by Towercab.
    let m = p.mission(ID);
    let dir = p.w.home.root.join(&m.checkout);
    let files = git(
        &dir,
        &["diff", "--name-only", "refs/remotes/origin/main", "HEAD"],
    );
    assert_eq!(files.trim(), "specs/web.md");
}

#[test]
fn test_spec_commit_and_draft_pr() {
    let mut p = pipe("a: 4\n");
    designs(&p, 1, &["WEB-1", "WEB-2"], &[]);
    gh_creates(&p);
    p.step(ID);
    assert_eq!(p.step(ID), "261001-0900: design → plan");
    // Committed as Towercab (no App here) and pushed from its clone.
    let log = p.origin_log("web", branch());
    assert_eq!(log[0], ("docs(specs): Add login".into(), "Towercab".into()));
    assert_eq!(
        p.origin_file("web", branch(), "specs/web.md"),
        "| WEB-1 | log in | test_login |\n"
    );
    let m = p.mission(ID);
    let origin = p.w.root.join("repos/web.git");
    assert_eq!(
        m.head.as_deref(),
        Some(git(&origin, &["rev-parse", branch()]).trim())
    );
    assert!(m.pushed_at.is_some());
    // The draft PR: its title from the design, its body the initial text.
    let create = p.gh.find("pr create")[0];
    let argv = p.gh.argv(create);
    let after = |f: &str| argv[argv.iter().position(|a| a == f).unwrap() + 1].clone();
    assert!(argv.contains(&"--draft".to_string()));
    assert_eq!(after("--title"), "feat(auth): Add login");
    assert_eq!(after("-R"), "me/web");
    assert_eq!(after("--base"), "main");
    assert_eq!(after("--head"), branch());
    let body = p.gh.body(create).unwrap();
    assert!(body.starts_with("Spec IDs: WEB-1, WEB-2\n"), "{body}");
    assert!(
        body.contains(&format!(
            "<sub>Towercab {} · base ",
            env!("CARGO_PKG_VERSION")
        )),
        "{body}"
    );
    assert!(body.contains(" · policies none</sub>"), "{body}");
    assert_eq!(m.pr, Some(7));
    assert_eq!(
        m.pr_url.as_deref(),
        Some("https://github.com/me/web/pull/7")
    );
    // intent.md: the PR, stage build (plan).
    let md = p.w.intent_md("261001-0900-login");
    assert!(md.contains("pr: https://github.com/me/web/pull/7"), "{md}");
    let d = &p.data(ID)["design"];
    assert_eq!(d["title"], "feat(auth): Add login");
    assert_eq!(d["spec_ids"], json!(["WEB-1", "WEB-2"]));
    assert_eq!(d["intent_hash"].as_str().unwrap().len(), 64);
}

/// One design per case: (a, max_autonomy, concerns) → waits for my approval.
#[test]
fn test_spec_gate() {
    type Case<'a> = (&'a str, Option<u8>, &'a [(&'a str, &'a str)], bool);
    let cases: [Case; 6] = [
        ("a: 4\n", None, &[], false),
        ("a: 2\n", None, &[], true),
        ("a: 4\n", None, &[("Sessions", "cookie vs token")], true),
        ("", None, &[], false),
        ("", Some(2), &[], true),
        ("a: 5\n", Some(2), &[], true),
    ];
    for (extra, max, concerns, waits) in cases {
        let mut p = pipe(extra);
        if let Some(max) = max {
            let mine = p.w.mine("web");
            write(
                &mine,
                "TOWERCAB.md",
                &format!("---\nmax_autonomy: {max}\n---\n"),
            );
            git(&mine, &["add", "-A"]);
            git(&mine, &["commit", "--quiet", "-m", "cap"]);
            git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
        }
        designs(&p, 1, &["WEB-1"], concerns);
        gh_creates(&p);
        p.step(ID);
        let line = p.step(ID);
        let case = format!("{extra:?} max {max:?} concerns {concerns:?}");
        if !waits {
            assert_eq!(line, "261001-0900: design → plan", "{case}");
            continue;
        }
        assert_eq!(
            line,
            "261001-0900: design → approval:spec · approve spec".to_string(),
            "{case}"
        );
        let md = p.w.intent_md("261001-0900-login");
        assert!(md.contains("waiting: approve spec"), "{case}: {md}");
        assert!(
            md.contains("\n## Towercab\n\nDesign: Adds login."),
            "{case}: {md}"
        );
        assert!(
            md.contains("Spec PR: https://github.com/me/web/pull/7"),
            "{md}"
        );
        let body = p.gh.body(p.gh.find("pr create")[0]).unwrap();
        for (what, why) in concerns {
            assert!(md.contains(&format!("- {what}: {why}")), "{md}");
            assert!(
                body.contains(&format!("**Concerns**\n- {what}: {why}")),
                "{body}"
            );
        }
        let o = p.w.outbox();
        assert!(o.iter().any(|r| r.1 == "approve_spec"), "{o:?}");
    }
    // No behaviour change: no commit, no PR; the summary only in intent.md.
    let mut p = pipe("a: 2\n");
    p.claude.answer(1, &FakeClaude::result(design(&[], &[])));
    p.step(ID);
    assert_eq!(
        p.step(ID),
        "261001-0900: design → approval:spec · approve spec"
    );
    assert!(p.gh.calls().is_empty(), "{:?}", p.gh.calls());
    let m = p.mission(ID);
    assert_eq!((m.pr, m.head), (None, None));
    let md = p.w.intent_md("261001-0900-login");
    assert!(md.contains("No spec change (no PR yet)"), "{md}");
}

/// Waits at `approval:spec` with PR 7 (a2).
fn waiting_spec() -> Pipe {
    let mut p = pipe("a: 2\n");
    designs(&p, 1, &["WEB-1"], &[]);
    gh_creates(&p);
    p.step(ID);
    p.step(ID);
    assert_eq!(p.w.stage(ID), Some(Stage::ApprovalSpec));
    p
}

#[test]
fn test_spec_feedback_revises() {
    let mut p = waiting_spec();
    let head = p.mission(ID).head.unwrap();
    let comment = Comment {
        author: "me".into(),
        at: "2099-01-01T10:00:00Z".into(),
        body: "Use WEB-2 for logout too.".into(),
    };
    let mut pr = open_pr(&head);
    pr.comments = vec![comment];
    p.w.prs.set(7, pr);
    // The design's read of my comments goes through gh.
    p.gh.on(
        "pr view 7 *",
        &[(
            &json!({"state": "OPEN", "headRefOid": head, "mergeable": "MERGEABLE",
                "comments": [{"author": {"login": "me"}, "createdAt": "2099-01-01T10:00:00Z",
                    "body": "Use WEB-2 for logout too."}],
                "reviews": []})
            .to_string(),
            "",
            0,
        )],
    )
    .on("api --paginate *", &[("[[]]", "", 0)]);
    p.claude
        .script(
            2,
            &writes(
                "specs/web.md",
                "| WEB-1 | log in | test_login |\n| WEB-2 | log out | test_logout |\n",
            ),
        )
        .answer(2, &FakeClaude::result(design(&["WEB-1", "WEB-2"], &[])));
    let Pipe { w, lp, .. } = &mut p;
    let lp = lp.as_mut().unwrap();
    w.wait_for(lp, 30, |w, _| {
        w.transitions(ID)
            .iter()
            .filter(|t| t.2 == "approval:spec")
            .count()
            == 2
    });
    let t = p.w.transitions(ID);
    assert!(
        t.contains(&("approval:spec".into(), "feedback".into(), "design".into())),
        "{t:?}"
    );
    // The same session, my comment as data; a new spec commit; back to approve spec.
    let m = p.mission(ID);
    assert_eq!(
        p.claude.flag(2, "--resume").as_deref(),
        Some(m.session.as_str())
    );
    let prompt = p.claude.stdin(2);
    assert!(
        prompt.contains("<comments>\n- me at 2099-01-01T10:00:00Z: Use WEB-2 for logout too."),
        "{prompt}"
    );
    assert_eq!(
        p.origin_log("web", branch())[0].0,
        "docs(specs): revise Add login"
    );
    assert_eq!(m.stage, Stage::ApprovalSpec);
    assert_eq!(m.feedback_seen.as_deref(), Some("2099-01-01T10:00:00Z"));
    assert_ne!(m.head.unwrap(), head);
    // The PR body follows the revised spec.
    let patch = *p
        .gh
        .find("api -X PATCH repos/me/web/pulls/7")
        .last()
        .unwrap();
    assert!(
        p.gh.body(patch)
            .unwrap()
            .starts_with("Spec IDs: WEB-1, WEB-2\n")
    );
    assert_eq!(
        p.w.outbox()
            .iter()
            .filter(|r| r.1 == "approve_spec")
            .count(),
        2
    );
}

#[test]
fn test_approve_starts_build() {
    let mut p = waiting_spec();
    let db = p.w.db();
    commands::queue(&db, &Cmd::Approve(ID.into()), "cli").unwrap();
    let Pipe { w, lp, .. } = &mut p;
    let lp = lp.as_mut().unwrap();
    w.until(lp, 5, |w| w.stage(ID) != Some(Stage::ApprovalSpec));
    let t = p.w.transitions(ID);
    assert!(
        t.contains(&("approval:spec".into(), "approve".into(), "plan".into())),
        "{t:?}"
    );
    // No second design run.
    assert_eq!(p.claude.calls(), 1);
    assert!(!p.w.intent_md("261001-0900-login").contains("waiting:"));
}

/// The policies repo `me/policies` and a skill in the target repo's base.
fn with_policies(p: &mut Pipe) -> std::path::PathBuf {
    let hub = p.w.root.join("github");
    let bare = github_repo(
        &hub,
        "me/policies",
        &[
            (
                "policies/style/SKILL.md",
                "---\nname: style\n---\nshared style\n",
            ),
            ("policies/style/ref/rules.md", "rules\n"),
            ("policies/lint/SKILL.md", "shared lint\n"),
            ("policies/notes/README.md", "no SKILL.md: not a skill\n"),
            ("hooks/hooks.json", "{\"hooks\": {}}\n"),
            (".mcp.json", "{\"mcpServers\": {}}\n"),
            ("settings.json", "{}\n"),
        ],
    );
    let work = hub.join("me/policies.work");
    std::os::unix::fs::symlink("/etc/passwd", work.join("policies/style/link.md")).unwrap();
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "--quiet", "-m", "link"]);
    git(&work, &["push", "--quiet", "origin", "HEAD:main"]);
    p.w.config.policies.github = Some("me/policies".into());
    let mine = p.w.mine("web");
    write(&mine, ".claude/skills/lint/SKILL.md", "repo lint\n");
    write(&mine, ".claude/settings.json", "{\"hooks\": {}}\n");
    write(&mine, ".claude/hooks/x.sh", "echo hi\n");
    git(&mine, &["add", "-A"]);
    git(&mine, &["commit", "--quiet", "-m", "skills"]);
    git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
    bare
}

#[test]
fn test_policy_skills_in_tools() {
    let mut p = pipe("a: 4\n");
    with_policies(&mut p);
    designs(&p, 1, &["WEB-1"], &[]);
    gh_creates(&p);
    p.step(ID);
    p.step(ID);
    let plugin = p.runs(ID).join("policies");
    assert_eq!(
        p.claude.flag(1, "--plugin-dir").as_deref(),
        Some(plugin.to_str().unwrap())
    );
    assert!(
        p.claude
            .flag(1, "--tools")
            .unwrap()
            .split(',')
            .any(|t| t == "Skill")
    );
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest, policies::plugin_json());
    assert_eq!(manifest["name"], "towercab-policies");
    for skill in ["style", "lint"] {
        assert!(
            plugin.join("skills").join(skill).join("SKILL.md").is_file(),
            "{skill}"
        );
    }
    // The versions in force name the policies sha.
    let hub = p.w.root.join("github/me/policies.git");
    let sha = git(&hub, &["rev-parse", "main"]);
    let body = p.gh.body(p.gh.find("pr create")[0]).unwrap();
    assert!(
        body.contains(&format!("policies me/policies@{}</sub>", &sha[..7])),
        "{body}"
    );
}

#[test]
fn test_policy_plugin_from_base() {
    let mut p = pipe("a: 4\n");
    with_policies(&mut p);
    p.step(ID);
    let m = p.mission(ID);
    // The checkout (the PR's side) changes a skill: never read.
    let dir = p.w.home.root.join(&m.checkout);
    write(&dir, ".claude/skills/lint/SKILL.md", "from the PR\n");
    write(&dir, ".claude/skills/evil/SKILL.md", "from the PR\n");
    git(&dir, &["add", "-A"]);
    git(
        &dir,
        &[
            "-c",
            "user.name=w",
            "-c",
            "user.email=w@x",
            "commit",
            "--quiet",
            "-m",
            "pr",
        ],
    );
    let sha = p.cx(|cx| policies::assemble(cx, &m)).unwrap();
    let hub = p.w.root.join("github/me/policies.git");
    assert_eq!(sha, git(&hub, &["rev-parse", "main"]).trim());
    let skills = p.runs(ID).join("policies/skills");
    // The repo's base wins a name clash; shared ones come from policies/ at its base.
    assert_eq!(
        fs::read_to_string(skills.join("lint/SKILL.md")).unwrap(),
        "repo lint\n"
    );
    assert_eq!(
        fs::read_to_string(skills.join("style/SKILL.md")).unwrap(),
        "---\nname: style\n---\nshared style\n"
    );
    assert_eq!(
        fs::read_to_string(skills.join("style/ref/rules.md")).unwrap(),
        "rules\n"
    );
    assert!(!skills.join("evil").exists());
    assert!(!skills.join("notes").exists());
    // Symlinks are never copied.
    assert!(fs::symlink_metadata(skills.join("style/link.md")).is_err());
    // A change on the policies repo is fetched at most every 300 s.
    let work = p.w.root.join("github/me/policies.work");
    write(&work, "policies/style/SKILL.md", "v2\n");
    git(&work, &["commit", "--quiet", "-am", "v2"]);
    git(&work, &["push", "--quiet", "origin", "HEAD:main"]);
    let again = p.cx(|cx| policies::assemble(cx, &m)).unwrap();
    assert_eq!(again, sha);
    let db = p.w.db();
    db.set_meta("policies_fetched", "0").unwrap();
    let fetched = p.cx(|cx| policies::assemble(cx, &m)).unwrap();
    assert_ne!(fetched, sha);
    assert_eq!(
        fs::read_to_string(skills.join("style/SKILL.md")).unwrap(),
        "v2\n"
    );
    let _ = Duration::ZERO;
}

#[test]
fn test_policy_plugin_has_no_hooks() {
    let mut p = pipe("a: 4\n");
    with_policies(&mut p);
    p.step(ID);
    let m = p.mission(ID);
    // A leftover from an earlier run is cleared.
    let plugin = p.runs(ID).join("policies");
    write(&plugin, "hooks/hooks.json", "{}");
    p.cx(|cx| policies::assemble(cx, &m)).unwrap();
    let mut top: Vec<String> = fs::read_dir(&plugin)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    top.sort();
    assert_eq!(top, [".claude-plugin", "skills"]);
    let manifest = fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap();
    for key in ["hooks", "mcpServers", "settings"] {
        assert!(!manifest.contains(key), "{manifest}");
    }
    let mut skills: Vec<String> = fs::read_dir(plugin.join("skills"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    skills.sort();
    assert_eq!(skills, ["lint", "style"]);
    // The repo's `.claude/settings.json` and hooks never reach it.
    let all = git(&p.w.mine("web"), &["ls-files"]);
    assert!(all.contains(".claude/settings.json"));
    assert!(!plugin.join("skills/settings.json").exists());
    let _ = CLAUDE;
}

/// PIP-25 → PIP-1: no or an invalid result → one result-only continue in the same session,
/// then `no result`.
#[test]
fn test_design_result_continue() {
    let mut p = pipe("a: 4\n");
    // An invalid result (a spec ID not like WEB-1), then a valid one.
    p.claude
        .script(
            1,
            &writes("specs/web.md", "| WEB-1 | log in | test_login |\n"),
        )
        .answer(1, &FakeClaude::result(design(&["web one"], &[])))
        .answer(2, &FakeClaude::result(design(&["WEB-1"], &[])));
    gh_creates(&p);
    p.step(ID);
    assert_eq!(p.step(ID), "261001-0900: design → plan");
    let m = p.mission(ID);
    assert_eq!(
        p.claude.flag(2, "--resume").as_deref(),
        Some(m.session.as_str())
    );
    assert!(
        p.claude
            .stdin(2)
            .contains("Reply with only the JSON result")
    );
    assert_eq!(p.data(ID)["cont"], "design:run");
    assert_eq!(p.origin_log("web", branch())[0].0, "docs(specs): Add login");
    // Twice nothing: waits.
    let mut p = pipe("a: 4\n");
    p.claude.answer(1, "").answer(2, "not json\n");
    p.step(ID);
    let line = p.step(ID);
    assert_eq!(line, "261001-0900: design → blocked · no result");
    assert_eq!(p.claude.calls(), 2);
    assert!(p.mission(ID).why.unwrap().contains("no JSON result"));
}
