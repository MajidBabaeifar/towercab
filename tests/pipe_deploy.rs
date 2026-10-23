//! Deploy (PIP-8), e2e (PIP-9) and the release gate (PIP-34): after a merge into a repo with
//! ` ```live `, the deploy is seen when its sha contains the merge; e2e runs sandboxed with the
//! secrets file only, once more when red; a ` ```release ` block waits for me, then promotes,
//! waits for production and runs its e2e once.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};

use common::http::FakeHttp;
use common::pipe::{E2E_LINE, LOGIN_ID as ID, Pipe};
use serde_json::{Value, json};
use sha2::Digest as _;
use towercab::commands::{self, Cmd};
use towercab::machine::Stage;
use towercab::pipeline::e2e::{self, REDACTED, WITHHELD, redact, secrets};

/// `TOWERCAB.md` with ` ```live ` on `env:staging` and the e2e script.
fn live() -> String {
    format!("```live\ndeploy: env:staging\ne2e: {E2E_LINE}\n```\n")
}

/// `live` plus a ` ```release ` block (`release.sh <sha>`, production, the e2e script).
fn with_release() -> String {
    format!(
        "{}\n```release\ncommand: sh '{{root}}/release.sh' <sha>\ndeploy: env:production\ne2e: {E2E_LINE}\n```\n",
        live()
    )
}

/// `<root>/release.sh`: appends its `$1` to `release.args`, exits `release.exit` (none: 0),
/// with a line on stderr when it fails.
fn release_script(p: &Pipe) {
    let d = p.w.root.display();
    fs::write(
        p.w.root.join("release.sh"),
        format!(
            r#"d='{d}'
echo "$1" >> "$d/release.args"
code=$(cat "$d/release.exit" 2>/dev/null || echo 0)
[ "$code" = 0 ] || echo "deploy.yml: workflow not found" >&2
exit "$code"
"#
        ),
    )
    .unwrap();
}

fn transitions(p: &Pipe) -> Vec<String> {
    p.w.transitions(ID)
        .into_iter()
        .map(|(f, e, t)| format!("{f} {e} {t}"))
        .collect()
}

/// Another mission of the repo, id 0, at `stage`.
fn other_at(p: &Pipe, stage: &str) {
    p.w.db()
        .conn()
        .execute(
            "INSERT INTO missions (id, kind, intent, repo, stage, step, model, session, checkout,
               created, updated) VALUES (0, 'intent', 'other', 'web', ?1, '', 'sonnet', 'u',
               'work/other-1', 0, 0)",
            [stage],
        )
        .unwrap();
}

