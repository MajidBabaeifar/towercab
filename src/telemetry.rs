//! `towercab telemetry on|off|status` (MET-12): Claude Code's OpenTelemetry export for my own
//! sessions, in the `env` block of its user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else
//! `~/.claude/settings.json`), every other setting kept. A repo's `.claude/settings.json` can't
//! set these: Claude Code ignores OTEL exporter variables there. New sessions pick it up.

use std::fs;
use std::path::PathBuf;

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
                    env.remove(*k);
                }
            }
        }
        other => return Err(format!("telemetry: want on, off or status, got {other:?}")),
    }
    if env.is_empty() {
        settings.remove("env");
    } else {
        settings.insert("env".into(), Value::Object(env));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| err(&e))?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(settings)).map_err(|e| err(&e))? + "\n";
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|e| err(&e))?;
    Ok(format!(
        "telemetry {what} ({shown}); applies to new Claude Code sessions"
    ))
}
