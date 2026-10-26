//! `intent.md`: front matter read with `yaml-rust2`, edited by line (INT-2, INT-5, INT-10).
//!
//! The file is kept as raw segments, one per top-level key (plus standalone blank and `#`
//! lines), so rendering an untouched intent gives back the same bytes and a write replaces
//! only the lines of the key that changed.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset};
use regex::Regex;
use yaml_rust2::{Yaml, YamlLoader};

use super::id::is_id;

static KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]|$)").unwrap());

/// A repo name: `[A-Za-z0-9._-]+`, not starting with `-`, not `.` or `..` (safe as a path
/// part and as a `git`/`gh` argument). Used by `Intent::parse`, `towercab add` and `migrate`.
pub fn is_repo(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A front matter value as Towercab reads and writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<String>),
}

/// Playbook stages written to `stage:` (INT-5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Stage {
    Design,
    Build,
    Test,
    Deploy,
    Maintain,
    Done,
    Dropped,
}

impl Stage {
    pub const ALL: [Stage; 7] = [
        Stage::Design,
        Stage::Build,
        Stage::Test,
        Stage::Deploy,
        Stage::Maintain,
        Stage::Done,
        Stage::Dropped,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Design => "design",
            Stage::Build => "build",
            Stage::Test => "test",
            Stage::Deploy => "deploy",
            Stage::Maintain => "maintain",
            Stage::Done => "done",
            Stage::Dropped => "dropped",
        }
    }

    /// `done` or `dropped`.
    pub fn is_finished(self) -> bool {
        matches!(self, Stage::Done | Stage::Dropped)
    }
}

impl FromStr for Stage {
    type Err = String;
    fn from_str(s: &str) -> Result<Stage, String> {
        Stage::ALL
            .into_iter()
            .find(|st| st.as_str() == s)
            .ok_or_else(|| format!("stage must be {}", describe(Kind::Stage)))
    }
}

impl fmt::Display for Stage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Repo,
    Score,
    Str,
    After,
    List,
    Time,
    Stage,
    Float,
    Seconds,
    Count,
}

/// The fields Towercab knows (INT-2, INT-5); any other key is kept verbatim.
fn kind(key: &str) -> Option<Kind> {
    Some(match key {
        "repo" => Kind::Repo,
        "u" | "i" | "a" => Kind::Score,
        "model" | "review" | "source" | "waiting" | "pr" | "retry" | "lower_why" => Kind::Str,
        "after" => Kind::After,
        "unlock" | "network" => Kind::List,
        "started" | "finished" | "reviewed" => Kind::Time,
        "stage" => Kind::Stage,
        "cost" => Kind::Float,
        "agent_time" => Kind::Seconds,
        "attempts" => Kind::Count,
        _ => return None,
    })
}

/// The kind of a Towercab field; any other key can't be written (INT-2: kept verbatim).
fn known(key: &str) -> Result<Kind, String> {
    kind(key).ok_or_else(|| format!("{key} is not a Towercab field"))
}

/// What a known field must be, for the error message.
fn describe(kind: Kind) -> String {
    match kind {
        Kind::Repo => "a repo name ([A-Za-z0-9._-], no leading -, not . or ..)".into(),
        Kind::Score => "an integer 1-5".into(),
        Kind::Str => "a string".into(),
        Kind::After => "a list of ids".into(),
        Kind::List => "a list of strings".into(),
        Kind::Time => "an RFC 3339 time with offset".into(),
        Kind::Stage => {
            let names: Vec<&str> = Stage::ALL.iter().map(|s| s.as_str()).collect();
            format!("one of {}", names.join(", "))
        }
        Kind::Float => "a number".into(),
        Kind::Seconds => "an integer >= 0 (seconds)".into(),
        Kind::Count => "an integer >= 1".into(),
    }
}

