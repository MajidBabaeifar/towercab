//! Towercab acts on GitHub as its App (LOOP-19): a JWT signed with `app.pem`, a 1-hour
//! installation token per repo (cached, re-minted under 10 min), `GH_TOKEN` for its `gh`
//! calls, the token through `gh auth git-credential` for git, commits as `towercab[bot]`.

mod common;

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use common::app::{BOT, BOT_EMAIL, FakeGithub, key, verify_jwt};
use common::world::{World, intent_file};
use common::{exe, git, github_git, github_repo};
use serde_json::{Value, json};
use towercab::config::{Config, GithubConfig, IntentsConfig, RepoConfig};
use towercab::db::Db;
use towercab::env::{self, Fault};
use towercab::events::{GhPrs, PrSource};
use towercab::exes::Exes;
use towercab::github::{App, Bot, GhError, Identity, github_of};
use towercab::handler::Handlers;
use towercab::intents::git::AuthFn;
use towercab::intents::{NewIntent, Store};
use towercab::machine::Stage;
use towercab::pick::Pick;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The fake API's requests as (method, path).
fn calls(gh: &FakeGithub) -> Vec<(String, String)> {
    gh.requests()
        .into_iter()
        .map(|r| (r.method, r.path))
        .collect()
}

#[test]
fn test_installation_token_per_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let pem = tmp.path().join("app.pem");
    let public = key(&pem, false);
    let gh = FakeGithub::start(&["me/a", "me/b"]);

    // The JWT: RS256 with the App's key, iat now - 60 s, exp now + 540 s, iss the app id.
    let app = App::load(&pem, 77).unwrap();
    let t = 1_800_000_000;
    assert_eq!(
        verify_jwt(&app.jwt(t), &public),
        json!({"iat": t - 60, "exp": t + 540, "iss": 77})
    );

    // One token per repo: installation (JWT) → access token for that repo only.
    let id = Identity::app(Ok(app), &format!("{}/", gh.http.url));
    let t = now();
    let a = id.token("me/a", t).unwrap();
    let b = id.token("me/b", t).unwrap();
    assert_eq!(
        gh.tokens(),
        [(11, a.clone()), (12, b.clone())],
        "a token per repo"
    );
    assert_eq!(
        calls(&gh),
        [
            ("GET".into(), "/repos/me/a/installation".into()),
            ("POST".into(), "/app/installations/11/access_tokens".into()),
            ("GET".into(), "/repos/me/b/installation".into()),
            ("POST".into(), "/app/installations/12/access_tokens".into()),
        ]
    );
    for r in gh.requests() {
        let jwt = r
            .header("authorization")
            .and_then(|h| h.strip_prefix("Bearer "))
            .expect("JWT");
        assert_eq!(verify_jwt(jwt, &public)["iss"], 77);
        assert_eq!(r.header("accept"), Some("application/vnd.github+json"));
    }
    let bodies: Vec<Value> = gh
        .requests()
        .iter()
        .filter(|r| r.method == "POST")
        .map(|r| serde_json::from_str(&r.body).unwrap())
        .collect();
    assert_eq!(
        bodies,
        [
            json!({"repositories": ["a"]}),
            json!({"repositories": ["b"]})
        ]
    );

    // Cached in memory while 10 min or more remain; re-minted (same installation) after.
    assert_eq!(id.token("me/a", t + 49 * 60).unwrap(), a);
    assert_eq!(id.token("ME/A", t).unwrap(), a, "owner/name in any case");
    assert_eq!(gh.tokens().len(), 2, "no new token");
    let a2 = id.token("me/a", t + 51 * 60).unwrap();
    assert_ne!(a2, a, "under 10 min left: re-minted");
    assert_eq!(
        calls(&gh).last().unwrap(),
        &("POST".into(), "/app/installations/11/access_tokens".into())
    );
    assert_eq!(calls(&gh).len(), 5, "the installation id is kept");

    // Not installed: GitHub's no; down or unauthorized: network or auth (LOOP-10).
    assert_eq!(
        id.token("me/c", t),
        Err(GhError::Failed(
            "the GitHub App isn't installed on me/c".into()
        ))
    );
    gh.down(Some(502));
    assert!(matches!(id.token("me/b", t + 3100), Err(GhError::Env(_))));
    gh.down(Some(401));
    let e = id.token("me/b", t + 3100).unwrap_err();
    assert!(matches!(e, GhError::Env(_)), "{e:?}");
    assert!(env::classify(&e.to_string()).is_some(), "{e}");
    gh.down(None);

    // The key: PKCS#8 loads too; readable by others, missing or not a key → refused, and an
    // identity without its key fails every call with why (a github fault, LOOP-10).
    let p8 = tmp.path().join("p8.pem");
    key(&p8, true);
    assert_eq!(App::load(&p8, 1).unwrap().app_id, 1);
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&p8, fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert_eq!(
        App::load(&p8, 1).unwrap_err(),
        format!("{}: mode 644, want 600", p8.display())
    );
    let junk = tmp.path().join("junk.pem");
    fs::write(&junk, "not a key").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&junk, fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert!(
        App::load(&junk, 1)
            .unwrap_err()
            .ends_with("not an RSA private key (PKCS#1 or PKCS#8 PEM)")
    );
    let mut config = Config::new(
        tmp.path().join("cfg/config.toml"),
        IntentsConfig {
            remote: None,
            path: tmp.path().join("intents"),
            cutoff: 7,
        },
    );
    config.github = Some(GithubConfig {
        app_id: Some(77),
        me: Some("me".into()),
        api_base: gh.http.url.clone(),
    });
    let missing = Identity::from_config(&config, &Exes::default());
    let before = gh.requests().len();
    match missing.token("me/a", t) {
        Err(GhError::Env(e)) => assert!(
            e.starts_with(&format!("{}/cfg/app.pem: ", tmp.path().display())),
            "{e}"
        ),
        other => panic!("{other:?}"),
    }
    assert_eq!(gh.requests().len(), before, "no call without a key");

    // The preflight mints each GitHub repo's token first (LOOP-10): one that fails → github.
    let hub = tmp.path().join("hub");
    github_repo(&hub, "me/a", &[]);
    github_repo(&hub, "me/c", &[]);
    let bin = tmp.path().join("bin");
    let exes = Exes {
        git: github_git(&bin, &hub).into(),
        ..common::fake_exes(&bin)
    };
    fs::create_dir_all(tmp.path().join("cfg")).unwrap();
    fs::copy(&pem, tmp.path().join("cfg/app.pem")).unwrap();
    for name in ["a", "c"] {
        config.repos.insert(
            name.into(),
            Ok(RepoConfig {
                name: name.into(),
                github: format!("me/{name}"),
                path: tmp.path().join("clones").join(name),
                base: "main".into(),
                workers: 1,
                bash: vec![],
            }),
        );
    }
    let mut app = Identity::from_config(&config, &exes);
    let results = env::preflight(&config, &exes, &mut app);
    let github: Vec<&Result<(), String>> = results
        .iter()
        .filter(|(f, _)| *f == Fault::Github)
        .map(|(_, r)| r)
        .collect();
    assert_eq!(github.len(), 2, "{results:?}");
    assert_eq!(github[0], &Ok(()), "me/a: token, then ls-remote");
    assert_eq!(
        github[1],
        &Err(
            "https://github.com/me/c.git: GitHub App: the GitHub App isn't installed on me/c"
                .into()
        )
    );
    let log = fs::read_to_string(bin.join("git.log")).unwrap();
    let ls: Vec<&str> = log.lines().filter(|l| l.contains("ls-remote")).collect();
    assert_eq!(ls.len(), 1, "{log}");
    assert!(ls[0].starts_with("tok-11-"), "with me/a's token: {}", ls[0]);
}

