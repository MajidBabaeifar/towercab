//! Towercab's clone and the missions' checkouts (LOOP-8).

mod common;

use std::ffi::OsStr;
use std::fs;

use common::git;
use common::world::{World, has_head, intent_file};
use towercab::checkout;
use towercab::handler::Handlers;
use towercab::machine::Stage;
use towercab::pick::Pick;

fn handlers() -> Handlers {
    let mut h = Handlers::stubs();
    h.set(Stage::Pick, Box::new(Pick));
    h
}

const ID: &str = "261001-0900";

#[test]
fn test_checkout_kept() {
    let mut w = World::new(
        &[intent_file("261001-0900-keep", "web", "", "Keep")],
        &["web"],
    );
    let mut lp = w.open(handlers());
    w.until(&mut lp, 4, |w| w.stage(ID) == Some(Stage::Design));
    let m = w.mission(ID);
    let dir = w.home.root.join(&m.checkout);
    assert_eq!(dir, w.home.work(ID, 1));
    assert!(has_head(&dir));
    // Work in the checkout survives every stage, and the loop restarting.
    fs::write(dir.join("work.txt"), "mine\n").unwrap();
    w.until(&mut lp, 6, |w| w.stage(ID) == Some(Stage::Ci));
    lp.shutdown().unwrap();
    drop(lp);
    let mut lp = w.open(handlers());
    w.until(&mut lp, 6, |w| w.stage(ID) == Some(Stage::Merge));
    assert_eq!(fs::read_to_string(dir.join("work.txt")).unwrap(), "mine\n");
    assert_eq!(
        w.mission(ID).session,
        m.session,
        "the same session throughout"
    );
    // Done: the checkout is deleted.
    w.until(&mut lp, 6, |w| w.stage(ID) == Some(Stage::Done));
    w.pass(&mut lp);
    assert!(!dir.exists());
    assert!(w.mission(ID).finished.is_some());

    // Stopped (the intent removed): deleted too.
    w.intents.push_mine(
        &[(
            "intents/261001-0901-stop/intent.md",
            Some(&common::intent_md("web", "", "Stop")),
        )],
        "add",
    );
    w.until(&mut lp, 6, |w| w.stage("261001-0901") == Some(Stage::Build));
    let stop = w.home.work("261001-0901", 1);
    assert!(has_head(&stop));
    w.intents
        .push_mine(&[("intents/261001-0901-stop/intent.md", None)], "rm");
    w.until(&mut lp, 3, |w| {
        w.stage("261001-0901") == Some(Stage::Stopped)
    });
    assert!(!stop.exists());
    lp.shutdown().unwrap();
}

