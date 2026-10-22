//! The loop's home (LOOP-1, **Home**): `towercab.db`, `towercab.lock`, checkouts `work/`, run
//! files `runs/`. One loop per home (LOOP-15): `flock` on `towercab.lock`.

use std::collections::BTreeSet;
use std::fs::{DirBuilder, File};
use std::io::{Read, Seek, Write};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::config::expand;

pub const DEFAULT_HOME: &str = "~/.local/share/towercab";

#[derive(Debug, Clone, PartialEq)]
pub struct Home {
    pub root: PathBuf,
}

/// The held `flock` on `<home>/towercab.lock`; dropping it releases the lock (so does the
/// process dying).
#[derive(Debug)]
pub struct LoopLock {
    _file: File,
    pub path: PathBuf,
}

/// Lock files a [`LoopLock`] of this process holds.
static HELD: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

fn held() -> std::sync::MutexGuard<'static, BTreeSet<PathBuf>> {
    HELD.lock().unwrap_or_else(|e| e.into_inner())
}

impl Drop for LoopLock {
    fn drop(&mut self) {
        held().remove(&self.path);
    }
}

impl Home {
    /// `--home` (`dir`) > `TOWERCAB_HOME` > `~/.local/share/towercab` (`~/` expanded); the
    /// directory, `work/` and `runs/` are created 0700 when missing.
    pub fn resolve(dir: Option<&Path>) -> Result<Home, String> {
        let root = match dir {
            Some(d) => expand(&d.to_string_lossy())?,
            None => match std::env::var_os("TOWERCAB_HOME") {
                Some(d) if !d.is_empty() => expand(&d.to_string_lossy())?,
                _ => expand(DEFAULT_HOME)?,
            },
        };
        let home = Home { root };
        for dir in [
            home.root.clone(),
            home.root.join("work"),
            home.root.join("runs"),
        ] {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&dir)
                .map_err(|e| format!("home: {}: {e}", dir.display()))?;
        }
        Ok(home)
    }

    /// `<home>/towercab.db`.
    pub fn db(&self) -> PathBuf {
        self.root.join("towercab.db")
    }

    /// `<home>/towercab.lock`.
    pub fn lock_path(&self) -> PathBuf {
        self.root.join("towercab.lock")
    }

    /// Takes the home's lock without waiting and writes `<pid>\n` into it. Held elsewhere →
    /// `towercab is running (pid N); towercab down first`. Held, but by no `LoopLock` of this
    /// process and not by another pid, it is retried for up to 5 s: a child this process is
    /// forking holds a copy of the fd until its `exec` (another thread's spawn just as a loop
    /// was dropped).
    pub fn lock(&self) -> Result<LoopLock, String> {
        let end = std::time::Instant::now() + Duration::from_secs(5);
        let path = self.lock_path();
        loop {
            match self.try_lock() {
                Err(e)
                    if e.starts_with("towercab is running ")
                        && !held().contains(&path)
                        && self.holder().is_none_or(|p| p == std::process::id())
                        && std::time::Instant::now() < end =>
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(lock) => {
                    held().insert(lock.path.clone());
                    return Ok(lock);
                }
                r => return r,
            }
        }
    }

    fn try_lock(&self) -> Result<LoopLock, String> {
        let path = self.lock_path();
        let shown = |e: std::io::Error| format!("{}: {e}", path.display());
        let mut file = File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(shown)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                let pid = self
                    .holder()
                    .map_or_else(|| "?".to_string(), |p| p.to_string());
                return Err(format!(
                    "towercab is running (pid {pid}); towercab down first"
                ));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(shown(e)),
        }
        file.set_len(0).map_err(shown)?;
        file.rewind().map_err(shown)?;
        file.write_all(format!("{}\n", std::process::id()).as_bytes())
            .map_err(shown)?;
        Ok(LoopLock { _file: file, path })
    }

    /// The pid in the lock file while another open file holds the lock (this process's own
    /// [`LoopLock`] included); `None` when it is free.
    pub fn holder(&self) -> Option<u32> {
        let mut file = File::open(self.lock_path()).ok()?;
        if file.try_lock_shared().is_ok() {
            return None;
        }
        // The holder writes its pid right after taking the lock.
        for _ in 0..20 {
            let mut text = String::new();
            let _ = file.rewind();
            if file.read_to_string(&mut text).is_ok()
                && let Ok(pid) = text.trim().parse()
            {
                return Some(pid);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }

    /// A mission's checkout: `<home>/work/<id>-<attempt>` (LOOP-8).
    pub fn work(&self, id: &str, attempt: u32) -> PathBuf {
        self.root.join("work").join(format!("{id}-{attempt}"))
    }

    /// Run files: `<home>/runs/<dir>` (an intent id, `rehearse-<repo>-<yymmdd>`, `draft-<n>`).
    pub fn runs(&self, dir: &str) -> PathBuf {
        self.root.join("runs").join(dir)
    }
}
