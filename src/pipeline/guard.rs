//! The worker's guard (PIP-29, PIP-31; pipeline.md **Guard**): before each worker run Towercab
//! writes `<runs>/guard.json` (the checkout, the protected globs, the intent's `unlock`, the
//! locked test files) and the run's `denyWrite`; Claude Code's `PreToolUse` hook runs
//! `towercab hook guard <runs>/guard.json` on every `Edit`, `Write` and `NotebookEdit`, which
//! [`hook`] answers. Publish refuses what got past it ([`check`]).

use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

use crate::handler::{Ctx, StepError};
use crate::mission::Mission;
use crate::repo::protected::{CONTROL, glob};
use crate::repo::{Protected, RepoFiles};

use super::{Round, git as pgit, intent};

/// What the guard knows of one worker run (`<runs>/guard.json`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    /// The mission checkout (absolute).
    pub checkout: PathBuf,
    /// [`CONTROL`] + `TOWERCAB.md` `protected`.
    pub protected: Vec<String>,
    /// The intent's `unlock`.
    pub unlock: Vec<String>,
    /// Test files already in the pushed head (repo-relative), during verify and CI rounds.
    pub locked: Vec<String>,
}

impl Rules {
    pub fn to_json(&self) -> Value {
        json!({
            "checkout": self.checkout.to_string_lossy(),
            "protected": self.protected,
            "unlock": self.unlock,
            "locked": self.locked,
        })
    }

    pub fn from_json(v: &Value) -> Result<Rules, String> {
        let list = |k: &str| -> Result<Vec<String>, String> {
            v.get(k)
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{k} missing"))?
                .iter()
                .map(|x| {
                    x.as_str()
                        .map(str::to_string)
                        .ok_or(format!("{k}: not a string"))
                })
                .collect()
        };
        let checkout = v
            .get("checkout")
            .and_then(Value::as_str)
            .filter(|c| Path::new(c).is_absolute())
            .ok_or("checkout missing or not absolute")?;
        Ok(Rules {
            checkout: PathBuf::from(checkout),
            protected: list("protected")?,
            unlock: list("unlock")?,
            locked: list("locked")?,
        })
    }

    /// The rules file.
    pub fn read(path: &Path) -> Result<Rules, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        Rules::from_json(&v).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// Test files (`TOWERCAB.md` `tests` globs) in `missions.head` (`git ls-tree -r --name-only`
/// in the checkout); no head yet → none.
pub fn locked(cx: &Ctx<'_>, m: &Mission, tests: &[String]) -> Result<Vec<String>, StepError> {
    let Some(head) = m.head.as_deref() else {
        return Ok(Vec::new());
    };
    let globs: Vec<_> = tests.iter().filter_map(|g| glob(g).ok()).collect();
    let out = pgit::run(
        cx,
        &cx.checkout(m),
        &["ls-tree", "-r", "-z", "--name-only", head],
    )?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty() && globs.iter().any(|g| g.is_match(p)))
        .map(str::to_string)
        .collect())
}

/// Writes `<runs>/guard.json` for a worker run in `round` (locked tests only in verify and CI
/// rounds) → the run's `denyWrite`: `Protected::deny_write(checkout)` + the locked files that
/// exist (absolute).
pub fn write_rules(
    cx: &Ctx<'_>,
    m: &Mission,
    files: &RepoFiles,
    round: Round,
) -> Result<Vec<PathBuf>, StepError> {
    let checkout =
        std::path::absolute(cx.checkout(m)).map_err(|e| StepError::Bug(e.to_string()))?;
    let unlock = match m.intent {
        Some(_) => intent(cx, m)?.unlock().to_vec(),
        None => Vec::new(),
    };
    let locked = if matches!(round, Round::Verify | Round::Ci) {
        locked(cx, m, &files.towercab.tests)?
    } else {
        Vec::new()
    };
    let rules = Rules {
        checkout: checkout.clone(),
        protected: CONTROL
            .iter()
            .map(|s| s.to_string())
            .chain(files.towercab.protected.iter().cloned())
            .collect(),
        unlock,
        locked,
    };
    let protected = Protected::new(&rules.protected, &rules.unlock).map_err(StepError::Bug)?;
    let mut deny: BTreeSet<PathBuf> = protected
        .deny_write(&checkout)
        .map_err(StepError::Bug)?
        .into_iter()
        .collect();
    for rel in &rules.locked {
        let p = checkout.join(rel);
        if std::fs::symlink_metadata(&p).is_ok() {
            deny.insert(p);
        }
    }
    let runs = cx.runs(m);
    std::fs::create_dir_all(&runs)
        .map_err(|e| StepError::Bug(format!("{}: {e}", runs.display())))?;
    let file = runs.join("guard.json");
    std::fs::write(&file, rules.to_json().to_string())
        .map_err(|e| StepError::Bug(format!("{}: {e}", file.display())))?;
    Ok(deny.into_iter().collect())
}

/// What a block is (`guard-blocks.jsonl` `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Block {
    Protected,
    TestLock,
}

