//! Towercab's checkout of the intent home, through the `git` CLI (INT-10).

use std::path::{Path, PathBuf};
use std::process::Command;

/// Identity and settings for every git call Towercab makes here.
const GIT_CONFIG: [&str; 6] = [
    "-c",
    "user.name=towercab",
    "-c",
    "user.email=towercab@localhost",
    "-c",
    "commit.gpgsign=false",
];

/// A git working tree on `main`; `origin` = it has an `origin` remote to pull from and push to.
#[derive(Debug, Clone)]
pub struct Checkout {
    pub path: PathBuf,
    pub origin: bool,
}

impl Checkout {
    /// A checkout at `path`; `origin` read from its remotes.
    pub fn new(path: &Path) -> Result<Checkout, String> {
        let mut c = Checkout {
            path: path.to_path_buf(),
            origin: false,
        };
        let not_checkout = || format!("intents: {} is not a git checkout", path.display());
        let top = c
            .git(&["rev-parse", "--show-toplevel"])
            .map_err(|_| not_checkout())?;
        let same = match (Path::new(top.trim()).canonicalize(), path.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same {
            return Err(not_checkout());
        }
        c.origin = c.git(&["remote", "get-url", "origin"]).is_ok();
        Ok(c)
    }

    /// `git clone --quiet <remote> <path>`.
    pub fn clone(remote: &str, path: &Path) -> Result<Checkout, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("clone failed: {e}"))?;
        }
        let out = Command::new("git")
            .args(GIT_CONFIG)
            .args(["clone", "--quiet", remote])
            .arg(path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("clone failed: git: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "clone failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Checkout::new(path)
    }

    /// Runs `git <args>` in the checkout; stdout on success, stderr (or stdout) on failure.
    pub fn git(&self, args: &[&str]) -> Result<String, String> {
        let out = Command::new("git")
            .args(GIT_CONFIG)
            .args(args)
            .current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| format!("git: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            } else {
                err
            })
        }
    }

    /// The checked-out branch, or `detached HEAD`.
    pub fn branch(&self) -> String {
        self.git(&["symbolic-ref", "--short", "-q", "HEAD"])
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "detached HEAD".into())
    }

    /// No staged, unstaged or untracked changes.
    pub fn is_clean(&self) -> Result<bool, String> {
        self.git(&["status", "--porcelain"])
            .map(|s| s.trim().is_empty())
    }

    /// `git pull --rebase --quiet origin main`; nothing without `origin`.
    pub fn pull(&self) -> Result<(), String> {
        if !self.origin {
            return Ok(());
        }
        self.git(&["pull", "--rebase", "--quiet", "origin", "main"])
            .map(drop)
            .map_err(|e| {
                // A stopped rebase would leave the checkout unusable for the next try.
                let _ = self.git(&["rebase", "--abort"]);
                format!("pull failed: {e}")
            })
    }

    /// `git add -A` and commit; `Ok(false)` when there was nothing to commit.
    pub fn commit(&self, msg: &str) -> Result<bool, String> {
        self.git(&["add", "-A"])?;
        if self.is_clean()? {
            return Ok(false);
        }
        self.git(&["commit", "--quiet", "-m", msg])
            .map(|_| true)
            .map_err(|e| format!("commit failed: {e}"))
    }

    /// `git push --quiet origin HEAD:main`; nothing without `origin`.
    pub fn push(&self) -> Result<(), String> {
        if !self.origin {
            return Ok(());
        }
        self.git(&["push", "--quiet", "origin", "HEAD:main"])
            .map(drop)
    }

    /// `git fetch origin main`.
    pub fn fetch(&self) -> Result<(), String> {
        self.git(&["fetch", "--quiet", "origin", "main"])
            .map(drop)
            .map_err(|e| format!("fetch failed: {e}"))
    }

    /// `git reset --hard origin/main` and drop untracked files.
    pub fn reset_to_origin(&self) -> Result<(), String> {
        self.reset("origin/main")
    }

    /// Throws away uncommitted changes (a write that failed half-way).
    pub fn discard(&self) -> Result<(), String> {
        self.reset("HEAD")
    }

    fn reset(&self, to: &str) -> Result<(), String> {
        self.git(&["reset", "--quiet", "--hard", to])?;
        self.git(&["clean", "-fdq"]).map(drop)
    }

    /// `git mv <from> <to>` (paths relative to the checkout).
    pub fn mv(&self, from: &str, to: &str) -> Result<(), String> {
        self.git(&["mv", from, to]).map(drop)
    }
}
