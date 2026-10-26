//! `towercab doctor` (LOOP-15, loop.md **Doctor**): the setup as the loop would see it. Warnings
//! only; the command fails only when the config can't load.

use crate::checkout;
use crate::config::Config;
use crate::exes::{Exes, which};
use crate::github::Identity;
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
    // The oldest gh Towercab's calls work with (LOOP-20).
    if which(&exes.gh).is_some() {
        out.push(gh_version(&exes.gh));
    }
    // Claude Code's Bash sandbox can't start where user namespaces are restricted (PIP-24).
    if userns_restricted() && !config.agent.sandbox_unix_sockets {
        out.push(SANDBOX_HINT.into());
    }
    // The App identity (LOOP-19): its key loads and GitHub knows its bot.
    let identity = Identity::from_config(config, exes);
    out.push(match identity.bot() {
        Ok(bot) => format!("github app: {} {}", bot.login, bot.id),
        Err(e) => format!("github app: {e}"),
    });
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
        // PIP-34: a release block needs `live` (its staging).
        if repo.path.exists()
            && let Ok(files) = crate::repo::load(&repo.path, &repo.base)
            && files.towercab.release.is_some()
            && files.towercab.live.is_none()
        {
            out.push(format!("{name}: release block without live: ignored"));
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

/// The `doctor` line when Claude Code's Bash sandbox can't start here.
pub const SANDBOX_HINT: &str = "sandbox: user namespaces are restricted (Ubuntu): Claude Code's Bash sandbox fails \
     (apply-seccomp setgroups); set [agent] sandbox_unix_sockets = true (README: Known issues)";

/// `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is 1.
pub fn userns_restricted() -> bool {
    std::fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        .is_ok_and(|v| v.trim() == "1")
}

/// The oldest gh every call Towercab makes works with (LOOP-20).
pub const GH_MIN: (u32, u32) = (2, 46);

/// `gh version: <x.y.z>`, with `: Towercab needs 2.46 or newer` below [`GH_MIN`]; `gh --version`
/// failing or unreadable → `gh version: unknown (<why>)`.
pub fn gh_version(gh: &std::ffi::OsStr) -> String {
    let mut cmd = std::process::Command::new(gh);
    cmd.arg("--version");
    let text = match crate::child::output(&mut cmd, std::time::Duration::from_secs(10)) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            return format!(
                "gh version: unknown (exit {})",
                o.status.code().unwrap_or(-1)
            );
        }
        Err(e) => return format!("gh version: unknown ({e})"),
    };
    let version = text
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("gh version "))
        .and_then(|l| l.split_whitespace().next());
    let Some(version) = version else {
        return "gh version: unknown (no `gh version x.y.z` line)".into();
    };
    let mut parts = version.split('.').map(|p| p.parse::<u32>().ok());
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(major), Some(minor)) if (major, minor) < GH_MIN => format!(
            "gh version: {version}: Towercab needs {}.{} or newer",
            GH_MIN.0, GH_MIN.1
        ),
        (Some(_), Some(_)) => format!("gh version: {version}"),
        _ => format!("gh version: unknown ({version})"),
    }
}
