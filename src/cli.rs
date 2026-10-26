//! Command line (LOOP-15): every command.

use std::ffi::{OsStr, OsString};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Parser, Subcommand};

use crate::commands::{self, Cmd, QUEUED};
use crate::config::Config;
use crate::db::Db;
use crate::doctor::doctor;
use crate::exes::Exes;
use crate::handler::Handlers;
use crate::home::Home;
use crate::intents::intent::is_repo;
use crate::intents::migrate::migrate;
use crate::intents::store::now;
use crate::intents::{Listing, NewIntent, Store};
use crate::metrics::Sink;
use crate::pick;
use crate::pipeline::evals;
use crate::repo::protect::{Target, protect};
use crate::runloop::{Loop, LoopOpts, Tick};
use crate::service;
use crate::status::{self, Snapshot};

#[derive(Parser, Debug)]
#[command(name = "towercab", version, about = "Majid's software factory")]
struct Args {
    /// Config file (default: $TOWERCAB_CONFIG, else ~/.config/towercab/config.toml)
    #[arg(long, global = true, value_name = "FILE")]
    config: Option<PathBuf>,
    /// The loop's home (default: $TOWERCAB_HOME, else ~/.local/share/towercab)
    #[arg(long, global = true, value_name = "DIR")]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Write a thin intent to `main` of the intent home: add "<repo>: <title>" [uN iN aN]
    Add {
        /// "<repo>: <title>"
        intent: String,
        /// Scores: uN, iN, aN with N 1-5
        scores: Vec<String>,
    },
    /// Convert the old TODO.md line format into intent folders (once)
    Migrate,
    /// Walk parked and stale intents: keep, rescore or drop each
    Review,
    /// Create or update the `towercab` ruleset on a repo's base branch, with your gh login
    Protect {
        /// A [repos] name, or `intents` for the intent home
        repo: String,
    },
    /// Install the systemd user service and start it
    Up,
    /// Stop and disable the service (missions stay)
    Down,
    /// Follow the service's log
    Logs,
    /// Run the loop: a pass every 5 s until nothing is runnable
    Run {
        /// Keep running until SIGTERM or SIGINT
        #[arg(long)]
        watch: bool,
        /// Step only this intent's mission
        #[arg(long, value_name = "ID")]
        intent: Option<String>,
    },
    /// Go on with an intent waiting on you
    Approve { id: String },
    /// Answer an intent waiting on you, and go on (the worker gets the answer)
    Answer {
        id: String,
        #[arg(required = true, num_args = 1..)]
        text: Vec<String>,
    },
    /// Let an intent's worker change protected paths (globs), and go on if it waits
    Unlock {
        id: String,
        #[arg(required = true, num_args = 1..)]
        globs: Vec<String>,
    },
    /// Let an intent's worker reach network domains (e.g. registry.npmjs.org), and go on if it waits
    Allow {
        id: String,
        #[arg(required = true, num_args = 1..)]
        domains: Vec<String>,
    },
    /// Drop an intent: its mission stops, its folder moves to done/
    Drop { id: String },
    /// Start an intent over as a new attempt
    Retry {
        #[arg(long, required = true)]
        fresh: bool,
        id: String,
    },
    /// Authorize an intent's release
    Release { id: String },
    /// No picks; merges and reverts hold
    Pause,
    /// Undo pause
    Resume,
    /// Lift a repo's autonomy cap and freeze
    Trust { repo: String },
    /// What runs, what waits on you, what's next
    Status,
    /// The intent the loop would pick next, and why the others wait
    Next,
    /// One step of an intent's mission in the foreground
    Step { id: String },
    /// Your Claude Code sessions' telemetry to the metrics endpoint (MET-12)
    Telemetry {
        #[arg(value_parser = ["on", "off", "status"])]
        what: String,
    },
    /// Run the evals (PIP-33): a baseline with this binary, a Towercab PR's build, or the
    /// cases in a directory (the PR build's inner run)
    Eval {
        /// What changed (a drop of 10 points or more sends a message)
        #[arg(long, conflicts_with_all = ["pr", "cases"])]
        reason: Option<String>,
        /// Build this Towercab PR's head, run the cases with it, post towercab/evals
        #[arg(long, conflicts_with = "cases")]
        pr: Option<u64>,
        /// Run only the cases in this directory (with --out)
        #[arg(long, requires = "out", value_name = "DIR")]
        cases: Option<PathBuf>,
        /// Where the run's result.json goes (with --cases)
        #[arg(long, requires = "cases", value_name = "FILE")]
        out: Option<PathBuf>,
    },
    /// Hooks Claude Code runs inside Towercab's workers
    #[command(hide = true)]
    Hook {
        #[command(subcommand)]
        hook: Hook,
    },
    /// Check the config, programs, GitHub App, rulesets and Telegram
    Doctor,
    /// Open the web UI (served by the running loop; else here, read-only)
    Ui {
        /// Print the URL only
        #[arg(long)]
        no_open: bool,
    },
}