impl Block {
    pub fn as_str(self) -> &'static str {
        match self {
            Block::Protected => "protected",
            Block::TestLock => "test_lock",
        }
    }
}

/// `path` as the worker named it → repo-relative to `checkout` (a relative one is relative to
/// it): the deepest existing ancestor resolved (symlinks followed), the rest kept as written;
/// outside the checkout → `Err`.
fn relative(checkout: &Path, path: &str) -> Result<String, String> {
    let outside = || format!("{path} is outside the checkout: changes here go through Majid");
    let p = Path::new(path);
    let p = if p.is_absolute() {
        p.to_path_buf()
    } else {
        checkout.join(p)
    };
    let root = checkout
        .canonicalize()
        .unwrap_or_else(|_| checkout.to_path_buf());
    // The deepest ancestor that exists, resolved; the components after it as written.
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.as_path();
    let resolved = loop {
        if let Ok(meta) = std::fs::symlink_metadata(cur) {
            match cur.canonicalize() {
                Ok(c) => break c,
                // A write through a dangling symlink lands wherever it points.
                Err(_) if meta.file_type().is_symlink() => {
                    return Err(format!(
                        "{path} goes through a dangling symlink: changes here go through Majid"
                    ));
                }
                Err(_) => {}
            }
        }
        match (cur.file_name(), cur.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_os_string());
                cur = parent;
            }
            _ => break cur.to_path_buf(),
        }
    };
    let mut full = resolved;
    for c in rest.iter().rev() {
        full.push(c);
    }
    // `..` left in the unresolved part stays, and blocks (Protected::blocks).
    let rel = full.strip_prefix(&root).map_err(|_| outside())?;
    if rel.as_os_str().is_empty() {
        return Err(outside());
    }
    if rel
        .components()
        .any(|c| matches!(c, Component::RootDir | Component::Prefix(_)))
    {
        return Err(outside());
    }
    Ok(rel.to_string_lossy().into_owned())
}

/// The guard's decision on repo-relative `rel`: protected and not unlocked, or a locked test →
/// `Err((kind, reason))`.
pub fn decide(rules: &Rules, rel: &str) -> Result<(), (Block, String)> {
    let protected = Protected::new(&rules.protected, &rules.unlock)
        .map_err(|e| (Block::Protected, format!("guard rules: {e}: blocked")))?;
    if protected.blocks(rel) {
        return Err((
            Block::Protected,
            format!("{rel} is protected: changes here go through Majid"),
        ));
    }
    if rules.locked.iter().any(|l| l == rel) {
        return Err((
            Block::TestLock,
            format!(
                "{rel} is a test already pushed: it is locked in repair rounds; changes here go through Majid"
            ),
        ));
    }
    Ok(())
}

/// `towercab hook guard <rules>`: the hook's stdin (`{tool_name, tool_input: {file_path |
/// notebook_path}}`) against the rules → `Err(reason)` blocks (exit 2). Fails closed: a missing
/// or bad rules file or stdin blocks. Each path block appends a line to `guard-blocks.jsonl`
/// next to the rules file.
pub fn hook(stdin: &str, rules: &Path) -> Result<(), String> {
    let r = Rules::read(rules).map_err(|e| format!("guard: {e}: blocked"))?;
    let input: Value =
        serde_json::from_str(stdin).map_err(|e| format!("guard: bad hook input: {e}: blocked"))?;
    let tool = input.get("tool_input");
    let path = tool
        .and_then(|t| t.get("file_path").or_else(|| t.get("notebook_path")))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or("guard: no file_path in the hook input: blocked")?;
    let decided = relative(&r.checkout, path)
        .map_err(|why| (Block::Protected, why))
        .and_then(|rel| decide(&r, &rel).map(|()| rel));
    match decided {
        Ok(_) => Ok(()),
        Err((kind, why)) => {
            if let Some(dir) = rules.parent() {
                let line = json!({
                    "at": chrono::Utc::now().to_rfc3339(),
                    "path": path,
                    "reason": why,
                    "kind": kind.as_str(),
                });
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("guard-blocks.jsonl"))
                    .and_then(|mut f| writeln!(f, "{line}"));
            }
            Err(why)
        }
    }
}

/// The publish refusals (PIP-29, PIP-31): a path changed since the merge-base (`changed`)
/// that `protected` blocks; a `locked` test changed or deleted since the pushed head
/// (`since_head`). `Err`: the paths, `, `-joined.
pub fn check(
    changed: &[(char, String)],
    protected: &Protected,
    since_head: &[(char, String)],
    locked: &[String],
) -> Result<(), String> {
    let mut bad: Vec<String> = changed
        .iter()
        .filter(|(_, p)| protected.blocks(p))
        .map(|(_, p)| format!("{p} (protected)"))
        .collect();
    for (st, p) in since_head {
        if matches!(st, 'M' | 'D' | 'T') && locked.contains(p) {
            bad.push(format!("{p} (a test already pushed)"));
        }
    }
    if bad.is_empty() {
        Ok(())
    } else {
        Err(bad.join(", "))
    }
}
