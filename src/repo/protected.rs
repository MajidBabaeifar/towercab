//! Protected paths (REPO-8): control files + `TOWERCAB.md` `protected` globs, minus the
//! intent's `unlock`. The guard (PIP-29) asks [`Protected::blocks`]; the sandbox gets
//! [`Protected::deny_write`].

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobMatcher};

/// Files Towercab reads from the base branch, what runs on every push, and git's own directory
/// (its config and hooks run in Towercab's git calls in the checkout; never unlocked).
pub const CONTROL: [&str; 6] = [
    "CLAUDE.md",
    "REVIEW.md",
    "TOWERCAB.md",
    ".github/**",
    ".claude/**",
    ".git/**",
];

/// The checkout's git directory: no `unlock` reaches it.
const GIT: &str = ".git";

/// What makes a glob component not literal (`\` escapes the next character).
const WILD: [char; 5] = ['*', '?', '[', '{', '\\'];

/// Characters a Linux sandbox write entry can't contain.
const SANDBOX_WILD: [char; 3] = ['*', '?', '['];

/// A glob relative to the repo root: a leading `./` or `/` and a trailing `/` dropped.
fn normalize(g: &str) -> &str {
    let mut g = g;
    loop {
        if let Some(rest) = g.strip_prefix("./") {
            g = rest;
        } else if let Some(rest) = g.strip_prefix('/') {
            g = rest;
        } else {
            break;
        }
    }
    g.trim_end_matches('/')
}

/// `globset` with `literal_separator`, case-sensitive, `\` escapes, `{a,b}` alternation with
/// empty alternates (`x{,.bak}` = `x` or `x.bak`).
fn builder(g: &str) -> Result<GlobMatcher, String> {
    GlobBuilder::new(g)
        .literal_separator(true)
        .case_insensitive(false)
        .backslash_escape(true)
        .empty_alternates(true)
        .build()
        .map(|g| g.compile_matcher())
        .map_err(|e| e.kind().to_string())
}

/// A protected, tests or unlock glob (**Globs**): `*`, `?`, `[…]` stay inside one path
/// component, `**` spans them, `{a,b}` alternates, case-sensitive; `P/**` also matches `P`.
/// Empty, an empty, `.` or `..` component (paths have none, so it would match nothing) or a
/// bad glob → `bad glob "<g>"[: <error>]` (the caller adds the key).
pub fn glob(g: &str) -> Result<GlobMatcher, String> {
    let bad = || format!("bad glob \"{g}\"");
    let norm = normalize(g);
    if norm.is_empty() || norm.split('/').any(|c| matches!(c, "" | "." | "..")) {
        return Err(bad());
    }
    let m = builder(norm).map_err(|e| format!("{}: {e}", bad()))?;
    match norm.strip_suffix("/**") {
        // `P` stays outside the group, so its own `**` keep their meaning.
        Some(p) => builder(&format!("{p}{{,/**}}")).map_err(|e| format!("{}: {e}", bad())),
        None => Ok(m),
    }
}

/// The leading components of a normalized glob with no `*`, `?`, `[`, `{`, `\`.
fn literal_prefix(norm: &str) -> String {
    norm.split('/')
        .take_while(|c| !c.contains(WILD))
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Debug, Clone)]
struct Rule {
    /// Normalized.
    glob: String,
    matcher: GlobMatcher,
    prefix: String,
}

impl Rule {
    fn new(key: &str, g: &str) -> Result<Rule, String> {
        let matcher = glob(g).map_err(|e| format!("{key}: {e}"))?;
        let glob = normalize(g).to_string();
        let prefix = literal_prefix(&glob);
        Ok(Rule {
            glob,
            matcher,
            prefix,
        })
    }

    /// Matches `rel` (normalized components) or one of its parent directories.
    fn covers(&self, parts: &[&str]) -> bool {
        (1..=parts.len()).any(|n| self.matcher.is_match(parts[..n].join("/")))
    }

    /// Could match something inside directory `dir`: its literal prefix is equal to, inside
    /// or above `dir`, or empty.
    fn may_reach_into(&self, dir: &str) -> bool {
        let (p, d) = (self.prefix.as_str(), dir);
        p.is_empty()
            || p == d
            || p.strip_prefix(d).is_some_and(|r| r.starts_with('/'))
            || d.strip_prefix(p).is_some_and(|r| r.starts_with('/'))
    }
}

/// The protected paths of one worker run.
#[derive(Debug, Clone)]
pub struct Protected {
    protected: Vec<Rule>,
    unlock: Vec<Rule>,
}

/// `rel`'s components without empty and `.` ones; `None` for an absolute path or a `..`.
fn components(rel: &str) -> Option<Vec<&str>> {
    if rel.starts_with('/') {
        return None;
    }
    let parts: Vec<&str> = rel
        .split('/')
        .filter(|c| !c.is_empty() && *c != ".")
        .collect();
    if parts.contains(&"..") {
        return None;
    }
    Some(parts)
}

