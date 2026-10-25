//! Stay awake while driving (LOOP-11): one `systemd-inhibit … sleep infinity` child while any
//! mission is driven, killed when none is; and wake detection, so no wait timeout fires
//! before its wait has polled again.

use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use crate::child::kill_group;
use crate::exes::Exes;
use crate::machine::Stage;
use crate::runloop::Tick;

/// After the inhibitor fails to start or exits on its own, the next try waits this long.
pub const RETRY: Duration = Duration::from_secs(60);

/// `systemd-inhibit`'s arguments for `why` (`<id> <stage>`).
pub fn args(why: &str) -> Vec<OsString> {
    [
        "--what=sleep:idle:handle-lid-switch",
        "--who=Towercab",
        &format!("--why={why}"),
        "--mode=block",
        "sleep",
        "infinity",
    ]
    .iter()
    .map(OsString::from)
    .collect()
}

/// The inhibitor child (not a slot, LOOP-4): in its own process group, dying with the loop
/// (`PR_SET_PDEATHSIG`), killed with its group when nothing is driven or on drop.
#[derive(Debug, Default)]
pub struct Inhibitor {
    child: Option<Child>,
    /// The `--why` it was started with.
    why: Option<String>,
    /// No new start before this (monotonic).
    retry_at: Option<Duration>,
}

impl Inhibitor {
    pub fn new() -> Inhibitor {
        Inhibitor::default()
    }

    /// Its pid while it runs.
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    /// The `--why` of the running inhibitor.
    pub fn why(&self) -> Option<&str> {
        self.child.as_ref().and(self.why.as_deref())
    }

    /// `driving`: the first driven mission (its id, stage), or none. Started when one is
    /// driven and none runs (not restarted on stage changes); killed when none is.
    pub fn update(&mut self, driving: Option<(String, Stage)>, exes: &Exes, mono: Duration) {
        if let Some(c) = &mut self.child
            && let Ok(Some(status)) = c.try_wait()
        {
            crate::tlog!("towercab: systemd-inhibit exited: {status}");
            kill_group(c.id());
            self.child = None;
            self.retry_at = Some(mono + RETRY);
        }
        let Some((id, stage)) = driving else {
            self.stop();
            return;
        };
        if self.child.is_some() || self.retry_at.is_some_and(|t| mono < t) {
            return;
        }
        let why = format!("{id} {stage}");
        let mut c = Command::new(&exes.systemd_inhibit);
        c.args(args(&why))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        // SAFETY: prctl only sets this process's parent-death signal (async-signal-safe).
        unsafe {
            c.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong);
                Ok(())
            });
        }
        match c.spawn() {
            Ok(child) => {
                self.child = Some(child);
                self.why = Some(why);
                self.retry_at = None;
            }
            Err(e) => {
                crate::tlog!("towercab: {}: {e}", exes.systemd_inhibit.to_string_lossy());
                self.retry_at = Some(mono + RETRY);
            }
        }
    }

    /// Kills it (its group: `systemd-inhibit` and its `sleep`).
    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            kill_group(c.id());
            let _ = c.wait();
        }
    }
}

impl Drop for Inhibitor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The machine slept between two passes: their wall-clock gap beyond the monotonic one
/// (which stops in suspend) is more than 3 × `pass`.
pub fn woke(last: Tick, now: Tick, pass: Duration) -> bool {
    let wall = (now.wall - last.wall).as_seconds_f64();
    let mono = now.mono.saturating_sub(last.mono).as_secs_f64();
    wall - mono > 3.0 * pass.as_secs_f64()
}
