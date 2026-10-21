//! The loop (LOOP-12, `run` of LOOP-15): one pass every 5 s, single-threaded, until SIGTERM
//! or SIGINT, or (without `--watch`) until it is idle.
//!
//! So far a pass applies `commands`; the other steps of the pass (wake check, Telegram,
//! children, polls, missions, pick, faults, outbox, inhibitor, gauges), recovery and preflight
//! come with the later parts of the loop intent, in the order LOOP-12 gives.

use std::io::Read;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use chrono::{DateTime, FixedOffset, Local};
use signal_hook::consts::{SIGINT, SIGTERM};

use crate::commands::{self, CmdCx};
use crate::config::Config;
use crate::db::Db;
use crate::exes::Exes;
use crate::handler::Handlers;
use crate::home::{Home, LoopLock};

/// The pass interval.
pub const PASS: Duration = Duration::from_secs(5);

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
}

/// Unix seconds (microsecond precision).
pub fn unix(t: DateTime<FixedOffset>) -> f64 {
    t.timestamp_micros() as f64 / 1e6
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoopOpts {
    /// Exit only on SIGTERM or SIGINT.
    pub watch: bool,
    /// Step only this intent's mission (`run --intent`).
    pub intent: Option<String>,
    /// Time between pass starts (5 s).
    pub pass: Duration,
}

impl Default for LoopOpts {
    fn default() -> LoopOpts {
        LoopOpts {
            watch: false,
            intent: None,
            pass: PASS,
        }
    }
}

/// What a pass did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PassReport {
    /// `commands` rows applied, oldest first: (id, reply).
    pub commands: Vec<(i64, String)>,
    /// Nothing runnable and no mission driven but by a limit wait: `run` without `--watch`
    /// exits.
    pub idle: bool,
    /// A SIGTERM or SIGINT had arrived: the pass did nothing.
    pub stop: bool,
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
    stop: Arc<AtomicBool>,
    _lock: LoopLock,
}

impl Loop {
    /// Takes the home's lock (another loop or `step` → `towercab is running (pid N); towercab
    /// down first`), opens the database and sets `meta.running` = `<pid> <unix s>`.
    pub fn open(
        config: Config,
        home: Home,
        handlers: Handlers,
        exes: Exes,
        opts: LoopOpts,
    ) -> Result<Loop, String> {
        let lock = home.lock()?;
        let db = Db::open(&home.db())?;
        let unclean = db.meta("running")?;
        let now = Tick::now();
        db.set_meta(
            "running",
            &format!("{} {}", std::process::id(), now.wall.timestamp()),
        )?;
        Ok(Loop {
            config,
            home,
            handlers,
            exes,
            opts,
            db,
            unclean,
            stop: Arc::new(AtomicBool::new(false)),
            _lock: lock,
        })
    }

    /// Set by SIGTERM and SIGINT once `run` started; setting it stops the loop between passes.
    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    /// One pass (LOOP-12 order): signals, then `commands`.
    pub fn pass(&mut self, tick: Tick) -> Result<PassReport, String> {
        let mut report = PassReport::default();
        if self.stop.load(Ordering::SeqCst) {
            report.stop = true;
            return Ok(report);
        }
        let cx = CmdCx {
            config: &self.config,
            db: &self.db,
            tick,
        };
        report.commands = commands::apply_pending(&cx)?;
        // No stage handler yet: nothing is runnable and no mission is driven.
        report.idle = true;
        Ok(report)
    }

    /// Passes every `opts.pass` until SIGTERM or SIGINT (a second one exits at once, uncleanly),
    /// or, without `--watch`, until a pass finds nothing to do; then [`Loop::shutdown`].
    /// A failed pass is logged to stderr and the loop goes on (`--watch`) or exits with it.
    pub fn run(mut self) -> Result<(), String> {
        if let Some(id) = self.opts.intent.clone()
            && !self.handlers.built()
        {
            self.shutdown()?;
            return Err(format!("{id}: not picked: picks off: pipeline not built"));
        }
        let mut wake = self.signals().map_err(|e| format!("signals: {e}"))?;
        let mut next = Instant::now();
        loop {
            match self.pass(Tick::now()) {
                Ok(r) if r.stop => break,
                Ok(r) if r.idle && !self.opts.watch => break,
                Ok(_) => {}
                Err(e) if self.opts.watch => eprintln!("towercab: {e}"),
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

    /// SIGTERM and SIGINT set the stop flag and write to the returned socket, which wakes
    /// [`Loop::sleep_until`].
    fn signals(&self) -> std::io::Result<UnixStream> {
        use signal_hook::{flag, low_level::pipe};
        let (read, write) = UnixStream::pair()?;
        for sig in [SIGTERM, SIGINT] {
            flag::register_conditional_shutdown(sig, 1, Arc::clone(&self.stop))?;
            flag::register(sig, Arc::clone(&self.stop))?;
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

    /// A clean exit: `meta.running` removed. Dropping a `Loop` without it is a crash.
    pub fn shutdown(&mut self) -> Result<(), String> {
        self.db.del_meta("running")
    }
}
