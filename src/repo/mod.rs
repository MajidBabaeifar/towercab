//! The repo contract ([REPO](../../specs/repo.md)): `CLAUDE.md`, `REVIEW.md` and `TOWERCAB.md`,
//! always read from the base branch; protected paths; `towercab protect`.

pub mod markdown;
pub mod protect;
pub mod protected;
pub mod review;
pub mod towercab;
pub mod verifying;

use std::fmt;
use std::path::Path;

pub use protected::Protected;
pub use review::{Pass, Review};
pub use towercab::{Deploy, Live, Release, Rollback, Towercab};
pub use verifying::{Run, Verifying};

use crate::intents::git::git_command;

/// The three files, in the order they are parsed.
pub const FILES: [&str; 3] = ["CLAUDE.md", "REVIEW.md", "TOWERCAB.md"];

/// What a repo tells Towercab about itself, from its base branch.
#[derive(Debug, Clone, PartialEq)]
pub struct RepoFiles {
    /// `CLAUDE.md` as written (given to every session, PIP-24).
    pub claude_md: String,
    pub verifying: Verifying,
    pub review: Review,
    pub towercab: Towercab,
}

/// Why the repo files can't be used.
#[derive(Debug, Clone, PartialEq)]
pub enum RepoError {
    /// No `## Verifying your work` with a non-empty ` ```checks ` (REPO-5): the loop waits
    /// with `add CLAUDE.md verifying block`.
    NoVerifyingBlock,
    /// A present file is malformed: `<file>: <where>: <what>`.
    Invalid(String),
    /// `git` failed or `origin/<base>` is missing: `<clone>: <stderr>`. Retried.
    Git(String),
}

impl fmt::Display for RepoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RepoError::NoVerifyingBlock => f.write_str("add CLAUDE.md verifying block"),
            RepoError::Invalid(s) | RepoError::Git(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for RepoError {}

/// The files' texts (`None` = absent) → their contents. Pure; `CLAUDE.md`, `REVIEW.md`,
/// `TOWERCAB.md` in that order, the first error wins.
pub fn parse(
    claude: Option<&str>,
    review: Option<&str>,
    towercab: Option<&str>,
) -> Result<RepoFiles, RepoError> {
    assemble([Ok(claude), Ok(review), Ok(towercab)])
}

/// Each file's text, or why it couldn't be read, in [`FILES`] order.
fn assemble(files: [Result<Option<&str>, RepoError>; 3]) -> Result<RepoFiles, RepoError> {
    let [claude, review, towercab] = files;
    let claude = claude?.ok_or(RepoError::NoVerifyingBlock)?;
    let verifying = Verifying::parse(claude)?;
    let review = match review? {
        Some(text) => Review::parse(text).map_err(RepoError::Invalid)?,
        None => Review::default(),
    };
    let towercab = match towercab? {
        Some(text) => Towercab::parse(text).map_err(RepoError::Invalid)?,
        None => Towercab::default(),
    };
    Ok(RepoFiles {
        claude_md: claude.to_string(),
        verifying,
        review,
        towercab,
    })
}

/// `git <args>` in `clone` → stdout bytes; failure → `<clone>: <stderr>`.
fn git(clone: &Path, args: &[&str]) -> Result<Vec<u8>, RepoError> {
    let failed = |e: String| RepoError::Git(format!("{}: {e}", clone.display()));
    let out = git_command()
        .args(args)
        .current_dir(clone)
        .output()
        .map_err(|e| failed(format!("git: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(failed(if err.is_empty() {
            format!("git {} failed", args[0])
        } else {
            err
        }));
    }
    Ok(out.stdout)
}

/// The three files from `refs/remotes/origin/<base>` of the local `clone` (never the working
/// tree or a PR; no fetch, the caller fetches), then [`parse`]. Only regular files are read: a
/// symlink, directory or submodule in a file's place, or non-UTF-8 bytes → `Invalid`.
pub fn load(clone: &Path, base: &str) -> Result<RepoFiles, RepoError> {
    let tree = format!("refs/remotes/origin/{base}");
    let listing = git(
        clone,
        &["ls-tree", "-z", &tree, "--", FILES[0], FILES[1], FILES[2]],
    )?;
    let mut texts: [Result<Option<String>, RepoError>; 3] = [Ok(None), Ok(None), Ok(None)];
    for entry in listing.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let entry = String::from_utf8_lossy(entry);
        let Some((meta, name)) = entry.split_once('\t') else {
            continue;
        };
        let Some(k) = FILES.iter().position(|f| *f == name) else {
            continue;
        };
        let mut meta = meta.split(' ');
        let (mode, oid) = (meta.next().unwrap_or(""), meta.nth(1).unwrap_or(""));
        let not_file = |what: &str| Err(RepoError::Invalid(format!("{name}: {what}, not a file")));
        texts[k] = match mode {
            "100644" | "100755" => git(clone, &["cat-file", "blob", oid]).and_then(|bytes| {
                String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| RepoError::Invalid(format!("{name}: not UTF-8")))
            }),
            "120000" => not_file("a symlink"),
            "040000" => not_file("a directory"),
            "160000" => not_file("a submodule"),
            other => not_file(&format!("mode {other}")),
        };
    }
    let [c, r, t] = texts;
    assemble([c.as_ref(), r.as_ref(), t.as_ref()].map(|x| match x {
        Ok(text) => Ok(text.as_deref()),
        Err(e) => Err(e.clone()),
    }))
}