/// Type-checks a known field; the same rules for parse and `set`.
fn check(key: &str, kind: Kind, value: Value) -> Result<Value, String> {
    let ok = match (kind, value) {
        (Kind::Repo, Value::Str(s)) if is_repo(&s) => Value::Str(s),
        (Kind::Score, Value::Int(n)) if (1..=5).contains(&n) => Value::Int(n),
        (Kind::Str, Value::Str(s)) => Value::Str(s),
        // A single id counts as a one-item list (only for `after`).
        (Kind::After, Value::Str(s)) if is_id(&s) => Value::List(vec![s]),
        (Kind::After, Value::List(l)) if l.iter().all(|s| is_id(s)) => Value::List(l),
        (Kind::List, Value::List(l)) => Value::List(l),
        (Kind::Time, Value::Str(s)) if DateTime::parse_from_rfc3339(&s).is_ok() => Value::Str(s),
        (Kind::Stage, Value::Str(s)) if s.parse::<Stage>().is_ok() => Value::Str(s),
        (Kind::Float, Value::Float(f)) if f.is_finite() => Value::Float(f),
        (Kind::Float, Value::Int(n)) => Value::Float(n as f64),
        (Kind::Seconds, Value::Int(n)) if n >= 0 => Value::Int(n),
        (Kind::Count, Value::Int(n)) if (1..=i64::from(u32::MAX)).contains(&n) => Value::Int(n),
        _ => return Err(format!("{key} must be {}", describe(kind))),
    };
    Ok(ok)
}

