//! Towercab's checkout of the intent home, through the `git` CLI (INT-10).
//!
//! Every call runs in an environment of its own: the caller's `GIT_DIR`, `GIT_WORK_TREE`,
//! `GIT_INDEX_FILE` (set inside a git hook or `rebase --exec`) never point it elsewhere, and
//! nothing prompts (`GIT_TERMINAL_PROMPT=0`; ssh `BatchMode=yes` unless I configured my own
//! ssh command). No timeouts here: the loop bounds its calls (LOOP-10).

use std::ffi::OsStr;
use std::fmt;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, LazyLock, Mutex};

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

/// Repository-selecting variables a caller's environment may carry.
const REPO_ENV: [&str; 7] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
];

/// No ssh command of mine (`GIT_SSH_COMMAND`, `GIT_SSH`, `core.sshCommand`): use batch mode.
static SSH_BATCH: LazyLock<bool> = LazyLock::new(|| {
    let set = |v: &str| std::env::var_os(v).is_some_and(|x| !x.is_empty());
    if set("GIT_SSH_COMMAND") || set("GIT_SSH") {
        return false;
    }
    let mut c = Command::new("git");
    for v in REPO_ENV {
        c.env_remove(v);
    }
    !c.args(["config", "--get", "core.sshCommand"])
        .output()
        .is_ok_and(|o| o.status.success())
});

/// `git` with Towercab's identity and its own environment (module doc); also used by
/// `repo::load` (REPO-1).
pub fn git_command() -> Command {
    git_command_for(OsStr::new("git"))
}

/// [`git_command`] with another `git` executable (the loop's `Exes::git`).
pub fn git_command_for(git: &OsStr) -> Command {
    let mut c = Command::new(git);
    c.args(GIT_CONFIG);
    for v in REPO_ENV {
        c.env_remove(v);
    }
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true");
    if *SSH_BATCH {
        c.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    c
}

/// What a git call adds to act as Towercab's GitHub App (LOOP-19, `github::Identity::git_auth`):
/// `-c` args after Towercab's own (the credential helper, the bot's `user.name`/`user.email`,
/// which win) and env (`GH_TOKEN`). Empty = my own git setup.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GitAuth {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl GitAuth {
    /// Adds it to a git command, before the subcommand.
    pub fn apply(&self, cmd: &mut Command) {
        cmd.args(&self.args);
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)));
    }
}

/// Where a checkout's network and commit calls get their [`GitAuth`] (minted when called, so a
/// token is fresh); `Err` fails that call with the reason.
pub type AuthFn = Box<dyn FnMut() -> Result<GitAuth, String> + Send>;

/// A git working tree on `main`; `origin` = it has an `origin` remote to pull from and push to.
#[derive(Clone)]
pub struct Checkout {
    pub path: PathBuf,
    pub origin: bool,
    /// Its absolute git directory (`.git`, or the worktree's).
    pub git_dir: PathBuf,
    /// Used by fetch, pull, commit and push (`with_auth`); none → my own git setup.
    auth: Option<Arc<Mutex<AuthFn>>>,
}

impl fmt::Debug for Checkout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Checkout")
            .field("path", &self.path)
            .field("origin", &self.origin)
            .field("git_dir", &self.git_dir)
            .field("auth", &self.auth.is_some())
            .finish()
    }
}

impl Checkout {
    /// A checkout at `path`; `origin` read from its remotes.
    pub fn new(path: &Path) -> Result<Checkout, String> {
        let mut c = Checkout {
            path: path.to_path_buf(),
            origin: false,
            git_dir: PathBuf::new(),
            auth: None,
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

    /// Its fetches, pulls, commits and pushes act as `auth` returns (LOOP-19: the App's token
    /// and bot); every other call stays local and plain.
    pub fn with_auth(mut self, auth: AuthFn) -> Checkout {
        self.auth = Some(Arc::new(Mutex::new(auth)));
        self
    }

    /// The [`GitAuth`] of a network or commit call now.
    fn auth(&self) -> Result<GitAuth, String> {
        match &self.auth {
            None => Ok(GitAuth::default()),
            Some(f) => (f.lock().unwrap_or_else(|p| p.into_inner()))(),
        }
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
        Checkout::clone_as(remote, path, &GitAuth::default())
    }

    /// [`Checkout::clone`] with `auth` (LOOP-19).
    pub fn clone_as(remote: &str, path: &Path, auth: &GitAuth) -> Result<Checkout, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("clone failed: {e}"))?;
        }
        let mut cmd = git_command();
        auth.apply(&mut cmd);
        let out = cmd
            .args(["clone", "--quiet", "--", remote])
            .arg(path)
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
        self.run(args, &GitAuth::default())
    }

    /// [`Checkout::git`] with its auth (`with_auth`): fetches, rebases, commits, pushes and
    /// `ls-remote`.
    pub fn git_as(&self, args: &[&str]) -> Result<String, String> {
        let auth = self.auth()?;
        self.run(args, &auth)
    }

    fn run(&self, args: &[&str], auth: &GitAuth) -> Result<String, String> {
        let mut cmd = git_command();
        auth.apply(&mut cmd);
        let out = cmd
            .args(args)
            .current_dir(&self.path)
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
        self.git_as(&["fetch", "--quiet", "origin", "main"])
            .map_err(failed)?;
        let local = self.local_commits().map_err(failed)?;
        if local.is_empty() {
            return self
                .git(&["merge", "--quiet", "--ff-only", "origin/main"])
                .map(drop)
                .map_err(failed);
        }
        let mut step = self.git_as(&["rebase", "--quiet", "origin/main"]);
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
            step = self.git_as(&["rebase", if only_views { "--skip" } else { "--continue" }]);
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
        self.git_as(&["commit", "--quiet", "-m", msg])
            .map(|_| true)
            .map_err(|e| format!("commit failed: {e}"))
    }

    /// `git push --quiet origin HEAD:main`; nothing without `origin`.
    pub fn push(&self) -> Result<(), String> {
        if !self.origin {
            return Ok(());
        }
        self.git_as(&["push", "--quiet", "origin", "HEAD:main"])
            .map(drop)
    }

    /// `git fetch origin main`.
    pub fn fetch(&self) -> Result<(), String> {
        self.git_as(&["fetch", "--quiet", "origin", "main"])
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
