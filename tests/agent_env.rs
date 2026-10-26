//! `[agent].env` and `sandbox_unix_sockets` (PIP-24): machine settings for runs and checks.

use towercab::config::Config;

#[test]
fn test_agent_env() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("config.toml");
    std::fs::write(
        &file,
        "[intents]\npath = \"/x\"\n\n[agent]\nenv = { CRATE_CC_NO_DEFAULTS = \"1\", RUST_LOG = \"warn\" }\n",
    )
    .unwrap();
    let c = Config::load(Some(&file)).unwrap();
    assert!(
        c.agent
            .env
            .contains(&("CRATE_CC_NO_DEFAULTS".into(), "1".into()))
    );
    // Passed to every Claude run and every sandboxed command.
    let run_env = towercab::claude::env(&c);
    assert!(
        run_env
            .iter()
            .any(|(k, v)| k == "CRATE_CC_NO_DEFAULTS" && v == "1")
    );
    let sbx =
        towercab::pipeline::sandbox::env(&c, tmp.path(), towercab::pipeline::sandbox::Cache::None);
    assert!(
        sbx.iter()
            .any(|(k, v)| k == "CRATE_CC_NO_DEFAULTS" && v == "1")
    );
    // A worker's cache variables point into its writable cache.
    let cache = towercab::claude::cache_env(std::path::Path::new("/h/cache/web/worker"));
    assert!(
        cache
            .iter()
            .any(|(k, v)| k == "XDG_CACHE_HOME" && v == "/h/cache/web/worker/xdg")
    );
    // Towercab's own variables can't be overridden; bad names refused.
    for bad in ["PATH = \"/x\"", "lower = \"1\"", "X = 1"] {
        std::fs::write(
            &file,
            format!("[intents]\npath = \"/x\"\n\n[agent]\nenv = {{ {bad} }}\n"),
        )
        .unwrap();
        assert!(
            Config::load(Some(&file)).unwrap_err().contains("agent.env"),
            "{bad}"
        );
    }
}
