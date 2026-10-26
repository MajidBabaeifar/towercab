//! `towercab doctor` (LOOP-15, loop.md **Doctor**): programs, the App, rulesets, origins,
//! Telegram; warnings only, exit 1 only when the config can't load.

mod common;

use std::path::Path;

use common::app::{FakeGithub, key};
use common::{exe, git, loop_config, output, towercab};

/// A git repo at `dir` whose `origin` is `url`.
fn clone_with_origin(dir: &Path, url: &str) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "--quiet", "-b", "main"]);
    git(dir, &["remote", "add", "origin", url]);
}

const GH: &str = r#"if [ "$1" = --version ]; then
  v=2.40.1; [ -f "${0%/*}/gh-version" ] && read -r v < "${0%/*}/gh-version"
  echo "gh version $v (2023-12-13)"; exit 0
fi
case "$2" in
  repos/me/web/rulesets*) echo '[{"name":"other","id":1}]' ;;
  repos/me/ok/rulesets*) echo '[{"name":"towercab","id":5}]' ;;
  *) echo 'HTTP 404: Not Found' >&2; exit 1 ;;
esac
"#;

#[test]
fn test_doctor() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    std::fs::create_dir_all(&user).unwrap();
    let web = tmp.path().join("clones/web");
    let ok = tmp.path().join("clones/ok");
    clone_with_origin(&web, "/srv/web.git");
    clone_with_origin(&ok, "https://github.com/me/ok.git");
    let file = loop_config(
        tmp.path(),
        &format!(
            "[repos.web]\ngithub = \"me/web\"\npath = \"{}\"\n\n\
             [repos.ok]\ngithub = \"me/ok\"\npath = \"{}\"\n\n\
             [repos.api]\ngithub = \"me/api\"\npath = \"{}\"\n\n\
             [telegram]\nbot_token = \"1:x\"\nchat_id = 42\n",
            web.display(),
            ok.display(),
            tmp.path().join("clones/api").display(),
        ),
    );
    let home = tmp.path().join("home");
    let doctor = |file: &Path| {
        let mut c = towercab(
            &user,
            &[
                "--config",
                file.to_str().unwrap(),
                "--home",
                home.to_str().unwrap(),
                "doctor",
            ],
        );
        // Only the fakes (and git) on PATH: systemctl is missing.
        let bin = user.join(".fakebin");
        exe(&bin.join("gh"), GH);
        if !bin.join("git").exists() {
            let real = std::process::Command::new("sh")
                .args(["-c", "command -v git"])
                .output()
                .unwrap();
            let real = String::from_utf8(real.stdout).unwrap();
            std::os::unix::fs::symlink(real.trim(), bin.join("git")).unwrap();
        }
        c.env("PATH", &bin);
        output(&mut c)
    };
    let bin = user.join(".fakebin");
    let b = |n: &str| bin.join(n).display().to_string();
    let (out, err, code) = doctor(&file);
    assert_eq!(code, Some(0), "{err}");
    assert_eq!(
        out,
        format!(
            "config: {}\nhome: {}\ngit: {}\ngh: {}\nclaude: {}\ncargo: {}\nbwrap: {}\n\
             systemd-inhibit: {}\nsystemctl: missing\n\
             gh version: 2.40.1: Towercab needs 2.46 or newer\n\
             {}github app: {}/app.pem: No such file or directory (os error 2)\n\
             api: ruleset: gh api repos/me/api/rulesets?includes_parents=false&per_page=100: \
             HTTP 404: Not Found\n\
             web: no towercab ruleset: towercab protect web\n\
             web: origin isn't https://github.com/…: the App token isn't used\n\
             telegram: chat 42\n",
            file.display(),
            home.display(),
            b("git"),
            b("gh"),
            b("claude"),
            b("cargo"),
            b("bwrap"),
            b("systemd-inhibit"),
            // The host's own user-namespace setting (PIP-24): the hint only where it bites.
            if towercab::doctor::userns_restricted() {
                format!("{}\n", towercab::doctor::SANDBOX_HINT)
            } else {
                String::new()
            },
            tmp.path().display(),
        )
    );

    // No [telegram], no [repos]: said so; nothing to check. The App's key loads and GitHub
    // knows its bot (LOOP-19).
    let gh = FakeGithub::start(&[]);
    let plain_dir = tmp.path().join("plain");
    let plain = loop_config(&plain_dir, "");
    let text = std::fs::read_to_string(&plain).unwrap().replace(
        "[github]\n",
        &format!("[github]\napi_base = \"{}\"\n", gh.http.url),
    );
    std::fs::write(&plain, text).unwrap();
    key(&plain_dir.join("app.pem"), false);
    std::fs::write(user.join(".fakebin/gh-version"), "2.46.0").unwrap();
    let (out, _, code) = doctor(&plain);
    assert_eq!(code, Some(0));
    assert!(
        out.replace(&format!("{}\n", towercab::doctor::SANDBOX_HINT), "")
            .ends_with(
                "gh version: 2.46.0\ngithub app: towercab[bot] 42\ntelegram: not configured\n"
            ),
        "{out}"
    );

    // A config the loop can't run with: the error, exit 1.
    std::fs::write(&plain, "[intents]\npath = \"/x\"\n\n[github]\napp_id = 1\n").unwrap();
    assert_eq!(
        doctor(&plain),
        (
            format!("config: {}: github.me is required\n", plain.display()),
            String::new(),
            Some(1)
        )
    );
    std::fs::write(&plain, "[agent]\nparallel = 99\n").unwrap();
    let (out, _, code) = doctor(&plain);
    assert_eq!(code, Some(1));
    assert!(
        out.starts_with(&format!("config: {}: ", plain.display())),
        "{out}"
    );
}
