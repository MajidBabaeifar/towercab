//! The App's token never reaches a Claude run (LOOP-19, PIP-24): its environment is built from
//! nothing. Its own test binary: it sets `GH_TOKEN` and `GITHUB_TOKEN` in the process.

mod common;

use std::fs;
use std::time::Duration;

use common::app::{FakeGithub, key};
use towercab::child;
use towercab::claude::{self, Run, RunKind};
use towercab::config::{Config, IntentsConfig};
use towercab::exes::Exes;
use towercab::github::{App, Identity};

#[test]
fn test_token_never_in_claude_env() {
    let tmp = tempfile::tempdir().unwrap();
    // The loop holds an App token, and my shell's tokens are in its environment.
    let gh = FakeGithub::start(&["me/web"]);
    let pem = tmp.path().join("app.pem");
    key(&pem, false);
    let id = Identity::app(App::load(&pem, 3), &gh.http.url);
    let token = id.token("me/web", chrono::Utc::now().timestamp()).unwrap();
    // SAFETY: this test binary has no other test; nothing reads the environment concurrently.
    unsafe {
        std::env::set_var("GH_TOKEN", &token);
        std::env::set_var("GITHUB_TOKEN", "mine");
        std::env::set_var("LANG", "de_DE.UTF-8");
    }

    let mut config = Config::new(
        tmp.path().join("config.toml"),
        IntentsConfig {
            remote: None,
            path: tmp.path().join("intents"),
            cutoff: 7,
        },
    );
    config.agent.path = std::env::var("PATH").unwrap();
    let env = claude::env(&config);
    let keys: Vec<String> = env
        .iter()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        keys,
        [
            "HOME",
            "PATH",
            "LANG",
            "CLAUDE_CODE_ENABLE_TELEMETRY",
            "OTEL_METRICS_EXPORTER",
            "OTEL_LOGS_EXPORTER",
            "OTEL_EXPORTER_OTLP_PROTOCOL",
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
            "OTEL_METRIC_EXPORT_INTERVAL",
            "OTEL_SERVICE_NAME",
        ]
    );

    // The run itself: a fake claude dumps the environment it got.
    let bin = tmp.path().join("bin");
    let fake = bin.join("claude");
    common::exe(
        &fake,
        "env > \"$PWD/env.txt\"\necho '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ok\"}'\n",
    );
    let runs = tmp.path().join("runs");
    let r = Run::new(
        RunKind::Drafter,
        "sonnet",
        &runs,
        &runs,
        1,
        "draft",
        &config,
    );
    let exes = Exes {
        claude: fake.into(),
        ..Exes::default()
    };
    let spec = claude::prepare(&r, "", &config, &exes).unwrap();
    let mut c = child::spawn(&spec, Duration::ZERO).unwrap();
    let end = loop {
        if let Some(e) = c.poll(Duration::ZERO) {
            break e;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(end.status.unwrap().success());
    let got = fs::read_to_string(runs.join("env.txt")).unwrap();
    assert!(!got.contains(&token), "{got}");
    assert!(
        !got.contains("GH_TOKEN") && !got.contains("GITHUB_TOKEN"),
        "{got}"
    );
    assert!(got.contains("LANG=de_DE.UTF-8\n"), "{got}");
    assert!(got.contains("OTEL_SERVICE_NAME=towercab\n"), "{got}");
    assert!(
        got.contains(&format!("HOME={}\n", claude::home().display())),
        "{got}"
    );
}
