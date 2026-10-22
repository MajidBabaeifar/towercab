//! The sandbox of the repo's commands (PIP-23, pipeline.md **Sandbox**): ` ```checks ` (and the
//! proof's, e2e, the verifier's app) under `bwrap`: `/` read-only, `HOME` and `/tmp` empty
//! tmpfs, the toolchain directories read-only, only the checkout writable, no network for
//! checks. ` ```setup ` runs unsandboxed with network (it fills the caches the sandbox mounts
//! read-only).

use std::ffi::OsString;
use std::path::Path;

use crate::claude;
use crate::config::Config;
use crate::exes::Exes;
use crate::handler::{ChildKind, ChildSpec, Ctx, StepError};
use crate::mission::Mission;

/// `bwrap [--unshare-net] --die-with-parent --ro-bind / / --dev /dev --tmpfs <home>
/// {--ro-bind <d> <d> per existing toolchain dir} --tmpfs /tmp --bind <dir> <dir> --chdir
/// <dir> -- sh -c <line>` (`--unshare-net` unless `net`). `--dev /dev`: the read-only bind of
/// `/` mounts `nodev`, and a toolchain that opens `/dev/null` (cargo) would fail.
pub fn checks_argv(
    exes: &Exes,
    config: &Config,
    home: &Path,
    dir: &Path,
    line: &str,
    net: bool,
) -> Vec<OsString> {
    let mut a: Vec<OsString> = vec![exes.bwrap.clone()];
    if !net {
        a.push("--unshare-net".into());
    }
    a.extend(
        [
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--tmpfs",
        ]
        .map(OsString::from),
    );
    a.push(home.into());
    for d in config.agent.toolchain.iter().filter(|d| d.exists()) {
        a.extend(["--ro-bind".into(), d.into(), d.into()]);
    }
    a.extend(["--tmpfs".into(), "/tmp".into()]);
    a.extend(["--bind".into(), dir.into(), dir.into()]);
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
/// `TMPDIR=/tmp`, `XDG_CACHE_HOME=/tmp/cache`.
pub fn env(config: &Config, home: &Path) -> Vec<(OsString, OsString)> {
    vec![
        ("HOME".into(), home.into()),
        ("PATH".into(), config.agent.path.clone().into()),
        ("LANG".into(), lang()),
        ("TMPDIR".into(), "/tmp".into()),
        ("XDG_CACHE_HOME".into(), "/tmp/cache".into()),
    ]
}

/// The `.err` file next to a log: `<stem>.err`.
pub fn err_of(log: &Path) -> std::path::PathBuf {
    log.with_extension("err")
}

/// `line` sandboxed in `dir` as a child of `kind` (checks and proof without network; e2e and
/// the verifier's app with it): stdout `log`, stderr [`err_of`], `check_timeout`, no slot.
/// No `HOME` → a bug (no run, PIP-24).
pub fn command(
    cx: &Ctx<'_>,
    kind: ChildKind,
    dir: &Path,
    line: &str,
    log: &Path,
) -> Result<ChildSpec, StepError> {
    let home = claude::home().map_err(StepError::Bug)?;
    let net = !matches!(kind, ChildKind::Checks);
    Ok(ChildSpec {
        kind,
        argv: checks_argv(cx.exes, cx.config, &home, dir, line, net),
        cwd: dir.to_path_buf(),
        env: env(cx.config, &home),
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
/// [`E2E_TIMEOUT`]), its env plus the repo's secrets file (`e2e::secrets`); a refused secrets
/// file → `Ok(Err(why))` (`env_blocked`, never red).
pub fn e2e(
    cx: &Ctx<'_>,
    m: &Mission,
    dir: &Path,
    line: &str,
    log: &Path,
) -> Result<Result<ChildSpec, String>, StepError> {
    let mut spec = command(cx, ChildKind::E2e, dir, line, log)?;
    spec.timeout = Some(E2E_TIMEOUT);
    match super::e2e::secrets(&super::e2e::secrets_file(cx.config, &m.repo)) {
        Ok(kv) => spec
            .env
            .extend(kv.into_iter().map(|(k, v)| (k.into(), v.into()))),
        Err(e) => return Ok(Err(e)),
    }
    Ok(Ok(spec))
}

/// A `TOWERCAB.md` command (release, rollback, rehearse): unsandboxed in `dir` like
/// [`setup_spec`] (`ChildKind::Command`), plus `GH_TOKEN` = the App's token for the repo when
/// Towercab is the App.
pub fn repo_command(
    cx: &Ctx<'_>,
    m: &Mission,
    dir: &Path,
    line: &str,
    log: &Path,
) -> Result<ChildSpec, StepError> {
    let mut spec = setup_spec(cx, m, dir, line, log)?;
    spec.kind = ChildKind::Command;
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

/// A ` ```setup ` line, unsandboxed with network, in `dir`: `sh -c <line>`, env `HOME`, `PATH`,
/// `LANG`; stdout `log`, stderr [`err_of`], `check_timeout`.
pub fn setup_spec(
    cx: &Ctx<'_>,
    _m: &Mission,
    dir: &Path,
    line: &str,
    log: &Path,
) -> Result<ChildSpec, StepError> {
    let home = claude::home().map_err(StepError::Bug)?;
    Ok(ChildSpec {
        kind: ChildKind::Setup,
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
    })
}
