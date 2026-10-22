//! The programs the loop runs, by path or name (tests point them at fakes).

use std::ffi::OsString;

#[derive(Debug, Clone, PartialEq)]
pub struct Exes {
    pub git: OsString,
    pub gh: OsString,
    pub claude: OsString,
    pub cargo: OsString,
    pub bwrap: OsString,
    pub systemd_inhibit: OsString,
    pub systemctl: OsString,
    pub journalctl: OsString,
}

impl Default for Exes {
    /// The names, looked up on `PATH` when run.
    fn default() -> Exes {
        Exes {
            git: "git".into(),
            gh: "gh".into(),
            claude: "claude".into(),
            cargo: "cargo".into(),
            bwrap: "bwrap".into(),
            systemd_inhibit: "systemd-inhibit".into(),
            systemctl: "systemctl".into(),
            journalctl: "journalctl".into(),
        }
    }
}

/// Where `exe` runs from: a path (with a `/`) if it is an executable file, else the first
/// executable `PATH` entry of that name.
pub fn which(exe: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let runs = |p: &std::path::Path| {
        p.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    let path = std::path::Path::new(exe);
    if path.components().count() > 1 {
        return runs(path).then(|| path.to_path_buf());
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(exe))
        .find(|c| runs(c))
}