#[derive(Subcommand, Debug)]
enum Hook {
    /// The worker's PreToolUse guard (PIP-29): the hook input on stdin, exit 2 blocks
    Guard {
        /// `<runs>/guard.json`
        rules: PathBuf,
    },
    /// The verifier's child (PIP-32): starts the app, waits for its url, runs Claude, kills the
    /// app; the app never answered → `<log>.nostart`, exit 3
    Verifier {
        /// The app's `{argv, env}` (JSON)
        #[arg(long)]
        app: String,
        #[arg(long)]
        url: String,
        /// The app's output
        #[arg(long)]
        log: PathBuf,
        /// The Claude run's argv
        #[arg(last = true, required = true)]
        claude: Vec<OsString>,
    },
}

/// Exit code: 0 ok, 1 error, 2 bad arguments.
pub fn run<I, T>(args: I) -> i32
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let args = match Args::try_parse_from(args) {
        Ok(a) => a,
        Err(e) => {
            let _ = e.print();
            return e.exit_code();
        }
    };
    match args.command {
        Command::Add { intent, scores } => {
            let new = match parse_add(&intent, &scores) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("towercab: {e}");
                    return 2;
                }
            };
            report(store(&args.config).and_then(|s| {
                let i = s.add(new).map_err(|e| e.to_string())?;
                Ok(format!("{} {}/intent.md", i.id, i.dir))
            }))
        }
        Command::Migrate => {
            report(store(&args.config).and_then(|s| migrate(&s, now()).map_err(|e| e.to_string())))
        }
        Command::Review => {
            let walk = store(&args.config).and_then(|s| {
                let (stdin, stdout) = (std::io::stdin(), std::io::stdout());
                crate::review::run(&s, &mut stdin.lock(), &mut stdout.lock(), now())
            });
            match walk {
                Ok(_) => 0,
                Err(e) => {
                    eprintln!("towercab: {e}");
                    1
                }
            }
        }
        Command::Protect { repo } => report(
            Config::load(args.config.as_deref())
                .and_then(|c| Target::resolve(&c, &repo))
                .and_then(|t| protect(&t, OsStr::new("gh"))),
        ),
        Command::Up => {
            report(loop_config(&args.config).and_then(|_| service::up(&Exes::default())))
        }
        Command::Down => report(
            Config::load(args.config.as_deref()).and_then(|_| service::down(&Exes::default())),
        ),
        Command::Logs => report(
            Config::load(args.config.as_deref())
                .and_then(|_| service::logs(&Exes::default()).map(|never| match never {})),
        ),
        Command::Run { watch, intent } => {
            let run = loop_config(&args.config).and_then(|config| {
                let home = Home::resolve(args.home.as_deref())?;
                let opts = LoopOpts {
                    watch,
                    intent,
                    ..LoopOpts::default()
                };
                Loop::open(config, home, Handlers::production(), Exes::default(), opts)?.run()
            });
            match run {
                Ok(()) => 0,
                Err(e) => {
                    crate::tlog!("towercab: {e}");
                    1
                }
            }
        }
        Command::Approve { id } => command(&args.config, &args.home, Cmd::Approve(id)),
        Command::Answer { id, text } => {
            command(&args.config, &args.home, Cmd::Answer(id, text.join(" ")))
        }
        Command::Unlock { id, globs } => command(&args.config, &args.home, Cmd::Unlock(id, globs)),
        Command::Allow { id, domains } => {
            command(&args.config, &args.home, Cmd::Allow(id, domains))
        }
        Command::Drop { id } => command(&args.config, &args.home, Cmd::Drop(id)),
        Command::Retry { fresh: _, id } => command(&args.config, &args.home, Cmd::RetryFresh(id)),
        Command::Release { id } => command(&args.config, &args.home, Cmd::Release(id)),
        Command::Pause => command(&args.config, &args.home, Cmd::Pause),
        Command::Resume => command(&args.config, &args.home, Cmd::Resume),
        Command::Trust { repo } => command(&args.config, &args.home, Cmd::Trust(repo)),
        Command::Status => report(status_cmd(&args.config, &args.home)),
        Command::Next => report(next_cmd(&args.config, &args.home)),
        Command::Step { id } => report(loop_config(&args.config).and_then(|config| {
            let home = Home::resolve(args.home.as_deref())?;
            let mut lp = Loop::open(
                config,
                home,
                Handlers::production(),
                Exes::default(),
                LoopOpts::default(),
            )?;
            let out = lp.step_intent(&id);
            lp.shutdown()?;
            out
        })),
        Command::Telemetry { what } => {
            // My own sessions: no Towercab config needed (the default endpoint).
            let endpoint = Config::load(args.config.as_deref())
                .map(|c| c.metrics.endpoint)
                .unwrap_or_else(|_| crate::config::MetricsConfig::default().endpoint);
            report(crate::telemetry::run(&what, &endpoint))
        }
        Command::Eval {
            reason,
            pr,
            cases,
            out,
        } => report(Config::load(args.config.as_deref()).and_then(|config| {
            let home = Home::resolve(args.home.as_deref())?;
            let exes = Exes::default();
            let out = match (pr, cases, out) {
                // It posts statuses: as the App only (LOOP-19).
                (Some(n), _, _) => config
                    .check_loop()
                    .and_then(|()| evals::pr(&config, &home, &exes, n)),
                (None, Some(dir), Some(out)) => evals::inner(&config, &exes, &dir, &out),
                _ => evals::baseline(&config, &home, &exes, reason.as_deref()),
            };
            // The runs' cost and the pass rate (MET-13, MET-16, MET-25).
            Sink::new(&config, &home).flush(Tick::now());
            out
        })),
        Command::Hook {
            hook: Hook::Guard { rules },
        } => fail_closed(move || guard(&rules)),
        Command::Hook {
            hook:
                Hook::Verifier {
                    app,
                    url,
                    log,
                    claude,
                },
        } => crate::pipeline::verifier::hook(&app, &url, &log, &claude),
        Command::Ui { no_open } => report(ui_cmd(&args.config, &args.home, no_open)),
        Command::Doctor => match loop_config(&args.config) {
            Err(e) => {
                println!("{e}");
                1
            }
            Ok(config) => report(
                Home::resolve(args.home.as_deref())
                    .map(|home| doctor(&config, &home, &Exes::default())),
            ),
        },
    }
}

