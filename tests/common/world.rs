//! A whole loop world: the intent home, target repos (a bare `origin` with a verifying block
//! and Towercab's clone of it), the loop's home and config, a fake PR source and a clock the
//! test drives.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use chrono::DateTime;
use towercab::config::{Config, GITHUB_API, GithubConfig, IntentsConfig, RepoConfig};
use towercab::db::Db;
use towercab::events::{PrSource, PrState};
use towercab::exes::Exes;
use towercab::github::GhError;
use towercab::handler::{
    ChildEnd, ChildKind, ChildSpec, Ctx, Handler, Handlers, Outcome, Progress, StepError,
};
use towercab::home::Home as LoopHome;
use towercab::machine::{Stage, Waiting};
use towercab::mission::{self, Mission};
use towercab::runloop::{Loop, LoopOpts, PassReport, Tick};

use super::{Home, git, write};

/// A `CLAUDE.md` with a verifying block (REPO-5).
pub const CLAUDE: &str = "# Repo\n\n## Verifying your work\n\n```checks\nmake test\n```\n";

/// `intents/<dir>/intent.md` with `repo`, `extra` front matter and `title`.
pub fn intent_file(dir: &str, repo: &str, extra: &str, title: &str) -> (String, String) {
    (
        format!("intents/{dir}/intent.md"),
        super::intent_md(repo, extra, title),
    )
}

/// PR states by number; every read recorded; with `failing`, every read fails with it.
#[derive(Clone, Default)]
pub struct FakePrs {
    pub states: Rc<RefCell<BTreeMap<u64, PrState>>>,
    pub reads: Rc<RefCell<Vec<(String, u64)>>>,
    pub failing: Rc<RefCell<Option<GhError>>>,
}

impl FakePrs {
    pub fn set(&self, pr: u64, state: PrState) {
        self.states.borrow_mut().insert(pr, state);
    }

    pub fn fail(&self, e: Option<GhError>) {
        *self.failing.borrow_mut() = e;
    }

    pub fn reads(&self) -> usize {
        self.reads.borrow().len()
    }
}

impl PrSource for FakePrs {
    fn read(&mut self, github: &str, pr: u64) -> Result<PrState, GhError> {
        self.reads.borrow_mut().push((github.to_string(), pr));
        if let Some(e) = self.failing.borrow().clone() {
            return Err(e);
        }
        self.states
            .borrow()
            .get(&pr)
            .cloned()
            .ok_or_else(|| GhError::Failed(format!("no PR {pr}")))
    }
}

/// An open PR at `head`, mergeable, no comments.
pub fn open_pr(head: &str) -> PrState {
    PrState {
        state: "OPEN".into(),
        head: head.into(),
        mergeable: "MERGEABLE".into(),
        ..PrState::default()
    }
}

pub struct World {
    pub intents: Home,
    pub root: PathBuf,
    pub home: LoopHome,
    pub config: Config,
    pub prs: FakePrs,
    pub clock: Tick,
}

