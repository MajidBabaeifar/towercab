//! The systemd user service: `up`, `down`, `logs` (LOOP-2), against fake `systemctl` and
//! `journalctl` on `PATH`.

mod common;

use std::fs;
use std::path::Path;

use common::{exe, loop_config, output, read, towercab};
use towercab::service::UNIT;

#[test]
fn test_unit_file() {
    let spec = read("specs/loop.md");
    let at = spec.find("**Unit**").expect("loop.md has **Unit**");
    let block = &spec[at..];
    let start = block.find("```ini\n").expect("an ini block") + "```ini\n".len();
    let end = start + block[start..].find("```").unwrap();
    assert_eq!(
        UNIT,
        &block[start..end],
        "service::UNIT is loop.md's **Unit**"
    );
    for line in [
        "ExecStart=%h/.cargo/bin/towercab run --watch",
        "Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "Restart=always",
        "RestartSec=30",
        "WantedBy=graphical-session.target",
    ] {
        assert!(UNIT.lines().any(|l| l == line), "LOOP-2: {line}");
    }
}

const SYSTEMCTL: &str = r#"d="$(dirname "$0")/.."
echo "$*" >> "$d/systemctl.log"
[ -f "$d/systemctl.err" ] && cat "$d/systemctl.err" >&2
exit "$(cat "$d/systemctl.code" 2>/dev/null || echo 0)"
"#;

fn calls(dir: &Path) -> Vec<String> {
    let calls = fs::read_to_string(dir.join("systemctl.log")).unwrap_or_default();
    let _ = fs::remove_file(dir.join("systemctl.log"));
    calls.lines().map(str::to_string).collect()
}

#[test]
fn test_up_down_logs() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let home = dir.join("home");
    fs::create_dir_all(&home).unwrap();
    exe(&dir.join("bin/systemctl"), SYSTEMCTL);
    exe(
        &dir.join("bin/journalctl"),
        "echo \"journalctl $*\"\necho \"PATH ok\" >&2\n",
    );
    let path = format!(
        "{}:{}",
        dir.join("bin").display(),
        std::env::var("PATH").unwrap()
    );
    let cfg = loop_config(dir, "");
    let run = |args: &[&str], xdg: Option<&Path>| {
        let mut full = vec!["--config", cfg.to_str().unwrap()];
        full.extend_from_slice(args);
        let mut c = towercab(&home, &full);
        c.env("PATH", &path).current_dir(dir);
        if let Some(x) = xdg {
            c.env("XDG_CONFIG_HOME", x);
        }
        output(&mut c)
    };
    let unit = home.join(".config/systemd/user/towercab.service");

    // No ~/.cargo/bin/towercab: refused, nothing written or started.
    let (_, stderr, code) = run(&["up"], None);
    assert_eq!(code, Some(1));
    assert_eq!(
        stderr,
        "towercab: ~/.cargo/bin/towercab is missing: cargo install --path . --locked\n"
    );
    assert!(!unit.exists());
    assert_eq!(calls(dir), Vec::<String>::new());

    // Installed: the unit written, systemd reloaded, the service enabled and started.
    exe(&home.join(".cargo/bin/towercab"), "exit 0\n");
    let (stdout, stderr, code) = run(&["up"], None);
    assert_eq!(code, Some(0), "{stderr}");
    assert_eq!(
        stdout,
        format!("started towercab.service ({})\n", unit.display())
    );
    assert_eq!(fs::read_to_string(&unit).unwrap(), UNIT);
    assert_eq!(
        calls(dir),
        [
            "--user daemon-reload",
            "--user enable --now towercab.service"
        ]
    );
    // $XDG_CONFIG_HOME/systemd/user when set (absolute); a stale unit is replaced.
    let xdg = dir.join("xdg");
    let xdg_unit = xdg.join("systemd/user/towercab.service");
    fs::create_dir_all(xdg_unit.parent().unwrap()).unwrap();
    fs::write(&xdg_unit, "[Service]\nExecStart=/old\n").unwrap();
    let (_, stderr, code) = run(&["up"], Some(&xdg));
    assert_eq!(code, Some(0), "{stderr}");
    assert_eq!(fs::read_to_string(&xdg_unit).unwrap(), UNIT);
    calls(dir);
    let (_, _, code) = run(&["up"], Some(Path::new("relative/xdg")));
    assert_eq!(code, Some(0));
    assert!(
        !dir.join("relative").exists() && !home.join("relative").exists(),
        "a relative XDG_CONFIG_HOME is ignored"
    );
    calls(dir);

    // down: disabled and stopped.
    let (stdout, stderr, code) = run(&["down"], None);
    assert_eq!(code, Some(0), "{stderr}");
    assert_eq!(stdout, "stopped towercab.service\n");
    assert_eq!(calls(dir), ["--user disable --now towercab.service"]);

    // systemctl fails → exit 1 with its stderr; up stops at the first failure.
    fs::write(dir.join("systemctl.code"), "1").unwrap();
    fs::write(
        dir.join("systemctl.err"),
        "Failed to connect to bus: No medium found\n",
    )
    .unwrap();
    let (_, stderr, code) = run(&["up"], None);
    assert_eq!(code, Some(1));
    assert_eq!(
        stderr,
        "towercab: systemctl --user daemon-reload: Failed to connect to bus: No medium found\n"
    );
    assert_eq!(calls(dir), ["--user daemon-reload"]);
    let (_, stderr, code) = run(&["down"], None);
    assert_eq!(code, Some(1));
    assert_eq!(
        stderr,
        "towercab: systemctl --user disable --now towercab.service: Failed to connect to bus: No medium found\n"
    );
    fs::remove_file(dir.join("systemctl.err")).unwrap();
    fs::write(dir.join("systemctl.code"), "3").unwrap();
    let (_, stderr, code) = run(&["down"], None);
    assert_eq!(code, Some(1));
    assert_eq!(
        stderr,
        "towercab: systemctl --user disable --now towercab.service: exit status: 3\n"
    );

    // logs: journalctl takes over the process.
    let (stdout, stderr, code) = run(&["logs"], None);
    assert_eq!(code, Some(0));
    assert_eq!(stdout, "journalctl --user -u towercab -f\n");
    assert_eq!(stderr, "PATH ok\n");
    let mut c = towercab(&home, &["--config", cfg.to_str().unwrap(), "logs"]);
    c.env("PATH", dir.join("nothing-here"));
    let (_, stderr, code) = output(&mut c);
    assert_eq!(code, Some(1));
    assert!(stderr.starts_with("towercab: journalctl: "), "{stderr}");
}
