//! The `towercab` binary: `add`, `migrate`, `--version` (INT-2, INT-13, LOOP-15 so far).

mod common;

use std::path::Path;
use std::process::{Command, Output};

use chrono::{DateTime, Local};
use common::Home;
use regex::Regex;

fn towercab(home: &Path, args: &[&str], env: &[(&str, &Path)]) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_towercab"));
    cmd.args(args)
        .env("HOME", home)
        .env_remove("TOWERCAB_CONFIG")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[test]
fn test_add_command() {
    let home = Home::new(&[]);
    let user_home = home.tmp.path().join("home");
    std::fs::create_dir_all(&user_home).unwrap();
    let cfg = home.tmp.path().join("config.toml");
    std::fs::write(
        &cfg,
        format!(
            "[intents]\nremote = \"{}\"\npath = \"{}\"\n",
            home.remote.display(),
            home.checkout.display()
        ),
    )
    .unwrap();
    let cfg_s = cfg.to_str().unwrap();

    let before = Local::now();
    let out = towercab(
        &user_home,
        &[
            "--config",
            cfg_s,
            "add",
            "towercab: Ship the thing",
            "u4",
            "i5",
            "a3",
        ],
        &[],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    let c = Regex::new(r"^(\d{6}-\d{4}) intents/(\d{6}-\d{4})-ship-the-thing/intent\.md\n$")
        .unwrap()
        .captures(&stdout)
        .unwrap_or_else(|| panic!("stdout {stdout:?}"));
    assert_eq!(&c[1], &c[2]);
    let file = home.remote_file(&format!("intents/{}-ship-the-thing/intent.md", &c[1]));
    let started = Regex::new(r"(?m)^started: (.+)$")
        .unwrap()
        .captures(&file)
        .unwrap()[1]
        .to_string();
    assert_eq!(
        file,
        format!(
            "---\nrepo: towercab\nu: 4\ni: 5\na: 3\nsource: me\nstarted: {started}\n---\n\n# Intent: Ship the thing\n"
        )
    );
    let started = DateTime::parse_from_rfc3339(&started).unwrap();
    assert!(
        (started.timestamp() - before.timestamp()).abs() < 60,
        "started = now"
    );
    assert_eq!(
        started.offset().local_minus_utc(),
        before.offset().local_minus_utc(),
        "local offset"
    );
    assert_eq!(
        started.format("%y%m%d-%H%M").to_string(),
        c[1],
        "ID = creation minute"
    );
    assert_eq!(home.log()[0], format!("towercab: add {}", &c[1]));

    // TOWERCAB_CONFIG works too; scores are optional.
    let out = towercab(
        &user_home,
        &["add", "towercab:No scores"],
        &[("TOWERCAB_CONFIG", &cfg)],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).contains("-no-scores/intent.md"));

    // Bad arguments → exit 2, nothing written.
    let head = home.head();
    for args in [
        vec!["add", "no colon here"],
        vec!["add", ": no repo"],
        vec!["add", "towercab: "],
        vec!["add", "bad repo!: title"],
        vec!["add", "towercab: x", "u6"],
        vec!["add", "towercab: x", "u3", "u4"],
        vec!["add", "towercab: x", "q3"],
        vec!["add", "towercab: x", "u33"],
        vec!["add"],
        vec!["bogus"],
        vec![],
    ] {
        let mut full = vec!["--config", cfg_s];
        full.extend(args.iter());
        let out = towercab(&user_home, &full, &[]);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{args:?}: {}",
            text(&out.stderr)
        );
    }
    assert_eq!(home.head(), head);

    // Errors → stderr `towercab: <reason>`, exit 1.
    let out = towercab(
        &user_home,
        &["--config", "/nonexistent/c.toml", "add", "towercab: x"],
        &[],
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(
        text(&out.stderr).starts_with("towercab: config: /nonexistent/c.toml: "),
        "{}",
        text(&out.stderr)
    );
    let out = towercab(&user_home, &["add", "towercab: x"], &[]);
    assert_eq!(
        out.status.code(),
        Some(1),
        "no config at ~/.config/towercab/config.toml"
    );

    let out = towercab(&user_home, &["--version"], &[]);
    assert!(out.status.success());
    assert_eq!(
        text(&out.stdout),
        format!("towercab {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.3.0");

    // Old format: `add` refuses until `migrate` has run; `migrate` prints its summary.
    home.push_mine(
        &[(
            "TODO.md",
            Some("# TODO\n\n- [ ] 261017-1200 towercab: Old one\n"),
        )],
        "old",
    );
    let out = towercab(
        &user_home,
        &["--config", cfg_s, "add", "towercab: Too early"],
        &[],
    );
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        text(&out.stderr),
        "towercab: TODO.md is in the old format: run towercab migrate\n"
    );
    let out = towercab(&user_home, &["migrate", "--config", cfg_s], &[]);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert_eq!(
        text(&out.stdout),
        "migrated 1 intents (0 done), 0 lines to done/legacy.md\n"
    );
    assert!(home.remote_has("intents/261017-1200-old-one/intent.md"));
    let out = towercab(
        &user_home,
        &["--config", cfg_s, "add", "towercab: In time"],
        &[],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let out = towercab(&user_home, &["--config", cfg_s, "migrate"], &[]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        text(&out.stderr),
        "towercab: TODO.md is already generated: migrate has run\n"
    );
}
