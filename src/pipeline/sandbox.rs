//! The sandbox of the repo's commands (PIP-23, pipeline.md **Sandbox**): ` ```setup `,
//! ` ```checks ` (and the proof's), e2e and the verifier's app under `bwrap`: own pid, IPC and
//! UTS namespaces and session, `/` read-only, `HOME`, `/tmp` and `/run` empty tmpfs (no D-Bus,
//! ssh-agent or gpg-agent socket), the toolchain directories read-only (credential files in
//! them masked), the repo's cache, only the checkout writable and its `.git` read-only, no
//! network for checks. Release, rollback and rehearse commands (mine, on merged code) run
//! unsandboxed ([`repo_command`]).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::claude;
use crate::config::Config;
use crate::exes::Exes;
use crate::handler::{ChildKind, ChildSpec, Ctx, StepError};
use crate::mission::Mission;

/// Files masked (`--ro-bind /dev/null <dir>/<name>`) in each toolchain directory that has
/// them: registry tokens and logins (`~/.cargo/credentials.toml` …).
pub const MASKED: [&str; 9] = [
    "credentials",
    "credentials.toml",
    ".credentials.json",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "auth.json",
    "hosts.yml",
];

/// The repo's cache as a sandboxed command sees it (`<home>/cache/<repo>`, [`cache_dir`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cache<'a> {
    /// Not mounted (e2e: with secrets, it never runs what a PR's setup left).
    None,
    /// Read-only (checks, proof, the verifier's app): `CARGO_HOME=<cache>/cargo`.
    Read(&'a Path),
    /// Writable (setup): `CARGO_HOME`, `XDG_CACHE_HOME`, `npm_config_cache` in it.
    Write(&'a Path),
}

/// `<home>/cache/<repo>` (created): what setup downloads for the repo's sandboxed commands.
/// Never `~/.cargo/registry` or another cache of mine: a PR's setup writes it.
pub fn cache_dir(cx: &Ctx<'_>, m: &Mission) -> Result<PathBuf, StepError> {
    let dir = cx.home.root.join("cache").join(&m.repo);
    std::fs::create_dir_all(&dir).map_err(|e| StepError::Bug(format!("{}: {e}", dir.display())))?;
    Ok(dir)
}

/// Where `/etc/resolv.conf` points when that is under `/run` (systemd-resolved): bound back
/// read-only over the `/run` tmpfs so a sandbox with network resolves names.
fn resolv_conf() -> Option<PathBuf> {
    std::fs::canonicalize("/etc/resolv.conf")
        .ok()
        .filter(|p| p.starts_with("/run"))
}

/// `bwrap [--unshare-net] --unshare-pid --unshare-ipc --unshare-uts --new-session
/// --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /run [--ro-bind-try
/// <resolv.conf> <same>] --tmpfs <home> --tmpfs /tmp {--ro-bind <d> <d> per existing toolchain
/// dir, then --ro-bind /dev/null <d>/<f> per MASKED file in it} [--ro-bind|--bind <cache>
/// <cache>] --bind <dir> <dir> --ro-bind-try <dir>/.git <dir>/.git --chdir <dir> -- sh -c
/// <line>` (`--unshare-net` unless `net`; resolv.conf only with `net`). `--dev /dev`: the
/// read-only bind of `/` mounts `nodev`, and a toolchain that opens `/dev/null` (cargo) would
/// fail. `.git` read-only: nothing a command writes there (config, attributes, hooks) reaches
/// Towercab's git (LOOP-8).
pub fn checks_argv(
    exes: &Exes,
    config: &Config,
    home: &Path,
    dir: &Path,
    line: &str,
    net: bool,
    cache: Cache<'_>,
) -> Vec<OsString> {
    let mut a: Vec<OsString> = vec![exes.bwrap.clone()];
    if !net {
        a.push("--unshare-net".into());
    }
    a.extend(
        [
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--new-session",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/run",
        ]
        .map(OsString::from),
    );
    if net && let Some(r) = resolv_conf() {
        a.extend(["--ro-bind-try".into(), r.clone().into(), r.into()]);
    }
    a.extend([
        "--tmpfs".into(),
        home.into(),
        "--tmpfs".into(),
        "/tmp".into(),
    ]);
    for d in config.agent.toolchain.iter().filter(|d| d.exists()) {
        a.extend(["--ro-bind".into(), d.into(), d.into()]);
        for f in MASKED.iter().map(|f| d.join(f)).filter(|f| f.exists()) {
            a.extend(["--ro-bind".into(), "/dev/null".into(), f.into()]);
        }
    }
    match cache {
        Cache::None => {}
        Cache::Read(c) => a.extend(["--ro-bind".into(), c.into(), c.into()]),
        Cache::Write(c) => a.extend(["--bind".into(), c.into(), c.into()]),
    }
    let git = dir.join(".git");
    a.extend(["--bind".into(), dir.into(), dir.into()]);
    a.extend(["--ro-bind-try".into(), git.clone().into(), git.into()]);
    a.extend(["--chdir".into(), dir.into()]);
    a.extend(["--".into(), "sh".into(), "-c".into(), line.into()]);
    a
}

/// The loop's `LANG`, else `C.UTF-8`.
fn lang() -> OsString {
    std::env::var_os("LANG")
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "C.UTF-8".into())
}

