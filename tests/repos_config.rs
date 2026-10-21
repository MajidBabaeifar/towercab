//! `[repos.<name>]` config (LOOP-1's slice for REPO-1, REPO-7). The only test in this binary:
//! it sets `HOME`.

use std::fs;
use std::path::{Path, PathBuf};

use towercab::config::{Config, RepoConfig};

fn load(file: &Path, text: &str) -> Result<Config, String> {
    fs::write(file, text).unwrap();
    Config::load(Some(file))
}

#[test]
fn test_repos_config() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    // SAFETY: no other test runs in this binary, so nothing reads the environment concurrently.
    unsafe { std::env::set_var("HOME", &home) };
    let file = tmp.path().join("config.toml");
    let intents = "[intents]\nremote = \"r\"\n";

    // Every key, plus keys the Python version still reads (ignored).
    let c = load(
        &file,
        &format!(
            "{intents}[repos.towercab]\ngithub = \"Me/towercab\"\npath = \"~/src/towercab\"\n\
             base = \"release/1.x\"\nworkers = 3\nbash = [\"cargo test*\", \"ls*\"]\n\
             verify = [\"python3\"]\n\n[repos.web]\ngithub = \"me/web.site\"\npath = \"/srv/web\"\n"
        ),
    )
    .unwrap();
    assert_eq!(
        c.repos.keys().collect::<Vec<_>>(),
        ["towercab", "web"],
        "by name"
    );
    assert_eq!(
        c.repo("towercab").unwrap(),
        &RepoConfig {
            name: "towercab".into(),
            github: "Me/towercab".into(),
            path: home.join("src/towercab"),
            base: "release/1.x".into(),
            workers: 3,
            bash: vec!["cargo test*".into(), "ls*".into()],
        }
    );
    // Defaults: base main, workers 1, bash [].
    assert_eq!(
        c.repo("web").unwrap(),
        &RepoConfig {
            name: "web".into(),
            github: "me/web.site".into(),
            path: PathBuf::from("/srv/web"),
            base: "main".into(),
            workers: 1,
            bash: vec![],
        }
    );
    // No [repos] at all is fine.
    assert!(load(&file, intents).unwrap().repos.is_empty());
    assert_eq!(c.repo("nope"), Err("unknown repo nope".into()));

    // A bad table fails only that repo, when it is used: the Python version's `[repos.<name>]`
    // (no `github`) loads, and the other repos stay usable.
    let shown = file.display().to_string();
    let c = load(
        &file,
        &format!(
            "{intents}[repos.towercab]\npath = \"~/src/towercab\"\nbase = \"main\"\n\
             verify = [\"python3 -m unittest\"]\nbash = [\"python3 *\"]\n\n\
             [repos.web]\ngithub = \"me/web\"\npath = \"/srv/web\"\n"
        ),
    )
    .unwrap();
    assert_eq!(
        c.repo("towercab"),
        Err(format!(
            "config: {shown}: repos.towercab.github is required"
        ))
    );
    assert_eq!(c.repo("web").unwrap().github, "me/web");

    let err = |repo: &str| {
        let c = load(&file, &format!("{intents}{repo}")).expect("a bad repo still loads");
        let name = c.repos.keys().next().expect("one repo").clone();
        c.repo(&name)
            .unwrap_err()
            .strip_prefix(&format!("config: {shown}: "))
            .unwrap_or_else(|| panic!("{repo}: error names the file"))
            .to_string()
    };
    assert_eq!(
        load(&file, &format!("repos = 3\n{intents}")).unwrap_err(),
        format!("config: {shown}: repos must be a table")
    );
    let ok = "github = \"me/x\"\npath = \"/x\"\n";
    for (repo, want) in [
        ("[repos]\nx = 1\n", "repos.x must be a table"),
        ("[repos.x]\npath = \"/x\"\n", "repos.x.github is required"),
        (
            "[repos.x]\ngithub = \"x\"\npath = \"/x\"\n",
            "repos.x.github must be \"<owner>/<name>\"",
        ),
        (
            "[repos.x]\ngithub = \"me/x/y\"\npath = \"/x\"\n",
            "repos.x.github must be \"<owner>/<name>\"",
        ),
        (
            "[repos.x]\ngithub = \"-me/x\"\npath = \"/x\"\n",
            "repos.x.github must be \"<owner>/<name>\"",
        ),
        (
            "[repos.x]\ngithub = 5\npath = \"/x\"\n",
            "repos.x.github must be a string",
        ),
        ("[repos.x]\ngithub = \"me/x\"\n", "repos.x.path is required"),
        (
            "[repos.x]\ngithub = \"me/x\"\npath = [\"/x\"]\n",
            "repos.x.path must be a string",
        ),
        (
            "[repos.intents]\ngithub = \"me/intents\"\npath = \"/x\"\n",
            "repos.intents is reserved: `protect intents` is the intent home",
        ),
        (
            "[repos.\"a b\"]\ngithub = \"me/x\"\npath = \"/x\"\n",
            "repos.\"a b\" is not a repo name ([A-Za-z0-9._-], no leading -)",
        ),
        (
            "[repos.x]\ngithub = \"me/x\"\npath = \"src/x\"\n",
            "repos.x.path must be absolute or start with ~/",
        ),
        (
            "[repos.x]\ngithub = \"me/x\"\npath = \"~x/src\"\n",
            "repos.x.path must be absolute or start with ~/",
        ),
    ] {
        assert_eq!(err(repo), want, "{repo}");
    }
    for base in [
        "", "-x", "/main", "main/", "a..b", "a//b", "a b", "main~1", "a:b", "x\\y", "HEAD",
        "foo.lock", "a/b.lock", ".x", "a/.b", "main.",
    ] {
        assert_eq!(
            err(&format!("[repos.x]\n{ok}base = {base:?}\n")),
            "repos.x.base must be a branch name ([A-Za-z0-9._/-])",
            "{base:?}"
        );
    }
    for workers in ["0", "256", "\"2\"", "1.5", "-1"] {
        assert_eq!(
            err(&format!("[repos.x]\n{ok}workers = {workers}\n")),
            "repos.x.workers must be an integer 1-255",
            "{workers}"
        );
    }
    assert_eq!(
        load(&file, &format!("{intents}[repos.x]\n{ok}workers = 255\n"))
            .unwrap()
            .repo("x")
            .unwrap()
            .workers,
        255
    );
    for base in ["release/1.x", "v1.2", "a.b/c_d-e", "HEADS", "x/HEAD"] {
        let c = load(&file, &format!("{intents}[repos.x]\n{ok}base = {base:?}\n")).unwrap();
        assert_eq!(c.repo("x").unwrap().base, base);
    }
    for bash in ["\"ls*\"", "[\"\"]", "[\" \"]", "[1]", "[[\"a\"]]"] {
        assert_eq!(
            err(&format!("[repos.x]\n{ok}bash = {bash}\n")),
            "repos.x.bash must be a list of non-empty strings",
            "{bash}"
        );
    }
}