impl World {
    /// The intent home holding `files`, and each of `repos` (`[repos.<r>]`, github `me/<r>`,
    /// workers 1) with a `CLAUDE.md` verifying block on `main`.
    pub fn new(files: &[(String, String)], repos: &[&str]) -> World {
        let files: Vec<(&str, &str)> = files
            .iter()
            .map(|(p, t)| (p.as_str(), t.as_str()))
            .collect();
        let intents = Home::new(&files);
        let root = intents.tmp.path().to_path_buf();
        let mut config = intents.config();
        config.intents = IntentsConfig {
            cutoff: 7,
            ..config.intents
        };
        // No App (its tests add one): my login, through the fake `gh` (`World::exes`).
        config.github = Some(GithubConfig {
            app_id: None,
            me: Some("me".into()),
            api_base: GITHUB_API.into(),
        });
        for name in repos {
            let origin = root.join("repos").join(format!("{name}.git"));
            fs::create_dir_all(&origin).unwrap();
            git(&origin, &["init", "--quiet", "--bare", "-b", "main"]);
            let mine = root.join("mine").join(name);
            fs::create_dir_all(mine.parent().unwrap()).unwrap();
            git(
                mine.parent().unwrap(),
                &["clone", "--quiet", origin.to_str().unwrap(), name],
            );
            git(&mine, &["checkout", "--quiet", "-B", "main"]);
            write(&mine, "CLAUDE.md", CLAUDE);
            write(&mine, "src/lib.rs", "// code\n");
            git(&mine, &["add", "-A"]);
            git(&mine, &["commit", "--quiet", "-m", "seed"]);
            git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
            let clone = root.join("clones").join(name);
            fs::create_dir_all(clone.parent().unwrap()).unwrap();
            git(
                clone.parent().unwrap(),
                &["clone", "--quiet", origin.to_str().unwrap(), name],
            );
            config.repos.insert(
                name.to_string(),
                Ok(RepoConfig {
                    name: name.to_string(),
                    github: format!("me/{name}"),
                    path: clone,
                    base: "main".into(),
                    workers: 1,
                    bash: Vec::new(),
                }),
            );
        }
        let home = LoopHome::resolve(Some(&root.join("home"))).unwrap();
        World {
            intents,
            root,
            home,
            config,
            prs: FakePrs::default(),
            clock: Tick {
                wall: DateTime::parse_from_rfc3339("2026-10-15T13:30:00+02:00").unwrap(),
                mono: Duration::from_secs(1000),
            },
        }
    }

    /// My clone of repo `name`.
    pub fn mine(&self, name: &str) -> PathBuf {
        self.root.join("mine").join(name)
    }

    /// Towercab's clone of repo `name`.
    pub fn clone_path(&self, name: &str) -> PathBuf {
        self.root.join("clones").join(name)
    }

    pub fn repo_mut(&mut self, name: &str) -> &mut RepoConfig {
        self.config.repos.get_mut(name).unwrap().as_mut().unwrap()
    }

    /// A loop on this world with `handlers`, the fake PRs and `opts`.
    pub fn open_with(&self, handlers: Handlers, exes: Exes, opts: LoopOpts) -> Loop {
        let mut lp = Loop::open(self.config.clone(), self.home.clone(), handlers, exes, opts)
            .unwrap_or_else(|e| panic!("loop opens: {e}"));
        lp.prs = Box::new(self.prs.clone());
        lp
    }

    pub fn open(&self, handlers: Handlers) -> Loop {
        self.open_with(handlers, self.exes(), LoopOpts::default())
    }

    /// [`super::fake_exes`] in `<root>/fakebin`: preflight passes, the inhibitor is a fake.
    pub fn exes(&self) -> Exes {
        super::fake_exes(&self.fakebin())
    }

    pub fn fakebin(&self) -> PathBuf {
        self.root.join("fakebin")
    }

    /// How many times the fake `systemd-inhibit` started; `inhibitor(n)`: its argv and pid.
    pub fn inhibits(&self) -> usize {
        fs::read_to_string(self.fakebin().join("inhibit.count"))
            .map(|s| s.trim().parse().unwrap())
            .unwrap_or(0)
    }

    pub fn inhibitor(&self, n: usize) -> (Vec<String>, i64) {
        let d = self.fakebin();
        let argv = fs::read_to_string(d.join(format!("inhibit-{n}.argv"))).unwrap();
        let pid = fs::read_to_string(d.join(format!("inhibit-{n}.pid"))).unwrap();
        (
            argv.lines().map(str::to_string).collect(),
            pid.trim().parse().unwrap(),
        )
    }

    /// One pass, 61 s after the last one (every poll due).
    pub fn pass(&mut self, lp: &mut Loop) -> PassReport {
        self.clock = self.clock.after(Duration::from_secs(61));
        lp.pass(self.clock).expect("pass")
    }

    /// One pass, `secs` after the last one.
    pub fn pass_after(&mut self, lp: &mut Loop, secs: u64) -> PassReport {
        self.clock = self.clock.after(Duration::from_secs(secs));
        lp.pass(self.clock).expect("pass")
    }