#[test]
fn test_deploy_contains_merge() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    // Nothing deployed yet: it polls.
    p.gh.on(
        "api repos/me/web/deployments?environment=staging*",
        &[("[]", "", 0)],
    );
    assert_eq!(p.step(ID), "261001-0900: deploy → deploy");
    let d = p.datum(ID, "deploy");
    assert_eq!(d["merge"], json!(merge));
    assert!(d["since"].as_f64().is_some());
    // The newest deployment without a success status is passed over; an older one doesn't
    // contain the merge yet.
    p.gh.replace(
        "api repos/me/web/deployments?environment=staging*",
        &[(
            &json!([{"id": 4, "sha": "4444444"}, {"id": 3, "sha": "3333333"}]).to_string(),
            "",
            0,
        )],
    );
    p.gh.on(
        "api repos/me/web/deployments/4/statuses",
        &[(r#"[{"state":"in_progress"}]"#, "", 0)],
    )
    .on(
        "api repos/me/web/deployments/3/statuses",
        &[(r#"[{"state":"success"}]"#, "", 0)],
    )
    .on("api repos/me/web/compare/*", &[("behind\n", "", 0)]);
    assert_eq!(p.step(ID), "261001-0900: deploy → deploy");
    let n = *p.gh.find("api repos/me/web/compare").last().unwrap();
    assert_eq!(
        p.gh.argv(n),
        [
            "api",
            &format!("repos/me/web/compare/{merge}...3333333"),
            "--jq",
            ".status"
        ]
    );
    assert!(p.gh.find("api repos/me/web/deployments/4/statuses").len() == 1);
    // Another mission of the repo deploying with a lower id goes first.
    p.deploys("staging", 5, "5555555", "ahead");
    other_at(&p, "e2e");
    assert_eq!(p.step(ID), "261001-0900: deploy → deploy");
    assert_eq!(p.mission(ID).step, "queued");
    p.w.db()
        .conn()
        .execute("DELETE FROM missions WHERE id = 0", [])
        .unwrap();
    // A deployed sha ahead of the merge contains it: on to e2e.
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    assert_eq!(p.datum(ID, "deploy")["sha"], json!("5555555"));
    assert_eq!(p.step(ID), "261001-0900: e2e → release");
    assert_eq!(p.step(ID), "261001-0900: release → done");
}

#[test]
fn test_url_newer_deploy_counts() {
    let page = Arc::new(Mutex::new(String::from("version: none yet")));
    let shown = Arc::clone(&page);
    let http = FakeHttp::start(move |_| (200, shown.lock().unwrap().clone()));
    let towercab = format!(
        "```live\ndeploy: url:{}/version\ntimeout: 5\ne2e: {E2E_LINE}\n```\n",
        http.url
    );
    let (mut p, merge) = Pipe::merged(&towercab, "towercab");
    // The page shows no sha: polls, no compare.
    assert_eq!(p.step(ID), "261001-0900: deploy → deploy");
    assert!(p.gh.find("api repos/me/web/compare").is_empty());
    // A newer commit on main is deployed: GitHub says it is ahead of the merge.
    p.base("web", &[("docs/next.md", "next\n")], "next");
    let newer = common::git(&p.w.mine("web"), &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    *page.lock().unwrap() = format!("{{\"version\": \"1.2\", \"sha\": \"{newer}\"}}");
    p.gh.on("api repos/me/web/compare/*", &[("ahead\n", "", 0)]);
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    let n = p.gh.find("api repos/me/web/compare")[0];
    assert_eq!(
        p.gh.argv(n)[1],
        format!("repos/me/web/compare/{merge}...{newer}")
    );
    assert_eq!(p.datum(ID, "deploy")["sha"], json!(newer));
    assert!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.path == "/version")
    );
}

#[test]
fn test_deploy_timeout_no_revert() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    p.gh.on(
        "api repos/me/web/deployments?environment=staging*",
        &[("[]", "", 0)],
    );
    assert_eq!(p.step(ID), "261001-0900: deploy → deploy");
    // 15 minutes (the default) pass without the deploy.
    let m = p.mission(ID);
    let mut data: Value = serde_json::from_str(&m.data).unwrap();
    let since = data["deploy"]["since"].as_f64().unwrap() - 15.0 * 60.0;
    data["deploy"]["since"] = json!(since);
    p.w.db()
        .conn()
        .execute(
            "UPDATE missions SET data = ?1 WHERE id = ?2",
            rusqlite::params![data.to_string(), m.id],
        )
        .unwrap();
    assert_eq!(
        p.step(ID),
        "261001-0900: deploy → blocked · deploy not seen"
    );
    let m = p.mission(ID);
    assert_eq!(
        m.why.as_deref(),
        Some(format!("{} not deployed after 15 min (deployed: none)", &merge[..7]).as_str())
    );
    assert!(!transitions(&p).iter().any(|t| t.contains("rollback")));
    assert_eq!(p.e2e_runs(), 0);
    assert!(
        p.w.outbox()
            .iter()
            .any(|o| o.1 == "deploy_not_seen" && o.3.starts_with("deploy not seen"))
    );
    // My continue: deploy again, its clock started anew.
    commands::queue(&p.w.db(), &Cmd::Approve(ID.into()), "cli").unwrap();
    let lp = p.lp.as_mut().unwrap();
    p.w.pass(lp);
    assert_eq!(p.w.stage(ID), Some(Stage::Deploy));
    let again = p.datum(ID, "deploy")["since"].as_f64().unwrap();
    assert!(again != since, "a new wait");
}

#[test]
fn test_no_live_is_done() {
    let (mut p, _) = Pipe::merged("---\nmax_autonomy: 5\n---\n", "towercab");
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    assert_eq!(p.step(ID), "261001-0900: e2e → release");
    assert_eq!(p.step(ID), "261001-0900: release → done");
    assert!(p.gh.find("api repos/me/web/deployments").is_empty());
    assert_eq!(p.e2e_runs(), 0);
    assert!(p.bwraps().is_empty());
}

#[test]
fn test_e2e_retry_once() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    p.deploys("staging", 1, &merge, "identical");
    p.e2e_exits(&[1, 0]);
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    // Red: once more (60 s later in the loop), not yet a revert.
    assert_eq!(p.step(ID), "261001-0900: e2e → e2e");
    assert_eq!(p.mission(ID).step, "e2e:2");
    assert_eq!(p.step(ID), "261001-0900: e2e → release");
    assert_eq!(p.e2e_runs(), 2);
    // In a checkout of the merge commit, under the sandbox with network.
    let checkout = p.checkout(ID).display().to_string();
    assert_eq!(p.root_file("e2e-1.head").trim(), merge);
    assert_eq!(p.root_file("e2e-2.cwd").trim(), checkout);
    let calls = p.bwraps();
    assert_eq!(calls.len(), 2);
    for argv in &calls {
        assert!(!argv.contains(&"--unshare-net".to_string()), "{argv:?}");
        let i = argv.iter().position(|a| a == "--bind").unwrap();
        assert_eq!(argv[i + 1], checkout);
        assert_eq!(
            argv.last().unwrap(),
            &format!("sh '{}/e2e.sh'", p.w.root.display())
        );
    }
    let runs = p.runs(ID);
    assert!(
        fs::read_to_string(runs.join("e2e-1.log"))
            .unwrap()
            .contains("e2e run 1 failed")
    );
    assert!(
        fs::read_to_string(runs.join("e2e-2.log"))
            .unwrap()
            .contains("e2e run 2")
    );
    assert_eq!(p.datum(ID, "e2e")["runs"], json!(2));
}