/// `towercab hook guard <rules>` (PIP-29): stdin → `guard::hook`; allowed → exit 0, blocked →
/// the reason on stderr, exit 2 (also when stdin or the rules can't be read: fail closed).
/// `f`'s exit code, a panic in it → 2 (`guard: panicked: blocked`): Claude Code takes any exit
/// but 2 from a hook as a non-blocking error, so a panicking guard would let the write through.
pub fn fail_closed(f: impl FnOnce() -> i32 + std::panic::UnwindSafe) -> i32 {
    std::panic::catch_unwind(f).unwrap_or_else(|_| {
        eprintln!("guard: panicked: blocked");
        2
    })
}

fn guard(rules: &Path) -> i32 {
    let mut stdin = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut stdin) {
        eprintln!("guard: stdin: {e}: blocked");
        return 2;
    }
    match crate::pipeline::guard::hook(&stdin, rules) {
        Ok(()) => 0,
        Err(why) => {
            eprintln!("{why}");
            2
        }
    }
}

/// The intents for `status` and `next`: pulled; a failed pull → the checkout as it is, and
/// the error.
fn intents(config: &Config) -> (Option<Listing>, Option<String>) {
    match Store::open(config) {
        Err(e) => (None, Some(e.to_string())),
        Ok(s) => match s.list() {
            Ok(l) => (Some(l), None),
            Err(e) => (Some(s.scan()), Some(e.to_string())),
        },
    }
}

/// `towercab ui` (UI-2): the loop's page if it answers, else served here read-only until
/// SIGTERM or SIGINT.
fn ui_cmd(
    config: &Option<PathBuf>,
    home: &Option<PathBuf>,
    no_open: bool,
) -> Result<String, String> {
    let config = Config::load(config.as_deref())?;
    let port = config.ui.port;
    if port == 0 {
        return Err("ui is off: [ui] port = 0".into());
    }
    let exes = Exes::default();
    let url = crate::ui::url(port);
    let open = |url: &str| {
        if !no_open {
            let _ = std::process::Command::new(&exes.xdg_open)
                .arg(url)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    };
    if crate::ui::answers(port) {
        open(&url);
        return Ok(url);
    }
    let home = Home::resolve(home.as_deref())?;
    let ctx = std::sync::Arc::new(crate::ui::Ctx::new(config, home, exes.clone(), false));
    let server = crate::ui::serve(ctx, port).map_err(|e| format!("ui: {e}"))?;
    println!("{url} (towercab isn't running: read-only; Ctrl-C to stop)");
    open(&url);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(sig, stop.clone()).map_err(|e| e.to_string())?;
    }
    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(200));
    }
    server.stop();
    Ok(String::new())
}