    /// Passes until `done` holds (at most `max`).
    pub fn until(&mut self, lp: &mut Loop, max: usize, done: impl Fn(&World) -> bool) {
        for _ in 0..max {
            if done(self) {
                return;
            }
            self.pass(lp);
        }
        assert!(done(self), "not reached in {max} passes");
    }

    pub fn db(&self) -> Db {
        Db::open(&self.home.db()).unwrap()
    }

    /// The intent's missions, oldest attempt first.
    pub fn missions(&self, intent: &str) -> Vec<Mission> {
        mission::for_intent(self.db().conn(), intent).unwrap()
    }

    /// The intent's latest mission.
    pub fn mission(&self, intent: &str) -> Mission {
        self.missions(intent).pop().expect("a mission")
    }

    /// The stage of the intent's latest mission, if any.
    pub fn stage(&self, intent: &str) -> Option<Stage> {
        self.missions(intent).pop().map(|m| m.stage)
    }

    /// `intent.md` on the remote's `main` (`intents/` or `done/`).
    pub fn intent_md(&self, dir: &str) -> String {
        for base in ["intents", "done"] {
            let rel = format!("{base}/{dir}/intent.md");
            if self.intents.remote_has(&rel) {
                return self.intents.remote_file(&rel);
            }
        }
        panic!("{dir}: no intent.md on main");
    }

    /// The `outbox` rows: (mission, event, n, text).
    pub fn outbox(&self) -> Vec<(String, String, String, String)> {
        let db = self.db();
        let mut q = db
            .conn()
            .prepare(
                "SELECT mission, event, n, text FROM outbox ORDER BY created, mission, event, n",
            )
            .unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// The transitions of `intent`'s missions: (from, event, to).
    pub fn transitions(&self, intent: &str) -> Vec<(String, String, String)> {
        let db = self.db();
        let mut q = db
            .conn()
            .prepare(
                "SELECT t.from_stage, t.event, t.to_stage FROM transitions t
                 JOIN missions m ON m.id = t.mission WHERE m.intent = ?1 ORDER BY t.id",
            )
            .unwrap();
        q.query_map([intent], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}

/// Whether `dir` is a git checkout with a valid `HEAD`.
pub fn has_head(dir: &Path) -> bool {
    dir.join(".git").exists()
        && std::process::Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", "HEAD"])
            .current_dir(dir)
            .output()
            .is_ok_and(|o| o.status.success())
}

/// What [`Scripted`] does for an intent at its stage.
#[derive(Debug, Clone, PartialEq)]
pub enum Act {
    Ok,
    Wait(Waiting),
    /// `Progress::Poll` for ever.
    Poll(Duration),
    /// Records step `run`, then a slot child in the checkout that runs until
    /// `runs/<id>/release-<stage>` exists; `ok` when it ends.
    Child,
}

/// A test handler: per intent (else `default`), what to do.
pub struct Scripted {
    pub acts: BTreeMap<String, Act>,
    pub default: Act,
}

impl Scripted {
    pub fn all(default: Act) -> Box<Scripted> {
        Box::new(Scripted {
            acts: BTreeMap::new(),
            default,
        })
    }

    pub fn by(default: Act, acts: &[(&str, Act)]) -> Box<Scripted> {
        Box::new(Scripted {
            acts: acts
                .iter()
                .map(|(i, a)| (i.to_string(), a.clone()))
                .collect(),
            default,
        })
    }

    fn act(&self, m: &Mission) -> Act {
        m.intent
            .as_ref()
            .and_then(|i| self.acts.get(i))
            .unwrap_or(&self.default)
            .clone()
    }
}

/// The child [`Act::Child`] runs: until `release` exists.
pub fn waiter(cx: &Ctx<'_>, m: &Mission) -> ChildSpec {
    let runs = cx.runs(m);
    let release = runs.join(format!("release-{}", m.stage));
    ChildSpec {
        kind: ChildKind::Claude,
        argv: vec![
            "sh".into(),
            "-c".into(),
            format!(
                "echo \"$PWD\" > {cwd}.tmp && mv {cwd}.tmp {cwd}; while [ ! -e {} ]; do sleep 0.05; done",
                release.display(),
                cwd = runs.join(format!("cwd-{}", m.stage)).display(),
            )
            .into(),
        ],
        cwd: cx.checkout(m),
        env: vec![("PATH".into(), std::env::var_os("PATH").unwrap_or_default())],
        stdin: None,
        stdout: runs.join(format!("{}.out", m.stage)),
        stderr: runs.join(format!("{}.err", m.stage)),
        timeout: None,
        slot: true,
        model: Some(m.model.clone()),
    }
}

impl Handler for Scripted {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        Ok(match self.act(m) {
            Act::Ok => Progress::Done(Outcome::ok()),
            Act::Wait(w) => Progress::Done(Outcome::wait(w, "")),
            Act::Poll(after) => Progress::Poll { after },
            Act::Child => {
                let m = if m.step == "run" {
                    m.clone()
                } else {
                    cx.record(m, "run", &[])?
                };
                Progress::Spawn(waiter(cx, &m))
            }
        })
    }

    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        Ok(Progress::Done(Outcome::ok()))
    }
}

impl World {
    /// Lets the [`Act::Child`] of `intent` at `stage` end.
    pub fn release(&self, intent: &str, stage: Stage) {
        let runs = self.home.runs(intent);
        fs::create_dir_all(&runs).unwrap();
        fs::write(runs.join(format!("release-{stage}")), "").unwrap();
    }

