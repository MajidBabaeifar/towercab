//! Towercab's own git in a mission's checkout and its clone (pipeline.md **gh and git**), all
//! through `checkout::git` (no hooks, LOOP-8). The worker never runs any of it (PIP-24):
//! Towercab commits as the bot and pushes from its clone, never with `--force`.

use std::ffi::OsStr;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

use crate::checkout::{self, NO_HOOKS};
use crate::env::{self, Fault};
use crate::handler::{Ctx, StepError};
use crate::intents::git::git_command_for;
use crate::mission::Mission;

/// Who commits without the App (`Mode::Eval`, tests).
pub const LOCAL_BOT: (&str, &str) = ("Towercab", "towercab@localhost");

/// The commit author: the App's bot (`Identity::bot`), else [`LOCAL_BOT`].
pub fn bot(cx: &Ctx<'_>, eval: bool) -> Result<(String, String), StepError> {
    if eval || !cx.identity.is_app() {
        return Ok((LOCAL_BOT.0.into(), LOCAL_BOT.1.into()));
    }
    match cx.identity.bot() {
        Ok(b) => Ok((b.login, b.email)),
        Err(crate::github::GhError::Env(e)) => Err(StepError::Env(Fault::Github, e)),
        Err(crate::github::GhError::Failed(e)) => Err(StepError::Bug(e)),
    }
}

/// A git failure: network or auth → `Env(github)`, else a bug.
pub fn failed(e: String) -> StepError {
    match env::classify(&e) {
        Some(_) => StepError::Env(Fault::Github, e),
        None => StepError::Bug(e),
    }
}

/// `git <args>` in `dir` (local: no auth).
pub fn run(cx: &Ctx<'_>, dir: &Path, args: &[&str]) -> Result<String, StepError> {
    checkout::git(&cx.exes.git, dir, args, None).map_err(failed)
}

/// `git <args>` in `dir` → whether it succeeded (its output dropped).
pub fn ok(cx: &Ctx<'_>, dir: &Path, args: &[&str]) -> bool {
    checkout::git(&cx.exes.git, dir, args, None).is_ok()
}

/// The identity flags of a commit or merge as the bot.
fn who(name: &str, email: &str) -> Vec<String> {
    vec![
        "-c".into(),
        format!("user.name={name}"),
        "-c".into(),
        format!("user.email={email}"),
        "-c".into(),
        "commit.gpgsign=false".into(),
    ]
}

