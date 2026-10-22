//! The systemd user service (LOOP-2): `up`, `down`, `logs`.

use std::convert::Infallible;
use std::ffi::OsStr;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

use crate::config::expand;
use crate::exes::Exes;

/// loop.md **Unit**.
pub const UNIT: &str = "\
[Unit]
Description=Towercab

[Service]
ExecStart=%h/.cargo/bin/towercab run --watch
Environment=PATH=%h/.cargo/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=30
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=graphical-session.target
";

pub const SERVICE: &str = "towercab.service";

/// `$XDG_CONFIG_HOME/systemd/user/towercab.service` (an absolute `XDG_CONFIG_HOME`), else
/// `~/.config/systemd/user/towercab.service`.
pub fn unit_path() -> Result<PathBuf, String> {
    let config = match std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
        Some(d) if d.is_absolute() => d,
        _ => expand("~/.config")?,
    };
    Ok(config.join("systemd/user").join(SERVICE))
}

/// Writes the unit and enables and starts it. Refuses without `~/.cargo/bin/towercab`, the
/// binary the unit runs.
pub fn up(exes: &Exes) -> Result<String, String> {
    if !expand("~/.cargo/bin/towercab")?.is_file() {
        return Err("~/.cargo/bin/towercab is missing: cargo install --path . --locked".into());
    }
    let unit = unit_path()?;
    let dir = unit.parent().expect("unit_path has a parent");
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::fs::write(&unit, UNIT).map_err(|e| format!("{}: {e}", unit.display()))?;
    systemctl(exes, &["--user", "daemon-reload"])?;
    systemctl(exes, &["--user", "enable", "--now", SERVICE])?;
    Ok(format!("started {SERVICE} ({})", unit.display()))
}

/// Stops and disables the service: the loop gets SIGTERM (LOOP-7); missions stay.
pub fn down(exes: &Exes) -> Result<String, String> {
    systemctl(exes, &["--user", "disable", "--now", SERVICE])?;
    Ok(format!("stopped {SERVICE}"))
}

/// Replaces this process with `journalctl --user -u towercab -f`.
pub fn logs(exes: &Exes) -> Result<Infallible, String> {
    let e = Command::new(&exes.journalctl)
        .args(["--user", "-u", "towercab", "-f"])
        .exec();
    Err(format!("{}: {e}", exes.journalctl.to_string_lossy()))
}

/// `systemctl <args>`; non-zero → `systemctl <args>: <its stderr>`.
fn systemctl(exes: &Exes, args: &[&str]) -> Result<(), String> {
    let shown = format!("systemctl {}", args.join(" "));
    let out = Command::new(&exes.systemctl)
        .args(args.iter().map(OsStr::new))
        .output()
        .map_err(|e| format!("{shown}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(match stderr.is_empty() {
        true => format!("{shown}: {}", out.status),
        false => format!("{shown}: {stderr}"),
    })
}
