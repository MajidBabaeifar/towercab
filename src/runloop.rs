//! The loop (LOOP-12, `run` of LOOP-15): one pass every 5 s, single-threaded, until SIGTERM
//! or SIGINT, or (without `--watch`) until it is idle.
//!
//! A pass, in LOOP-12's order: signals; wake check; Telegram updates → `commands`; apply
//! `commands`; reap children → `Handler::finish` (the drafter's → `drafts::finish_run`);
//! entry effects; child timeouts; due polls (`intents`, PRs, issues and draft PRs); due
//! missions; children waiting for a slot; pick; the drafter; faults and preflight; review due;
//! outbox; inhibitor; gauges (MET-20); the metrics flushed (MET-13). The drafts poll also drafts
//! repeated review findings and polls the evals (PIP-33, PIP-36).

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::os::unix::net::UnixStream;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use chrono::{DateTime, FixedOffset, Local, TimeZone};
use rusqlite::types::Value;
use signal_hook::consts::{SIGINT, SIGTERM};

use crate::awake::{self, Inhibitor};
use crate::child::{self, Child};
use crate::commands::{self, CmdCx};
use crate::config::{Config, RepoConfig};
use crate::db::{Db, set_meta};
use crate::drafts;
use crate::env::{self, Fault};
use crate::events::{self, GhPrs, PrSource};
use crate::exes::Exes;
use crate::github::{Bot, GhError, Identity};
use crate::handler::{
    ChildEnd, ChildKind, ChildSpec, Crashed, Ctx, Handler, Handlers, Outcome, Probe, Progress,
    StepError, update,
};
use crate::home::{Home, LoopLock};
use crate::indicators;
use crate::intents::git::AuthFn;
use crate::intents::store::find_open;
use crate::intents::{Intent, Listing, Store, Value as IValue};
use crate::limits;
use crate::machine::{self, Apply, Event, Next, Stage};
use crate::maintain;
use crate::metrics::Sink;
use crate::mission::{self, ENTER, Kind, Mission};
use crate::outbox::{self, Notice};
use crate::pick::{self, Decision, PickState};
use crate::pipeline;
use crate::priority;
use crate::status::{self, Snapshot};
use crate::telegram::{self, HELP, Telegram, TgCommand};

/// The pass interval.
pub const PASS: Duration = Duration::from_secs(5);

/// PR reads and `intents` checks: at most every 60 s (LOOP-12).
pub const POLL: Duration = Duration::from_secs(60);

/// Telegram messages older than this at the first start are skipped (LOOP-16).
pub const BACKLOG: Duration = Duration::from_secs(600);

/// Gauges (MET-20): every 60 s.
pub const GAUGES: Duration = Duration::from_secs(60);

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// A pass's clock: wall time for the database and messages, a monotonic one for run times and
/// timeouts. Tests drive the loop with their own.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tick {
    pub wall: DateTime<FixedOffset>,
    pub mono: Duration,
}

impl Tick {
    /// Now: local wall time; monotonic time since this process's first tick.
    pub fn now() -> Tick {
        Tick {
            wall: Local::now().fixed_offset(),
            mono: START.elapsed(),
        }
    }

    /// Wall time as unix seconds, the database's time format.
    pub fn unix(&self) -> f64 {
        unix(self.wall)
    }

    /// This tick `d` later, on both clocks.
    pub fn after(&self, d: Duration) -> Tick {
        Tick {
            wall: self.wall + chrono::TimeDelta::from_std(d).unwrap_or_default(),
            mono: self.mono + d,
        }
    }
}

/// Unix seconds (microsecond precision).
pub fn unix(t: DateTime<FixedOffset>) -> f64 {
    t.timestamp_micros() as f64 / 1e6
}

