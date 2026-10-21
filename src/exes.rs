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
