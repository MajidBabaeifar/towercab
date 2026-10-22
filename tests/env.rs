//! Network, auth and tool failures (LOOP-10): classified, retried with backoff, a fault per
//! kind; one open for 15 min → `env_blocked` (no picks, no wait timeouts, one message per
//! episode); the start-up preflight, rechecked every 5 min.

mod common;

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;
use std::time::Duration;

use common::world::{World, intent_file, open_pr};
use towercab::db::FaultRow;
use towercab::env::{self, Fault, FaultClass};
use towercab::exes::Exes;
use towercab::github::GhError;
use towercab::handler::{
    ChildEnd, ChildKind, ChildSpec, Ctx, Handler, Handlers, Outcome, Progress, StepError,
};
use towercab::machine::Stage;
use towercab::mission::Mission;
use towercab::pick::Pick;

const X: &str = "261001-0900";
const Y: &str = "261001-0901";

const DNS: &str =
    "fatal: unable to access 'https://github.com/me/web.git/': Could not resolve host: github.com";
const LOGIN: &str = "Invalid API key · Please run /login";

#[test]
fn test_classify() {
    for (text, want) in [
        (DNS, Some(FaultClass::Network)),
        (
            "ssh: connect to host github.com port 22: Connection refused",
            Some(FaultClass::Network),
        ),
        (
            "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
            Some(FaultClass::Network),
        ),
        (
            "Failed to connect to github.com port 443 after 130000 ms: Timed out",
            Some(FaultClass::Network),
        ),
        (
            "gnutls_handshake() failed: The TLS connection was non-properly terminated.",
            Some(FaultClass::Network),
        ),
        (
            "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
            Some(FaultClass::Network),
        ),
        (
            "The requested URL returned error: 503",
            Some(FaultClass::Network),
        ),
        (
            "The requested URL returned error: 401",
            Some(FaultClass::Auth),
        ),
        ("error: 503 Service Unavailable", Some(FaultClass::Network)),
        (
            "API Error: 500 {\"type\":\"error\"}",
            Some(FaultClass::Network),
        ),
        (
            "error connecting to api.github.com",
            Some(FaultClass::Network),
        ),
        (
            "HTTP 401: Bad credentials (https://api.github.com/user)",
            Some(FaultClass::Auth),
        ),
        (
            "fatal: Authentication failed for 'https://github.com/me/web.git/'",
            Some(FaultClass::Auth),
        ),
        (LOGIN, Some(FaultClass::Auth)),
        ("OAuth token has expired", Some(FaultClass::Auth)),
        (
            "fatal: not a git repository (or any of the parent directories): .git",
            None,
        ),
        (
            "GraphQL: Could not resolve to a PullRequest with the number of 9.",
            None,
        ),
        ("HTTP 404: Not Found", None),
        ("error: pathspec 'main' did not match", None),
        ("", None),
    ] {
        assert_eq!(env::classify(text), want, "{text}");
    }
    // The gh calls' check is the same classification.
    assert!(towercab::github::is_env_failure(DNS));
    assert!(!towercab::github::is_env_failure("HTTP 404: Not Found"));

    // Kinds, as `faults.kind` and `missions.fault` hold them, and their fixes.
    for (f, s) in [
        (Fault::Github, "github"),
        (Fault::Claude, "claude"),
        (Fault::Tool("cargo".into()), "tool:cargo"),
        (Fault::Sandbox, "sandbox"),
        (Fault::Secrets("web".into()), "secrets:web"),
    ] {
        assert_eq!(f.to_string(), s);
        assert_eq!(s.parse::<Fault>(), Ok(f));
    }
    assert!("tool:".parse::<Fault>().is_err());
    assert_eq!(
        Fault::Secrets("web".into()).fix(),
        "chmod 600 ~/.config/towercab/secrets/web.env"
    );
    let secs: Vec<u64> = (1..=7).map(|n| env::backoff(n).as_secs()).collect();
    assert_eq!(secs, [30, 60, 120, 240, 300, 300, 300]);
}