#[test]
fn test_e2e_env_only_secrets() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    p.deploys("staging", 1, &merge, "ahead");
    let dir = p.w.root.join("secrets");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("web.env");
    fs::write(
        &file,
        "# staging\nAPI_TOKEN=s3cr3t-token-value\n\nOTHER='quoted value'\n",
    )
    .unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    assert_eq!(p.step(ID), "261001-0900: e2e → release");
    let env: Vec<(String, String)> = p
        .root_file("e2e-1.env")
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let mut keys: Vec<&str> = env
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !["PWD", "SHLVL", "_", "OLDPWD"].contains(k))
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "API_TOKEN",
            "HOME",
            "LANG",
            "OTHER",
            "PATH",
            "TMPDIR",
            "XDG_CACHE_HOME"
        ]
    );
    let get = |k: &str| env.iter().find(|(x, _)| x == k).unwrap().1.clone();
    assert_eq!(get("API_TOKEN"), "s3cr3t-token-value");
    assert_eq!(get("OTHER"), "quoted value");
    assert_eq!(get("PATH"), p.w.config.agent.path);
    // The log never holds a secret.
    let log = fs::read_to_string(p.runs(ID).join("e2e-1.log")).unwrap();
    assert!(log.contains(&format!("token={REDACTED}")), "{log}");
    assert!(!log.contains("s3cr3t"));
    assert_eq!(
        redact("a s3cr3t b 12", &["s3cr3t".into(), "12".into()]),
        format!("a {REDACTED} b 12"),
        "values under 3 characters stay"
    );
}

#[test]
fn test_e2e_redaction_fails_closed() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    p.deploys("staging", 1, &merge, "ahead");
    let dir = p.w.root.join("secrets");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("web.env");
    fs::write(&file, "API_TOKEN=s3cr3t-token-value\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    // The e2e rotates the secret while it runs: what it ran with is still redacted.
    fs::write(
        p.w.root.join("e2e.sh"),
        format!(
            "echo \"token=$API_TOKEN\" >&2\nprintf 'API_TOKEN=rotated-value\\n' > '{}'\n",
            file.display()
        ),
    )
    .unwrap();
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    // What a worker or a PR's commands left in the checkout is gone before the e2e runs.
    let co = p.checkout(ID);
    assert!(co.join(".git").is_dir());
    fs::write(co.join("planted.txt"), "x").unwrap();
    assert_eq!(p.step(ID), "261001-0900: e2e → release");
    assert!(!co.join("planted.txt").exists());
    let runs = p.runs(ID);
    let log = fs::read_to_string(runs.join("e2e-1.log")).unwrap();
    assert!(log.contains(&format!("token={REDACTED}")), "{log}");
    let err = fs::read_to_string(runs.join("e2e-1.err")).unwrap();
    assert_eq!(err, format!("token={REDACTED}\n"));
    let raw = |runs: &std::path::Path| -> Vec<String> {
        fs::read_dir(runs)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".raw"))
            .collect()
    };
    assert!(raw(&runs).is_empty());
    // Raw output a cut-off run left (another process spawned it): redacted when the secrets
    // file is as recorded at its spawn, withheld when it changed; deleted either way, before
    // the next step reads a log.
    let now = fs::read(&file).unwrap();
    let sha: String = sha2::Sha256::digest(&now)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    for (n, rec) in [(5, sha.as_str()), (6, "0000")] {
        fs::write(
            runs.join(format!("e2e-{n}.out.raw")),
            "token=rotated-value\n",
        )
        .unwrap();
        fs::write(runs.join(format!("e2e-{n}.err.raw")), "rotated-value\n").unwrap();
        let mut d = p.data(ID);
        d["e2e_secrets"] = json!({"n": n, "sha": rec});
        p.w.db()
            .conn()
            .execute(
                "UPDATE missions SET data = ?1 WHERE intent = ?2",
                rusqlite::params![d.to_string(), ID],
            )
            .unwrap();
        let m = p.mission(ID);
        p.cx(|cx| e2e::scrub(cx, &m));
        let log = fs::read_to_string(runs.join(format!("e2e-{n}.log"))).unwrap();
        assert!(!log.contains("rotated"), "{log}");
        if n == 5 {
            assert_eq!(
                log,
                format!("$ (interrupted)\ntoken={REDACTED}\n{REDACTED}\n")
            );
        } else {
            assert_eq!(log, format!("$ (interrupted)\n{WITHHELD}\n"));
        }
        assert!(raw(&runs).is_empty());
    }
}

