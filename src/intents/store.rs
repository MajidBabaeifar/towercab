//! The store interface (INT-12): the only way Towercab reads or writes intents.
//!
//! Reads pull first; writes pull, change files, regenerate `TODO.md` and `DONE.md`, commit and
//! push to `main`, and replay the change on a fresh `main` when the push is rejected (INT-10).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;

use chrono::{DateTime, FixedOffset, Local, SecondsFormat};

use super::git::Checkout;
use super::id::{self, is_id, new_id, resolve, split_dir};
use super::intent::{Intent, Value, format_value};
use super::views;
use crate::config::Config;
use crate::priority;

/// Old `DONE.md` lines, kept by `migrate` (INT-13).
pub const LEGACY: &str = "done/legacy.md";

/// Retries after the first rejected push.
pub const PUSH_RETRIES: usize = 3;
pub const OLD_FORMAT: &str = "TODO.md is in the old format: run towercab migrate";

/// `<file> is in the old format: run towercab migrate`.
pub fn old_format(file: &str) -> String {
    format!("{file} is in the old format: run towercab migrate")
}

/// `rel` under `root`; missing → `None`; any other error → `<rel>: <error>`.
pub fn read_optional(root: &Path, rel: &str) -> Result<Option<String>, String> {
    match fs::read_to_string(root.join(rel)) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{rel}: {e}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// Clone, pull or push failed: worth retrying later (LOOP-10).
    Sync(String),
    /// Anything else; the message is the reason.
    Refused(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Sync(m) | StoreError::Refused(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for StoreError {}

/// A folder or file that can't be read (INT-11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    /// `intents/<dir>` or `intents/<dir>/intent.md` (or under `done/`).
    pub path: String,
    pub reason: String,
}

impl Unreadable {
    /// The ID in the folder name, if it has one.
    pub fn id(&self) -> Option<String> {
        self.path
            .split('/')
            .nth(1)
            .and_then(split_dir)
            .map(|(id, _)| id)
    }
}

/// Everything in the intent home's `main`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Listing {
    /// In `intents/`, not `stage: done|dropped`; PRI-4 order.
    pub open: Vec<Intent>,
    /// In `done/`, or `stage: done|dropped` anywhere; newest ID first.
    pub done: Vec<Intent>,
    /// By path.
    pub unreadable: Vec<Unreadable>,
    /// `done/legacy.md` (old `DONE.md` lines), or empty.
    pub legacy: String,
}

impl Listing {
    /// IDs in `done/legacy.md`.
    pub fn legacy_ids(&self) -> BTreeSet<String> {
        legacy_ids(&self.legacy)
    }

    /// IDs of every folder in `intents/` and `done/`, readable or not.
    pub fn folder_ids(&self) -> BTreeSet<String> {
        let mut ids: BTreeSet<String> = self
            .open
            .iter()
            .chain(&self.done)
            .map(|i| i.id.clone())
            .collect();
        ids.extend(self.unreadable.iter().filter_map(Unreadable::id));
        ids
    }

    /// IDs that are never handed out again: every folder's and every legacy one.
    pub fn taken(&self) -> BTreeSet<String> {
        let mut ids = self.folder_ids();
        ids.extend(self.legacy_ids());
        ids
    }

    /// Finished: done or dropped, in `done/`, or in `done/legacy.md`.
    pub fn finished_ids(&self) -> BTreeSet<String> {
        let mut ids = self.legacy_ids();
        ids.extend(self.done.iter().map(|i| i.id.clone()));
        ids
    }
}

/// IDs written as a whole word in old `DONE.md` lines.
pub fn legacy_ids(text: &str) -> BTreeSet<String> {
    text.split_whitespace()
        .filter(|w| is_id(w))
        .map(str::to_string)
        .collect()
}

/// What `towercab add` (and later the drafter) gives the store.
#[derive(Debug, Clone, PartialEq)]
pub struct NewIntent {
    pub repo: String,
    pub title: String,
    pub u: Option<u8>,
    pub i: Option<u8>,
    pub a: Option<u8>,
    pub source: String,
    /// Becomes the ID (local time) and `started`.
    pub created: DateTime<FixedOffset>,
}

impl NewIntent {
    /// The thin `intent.md` (INT-2): `repo`, the scores given, `source`, `started`, the title.
    pub fn render(&self) -> String {
        let mut fm = format!("repo: {}\n", format_value(&Value::Str(self.repo.clone())));
        for (key, score) in [("u", self.u), ("i", self.i), ("a", self.a)] {
            if let Some(n) = score {
                fm.push_str(&format!("{key}: {n}\n"));
            }
        }
        fm.push_str(&format!(
            "source: {}\n",
            format_value(&Value::Str(self.source.clone()))
        ));
        fm.push_str(&format!("started: {}\n", rfc3339(self.created)));
        format!("---\n{fm}---\n\n# Intent: {}\n", self.title.trim())
    }
}

/// RFC 3339 to the second, with offset.
pub fn rfc3339(t: DateTime<FixedOffset>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// Now, local time to the second.
pub fn now() -> DateTime<FixedOffset> {
    let t = Local::now().fixed_offset();
    DateTime::parse_from_rfc3339(&rfc3339(t)).unwrap_or(t)
}

pub struct Store {
    checkout: Checkout,
    cutoff: u8,
}

impl Store {
    /// Opens `[intents].path`, cloning `[intents].remote` there when it is missing.
    /// Refuses a checkout on any branch but `main` (INT-4).
    pub fn open(config: &Config) -> Result<Store, StoreError> {
        let path = &config.intents.path;
        let checkout = if path.exists() {
            Checkout::new(path).map_err(StoreError::Refused)?
        } else if let Some(remote) = &config.intents.remote {
            Checkout::clone(remote, path).map_err(StoreError::Sync)?
        } else {
            return Err(StoreError::Refused(format!(
                "intents: {} does not exist and [intents].remote is not set",
                path.display()
            )));
        };
        let branch = checkout.branch();
        if branch != "main" {
            return Err(StoreError::Refused(format!(
                "intents: {} is on {branch}, not main",
                path.display()
            )));
        }
        Ok(Store {
            checkout,
            cutoff: config.intents.cutoff,
        })
    }

    pub fn path(&self) -> &Path {
        &self.checkout.path
    }

    pub fn checkout(&self) -> &Checkout {
        &self.checkout
    }

    pub fn cutoff(&self) -> u8 {
        self.cutoff
    }

    /// Pulls, then reads every intent.
    pub fn list(&self) -> Result<Listing, StoreError> {
        self.sync()?;
        Ok(self.scan())
    }

    /// An open intent by ID or unique ID suffix.
    pub fn get(&self, id_or_suffix: &str) -> Result<Intent, StoreError> {
        let listing = self.list()?;
        find_open(&listing, id_or_suffix)
    }

    /// Writes a thin intent to `main` (commit `towercab: add <id>`).
    pub fn add(&self, new: NewIntent) -> Result<Intent, StoreError> {
        let refuse = |m: String| Err(StoreError::Refused(m));
        if new.title.trim().is_empty() || new.title.contains(['\n', '\r']) {
            return refuse("the title must be one non-empty line".into());
        }
        for (key, score) in [("u", new.u), ("i", new.i), ("a", new.a)] {
            if score.is_some_and(|n| !(1..=5).contains(&n)) {
                return refuse(format!("{key} must be an integer 1-5"));
            }
        }
        let text = new.render();
        Intent::parse(&text).map_err(StoreError::Refused)?;
        self.write(true, |listing| {
            let id = new_id(new.created, &listing.taken());
            let slug = id::slug(&new.title);
            let dir = format!("intents/{id}-{slug}");
            let mut intent = Intent::parse(&text).map_err(StoreError::Refused)?;
            self.write_file(&format!("{dir}/intent.md"), &text)?;
            let msg = format!("towercab: add {id}");
            (intent.id, intent.slug, intent.dir) = (id, slug, dir);
            Ok((msg, intent))
        })
    }

    /// Changes one open intent through `f` (commit `towercab: <what> <id>`); `Err` from `f` →
    /// nothing written. `stage: done|dropped` adds `finished` and moves the folder to `done/`.
    pub fn update<F>(&self, id_or_suffix: &str, what: &str, mut f: F) -> Result<Intent, StoreError>
    where
        F: FnMut(&mut Intent) -> Result<(), String>,
    {
        self.write(true, |listing| {
            let original = find_open(listing, id_or_suffix)?;
            let mut intent = original.clone();
            f(&mut intent).map_err(StoreError::Refused)?;
            (intent.id, intent.slug, intent.dir) = (
                original.id.clone(),
                original.slug.clone(),
                original.dir.clone(),
            );
            let finished = intent.stage().is_some_and(|s| s.is_finished());
            if finished && !intent.has("finished") {
                intent
                    .set("finished", Value::Str(rfc3339(now())))
                    .map_err(StoreError::Refused)?;
            }
            self.write_file(&format!("{}/intent.md", intent.dir), &intent.render())?;
            if finished && intent.dir.starts_with("intents/") {
                let to = format!("done/{}-{}", intent.id, intent.slug);
                fs::create_dir_all(self.path().join("done"))
                    .map_err(|e| StoreError::Refused(format!("done/: {e}")))?;
                self.checkout
                    .mv(&intent.dir, &to)
                    .map_err(StoreError::Refused)?;
                intent.dir = to;
            }
            Ok((format!("towercab: {what} {}", intent.id), intent))
        })
    }

    /// Reads every folder in the working tree (no git).
    pub fn scan(&self) -> Listing {
        scan(self.path())
    }

    /// The write protocol (INT-10). `change` edits files for one attempt and returns the commit
    /// message; it runs again on a fresh `main` after a rejected push. `guard` refuses before
    /// `migrate` has run (INT-13).
    pub(crate) fn write<T>(
        &self,
        guard: bool,
        mut change: impl FnMut(&Listing) -> Result<(String, T), StoreError>,
    ) -> Result<T, StoreError> {
        self.sync()?;
        let mut failed = 0;
        loop {
            if guard {
                self.refuse_old_format()?;
            }
            let listing = self.scan();
            if let Some(u) = listing.unreadable.iter().find(|u| u.path == LEGACY) {
                // Its IDs and lines can't be kept: no write until it reads again.
                return Err(StoreError::Refused(format!("{}: {}", u.path, u.reason)));
            }
            let attempt = change(&listing).and_then(|(msg, out)| {
                self.write_views()?;
                let committed = self.checkout.commit(&msg).map_err(StoreError::Refused)?;
                Ok((committed, out))
            });
            let (committed, out) = match attempt {
                Ok(x) => x,
                Err(e) => {
                    let _ = self.checkout.discard();
                    return Err(e);
                }
            };
            if !committed || !self.checkout.origin {
                return Ok(out);
            }
            let Err(e) = self.checkout.push() else {
                return Ok(out);
            };
            failed += 1;
            if failed > PUSH_RETRIES {
                let _ = self.checkout.reset_to_origin();
                return Err(StoreError::Sync(format!("push failed {failed} times: {e}")));
            }
            if let Err(fe) = self.checkout.fetch() {
                let _ = self.checkout.reset_to_origin();
                return Err(StoreError::Sync(fe));
            }
            self.checkout.reset_to_origin().map_err(StoreError::Sync)?;
        }
    }

    /// Refuses on uncommitted changes, then pulls.
    fn sync(&self) -> Result<(), StoreError> {
        match self.checkout.is_clean() {
            Ok(true) => {}
            Ok(false) => {
                return Err(StoreError::Refused(format!(
                    "intents: {} has uncommitted changes",
                    self.path().display()
                )));
            }
            Err(e) => return Err(StoreError::Refused(e)),
        }
        self.checkout.pull().map_err(StoreError::Sync)
    }

    /// `TODO.md` or `DONE.md` present but not generated: regenerating would drop old lines.
    fn refuse_old_format(&self) -> Result<(), StoreError> {
        for file in ["TODO.md", "DONE.md"] {
            match read_optional(self.path(), file) {
                Ok(Some(text)) if !views::is_generated(&text) => {
                    return Err(StoreError::Refused(old_format(file)));
                }
                Ok(_) => {}
                Err(e) => return Err(StoreError::Refused(e)),
            }
        }
        Ok(())
    }

    fn write_views(&self) -> Result<(), StoreError> {
        let listing = self.scan();
        self.write_file("TODO.md", &views::todo(&listing, self.cutoff))?;
        self.write_file("DONE.md", &views::done(&listing))
    }

    /// Writes `rel` (relative to the checkout), creating folders.
    pub(crate) fn write_file(&self, rel: &str, text: &str) -> Result<(), StoreError> {
        let path = self.path().join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| StoreError::Refused(format!("{rel}: {e}")))?;
        }
        fs::write(&path, text).map_err(|e| StoreError::Refused(format!("{rel}: {e}")))
    }
}