/// A stage that fails with `failing` while it is set; else `then`. Each call's (monotonic time,
/// `cx.timeouts`) logged.
#[derive(Clone)]
struct Flaky {
    failing: Rc<RefCell<Option<(Fault, String)>>>,
    then: Progress,
    calls: Rc<RefCell<Vec<(Duration, bool)>>>,
}

impl Flaky {
    fn new(then: Progress) -> Flaky {
        Flaky {
            failing: Rc::default(),
            then,
            calls: Rc::default(),
        }
    }

    fn fail(&self, f: Option<(Fault, &str)>) {
        *self.failing.borrow_mut() = f.map(|(f, e)| (f, e.to_string()));
    }

    fn calls(&self) -> usize {
        self.calls.borrow().len()
    }
}

impl Handler for Flaky {
    fn step(&mut self, cx: &mut Ctx<'_>, _: &Mission) -> Result<Progress, StepError> {
        self.calls.borrow_mut().push((cx.tick.mono, cx.timeouts));
        match self.failing.borrow().clone() {
            Some((f, e)) => Err(StepError::Env(f, e)),
            None => Ok(self.then.clone()),
        }
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Ok(Progress::Done(Outcome::ok()))
    }
}

/// A build that runs `<root>/bin/tool` (missing until the test writes it).
struct RunsTool;

impl Handler for RunsTool {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let runs = cx.runs(m);
        Ok(Progress::Spawn(ChildSpec {
            kind: ChildKind::Checks,
            argv: vec![cx.home.root.with_file_name("bin").join("tool").into()],
            cwd: cx.checkout(m),
            env: vec![],
            stdin: None,
            stdout: runs.join("tool.out"),
            stderr: runs.join("tool.err"),
            timeout: None,
            slot: true,
            model: None,
        }))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Ok(Progress::Done(Outcome::ok()))
    }
}

fn faults(w: &World) -> Vec<FaultRow> {
    env::faults(w.db().conn()).unwrap()
}

fn kinds(w: &World) -> Vec<String> {
    faults(w).into_iter().map(|f| f.kind).collect()
}

