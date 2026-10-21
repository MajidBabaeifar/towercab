//! `repo::load`: the repo files from `origin/<base>` of a local clone (REPO-1).

mod common;

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use common::{git, write};
use tempfile::TempDir;
use towercab::repo::{RepoError, load};

const CLAUDE: &str = "# Repo\n\n## Verifying your work\n\n```checks\nmake test\n```\n";
const REVIEW: &str = "## Red lines\n\n- auth\n";
const TOWERCAB: &str = "---\nmax_autonomy: 3\n---\n";

/// A bare `origin`, my clone of it (`me`) and Towercab's (`clone`).
struct Repo {
    _tmp: TempDir,
    me: PathBuf,
    clone: PathBuf,
}

impl Repo {
    fn new() -> Repo {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "--quiet", "--bare", "-b", "main"]);
        let me = tmp.path().join("me");
        git(
            tmp.path(),
            &["clone", "--quiet", origin.to_str().unwrap(), "me"],
        );
        git(&me, &["checkout", "--quiet", "-B", "main"]);
        write(&me, "CLAUDE.md", CLAUDE);
        write(&me, "REVIEW.md", REVIEW);
        write(&me, "TOWERCAB.md", TOWERCAB);
        git(&me, &["add", "-A"]);
        git(&me, &["commit", "--quiet", "-m", "seed"]);
        git(&me, &["push", "--quiet", "origin", "HEAD:main"]);
        git(
            tmp.path(),
            &["clone", "--quiet", origin.to_str().unwrap(), "clone"],
        );
        let clone = tmp.path().join("clone");
        Repo {
            _tmp: tmp,
            me,
            clone,
        }
    }

    /// I commit everything in my clone and push it to `branch`.
    fn push(&self, branch: &str, msg: &str) {
        git(&self.me, &["add", "-A"]);
        git(&self.me, &["commit", "--quiet", "-m", msg]);
        git(
            &self.me,
            &["push", "--quiet", "origin", &format!("HEAD:{branch}")],
        );
    }

    fn fetch(&self) {
        git(&self.clone, &["fetch", "--quiet", "origin"]);
    }

    fn me(&self, rel: &str) -> PathBuf {
        self.me.join(rel)
    }
}

fn checks(clone: &Path, base: &str) -> Vec<String> {
    load(clone, base).unwrap().verifying.checks
}

fn invalid(clone: &Path) -> String {
    match load(clone, "main") {
        Err(RepoError::Invalid(e)) => e,
        other => panic!("want Invalid, got {other:?}"),
    }
}