#[test]
fn test_e2e_env_failure_not_red() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    p.deploys("staging", 1, &merge, "ahead");
    p.e2e_exits(&[127]);
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    // The command couldn't run: env_blocked's backoff, the step kept, never red.
    assert_eq!(p.step(ID), "261001-0900: e2e → e2e");
    let m = p.mission(ID);
    assert_eq!(m.fault.as_deref(), Some("tool:sh"));
    assert_eq!(m.retries, 1);
    assert_eq!(m.step, "e2e:1");
    assert!(!transitions(&p).iter().any(|t| t.contains(" red ")));
    // The sandbox doesn't start (bwrap's own error): env_blocked too.
    let bwrap = p.w.root.join("pipebin/bwrap-broken");
    common::exe(
        &bwrap,
        "echo 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n",
    );
    p.exes.bwrap = bwrap.into();
    let mut h = Pipe::handlers();
    for s in common::pipe::DESIGN_TO_MERGE {
        h.set(s, Box::new(towercab::handler::Stub));
    }
    p.open_with(h);
    let clear = |p: &Pipe| {
        p.w.db()
            .conn()
            .execute("UPDATE missions SET retry_at = NULL", [])
            .unwrap();
    };
    clear(&p);
    assert_eq!(p.step(ID), "261001-0900: e2e → e2e");
    assert_eq!(p.mission(ID).fault.as_deref(), Some("sandbox"));
    assert_eq!(p.e2e_runs(), 1, "the script never ran");
    assert_eq!(p.w.stage(ID), Some(Stage::E2e));
}

#[test]
fn test_e2e_secrets_file_mode() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    p.deploys("staging", 1, &merge, "ahead");
    let dir = p.w.root.join("secrets");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("web.env");
    fs::write(&file, "API_TOKEN=s3cr3t-token-value\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(secrets(&file).unwrap_err().contains("mode 644"));
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    // Readable by others: refused, env_blocked (secrets:web), no run.
    assert_eq!(p.step(ID), "261001-0900: e2e → e2e");
    let m = p.mission(ID);
    assert_eq!(m.fault.as_deref(), Some("secrets:web"));
    assert_eq!(p.e2e_runs(), 0);
    assert!(p.bwraps().is_empty());
    // chmod 600: it runs.
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    p.w.db()
        .conn()
        .execute("UPDATE missions SET retry_at = NULL", [])
        .unwrap();
    assert_eq!(p.step(ID), "261001-0900: e2e → release");
    assert_eq!(p.e2e_runs(), 1);
    // Absent: no secrets; a bad line: refused.
    assert_eq!(secrets(&dir.join("none.env")).unwrap(), vec![]);
    fs::write(&file, "not a pair\n").unwrap();
    assert!(
        secrets(&file)
            .unwrap_err()
            .contains("line 1: want KEY=VALUE")
    );
}

#[test]
fn test_e2e_green_done() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    p.deploys("staging", 1, &merge, "ahead");
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    assert_eq!(p.step(ID), "261001-0900: e2e → release");
    assert_eq!(p.step(ID), "261001-0900: release → done");
    assert_eq!(p.e2e_runs(), 1);
    assert!(p.w.intents.store().scan().done.iter().any(|i| i.id == ID));
}

