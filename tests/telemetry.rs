//! Claude Code's telemetry (MET-12): every Claude run's environment, and `towercab telemetry
//! on|off|status` for my own sessions (was `ops/telemetry`), always in a temp
//! `CLAUDE_CONFIG_DIR` or a temp `HOME`.

mod common;

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use towercab::claude;
use towercab::config::{Config, IntentsConfig};

/// `towercab [--config <cfg>] telemetry <args>` with `CLAUDE_CONFIG_DIR` = `dir` (`None`: unset,
/// so `<home>/.claude`) → (stdout, stderr, exit code).
fn telemetry(
    home: &Path,
    dir: Option<&Path>,
    cfg: Option<&Path>,
    args: &[&str],
) -> (String, String, Option<i32>) {
    let mut full: Vec<&str> = Vec::new();
    if let Some(c) = cfg {
        full.extend(["--config", c.to_str().unwrap()]);
    }
    full.push("telemetry");
    full.extend_from_slice(args);
    let mut c = common::towercab(home, &full);
    if let Some(d) = dir {
        c.env("CLAUDE_CONFIG_DIR", d);
    }
    common::output(&mut c)
}

fn read(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// What `on` writes with the default endpoint.
fn on_env() -> Value {
    json!({
        "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
        "OTEL_METRICS_EXPORTER": "otlp",
        "OTEL_LOGS_EXPORTER": "otlp",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
        "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "delta",
        "OTEL_METRIC_EXPORT_INTERVAL": "30000",
    })
}

#[test]
fn test_claude_env() {
    let tmp = tempfile::tempdir().unwrap();
    let mut config = Config::new(
        tmp.path().join("config.toml"),
        IntentsConfig {
            remote: None,
            path: tmp.path().join("intents"),
            cutoff: 7,
        },
    );
    config.metrics.endpoint = "http://collector:4318".into();
    let env: Vec<(String, String)> = claude::env(&config)
        .into_iter()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .filter(|(k, _)| k.starts_with("OTEL_") || k.starts_with("CLAUDE_"))
        .collect();
    let want: Vec<(String, String)> = [
        ("CLAUDE_CODE_ENABLE_TELEMETRY", "1"),
        ("OTEL_METRICS_EXPORTER", "otlp"),
        ("OTEL_LOGS_EXPORTER", "otlp"),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318"),
        ("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta"),
        ("OTEL_METRIC_EXPORT_INTERVAL", "30000"),
        ("OTEL_SERVICE_NAME", "towercab"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    assert_eq!(env, want);
    // `telemetry on` writes the same, minus the service name (the dashboard's Source).
    let vars: Vec<(String, String)> = towercab::telemetry::vars("http://collector:4318")
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    assert_eq!(vars, want[..7]);
}

#[test]
fn test_on_off_keeps_other_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let (home, dir) = (tmp.path().join("user"), tmp.path().join("claude"));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");
    fs::write(&path, r#"{"model": "opus", "env": {"FOO": "1"}}"#).unwrap();
    let shown = path.display();

    let (out, err, code) = telemetry(&home, Some(&dir), None, &["on"]);
    assert_eq!(code, Some(0), "{err}");
    assert_eq!(
        out,
        format!("telemetry on ({shown}); applies to new Claude Code sessions\n")
    );
    let s = read(&path);
    assert_eq!(s["model"], "opus");
    assert_eq!(s["env"]["FOO"], "1");
    for (k, v) in on_env().as_object().unwrap() {
        assert_eq!(&s["env"][k], v, "{k}");
    }
    assert!(s["env"].get("OTEL_SERVICE_NAME").is_none());
    let text = fs::read_to_string(&path).unwrap();
    assert!(
        text.ends_with("}\n") && text.contains("\n  \"env\": {"),
        "{text}"
    );
    assert!(!dir.join("settings.json.tmp").exists());
    assert_eq!(
        telemetry(&home, Some(&dir), None, &["status"]).0,
        format!("telemetry on ({shown})\n")
    );

    let (out, _, code) = telemetry(&home, Some(&dir), None, &["off"]);
    assert_eq!(code, Some(0));
    assert_eq!(
        out,
        format!("telemetry off ({shown}); applies to new Claude Code sessions\n")
    );
    assert_eq!(read(&path), json!({"model": "opus", "env": {"FOO": "1"}}));
    assert_eq!(
        telemetry(&home, Some(&dir), None, &["status"]).0,
        format!("telemetry off ({shown})\n")
    );

    // On and off again with nothing else in `env`: the block goes with them.
    fs::write(&path, r#"{"model": "opus"}"#).unwrap();
    telemetry(&home, Some(&dir), None, &["on"]);
    telemetry(&home, Some(&dir), None, &["off"]);
    assert_eq!(read(&path), json!({"model": "opus"}));

    // The endpoint is the config's `[metrics].endpoint`.
    let cfg = common::loop_config(
        tmp.path(),
        "[metrics]\nendpoint = \"http://collector:4318\"\n",
    );
    telemetry(&home, Some(&dir), Some(&cfg), &["on"]);
    assert_eq!(
        read(&path)["env"]["OTEL_EXPORTER_OTLP_ENDPOINT"],
        "http://collector:4318"
    );
    // Without it, status reads the default endpoint's values: off.
    assert_eq!(
        telemetry(&home, Some(&dir), None, &["status"]).0,
        format!("telemetry off ({shown})\n")
    );
}

#[test]
fn test_off_keeps_values_it_did_not_set() {
    let tmp = tempfile::tempdir().unwrap();
    let (home, dir) = (tmp.path().join("user"), tmp.path().join("claude"));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");
    fs::write(
        &path,
        r#"{"env": {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://elsewhere:4318", "OTEL_LOGS_EXPORTER": "otlp"}}"#,
    )
    .unwrap();
    assert_eq!(telemetry(&home, Some(&dir), None, &["off"]).2, Some(0));
    // Mine stays; what equals `on`'s value goes.
    assert_eq!(
        read(&path),
        json!({"env": {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://elsewhere:4318"}})
    );
}

#[test]
fn test_telemetry_creates_file_and_rejects_bad_args() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("user");
    // A directory that doesn't exist yet.
    let dir = tmp.path().join("new");
    assert_eq!(telemetry(&home, Some(&dir), None, &["on"]).2, Some(0));
    assert_eq!(read(&dir.join("settings.json"))["env"], on_env());
    // No CLAUDE_CONFIG_DIR: ~/.claude of HOME (a temp dir here).
    let (out, _, code) = telemetry(&home, None, None, &["on"]);
    assert_eq!(code, Some(0));
    let user = home.join(".claude/settings.json");
    assert!(out.contains(&user.display().to_string()), "{out}");
    assert_eq!(read(&user)["env"], on_env());
    // Another argument: a bad argument, nothing written.
    let (_, _, code) = telemetry(&home, Some(&dir), None, &["maybe"]);
    assert_eq!(code, Some(2));
    // A settings file that isn't a JSON object: refused, untouched.
    let bad = tmp.path().join("bad");
    fs::create_dir_all(&bad).unwrap();
    fs::write(bad.join("settings.json"), "[1, 2]\n").unwrap();
    let (_, err, code) = telemetry(&home, Some(&bad), None, &["on"]);
    assert_eq!(code, Some(1));
    assert!(err.contains("not a JSON object"), "{err}");
    assert_eq!(
        fs::read_to_string(bad.join("settings.json")).unwrap(),
        "[1, 2]\n"
    );
}

#[test]
fn test_telemetry_keeps_mode_link_and_order() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let tmp = tempfile::tempdir().unwrap();
    let (home, dir) = (tmp.path().join("user"), tmp.path().join("claude"));
    fs::create_dir_all(&dir).unwrap();
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o7777;

    // A 0600 file stays 0600, its keys in their order.
    let path = dir.join("settings.json");
    fs::write(
        &path,
        r#"{"model": "opus", "env": {"FOO": "1"}, "apiKeyHelper": "x"}"#,
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(telemetry(&home, Some(&dir), None, &["on"]).2, Some(0));
    assert_eq!(mode(&path), 0o600);
    let text = fs::read_to_string(&path).unwrap();
    let at = |k: &str| text.find(&format!("\"{k}\"")).unwrap();
    assert!(
        at("model") < at("env") && at("env") < at("apiKeyHelper"),
        "{text}"
    );
    assert!(at("FOO") < at("CLAUDE_CODE_ENABLE_TELEMETRY"), "{text}");
    assert_eq!(telemetry(&home, Some(&dir), None, &["off"]).2, Some(0));
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\n  \"model\": \"opus\",\n  \"env\": {\n    \"FOO\": \"1\"\n  },\n  \"apiKeyHelper\": \"x\"\n}\n"
    );
    assert_eq!(mode(&path), 0o600);
    // An `env` left empty goes without moving the keys after it.
    fs::write(&path, r#"{"env": {}, "a": 1, "b": 2, "c": 3}"#).unwrap();
    telemetry(&home, Some(&dir), None, &["on"]);
    telemetry(&home, Some(&dir), None, &["off"]);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n"
    );

    // A new file is 0600.
    let fresh = tmp.path().join("fresh");
    assert_eq!(telemetry(&home, Some(&fresh), None, &["on"]).2, Some(0));
    assert_eq!(mode(&fresh.join("settings.json")), 0o600);

    // A symlink (a dotfiles repo): the target changes, keeps its 0640, the link stays a link.
    let (dots, linked) = (tmp.path().join("dots"), tmp.path().join("linked"));
    fs::create_dir_all(&dots).unwrap();
    fs::create_dir_all(&linked).unwrap();
    let target = dots.join("claude-settings.json");
    fs::write(&target, r#"{"model": "opus"}"#).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    let link = linked.join("settings.json");
    symlink("../dots/claude-settings.json", &link).unwrap();
    assert_eq!(telemetry(&home, Some(&linked), None, &["on"]).2, Some(0));
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(read(&target)["env"], on_env());
    assert_eq!(mode(&target), 0o640);
    assert!(!dots.join("claude-settings.json.tmp").exists());
    assert!(!linked.join("settings.json.tmp").exists());
    assert_eq!(telemetry(&home, Some(&linked), None, &["off"]).2, Some(0));
    assert_eq!(read(&target), json!({"model": "opus"}));
}