#[test]
fn test_read_from_base() {
    let r = Repo::new();
    let files = load(&r.clone, "main").unwrap();
    assert_eq!(files.claude_md, CLAUDE);
    assert_eq!(files.verifying.checks, ["make test"]);
    assert_eq!(files.review.red_lines, ["auth"]);
    assert_eq!(files.towercab.max_autonomy, 3);

    // Never the working tree, the index or a local (PR) branch.
    write(&r.clone, "CLAUDE.md", "nothing here\n");
    git(&r.clone, &["checkout", "--quiet", "-b", "towercab/1-x"]);
    write(
        &r.clone,
        "TOWERCAB.md",
        "---\nmax_autonomy: 5\nprotected: [x]\n---\n",
    );
    git(&r.clone, &["add", "TOWERCAB.md"]);
    git(
        &r.clone,
        &[
            "-c",
            "user.name=w",
            "-c",
            "user.email=w@x",
            "commit",
            "--quiet",
            "-m",
            "pr",
        ],
    );
    let files = load(&r.clone, "main").unwrap();
    assert_eq!(files.verifying.checks, ["make test"]);
    assert_eq!(files.towercab.max_autonomy, 3, "the PR can't raise its cap");

    // origin/<base> as it is: no fetch here; after the caller fetches, the new base.
    fs::write(r.me("CLAUDE.md"), CLAUDE.replace("make test", "make check")).unwrap();
    r.push("main", "new checks");
    assert_eq!(checks(&r.clone, "main"), ["make test"]);
    r.fetch();
    assert_eq!(checks(&r.clone, "main"), ["make check"]);
    // A pushed PR branch doesn't count either; another base does when asked for.
    fs::write(r.me("CLAUDE.md"), CLAUDE.replace("make test", "make pr")).unwrap();
    r.push("release/2.x", "release base");
    r.fetch();
    assert_eq!(checks(&r.clone, "main"), ["make check"]);
    assert_eq!(checks(&r.clone, "release/2.x"), ["make pr"]);

    // No origin/<base>, or not a clone → Git, naming the clone.
    let shown = r.clone.display().to_string();
    match load(&r.clone, "nope") {
        Err(RepoError::Git(e)) => {
            assert!(e.starts_with(&format!("{shown}: ")), "{e}");
            assert!(e.len() > shown.len() + 2, "with git's stderr: {e}");
        }
        other => panic!("want Git, got {other:?}"),
    }
    let empty = r._tmp.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    assert!(
        matches!(load(&empty, "main"), Err(RepoError::Git(e)) if e.starts_with(&format!("{}: ", empty.display())))
    );

    // Absent files: REVIEW.md and TOWERCAB.md default, CLAUDE.md is REPO-5.
    git(&r.me, &["fetch", "--quiet", "origin"]);
    git(&r.me, &["reset", "--quiet", "--hard", "origin/main"]);
    git(&r.me, &["rm", "--quiet", "REVIEW.md", "TOWERCAB.md"]);
    r.push("main", "drop optional files");
    r.fetch();
    let files = load(&r.clone, "main").unwrap();
    assert!(files.review.red_lines.is_empty() && files.towercab.max_autonomy == 5);
    // An executable file is a regular file.
    fs::set_permissions(r.me("CLAUDE.md"), fs::Permissions::from_mode(0o755)).unwrap();
    r.push("main", "exec bit");
    r.fetch();
    assert_eq!(checks(&r.clone, "main"), ["make check"]);

    // A symlink, directory or submodule in a file's place, or non-UTF-8 bytes → Invalid.
    fs::write(r.me("AGENTS.md"), CLAUDE).unwrap();
    git(&r.me, &["rm", "--quiet", "CLAUDE.md"]);
    symlink("AGENTS.md", r.me("CLAUDE.md")).unwrap();
    r.push("main", "symlinked CLAUDE.md");
    r.fetch();
    assert_eq!(invalid(&r.clone), "CLAUDE.md: a symlink, not a file");

    git(&r.me, &["rm", "--quiet", "CLAUDE.md"]);
    fs::write(r.me("CLAUDE.md"), CLAUDE).unwrap();
    write(&r.me, "REVIEW.md/x.md", "dir\n");
    r.push("main", "REVIEW.md is a directory");
    r.fetch();
    assert_eq!(invalid(&r.clone), "REVIEW.md: a directory, not a file");

    git(&r.me, &["rm", "--quiet", "-r", "REVIEW.md"]);
    let head = git(&r.me, &["rev-parse", "HEAD"]).trim().to_string();
    git(
        &r.me,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{head},TOWERCAB.md"),
        ],
    );
    git(&r.me, &["commit", "--quiet", "-m", "submodule"]);
    git(&r.me, &["push", "--quiet", "origin", "HEAD:main"]);
    r.fetch();
    assert_eq!(invalid(&r.clone), "TOWERCAB.md: a submodule, not a file");

    git(&r.me, &["rm", "--quiet", "--cached", "TOWERCAB.md"]);
    fs::write(r.me("REVIEW.md"), b"## Red lines\n\n- caf\xe9\n").unwrap();
    r.push("main", "latin-1");
    r.fetch();
    assert_eq!(invalid(&r.clone), "REVIEW.md: not UTF-8");

    // The first error in file order wins: no CLAUDE.md before a bad REVIEW.md.
    git(&r.me, &["rm", "--quiet", "CLAUDE.md"]);
    r.push("main", "no CLAUDE.md");
    r.fetch();
    assert_eq!(load(&r.clone, "main"), Err(RepoError::NoVerifyingBlock));
}