    /// The directory the child of `intent` at `stage` ran in.
    pub fn child_cwd(&self, intent: &str, stage: Stage) -> Option<String> {
        fs::read_to_string(self.home.runs(intent).join(format!("cwd-{stage}")))
            .ok()
            .map(|s| s.trim().to_string())
    }

    /// Passes (1 s apart) until `done` holds, at most `secs` seconds of real time.
    pub fn wait_for(&mut self, lp: &mut Loop, secs: u64, done: impl Fn(&World, &Loop) -> bool) {
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        while !done(self, lp) {
            assert!(std::time::Instant::now() < end, "not reached in {secs} s");
            std::thread::sleep(Duration::from_millis(30));
            self.pass_after(lp, 1);
        }
    }
}

/// A design that publishes PR 7 at head `h1` (`feedback_seen` 10:00 UTC).
pub struct PublishesPr;

impl Handler for PublishesPr {
    fn step(&mut self, _: &mut Ctx<'_>, _: &Mission) -> Result<Progress, StepError> {
        Ok(Progress::Done(
            Outcome::ok()
                .with("pr", 7)
                .with("pr_url", "https://github.com/me/web/pull/7".to_string())
                .with("head", "h1".to_string())
                .with("feedback_seen", "2026-10-15T10:00:00Z".to_string()),
        ))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        unreachable!()
    }
}

/// A wait (CI, deploy): `Progress::Poll { after }` for ever; each call logged as (intent,
/// monotonic time, `cx.timeouts`).
#[derive(Clone, Default)]
pub struct Poller {
    pub after: Duration,
    pub calls: Rc<RefCell<Vec<(String, Duration, bool)>>>,
}

impl Poller {
    pub fn every(after: Duration) -> Poller {
        Poller {
            after,
            ..Poller::default()
        }
    }

    /// The calls for `intent`: (monotonic time, `cx.timeouts`).
    pub fn of(&self, intent: &str) -> Vec<(Duration, bool)> {
        self.calls
            .borrow()
            .iter()
            .filter(|(i, _, _)| i == intent)
            .map(|(_, t, on)| (*t, *on))
            .collect()
    }
}

impl Handler for Poller {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        self.calls
            .borrow_mut()
            .push((m.label(), cx.tick.mono, cx.timeouts));
        Ok(Progress::Poll { after: self.after })
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        unreachable!("a poller runs no child")
    }
}
