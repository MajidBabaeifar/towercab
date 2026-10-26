//! Every config section and its defaults (LOOP-1). The only test in this binary: it sets
//! `HOME` and `PATH`.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use towercab::config::{
    AgentConfig, Config, GithubConfig, MetricsConfig, PoliciesConfig, TelegramConfig,
};

#[test]
fn test_config_loads() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let path = std::env::var("PATH").unwrap();
    // SAFETY: no other test runs in this binary, so nothing reads the environment concurrently.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("PATH", format!("/loop/bin:{path}"));
    }
    let file = tmp.path().join("config.toml");
    let load = |text: &str| {
        fs::write(&file, text).unwrap();
        Config::load(Some(&file))
    };

    // Every key, plus keys the Python version reads ([agent] provider, timeout, max_repairs;
    // [repos] verify) and a section nobody reads: ignored.
    let c = load(
        r#"
[intents]
remote = "https://github.com/me/intents.git"
cutoff = 9

[agent]
model = "claude-opus-4-5"
parallel = 3
drafter = "haiku"
build_timeout = 90
review_timeout = 20
check_timeout = 5
max_budget_usd = 12.5
ci_poll = 10
ci_grace = 0
ci_wait = 3600
path = "/usr/bin:/bin"
toolchain = ["~/.cargo", "/opt/go"]
sandbox_unix_sockets = true
provider = "claude"
timeout = 1200
max_repairs = 2

[repos.towercab]
github = "Me/towercab"
path = "~/towercab-clone"
verify = ["python3"]

[github]
app_id = 123456
me = "Majid-B"
api_base = "http://127.0.0.1:8080/"

[telegram]
bot_token = "123:abc"
chat_id = -1001234
api_base = "http://127.0.0.1:9090/tg//"

[metrics]
endpoint = "https://otel.example:4318"
prometheus = "http://prom:9090/"

[policies]
github = "me/agent-instructions"
base = "trunk"

[dashboard]
anything = true
"#,
    )
    .unwrap();
    assert_eq!(
        c.agent,
        AgentConfig {
            model: "claude-opus-4-5".into(),
            parallel: 3,
            drafter: "haiku".into(),
            build_timeout: Duration::from_secs(90 * 60),
            review_timeout: Duration::from_secs(20 * 60),
            check_timeout: Duration::from_secs(5 * 60),
            max_budget_usd: 12.5,
            ci_poll: Duration::from_secs(10),
            ci_grace: Duration::ZERO,
            ci_wait: Duration::from_secs(3600),
            path: "/usr/bin:/bin".into(),
            toolchain: vec![home.join(".cargo"), PathBuf::from("/opt/go")],
            sandbox_unix_sockets: true,
        }
    );
    assert_eq!(
        c.github,
        Some(GithubConfig {
            app_id: Some(123456),
            me: Some("Majid-B".into()),
            api_base: "http://127.0.0.1:8080".into(),
        }),
        "trailing / dropped"
    );
    assert_eq!(
        c.telegram,
        Some(TelegramConfig {
            bot_token: "123:abc".into(),
            chat_id: "-1001234".into(),
            api_base: "http://127.0.0.1:9090/tg".into(),
        }),
        "an integer chat_id kept as a string"
    );
    assert_eq!(
        c.metrics,
        MetricsConfig {
            endpoint: "https://otel.example:4318".into(),
            prometheus: "http://prom:9090".into(),
        }
    );
    assert_eq!(
        c.policies,
        PoliciesConfig {
            github: Some("me/agent-instructions".into()),
            base: "trunk".into(),
        }
    );
    assert_eq!(c.intents.cutoff, 9);
    assert_eq!(
        c.repo("towercab").unwrap().path,
        home.join("towercab-clone"),
        "Towercab's own clone"
    );
    assert_eq!(c.check_loop(), Ok(()));

    // Defaults: only [intents].
    let c = load("[intents]\nremote = \"r\"\n").unwrap();
    assert_eq!(
        c.agent,
        AgentConfig {
            model: "opus".into(),
            parallel: 1,
            drafter: "sonnet".into(),
            build_timeout: Duration::from_secs(60 * 60),
            review_timeout: Duration::from_secs(15 * 60),
            check_timeout: Duration::from_secs(10 * 60),
            max_budget_usd: 5.0,
            ci_poll: Duration::from_secs(30),
            ci_grace: Duration::from_secs(120),
            ci_wait: Duration::from_secs(1800),
            path: format!("/loop/bin:{path}"),
            toolchain: vec![
                home.join(".cargo/bin"),
                home.join(".rustup"),
                home.join(".local/bin"),
            ],
            sandbox_unix_sockets: false,
        },
        "path = the loop's PATH, toolchain under ~"
    );
    assert_eq!(c.agent, AgentConfig::default());
    assert_eq!(c.github, None);
    assert_eq!(c.telegram, None, "no [telegram]: no Telegram");
    assert_eq!(
        c.metrics,
        MetricsConfig {
            endpoint: "http://localhost:4318".into(),
            prometheus: "http://localhost:9090".into(),
        }
    );
    assert_eq!(
        c.policies,
        PoliciesConfig {
            github: None,
            base: "main".into(),
        }
    );
    assert_eq!(
        c,
        Config::new(c.file.clone(), c.intents.clone()),
        "Config::new = the defaults"
    );

    // Section defaults inside present sections; an integer budget.
    let c = load(
        "[intents]\nremote = \"r\"\n[agent]\nmax_budget_usd = 1000\n[github]\napp_id = 7\nme = \"m\"\n\
         [telegram]\nbot_token = \"t\"\nchat_id = \"42\"\n",
    )
    .unwrap();
    assert_eq!(c.agent.max_budget_usd, 1000.0);
    assert_eq!(
        c.github.unwrap().api_base,
        "https://api.github.com",
        "default api_base"
    );
    let tg = c.telegram.unwrap();
    assert_eq!(
        (tg.chat_id.as_str(), tg.api_base.as_str()),
        ("42", "https://api.telegram.org")
    );
    // The edges of each range load.
    let c = load(
        "[intents]\nremote = \"r\"\n[agent]\nparallel = 16\nbuild_timeout = 1440\n\
         review_timeout = 1\nci_poll = 5\nci_grace = 3600\nci_wait = 86400\nmax_budget_usd = 0.01\n",
    )
    .unwrap();
    assert_eq!(
        (
            c.agent.parallel,
            c.agent.build_timeout,
            c.agent.review_timeout
        ),
        (16, Duration::from_secs(86400), Duration::from_secs(60))
    );
    assert_eq!(
        (c.agent.ci_poll, c.agent.ci_grace, c.agent.ci_wait),
        (
            Duration::from_secs(5),
            Duration::from_secs(3600),
            Duration::from_secs(86400)
        )
    );
    assert_eq!(c.agent.max_budget_usd, 0.01);
}