#[test]
fn test_release_waits_for_me() {
    let (mut p, merge) = Pipe::merged(&with_release(), "towercab");
    release_script(&p);
    p.deploys("staging", 1, &merge, "ahead");
    assert_eq!(p.step(ID), "261001-0900: deploy → e2e");
    assert_eq!(
        p.step(ID),
        "261001-0900: e2e → approval:release · authorize release"
    );
    assert!(
        p.w.outbox()
            .iter()
            .any(|o| o.3.starts_with("authorize release: release 261001-0900"))
    );
    assert_eq!(p.root_file("release.args"), "", "nothing released");
    assert!(
        p.w.intent_md(common::pipe::LOGIN_DIR)
            .contains("waiting: authorize release")
    );
}

/// The release world at `approval:release`, production's gh answers set.
fn at_release() -> (Pipe, String) {
    let (mut p, merge) = Pipe::merged(&with_release(), "towercab");
    release_script(&p);
    p.deploys("staging", 1, &merge, "ahead");
    p.step_to(ID, Stage::ApprovalRelease, 4);
    (p, merge)
}

#[test]
fn test_release_runs_command() {
    let (mut p, merge) = at_release();
    // The PR's head (a stub merge has none): one commit for the change's lead time (MET-26).
    let dir = p.checkout(ID);
    common::write(&dir, "src/logout.rs", "pub fn logout() {}\n");
    common::git(&dir, &["add", "-A"]);
    common::git(&dir, &["commit", "--quiet", "-m", "logout"]);
    let head = common::git(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    p.w.db()
        .conn()
        .execute(
            "UPDATE missions SET head = ?1 WHERE intent = ?2",
            rusqlite::params![head, ID],
        )
        .unwrap();
    // Production shows nothing yet; `release <id>` runs the command once.
    p.gh.on(
        "api repos/me/web/deployments?environment=production*",
        &[("[]", "", 0)],
    );
    commands::queue(&p.w.db(), &Cmd::Release(ID.into()), "cli").unwrap();
    p.until(30, |w| w.stage(ID) == Some(Stage::Blocked));
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("deploy not seen"));
    assert_eq!(p.root_file("release.args"), format!("{merge}\n"));
    assert!(p.runs(ID).join("release-1.log").exists());
    assert_eq!(p.datum(ID, "release")["ran"], json!(merge));
    // Production deployed; my continue waits again without a second release.
    p.gh.on(
        "api repos/me/web/deployments/9/statuses",
        &[(r#"[{"state":"success"}]"#, "", 0)],
    );
    p.gh.replace(
        "api repos/me/web/deployments?environment=production*",
        &[(&json!([{"id": 9, "sha": merge}]).to_string(), "", 0)],
    );
    commands::queue(&p.w.db(), &Cmd::Approve(ID.into()), "cli").unwrap();
    p.until(30, |w| w.stage(ID) == Some(Stage::Done));
    assert_eq!(p.root_file("release.args"), format!("{merge}\n"), "once");
    assert_eq!(p.e2e_runs(), 2, "staging, then production");
    // DORA (MET-26): `live` was staging; the release's deploy is production, and ends the
    // change's lead time (spooled: the test's collector is dead).
    let recs = towercab::metrics::spool_read(&p.w.home.root.join("metrics.jsonl"), usize::MAX);
    let deploys: Vec<&str> = recs
        .iter()
        .filter(|r| r.metric == towercab::metrics::Metric::Deploys)
        .map(|r| r.label("env").unwrap())
        .collect();
    assert_eq!(deploys, ["staging", "production"]);
    // Stored before it counts: a re-entry of `wait` (an env failure after it) doesn't again.
    assert_eq!(p.datum(ID, "release")["counted"], json!(merge));
    let leads = recs
        .iter()
        .filter(|r| r.metric == towercab::metrics::Metric::ChangeLeadDuration)
        .count();
    assert_eq!(leads, 1);
    assert!(
        transitions(&p)
            .iter()
            .any(|t| t == "approval:release release release")
    );

    // A command that fails: `release failed` with its stderr.
    let (mut p, _) = at_release();
    fs::write(p.w.root.join("release.exit"), "1").unwrap();
    commands::queue(&p.w.db(), &Cmd::Release(ID.into()), "cli").unwrap();
    p.until(30, |w| w.stage(ID) == Some(Stage::Blocked));
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("release failed"));
    assert_eq!(m.why.as_deref(), Some("deploy.yml: workflow not found"));
    // My continue runs the command again (no rebuild of the merged PR).
    fs::write(p.w.root.join("release.exit"), "0").unwrap();
    p.gh.on(
        "api repos/me/web/deployments?environment=production*",
        &[("[]", "", 0)],
    );
    commands::queue(&p.w.db(), &Cmd::Approve(ID.into()), "cli").unwrap();
    p.until(30, |w| {
        fs::read_to_string(w.root.join("release.args"))
            .unwrap_or_default()
            .lines()
            .count()
            == 2
    });
    assert!(
        transitions(&p)
            .iter()
            .any(|t| t == "blocked approve release"),
        "{:?}",
        transitions(&p)
    );
    assert!(
        !transitions(&p)
            .iter()
            .any(|t| t.starts_with("blocked ") && t.ends_with(" build"))
    );
}

#[test]
fn test_no_release_block_done() {
    let (mut p, merge) = Pipe::merged(&live(), "towercab");
    release_script(&p);
    p.deploys("staging", 1, &merge, "ahead");
    p.step_to(ID, Stage::Done, 4);
    assert_eq!(p.root_file("release.args"), "");
    assert!(
        !transitions(&p)
            .iter()
            .any(|t| t.contains("approval:release"))
    );
    // A release block without live is ignored, and doctor says so.
    p.base(
        "web",
        &[(
            "TOWERCAB.md",
            "```release\ncommand: true\ndeploy: env:production\n```\n",
        )],
        "release only",
    );
    let out = towercab::doctor::doctor(&p.w.config, &p.w.home, &p.exes);
    assert!(
        out.lines()
            .any(|l| l == "web: release block without live: ignored"),
        "{out}"
    );
}

#[test]
fn test_release_production_e2e_red() {
    let (mut p, merge) = at_release();
    p.deploys("production", 9, &merge, "identical");
    p.e2e_exits(&[0, 1]);
    commands::queue(&p.w.db(), &Cmd::Release(ID.into()), "cli").unwrap();
    p.until(30, |w| w.stage(ID) == Some(Stage::Blocked));
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("production e2e red"));
    assert_eq!(m.why.as_deref(), Some("production e2e: exit 1"));
    // Once, no rerun, no revert in production.
    assert_eq!(p.e2e_runs(), 2);
    assert!(!transitions(&p).iter().any(|t| t.contains("rollback")));
    // My continue keeps it: done, nothing rebuilt.
    commands::queue(&p.w.db(), &Cmd::Approve(ID.into()), "cli").unwrap();
    p.until(30, |w| w.stage(ID) == Some(Stage::Done));
    assert!(transitions(&p).iter().any(|t| t == "blocked approve done"));
    assert_eq!(p.e2e_runs(), 2);
}