/// A YAML node as a `Value`, if it is one of the shapes Towercab writes.
fn from_yaml(y: &Yaml) -> Option<Value> {
    match y {
        Yaml::Integer(n) => Some(Value::Int(*n)),
        Yaml::Real(s) => s.parse().ok().map(Value::Float),
        Yaml::String(s) => Some(Value::Str(s.clone())),
        Yaml::Array(items) => items
            .iter()
            .map(|i| match i {
                Yaml::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .map(Value::List),
        _ => None,
    }
}

/// One top-level key's lines, or a standalone blank / `#` line.
#[derive(Debug, Clone, PartialEq)]
struct Segment {
    key: Option<String>,
    text: String,
}

/// A parsed `intent.md`. `id`, `slug` and `dir` are filled in by the store.
#[derive(Debug, Clone, PartialEq)]
pub struct Intent {
    pub id: String,
    pub slug: String,
    /// `intents/<id>-<slug>` or `done/<id>-<slug>`.
    pub dir: String,
    open: String,
    segments: Vec<Segment>,
    close: String,
    body: String,
    values: BTreeMap<String, Value>,
    title: String,
}

fn eol_stripped(line: &str) -> &str {
    line.trim_end_matches('\n').trim_end_matches('\r')
}

impl Intent {
    /// Parses an `intent.md`; the error is the reason shown under "Can't read" (INT-11).
    pub fn parse(text: &str) -> Result<Intent, String> {
        let mut lines = text.split_inclusive('\n');
        // A UTF-8 BOM before the first `---` (some editors add one) is kept in `open`.
        let open = match lines.next() {
            Some(l) if eol_stripped(l.trim_start_matches('\u{feff}')) == "---" => l.to_string(),
            _ => return Err("no front matter: the first line must be ---".into()),
        };
        let mut consumed = open.len();
        let mut segments: Vec<Segment> = Vec::new();
        let mut close = None;
        for (n, line) in lines.enumerate() {
            let line_no = n + 2;
            consumed += line.len();
            let l = eol_stripped(line);
            if l == "---" {
                close = Some(line.to_string());
                break;
            }
            if l.trim().is_empty() || l.starts_with('#') {
                segments.push(Segment {
                    key: None,
                    text: line.to_string(),
                });
            } else if l.starts_with([' ', '\t']) || l == "-" || l.starts_with("- ") {
                // A continuation; blank or comment lines between it and its key join the key.
                let Some(owner) = segments.iter().rposition(|s| s.key.is_some()) else {
                    return Err(format!("front matter line {line_no}: no key before it"));
                };
                let joined: String = segments.drain(owner + 1..).map(|s| s.text).collect();
                let seg = &mut segments[owner];
                seg.text.push_str(&joined);
                seg.text.push_str(line);
            } else if let Some(c) = KEY.captures(l) {
                let key = c[1].to_string();
                if segments.iter().any(|s| s.key.as_deref() == Some(&key)) {
                    return Err(format!("duplicate key {key}"));
                }
                segments.push(Segment {
                    key: Some(key),
                    text: line.to_string(),
                });
            } else {
                return Err(format!(
                    "front matter line {line_no}: not a `key:` line at column 0"
                ));
            }
        }
        let Some(close) = close else {
            return Err("front matter has no closing ---".into());
        };
        let body = text[consumed..].to_string();
        let mut intent = Intent {
            id: String::new(),
            slug: String::new(),
            dir: String::new(),
            open,
            segments,
            close,
            body,
            values: BTreeMap::new(),
            title: String::new(),
        };
        intent.read_values()?;
        intent.title = title_of(&intent.body).ok_or("no title: the body needs a `# ` line")?;
        Ok(intent)
    }

    fn front_matter(&self) -> String {
        self.segments.iter().map(|s| s.text.as_str()).collect()
    }

    fn read_values(&mut self) -> Result<(), String> {
        let docs = YamlLoader::load_from_str(&self.front_matter())
            .map_err(|e| format!("front matter: {e}"))?;
        let map = match docs.first() {
            None | Some(Yaml::Null) => Default::default(),
            Some(Yaml::Hash(h)) => h.clone(),
            Some(_) => return Err("front matter is not a mapping".into()),
        };
        let mut values = BTreeMap::new();
        for key in self.segments.iter().filter_map(|s| s.key.as_deref()) {
            let Some(k) = kind(key) else { continue };
            let y = map
                .get(&Yaml::String(key.to_string()))
                .unwrap_or(&Yaml::Null);
            let v = from_yaml(y).ok_or_else(|| format!("{key} must be {}", describe(k)))?;
            values.insert(key.to_string(), check(key, k, v)?);
        }
        if !values.contains_key("repo") {
            return Err("repo is missing".into());
        }
        self.values = values;
        Ok(())
    }

    /// The file's bytes: untouched segments exactly as read.
    pub fn render(&self) -> String {
        let mut out = String::with_capacity(self.body.len() + 256);
        out.push_str(&self.open);
        out.push_str(&self.front_matter());
        out.push_str(&self.close);
        out.push_str(&self.body);
        out
    }

    /// Sets a Towercab field (INT-2, INT-5): same type checks as parse; the key's lines become
    /// one `key: value` line in place (with the file's line ending), a new key goes last. An
    /// unchanged value leaves the file untouched; any other key is refused, never rewritten.
    pub fn set(&mut self, key: &str, value: Value) -> Result<(), String> {
        let value = check(key, known(key)?, value)?;
        if self.values.get(key) == Some(&value) {
            return Ok(());
        }
        let eol = if self.open.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let line = format!("{key}: {}{eol}", format_value(&value));
        let mut next = self.clone();
        match next
            .segments
            .iter_mut()
            .find(|s| s.key.as_deref() == Some(key))
        {
            Some(seg) => seg.text = line,
            None => next.segments.push(Segment {
                key: Some(key.to_string()),
                text: line,
            }),
        }
        next.read_values()?;
        *self = next;
        Ok(())
    }

    /// Removes a Towercab field's lines; absent → nothing changes; any other key is refused.
    pub fn remove(&mut self, key: &str) -> Result<(), String> {
        known(key)?;
        let mut next = self.clone();
        next.segments.retain(|s| s.key.as_deref() != Some(key));
        if next.segments.len() == self.segments.len() {
            return Ok(());
        }
        next.read_values()?;
        *self = next;
        Ok(())
    }

    /// Replaces the body section `## <title>` with `text` (pipeline.md **Notes**): the old one
    /// (its heading up to the next `# `/`## ` line, with the blank line before it) removed, the
    /// new one appended last; empty `text` → only removed. Other lines stay byte-identical; a
    /// line of `text` starting with `#` is escaped (`\#`) so it can't end the section.
    pub fn set_section(&mut self, title: &str, text: &str) -> Result<(), String> {
        let eol = if self.open.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let heading = format!("## {title}");
        let body = self.body.clone();
        let mut start = None;
        let mut end = body.len();
        let mut pos = 0;
        let mut fence: Option<char> = None;
        for line in body.split_inclusive('\n') {
            let l = eol_stripped(line);
            let t = l.trim_start();
            if let Some(c) = t.chars().next().filter(|c| matches!(c, '`' | '~'))
                && t.starts_with(&c.to_string().repeat(3))
            {
                fence = match fence {
                    Some(f) if f == c => None,
                    None => Some(c),
                    other => other,
                };
            } else if fence.is_none() {
                if start.is_none() && l.trim_end() == heading {
                    start = Some(pos);
                } else if start.is_some() && (l.starts_with("# ") || l.starts_with("## ")) {
                    end = pos;
                    break;
                }
            }
            pos += line.len();
        }
        let mut next = match start {
            Some(s) => {
                let blank = format!("{eol}{eol}");
                let s = if body[..s].ends_with(&blank) {
                    s - eol.len()
                } else {
                    s
                };
                format!("{}{}", &body[..s], &body[end..])
            }
            None => body,
        };
        let text = text.trim();
        if !text.is_empty() {
            if !next.is_empty() && !next.ends_with('\n') {
                next.push_str(eol);
            }
            next.push_str(eol);
            next.push_str(&heading);
            next.push_str(eol);
            next.push_str(eol);
            for line in text.lines() {
                let line = line.trim_end_matches('\r');
                if line.starts_with('#') {
                    next.push('\\');
                }
                next.push_str(line);
                next.push_str(eol);
            }
        }
        let mut changed = self.clone();
        changed.body = next;
        changed.title = title_of(&changed.body).ok_or("no title: the body needs a `# ` line")?;
        *self = changed;
        Ok(())
    }

    /// The body section `## <title>` (ASCII case-insensitive, outside fences): its lines up to
    /// the next `# `/`## ` line, as written; absent → `None`.
    pub fn section(&self, title: &str) -> Option<String> {
        use crate::repo::markdown;
        let lines = markdown::lines(&self.body);
        let items = markdown::items(&lines, 1).ok()?;
        let [found] = markdown::sections(&items, [title]).ok()?;
        found.map(markdown::text)
    }

    /// The bullets of the body section `## <title>` (none: empty).
    pub fn section_bullets(&self, title: &str) -> Vec<String> {
        use crate::repo::markdown;
        let lines = markdown::lines(&self.body);
        let Ok(items) = markdown::items(&lines, 1) else {
            return Vec::new();
        };
        match markdown::sections(&items, [title]) {
            Ok([Some(s)]) => markdown::bullets(s),
            _ => Vec::new(),
        }
    }

    /// Typed value of a known field.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    /// Whether the front matter has `key` (known or not).
    pub fn has(&self, key: &str) -> bool {
        self.segments.iter().any(|s| s.key.as_deref() == Some(key))
    }

    fn str(&self, key: &str) -> Option<&str> {
        match self.values.get(key) {
            Some(Value::Str(s)) => Some(s),
            _ => None,
        }
    }

    fn int(&self, key: &str) -> Option<i64> {
        match self.values.get(key) {
            Some(Value::Int(n)) => Some(*n),
            _ => None,
        }
    }

    fn list(&self, key: &str) -> &[String] {
        match self.values.get(key) {
            Some(Value::List(l)) => l,
            _ => &[],
        }
    }

    fn time(&self, key: &str) -> Option<DateTime<FixedOffset>> {
        self.str(key)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
    }

    pub fn title(&self) -> &str {
        &self.title
    }
    /// Everything after the closing `---`.
    pub fn body(&self) -> &str {
        &self.body
    }
    pub fn repo(&self) -> &str {
        self.str("repo").unwrap_or_default()
    }
    pub fn u(&self) -> Option<u8> {
        self.int("u").map(|n| n as u8)
    }
    pub fn i(&self) -> Option<u8> {
        self.int("i").map(|n| n as u8)
    }
    pub fn a(&self) -> Option<u8> {
        self.int("a").map(|n| n as u8)
    }
    pub fn after(&self) -> &[String] {
        self.list("after")
    }
    pub fn unlock(&self) -> &[String] {
        self.list("unlock")
    }
    /// Domains its worker runs may reach (PIP-24, `towercab allow`).
    pub fn network(&self) -> &[String] {
        self.list("network")
    }
    pub fn model(&self) -> Option<&str> {
        self.str("model")
    }
    pub fn review(&self) -> Option<&str> {
        self.str("review")
    }
    pub fn source(&self) -> Option<&str> {
        self.str("source")
    }
    pub fn started(&self) -> Option<DateTime<FixedOffset>> {
        self.time("started")
    }
    pub fn stage(&self) -> Option<Stage> {
        self.str("stage").and_then(|s| s.parse().ok())
    }
    pub fn waiting(&self) -> Option<&str> {
        self.str("waiting")
    }
    pub fn pr(&self) -> Option<&str> {
        self.str("pr")
    }
    pub fn retry(&self) -> Option<&str> {
        self.str("retry")
    }
    /// The worker's reason for a lowered `a` (AUT-7).
    pub fn lower_why(&self) -> Option<&str> {
        self.str("lower_why")
    }
    pub fn cost(&self) -> Option<f64> {
        match self.values.get("cost") {
            Some(Value::Float(f)) => Some(*f),
            _ => None,
        }
    }
    pub fn agent_time(&self) -> Option<u64> {
        self.int("agent_time").map(|n| n as u64)
    }
    pub fn attempts(&self) -> Option<u32> {
        self.int("attempts").map(|n| n as u32)
    }
    pub fn finished(&self) -> Option<DateTime<FixedOffset>> {
        self.time("finished")
    }
    /// The last backlog review (PRI-7).
    pub fn reviewed(&self) -> Option<DateTime<FixedOffset>> {
        self.time("reviewed")
    }
}

/// The first `# ` line, without an `Intent: ` prefix.
fn title_of(body: &str) -> Option<String> {
    body.lines()
        .map(|l| l.trim_end_matches('\r'))
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| {
            let t = t.trim();
            t.strip_prefix("Intent:").map_or(t, str::trim).to_string()
        })
        .filter(|t| !t.is_empty())
}

/// How a value is written: strings plain when `yaml-rust2` reads them back unchanged, else
/// double-quoted; ints in decimal; floats with 2 decimals; lists in flow style.
pub fn format_value(value: &Value) -> String {
    match value {
        Value::Int(n) => n.to_string(),
        Value::Float(f) => format!("{f:.2}"),
        Value::Str(s) => {
            if reads_back(&format!("k: {s}"), |y| y == &Yaml::String(s.clone())) {
                s.clone()
            } else {
                quote(s)
            }
        }
        Value::List(items) => {
            let items: Vec<String> = items
                .iter()
                .map(|s| {
                    let plain = reads_back(&format!("k: [{s}]"), |y| {
                        y == &Yaml::Array(vec![Yaml::String(s.clone())])
                    });
                    if plain { s.clone() } else { quote(s) }
                })
                .collect();
            format!("[{}]", items.join(", "))
        }
    }
}

fn reads_back(doc: &str, want: impl Fn(&Yaml) -> bool) -> bool {
    // Line breaks and control characters (YAML 1.2: not printable) are always quoted.
    if doc.chars().any(|c| c.is_control() && c != '\t') {
        return false;
    }
    match YamlLoader::load_from_str(doc) {
        Ok(docs) => docs.first().is_some_and(|d| want(&d["k"])),
        Err(_) => false,
    }
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // C0, DEL and C1 are all below U+0100.
            c if c.is_control() => out.push_str(&format!("\\x{:02x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