#[test]
fn test_network_blip_keeps_looping() {
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    w.prs.set(7, open_pr("h1"));
    let design = Flaky::new(Progress::Done(
        Outcome::ok()
            .with("pr", 7)
            .with("pr_url", "https://github.com/me/web/pull/7".to_string())
            .with("head", "h1".to_string()),
    ));
    design.fail(Some((Fault::Github, DNS)));
    let ci = Flaky::new(Progress::Poll {
        after: Duration::from_secs(30),
    });
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Design, Box::new(design.clone()));
    h.set(Stage::Build, Box::new(RunsTool));
    h.set(Stage::Ci, Box::new(ci.clone()));
    let mut lp = w.open(h);

    // A network failure: the step retries after 30 s, then 60 s; one fault, held by it.
    w.until(&mut lp, 10, |_| design.calls() == 1);
    let t1 = w.clock.unix();
    let m = w.mission(X);
    assert_eq!((m.stage, m.retries), (Stage::Design, 1));
    assert_eq!(m.retry_at, Some(t1 + 30.0));
    assert_eq!(m.fault.as_deref(), Some("github"));
    let f = &faults(&w)[0];
    assert_eq!(
        (f.kind.as_str(), f.since, f.error.as_str()),
        ("github", t1, DNS)
    );
    w.pass_after(&mut lp, 20);
    assert_eq!(design.calls(), 1, "not before its backoff");
    w.pass_after(&mut lp, 11);
    assert_eq!(design.calls(), 2);
    let m = w.mission(X);
    assert_eq!(m.retries, 2);
    assert_eq!(m.retry_at, Some(w.clock.unix() + 60.0));
    assert_eq!(faults(&w)[0].since, t1, "the same fault");
    // Back: the step succeeds, its fault closes; nothing was sent.
    design.fail(None);
    w.pass_after(&mut lp, 59);
    assert_eq!(design.calls(), 2);
    w.pass_after(&mut lp, 2);
    assert_eq!(design.calls(), 3);
    assert!(kinds(&w).is_empty());
    let m = w.mission(X);
    assert_ne!(m.stage, Stage::Design);
    assert_eq!((m.retries, m.fault), (0, None));

    // A program the step runs is missing: `tool:<path>`, retried; installed → closed.
    w.until(&mut lp, 10, |w| !kinds(w).is_empty());
    let tool = w.root.join("bin").join("tool");
    assert_eq!(kinds(&w), [format!("tool:{}", tool.display())]);
    assert_eq!(w.mission(X).stage, Stage::Build);
    common::exe(&tool, "exit 0\n");
    w.until(&mut lp, 10, |w| w.stage(X) == Some(Stage::Ci));
    assert!(kinds(&w).is_empty());

    // The loop's own PR reads fail: a `github` fault no mission holds; it stays while they
    // fail and closes at the recheck (`git ls-remote`) 5 min after the last failure.
    w.prs.fail(Some(GhError::Env(
        "Could not resolve host: api.github.com".into(),
    )));
    w.pass(&mut lp);
    assert_eq!(kinds(&w), ["github"]);
    assert_eq!(w.mission(X).fault, None);
    w.pass(&mut lp);
    w.prs.fail(None);
    w.pass_after(&mut lp, 200);
    assert_eq!(kinds(&w), ["github"], "rechecked only after 5 min");
    w.pass_after(&mut lp, 101);
    assert!(kinds(&w).is_empty(), "the recheck passed");
    assert!(ci.calls() > 0);

    // Never blocked, never a message, and every pass returned (`World::pass` unwraps it).
    assert_eq!(w.db().meta("env_episode").unwrap(), None);
    assert!(w.outbox().is_empty());
    lp.shutdown().unwrap();
}

#[test]
fn test_env_blocked_once() {
    let mut w = World::new(
        &[intent_file("261001-0900-x", "web", "u: 5\ni: 5\n", "X")],
        &["web", "api"],
    );
    // bwrap can't make namespaces: preflight opens `sandbox`, rechecked every 5 min.
    let bwrap = w.fakebin().join("bwrap");
    common::exe(
        &bwrap,
        "echo 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n",
    );
    let ci = Flaky::new(Progress::Poll {
        after: Duration::from_secs(30),
    });
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h.set(Stage::Ci, Box::new(ci.clone()));
    let mut lp = w.open(h);
    w.pass(&mut lp);
    assert_eq!(kinds(&w), ["sandbox"]);
    let t0 = faults(&w)[0].since;
    let blocked = |w: &World| w.db().meta("env_episode").unwrap();

    // X is picked and polls CI, wait timeouts on, until the fault is 15 min old.
    w.until(&mut lp, 10, |w| w.stage(X) == Some(Stage::Ci));
    while w.clock.unix() < t0 + 900.0 {
        assert_eq!(blocked(&w), None);
        w.pass(&mut lp);
    }
    assert!(ci.calls.borrow().iter().all(|(_, on)| *on));
    let episode = blocked(&w).expect("env blocked after 15 min");
    let rows = w.outbox();
    assert_eq!(
        rows,
        [(
            "loop".to_string(),
            "env_blocked".to_string(),
            episode.clone(),
            "env blocked: sandbox: bwrap --version: bwrap: setting up uid map: Permission denied\n\
             fix: check bwrap (unprivileged user namespaces)"
                .replace("bwrap --version", &format!("{} --version", bwrap.display()))
        )]
    );

    // Blocked: no wait timeouts; a new failure retries every 5 min; no picks.
    let before = ci.calls();
    w.pass(&mut lp);
    w.pass(&mut lp);
    assert!(ci.calls() > before);
    assert!(ci.calls.borrow()[before..].iter().all(|(_, on)| !*on));
    ci.fail(Some((Fault::Claude, LOGIN)));
    w.until(&mut lp, 5, |w| w.mission(X).retries == 1);
    let m = w.mission(X);
    assert_eq!(m.retry_at, Some(m.updated + 300.0), "5 min, not 30 s");
    w.intents.push_mine(
        &[(
            "intents/261001-0901-y/intent.md",
            Some(&common::intent_md("api", "u: 5\ni: 5\n", "Y")),
        )],
        "add Y",
    );
    for _ in 0..20 {
        w.pass(&mut lp);
    }
    assert_eq!(w.stage(Y), None, "no picks while blocked");
    assert!(lp.pick_state(w.clock).unwrap().env_blocked);
    assert_eq!(w.outbox().len(), 1, "one message per episode");
    assert_eq!(kinds(&w), ["sandbox", "claude"]);

    // Both fixed: X's retry closes `claude`, the recheck `sandbox`; the episode ends.
    ci.fail(None);
    common::exe(&bwrap, "echo 'bubblewrap 0.11.0'\n");
    w.until(&mut lp, 10, |w| blocked(w).is_none());
    assert!(kinds(&w).is_empty());
    w.until(&mut lp, 10, |w| w.stage(Y).is_some());
    let polls = ci.calls();
    w.pass(&mut lp);
    assert!(ci.calls.borrow()[polls..].iter().all(|(_, on)| *on));

    // A new episode: a new message.
    ci.fail(Some((Fault::Claude, LOGIN)));
    w.until(&mut lp, 25, |w| blocked(w).is_some_and(|e| e != episode));
    let rows = w.outbox();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[1].3,
        format!("env blocked: claude: {LOGIN}\nfix: run claude and /login, or check the network")
    );
    lp.shutdown().unwrap();
}