/// `towercab status` (LOOP-13): SQLite and the intents; works without a running loop.
fn status_cmd(config: &Option<PathBuf>, home: &Option<PathBuf>) -> Result<String, String> {
    let config = Config::load(config.as_deref())?;
    let home = Home::resolve(home.as_deref())?;
    let db = Db::open(&home.db())?;
    let (listing, error) = intents(&config);
    let snapshot = Snapshot::read(
        &db,
        listing.as_ref(),
        error.as_deref(),
        &config,
        home.holder(),
        Handlers::production().built(),
        Tick::now(),
    )?;
    Ok(status::render(&snapshot))
}

/// `towercab next` (loop.md **Next**): what `run` would pick.
fn next_cmd(config: &Option<PathBuf>, home: &Option<PathBuf>) -> Result<String, String> {
    let config = Config::load(config.as_deref())?;
    let home = Home::resolve(home.as_deref())?;
    let db = Db::open(&home.db())?;
    let (listing, error) = intents(&config);
    let listing = match (listing, error) {
        (Some(l), _) => l,
        (None, e) => return Err(format!("intents: {}", e.unwrap_or_default())),
    };
    let state = pick::state(&db, &config, Handlers::production().built(), Tick::now())?;
    let d = pick::decide(&listing, &state);
    Ok(status::next_text(&d, &listing, config.intents.cutoff))
}

/// The config of a loop command (`run`, `step`, `up`, `doctor`): loaded and
/// [`Config::check_loop`]ed.
fn loop_config(config: &Option<PathBuf>) -> Result<Config, String> {
    let config = Config::load(config.as_deref())?;
    config.check_loop()?;
    Ok(config)
}

/// A `commands` row from the CLI (LOOP-15): applied here when no loop holds the home, else
/// the loop's reply within 10 s, else `queued: …`. An error reply exits 1.
fn command(config: &Option<PathBuf>, home: &Option<PathBuf>, cmd: Cmd) -> i32 {
    let submitted = Config::load(config.as_deref()).and_then(|config| {
        let home = Home::resolve(home.as_deref())?;
        let db = Db::open(&home.db())?;
        let reply = commands::submit(&config, &home, &db, &cmd, Duration::from_secs(10));
        // Applied here: its transitions' metrics (MET-13).
        Sink::new(&config, &home).flush(Tick::now());
        reply
    });
    match submitted {
        Ok(Some(reply)) if cmd.failed(&reply) => {
            eprintln!("towercab: {reply}");
            1
        }
        Ok(reply) => {
            println!("{}", reply.as_deref().unwrap_or(QUEUED));
            0
        }
        Err(e) => {
            eprintln!("towercab: {e}");
            1
        }
    }
}

fn store(config: &Option<PathBuf>) -> Result<Store, String> {
    let config = Config::load(config.as_deref())?;
    Store::open(&config).map_err(|e| e.to_string())
}

fn report(result: Result<String, String>) -> i32 {
    match result {
        Ok(out) => {
            println!("{out}");
            0
        }
        Err(e) => {
            eprintln!("towercab: {e}");
            1
        }
    }
}

/// `"<repo>: <title>"` and `uN iN aN` (each at most once) → a `NewIntent` from me, now.
pub fn parse_add(intent: &str, scores: &[String]) -> Result<NewIntent, String> {
    let usage = || format!("want \"<repo>: <title>\", got {intent:?}");
    let (repo, title) = intent.split_once(':').ok_or_else(usage)?;
    let (repo, title) = (repo.trim(), title.trim());
    if !is_repo(repo) || title.is_empty() || title.contains(['\n', '\r']) {
        return Err(usage());
    }
    let scores = crate::priority::parse_scores(scores)?;
    Ok(NewIntent {
        repo: repo.to_string(),
        title: title.to_string(),
        u: scores.u,
        i: scores.i,
        a: scores.a,
        source: "me".into(),
        created: now(),
    })
}