/// A fake `gh` in `dir`: `auth git-credential get` answers git's credential protocol with
/// `GH_TOKEN`; every call logs `<GH_TOKEN> <args>` to `<dir>/gh.log`.
fn fake_gh(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("gh");
    exe(
        &path,
        &format!(
            "echo \"${{GH_TOKEN:--}} $*\" >> '{log}'\n\
             if [ \"$1 $2\" = 'auth git-credential' ]; then\n\
               cat > /dev/null\n\
               [ \"$3\" = get ] && printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n' \"$GH_TOKEN\"\n\
               exit 0\n\
             fi\n\
             case \"$1\" in\n\
               pr) echo '{{\"state\":\"OPEN\",\"headRefOid\":\"h1\",\"mergeable\":\"MERGEABLE\",\"comments\":[],\"reviews\":[]}}' ;;\n\
               api) echo '[]' ;;\n\
             esac\n",
            log = dir.join("gh.log").display()
        ),
    );
    path
}

#[test]
fn test_git_uses_app_token() {
    let tmp = tempfile::tempdir().unwrap();
    let pem = tmp.path().join("app.pem");
    key(&pem, false);
    let gh = FakeGithub::start(&["me/a", "me/web"]);
    let bin = tmp.path().join("bin");
    let fake = fake_gh(&bin);
    let id = Identity::app(App::load(&pem, 5), &gh.http.url).with_gh(fake.as_os_str());

    // What git gets: my helpers dropped, gh's helper with GH_TOKEN, the bot as author.
    let auth = id.git_auth("me/a").unwrap();
    let token = gh.tokens()[0].1.clone();
    let quoted = format!("'{}'", fake.display());
    assert_eq!(
        auth.args,
        [
            "-c".to_string(),
            "credential.helper=".into(),
            "-c".into(),
            format!("credential.helper=!{quoted} auth git-credential"),
            "-c".into(),
            format!("user.name={BOT}"),
            "-c".into(),
            format!("user.email={BOT_EMAIL}"),
        ]
    );
    assert_eq!(auth.env, [("GH_TOKEN".to_string(), token.clone())]);
    assert_eq!(
        id.auth_for_url("https://github.com/me/a.git").unwrap(),
        auth
    );
    assert_eq!(
        id.auth_for_url("git@github.com:me/a.git").unwrap(),
        Default::default(),
        "not HTTPS: the token can't be used"
    );
    assert_eq!(id.auth_for_url("/srv/a.git").unwrap(), Default::default());
    assert_eq!(github_of("https://github.com/me/a"), Some("me/a".into()));
    assert_eq!(
        github_of("https://github.com/me/a.git/"),
        Some("me/a".into())
    );
    assert_eq!(github_of("https://example.com/me/a.git"), None);

    // git asks the helper and gets the token (git ignores GH_TOKEN itself).
    let mut cmd = Command::new("git");
    cmd.args(&auth.args)
        .args(["credential", "fill"])
        .envs(auth.env.iter().map(|(k, v)| (k, v)))
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", tmp.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"protocol=https\nhost=github.com\npath=me/a.git\n\n")
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let filled = String::from_utf8_lossy(&out.stdout);
    assert!(filled.contains(&format!("password={token}\n")), "{filled}");

    // Its gh calls: GH_TOKEN = the repo's token (my GITHUB_TOKEN never wins); PR reads too.
    let none = Identity::none().with_gh(fake.as_os_str());
    none.gh("me/a", &["api", "x"]).unwrap();
    id.gh("me/a", &["api", "y"]).unwrap();
    let mut prs = GhPrs {
        identity: id.clone(),
    };
    prs.read("me/web", 7).unwrap();
    let web = gh.tokens().last().unwrap().1.clone();
    let log = fs::read_to_string(bin.join("gh.log")).unwrap();
    let lines: Vec<&str> = log
        .lines()
        .filter(|l| !l.contains("git-credential"))
        .collect();
    assert_eq!(
        lines,
        [
            "- api x".to_string(),
            format!("{token} api y"),
            format!(
                "{web} pr view 7 -R me/web --json state,mergedAt,mergeCommit,headRefOid,mergeable,comments,reviews"
            ),
            format!("{web} api --paginate --slurp repos/me/web/pulls/7/comments?per_page=100"),
        ]
    );

    // The loop's pick clones and fetches as the App (a clone of https://github.com/…).
    let hub = tmp.path().join("hub");
    github_repo(&hub, "me/web", &[("CLAUDE.md", common::world::CLAUDE)]);
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &[]);
    let root = w.root.clone();
    fs::copy(&pem, root.join("app.pem")).unwrap();
    let g = w.config.github.as_mut().unwrap();
    (g.app_id, g.api_base) = (Some(5), gh.http.url.clone());
    w.config.repos.insert(
        "web".into(),
        Ok(RepoConfig {
            name: "web".into(),
            github: "me/web".into(),
            path: root.join("clones/web"),
            base: "main".into(),
            workers: 1,
            bash: vec![],
        }),
    );
    let wbin = root.join("wbin");
    let exes = Exes {
        git: github_git(&wbin, &hub).into(),
        gh: fake.clone().into(),
        ..w.exes()
    };
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    let mut lp = w.open_with(h, exes, Default::default());
    w.until(&mut lp, 10, |w| {
        w.stage("261001-0900") == Some(Stage::Design)
    });
    let web = gh.tokens().last().unwrap().1.clone();
    let log = fs::read_to_string(wbin.join("git.log")).unwrap();
    let net: Vec<&str> = log
        .lines()
        .filter(|l| {
            l.contains("clone --quiet -- https://github.com/me/web.git")
                || l.contains("fetch --quiet --prune origin")
        })
        .collect();
    assert_eq!(net.len(), 2, "{log}");
    for l in net {
        assert!(l.starts_with(&format!("{web} ")), "{l}");
        assert!(
            l.contains(&format!("credential.helper=!{quoted} auth git-credential")),
            "{l}"
        );
    }
    assert_eq!(
        git(
            &root.join("clones/web"),
            &["config", "--get", "remote.origin.url"]
        )
        .trim(),
        "https://github.com/me/web.git"
    );
}

