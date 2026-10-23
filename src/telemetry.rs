//! `towercab telemetry on|off|status` (MET-12): Claude Code's OpenTelemetry export for my own
//! sessions, in the `env` block of its user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else
//! `~/.claude/settings.json`), every other setting kept. A repo's `.claude/settings.json` can't
//! set these: Claude Code ignores OTEL exporter variables there. New sessions pick it up.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// The variables `on` writes: a Claude run's (`claude::env`) without `OTEL_SERVICE_NAME`.
pub fn vars(endpoint: &str) -> [(&'static str, String); 7] {
    [
        ("CLAUDE_CODE_ENABLE_TELEMETRY", "1".into()),
        ("OTEL_METRICS_EXPORTER", "otlp".into()),
        ("OTEL_LOGS_EXPORTER", "otlp".into()),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf".into()),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.into()),
        // Delta: Prometheus stores it as-is (otlp-native-delta-ingestion); dashboards sum.
        (
            "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
            "delta".into(),
        ),
        ("OTEL_METRIC_EXPORT_INTERVAL", "30000".into()),
    ]
}

/// `$CLAUDE_CONFIG_DIR/settings.json` (unset or empty: `~/.claude/settings.json`).
pub fn settings_path() -> Result<PathBuf, String> {
    let dir = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(".claude"),
    };
    Ok(dir.join("settings.json"))
}

/// `what` = `on`, `off` or `status` with the export to `endpoint` → the line printed.
pub fn run(what: &str, endpoint: &str) -> Result<String, String> {
    let path = settings_path()?;
    let shown = path.display().to_string();
    let err = |e: &dyn std::fmt::Display| format!("{shown}: {e}");
    let mut settings: Map<String, Value> = match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(Value::Object(m)) => m,
            Ok(_) => return Err(err(&"not a JSON object")),
            Err(e) => return Err(err(&e)),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(err(&e)),
    };
    let mut env = match settings.get("env") {
        None => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err(err(&"env is not a JSON object")),
    };
    let vars = vars(endpoint);
    let holds =
        |env: &Map<String, Value>, k: &str, v: &str| env.get(k).and_then(Value::as_str) == Some(v);
    match what {
        "status" => {
            let on = vars.iter().all(|(k, v)| holds(&env, k, v));
            return Ok(format!(
                "telemetry {} ({shown})",
                if on { "on" } else { "off" }
            ));
        }
        "on" => {
            for (k, v) in &vars {
                env.insert(k.to_string(), Value::String(v.clone()));
            }
        }
        "off" => {
            for (k, v) in &vars {
                if holds(&env, k, v) {
                    env.shift_remove(*k);
                }
            }
        }
        other => return Err(format!("telemetry: want on, off or status, got {other:?}")),
    }
    if env.is_empty() {
        settings.shift_remove("env");
    } else {
        settings.insert("env".into(), Value::Object(env));
    }
    let text = serde_json::to_string_pretty(&Value::Object(settings)).map_err(|e| err(&e))? + "\n";
    write_keeping(&path, &text).map_err(|e| err(&e))?;
    Ok(format!(
        "telemetry {what} ({shown}); applies to new Claude Code sessions"
    ))
}

/// Writes `text` to `path` whole: through a symlink to its target, via `<target>.tmp` + rename in
/// the target's directory, with the target's mode (a new file: 0600, `env` may hold tokens).
pub fn write_keeping(path: &Path, text: &str) -> std::io::Result<()> {
    let mut target = path.to_path_buf();
    for _ in 0..40 {
        match fs::symlink_metadata(&target) {
            Ok(m) if m.file_type().is_symlink() => {
                let to = fs::read_link(&target)?;
                target = match target.parent() {
                    Some(dir) if to.is_relative() => dir.join(to),
                    _ => to,
                };
            }
            _ => break,
        }
    }
    let mode = match fs::metadata(&target) {
        Ok(m) => m.permissions().mode() & 0o7777,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0o600,
        Err(e) => return Err(e),
    };
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = target.with_file_name(name);
    let written = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&tmp)?;
        // `mode` applies only on creation and through the umask: set it outright.
        f.set_permissions(fs::Permissions::from_mode(mode))?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, &target)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}
