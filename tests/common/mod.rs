//! Hermetic fixtures: a bare `intents` repo in a temp dir, my clone of it, Towercab's checkout.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{DateTime, FixedOffset};
use tempfile::TempDir;
use towercab::config::{Config, IntentsConfig};
use towercab::intents::{Intent, Store};

pub mod world;

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
        Config::new(
            self.tmp.path().join("config.toml"),
            IntentsConfig {
                remote: Some(self.remote.to_str().unwrap().to_string()),
                path: self.checkout.clone(),
                cutoff: 7,
            },
        )
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

/// A fake `gh` on disk: `<dir>/bin/gh`, a shell script that records each call's argv
/// (`argv-<n>`, one argument per line) and stdin (`stdin-<n>`), then answers with canned
/// response `n` (stdout, stderr, exit code). A call without a response exits 99.
pub struct FakeGh {
    pub dir: PathBuf,
    /// The executable; its directory can go first on `PATH`.
    pub bin: PathBuf,
}

const FAKE_GH: &str = r#"#!/bin/sh
d="$(dirname "$0")/.."
[ "$1" = "__probe" ] && exit 0
n=$(($(cat "$d/count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$d/count"
: > "$d/argv-$n"
for a in "$@"; do printf '%s\n' "$a" >> "$d/argv-$n"; done
cat > "$d/stdin-$n"
if [ ! -f "$d/code-$n" ]; then echo "fake gh: unexpected call $n" >&2; exit 99; fi
cat "$d/out-$n"
cat "$d/err-$n" >&2
exit "$(cat "$d/code-$n")"
"#;

impl FakeGh {
    /// `responses[i]` answers call `i + 1`: (stdout, stderr, exit code).
    pub fn new(dir: &Path, responses: &[(&str, &str, i32)]) -> FakeGh {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin").join("gh");
        fs::create_dir_all(bin.parent().unwrap()).unwrap();
        for (i, (out, err, code)) in responses.iter().enumerate() {
            let n = i + 1;
            fs::write(dir.join(format!("out-{n}")), out).unwrap();
            fs::write(dir.join(format!("err-{n}")), err).unwrap();
            fs::write(dir.join(format!("code-{n}")), code.to_string()).unwrap();
        }
        fs::write(&bin, FAKE_GH).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        // Another test's fork may still hold the file open for writing (ETXTBSY) for a moment.
        for _ in 0..500 {
            match Command::new(&bin).arg("__probe").status() {
                Err(e) if e.raw_os_error() == Some(26) => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                r => {
                    assert!(r.unwrap().success(), "fake gh runs");
                    break;
                }
            }
        }
        FakeGh {
            dir: dir.to_path_buf(),
            bin,
        }
    }

    /// Each call's arguments, in order.
    pub fn calls(&self) -> Vec<Vec<String>> {
        let n: usize = fs::read_to_string(self.dir.join("count"))
            .map(|s| s.trim().parse().unwrap())
            .unwrap_or(0);
        (1..=n)
            .map(|i| {
                fs::read_to_string(self.dir.join(format!("argv-{i}")))
                    .unwrap()
                    .lines()
                    .map(str::to_string)
                    .collect()
            })
            .collect()
    }

    /// What call `n` (1-based) read on stdin.
    pub fn stdin(&self, n: usize) -> String {
        fs::read_to_string(self.dir.join(format!("stdin-{n}"))).unwrap()
    }
}

/// Writes an executable `#!/bin/sh` script at `path` (`$FAKE_PROBE` set → exit 0) and waits
/// until it can run: another test's fork may hold the file open for writing (ETXTBSY).
pub fn exe(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!("#!/bin/sh\n[ -n \"$FAKE_PROBE\" ] && exit 0\n{body}"),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    for _ in 0..500 {
        match Command::new(path).env("FAKE_PROBE", "1").status() {
            Err(e) if e.raw_os_error() == Some(26) => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            r => {
                assert!(r.unwrap().success(), "{} runs", path.display());
                return;
            }
        }
    }
    panic!("{} stays busy", path.display());
}

/// Fakes of the programs the loop checks at start and runs itself, in `dir` (made once):
/// `claude`, `cargo`, `bwrap` answer `--version`; `systemd-inhibit` answers `--version`, else
/// logs its argv (`inhibit-<n>.argv`) and pid (`inhibit-<n>.pid`), then runs until `dir` is
/// gone. Returns `Exes` with them (the rest by name).
pub fn fake_exes(dir: &Path) -> towercab::exes::Exes {
    let fakes = [
        ("claude", "[ \"$1\" = --version ] && echo '2.1.0 (Claude Code)' && exit 0\necho \"fake claude: $*\" >&2\nexit 1\n".to_string()),
        ("cargo", "echo 'cargo 1.98.0'\n".to_string()),
        ("bwrap", "echo 'bubblewrap 0.11.0'\n".to_string()),
        ("systemd-inhibit", FAKE_INHIBIT.to_string()),
    ];
    for (name, body) in &fakes {
        let path = dir.join(name);
        if !path.exists() {
            exe(&path, body);
        }
    }
    towercab::exes::Exes {
        claude: dir.join("claude").into(),
        cargo: dir.join("cargo").into(),
        bwrap: dir.join("bwrap").into(),
        systemd_inhibit: dir.join("systemd-inhibit").into(),
        ..towercab::exes::Exes::default()
    }
}

const FAKE_INHIBIT: &str = r#"[ "$1" = --version ] && echo 'systemd 255' && exit 0
d="$(dirname "$0")"
n=$(($(cat "$d/inhibit.count" 2>/dev/null || echo 0) + 1))
printf '%s\n' "$@" > "$d/inhibit-$n.argv"
echo $$ > "$d/inhibit-$n.pid"
echo "$n" > "$d/inhibit.count"
while [ -d "$d" ]; do sleep 0.1; done
"#;

/// The built `towercab` with `HOME` = `home`, [`fake_exes`] (in `<home>/.fakebin`) first on
/// `PATH`, and none of `TOWERCAB_CONFIG`, `TOWERCAB_HOME`, `XDG_CONFIG_HOME` from the test's
/// environment.
pub fn towercab(home: &Path, args: &[&str]) -> Command {
    let fakes = home.join(".fakebin");
    fake_exes(&fakes);
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![fakes];
    paths.extend(std::env::split_paths(&path));
    let mut c = Command::new(env!("CARGO_BIN_EXE_towercab"));
    c.args(args)
        .env("HOME", home)
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env_remove("TOWERCAB_CONFIG")
        .env_remove("TOWERCAB_HOME")
        .env_remove("XDG_CONFIG_HOME")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    c
}

/// stdout, stderr and the exit code of a finished command.
pub fn output(c: &mut Command) -> (String, String, Option<i32>) {
    let out = c.output().expect("towercab runs");
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.code(),
    )
}

/// A config the loop's commands accept (`[intents]` path in `dir`: an empty git repo on
/// `main` without a remote; `[github]` app 1 as `me`), then `extra`; written to
/// `<dir>/config.toml`.
pub fn loop_config(dir: &Path, extra: &str) -> PathBuf {
    let intents = dir.join("intents");
    if !intents.exists() {
        fs::create_dir_all(&intents).unwrap();
        git(&intents, &["init", "--quiet", "-b", "main"]);
    }
    let file = dir.join("config.toml");
    fs::write(
        &file,
        format!(
            "[intents]\npath = \"{}\"\n\n[github]\napp_id = 1\nme = \"me\"\n\n{extra}",
            dir.join("intents").display()
        ),
    )
    .unwrap();
    file
}