/// `HH:MM` on `now`'s day, else `YYYY-MM-DD HH:MM`, in `now`'s offset.
pub fn shown_time(at: f64, now: DateTime<FixedOffset>) -> String {
    let t = now
        .offset()
        .timestamp_micros((at * 1e6) as i64)
        .single()
        .unwrap_or(now);
    if t.date_naive() == now.date_naive() {
        t.format("%H:%M").to_string()
    } else {
        t.format("%Y-%m-%d %H:%M").to_string()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoopOpts {
    /// Exit only on SIGTERM or SIGINT.
    pub watch: bool,
    /// Step only this intent's mission (`run --intent`).
    pub intent: Option<String>,
    /// Time between pass starts (5 s).
    pub pass: Duration,
    /// SIGKILL a child's group this long after its SIGTERM (10 s).
    pub kill_after: Duration,
}

impl Default for LoopOpts {
    fn default() -> LoopOpts {
        LoopOpts {
            watch: false,
            intent: None,
            pass: PASS,
            kill_after: child::KILL_AFTER,
        }
    }
}

/// What a pass did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PassReport {
    /// `commands` rows applied, oldest first: (id, reply).
    pub commands: Vec<(i64, String)>,
    /// Nothing runnable and no mission driven but by a limit wait: `run` without `--watch`
    /// exits (LOOP-17).
    pub idle: bool,
    /// A SIGTERM or SIGINT had arrived: the pass did nothing.
    pub stop: bool,
    /// The intent picked this pass.
    pub picked: Option<String>,
    /// The machine slept since the last pass (LOOP-11): every wait polls again first.
    pub woke: bool,
    /// `run --intent`: its mission reached `done`, `stopped`, `approval:*` or `blocked`
    /// (`Ok`: `<id>: <stage>[ · <waiting>]`), or it can't be picked (`Err`: why).
    pub target: Option<Result<String, String>>,
    /// Issues and draft PRs were read this pass (every 300 s, INT-7).
    pub drafts: bool,
    /// The gauges step ran this pass (every 60 s, MET-20).
    pub gauges: bool,
}

/// What a handler call ended in.
enum Called {
    Returned(Result<Progress, StepError>),
    Panicked(String),
}

/// A running loop: holds the home's lock from `open` until dropped.
pub struct Loop {
    pub config: Config,
    pub home: Home,
    pub handlers: Handlers,
    pub exes: Exes,
    pub opts: LoopOpts,
    pub db: Db,
    /// `meta.running` found at `open`: the last loop's exit was unclean (LOOP-7).
    pub unclean: Option<String>,
    /// PR reads (`gh`; tests set a fake).
    pub prs: Box<dyn PrSource>,
    pub identity: Identity,
    /// Crash injection (tests).
    pub probe: Probe,
    /// `[telegram]`: updates read and the outbox sent each pass (LOOP-16).
    pub telegram: Option<Telegram>,
    /// Where this thread's metrics go at the end of each pass (MET-13).
    pub metrics: Sink,
    /// `run --intent`: the intent (resolved) and its mission.
    target: Option<String>,
    target_mission: Option<i64>,
    /// Why the target can't be picked.
    refused: Option<String>,
    store: Option<Store>,
    listing: Option<Listing>,
    children: BTreeMap<i64, Child>,
    /// Children of stages left: SIGTERM sent, SIGKILL when due.
    dying: Vec<Child>,
    /// Slot children waiting for a free slot: (mission, its stage then, spec).
    queued: Vec<(i64, Stage, ChildSpec)>,
    /// `Progress::Poll`: a mission's next step (monotonic).
    due: BTreeMap<i64, Duration>,
    pr_due: BTreeMap<i64, Duration>,
    intents_due: Option<Duration>,
    /// Issues and draft PRs (INT-7, INT-8), every 300 s.
    drafts_due: Option<Duration>,
    /// The drafter's run: (its drafts key, the child).
    drafter: Option<(String, Child)>,
    /// An eval child (PIP-33): its job and the child.
    evaluator: Option<(pipeline::evals::Job, Child)>,
    gauges_due: Option<Duration>,
    /// The bands (MNT-3): last periods evaluated, the next round, the query thread.
    pub watch: maintain::Watch,
    /// The last message logged per kind (logged again only when it changes).
    warned: BTreeMap<String, String>,
    /// An `env_blocked` episode is open (LOOP-10): no picks, no wait timeouts.
    blocked: bool,
    /// The start-up checks ran (the first pass's faults step).
    preflighted: bool,
    /// Keeps the machine awake while a mission is driven (LOOP-11).
    inhibitor: Inhibitor,
    /// The last pass's clock; before the first, `meta.last_pass` (wall, unix s).
    last_tick: Option<Tick>,
    last_wall: Option<f64>,
    /// Missions whose next handler call follows a wake: `Ctx::timeouts` false for it.
    repoll: BTreeSet<i64>,
    stop: Arc<AtomicBool>,
    _lock: LoopLock,
}

impl Loop {
    /// Takes the home's lock (another loop or `step` → `towercab is running (pid N); towercab
    /// down first`), opens the database, sets `meta.running` = `<pid> <unix s>`, opens the
    /// intent store and recovers from an unclean exit (LOOP-7).
    pub fn open(
        config: Config,
        home: Home,
        handlers: Handlers,
        exes: Exes,
        opts: LoopOpts,
    ) -> Result<Loop, String> {
        let lock = home.lock()?;
        crate::log::init(&home.root);
        let db = Db::open(&home.db())?;
        let unclean = db.meta("running")?;
        let now = Tick::now();
        db.set_meta(
            "running",
            &format!("{} {}", std::process::id(), now.wall.timestamp()),
        )?;
        // The GitHub App (LOOP-19); its bot as last looked up.
        let identity = Identity::from_config(&config, &exes);
        if let Some(bot) = db.meta("bot")?.as_deref().and_then(Bot::from_meta) {
            identity.seed_bot(bot);
        }
        let prs = Box::new(GhPrs {
            identity: identity.clone(),
        });
        let metrics = Sink::new(&config, &home);
        let mut lp = Loop {
            config,
            home,
            handlers,
            exes,
            opts,
            db,
            unclean,
            prs,
            identity,
            probe: Probe::default(),
            telegram: None,
            metrics,
            target: None,
            target_mission: None,
            refused: None,
            store: None,
            listing: None,
            children: BTreeMap::new(),
            dying: Vec::new(),
            queued: Vec::new(),
            due: BTreeMap::new(),
            pr_due: BTreeMap::new(),
            intents_due: None,
            drafts_due: None,
            drafter: None,
            evaluator: None,
            gauges_due: None,
            watch: maintain::Watch::default(),
            warned: BTreeMap::new(),
            blocked: false,
            preflighted: false,
            inhibitor: Inhibitor::new(),
            last_tick: None,
            last_wall: None,
            repoll: BTreeSet::new(),
            stop: Arc::new(AtomicBool::new(false)),
            _lock: lock,
        };
        // SIGTERM or SIGINT sets `stop` from here on (a second one exits 1), so one while
        // opening (git calls, recovery) stops the first pass cleanly.
        for sig in [SIGTERM, SIGINT] {
            let stop = Arc::clone(&lp.stop);
            signal_hook::flag::register_conditional_shutdown(sig, 1, Arc::clone(&stop))
                .and_then(|_| signal_hook::flag::register(sig, stop))
                .map_err(|e| format!("signals: {e}"))?;
        }
        lp.telegram = lp.config.telegram.as_ref().map(Telegram::new);
        lp.ensure_store();
        if let Some(s) = &lp.store {
            lp.listing = Some(s.scan());
        }
        lp.recover(now)?;
        lp.blocked = env::blocked(lp.db.conn())?;
        lp.last_wall = lp.db.meta("last_pass")?.and_then(|v| v.parse().ok());
        Ok(lp)
    }

    /// LOOP-7: leftover children killed (their group, when `/proc/<pid>/stat` still shows the
    /// same start time); after an unclean exit each `busy` mission gets `unclean + 1` (the
    /// third: `crashed at <stage>`), committed before it re-enters its step.
    fn recover(&mut self, tick: Tick) -> Result<(), String> {
        let unfinished = mission::unfinished(self.db.conn())?;
        let mut leftovers = machine::dying(self.db.conn())?;
        leftovers.extend(
            unfinished
                .iter()
                .filter_map(|m| m.child_pid.zip(m.child_start)),
        );
        for (pid, start) in leftovers {
            child::kill_leftover(pid as u32, start as u64);
        }
        // A killed child's run time counts toward its step's timeout (LOOP-9), up to the last
        // pass that saw it.
        let last: Option<f64> = self.db.meta("last_pass")?.and_then(|v| v.parse().ok());
        let ax = self.apply_cx(tick);
        for m in unfinished.iter().filter(|m| m.busy || m.has_child()) {
            self.db.tx(|tx| {
                if self.unclean.is_some() && m.busy {
                    let ran = m
                        .child_since
                        .zip(last)
                        .map_or(0.0, |(since, last)| (last - since).max(0.0));
                    let o = Outcome::event(Event::Crash).with("step_secs", m.step_secs + ran);
                    machine::apply_tx(tx, &ax, m, &o, None)?;
                }
                let mut cols = vec![("busy".to_string(), Value::Integer(0))];
                cols.extend(mission::CHILD.map(|c| (c.to_string(), Value::Null)));
                update(tx, m.id, &cols)
            })?;
        }
        machine::set_dying(self.db.conn(), &[])
    }

    /// Set by SIGTERM and SIGINT once `run` started; setting it stops the loop between passes.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    /// The last `intents` listing.
    pub fn listing(&self) -> Option<&Listing> {
        self.listing.as_ref()
    }

    /// Missions with a running child.
    pub fn running(&self) -> Vec<i64> {
        self.children.keys().copied().collect()
    }

    /// Missions whose slot child waits for a free slot.
    pub fn queued(&self) -> Vec<i64> {
        self.queued.iter().map(|(id, _, _)| *id).collect()
    }

    /// Logs `msg` for `kind` unless it was the last one logged for it.
    fn warn(&mut self, kind: &str, msg: String) {
        if self.warned.get(kind) != Some(&msg) {
            crate::tlog!("towercab: {msg}");
            self.warned.insert(kind.to_string(), msg);
        }
    }

    /// The intent store, its network and commit calls as the App (LOOP-19).
    fn ensure_store(&mut self) {
        if self.store.is_some() {
            return;
        }
        let auth = self.identity.is_app().then(|| {
            let id = self.identity.clone();
            let url = self.config.intents.remote.clone().unwrap_or_default();
            Box::new(move || id.auth_for_url(&url).map_err(|e| e.to_string())) as AuthFn
        });
        match Store::open_as(&self.config, auth) {
            Ok(s) => {
                self.warned.remove("intents");
                self.store = Some(s);
            }
            Err(e) => self.warn("intents", format!("intents: {e}")),
        }
    }

    /// One pass (LOOP-12 order); the metrics are flushed at its end even when a step failed.
    pub fn pass(&mut self, tick: Tick) -> Result<PassReport, String> {
        let r = self.pass_steps(tick);
        self.metrics.flush(tick);
        r
    }

    fn pass_steps(&mut self, tick: Tick) -> Result<PassReport, String> {
        let mut report = PassReport::default();
        if self.stop.load(Ordering::SeqCst) {
            report.stop = true;
            return Ok(report);
        }
        report.woke = self.wake_check(tick)?;
        self.ensure_store();
        report.commands = self.telegram_updates(tick)?;
        let cx = CmdCx {
            config: &self.config,
            db: &self.db,
            tick,
            store: self.store.as_ref(),
            listing: self.listing.as_ref(),
        };
        report.commands.extend(commands::apply_pending(&cx)?);
        if !report.commands.is_empty() {
            self.left_by_commands(tick)?;
            if let Some(s) = &self.store {
                self.listing = Some(s.scan());
            }
        }
        self.reap(tick)?;
        self.enter_all(tick)?;
        self.timeouts(tick);
        self.poll_intents(tick)?;
        self.poll_prs(tick)?;
        report.drafts = self.poll_drafts(tick)?;
        self.bands(tick);
        self.enter_all(tick)?;
        self.step_due(tick)?;
        self.spawn_queued(tick)?;
        let decision = self.pick(tick, &mut report)?;
        self.spawn_drafter(tick)?;
        self.faults(tick)?;
        if let Some(l) = &self.listing {
            let due = priority::review_due(l, self.config.intents.cutoff, tick.wall);
            outbox::review_due(self.db.conn(), due, tick.wall)?;
        }
        if let Some(tg) = self.telegram.as_mut() {
            outbox::send_due(&self.db, tg, self.listing.as_ref(), tick.unix())?;
        }
        self.inhibit(tick)?;
        report.gauges = self.gauges(tick);
        self.save_bot()?;
        report.idle = report.picked.is_none() && self.idle(tick, decision.as_ref())?;
        report.target = self.target_state()?;
        Ok(report)
    }

    /// LOOP-16: my messages since `meta.tg_offset`, in order, each in one transaction with
    /// the next offset: a command → a `commands` row, applied at once (its reply goes to the
    /// outbox); `status`, `next`, `help` or anything else → the reply. Other chats and
    /// messages without text are skipped. Returns the rows applied.
    fn telegram_updates(&mut self, tick: Tick) -> Result<Vec<(i64, String)>, String> {
        let Some(tg) = self.telegram.as_mut() else {
            return Ok(Vec::new());
        };
        let offset = self.db.meta("tg_offset")?.and_then(|v| v.parse().ok());
        let Ok(updates) = tg.updates(offset) else {
            return Ok(Vec::new());
        };
        let chat = tg.chat_id().to_string();
        let now = tick.unix();
        let mut applied = Vec::new();
        for u in updates {
            // The first start (no offset yet) skips Telegram's backlog (up to 24 h): an old
            // `approve` or `retry` isn't applied now.
            let stale = offset.is_none()
                && u.date
                    .is_some_and(|d| (d as f64) < now - BACKLOG.as_secs_f64());
            let parsed = u
                .text
                .as_deref()
                .filter(|_| u.chat == chat && !stale)
                .map(telegram::parse);
            let reply = match &parsed {
                None | Some(Ok(TgCommand::Cmd(_))) => None,
                Some(Ok(TgCommand::Status)) => Some(self.status_text(tick)?),
                Some(Ok(TgCommand::Next)) => Some(self.next_text(tick)?),
                Some(Ok(TgCommand::Help) | Err(_)) => Some(HELP.to_string()),
            };
            let cmd = match parsed {
                Some(Ok(TgCommand::Cmd(c))) => Some(c),
                _ => None,
            };
            let row = self.db.tx(|tx| {
                let row = match &cmd {
                    Some(c) => Some(commands::insert(tx, c, "telegram", Some(u.id), now)?),
                    None => None,
                };
                if let Some(r) = &reply {
                    let r = Notice::Reply(r.clone());
                    outbox::notify(tx, &r, &u.id.to_string(), now)?;
                }
                set_meta(tx, "tg_offset", &(u.id + 1).to_string())?;
                Ok(row)
            })?;
            if let Some(id) = row {
                let cx = CmdCx {
                    config: &self.config,
                    db: &self.db,
                    tick,
                    store: self.store.as_ref(),
                    listing: self.listing.as_ref(),
                };
                let reply = commands::apply(&cx, &commands::get(&self.db, id)?)?;
                applied.push((id, reply));
                if let Some(s) = &self.store {
                    self.listing = Some(s.scan());
                }
            }
        }
        Ok(applied)
    }

    /// `status` as this loop sees it (LOOP-13).
    pub fn status_text(&self, tick: Tick) -> Result<String, String> {
        let snapshot = Snapshot::read(
            &self.db,
            self.listing.as_ref(),
            // Logged as `intents: <error>`; the snapshot takes the error.
            self.warned
                .get("intents")
                .map(|e| e.strip_prefix("intents: ").unwrap_or(e)),
            &self.config,
            Some(std::process::id()),
            self.handlers.built(),
            tick,
        )?;
        Ok(status::render(&snapshot))
    }

    /// `next` as this loop sees it (loop.md **Next**).
    pub fn next_text(&self, tick: Tick) -> Result<String, String> {
        let Some(listing) = &self.listing else {
            return Ok("next: nothing runnable".into());
        };
        let d = pick::decide(listing, &self.pick_state(tick)?);
        Ok(status::next_text(&d, listing, self.config.intents.cutoff))
    }

    /// Missions a command moved (`step = 'enter'`): their child is stopped (SIGTERM now,
    /// SIGKILL when due), their queued child and poll dropped.
    fn left_by_commands(&mut self, tick: Tick) -> Result<(), String> {
        for m in mission::entering(self.db.conn())? {
            if let Some(mut c) = self.children.remove(&m.id) {
                c.term(tick.mono);
                self.dying.push(c);
            }
            self.queued.retain(|(id, _, _)| *id != m.id);
            self.due.remove(&m.id);
        }
        Ok(())
    }

    /// LOOP-11's wake check: the wall clock ran ahead of the monotonic one by more than 3
    /// passes since the last pass (or, at a loop's first pass, since `meta.last_pass`): every
    /// driven mission's poll, the PR reads and the `intents` poll are due now, and each
    /// mission's next handler call gets `Ctx::timeouts` false.
    fn wake_check(&mut self, tick: Tick) -> Result<bool, String> {
        let woke = match (self.last_tick, self.last_wall) {
            (Some(last), _) => awake::woke(last, tick, self.opts.pass),
            (None, Some(wall)) => tick.unix() - wall > 3.0 * self.opts.pass.as_secs_f64(),
            (None, None) => false,
        };
        self.last_tick = Some(tick);
        self.db.set_meta("last_pass", &tick.unix().to_string())?;
        if woke {
            for m in mission::unfinished(self.db.conn())? {
                if m.stage.driven() {
                    self.due.remove(&m.id);
                    self.repoll.insert(m.id);
                }
            }
            self.pr_due.clear();
            self.intents_due = self.intents_due.map(|_| tick.mono);
        }
        Ok(woke)
    }

    /// LOOP-11: the inhibitor runs while a mission (the first in PRI-4 order names it) is
    /// driven: a stage of a sequence, not held, not in a limit wait.
    fn inhibit(&mut self, tick: Tick) -> Result<(), String> {
        let mut ms = mission::unfinished(self.db.conn())?;
        ms.sort_by_key(|m| self.rank(m));
        let driving = ms
            .into_iter()
            .find(|m| m.stage.driven() && !m.held && !self.limit_waiting(m, tick.unix()))
            .map(|m| (m.label(), m.stage));
        self.inhibitor.update(driving, &self.exes, tick.mono);
        Ok(())
    }

    /// The running inhibitor's pid and `--why` (LOOP-11).
    pub fn inhibitor(&self) -> Option<(u32, String)> {
        Some((self.inhibitor.pid()?, self.inhibitor.why()?.to_string()))
    }

    fn apply_cx(&self, tick: Tick) -> Apply<'_> {
        Apply {
            db: &self.db,
            config: &self.config,
            listing: self.listing.as_ref(),
            tick,
        }
    }

    /// `machine::apply`, then: a stage left kills its child (SIGTERM now, SIGKILL when due),
    /// entry effects run.
    fn apply(&mut self, m: &Mission, o: &Outcome, tick: Tick) -> Result<Mission, String> {
        self.apply_as(m, o, None, tick)
    }

    fn apply_as(
        &mut self,
        m: &Mission,
        o: &Outcome,
        given: Option<Next>,
        tick: Tick,
    ) -> Result<Mission, String> {
        let after = machine::apply_as(&self.apply_cx(tick), m, o, given)?;
        if after != *m {
            self.probe.point();
        }
        if after.stage != m.stage || after.step == ENTER {
            if let Some(mut c) = self.children.remove(&m.id) {
                c.term(tick.mono);
                self.dying.push(c);
            }
            self.queued.retain(|(id, _, _)| *id != m.id);
            self.due.remove(&m.id);
        }
        self.enter_all(tick)?;
        mission::get(self.db.conn(), m.id)
    }

    /// Runs `f` on the handler of `stage` with a fresh `Ctx`; a panic is caught (`Crashed`,
    /// the tests' injected crash, is not).
    fn call(
        &mut self,
        m: &Mission,
        tick: Tick,
        f: impl FnOnce(&mut dyn Handler, &mut Ctx<'_>) -> Result<Progress, StepError>,
    ) -> Called {
        let (stage, id) = (m.stage, m.id);
        // Its first call after a wake: no wait timeout fires before this poll.
        let woke = self.repoll.remove(&id);
        let Some(store) = self.store.as_ref() else {
            return Called::Returned(Err(StepError::Bug("intents not open".into())));
        };
        let Some(h) = self.handlers.get_mut(stage) else {
            return Called::Returned(Err(StepError::Bug(format!("no handler for {stage}"))));
        };
        let mut cx = Ctx {
            config: &self.config,
            home: &self.home,
            db: &self.db,
            store,
            exes: &self.exes,
            identity: &mut self.identity,
            tick,
            timeouts: !self.blocked && !woke,
            probe: &self.probe,
        };
        match catch_unwind(AssertUnwindSafe(|| f(h.as_mut(), &mut cx))) {
            Ok(r) => Called::Returned(r),
            Err(p) if p.is::<Crashed>() => resume_unwind(p),
            Err(p) => Called::Panicked(
                p.downcast_ref::<String>()
                    .cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "panic".into()),
            ),
        }
    }

    /// What a handler call leads to (LOOP-4, LOOP-6, LOOP-7).
    fn progress(&mut self, m: &Mission, called: Called, tick: Tick) -> Result<(), String> {
        match called {
            Called::Panicked(msg) => {
                crate::tlog!("towercab: {}: panic at {}: {msg}", m.label(), m.stage);
                let o = Outcome {
                    why: Some(format!("panic: {msg}")),
                    ..Outcome::event(Event::Crash)
                };
                self.apply(m, &o, tick)?;
            }
            Called::Returned(Err(StepError::Env(fault, e))) => {
                self.apply_result(m, &Outcome::env(fault, e), None, tick)?;
            }
            Called::Returned(Err(StepError::Bug(e))) => {
                let o = Outcome {
                    why: Some(format!("bug: {e}")),
                    ..Outcome::event(Event::Crash)
                };
                self.apply_as(m, &o, Some(Next::Unexpected), tick)?;
            }
            Called::Returned(Ok(Progress::Done(o))) => {
                // An event its stage ignores would leave the step busy and re-called every
                // pass: a handler's bug.
                let given =
                    (machine::next(m.stage, o.event) == Next::Ignore).then_some(Next::Unexpected);
                self.apply_result(m, &o, given, tick)?;
            }
            Called::Returned(Ok(Progress::Poll { after })) => {
                update(self.db.conn(), m.id, &[("busy".into(), Value::Integer(0))])?;
                env::settle(self.db.conn(), m.id)?;
                self.due.insert(m.id, tick.mono + after);
            }
            Called::Returned(Ok(Progress::Spawn(spec))) => {
                update(self.db.conn(), m.id, &[("busy".into(), Value::Integer(0))])?;
                let m = mission::get(self.db.conn(), m.id)?;
                // A slot child always queues: `spawn_queued` hands free slots out in PRI-4
                // order, so a later step (or a finish chaining a child) never overtakes it.
                if spec.slot {
                    self.queued.push((m.id, m.stage, spec));
                } else {
                    self.spawn(&m, spec, tick)?;
                }
            }
        }
        Ok(())
    }

    /// A handler's result applied; one `apply` refuses is applied as `Unexpected` instead (a
    /// bug, counted), so it can't stall every pass.
    fn apply_result(
        &mut self,
        m: &Mission,
        o: &Outcome,
        given: Option<Next>,
        tick: Tick,
    ) -> Result<(), String> {
        if let Err(e) = self.apply_as(m, o, given, tick) {
            let o = Outcome {
                why: Some(format!("bug: {e}")),
                ..Outcome::event(Event::Crash)
            };
            self.apply_as(m, &o, Some(Next::Unexpected), tick)?;
        }
        Ok(())
    }

    /// Children with a slot running.
    pub fn slots_used(&self) -> usize {
        let drafter = self.drafter.as_ref().is_some_and(|(_, c)| c.spec.slot);
        let evaluator = self.evaluator.as_ref().is_some_and(|(_, c)| c.spec.slot);
        self.children.values().filter(|c| c.spec.slot).count()
            + usize::from(drafter)
            + usize::from(evaluator)
    }

    /// The eval child's job, while one runs (PIP-33).
    pub fn evaluating(&self) -> Option<&pipeline::evals::Job> {
        self.evaluator.as_ref().map(|(j, _)| j)
    }

    /// The drafts key whose drafter runs (INT-7).
    pub fn drafting(&self) -> Option<&str> {
        self.drafter.as_ref().map(|(k, _)| k.as_str())
    }

    fn slot_free(&self) -> bool {
        self.slots_used() < usize::from(self.config.agent.parallel)
    }

    /// Starts a mission's child; its timeout counts the step's earlier run time (`step_secs`,
    /// LOOP-9, LOOP-12), so a limit wait or a restart in between never adds to it.
    fn spawn(&mut self, m: &Mission, spec: ChildSpec, tick: Tick) -> Result<(), String> {
        let exe = spec
            .argv
            .first()
            .map(|a| a.to_string_lossy().into_owned())
            .unwrap_or_default();
        // A missing directory or input is the handler's bug, not the program's fault.
        let missing = if !spec.cwd.is_dir() {
            Some(format!("{}: no such directory", spec.cwd.display()))
        } else {
            spec.stdin
                .as_ref()
                .filter(|p| !p.is_file())
                .map(|p| format!("{}: no such file", p.display()))
        };
        if let Some(e) = missing {
            let o = Outcome {
                why: Some(format!("bug: {e}")),
                ..Outcome::event(Event::Crash)
            };
            self.apply_as(m, &o, Some(Next::Unexpected), tick)?;
            return Ok(());
        }
        match child::spawn(&spec, tick.mono) {
            Ok(mut c) => {
                let used = Duration::try_from_secs_f64(m.step_secs).unwrap_or_default();
                c.budget = spec.timeout.map(|t| t.saturating_sub(used));
                update(
                    self.db.conn(),
                    m.id,
                    &[
                        ("busy".into(), Value::Integer(1)),
                        ("child_pid".into(), Value::Integer(i64::from(c.pid))),
                        (
                            "child_start".into(),
                            c.start.map_or(Value::Null, |s| Value::Integer(s as i64)),
                        ),
                        ("child_kind".into(), Value::Text(spec.kind.as_str().into())),
                        ("child_since".into(), Value::Real(tick.unix())),
                        (
                            "child_model".into(),
                            spec.model
                                .clone()
                                .filter(|_| spec.kind == ChildKind::Claude)
                                .map_or(Value::Null, Value::Text),
                        ),
                    ],
                )?;
                // The step's calls got this far; a Claude run or a sandboxed command settles
                // its fault only when it ends well.
                if m.fault
                    .as_deref()
                    .is_some_and(|f| !matches!(f.parse(), Ok(Fault::Claude) | Ok(Fault::Sandbox)))
                {
                    env::settle(self.db.conn(), m.id)?;
                }
                self.children.insert(m.id, c);
            }
            // `child::spawn` names the program when it can't start; any other error is a run
            // file it couldn't make.
            Err(e) if e.starts_with(&format!("{exe}: ")) => {
                self.apply(m, &Outcome::env(Fault::Tool(exe), e), tick)?;
            }
            Err(e) => {
                let o = Outcome {
                    why: Some(format!("bug: {e}")),
                    ..Outcome::event(Event::Crash)
                };
                self.apply_as(m, &o, Some(Next::Unexpected), tick)?;
            }
        }
        Ok(())
    }

    /// Children that ended → `Handler::finish` (LOOP-12); children of stages left: SIGKILL
    /// when due.
    fn reap(&mut self, tick: Tick) -> Result<(), String> {
        let after = self.opts.kill_after;
        let mut reaped = Vec::new();
        self.dying.retain_mut(|c| {
            if c.poll(tick.mono).is_some() {
                child::kill_group(c.pid);
                reaped.push(i64::from(c.pid));
                return false;
            }
            c.kill_if_due(tick.mono, after);
            true
        });
        if !reaped.is_empty() {
            let mut d = machine::dying(self.db.conn())?;
            d.retain(|(pid, _)| !reaped.contains(pid));
            machine::set_dying(self.db.conn(), &d)?;
        }
        self.reap_drafter(tick)?;
        self.reap_evaluator(tick)?;
        let ended: Vec<(i64, ChildEnd)> = self
            .children
            .iter_mut()
            .filter_map(|(id, c)| c.poll(tick.mono).map(|e| (*id, e)))
            .collect();
        for (id, end) in ended {
            let mut model = None;
            if let Some(c) = self.children.remove(&id) {
                // What its group left behind (a shell's children) goes too.
                child::kill_group(c.pid);
                model = c.spec.model.clone();
            }
            let m = mission::get(self.db.conn(), id)?;
            let mut cols: Vec<(String, Value)> =
                mission::CHILD.map(|c| (c.to_string(), Value::Null)).into();
            cols.push((
                "step_secs".into(),
                Value::Real(m.step_secs + end.run.as_secs_f64()),
            ));
            update(self.db.conn(), id, &cols)?;
            let m = mission::get(self.db.conn(), id)?;
            let called = self.call(&m, tick, |h, cx| h.finish(cx, &m, end));
            // A run on a model that hit no limit (nor a network or auth failure): the model's
            // backoffs start over (LOOP-9). A bug or panic in `finish` says nothing either way
            // (it may have missed a limit): left alone.
            let ran = match &called {
                Called::Returned(Ok(Progress::Done(o))) => {
                    !matches!(o.event, Event::Limit | Event::EnvFail)
                }
                Called::Returned(Ok(_)) => true,
                Called::Returned(Err(_)) | Called::Panicked(_) => false,
            };
            if let (Some(model), true) = (&model, ran) {
                limits::success(self.db.conn(), model)?;
            }
            self.progress(&m, called, tick)?;
        }
        Ok(())
    }

    /// Children whose run time used up their budget: SIGTERM to the group, SIGKILL after
    /// `kill_after` (LOOP-12); the next reap hands `finish` a `timed_out` end.
    fn timeouts(&mut self, tick: Tick) {
        let after = self.opts.kill_after;
        for c in self.children.values_mut() {
            c.enforce(tick.mono, after);
        }
        if let Some((_, c)) = self.drafter.as_mut() {
            c.enforce(tick.mono, after);
        }
        if let Some((_, c)) = self.evaluator.as_mut() {
            c.enforce(tick.mono, after);
        }
    }

    /// A `Ctx` for work outside a mission's handler (drafts); `None` without the store.
    fn with_cx<T>(&mut self, tick: Tick, f: impl FnOnce(&mut Ctx<'_>) -> T) -> Option<T> {
        let store = self.store.as_ref()?;
        let mut cx = Ctx {
            config: &self.config,
            home: &self.home,
            db: &self.db,
            store,
            exes: &self.exes,
            identity: &mut self.identity,
            tick,
            timeouts: !self.blocked,
            probe: &self.probe,
        };
        Some(f(&mut cx))
    }

    /// A GitHub failure outside a mission: network or auth opens `github` (LOOP-10); logged.
    fn gh_failed(&mut self, kind: &str, e: GhError, tick: Tick) -> Result<(), String> {
        if let GhError::Env(m) = &e {
            env::open(self.db.conn(), &Fault::Github, m, tick.unix())?;
        }
        self.warn(kind, format!("{kind}: {e}"));
        Ok(())
    }

    /// INT-7, INT-8 every 300 s: each `[repos]` repo's issues labelled `intent`, then each
    /// draft's PR. Not with `--intent`. True when it ran.
    fn poll_drafts(&mut self, tick: Tick) -> Result<bool, String> {
        if self.target.is_some() || self.store.is_none() {
            return Ok(false);
        }
        if self.drafts_due.is_some_and(|d| tick.mono < d) {
            return Ok(false);
        }
        self.drafts_due = Some(tick.mono + drafts::POLL);
        let repos: Vec<RepoConfig> = self
            .config
            .repos
            .values()
            .filter_map(|r| r.as_ref().ok().cloned())
            .collect();
        let results = self
            .with_cx(tick, |cx| {
                let mut out: Vec<(String, Result<(), GhError>)> = repos
                    .iter()
                    .map(|r| (format!("issues {}", r.name), drafts::poll_issues(cx, r)))
                    .collect();
                out.push(("findings".into(), pipeline::findings::draft_due(cx)));
                out.push(("drafts".into(), drafts::poll_drafts(cx)));
                out.push(("maintain".into(), maintain::settle(cx)));
                out
            })
            .unwrap_or_default();
        for (kind, r) in results {
            match r {
                Ok(()) => {
                    self.warned.remove(&kind);
                }
                Err(e) => self.gh_failed(&kind, e, tick)?,
            }
        }
        self.poll_evals(tick)?;
        Ok(true)
    }

    /// MNT-3 (not with `--intent`): the bands' round; Prometheus never blocks it, nothing
    /// in it fails the pass.
    fn bands(&mut self, tick: Tick) {
        if self.target.is_none() {
            self.watch
                .round(&self.config, &self.exes, &self.db, &self.home, tick);
        }
    }

    /// PIP-33 with the drafts poll: `towercab/evals` on the Towercab repo's PR heads, the
    /// baseline triggers when idle; an eval child (one at a time, a slot) when one is due.
    fn poll_evals(&mut self, tick: Tick) -> Result<(), String> {
        if self.evaluator.is_some() || self.blocked || !self.queued.is_empty() {
            return Ok(());
        }
        let idle = self.idle(tick, None)?;
        let polled = self.with_cx(tick, |cx| {
            pipeline::evals::poll(cx, idle).map(|job| {
                job.map(|j| {
                    let spec = pipeline::evals::spec(cx, &j);
                    (j, spec)
                })
            })
        });
        let (job, spec) = match polled {
            None | Some(Ok(None)) => {
                self.warned.remove("evals");
                return Ok(());
            }
            Some(Err(e)) => return self.gh_failed("evals", e, tick),
            Some(Ok(Some((job, Err(e))))) => {
                self.warn("evals", format!("evals: {job:?}: {e}"));
                return Ok(());
            }
            Some(Ok(Some((job, Ok(spec))))) => (job, spec),
        };
        if !self.slot_free() {
            return Ok(());
        }
        match child::spawn(&spec, tick.mono) {
            Ok(mut c) => {
                c.budget = spec.timeout;
                self.evaluator = Some((job, c));
            }
            Err(e) => self.warn("evals", format!("evals: {e}")),
        }
        Ok(())
    }

    /// The eval child's end → `evals::ended` (a PR's failure posted, a baseline's metas).
    fn reap_evaluator(&mut self, tick: Tick) -> Result<(), String> {
        let Some(end) = self.evaluator.as_mut().and_then(|(_, c)| c.poll(tick.mono)) else {
            return Ok(());
        };
        let Some((job, c)) = self.evaluator.take() else {
            return Ok(());
        };
        child::kill_group(c.pid);
        match self.with_cx(tick, |cx| pipeline::evals::ended(cx, &job, Some(&end))) {
            Some(Err(e)) => self.gh_failed("evals", e, tick)?,
            Some(Ok(())) => {
                self.warned.remove("evals");
            }
            None => {}
        }
        Ok(())
    }

    /// The next issue's drafter (INT-7), when a slot is free after the missions' children and
    /// the pick; one at a time, not while `env_blocked` or with `--intent`.
    fn spawn_drafter(&mut self, tick: Tick) -> Result<(), String> {
        if self.target.is_some()
            || self.drafter.is_some()
            || self.blocked
            || !self.queued.is_empty()
            || !self.slot_free()
        {
            return Ok(());
        }
        let Some(next) = self.with_cx(tick, drafts::next_run) else {
            return Ok(());
        };
        let (key, spec) = match next {
            Ok(Some(x)) => x,
            Ok(None) => return Ok(()),
            Err(e) => {
                self.warn("drafter", format!("drafter: {e}"));
                return Ok(());
            }
        };
        match child::spawn(&spec, tick.mono) {
            Ok(mut c) => {
                c.budget = spec.timeout;
                self.drafter = Some((key, c));
            }
            Err(e) => {
                self.with_cx(tick, |cx| drafts::not_run(cx, &key));
                let exe = spec
                    .argv
                    .first()
                    .map(|a| a.to_string_lossy().into_owned())
                    .unwrap_or_default();
                env::open(self.db.conn(), &Fault::Tool(exe), &e, tick.unix())?;
                self.warn("drafter", format!("drafter: {e}"));
            }
        }
        Ok(())
    }

    /// The drafter's end → `drafts::finish_run` (its PR opened, or the try counted).
    fn reap_drafter(&mut self, tick: Tick) -> Result<(), String> {
        let Some(end) = self.drafter.as_mut().and_then(|(_, c)| c.poll(tick.mono)) else {
            return Ok(());
        };
        let Some((key, c)) = self.drafter.take() else {
            return Ok(());
        };
        child::kill_group(c.pid);
        match self.with_cx(tick, |cx| drafts::finish_run(cx, &key, &end)) {
            Some(Err(e)) => self.gh_failed(&format!("draft {key}"), e, tick)?,
            Some(Ok(_)) => {
                self.warned.remove(&format!("draft {key}"));
            }
            None => {}
        }
        Ok(())
    }

    /// Gauges every 60 s (MET-20, MET-24): the backlog, the loop's state, its children. True
    /// when due. A failure is logged, never the pass's.
    fn gauges(&mut self, tick: Tick) -> bool {
        if self.gauges_due.is_some_and(|d| tick.mono < d) {
            return false;
        }
        self.gauges_due = Some(tick.mono + GAUGES);
        let active = self.children.len()
            + usize::from(self.drafter.is_some())
            + usize::from(self.evaluator.is_some());
        let r = self.loop_state(tick, active).and_then(|state| {
            indicators::gauges(
                self.db.conn(),
                self.listing.as_ref(),
                self.config.intents.cutoff,
                state,
                active,
            )
        });
        if let Err(e) = r {
            self.warn("gauges", format!("gauges: {e}"));
        }
        true
    }

    /// MET-20's `loop.state`: `paused` > `env_blocked` > `running` (a child, or a driven
    /// mission not in a limit wait) > `limit` (every driven mission in one) > `idle`.
    fn loop_state(&self, tick: Tick, active: usize) -> Result<&'static str, String> {
        if machine::paused(self.db.conn())? {
            return Ok("paused");
        }
        if self.blocked {
            return Ok("env_blocked");
        }
        let now = tick.unix();
        let driven: Vec<Mission> = mission::unfinished(self.db.conn())?
            .into_iter()
            .filter(|m| m.stage.driven() && !m.held)
            .collect();
        Ok(
            if active > 0 || driven.iter().any(|m| !self.limit_waiting(m, now)) {
                "running"
            } else if !driven.is_empty() {
                "limit"
            } else {
                "idle"
            },
        )
    }

    /// The `intents` poll (LOOP-5, LOOP-18): every 60 s, pulled when `origin`'s `main` moved
    /// (`git ls-remote`, and always the first time), else the checkout re-read; then intent
    /// events, `retry: fresh` and orphaned stages.
    fn poll_intents(&mut self, tick: Tick) -> Result<(), String> {
        let Some(store) = self.store.as_ref() else {
            return Ok(());
        };
        if self.intents_due.is_some_and(|d| tick.mono < d) {
            return Ok(());
        }
        let first = self.intents_due.is_none();
        self.intents_due = Some(tick.mono + POLL);
        let co = store.checkout();
        let moved = first
            || !co.origin
            || match (
                co.git_as(&["ls-remote", "origin", "refs/heads/main"]),
                co.git(&["rev-parse", "refs/remotes/origin/main"]),
            ) {
                (Ok(remote), Ok(local)) => remote.split_whitespace().next() != Some(local.trim()),
                _ => true,
            };
        let listing = if moved {
            match store.list() {
                Ok(l) => l,
                Err(e) => {
                    let e = e.to_string();
                    if env::classify(&e).is_some() {
                        env::open(self.db.conn(), &Fault::Github, &e, tick.unix())?;
                    }
                    self.warn("intents", format!("intents: {e}"));
                    return Ok(());
                }
            }
        } else {
            store.scan()
        };
        self.warned.remove("intents");
        self.listing = Some(listing);
        self.intent_events(tick)
    }

    /// Intent events for unfinished missions (LOOP-18); intents with `retry: fresh` or a
    /// `stage` but no unfinished mission unstaged (LOOP-5, `towercab: unstage <id>`).
    fn intent_events(&mut self, tick: Tick) -> Result<(), String> {
        let Some(listing) = self.listing.clone() else {
            return Ok(());
        };
        for m in mission::unfinished(self.db.conn())? {
            if let Some(ev) = events::intent_events(&m, &listing) {
                self.apply(&m, &Outcome::event(ev), tick)?;
            }
        }
        // A finished mission whose entry write is due still owns its intent.
        let mut unfinished = mission::unfinished(self.db.conn())?;
        unfinished.extend(
            mission::entering(self.db.conn())?
                .into_iter()
                .filter(|m| m.stage.finished()),
        );
        let busy: BTreeSet<&str> = unfinished
            .iter()
            .filter_map(|m| m.intent.as_deref())
            .collect();
        let mut ids: Vec<String> = listing
            .open
            .iter()
            .filter(|i| i.retry() == Some("fresh") && !busy.contains(i.id.as_str()))
            .map(|i| i.id.clone())
            .collect();
        for id in pick::orphans(&listing, &unfinished) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let mut wrote = false;
        for id in ids {
            let Some(store) = self.store.as_ref() else {
                break;
            };
            let unstaged = store.update(&id, "unstage", |i| {
                i.remove("stage")?;
                if i.retry() == Some("fresh") {
                    i.remove("retry")?;
                    i.remove("waiting")?;
                }
                Ok(())
            });
            match unstaged {
                Ok(_) => {
                    wrote = true;
                    self.probe.point();
                }
                Err(e) => self.warn(&format!("unstage {id}"), format!("{id}: unstage: {e}")),
            }
        }
        if wrote && let Some(s) = &self.store {
            self.listing = Some(s.scan());
        }
        Ok(())
    }

    /// PR reads every 60 s per mission with a PR Towercab hasn't merged (LOOP-18, PIP-21): at
    /// most one event each; `feedback`, `conflict` and `head_moved` wait while a child runs.
    fn poll_prs(&mut self, tick: Tick) -> Result<(), String> {
        let me = self
            .config
            .github
            .as_ref()
            .and_then(|g| g.me.clone())
            .unwrap_or_default();
        for m in mission::unfinished(self.db.conn())? {
            let Some(pr) = m.pr else { continue };
            // The merge step, once recorded, may have merged: its re-entry reads `mergedAt`, so a
            // crash after my merge isn't taken for a human one.
            let merging = m.stage == Stage::Merge && !m.step.is_empty() && m.step != ENTER;
            if m.kind != Kind::Intent || m.merge_sha.is_some() || merging {
                continue;
            }
            if self.pr_due.get(&m.id).is_some_and(|d| tick.mono < *d) {
                continue;
            }
            self.pr_due.insert(m.id, tick.mono + POLL);
            let Ok(repo) = self.config.repo(&m.repo) else {
                continue;
            };
            let github = repo.github.clone();
            let key = format!("pr {}", m.id);
            let state = match self.prs.read(&github, pr) {
                Ok(s) => {
                    self.warned.remove(&key);
                    s
                }
                Err(e) => {
                    if let GhError::Env(err) = &e {
                        env::open(self.db.conn(), &Fault::Github, err, tick.unix())?;
                    }
                    self.warn(&key, format!("{}: PR {pr}: {e}", m.label()));
                    continue;
                }
            };
            let Some(ev) = events::pr_events(&m, &state, &me) else {
                continue;
            };
            let running = self.children.contains_key(&m.id)
                || self.queued.iter().any(|(id, _, _)| *id == m.id);
            if running && matches!(ev, Event::Feedback | Event::Conflict | Event::HeadMoved) {
                continue;
            }
            // Back to its own stage (feedback at build, head moved at ci) would restart the step
            // every read, its waits and counts wiped: it comes back at the next stage.
            if machine::next(m.stage, ev) == Next::Go(m.stage) {
                continue;
            }
            let mut o = Outcome::event(ev);
            if ev == Event::PrMerged {
                o = o.with("merged_by", "human".to_string());
                if let Some(sha) = state.merge_commit.clone() {
                    o = o.with("merge_sha", sha);
                }
            }
            self.apply(&m, &o, tick)?;
        }
        Ok(())
    }

    /// Entry effects of every mission whose stage changed (LOOP-6); a failure is logged and
    /// retried at the next pass.
    fn enter_all(&mut self, tick: Tick) -> Result<(), String> {
        let mut wrote = false;
        for m in mission::entering(self.db.conn())? {
            let Some(store) = self.store.as_ref() else {
                break;
            };
            let mut cx = Ctx {
                config: &self.config,
                home: &self.home,
                db: &self.db,
                store,
                exes: &self.exes,
                identity: &mut self.identity,
                tick,
                timeouts: !self.blocked,
                probe: &self.probe,
            };
            match machine::enter(&mut cx, &m) {
                Ok(_) => {
                    wrote = true;
                    self.warned.remove(&format!("enter {}", m.id));
                }
                Err(e) => self.warn(&format!("enter {}", m.id), format!("{}: {e}", m.label())),
            }
        }
        if wrote && let Some(s) = &self.store {
            self.listing = Some(s.scan());
        }
        Ok(())
    }

    /// The App's bot, once looked up, kept in `meta.bot` (LOOP-19).
    fn save_bot(&mut self) -> Result<(), String> {
        if let Some(bot) = self.identity.cached_bot() {
            let meta = bot.meta();
            if self.db.meta("bot")?.as_deref() != Some(meta.as_str()) {
                self.db.set_meta("bot", &meta)?;
            }
        }
        Ok(())
    }

    /// The PRI-4 rank of a mission's intent (missions without an open intent last).
    fn rank(&self, m: &Mission) -> (usize, i64) {
        let at = self.listing.as_ref().and_then(|l| {
            let i = l
                .open
                .iter()
                .find(|i| Some(i.id.as_str()) == m.intent.as_deref())?;
            Some(
                l.open
                    .iter()
                    .filter(|o| priority::cmp(o, i) == std::cmp::Ordering::Less)
                    .count(),
            )
        });
        (at.unwrap_or(usize::MAX), m.id)
    }

    /// Waiting for a model's cooldown (LOOP-9).
    fn limit_waiting(&self, m: &Mission, now: f64) -> bool {
        let Some(model) = &m.limit_model else {
            return false;
        };
        limits::until(self.db.conn(), model)
            .ok()
            .flatten()
            .is_some_and(|u| u > now)
    }

    /// Driven, not held, no running or queued child, no wait (poll, backoff, limit) pending.
    fn due_now(&self, m: &Mission, tick: Tick) -> bool {
        m.step != ENTER
            && m.stage.driven()
            && !m.held
            && !self.children.contains_key(&m.id)
            && !self.queued.iter().any(|(id, _, _)| *id == m.id)
            && m.retry_at.is_none_or(|t| t <= tick.unix())
            && self.due.get(&m.id).is_none_or(|d| *d <= tick.mono)
            && !self.limit_waiting(m, tick.unix())
    }

    /// One handler step for each due mission, in their intents' PRI-4 order.
    fn step_due(&mut self, tick: Tick) -> Result<(), String> {
        if self.store.is_none() {
            return Ok(());
        }
        let mut ms = mission::unfinished(self.db.conn())?;
        ms.sort_by_key(|m| self.rank(m));
        for m in ms {
            let m = mission::get(self.db.conn(), m.id)?;
            if !self.targets(&m) || !self.due_now(&m, tick) {
                continue;
            }
            self.due.remove(&m.id);
            update(
                self.db.conn(),
                m.id,
                &[
                    ("busy".into(), Value::Integer(1)),
                    ("limit_model".into(), Value::Null),
                ],
            )?;
            let m = mission::get(self.db.conn(), m.id)?;
            let called = self.call(&m, tick, |h, cx| h.step(cx, &m));
            self.progress(&m, called, tick)?;
        }
        Ok(())
    }

    /// Slot children waiting, in their intents' PRI-4 order, while a slot is free (LOOP-4).
    fn spawn_queued(&mut self, tick: Tick) -> Result<(), String> {
        let mut queued = std::mem::take(&mut self.queued);
        queued.sort_by_key(|(id, _, _)| {
            mission::get(self.db.conn(), *id).map_or((usize::MAX, *id), |m| self.rank(&m))
        });
        for (id, stage, spec) in queued {
            let Ok(m) = mission::get(self.db.conn(), id) else {
                continue;
            };
            if m.stage != stage || m.step == ENTER {
                continue;
            }
            if self.slot_free() {
                self.spawn(&m, spec, tick)?;
            } else {
                self.queued.push((id, stage, spec));
            }
        }
        Ok(())
    }

    /// A mission ahead of a new pick for a slot: driven and stepping (not held, no child, no
    /// poll, backoff or limit wait).
    fn pending(&self, m: &Mission, tick: Tick) -> bool {
        m.stage.driven()
            && !m.held
            && !self.children.contains_key(&m.id)
            && self.due.get(&m.id).is_none_or(|d| *d <= tick.mono)
            && m.retry_at.is_none_or(|t| t <= tick.unix())
            && !self.limit_waiting(m, tick.unix())
    }

    /// LOOP-5's inputs from the database and config.
    pub fn pick_state(&self, tick: Tick) -> Result<PickState, String> {
        pick::state(&self.db, &self.config, self.handlers.built(), tick)
    }

    /// LOOP-5: the waits written without a mission (the outbox row first, then the intent),
    /// then, with a slot free and no mission ahead of it, the pick: one transaction inserts the
    /// mission at `pick`.
    fn pick(&mut self, tick: Tick, report: &mut PassReport) -> Result<Option<Decision>, String> {
        let (Some(listing), true) = (self.listing.clone(), self.store.is_some()) else {
            return Ok(None);
        };
        let state = self.pick_state(tick)?;
        let decision = match self.target.clone() {
            None => pick::decide(&listing, &state),
            // Its mission exists: nothing to pick.
            Some(_) if self.target_mission.is_some() => Decision::default(),
            Some(id) => {
                let (d, r) = pick::decide_for(&listing, &state, &id);
                self.refused = r.err();
                d
            }
        };
        let mut wrote = false;
        for (id, w, n) in &decision.writes {
            let Some(intent) = listing.open.iter().find(|i| i.id == *id) else {
                continue;
            };
            let why = decision
                .skipped
                .iter()
                .find(|(s, _)| s == id)
                .map(|(_, skip)| skip.to_string());
            let subject = outbox::Subject {
                id: id.clone(),
                repo: intent.repo().to_string(),
                title: intent.title().to_string(),
                slug: intent.slug.clone(),
                pr_url: None,
                why,
            };
            let text = outbox::render_waiting(w, &subject, &self.config);
            let key = format!("intent:{id}");
            outbox::enqueue(self.db.conn(), &key, &w.key(), n, &text, tick.unix())?;
            self.probe.point();
            let Some(store) = self.store.as_ref() else {
                break;
            };
            let waiting = w.text();
            match store.update(id, "wait", |i| {
                i.set("waiting", IValue::Str(waiting.clone()))
            }) {
                Ok(_) => {
                    wrote = true;
                    self.probe.point();
                }
                Err(e) => self.warn(&format!("wait {id}"), format!("{id}: {e}")),
            }
        }
        if wrote && let Some(s) = &self.store {
            self.listing = Some(s.scan());
        }
        let Some(id) = decision.pick.clone() else {
            // Nothing to pick on an idle pass: the slot may go to a rollback rehearsal (PIP-35).
            if self.target.is_none()
                && self.handlers.built()
                && !self.blocked
                && self.slot_free()
                && self.queued.is_empty()
                && !machine::paused(self.db.conn())?
                && self.idle(tick, Some(&decision))?
                && pipeline::rehearse::schedule(&self.db, &self.config, tick)?.is_some()
            {
                self.probe.point();
            }
            return Ok(Some(decision));
        };
        let unfinished = mission::unfinished(self.db.conn())?;
        let ahead = !self.slot_free()
            || !self.queued.is_empty()
            || unfinished
                .iter()
                .any(|m| self.targets(m) && self.pending(m, tick));
        if ahead {
            return Ok(Some(decision));
        }
        let Some(intent) = listing.open.iter().find(|i| i.id == id).cloned() else {
            return Ok(Some(decision));
        };
        let m = self.insert_pick(&intent, tick)?;
        if self.target.is_some() {
            self.target_mission = Some(m.id);
        }
        report.picked = Some(id);
        Ok(Some(decision))
    }

    /// `m` is stepped: no `--intent`, or it is the target's.
    fn targets(&self, m: &Mission) -> bool {
        self.target
            .as_ref()
            .is_none_or(|t| m.intent.as_ref() == Some(t))
    }

    /// `run --intent` and `step` (LOOP-15): only intent `q`'s (any unique suffix) mission is
    /// stepped and picked, regardless of order and cutoff (not of skips). Returns its id.
    pub fn set_target(&mut self, q: &str) -> Result<String, String> {
        let listing = self.listing.as_ref().ok_or("intents can't be read")?;
        let id = find_open(listing, q).map_err(|e| e.to_string())?.id;
        self.target_mission = mission::unfinished_for(self.db.conn(), &id)?.map(|m| m.id);
        self.target = Some(id.clone());
        self.refused = None;
        Ok(id)
    }

    /// `<id>: <stage>[ · <waiting>]` once the target's mission is `done`, `stopped`,
    /// `approval:*` or `blocked` (entry effects run); `Err` when it can't be picked.
    fn target_state(&self) -> Result<Option<Result<String, String>>, String> {
        let Some(id) = &self.target else {
            return Ok(None);
        };
        if let Some(why) = &self.refused {
            return Ok(Some(Err(format!("{id}: not picked: {why}"))));
        }
        let Some(mid) = self.target_mission else {
            return Ok(None);
        };
        let m = mission::get(self.db.conn(), mid)?;
        if m.step == ENTER || !(m.stage.finished() || m.stage.waits()) {
            return Ok(None);
        }
        Ok(Some(Ok(stage_line(id, &m))))
    }

    /// `towercab step <id>` (LOOP-15): one step of the intent's unfinished mission in the
    /// foreground: one handler call, then each child it spawns waited for and `finish`ed,
    /// entry effects after. No mission → picked as `run --intent` does, then its first step.
    /// Returns `<id>: <stage> → <stage>[ · <waiting>]`.
    pub fn step_intent(&mut self, q: &str) -> Result<String, String> {
        let out = self.step_once(q);
        self.metrics.flush(Tick::now());
        out
    }

    fn step_once(&mut self, q: &str) -> Result<String, String> {
        let id = self.set_target(q)?;
        let tick = Tick::now();
        self.enter_all(tick)?;
        let mid = match self.target_mission {
            Some(mid) => mid,
            None => {
                let listing = self.listing.clone().ok_or("intents can't be read")?;
                let state = self.pick_state(tick)?;
                pick::decide_for(&listing, &state, &id)
                    .1
                    .map_err(|why| format!("{id}: not picked: {why}"))?;
                let intent = find_open(&listing, &id).map_err(|e| e.to_string())?;
                let m = self.insert_pick(&intent, tick)?;
                self.target_mission = Some(m.id);
                self.enter_all(tick)?;
                m.id
            }
        };
        let m = mission::get(self.db.conn(), mid)?;
        let from = m.stage;
        if m.step == ENTER {
            // Its entry effects failed (logged): the step would overwrite them.
            let why = self.warned.get(&format!("enter {mid}")).cloned();
            return Err(why.unwrap_or_else(|| format!("{id}: entry effects not done")));
        }
        if !m.stage.driven() || m.held {
            return Ok(format!("{id}: {from} → {}", stage_line_rest(&m)));
        }
        if !self.handlers.get_mut(m.stage).is_some_and(|h| h.built()) {
            return Err(format!("{id}: {} handler not built", m.stage));
        }
        // A foreground command doesn't wait (LOOP-15): a cooling model or a backoff refuses.
        let now = tick.unix();
        if let Some(model) = &m.limit_model
            && let Some(until) = limits::until(self.db.conn(), model)?.filter(|u| *u > now)
        {
            let at = shown_time(until, tick.wall);
            return Err(format!("{id}: {model} cooling until {at}"));
        }
        if let Some(at) = m.retry_at.filter(|t| *t > now) {
            return Err(format!("{id}: retry at {}", shown_time(at, tick.wall)));
        }
        // SIGTERM or SIGINT while its child runs: stopped as at shutdown (`interrupted`).
        let _wake = self.signals().map_err(|e| format!("signals: {e}"))?;
        update(
            self.db.conn(),
            m.id,
            &[
                ("busy".into(), Value::Integer(1)),
                ("limit_model".into(), Value::Null),
            ],
        )?;
        let m = mission::get(self.db.conn(), mid)?;
        let called = self.call(&m, tick, |h, cx| h.step(cx, &m));
        self.progress(&m, called, tick)?;
        while self.children.contains_key(&mid) || self.queued.iter().any(|(i, _, _)| *i == mid) {
            if self.stop.load(Ordering::SeqCst) {
                return Err(format!("{id}: interrupted"));
            }
            std::thread::sleep(Duration::from_millis(20));
            let tick = Tick::now();
            self.spawn_queued(tick)?;
            self.timeouts(tick);
            self.reap(tick)?;
        }
        self.enter_all(Tick::now())?;
        let after = mission::get(self.db.conn(), mid)?;
        Ok(format!("{id}: {from} → {}", stage_line_rest(&after)))
    }

    fn insert_pick(&mut self, intent: &Intent, tick: Tick) -> Result<Mission, String> {
        let config = &self.config;
        let m = self
            .db
            .tx(|tx| mission::insert_pick(tx, intent, config, tick))?;
        self.probe.point();
        Ok(m)
    }

    /// LOOP-10, once per pass: the start-up checks (first pass: each failure opens its
    /// fault, logged; a kind that passed closes unless held); faults no mission holds
    /// rechecked when due (pass → closed); then the `env_blocked` episode started (its
    /// message) or ended.
    fn faults(&mut self, tick: Tick) -> Result<(), String> {
        let now = tick.unix();
        if !self.preflighted {
            self.preflighted = true;
            let results = env::preflight(&self.config, &self.exes, &mut self.identity);
            for (fault, e) in self.db.tx(|tx| env::record(tx, &results, now))? {
                crate::tlog!("towercab: preflight: {fault}: {e}");
            }
        }
        let held = env::held(self.db.conn())?;
        for row in env::faults(self.db.conn())? {
            if row.next_try > now || held.contains(&row.kind) {
                continue;
            }
            let Ok(fault) = row.kind.parse::<Fault>() else {
                env::close(self.db.conn(), &row.kind)?;
                continue;
            };
            match env::check(&fault, &self.config, &self.exes, &mut self.identity) {
                Ok(()) => {
                    env::close(self.db.conn(), &row.kind)?;
                    crate::tlog!("towercab: {fault}: ok again");
                }
                Err(e) => {
                    env::open(self.db.conn(), &fault, &e, now)?;
                }
            }
        }
        let blocked = self.db.tx(|tx| env::episode(tx, now))?;
        if blocked != self.blocked {
            crate::tlog!(
                "towercab: {}",
                if blocked {
                    "env blocked"
                } else {
                    "env unblocked"
                }
            );
        }
        self.blocked = blocked;
        Ok(())
    }

    /// LOOP-17: nothing runnable and no mission driven but by a limit wait.
    fn idle(&self, tick: Tick, decision: Option<&Decision>) -> Result<bool, String> {
        if decision.is_some_and(|d| d.pick.is_some())
            || self.drafter.is_some()
            || self.evaluator.is_some()
        {
            return Ok(false);
        }
        Ok(mission::unfinished(self.db.conn())?.iter().all(|m| {
            m.step != ENTER && (!m.stage.driven() || m.held || self.limit_waiting(m, tick.unix()))
        }))
    }

    /// Passes every `opts.pass` until SIGTERM or SIGINT (a second one exits at once, uncleanly),
    /// or, without `--watch`, until a pass finds nothing to do; then [`Loop::shutdown`].
    /// A failed pass is logged to stderr and the loop goes on (`--watch`) or exits with it.
    pub fn run(mut self) -> Result<(), String> {
        if let Some(q) = self.opts.intent.clone() {
            // Without every handler it can't be picked (an existing mission is stepped).
            let target = self.set_target(&q).and_then(|id| {
                if self.target_mission.is_none() && !self.handlers.built() {
                    Err(format!("{id}: not picked: picks off: pipeline not built"))
                } else {
                    Ok(())
                }
            });
            if let Err(e) = target {
                self.shutdown()?;
                return Err(e);
            }
        }
        let mut wake = self.signals().map_err(|e| format!("signals: {e}"))?;
        // The web UI (UI-1): the service's own, on its own threads; stopped when this returns.
        let _ui = (self.opts.watch && self.config.ui.port != 0)
            .then(|| crate::ui::Running::start(&self.config, &self.home, &self.exes))
            .flatten();
        let mut next = Instant::now();
        loop {
            match self.pass(Tick::now()) {
                Ok(r) if r.stop => break,
                Ok(PassReport {
                    target: Some(end), ..
                }) => {
                    self.shutdown()?;
                    let line = end?;
                    println!("{line}");
                    return Ok(());
                }
                Ok(r) if r.idle && !self.opts.watch && self.target.is_none() => break,
                Ok(_) => {}
                Err(e) if self.opts.watch => crate::tlog!("towercab: {e}"),
                Err(e) => {
                    self.shutdown()?;
                    return Err(e);
                }
            }
            next += self.opts.pass;
            let now = Instant::now();
            if next < now {
                next = now;
            }
            self.sleep_until(&mut wake, next);
        }
        self.shutdown()
    }

    /// SIGTERM and SIGINT (which set the stop flag since `open`) write to the returned
    /// socket, which wakes [`Loop::sleep_until`].
    fn signals(&self) -> std::io::Result<UnixStream> {
        use signal_hook::low_level::pipe;
        let (read, write) = UnixStream::pair()?;
        for sig in [SIGTERM, SIGINT] {
            pipe::register(sig, write.try_clone()?)?;
        }
        Ok(read)
    }

    /// Blocks until `until` or a signal, without waking in between.
    fn sleep_until(&self, wake: &mut UnixStream, until: Instant) {
        let mut buf = [0u8; 64];
        while !self.stop.load(Ordering::SeqCst) {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            if wake.set_read_timeout(Some(left)).is_err() {
                std::thread::sleep(left);
                return;
            }
            if let Ok(0) = wake.read(&mut buf) {
                // Every write end closed: no more wake-ups, just sleep.
                std::thread::sleep(left.min(Duration::from_millis(200)));
            }
        }
    }

    /// A clean exit (LOOP-7): SIGTERM to each child's group, SIGKILL after `kill_after`,
    /// `interrupted` for its mission (not counted); `meta.running` removed. Dropping a `Loop`
    /// without it is a crash.
    pub fn shutdown(&mut self) -> Result<(), String> {
        let tick = Tick::now();
        let mut stopping: Vec<(Option<i64>, Child)> = std::mem::take(&mut self.children)
            .into_iter()
            .map(|(id, c)| (Some(id), c))
            .collect();
        stopping.extend(self.dying.drain(..).map(|c| (None, c)));
        let drafter = self.drafter.take().map(|(key, c)| {
            stopping.push((None, c));
            key
        });
        if let Some((_, c)) = self.evaluator.take() {
            // A PR's eval runs again at the next poll (its head has no status yet).
            stopping.push((None, c));
        }
        for (_, c) in stopping.iter_mut() {
            child::term_group(c.pid);
        }
        let end = Instant::now() + self.opts.kill_after;
        while Instant::now() < end
            && stopping
                .iter_mut()
                .any(|(_, c)| matches!(c.proc.try_wait(), Ok(None)))
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        for (_, c) in stopping.iter_mut() {
            child::kill_group(c.pid);
            let _ = c.proc.wait();
        }
        // Its run time counts toward the step's timeout (LOOP-9): the resumed run gets the
        // rest. (Tests drive the passes' clock: the later of it and now.)
        let mono = self.last_tick.map_or(tick.mono, |t| t.mono.max(tick.mono));
        let interrupted = (|| {
            for (id, c) in stopping.iter().filter_map(|(id, c)| Some(((*id)?, c))) {
                let m = mission::get(self.db.conn(), id)?;
                let ran = mono.saturating_sub(c.since).as_secs_f64();
                let o = Outcome::event(Event::Interrupted).with("step_secs", m.step_secs + ran);
                machine::apply(&self.apply_cx(tick), &m, &o)?;
            }
            machine::set_dying(self.db.conn(), &[])
        })();
        if let Err(e) = interrupted {
            // The transitions committed before it still send theirs.
            self.metrics.flush(tick);
            return Err(e);
        }
        if let Some(key) = drafter {
            // Stopped, not failed: the try isn't counted.
            if let Some(Err(e)) = self.with_cx(tick, |cx| drafts::not_run(cx, &key)) {
                crate::tlog!("towercab: draft {key}: {e}");
            }
        }
        self.queued.clear();
        self.inhibitor.stop();
        self.metrics.flush(tick);
        self.db.del_meta("running")
    }
}

/// `<stage>[ · <waiting>]`.
fn stage_line_rest(m: &Mission) -> String {
    match &m.waiting {
        Some(w) => format!("{} · {w}", m.stage),
        None => m.stage.to_string(),
    }
}

/// `<id>: <stage>[ · <waiting>]`.
fn stage_line(id: &str, m: &Mission) -> String {
    format!("{id}: {}", stage_line_rest(m))
}