#[test]
fn test_checkout_has_no_remote() {
    let mut w = World::new(
        &[intent_file("261001-0900-plain", "web", "", "Plain")],
        &["web"],
    );
    let clone = w.clone_path("web");
    let clone_head = git(&clone, &["rev-parse", "HEAD"]);
    let mut lp = w.open(handlers());
    w.until(&mut lp, 4, |w| w.stage(ID) == Some(Stage::Design));
    let m = w.mission(ID);
    let dir = w.home.root.join(&m.checkout);
    assert_eq!(git(&dir, &["remote"]), "", "no git remote");
    assert_eq!(
        git(&dir, &["symbolic-ref", "--short", "HEAD"]).trim(),
        "towercab/261001-0900-plain"
    );
    let base = git(&clone, &["rev-parse", "refs/remotes/origin/main"]);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), base);
    assert_eq!(git(&dir, &["rev-parse", "refs/remotes/origin/main"]), base);
    assert_eq!(m.base_sha.as_deref(), Some(base.trim()));
    assert_eq!(
        fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
        common::world::CLAUDE
    );
    // The clone: fetched into, its working tree and HEAD untouched.
    assert_eq!(git(&clone, &["rev-parse", "HEAD"]), clone_head);
    assert_eq!(git(&clone, &["status", "--porcelain"]), "");

    // Base moves: the clone fetches, the checkout takes it by path.
    let mine = w.mine("web");
    common::write(&mine, "NEW.md", "new\n");
    git(&mine, &["add", "-A"]);
    git(&mine, &["commit", "--quiet", "-m", "new"]);
    git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
    let git_exe = OsStr::new("git");
    let repo = w.config.repo("web").unwrap().clone();
    checkout::ensure_clone(git_exe, &repo, None).unwrap();
    checkout::refresh_base(git_exe, &clone, &dir, "main").unwrap();
    let moved = git(&clone, &["rev-parse", "refs/remotes/origin/main"]);
    assert_ne!(moved, base);
    assert_eq!(git(&dir, &["rev-parse", "refs/remotes/origin/main"]), moved);

    // What a worker writes into the checkout's `.git` never runs as Towercab: no hooks (its
    // own or a `core.hooksPath`), no fsmonitor.
    let marker = w.root.join("hook-ran");
    let hook = format!("#!/bin/sh\ntouch '{}'\n", marker.display());
    for h in [
        "hooks/reference-transaction",
        "evil/reference-transaction",
        "fsmonitor",
    ] {
        let p = dir.join(".git").join(h);
        common::exe(&p, &hook);
    }
    git(&dir, &["config", "core.hooksPath", ".git/evil"]);
    let fsmonitor = dir.join(".git/fsmonitor");
    git(
        &dir,
        &["config", "core.fsmonitor", fsmonitor.to_str().unwrap()],
    );
    common::write(&mine, "NEWER.md", "newer\n");
    git(&mine, &["add", "-A"]);
    git(&mine, &["commit", "--quiet", "-m", "newer"]);
    git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
    checkout::ensure_clone(git_exe, &repo, None).unwrap();
    checkout::refresh_base(git_exe, &clone, &dir, "main").unwrap();
    checkout::git(git_exe, &dir, &["status", "--porcelain"], None).unwrap();
    assert!(!marker.exists(), "a hook in the checkout ran");
    assert_eq!(git(&dir, &["remote"]), "");
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), base, "the branch stays");

    // A missing clone is cloned from GitHub (a fake git records the call).
    let gone = w.root.join("nowhere").join("web");
    let mut far = repo.clone();
    far.path = gone.clone();
    far.github = "me/web".into();
    let fake = w.root.join("bin").join("git");
    let log = w.root.join("git.log");
    common::exe(
        &fake,
        &format!(
            "printf '%s\\n' \"$@\" >> {}\necho offline >&2\nexit 128\n",
            log.display()
        ),
    );
    let err = checkout::ensure_clone(fake.as_os_str(), &far, None).unwrap_err();
    assert!(err.ends_with("offline"), "{err}");
    let args = fs::read_to_string(&log).unwrap();
    let want = format!(
        "clone\n--quiet\n--\nhttps://github.com/me/web.git\n{}\n",
        gone.display()
    );
    assert!(args.ends_with(&want), "{args}");
    lp.shutdown().unwrap();
}

#[test]
fn test_checkout_recloned() {
    let mut w = World::new(
        &[intent_file("261001-0900-broken", "web", "", "Broken")],
        &["web"],
    );
    let git_exe = OsStr::new("git");
    let clone = w.clone_path("web");
    // `ensure`: a valid checkout is kept; one without a valid HEAD is made again.
    let dir = w.root.join("scratch").join("c");
    assert!(!checkout::valid(git_exe, &dir));
    assert!(checkout::ensure(git_exe, &clone, &dir, "main", "towercab/x").unwrap());
    fs::write(dir.join("kept.txt"), "x").unwrap();
    assert!(!checkout::ensure(git_exe, &clone, &dir, "main", "towercab/x").unwrap());
    assert!(dir.join("kept.txt").exists());
    fs::remove_file(dir.join(".git").join("HEAD")).unwrap();
    assert!(!checkout::valid(git_exe, &dir));
    assert!(checkout::ensure(git_exe, &clone, &dir, "main", "towercab/x").unwrap());
    assert!(has_head(&dir));
    assert!(!dir.join("kept.txt").exists());

    // A crash mid-create leaves `<checkout>.tmp`, never a half-made checkout: removed next time.
    let fresh = w.root.join("scratch").join("d");
    let tmp = w.root.join("scratch").join("d.tmp");
    fs::create_dir_all(tmp.join(".git")).unwrap();
    fs::write(tmp.join("junk"), "half a clone").unwrap();
    assert!(checkout::ensure(git_exe, &clone, &fresh, "main", "towercab/y").unwrap());
    assert!(has_head(&fresh) && !tmp.exists());
    assert_eq!(
        git(&fresh, &["symbolic-ref", "--short", "HEAD"]).trim(),
        "towercab/y"
    );

    // The pick step re-entered over a broken checkout (a crash mid-clone) makes it again.
    let mut lp = w.open(handlers());
    w.pass(&mut lp);
    assert_eq!(w.stage(ID), Some(Stage::Pick));
    let work = w.home.work(ID, 1);
    fs::create_dir_all(work.join(".git")).unwrap();
    fs::write(work.join("junk"), "half a clone").unwrap();
    w.db()
        .conn()
        .execute("UPDATE missions SET step = 'checkout'", [])
        .unwrap();
    w.until(&mut lp, 3, |w| w.stage(ID) == Some(Stage::Design));
    assert!(has_head(&work));
    assert!(!work.join("junk").exists());
    assert_eq!(git(&work, &["remote"]), "");
    lp.shutdown().unwrap();
}

