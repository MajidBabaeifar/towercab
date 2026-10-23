//! Children the loop runs without blocking (LOOP-4, LOOP-7, LOOP-12): each in its own process
//! group, env cleared then set, stdin from a file or `/dev/null`, stdout and stderr to files;
//! polled with `try_wait`.
//!
//! A timeout is run time (monotonic): the step's budget used up → SIGTERM to the group,
//! SIGKILL [`KILL_AFTER`] later. Towercab's own short `gh` and `git` calls block instead,
//! bounded by [`output`].

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
    /// Run time allowed: `spec.timeout`, less the step's earlier run time (the loop sets it).
    pub budget: Option<Duration>,
    /// The budget ran out: SIGTERM sent, its `ChildEnd` says so.
    pub timed_out: bool,
}

/// Starts `spec` (directories of its output files created; the files removed again when it
/// can't start).
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
    // Its output files exist only for a child that started: a handler re-entering a step reads
    // them as "it ran" (pipeline runs, release, rollback).
    let proc = c.spawn().map_err(|e| {
        let _ = std::fs::remove_file(&spec.stdout);
        let _ = std::fs::remove_file(&spec.stderr);
        shown(e)
    })?;
    let pid = proc.id();
    Ok(Child {
        proc,
        pid,
        start: start_time(pid),
        spec: spec.clone(),
        since: mono,
        termed: None,
        budget: spec.timeout,
        timed_out: false,
    })
}

impl Child {
    /// Ended → how; still running → `None`.
    pub fn poll(&mut self, mono: Duration) -> Option<ChildEnd> {
        match self.proc.try_wait() {
            Ok(Some(status)) => Some(ChildEnd {
                status: Some(status),
                timed_out: self.timed_out,
                run: mono.saturating_sub(self.since),
                stdout: self.spec.stdout.clone(),
                stderr: self.spec.stderr.clone(),
            }),
            Ok(None) => None,
            Err(_) => Some(ChildEnd {
                status: None,
                timed_out: self.timed_out,
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

    /// Its run time reached `budget` → timed out: SIGTERM to its group; SIGKILL `after` later
    /// (LOOP-12).
    pub fn enforce(&mut self, mono: Duration, after: Duration) {
        if !self.timed_out
            && self
                .budget
                .is_some_and(|b| mono.saturating_sub(self.since) >= b)
        {
            self.timed_out = true;
            self.term(mono);
        }
        self.kill_if_due(mono, after);
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

/// Towercab's own `gh` calls are killed after this (LOOP-10).
pub const GH_TIMEOUT: Duration = Duration::from_secs(120);

/// Towercab's own `git` calls are killed after this (LOOP-10); a stalled transfer fails
/// sooner (`GIT_HTTP_LOW_SPEED_LIMIT`/`_TIME`, `intents::git::git_command_for`).
pub const GIT_TIMEOUT: Duration = Duration::from_secs(300);

/// Runs `cmd` to its end like `Command::output`, in its own process group with stdin from
/// `/dev/null`, stdout and stderr read as it runs. Still running after `timeout` → its group
/// SIGKILLed and an error of kind `TimedOut`: `timed out after <n> s` (network, LOOP-10).
pub fn output(cmd: &mut Command, timeout: Duration) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::time::Instant;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn()?;
    fn drain<R: Read + Send + 'static>(r: Option<R>) -> Option<std::thread::JoinHandle<Vec<u8>>> {
        r.map(|mut r| {
            std::thread::spawn(move || {
                let mut b = Vec::new();
                let _ = r.read_to_end(&mut b);
                b
            })
        })
    }
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let end = Instant::now() + timeout;
    let mut nap = Duration::from_millis(1);
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break Some(s);
        }
        if Instant::now() >= end {
            kill_group(child.id());
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(nap);
        nap = (nap * 2).min(Duration::from_millis(50));
    };
    // A process that left the group may hold a pipe open: its output isn't waited for long.
    let collect = |h: Option<std::thread::JoinHandle<Vec<u8>>>| {
        let h = h?;
        let until = Instant::now() + Duration::from_secs(1);
        while !h.is_finished() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        if h.is_finished() { h.join().ok() } else { None }
    };
    let (stdout, stderr) = (collect(out), collect(err));
    match status {
        Some(status) => Ok(std::process::Output {
            status,
            stdout: stdout.unwrap_or_default(),
            stderr: stderr.unwrap_or_default(),
        }),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("timed out after {} s", timeout.as_secs()),
        )),
    }
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