/// A merge is in progress in `dir`.
pub fn merging(cx: &Ctx<'_>, dir: &Path) -> bool {
    ok(cx, dir, &["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])
}

/// The files still unmerged in `dir` (a merge in progress).
pub fn unmerged(cx: &Ctx<'_>, dir: &Path) -> Result<Vec<String>, StepError> {
    Ok(run(cx, dir, &["diff", "--name-only", "--diff-filter=U"])?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect())
}

/// The unmerged files of `dir` that still hold a conflict marker (a line starting `<<<<<<< `,
/// `>>>>>>> ` or exactly `=======`): concluding the merge would commit them.
pub fn conflict_markers(cx: &Ctx<'_>, dir: &Path) -> Result<Vec<String>, StepError> {
    Ok(unmerged(cx, dir)?
        .into_iter()
        .filter(|rel| {
            let text = std::fs::read(dir.join(rel)).unwrap_or_default();
            String::from_utf8_lossy(&text)
                .lines()
                .any(|l| l.starts_with("<<<<<<< ") || l.starts_with(">>>>>>> ") || l == "=======")
        })
        .collect())
}

/// `git add -A` and, with something staged (or a merge in progress, which this concludes),
/// `git commit -q -F <runs>/commit.txt` as the bot → the new sha; nothing → `None`.
pub fn commit(
    cx: &Ctx<'_>,
    m: &Mission,
    dir: &Path,
    msg: &str,
    eval: bool,
) -> Result<Option<String>, StepError> {
    run(cx, dir, &["add", "-A"])?;
    let staged = run(cx, dir, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() && !merging(cx, dir) {
        return Ok(None);
    }
    let runs = cx.runs(m);
    std::fs::create_dir_all(&runs)
        .map_err(|e| StepError::Bug(format!("{}: {e}", runs.display())))?;
    let file = runs.join("commit.txt");
    std::fs::write(&file, format!("{}\n", msg.trim_end()))
        .map_err(|e| StepError::Bug(format!("{}: {e}", file.display())))?;
    let (name, email) = bot(cx, eval)?;
    let mut args = who(&name, &email);
    args.extend([
        "commit".into(),
        "-q".into(),
        "-F".into(),
        file.to_string_lossy().into_owned(),
    ]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run(cx, dir, &args)?;
    Ok(Some(rev(cx, dir, "HEAD")?))
}

/// `git merge --no-edit <rev>` in `dir` as the bot: `Ok(true)` clean, `Ok(false)` conflicts
/// (left in place).
pub fn merge(cx: &Ctx<'_>, dir: &Path, rev: &str, eval: bool) -> Result<bool, StepError> {
    let (name, email) = bot(cx, eval)?;
    let mut args = who(&name, &email);
    args.extend([
        "merge".into(),
        "--no-edit".into(),
        "--quiet".into(),
        rev.into(),
    ]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match checkout::git(&cx.exes.git, dir, &args, None) {
        Ok(_) => Ok(true),
        Err(_) if merging(cx, dir) => Ok(false),
        Err(e) => Err(failed(e)),
    }
}

/// `git revert --no-edit [-m 1] <sha>` in `dir` as the bot (`-m 1` for a two-parent merge):
/// `Ok(true)` reverted; `Ok(false)` a conflict, the revert aborted (`git revert --abort`).
pub fn revert(cx: &Ctx<'_>, dir: &Path, sha: &str, eval: bool) -> Result<bool, StepError> {
    let (name, email) = bot(cx, eval)?;
    let mut args = who(&name, &email);
    args.extend(["revert".into(), "--no-edit".into()]);
    if parents(cx, dir, sha)? >= 2 {
        args.extend(["-m".into(), "1".into()]);
    }
    args.push(sha.into());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match checkout::git(&cx.exes.git, dir, &args, None) {
        Ok(_) => Ok(true),
        Err(_)
            if ok(
                cx,
                dir,
                &["rev-parse", "--quiet", "--verify", "REVERT_HEAD"],
            ) =>
        {
            run(cx, dir, &["revert", "--abort"])?;
            Ok(false)
        }
        Err(e) => Err(failed(e)),
    }
}

/// `HEAD`'s message says it reverts `sha` (`This reverts commit <sha>`).
pub fn reverts(cx: &Ctx<'_>, dir: &Path, sha: &str) -> bool {
    checkout::git(
        &cx.exes.git,
        dir,
        &["log", "-1", "--format=%B", "HEAD"],
        None,
    )
    .is_ok_and(|msg| msg.contains(&format!("This reverts commit {sha}")))
}

/// `git rev-parse --verify <rev>` in `dir`.
pub fn rev(cx: &Ctx<'_>, dir: &Path, rev: &str) -> Result<String, StepError> {
    checkout::rev(&cx.exes.git, dir, rev).map_err(failed)
}

/// What a push did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Push {
    /// The branch is at this sha on `origin`.
    Pushed(String),
    /// Not a fast-forward (someone pushed): git's words.
    Rejected(String),
    /// Refused otherwise (a ruleset, a hook): git's words.
    Refused(String),
}

/// The checkout's `branch` pushed from Towercab's clone: `git fetch --quiet -- <dir> <branch>`
/// there, then `git push --quiet origin <sha>:refs/heads/<branch>` as the App; never `--force`.
pub fn push(cx: &Ctx<'_>, m: &Mission, dir: &Path, branch: &str) -> Result<Push, StepError> {
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let git = cx.exes.git.clone();
    let auth = cx
        .identity
        .auth_for_url(&checkout::origin_url(&git, &repo))
        .map_err(|e| StepError::Env(Fault::Github, e.to_string()))?;
    let from = dir.to_string_lossy();
    // Into a ref of its own, never `FETCH_HEAD`: an eval child fetches into this clone too.
    let local = format!("refs/towercab/push/{branch}");
    checkout::git(
        &git,
        &repo.path,
        &[
            "fetch",
            "--quiet",
            "--",
            &from,
            &format!("+refs/heads/{branch}:{local}"),
        ],
        None,
    )
    .map_err(failed)?;
    let sha = checkout::rev(&git, &repo.path, &local).map_err(failed)?;
    let refspec = format!("{sha}:refs/heads/{branch}");
    match checkout::git(
        &git,
        &repo.path,
        &["push", "--quiet", "origin", &refspec],
        Some(&auth),
    ) {
        Ok(_) => Ok(Push::Pushed(sha)),
        Err(e) if env::classify(&e).is_some() => Err(StepError::Env(Fault::Github, e)),
        Err(e)
            if ["non-fast-forward", "fetch first"]
                .iter()
                .any(|w| e.contains(w)) =>
        {
            Ok(Push::Rejected(e))
        }
        Err(e) if e.contains("rejected") || e.contains("declined") => Ok(Push::Refused(e)),
        Err(e) => Err(StepError::Bug(e)),
    }
}

/// `git fetch --quiet origin <branch>` in the clone (as the App): its
/// `refs/remotes/origin/<branch>`; `Ok(false)` when origin has no such branch.
pub fn fetch_branch(cx: &Ctx<'_>, m: &Mission, branch: &str) -> Result<bool, StepError> {
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let git = cx.exes.git.clone();
    let auth = cx
        .identity
        .auth_for_url(&checkout::origin_url(&git, &repo))
        .map_err(|e| StepError::Env(Fault::Github, e.to_string()))?;
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    match checkout::git(
        &git,
        &repo.path,
        &["fetch", "--quiet", "origin", &refspec],
        Some(&auth),
    ) {
        Ok(_) => Ok(true),
        Err(e) if env::classify(&e).is_some() => Err(StepError::Env(Fault::Github, e)),
        Err(e) if e.contains("couldn't find remote ref") => Ok(false),
        Err(e) => Err(StepError::Bug(e)),
    }
}

/// The checkout re-made on `branch` from the clone's `refs/remotes/origin/<branch>` (base
/// refreshed too): an adopted PR's head (PIP-17), or a checkout gone or broken (LOOP-8).
pub fn recreate(cx: &Ctx<'_>, m: &Mission, branch: &str) -> Result<(), StepError> {
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let dir = cx.checkout(m);
    checkout::remove(&dir).map_err(StepError::Bug)?;
    checkout::create(&cx.exes.git, &repo.path, &dir, branch, branch).map_err(failed)?;
    checkout::refresh_base(&cx.exes.git, &repo.path, &dir, &repo.base).map_err(failed)
}

/// The checkout brought up to the PR head (`missions.branch` on origin) without losing a
/// commit: missing or invalid → re-made on the branch (from base when origin has none); else the
/// branch fetched into it by path and base refreshed, then a fast-forward, nothing when the
/// checkout is ahead, or `git merge --no-edit` of it as the bot (`Ok(false)`: conflicts left
/// in place). A merge already in progress is left alone.
pub fn sync_head(cx: &Ctx<'_>, m: &Mission) -> Result<bool, StepError> {
    let branch = m
        .branch
        .clone()
        .ok_or_else(|| StepError::Bug(format!("{}: no branch", m.label())))?;
    let repo = cx.repo(m).map_err(StepError::Bug)?.clone();
    let dir = cx.checkout(m);
    let on_origin = fetch_branch(cx, m, &branch)?;
    if !checkout::valid(&cx.exes.git, &dir) {
        if on_origin {
            recreate(cx, m, &branch)?;
        } else {
            checkout::remove(&dir).map_err(StepError::Bug)?;
            checkout::create(&cx.exes.git, &repo.path, &dir, &repo.base, &branch)
                .map_err(failed)?;
        }
        return Ok(true);
    }
    checkout::refresh_base(&cx.exes.git, &repo.path, &dir, &repo.base).map_err(failed)?;
    if merging(cx, &dir) || !on_origin {
        return Ok(true);
    }
    let remote = format!("refs/remotes/origin/{branch}");
    let clone = repo.path.to_string_lossy().into_owned();
    run(
        cx,
        &dir,
        &["fetch", "--quiet", &clone, &format!("+{remote}:{remote}")],
    )?;
    run(cx, &dir, &["checkout", "--quiet", &branch])?;
    let ancestor = |a: &str, b: &str| ok(cx, &dir, &["merge-base", "--is-ancestor", a, b]);
    if ancestor("HEAD", &remote) {
        run(cx, &dir, &["merge", "--ff-only", "--quiet", &remote])?;
        Ok(true)
    } else if ancestor(&remote, "HEAD") {
        Ok(true)
    } else {
        merge(cx, &dir, &remote, false)
    }
}

/// `git merge-base HEAD refs/remotes/origin/<base>` in `dir`.
pub fn merge_base(cx: &Ctx<'_>, dir: &Path, base: &str) -> Result<String, StepError> {
    let out = run(
        cx,
        dir,
        &["merge-base", "HEAD", &format!("refs/remotes/origin/{base}")],
    )?;
    Ok(out.trim().to_string())
}

/// `git diff --name-status -z --no-renames <from> <to>` → (status letter, path).
pub fn changed(
    cx: &Ctx<'_>,
    dir: &Path,
    from: &str,
    to: &str,
) -> Result<Vec<(char, String)>, StepError> {
    let out = run(
        cx,
        dir,
        &["diff", "--name-status", "-z", "--no-renames", from, to],
    )?;
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut v = Vec::new();
    while let (Some(st), Some(path)) = (parts.next(), parts.next()) {
        v.push((st.chars().next().unwrap_or('M'), path.to_string()));
    }
    Ok(v)
}

/// `git diff <from> <to> | git patch-id --stable` → the patch id (no diff: empty).
pub fn patch_id(exe: &OsStr, dir: &Path, from: &str, to: &str) -> Result<String, String> {
    let diff = checkout::git(exe, dir, &["diff", from, to], None)?;
    let mut cmd = git_command_for(exe);
    cmd.args(NO_HOOKS)
        .args(["patch-id", "--stable"])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("git patch-id: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(diff.as_bytes())
            .map_err(|e| format!("git patch-id: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git patch-id: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string())
}

/// How many parents `sha` has.
pub fn parents(cx: &Ctx<'_>, dir: &Path, sha: &str) -> Result<usize, StepError> {
    let out = run(cx, dir, &["rev-list", "--parents", "-n", "1", sha])?;
    Ok(out.split_whitespace().count().saturating_sub(1))
}

/// A `.github/workflows/*.yml` or `*.yaml` at `HEAD` of `dir`.
pub fn has_workflows(cx: &Ctx<'_>, dir: &Path) -> bool {
    run(
        cx,
        dir,
        &["ls-tree", "--name-only", "HEAD", ".github/workflows/"],
    )
    .map(|out| {
        out.lines()
            .any(|l| l.ends_with(".yml") || l.ends_with(".yaml"))
    })
    .unwrap_or(false)
}
