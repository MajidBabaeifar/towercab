//! Children the loop runs without blocking (LOOP-4, LOOP-7, LOOP-12): each in its own process
//! group, env cleared then set, stdin from a file or `/dev/null`, stdout and stderr to files;
//! polled with `try_wait`.
//!
//! Part 2: spawn, poll, SIGTERM/SIGKILL of a group, a pid's start time. Timeouts come with
//! part 3.

use std::fs::File;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::handler::{ChildEnd, ChildSpec};

/// SIGTERM, then SIGKILL this long after (LOOP-7, LOOP-12).
pub const KILL_AFTER: Duration = Duration::from_secs(10);

/// A running child.
#[derive(Debug)]
pub struct Child {
    pub proc: std::process::Child,
    /// Its pid = its process group.
    pub pid: u32,
    /// `/proc/<pid>/stat` start time (clock ticks since boot).
    pub start: Option<u64>,
    pub spec: ChildSpec,
    /// Monotonic time it started.
    pub since: Duration,
    /// When SIGTERM was sent (monotonic).
    pub termed: Option<Duration>,
}

/// Starts `spec` (directories of its output files created).
pub fn spawn(spec: &ChildSpec, mono: Duration) -> Result<Child, String> {
    let (exe, args) = spec.argv.split_first().ok_or("child: empty argv")?;
    let shown = |e: std::io::Error| format!("{}: {e}", exe.to_string_lossy());
    for p in [&spec.stdout, &spec.stderr] {
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
    }
    let file = |p: &std::path::Path| File::create(p).map_err(|e| format!("{}: {e}", p.display()));
    let stdin = match &spec.stdin {
        Some(p) => Stdio::from(File::open(p).map_err(|e| format!("{}: {e}", p.display()))?),
        None => Stdio::null(),
    };
    let mut c = Command::new(exe);
    c.args(args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .stdin(stdin)
        .stdout(file(&spec.stdout)?)
        .stderr(file(&spec.stderr)?)
        .process_group(0);
    let proc = c.spawn().map_err(shown)?;
    let pid = proc.id();
    Ok(Child {
        proc,
        pid,
        start: start_time(pid),
        spec: spec.clone(),
        since: mono,
        termed: None,
    })
}

impl Child {
    /// Ended → how; still running → `None`.
    pub fn poll(&mut self, mono: Duration) -> Option<ChildEnd> {
        match self.proc.try_wait() {
            Ok(Some(status)) => Some(ChildEnd {
                status: Some(status),
                timed_out: false,
                run: mono.saturating_sub(self.since),
                stdout: self.spec.stdout.clone(),
                stderr: self.spec.stderr.clone(),
            }),
            Ok(None) => None,
            Err(_) => Some(ChildEnd {
                status: None,
                timed_out: false,
                run: mono.saturating_sub(self.since),
                stdout: self.spec.stdout.clone(),
                stderr: self.spec.stderr.clone(),
            }),
        }
    }

    /// SIGTERM to its group (once).
    pub fn term(&mut self, mono: Duration) {
        if self.termed.is_none() {
            signal_group(self.pid, libc::SIGTERM);
            self.termed = Some(mono);
        }
    }

    /// SIGTERM sent at least `after` ago and still running → SIGKILL to its group.
    pub fn kill_if_due(&mut self, mono: Duration, after: Duration) {
        if let Some(t) = self.termed
            && mono.saturating_sub(t) >= after
        {
            kill_group(self.pid);
        }
    }

    /// SIGTERM, wait up to `after`, then SIGKILL; reaps it.
    pub fn stop(&mut self, after: Duration) {
        signal_group(self.pid, libc::SIGTERM);
        let end = std::time::Instant::now() + after;
        while std::time::Instant::now() < end {
            if let Ok(Some(_)) = self.proc.try_wait() {
                kill_group(self.pid);
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        kill_group(self.pid);
        let _ = self.proc.wait();
    }
}

fn signal_group(pid: u32, sig: i32) {
    if let Ok(pid) = i32::try_from(pid)
        && pid > 1
    {
        // SAFETY: killpg only sends a signal; a gone group is ESRCH, ignored.
        unsafe {
            libc::killpg(pid, sig);
        }
    }
}

/// SIGKILL to process group `pid`.
pub fn kill_group(pid: u32) {
    signal_group(pid, libc::SIGKILL);
}

/// SIGTERM to process group `pid`.
pub fn term_group(pid: u32) {
    signal_group(pid, libc::SIGTERM);
}

/// Field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot); `None` when gone.
pub fn start_time(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name (field 2) is in parentheses and may hold spaces.
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(19)?.parse().ok()
}

/// A leftover child of an earlier loop: its group killed when `pid` still is that process
/// (same start time). True when it was killed.
pub fn kill_leftover(pid: u32, start: u64) -> bool {
    if start_time(pid) == Some(start) {
        kill_group(pid);
        true
    } else {
        false
    }
}
