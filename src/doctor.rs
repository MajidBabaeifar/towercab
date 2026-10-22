//! `towercab doctor` (LOOP-15, loop.md **Doctor**): the setup as the loop would see it. Warnings
//! only; the command fails only when the config can't load.

use crate::checkout;
use crate::config::Config;
use crate::exes::{Exes, which};
use crate::home::Home;
use crate::repo::protect::find_ruleset;

/// The report, one line each: config, home, each program (path or `missing`), the GitHub
/// App, per `[repos]` repo a missing `towercab` ruleset (my `gh`, REPO-7) or a clone whose
/// `origin` isn't on `https://github.com/`, Telegram.
pub fn doctor(config: &Config, home: &Home, exes: &Exes) -> String {
    let mut out = vec![
        format!("config: {}", config.file.display()),
        format!("home: {}", home.root.display()),
    ];
    for (name, exe) in [
        ("git", &exes.git),
        ("gh", &exes.gh),
        ("claude", &exes.claude),
        ("cargo", &exes.cargo),
        ("bwrap", &exes.bwrap),
        ("systemd-inhibit", &exes.systemd_inhibit),
        ("systemctl", &exes.systemctl),
    ] {
        let at = which(exe).map_or_else(|| "missing".to_string(), |p| p.display().to_string());
        out.push(format!("{name}: {at}"));
    }
    // The App identity (towercab[bot] <id>) comes with loop-runner part 5 (LOOP-19).
    out.push("github app: not built yet: LOOP-19".into());
    for (name, repo) in config
        .repos
        .iter()
        .filter_map(|(n, r)| Some((n, r.as_ref().ok()?)))
    {
        match find_ruleset(&exes.gh, &repo.github) {
            Ok(Some(_)) => {}
            Ok(None) => out.push(format!(
                "{name}: no towercab ruleset: towercab protect {name}"
            )),
            Err(e) => out.push(format!("{name}: ruleset: {e}")),
        }
        if repo.path.exists()
            && let Ok(url) = checkout::git(
                &exes.git,
                &repo.path,
                &["remote", "get-url", "origin"],
                None,
            )
            && !url.trim().starts_with("https://github.com/")
        {
            out.push(format!(
                "{name}: origin isn't https://github.com/…: the App token isn't used"
            ));
        }
    }
    out.push(match &config.telegram {
        Some(t) => format!("telegram: chat {}", t.chat_id),
        None => "telegram: not configured".into(),
    });
    out.join("\n")
}
