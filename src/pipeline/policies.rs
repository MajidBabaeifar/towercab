//! Policy skills (PIP-27): before every design, worker, review, triage and verifier run,
//! `<runs>/policies/` is rebuilt as a plugin (`--plugin-dir`): skill folders only (a folder
//! holding `SKILL.md`), first `policies/<name>/` of `[policies].github` at its base, then the
//! target repo's `.claude/skills/<name>/` at its base (the repo wins a clash). Never from the
//! PR, never hooks, MCP servers or settings.

use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path};

use serde_json::json;

use crate::checkout::{self, NO_HOOKS};
use crate::db::{get_meta, set_meta};
use crate::env::Fault;
use crate::handler::{Ctx, StepError};
use crate::intents::git::git_command_for;
use crate::mission::Mission;

use super::git::failed;

/// `[policies].github` is fetched at most this often (s).
pub const FETCH_EVERY: f64 = 300.0;

/// `.claude-plugin/plugin.json`.
pub fn plugin_json() -> serde_json::Value {
    json!({"name": "towercab-policies", "version": "0.0.0", "description": "Policy skills (Towercab)"})
}

/// `git <args>` in `dir` → stdout bytes.
fn git_bytes(exe: &OsStr, dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git_command_for(exe)
        .args(NO_HOOKS)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(format!(
            "{}: {}",
            dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// A regular file of a skill folder: (skill name, path inside it, executable, blob).
struct Entry {
    skill: String,
    rest: String,
    exec: bool,
    oid: String,
}

/// The skill folders under `prefix` of `tree` in the repo at `dir`: every regular file (modes
/// `100644`/`100755`) of each `prefix/<name>/` holding a `SKILL.md`; symlinks and submodules
/// skipped.
fn skills(exe: &OsStr, dir: &Path, tree: &str, prefix: &str) -> Result<Vec<Entry>, String> {
    let listing = git_bytes(
        exe,
        dir,
        &["ls-tree", "-r", "-z", "--full-tree", tree, "--", prefix],
    )?;
    let mut entries = Vec::new();
    for raw in listing.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let raw = String::from_utf8_lossy(raw);
        let Some((meta, path)) = raw.split_once('\t') else {
            continue;
        };
        let mut meta = meta.split(' ');
        let (mode, _, oid) = (meta.next(), meta.next(), meta.next());
        let exec = match mode {
            Some("100644") => false,
            Some("100755") => true,
            _ => continue,
        };
        let Some(inner) = path.strip_prefix(prefix).and_then(|p| p.strip_prefix('/')) else {
            continue;
        };
        let Some((skill, rest)) = inner.split_once('/') else {
            continue;
        };
        let safe = |p: &str| {
            Path::new(p)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        };
        if !safe(skill) || !safe(rest) {
            continue;
        }
        entries.push(Entry {
            skill: skill.to_string(),
            rest: rest.to_string(),
            exec,
            oid: oid.unwrap_or_default().to_string(),
        });
    }
    let with_skill: std::collections::BTreeSet<String> = entries
        .iter()
        .filter(|e| e.rest == "SKILL.md")
        .map(|e| e.skill.clone())
        .collect();
    entries.retain(|e| with_skill.contains(&e.skill));
    Ok(entries)
}

/// Writes `entries` into `<skills>/<name>/…`, each named folder replaced whole.
fn copy(exe: &OsStr, dir: &Path, entries: &[Entry], out: &Path) -> Result<(), String> {
    let names: std::collections::BTreeSet<&str> =
        entries.iter().map(|e| e.skill.as_str()).collect();
    for name in names {
        checkout::remove(&out.join(name))?;
    }
    for e in entries {
        let bytes = git_bytes(exe, dir, &["cat-file", "blob", &e.oid])?;
        let path = out.join(&e.skill).join(&e.rest);
        let err = |x: std::io::Error| format!("{}: {x}", path.display());
        fs::create_dir_all(path.parent().unwrap_or(out)).map_err(err)?;
        fs::write(&path, bytes).map_err(err)?;
        if e.exec {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(err)?;
        }
    }
    Ok(())
}

/// Towercab's clone of `[policies].github` at `<home>/policies` (cloned as the App when
/// missing; `git fetch origin <base>` at most every [`FETCH_EVERY`] s) → its base's sha.
fn policies_clone(cx: &Ctx<'_>, github: &str) -> Result<(std::path::PathBuf, String), StepError> {
    let clone = cx.home.root.join("policies");
    let base = cx.config.policies.base.clone();
    let url = format!("https://github.com/{github}.git");
    let auth = cx
        .identity
        .auth_for_url(&url)
        .map_err(|e| StepError::Env(Fault::Github, e.to_string()))?;
    let git = cx.exes.git.clone();
    let now = cx.tick.unix();
    let last: f64 = get_meta(cx.db.conn(), "policies_fetched")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    if !clone.join(".git").exists() {
        checkout::remove(&clone).map_err(StepError::Bug)?;
        let to = clone.to_string_lossy();
        checkout::git(
            &git,
            &cx.home.root,
            &["clone", "--quiet", "--no-checkout", "--", &url, &to],
            Some(&auth),
        )
        .map_err(failed)?;
        set_meta(cx.db.conn(), "policies_fetched", &now.to_string())?;
    } else if now - last >= FETCH_EVERY || now < last {
        let refspec = format!("+refs/heads/{base}:refs/remotes/origin/{base}");
        checkout::git(
            &git,
            &clone,
            &["fetch", "--quiet", "origin", &refspec],
            Some(&auth),
        )
        .map_err(failed)?;
        set_meta(cx.db.conn(), "policies_fetched", &now.to_string())?;
    }
    let sha =
        checkout::rev(&git, &clone, &format!("refs/remotes/origin/{base}")).map_err(failed)?;
    Ok((clone, sha))
}

/// Rebuilds `<runs>/policies/` (PIP-27) → the `[policies].github` sha used, or `none`.
pub fn assemble(cx: &Ctx<'_>, m: &Mission) -> Result<String, StepError> {
    let out = cx.runs(m).join("policies");
    let bug = |e: String| StepError::Bug(e);
    checkout::remove(&out).map_err(bug)?;
    let skills_dir = out.join("skills");
    fs::create_dir_all(&skills_dir).map_err(|e| bug(format!("{}: {e}", skills_dir.display())))?;
    let manifest = out.join(".claude-plugin").join("plugin.json");
    fs::create_dir_all(manifest.parent().unwrap_or(&out))
        .and_then(|()| fs::write(&manifest, plugin_json().to_string()))
        .map_err(|e| bug(format!("{}: {e}", manifest.display())))?;
    let git = cx.exes.git.clone();
    let mut sha = "none".to_string();
    if let Some(github) = cx.config.policies.github.clone() {
        let (clone, at) = policies_clone(cx, &github)?;
        let entries = skills(&git, &clone, &at, "policies").map_err(failed)?;
        copy(&git, &clone, &entries, &skills_dir).map_err(bug)?;
        sha = at;
    }
    let repo = cx.repo(m).map_err(bug)?.clone();
    let tree = format!("refs/remotes/origin/{}", repo.base);
    let entries = skills(&git, &repo.path, &tree, ".claude/skills").map_err(failed)?;
    copy(&git, &repo.path, &entries, &skills_dir).map_err(bug)?;
    Ok(sha)
}

/// The footer's `policies <owner/name>@<sha7>|none`.
pub fn shown(cx: &Ctx<'_>, sha: &str) -> String {
    match (&cx.config.policies.github, sha) {
        (Some(g), s) if s != "none" => format!("{g}@{}", &s[..s.len().min(7)]),
        _ => "none".into(),
    }
}
