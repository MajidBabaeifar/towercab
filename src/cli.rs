//! Command line (LOOP-15, so far `add`, `migrate`, `review`, `protect`, `up`, `down`, `logs`
//! and `--version`).

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::exes::Exes;
use crate::intents::intent::is_repo;
use crate::intents::migrate::migrate;
use crate::intents::store::now;
use crate::intents::{NewIntent, Store};
use crate::repo::protect::{Target, protect};
use crate::service;

#[derive(Parser, Debug)]
#[command(name = "towercab", version, about = "Majid's software factory")]
struct Args {
    /// Config file (default: $TOWERCAB_CONFIG, else ~/.config/towercab/config.toml)
    #[arg(long, global = true, value_name = "FILE")]
    config: Option<PathBuf>,
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
    }
}

/// The config of a loop command (`run`, `step`, `up`, `doctor`): loaded and
/// [`Config::check_loop`]ed.
fn loop_config(config: &Option<PathBuf>) -> Result<Config, String> {
    let config = Config::load(config.as_deref())?;
    config.check_loop()?;
    Ok(config)
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
