//! Command line (LOOP-15, so far `add`, `migrate` and `--version`).

use std::ffi::OsString;
use std::path::PathBuf;

use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::intents::migrate::migrate;
use crate::intents::store::now;
use crate::intents::{NewIntent, Store};

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
    let repo_ok = !repo.is_empty()
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if !repo_ok || title.is_empty() || title.contains(['\n', '\r']) {
        return Err(usage());
    }
    let mut new = NewIntent {
        repo: repo.to_string(),
        title: title.to_string(),
        u: None,
        i: None,
        a: None,
        source: "me".into(),
        created: now(),
    };
    for s in scores {
        let bad = || format!("bad score {s:?}: want uN, iN or aN with N 1-5, each once");
        let mut chars = s.chars();
        let (Some(k), Some(n), None) = (chars.next(), chars.next(), chars.next()) else {
            return Err(bad());
        };
        let n = n
            .to_digit(10)
            .filter(|n| (1..=5).contains(n))
            .ok_or_else(bad)? as u8;
        let slot = match k {
            'u' => &mut new.u,
            'i' => &mut new.i,
            'a' => &mut new.a,
            _ => return Err(bad()),
        };
        if slot.replace(n).is_some() {
            return Err(bad());
        }
    }
    Ok(new)
}
