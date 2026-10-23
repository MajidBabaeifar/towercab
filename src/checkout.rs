//! Towercab's clone of a repo and the missions' checkouts (LOOP-8).
//!
//! The clone (`[repos.<r>].path`) is only fetched into and pushed from; its working tree is
//! never touched. A checkout `work/<id>-<attempt>` has no git remote: base is fetched into it
//! by path, and Towercab pushes from its clone.

use std::ffi::OsStr;
use std::path::Path;

use crate::child::{GIT_TIMEOUT, output};
use crate::config::RepoConfig;
use crate::intents::git::{GitAuth, git_command_for};

/// What every git call here adds: no hook or fsmonitor of the repo's runs (LOOP-8; with
/// [`sane`] and the read-only `.git` in every sandbox, nothing a run writes there runs).
pub const NO_HOOKS: [&str; 4] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
];

/// Whether a repo-local config key is one Towercab's clones and checkouts are made with (`git
/// clone`, `git remote remove`, `git checkout -B`): `core.{repositoryformatversion, filemode,
/// bare, logallrefupdates, ignorecase, precomposeunicode, symlinks}`,
/// `extensions.{objectformat, refstorage}`, `remote.<name>.{url, fetch}`,
/// `branch.<name>.{remote, merge}`. Anything else (`filter.<x>.clean`, `diff.external`,
/// `merge.<x>.driver`, `core.worktree`, `core.sshCommand`, `include.path` …) could run code
/// as Towercab or redirect its git.
pub fn allowed_key(key: &str) -> bool {
    const EXACT: [&str; 9] = [
        "core.repositoryformatversion",
        "core.filemode",
        "core.bare",
        "core.logallrefupdates",
        "core.ignorecase",
        "core.precomposeunicode",
        "core.symlinks",
        "extensions.objectformat",
        "extensions.refstorage",
    ];
    if EXACT.contains(&key) {
        return true;
    }
    let last =
        |rest: &str, ok: [&str; 2]| rest.rsplit_once('.').is_some_and(|(_, k)| ok.contains(&k));
    match key.split_once('.') {
        Some(("remote", rest)) => last(rest, ["url", "fetch"]),
        Some(("branch", rest)) => last(rest, ["remote", "merge"]),
        _ => false,
    }
}

/// The repo at `dir` is one Towercab's git runs in (LOOP-8): `.git` a directory (no gitfile,
/// no `commondir`) whose `config` holds only [`allowed_key`]s, listed with `git config --file
/// <config> --no-includes --list --name-only` (which runs nothing). Else `Err` naming the keys:
/// something wrote the repo's `.git` (no run can: it is read-only in every sandbox).
pub fn sane(exe: &OsStr, dir: &Path) -> Result<(), String> {
    let gitdir = dir.join(".git");
    let refused = |why: String| format!("{}: {why}: refused (LOOP-8)", gitdir.display());
    let meta = std::fs::symlink_metadata(&gitdir).map_err(|e| refused(e.to_string()))?;
    if !meta.is_dir() {
        return Err(refused("not a directory".into()));
    }
    if std::fs::symlink_metadata(gitdir.join("commondir")).is_ok() {
        return Err(refused("has a commondir".into()));
    }
    let config = gitdir.join("config");
    let mut cmd = git_command_for(exe);
    cmd.args(["config", "--file"])
        .arg(&config)
        .args(["--no-includes", "--list", "--name-only"])
        .current_dir(dir);
    let out = output(&mut cmd, GIT_TIMEOUT).map_err(|e| refused(format!("git: {e}")))?;
    if !out.status.success() {
        return Err(refused(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    let bad: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|k| !k.is_empty() && !allowed_key(k))
        .map(str::to_string)
        .collect();
    if bad.is_empty() {
        Ok(())
    } else {
        Err(refused(format!(
            "config has {}, not written by Towercab",
            bad.join(", ")
        )))
    }
}

/// [`sane`], then [`git`]: Towercab's own git in a mission checkout (or its clone) after a run
/// was there: commit, merge, revert, checkout, diff.
pub fn git_sane(
    exe: &OsStr,
    dir: &Path,
    args: &[&str],
    auth: Option<&GitAuth>,
) -> Result<String, String> {
    sane(exe, dir)?;
    git(exe, dir, args, auth)
}

/// `git <args>` in `dir` (discovery stops at `dir`: its parent is the ceiling) → stdout;
/// failure → `<dir>: <stderr>`. [`NO_HOOKS`]; killed after [`GIT_TIMEOUT`] (LOOP-10).
pub fn git(
    git: &OsStr,
    dir: &Path,
    args: &[&str],
    auth: Option<&GitAuth>,
) -> Result<String, String> {
    let failed = |e: String| format!("{}: {e}", dir.display());
    let mut cmd = git_command_for(git);
    cmd.args(NO_HOOKS);
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
    let out = output(&mut cmd, GIT_TIMEOUT).map_err(|e| failed(format!("git: {e}")))?;
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
/// without a remote: made in `<checkout>.tmp` (a leftover one removed first), renamed into
/// place when done, so a crash never leaves a half-made one at `checkout`.
pub fn create(
    exe: &OsStr,
    clone: &Path,
    checkout: &Path,
    base: &str,
    branch: &str,
) -> Result<(), String> {
    let parent = checkout.parent().ok_or("checkout: no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let mut tmp = checkout.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    remove(&tmp)?;
    let (from, to) = (clone.to_string_lossy(), tmp.to_string_lossy());
    git(
        exe,
        parent,
        &["clone", "--quiet", "--no-checkout", "--", &from, &to],
        None,
    )?;
    git(exe, &tmp, &["remote", "remove", "origin"], None)?;
    refresh_base(exe, clone, &tmp, base)?;
    let start = format!("refs/remotes/origin/{base}");
    git(
        exe,
        &tmp,
        &["checkout", "--quiet", "-B", branch, &start],
        None,
    )?;
    std::fs::rename(&tmp, checkout).map_err(|e| format!("{}: {e}", checkout.display()))
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