impl Protected {
    /// [`CONTROL`] + `protected` (from `TOWERCAB.md`), minus the intent's `unlock`. A bad glob
    /// → `protected: bad glob "<g>"…` / `unlock: …`.
    pub fn new(protected: &[String], unlock: &[String]) -> Result<Protected, String> {
        let protected = CONTROL
            .iter()
            .map(|g| Rule::new("protected", g))
            .chain(protected.iter().map(|g| Rule::new("protected", g)))
            .collect::<Result<_, _>>()?;
        let unlock = unlock
            .iter()
            .map(|g| Rule::new("unlock", g))
            .collect::<Result<_, _>>()?;
        Ok(Protected { protected, unlock })
    }

    /// The worker may not write repo-relative `rel`: a protected glob matches it or one of its
    /// parent directories and no `unlock` glob does. An absolute path, a `..` or `.git` → true.
    pub fn blocks(&self, rel: &str) -> bool {
        let Some(parts) = components(rel) else {
            return true;
        };
        parts.first() == Some(&GIT)
            || self.protected.iter().any(|r| r.covers(&parts)) && !self.unlocked(&parts)
    }

    fn unlocked(&self, parts: &[&str]) -> bool {
        self.unlock.iter().any(|r| r.covers(parts))
    }

    /// Absolute paths for the sandbox's `denyWrite` (PIP-29): per protected glob its literal
    /// path without a wildcard, `P` for `P/**`, else what it matches under its literal prefix;
    /// existing paths only; unlocked entries dropped and directories an `unlock` glob may reach
    /// into split into their children (never `.git`); sorted, none inside another, none whose
    /// repo-relative part contains `*`, `?` or `[` (left to the guard and publish). A checkout
    /// path containing one → `Err`: the run refuses rather than going unprotected.
    pub fn deny_write(&self, checkout: &Path) -> Result<Vec<PathBuf>, String> {
        let checkout = std::path::absolute(checkout).unwrap_or_else(|_| checkout.to_path_buf());
        if checkout.to_string_lossy().contains(SANDBOX_WILD) {
            return Err(format!(
                "checkout {} contains *, ? or [: denyWrite can't name it",
                checkout.display()
            ));
        }
        let mut found = BTreeSet::new();
        for rule in &self.protected {
            let literal = match rule.glob.strip_suffix("/**") {
                Some(p) if !p.contains(WILD) => Some(p),
                _ if !rule.glob.contains(WILD) => Some(rule.glob.as_str()),
                _ => None,
            };
            match literal {
                Some(p) => {
                    if fs::symlink_metadata(checkout.join(p)).is_ok() {
                        found.insert(p.to_string());
                    }
                }
                None => walk(&checkout, &rule.prefix, &rule.matcher, &mut found),
            }
        }
        let mut out = BTreeSet::new();
        for rel in found {
            self.carve(&checkout, rel, &mut out);
        }
        let mut kept: Vec<PathBuf> = Vec::new();
        for p in out {
            if kept.last().is_some_and(|k| p.starts_with(k)) {
                continue;
            }
            let rel = p.strip_prefix(&checkout).unwrap_or(&p);
            if rel.to_string_lossy().contains(SANDBOX_WILD) {
                continue;
            }
            kept.push(p);
        }
        Ok(kept)
    }

    /// `rel` unless unlocked; a real directory an `unlock` glob may reach into → its children,
    /// recursively. `.git` and what is under it: always whole.
    fn carve(&self, checkout: &Path, rel: String, out: &mut BTreeSet<PathBuf>) {
        let path = checkout.join(&rel);
        let parts: Vec<&str> = rel.split('/').collect();
        if parts[0] == GIT {
            out.insert(path);
            return;
        }
        if self.unlocked(&parts) {
            return;
        }
        let is_dir = fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
        if is_dir && self.unlock.iter().any(|u| u.may_reach_into(&rel)) {
            for name in children(&path) {
                match name.into_string() {
                    Ok(name) => self.carve(checkout, format!("{rel}/{name}"), out),
                    // No glob names it, so no unlock either.
                    Err(name) => {
                        out.insert(path.join(name));
                    }
                }
            }
        } else {
            out.insert(path);
        }
    }
}

/// Entry names in `dir`, sorted; unreadable → none.
fn children(dir: &Path) -> Vec<OsString> {
    let mut names: Vec<OsString> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    names.sort();
    names
}

/// Every entry under `prefix` (repo-relative, `""` = the root) that `m` matches; a matched
/// directory is not entered, symlinks are not followed, `.git` is skipped.
fn walk(checkout: &Path, prefix: &str, m: &GlobMatcher, found: &mut BTreeSet<String>) {
    let dir = checkout.join(prefix);
    if !fs::symlink_metadata(&dir).is_ok_and(|md| md.is_dir()) {
        return;
    }
    // A name that isn't UTF-8 matches no glob.
    for name in children(&dir)
        .into_iter()
        .filter_map(|n| n.into_string().ok())
    {
        if name == ".git" {
            continue;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if m.is_match(&rel) {
            found.insert(rel);
        } else if fs::symlink_metadata(checkout.join(&rel)).is_ok_and(|md| md.is_dir()) {
            walk(checkout, &rel, m, found);
        }
    }
}
