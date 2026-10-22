//! Towercab's clone of a repo and the missions' checkouts (LOOP-8).
//!
//! The clone (`[repos.<r>].path`) is only fetched into and pushed from; its working tree is
//! never touched. A checkout `work/<id>-<attempt>` has no git remote: base is fetched into it
//! by path, and Towercab pushes from its clone.

use std::ffi::OsStr;
use std::path::Path;

use crate::config::RepoConfig;
use crate::intents::git::{GitAuth, git_command_for};

/// `git <args>` in `dir` (discovery stops at `dir`: its parent is the ceiling) → stdout;
/// failure → `<dir>: <stderr>`.
pub fn git(
    git: &OsStr,
    dir: &Path,
    args: &[&str],
    auth: Option<&GitAuth>,
) -> Result<String, String> {
    let failed = |e: String| format!("{}: {e}", dir.display());
    let mut cmd = git_command_for(git);
    if let Some(a) = auth {
        a.apply(&mut cmd);
    }
    cmd.args(args).current_dir(dir);
    if let Some(parent) = std::path::absolute(dir)
        .ok()
        .as_deref()
        .and_then(Path::parent)
    {
        cmd.env("GIT_CEILING_DIRECTORIES", parent);
    }
    let out = cmd.output().map_err(|e| failed(format!("git: {e}")))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(failed(if err.is_empty() {
        format!("git {} failed", args.first().unwrap_or(&""))
    } else {
        err
    }))
}

/// Where Towercab's clone of `repo` fetches from: its `origin` (`git config --get
/// remote.origin.url`, as written: no `insteadOf`), else `https://github.com/<github>.git`,
/// what [`ensure_clone`] clones. The App token is used only for a `https://github.com/` one.
pub fn origin_url(exe: &OsStr, repo: &RepoConfig) -> String {
    repo.path
        .join(".git")
        .exists()
        .then(|| {
            git(
                exe,
                &repo.path,
                &["config", "--get", "remote.origin.url"],
                None,
            )
            .ok()
        })
        .flatten()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| format!("https://github.com/{}.git", repo.github))
}

/// Towercab's clone of `repo`: cloned from `https://github.com/<github>.git` when missing,
/// then `git fetch --quiet --prune origin`.
pub fn ensure_clone(exe: &OsStr, repo: &RepoConfig, auth: Option<&GitAuth>) -> Result<(), String> {
    if !repo.path.exists() {
        let parent = repo.path.parent().ok_or("clone: no parent directory")?;
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        let url = format!("https://github.com/{}.git", repo.github);
        let path = repo.path.to_string_lossy();
        git(exe, parent, &["clone", "--quiet", "--", &url, &path], auth)?;
    }
    git(
        exe,
        &repo.path,
        &["fetch", "--quiet", "--prune", "origin"],
        auth,
    )
    .map(drop)
}

/// The fetch that brings `refs/remotes/origin/<base>` of the clone into the checkout (by path).
pub fn refresh_base(exe: &OsStr, clone: &Path, checkout: &Path, base: &str) -> Result<(), String> {
    let refspec = format!("+refs/remotes/origin/{base}:refs/remotes/origin/{base}");
    let clone = clone.to_string_lossy();
    git(exe, checkout, &["fetch", "--quiet", &clone, &refspec], None).map(drop)
}

/// A new checkout of `clone` at `checkout` on `branch` from `refs/remotes/origin/<base>`,
/// without a remote.
pub fn create(
    exe: &OsStr,
    clone: &Path,
    checkout: &Path,
    base: &str,
    branch: &str,
) -> Result<(), String> {
    let parent = checkout.parent().ok_or("checkout: no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let (from, to) = (clone.to_string_lossy(), checkout.to_string_lossy());
    git(
        exe,
        parent,
        &["clone", "--quiet", "--no-checkout", "--", &from, &to],
        None,
    )?;
    git(exe, checkout, &["remote", "remove", "origin"], None)?;
    refresh_base(exe, clone, checkout, base)?;
    let start = format!("refs/remotes/origin/{base}");
    git(
        exe,
        checkout,
        &["checkout", "--quiet", "-B", branch, &start],
        None,
    )
    .map(drop)
}

/// A checkout with a valid `HEAD` (`git rev-parse --verify HEAD`).
pub fn valid(exe: &OsStr, checkout: &Path) -> bool {
    checkout.join(".git").exists()
        && git(
            exe,
            checkout,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            None,
        )
        .is_ok()
}

/// The checkout as LOOP-8 keeps it: a valid one stays; a missing or broken one is (re)made.
/// True when it was made.
pub fn ensure(
    exe: &OsStr,
    clone: &Path,
    checkout: &Path,
    base: &str,
    branch: &str,
) -> Result<bool, String> {
    if valid(exe, checkout) {
        return Ok(false);
    }
    remove(checkout)?;
    create(exe, clone, checkout, base, branch)?;
    Ok(true)
}

/// Deletes a checkout (absent: nothing to do).
pub fn remove(checkout: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(checkout) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", checkout.display())),
    }
}

/// `git rev-parse <rev>` in `dir`.
pub fn rev(exe: &OsStr, dir: &Path, rev: &str) -> Result<String, String> {
    git(exe, dir, &["rev-parse", "--verify", "--quiet", rev], None).map(|s| s.trim().to_string())
}
