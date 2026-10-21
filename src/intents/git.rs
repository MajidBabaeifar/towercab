//! Towercab's checkout of the intent home, through the `git` CLI (INT-10).

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The generated views: a rebase conflict in them is resolved by taking `main`'s side, since
/// the next write regenerates them (INT-10).
pub const VIEWS: [&str; 2] = ["TODO.md", "DONE.md"];

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
    /// Its absolute git directory (`.git`, or the worktree's).
    pub git_dir: PathBuf,
}

impl Checkout {
    /// A checkout at `path`; `origin` read from its remotes.
    pub fn new(path: &Path) -> Result<Checkout, String> {
        let mut c = Checkout {
            path: path.to_path_buf(),
            origin: false,
            git_dir: PathBuf::new(),
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
        c.git_dir = PathBuf::from(c.git(&["rev-parse", "--absolute-git-dir"])?.trim());
        Ok(c)
    }

    /// Blocks until this process holds `<git dir>/towercab.lock` (`flock`), so one store
    /// operation at a time runs on the checkout, across threads and processes. Dropping the
    /// file releases it.
    pub fn lock(&self) -> Result<File, String> {
        let path = self.git_dir.join("towercab.lock");
        let f = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        f.lock().map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(f)
    }

    /// A rebase is stopped in the checkout (a run was killed during `pull`).
    pub fn rebase_in_progress(&self) -> bool {
        ["rebase-merge", "rebase-apply"]
            .iter()
            .any(|d| self.git_dir.join(d).exists())
    }

    /// Aborts a rebase a killed run left behind, back to the branch it started on. Only call
    /// it while holding [`Checkout::lock`].
    pub fn recover(&self) -> Result<(), String> {
        if self.rebase_in_progress() {
            self.git(&["rebase", "--abort"])
                .map_err(|e| format!("intents: {}: rebase --abort: {e}", self.path.display()))?;
        }
        Ok(())
    }

    /// Subjects of the commits on `HEAD` that aren't on `origin/main`, oldest first.
    pub fn local_commits(&self) -> Result<Vec<String>, String> {
        if !self.origin {
            return Ok(Vec::new());
        }
        Ok(self
            .git(&["log", "--reverse", "--format=%s", "origin/main..HEAD"])?
            .lines()
            .map(str::to_string)
            .collect())
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
            .env("GIT_EDITOR", "true")
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

    /// `git fetch origin main`, then fast-forward, or rebase local commits (a write that stopped
    /// before its push) onto `origin/main`. A conflict only in [`VIEWS`] takes `main`'s side; any
    /// other conflict drops the local commits (`reset --hard origin/main`) and fails naming them.
    /// Nothing without `origin`.
    pub fn pull(&self) -> Result<(), String> {
        if !self.origin {
            return Ok(());
        }
        let failed = |e: String| format!("pull failed: {e}");
        self.git(&["fetch", "--quiet", "origin", "main"])
            .map_err(failed)?;
        let local = self.local_commits().map_err(failed)?;
        if local.is_empty() {
            return self
                .git(&["merge", "--quiet", "--ff-only", "origin/main"])
                .map(drop)
                .map_err(failed);
        }
        let mut step = self.git(&["rebase", "--quiet", "origin/main"]);
        for _ in 0..=local.len() {
            if step.is_ok() {
                return Ok(());
            }
            if !self.rebase_in_progress() {
                break;
            }
            let conflicted = self
                .git(&["diff", "--name-only", "--diff-filter=U"])
                .unwrap_or_default();
            let files: Vec<&str> = conflicted.lines().collect();
            if files.is_empty() || !files.iter().all(|f| VIEWS.contains(f)) {
                break;
            }
            let theirs = [&["checkout", "--ours", "--"][..], &files].concat();
            let add = [&["add", "--"][..], &files].concat();
            if self.git(&theirs).and_then(|_| self.git(&add)).is_err() {
                break;
            }
            // Only the views changed: the commit is empty now.
            let only_views = self.git(&["diff", "--cached", "--quiet"]).is_ok();
            step = self.git(&["rebase", if only_views { "--skip" } else { "--continue" }]);
        }
        let _ = self.git(&["rebase", "--abort"]);
        let _ = self.reset_to_origin();
        Err(failed(format!(
            "local commits conflict with origin/main, dropped: {}",
            local.join("; ")
        )))
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
