//! Hermetic fixtures: a bare `intents` repo in a temp dir, my clone of it, Towercab's checkout.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{DateTime, FixedOffset};
use tempfile::TempDir;
use towercab::config::{Config, IntentsConfig};
use towercab::intents::{Intent, Store};

/// `git <args>` in `dir` as "me"; panics on failure.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=me",
            "-c",
            "user.email=me@localhost",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The repo root.
pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// A file in the repo.
pub fn read(rel: &str) -> String {
    fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

pub fn t(s: &str) -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339(s).expect("RFC 3339")
}

/// A minimal `intent.md`.
pub fn intent_md(repo: &str, extra: &str, title: &str) -> String {
    format!("---\nrepo: {repo}\n{extra}---\n\n# Intent: {title}\n")
}

/// An intent as the store would hand it out.
pub fn intent(dir: &str, text: &str) -> Intent {
    let mut i = Intent::parse(text).expect("fixture parses");
    let name = dir.rsplit('/').next().unwrap();
    let (id, slug) = towercab::intents::id::split_dir(name).expect("fixture dir name");
    (i.id, i.slug, i.dir) = (id, slug, dir.to_string());
    i
}

pub fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

/// The intent home: bare remote, my clone, Towercab's checkout path (cloned on first open).
pub struct Home {
    pub tmp: TempDir,
    pub remote: PathBuf,
    pub me: PathBuf,
    pub checkout: PathBuf,
}

impl Home {
    /// A bare repo on `main` with one commit holding `files`.
    pub fn new(files: &[(&str, &str)]) -> Home {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("intents.git");
        let me = tmp.path().join("me");
        fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--quiet", "--bare", "-b", "main"]);
        git(
            tmp.path(),
            &["clone", "--quiet", remote.to_str().unwrap(), "me"],
        );
        git(&me, &["checkout", "--quiet", "-B", "main"]);
        write(&me, "README.md", "# intents\n");
        for (rel, text) in files {
            write(&me, rel, text);
        }
        git(&me, &["add", "-A"]);
        git(&me, &["commit", "--quiet", "-m", "seed"]);
        git(&me, &["push", "--quiet", "origin", "HEAD:main"]);
        let checkout = tmp.path().join("towercab").join("intents");
        Home {
            tmp,
            remote,
            me,
            checkout,
        }
    }

    pub fn config(&self) -> Config {
        Config {
            file: self.tmp.path().join("config.toml"),
            intents: IntentsConfig {
                remote: Some(self.remote.to_str().unwrap().to_string()),
                path: self.checkout.clone(),
                cutoff: 7,
            },
            repos: Default::default(),
        }
    }

    pub fn store(&self) -> Store {
        Store::open(&self.config()).expect("store opens")
    }

    /// I change files in my clone and push to `main` (`None` deletes).
    pub fn push_mine(&self, files: &[(&str, Option<&str>)], msg: &str) {
        git(&self.me, &["pull", "--quiet", "--rebase", "origin", "main"]);
        for (rel, text) in files {
            match text {
                Some(text) => write(&self.me, rel, text),
                None => fs::remove_file(self.me.join(rel)).unwrap(),
            }
        }
        git(&self.me, &["add", "-A"]);
        git(&self.me, &["commit", "--quiet", "-m", msg]);
        git(&self.me, &["push", "--quiet", "origin", "HEAD:main"]);
    }

    /// A file on the remote's `main`.
    pub fn remote_file(&self, rel: &str) -> String {
        git(&self.remote, &["show", &format!("main:{rel}")])
    }

    /// Whether `rel` exists on the remote's `main`.
    pub fn remote_has(&self, rel: &str) -> bool {
        !git(&self.remote, &["ls-tree", "--name-only", "main", rel])
            .trim()
            .is_empty()
    }

    /// Commit subjects on the remote's `main`, newest first.
    pub fn log(&self) -> Vec<String> {
        git(&self.remote, &["log", "--format=%s", "main"])
            .lines()
            .map(str::to_string)
            .collect()
    }

    pub fn head(&self) -> String {
        git(&self.remote, &["rev-parse", "main"]).trim().to_string()
    }

    /// `git status --porcelain` of Towercab's checkout is empty.
    pub fn checkout_clean(&self) -> bool {
        git(&self.checkout, &["status", "--porcelain"])
            .trim()
            .is_empty()
    }
}