/// An open intent by ID or suffix; an unreadable one fails with its reason (INT-11).
fn find_open(listing: &Listing, s: &str) -> Result<Intent, StoreError> {
    let bad: Vec<(String, &Unreadable)> = listing
        .unreadable
        .iter()
        .filter(|u| u.path.starts_with("intents/"))
        .filter_map(|u| u.id().map(|id| (id, u)))
        .collect();
    let ids = listing
        .open
        .iter()
        .map(|i| i.id.as_str())
        .chain(bad.iter().map(|(id, _)| id.as_str()));
    let id = resolve(s, ids).map_err(StoreError::Refused)?;
    if let Some((_, u)) = bad.iter().find(|(b, _)| *b == id) {
        return Err(StoreError::Refused(format!("{}: {}", u.path, u.reason)));
    }
    listing
        .open
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .ok_or_else(|| StoreError::Refused(format!("no open intent matches {s}")))
}

/// Reads `intents/` and `done/` under `root`.
pub fn scan(root: &Path) -> Listing {
    let mut folders = Vec::new();
    for base in ["intents", "done"] {
        let Ok(entries) = fs::read_dir(root.join(base)) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        folders.extend(names.into_iter().map(|n| (base, n)));
    }
    let mut count: BTreeMap<String, usize> = BTreeMap::new();
    for (_, name) in &folders {
        if let Some((id, _)) = split_dir(name) {
            *count.entry(id).or_default() += 1;
        }
    }
    let mut listing = Listing::default();
    match read_optional(root, LEGACY) {
        Ok(text) => listing.legacy = text.unwrap_or_default(),
        Err(e) => listing.unreadable.push(Unreadable {
            path: LEGACY.into(),
            reason: e.trim_start_matches(&format!("{LEGACY}: ")).to_string(),
        }),
    }
    for (base, name) in folders {
        let dir = format!("{base}/{name}");
        let mut bad = |path: String, reason: &str| {
            listing.unreadable.push(Unreadable {
                path,
                reason: reason.to_string(),
            })
        };
        let Some((id, slug)) = split_dir(&name) else {
            bad(dir, "not an <id>-<slug> folder");
            continue;
        };
        if count[&id] > 1 {
            bad(dir, "duplicate id");
            continue;
        }
        let file = format!("{dir}/intent.md");
        let text = match fs::read(root.join(&file)) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(t) => t,
                Err(_) => {
                    bad(file, "not UTF-8");
                    continue;
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                bad(dir, "no intent.md");
                continue;
            }
            Err(e) => {
                bad(file, &e.to_string());
                continue;
            }
        };
        match Intent::parse(&text) {
            Ok(mut intent) => {
                (intent.id, intent.slug, intent.dir) = (id, slug, dir);
                if base == "done" || intent.stage().is_some_and(|s| s.is_finished()) {
                    listing.done.push(intent);
                } else {
                    listing.open.push(intent);
                }
            }
            Err(reason) => bad(file, &reason),
        }
    }
    listing.open.sort_by(priority::cmp);
    listing
        .done
        .sort_by_key(|i| std::cmp::Reverse(id::sort_key(&i.id)));
    listing.unreadable.sort_by(|a, b| a.path.cmp(&b.path));
    listing
}
