//! `[intents]` config (INT-1). The only test in this binary: it sets process env vars.

use std::fs;
use std::path::Path;

use towercab::config::Config;

fn load(file: &Path, text: &str) -> Result<Config, String> {
    fs::write(file, text).unwrap();
    Config::load(Some(file))
}

#[test]
fn test_intents_config() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    fs::create_dir_all(home.join(".config/towercab")).unwrap();
    // SAFETY: no other test runs in this binary, so nothing reads the environment concurrently.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::remove_var("TOWERCAB_CONFIG");
    }
    let file = tmp.path().join("config.toml");

    let c = load(
        &file,
        "[intents]\nremote = \"git@x:me/intents.git\"\npath = \"~/intents\"\ncutoff = 9\n",
    )
    .unwrap();
    assert_eq!(c.file, file);
    assert_eq!(c.intents.remote.as_deref(), Some("git@x:me/intents.git"));
    assert_eq!(c.intents.path, home.join("intents"), "~/ expanded");
    assert_eq!(c.intents.cutoff, 9);

    // Defaults: path ~/.local/share/towercab/intents, cutoff 7.
    let c = load(
        &file,
        "[intents]\nremote = \"r\"\n[agent]\nmodel = \"sonnet\"\n",
    )
    .unwrap();
    assert_eq!(c.intents.path, home.join(".local/share/towercab/intents"));
    assert_eq!(c.intents.cutoff, 7);
    // Only a path is fine: an existing checkout.
    let c = load(&file, "[intents]\npath = \"/srv/intents\"\n").unwrap();
    assert_eq!(
        (c.intents.remote, c.intents.path.to_str()),
        (None, Some("/srv/intents"))
    );

    // [tasks] (the Python version's section) when [intents] is absent; [intents] wins.
    let c = load(&file, "[tasks]\nremote = \"old\"\ncutoff = 5\n").unwrap();
    assert_eq!(
        (c.intents.remote.as_deref(), c.intents.cutoff),
        (Some("old"), 5)
    );
    let c = load(
        &file,
        "[tasks]\nremote = \"old\"\n[intents]\nremote = \"new\"\n",
    )
    .unwrap();
    assert_eq!(c.intents.remote.as_deref(), Some("new"));

    let shown = file.display().to_string();
    let err = |text: &str| load(&file, text).unwrap_err();
    assert_eq!(
        err("[agent]\nmodel = \"x\"\n"),
        format!("config: {shown}: [intents] is missing")
    );
    assert_eq!(
        err("[intents]\ncutoff = 7\n"),
        format!("config: {shown}: intents.remote or intents.path is required")
    );
    assert_eq!(
        err("[tasks]\n"),
        format!("config: {shown}: tasks.remote or tasks.path is required")
    );
    for cutoff in ["0", "16", "\"7\"", "7.5"] {
        assert_eq!(
            err(&format!("[intents]\nremote = \"r\"\ncutoff = {cutoff}\n")),
            format!("config: {shown}: intents.cutoff must be an integer 1-15")
        );
    }
    assert_eq!(
        err("[intents]\nremote = 5\n"),
        format!("config: {shown}: intents.remote must be a string")
    );
    assert_eq!(
        err("[intents]\npath = [\"a\"]\n"),
        format!("config: {shown}: intents.path must be a string")
    );
    assert_eq!(
        err("intents = 3\n"),
        format!("config: {shown}: intents must be a table")
    );
    assert!(err("[intents\nremote = ").starts_with(&format!("config: {shown}: ")));
    let missing = tmp.path().join("nope.toml");
    assert!(
        Config::load(Some(&missing))
            .unwrap_err()
            .starts_with(&format!("config: {}: ", missing.display()))
    );

    // Where the file comes from: --config > TOWERCAB_CONFIG > ~/.config/towercab/config.toml.
    let by_env = tmp.path().join("env.toml");
    fs::write(&by_env, "[intents]\nremote = \"env\"\n").unwrap();
    fs::write(
        home.join(".config/towercab/config.toml"),
        "[intents]\nremote = \"home\"\n",
    )
    .unwrap();
    fs::write(&file, "[intents]\nremote = \"arg\"\n").unwrap();
    let remote = |c: Config| c.intents.remote.unwrap();
    assert_eq!(remote(Config::load(None).unwrap()), "home");
    // SAFETY: as above.
    unsafe { std::env::set_var("TOWERCAB_CONFIG", &by_env) };
    assert_eq!(remote(Config::load(None).unwrap()), "env");
    assert_eq!(remote(Config::load(Some(&file)).unwrap()), "arg");
}
