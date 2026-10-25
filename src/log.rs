//! The loop's log lines (LOOP-21): one line each on stderr (the journal), the full text of a
//! longer message (a child's whole stderr, gh's usage text) in `<home>/towercab.log`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The most characters a journal line keeps of a message.
pub const MAX: usize = 300;

/// `towercab.log` is moved to `towercab.log.1` past this size.
pub const ROTATE: u64 = 5 << 20;

static FILE: OnceLock<PathBuf> = OnceLock::new();

/// Sends the full text of long messages to `<home>/towercab.log` (the loop's `open`; once).
pub fn init(home: &Path) {
    let _ = FILE.set(home.join("towercab.log"));
}

/// The journal line for `msg`: its first line that says something (blank lines and gh's
/// `Usage:`/`Flags:` lines skipped), control characters as spaces, at most [`MAX`]
/// characters, `(+<n> lines)` when it had more.
pub fn line(msg: &str) -> String {
    let lines: Vec<&str> = msg
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let first = lines
        .iter()
        .find(|l| !l.starts_with("Usage:") && !l.starts_with("Flags:"))
        .or(lines.first())
        .copied()
        .unwrap_or("");
    let mut out = crate::outbox::cut(&crate::outbox::one_line(first), MAX);
    if lines.len() > 1 {
        out.push_str(&format!(" (+{} lines)", lines.len() - 1));
    }
    out
}

/// Writes `msg` (already starting `towercab: …`) as one stderr line; a message of more than
/// one line also goes whole, with the time, to `towercab.log`, and the line says so.
pub fn emit(msg: &str) {
    let mut one = line(msg);
    if msg.trim().lines().count() > 1
        && let Some(path) = FILE.get()
        && append(path, msg).is_ok()
    {
        one.push_str(&format!(" · full: {}", path.display()));
    }
    eprintln!("{one}");
}

fn append(path: &Path, msg: &str) -> std::io::Result<()> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > ROTATE) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%z");
    writeln!(f, "--- {now}\n{}", msg.trim_end())
}

/// `eprintln!` for the loop: formats, then [`emit`]s one line.
#[macro_export]
macro_rules! tlog {
    ($($arg:tt)*) => {
        $crate::log::emit(&format!($($arg)*))
    };
}