#[test]
fn test_revert_deploys_first() {
    use towercab::mission::{self, NewMission};
    use towercab::pipeline::deploy::behind_other;
    // A revert mission on its way holds every intent's deploy, e2e and release on its repo
    // (staging still has the broken merge), whatever the ids; a revert waits only for a
    // lower-id revert.
    let (p, _) = Pipe::merged(&live(), "towercab");
    let m = p.mission(ID);
    assert!(!p.cx(|cx| behind_other(cx, &m)).unwrap());
    let db = p.w.db();
    let other = db
        .tx(|tx| {
            mission::insert(
                tx,
                &NewMission {
                    intent: "261002-0900".into(),
                    slug: "other".into(),
                    repo: "web".into(),
                    model: "sonnet".into(),
                    a: None,
                    min_attempt: 1,
                },
                towercab::runloop::Tick::now(),
            )
        })
        .unwrap();
    assert!(other.id > m.id);
    let set = |id: i64, stage: &str, kind: &str| {
        db.conn()
            .execute(
                "UPDATE missions SET stage = ?1, kind = ?2 WHERE id = ?3",
                rusqlite::params![stage, kind, id],
            )
            .unwrap();
    };
    set(other.id, "revert_ci", "revert");
    assert!(p.cx(|cx| behind_other(cx, &m)).unwrap(), "behind a revert");
    set(other.id, "e2e", "intent");
    assert!(!p.cx(|cx| behind_other(cx, &m)).unwrap(), "a higher id");
    // The revert (higher id) goes first past a lower-id intent in e2e.
    set(other.id, "revert_deploy", "revert");
    set(m.id, "e2e", "intent");
    let other = mission::get(db.conn(), other.id).unwrap();
    assert!(!p.cx(|cx| behind_other(cx, &other)).unwrap());
    assert!(p.cx(|cx| behind_other(cx, &p.mission(ID))).unwrap());
}