#[test]
fn test_commit_author_is_bot() {
    let gh = FakeGithub::start(&["me/intents"]);
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    let root = w.root.clone();
    key(&root.join("app.pem"), false);
    let g = w.config.github.as_mut().unwrap();
    (g.app_id, g.api_base) = (Some(5), gh.http.url.clone());

    // Towercab's intents checkout: origin https://github.com/me/intents.git (the bare repo
    // through this checkout's own insteadOf), as [intents].remote says.
    let url = "https://github.com/me/intents.git";
    let co = w.intents.checkout.clone();
    fs::create_dir_all(co.parent().unwrap()).unwrap();
    git(
        co.parent().unwrap(),
        &[
            "clone",
            "--quiet",
            w.intents.remote.to_str().unwrap(),
            co.to_str().unwrap(),
        ],
    );
    git(&co, &["remote", "set-url", "origin", url]);
    git(
        &co,
        &[
            "config",
            &format!("url.{}.insteadOf", w.intents.remote.display()),
            url,
        ],
    );
    w.config.intents.remote = Some(url.into());

    // A store write as the App: author and committer are the bot.
    let id = Identity::from_config(&w.config, &Exes::default());
    let auth_id = id.clone();
    let auth: AuthFn = Box::new(move || auth_id.auth_for_url(url).map_err(|e| e.to_string()));
    let store = Store::open_as(&w.config, Some(auth)).unwrap();
    store
        .add(NewIntent {
            repo: "web".into(),
            title: "Y".into(),
            u: None,
            i: None,
            a: None,
            source: "me".into(),
            created: common::t("2026-10-15T13:31:00+02:00"),
        })
        .unwrap();
    let who = |rev: &str| {
        git(
            &w.intents.remote,
            &["log", "-1", "--format=%an <%ae>|%cn <%ce>", rev],
        )
        .trim()
        .to_string()
    };
    let bot = format!("{BOT} <{BOT_EMAIL}>");
    assert_eq!(who("main"), format!("{bot}|{bot}"));
    assert_eq!(id.cached_bot(), Some(Bot::new("towercab", 42)));

    // The loop: its intent writes as the bot too, the bot kept in meta.bot, looked up once.
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    let mut lp = w.open(h);
    w.until(&mut lp, 10, |w| {
        w.stage("261001-0900") == Some(Stage::Design)
    });
    w.pass(&mut lp);
    let subjects = git(&w.intents.remote, &["log", "--format=%s|%an|%cn", "main"]);
    let entry = subjects
        .lines()
        .find(|l| l.starts_with("towercab: pick 261001-0900"))
        .expect("the entry write");
    assert_eq!(entry, format!("towercab: pick 261001-0900|{BOT}|{BOT}"));
    let db = Db::open(&w.home.db()).unwrap();
    assert_eq!(db.meta("bot").unwrap().as_deref(), Some("towercab 42"));
    drop(lp);
    let app_calls = |gh: &FakeGithub| gh.requests().iter().filter(|r| r.path == "/app").count();
    let before = app_calls(&gh);
    let lp = w.open(Handlers::stubs());
    assert_eq!(
        lp.identity.cached_bot(),
        Some(Bot::new("towercab", 42)),
        "from meta.bot"
    );
    assert_eq!(app_calls(&gh), before, "no lookup");
}

#[test]
fn test_app_manifest() {
    let m: Value = serde_json::from_str(&common::read("ops/github-app.json")).unwrap();
    assert_eq!(m["name"], "towercab");
    assert_eq!(m["url"], "https://github.com/MajidBabaeifar/towercab");
    assert_eq!(m["public"], false);
    assert_eq!(
        m["hook_attributes"],
        json!({"url": "https://github.com/MajidBabaeifar/towercab", "active": false})
    );
    assert_eq!(
        m["default_permissions"],
        json!({
            "contents": "write",
            "pull_requests": "write",
            "issues": "write",
            "checks": "write",
            "statuses": "write",
            "workflows": "write",
            "actions": "write",
            "deployments": "read",
            "metadata": "read",
        })
    );
    assert_eq!(m["default_events"], json!([]));
}