#[test]
fn test_planted_git_config_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("co");
    fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "--quiet"]);
    common::write(&dir, "a.txt", "one\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "--quiet", "-m", "one"]);
    common::write(&dir, "a.txt", "two\n");
    git(&dir, &["commit", "--quiet", "-am", "two"]);
    let exe = OsStr::new("git");
    checkout::sane(exe, &dir).unwrap();
    // What a run could plant in `.git` (no sandbox lets it: `.git` is read-only there): a clean
    // filter `git add -A` would run, a `diff.external` the review's diff would.
    let ran = tmp.path().join("ran");
    let script = tmp.path().join("evil.sh");
    common::exe(
        &script,
        &format!("#!/bin/sh\necho \"$0 $*\" >> '{}'\ncat\n", ran.display()),
    );
    common::write(&dir, ".gitattributes", "* filter=x\n");
    git(
        &dir,
        &["config", "filter.x.clean", script.to_str().unwrap()],
    );
    git(&dir, &["config", "diff.external", script.to_str().unwrap()]);
    common::write(&dir, "a.txt", "three\n");
    let err = checkout::sane(exe, &dir).unwrap_err();
    assert!(
        err.contains("filter.x.clean") && err.contains("diff.external"),
        "{err}"
    );
    assert!(checkout::git_sane(exe, &dir, &["add", "-A"], None).is_err());
    let diff = towercab::pipeline::git::patch_id(exe, &dir, "HEAD~1", "HEAD");
    assert!(diff.is_err(), "{diff:?}");
    assert!(!ran.exists(), "planted config ran");
    // `--no-ext-diff --no-textconv` alone keeps `diff.external` out too.
    let out = checkout::git(
        exe,
        &dir,
        &["diff", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD"],
        None,
    )
    .unwrap();
    assert!(out.contains("+two"), "{out}");
    assert!(!ran.exists());
    // Only what clone, `remote remove` and `checkout -B` write passes.
    for k in [
        "core.repositoryformatversion",
        "core.logallrefupdates",
        "remote.origin.url",
        "remote.origin.fetch",
        "branch.main.merge",
    ] {
        assert!(checkout::allowed_key(k), "{k}");
    }
    for k in [
        "core.worktree",
        "core.sshcommand",
        "include.path",
        "includeif.gitdir:/x.path",
        "merge.x.driver",
        "remote.origin.uploadpack",
        "diff.x.textconv",
    ] {
        assert!(!checkout::allowed_key(k), "{k}");
    }
    // A `.git` file (gitdir elsewhere) is refused.
    let linked = tmp.path().join("linked");
    fs::create_dir_all(&linked).unwrap();
    fs::write(
        linked.join(".git"),
        format!("gitdir: {}\n", dir.join(".git").display()),
    )
    .unwrap();
    assert!(
        checkout::sane(exe, &linked)
            .unwrap_err()
            .contains("not a directory")
    );
}
