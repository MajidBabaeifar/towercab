//! A wrong type or range in any section stops every command; the loop's commands also need
//! `[github]` and valid `[repos]` (LOOP-1).

mod common;

use std::fs;

use common::{loop_config, output, towercab};
use towercab::config::Config;

#[test]
fn test_bad_config() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("config.toml");
    let shown = file.display().to_string();
    let intents = "[intents]\nremote = \"r\"\n";
    let err = |text: &str| {
        fs::write(&file, format!("{text}\n{intents}")).unwrap();
        Config::load(Some(&file))
            .expect_err(text)
            .strip_prefix(&format!("config: {shown}: "))
            .unwrap_or_else(|| panic!("{text}: error names the file"))
            .to_string()
    };
    let cases: &[(&str, &[&str], &str)] = &[
        ("agent = 1\n", &[""], "agent must be a table"),
        (
            "[agent]\nmodel = {v}\n",
            &["\"\"", "\"claude opus\"", "5", "[\"opus\"]"],
            "agent.model must be a non-empty string without whitespace",
        ),
        (
            "[agent]\ndrafter = {v}\n",
            &["\"\"", "\"a\tb\"", "true"],
            "agent.drafter must be a non-empty string without whitespace",
        ),
        (
            "[agent]\nparallel = {v}\n",
            &["0", "17", "\"2\"", "1.0", "-1"],
            "agent.parallel must be an integer 1-16",
        ),
        (
            "[agent]\nbuild_timeout = {v}\n",
            &["0", "1441", "\"60\"", "60.5"],
            "agent.build_timeout must be an integer 1-1440 (minutes)",
        ),
        (
            "[agent]\nreview_timeout = {v}\n",
            &["0", "1441"],
            "agent.review_timeout must be an integer 1-1440 (minutes)",
        ),
        (
            "[agent]\ncheck_timeout = {v}\n",
            &["-5", "100000"],
            "agent.check_timeout must be an integer 1-1440 (minutes)",
        ),
        (
            "[agent]\nmax_budget_usd = {v}\n",
            &["0", "0.0", "-1", "1000.01", "1001", "\"5\"", "nan", "inf"],
            "agent.max_budget_usd must be a number above 0, at most 1000",
        ),
        (
            "[agent]\nci_poll = {v}\n",
            &["4", "3601", "30.0"],
            "agent.ci_poll must be an integer 5-3600 (seconds)",
        ),
        (
            "[agent]\nci_grace = {v}\n",
            &["-1", "3601"],
            "agent.ci_grace must be an integer 0-3600 (seconds)",
        ),
        (
            "[agent]\nci_wait = {v}\n",
            &["59", "86401"],
            "agent.ci_wait must be an integer 60-86400 (seconds)",
        ),
        (
            "[agent]\npath = {v}\n",
            &["\"\"", "[\"/bin\"]"],
            "agent.path must be a non-empty string",
        ),
        (
            "[agent]\ntoolchain = {v}\n",
            &[
                "\"~/.cargo\"",
                "[\"rel/dir\"]",
                "[\"\"]",
                "[1]",
                "[\"~x/y\"]",
            ],
            "agent.toolchain must be a list of absolute paths (or ~/…)",
        ),
        ("github = \"x\"\n", &[""], "github must be a table"),
        (
            "[github]\napp_id = {v}\n",
            &["0", "-3", "\"123\"", "1.5"],
            "github.app_id must be an integer >= 1",
        ),
        (
            "[github]\nme = {v}\n",
            &["\"\"", "\"me@x\"", "\"a b\"", "\"under_score\"", "7"],
            "github.me must be a GitHub login ([A-Za-z0-9-])",
        ),
        (
            "[github]\napi_base = {v}\n",
            &[
                "\"api.github.com\"",
                "\"ftp://x\"",
                "\"https://\"",
                "\"https:///x\"",
                "\"http://a b\"",
                "1",
            ],
            "github.api_base must be an http:// or https:// URL",
        ),
        ("telegram = []\n", &[""], "telegram must be a table"),
        (
            "[telegram]\nchat_id = \"1\"\n",
            &[""],
            "telegram.bot_token is required",
        ),
        (
            "[telegram]\nbot_token = {v}\nchat_id = \"1\"\n",
            &["\"\"", "123"],
            "telegram.bot_token must be a non-empty string",
        ),
        (
            "[telegram]\nbot_token = \"t\"\n",
            &[""],
            "telegram.chat_id is required",
        ),
        (
            "[telegram]\nbot_token = \"t\"\nchat_id = {v}\n",
            &["\"\"", "1.5", "[1]"],
            "telegram.chat_id must be a non-empty string or an integer",
        ),
        (
            "[telegram]\nbot_token = \"t\"\nchat_id = 1\napi_base = {v}\n",
            &["\"tg\"", "false"],
            "telegram.api_base must be an http:// or https:// URL",
        ),
        (
            "[metrics]\nendpoint = {v}\n",
            &["\"localhost:4318\"", "4318"],
            "metrics.endpoint must be an http:// or https:// URL",
        ),
        (
            "[metrics]\nprometheus = {v}\n",
            &["\"prom\""],
            "metrics.prometheus must be an http:// or https:// URL",
        ),
        (
            "[policies]\ngithub = {v}\n",
            &["\"agent-instructions\"", "\"a/b/c\"", "1"],
            "policies.github must be \"<owner>/<name>\"",
        ),
        (
            "[policies]\nbase = {v}\n",
            &["\"\"", "\"a..b\"", "\"HEAD\"", "2"],
            "policies.base must be a branch name ([A-Za-z0-9._/-])",
        ),
    ];
    for (template, values, want) in cases {
        for v in *values {
            let text = template.replace("{v}", v);
            assert_eq!(err(&text), *want, "{text}");
        }
    }

    // Every command: exit 1, `towercab: config: <file>: <section>.<key> …`, nothing done.
    let home = tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let loop_home = tmp.path().join("loop-home");
    let lh = loop_home.to_str().unwrap();
    let file = loop_config(tmp.path(), "[agent]\nparallel = 0\n");
    let cfg = file.to_str().unwrap();
    let commands: &[&[&str]] = &[
        &["add", "towercab: x"],
        &["migrate"],
        &["review"],
        &["protect", "towercab"],
        &["up"],
        &["down"],
        &["logs"],
        &["run"],
        &["run", "--watch"],
        &["approve", "1"],
        &["retry", "--fresh", "1"],
        &["release", "1"],
        &["pause"],
        &["resume"],
        &["trust", "towercab"],
    ];
    for args in commands {
        let mut full = vec!["--config", cfg, "--home", lh];
        full.extend_from_slice(args);
        let (stdout, stderr, code) = output(&mut towercab(&home, &full));
        assert_eq!(code, Some(1), "{args:?}: {stderr}");
        assert_eq!(
            stderr,
            format!(
                "towercab: config: {}: agent.parallel must be an integer 1-16\n",
                file.display()
            ),
            "{args:?}"
        );
        assert_eq!(stdout, "", "{args:?}");
    }
    assert!(
        !loop_home.join("towercab.db").exists(),
        "no command got as far as the home"
    );

    // The loop's commands (`run`, `up`) need [github] app_id and me and valid [repos];
    // `pause` doesn't.
    let write = |text: &str| fs::write(&file, text).unwrap();
    let base = format!("[intents]\npath = \"{}\"\n", tmp.path().join("i").display());
    let repo_ok = "[repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n";
    for (text, want) in [
        (base.clone(), "github.app_id is required"),
        (
            format!("{base}[github]\nme = \"me\"\n"),
            "github.app_id is required",
        ),
        (
            format!("{base}[github]\napp_id = 3\n"),
            "github.me is required",
        ),
        (
            // The Python version's [repos.<name>]: no github.
            format!(
                "{base}[github]\napp_id = 3\nme = \"me\"\n{repo_ok}\
                 [repos.towercab]\npath = \"~/towercab\"\nverify = [\"make\"]\n"
            ),
            "repos.towercab.github is required",
        ),
    ] {
        write(&text);
        let c = Config::load(Some(&file)).expect("loads: only the loop needs these");
        assert_eq!(
            c.check_loop(),
            Err(format!("config: {}: {want}", file.display()))
        );
        for cmd in ["run", "up"] {
            let (_, stderr, code) =
                output(&mut towercab(&home, &["--config", cfg, "--home", lh, cmd]));
            assert_eq!(code, Some(1), "{cmd}: {stderr}");
            assert_eq!(
                stderr,
                format!("towercab: config: {}: {want}\n", file.display()),
                "{cmd}"
            );
        }
        let (stdout, stderr, code) = output(&mut towercab(
            &home,
            &["--config", cfg, "--home", lh, "pause"],
        ));
        assert_eq!(code, Some(0), "{stderr}");
        assert_eq!(stdout, "paused: no picks; merges and reverts hold\n");
    }
    write(&format!(
        "{base}[github]\napp_id = 3\nme = \"me\"\n{repo_ok}"
    ));
    assert_eq!(Config::load(Some(&file)).unwrap().check_loop(), Ok(()));
}