/// A fake program logging each call's argv (one line, space-joined) to `<dir>/calls`.
fn logged(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    common::exe(
        &path,
        &format!(
            "echo \"{name} $*\" >> {}\n{body}",
            dir.join("calls").display()
        ),
    );
    path
}

#[test]
fn test_preflight() {
    let mut w = World::new(&[], &["web", "api"]);
    let dir = w.root.join("pre");
    let git = logged(&dir, "git", "exec git \"$@\"\n");
    let mut exes = Exes {
        git: git.clone().into(),
        claude: logged(&dir, "claude", "exit 0\n").into(),
        cargo: logged(&dir, "cargo", "exit 0\n").into(),
        bwrap: logged(&dir, "bwrap", "exit 0\n").into(),
        systemd_inhibit: logged(&dir, "systemd-inhibit", "exit 0\n").into(),
        ..Exes::default()
    };
    let calls = || -> Vec<String> {
        fs::read_to_string(dir.join("calls"))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.ends_with("config --get remote.origin.url"))
            .map(str::to_string)
            .collect()
    };
    let root = w.root.clone();
    let origin = |name: &str| {
        root.join("repos")
            .join(format!("{name}.git"))
            .display()
            .to_string()
    };
    let remote = w.config.intents.remote.clone().unwrap();
    let mut identity = towercab::github::Identity::none();

    // All pass: each check on the unit's PATH, each kind reported passed.
    let got = env::preflight(&w.config, &exes, &mut identity);
    assert_eq!(
        calls(),
        [
            format!("git ls-remote {} HEAD", origin("api")),
            format!("git ls-remote {} HEAD", origin("web")),
            format!("git ls-remote {remote} HEAD"),
            "claude --version".into(),
            "cargo --version".into(),
            "bwrap --version".into(),
            "systemd-inhibit --version".into(),
        ]
    );
    let ok = |f: Fault| (f, Ok(()));
    assert_eq!(
        got,
        [
            ok(Fault::Github),
            ok(Fault::Github),
            ok(Fault::Github),
            ok(Fault::Tool("claude".into())),
            ok(Fault::Claude),
            ok(Fault::Tool("cargo".into())),
            ok(Fault::Tool("bwrap".into())),
            ok(Fault::Sandbox),
            ok(Fault::Tool("systemd-inhibit".into())),
        ]
    );

    // A repo without a clone is checked at its GitHub URL (not run here: its clone is back).
    let saved = w.clone_path("api").with_extension("away");
    fs::rename(w.clone_path("api"), &saved).unwrap();
    assert_eq!(
        env::github_urls(&w.config, &exes)[0],
        "https://github.com/me/api.git"
    );
    fs::rename(&saved, w.clone_path("api")).unwrap();

    // Failures: an unreachable origin (the other github checks skipped), claude failing,
    // cargo missing, bwrap failing; each opens its fault when the loop starts.
    common::git(
        &w.clone_path("api"),
        &["remote", "set-url", "origin", "/nonexistent/api.git"],
    );
    let claude = logged(
        &dir,
        "claude",
        "echo 'claude: broken install' >&2\nexit 1\n",
    );
    exes.cargo = dir.join("no-cargo").into();
    logged(
        &dir,
        "bwrap",
        "echo 'bwrap: No permissions to create new namespace' >&2\nexit 1\n",
    );
    fs::remove_file(dir.join("calls")).unwrap();
    let got = env::preflight(&w.config, &exes, &mut identity);
    assert_eq!(calls()[0], "git ls-remote /nonexistent/api.git HEAD");
    assert!(!calls().iter().any(|c| c.contains("web.git")));
    let kinds_got: Vec<(String, bool)> = got
        .iter()
        .map(|(f, r)| (f.to_string(), r.is_ok()))
        .collect();
    assert_eq!(
        kinds_got,
        [
            ("github".into(), false),
            ("claude".into(), false),
            ("tool:cargo".into(), false),
            ("sandbox".into(), false),
            ("tool:systemd-inhibit".into(), true),
        ]
    );
    let err = |kind: &str| {
        got.iter()
            .find(|(f, _)| f.to_string() == kind)
            .and_then(|(_, r)| r.clone().err())
            .unwrap()
    };
    assert!(err("github").starts_with(&format!(
        "{} ls-remote /nonexistent/api.git HEAD: ",
        git.display()
    )));
    assert_eq!(
        err("claude"),
        format!("{} --version: claude: broken install", claude.display())
    );
    assert_eq!(
        err("tool:cargo"),
        format!("{}: not found", dir.join("no-cargo").display())
    );

    let mut lp = w.open_with(Handlers::production(), exes.clone(), Default::default());
    assert!(kinds(&w).is_empty(), "checked in the first pass");
    w.pass(&mut lp);
    assert_eq!(kinds(&w), ["claude", "github", "sandbox", "tool:cargo"]);
    let since = faults(&w)[0].since;
    // Fixed: rechecked 5 min later (not before), each kind by its own check.
    logged(&dir, "claude", "exit 0\n");
    w.pass_after(&mut lp, 240);
    assert_eq!(kinds(&w).len(), 4);
    w.pass_after(&mut lp, 61);
    assert_eq!(kinds(&w), ["github", "sandbox", "tool:cargo"]);
    let github = faults(&w).into_iter().find(|f| f.kind == "github").unwrap();
    assert_eq!(
        github.since, since,
        "still failing: the same fault, renewed"
    );
    assert!(github.next_try > w.clock.unix() + 299.0);
    lp.shutdown().unwrap();
    drop(lp);

    // The next start: preflight passes for what was fixed, closing its faults.
    common::git(
        &w.clone_path("api"),
        &["remote", "set-url", "origin", &origin("api")],
    );
    exes.cargo = logged(&dir, "cargo", "exit 0\n").into();
    let mut lp = w.open_with(Handlers::production(), exes, Default::default());
    w.pass(&mut lp);
    assert_eq!(kinds(&w), ["sandbox"]);
    lp.shutdown().unwrap();
}