/// A sandboxed command's whole environment: `HOME`, `PATH` = `[agent].path`, `LANG`,
/// `TMPDIR=/tmp`, `XDG_CACHE_HOME=/tmp/cache`; with the cache `CARGO_HOME=<cache>/cargo`, and
/// writable also `XDG_CACHE_HOME=<cache>/xdg`, `npm_config_cache=<cache>/npm`.
pub fn env(config: &Config, home: &Path, cache: Cache<'_>) -> Vec<(OsString, OsString)> {
    let mut v: Vec<(OsString, OsString)> = vec![
        ("HOME".into(), home.into()),
        ("PATH".into(), config.agent.path.clone().into()),
        ("LANG".into(), lang()),
        ("TMPDIR".into(), "/tmp".into()),
    ];
    match cache {
        Cache::None => v.push(("XDG_CACHE_HOME".into(), "/tmp/cache".into())),
        Cache::Read(c) => {
            v.push(("XDG_CACHE_HOME".into(), "/tmp/cache".into()));
            v.push(("CARGO_HOME".into(), c.join("cargo").into()));
        }
        Cache::Write(c) => {
            v.push(("XDG_CACHE_HOME".into(), c.join("xdg").into()));
            v.push(("CARGO_HOME".into(), c.join("cargo").into()));
            v.push(("npm_config_cache".into(), c.join("npm").into()));
        }
    }
    // `[agent].env`: the machine's own settings (a zig `cc`'s CRATE_CC_NO_DEFAULTS).
    for (k, val) in &config.agent.env {
        v.push((k.into(), val.into()));
    }
    v
}

/// The `.err` file next to a log: `<stem>.err`.
pub fn err_of(log: &Path) -> std::path::PathBuf {
    log.with_extension("err")
}

/// `line` sandboxed in `dir` as a child of `kind`: setup with network and the repo's cache
/// writable; checks and proof without network, the cache read-only; e2e with network and no
/// cache. Stdout `log`, stderr [`err_of`], `check_timeout`, no slot. No `HOME` → a bug (no
/// run, PIP-24).
pub fn command(
    cx: &Ctx<'_>,
    m: &Mission,
    kind: ChildKind,
    dir: &Path,
    line: &str,
    log: &Path,
) -> Result<ChildSpec, StepError> {
    let home = claude::home().map_err(StepError::Bug)?;
    let cache_dir = cache_dir(cx, m)?;
    let (net, cache) = match kind {
        ChildKind::Checks => (false, Cache::Read(&cache_dir)),
        ChildKind::Setup => (true, Cache::Write(&cache_dir)),
        _ => (true, Cache::None),
    };
    Ok(ChildSpec {
        kind,
        argv: checks_argv(cx.exes, cx.config, &home, dir, line, net, cache),
        cwd: dir.to_path_buf(),
        env: env(cx.config, &home, cache),
        stdin: None,
        stdout: log.to_path_buf(),
        stderr: err_of(log),
        timeout: Some(cx.config.agent.check_timeout),
        slot: false,
        model: None,
    })
}

/// An e2e run's bound (PIP-9): hitting it is red.
pub const E2E_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// The e2e `line` (PIP-9) sandboxed with network in `dir` ([`command`], `ChildKind::E2e`,
/// [`E2E_TIMEOUT`]), its env plus `secrets` (the repo's secrets file as read at the spawn);
/// stdout `out`, stderr `err`: raw until `e2e::settle` redacts them.
pub fn e2e(
    cx: &Ctx<'_>,
    m: &Mission,
    dir: &Path,
    line: &str,
    out: &Path,
    err: &Path,
    secrets: Vec<(String, String)>,
) -> Result<ChildSpec, StepError> {
    let mut spec = command(cx, m, ChildKind::E2e, dir, line, out)?;
    spec.stderr = err.to_path_buf();
    spec.timeout = Some(E2E_TIMEOUT);
    spec.env
        .extend(secrets.into_iter().map(|(k, v)| (k.into(), v.into())));
    Ok(spec)
}

/// A ` ```setup ` line in `dir`: [`command`] as `ChildKind::Setup` (network, the repo's cache
/// writable, the rest as checks).
pub fn setup_spec(
    cx: &Ctx<'_>,
    m: &Mission,
    dir: &Path,
    line: &str,
    log: &Path,
) -> Result<ChildSpec, StepError> {
    command(cx, m, ChildKind::Setup, dir, line, log)
}

/// A `TOWERCAB.md` command (release, rollback, rehearse; base branch's text, mine) unsandboxed
/// in `dir`, a clean checkout of merged code (`e2e::at_sha`, the rehearsal's revert), never a
/// PR head: `sh -c <line>`, env `HOME`, `PATH`, `LANG`, plus `GH_TOKEN` = the App's token for
/// the repo when Towercab is the App (`ChildKind::Command`); stdout `log`, stderr [`err_of`],
/// `check_timeout`.
pub fn repo_command(
    cx: &Ctx<'_>,
    m: &Mission,
    dir: &Path,
    line: &str,
    log: &Path,
) -> Result<ChildSpec, StepError> {
    let home = claude::home().map_err(StepError::Bug)?;
    let mut spec = ChildSpec {
        kind: ChildKind::Command,
        argv: vec!["sh".into(), "-c".into(), line.into()],
        cwd: dir.to_path_buf(),
        env: vec![
            ("HOME".into(), home.into()),
            ("PATH".into(), cx.config.agent.path.clone().into()),
            ("LANG".into(), lang()),
        ],
        stdin: None,
        stdout: log.to_path_buf(),
        stderr: err_of(log),
        timeout: Some(cx.config.agent.check_timeout),
        slot: false,
        model: None,
    };
    if cx.identity.is_app() {
        let github = super::gh::github(cx, m)?;
        let token = cx
            .identity
            .token(&github, cx.tick.unix() as i64)
            .map_err(|e| StepError::Env(crate::env::Fault::Github, e.to_string()))?;
        spec.env.push(("GH_TOKEN".into(), token.into()));
    }
    Ok(spec)
}
