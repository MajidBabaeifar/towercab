//! `towercab migrate` (INT-13): the old `TODO.md` line format → intent folders, once.

use std::collections::BTreeSet;
use std::fs;
use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset};
use regex::Regex;

use super::id::{self, is_id, new_id};
use super::intent::{Intent, Value, format_value, is_repo};
use super::store::{Store, StoreError, legacy_ids, read_optional};
use super::views::is_generated;

static TASK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^- \[([ ~!xX])\] (.+)$").unwrap());
static CONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^  ([a-z][a-z ]*): (.*)$").unwrap());
static SCORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([uia])([1-5])$").unwrap());
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@([\w.-]+)$").unwrap());
static REVIEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^review:([\w.-]+)$").unwrap());

/// One old task line with its `  <key>: <value>` lines.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OldTask {
    /// 1-based line in `TODO.md`.
    pub line: usize,
    /// ` `, `~`, `!` or `x`.
    pub marker: char,
    pub id: Option<String>,
    pub u: Option<u8>,
    pub i: Option<u8>,
    pub a: Option<u8>,
    pub repo: String,
    pub title: String,
    pub after: Vec<String>,
    pub model: Option<String>,
    pub review: Option<String>,
    pub fields: Vec<(String, String)>,
}

/// `- [ |~|!|x] [<id>] [uN iN aN] <repo>: <title> [after:<ids>] [@model] [review:<model>]`.
pub fn parse_line(line: &str) -> Result<OldTask, String> {
    let c = TASK
        .captures(line)
        .ok_or("not a task line: want `- [ ]`, `[~]`, `[!]` or `[x]` and a title")?;
    let mut task = OldTask {
        marker: c[1].chars().next().unwrap_or(' ').to_ascii_lowercase(),
        ..OldTask::default()
    };
    let mut tokens: Vec<&str> = c.get(2).map_or("", |m| m.as_str()).split(' ').collect();
    if tokens.first().is_some_and(|t| is_id(t)) {
        task.id = Some(tokens.remove(0).to_string());
    }
    while let Some(s) = tokens.first().and_then(|t| SCORE.captures(t)) {
        let n = s[2].parse().unwrap_or(3);
        let slot = match &s[1] {
            "u" => &mut task.u,
            "i" => &mut task.i,
            _ => &mut task.a,
        };
        if slot.replace(n).is_some() {
            return Err(format!("score {} given twice", &s[1]));
        }
        tokens.remove(0);
    }
    let repo = tokens
        .first()
        .and_then(|t| t.strip_suffix(':'))
        .filter(|r| is_repo(r))
        .ok_or("expected `<repo>:` after marker, id and scores")?;
    task.repo = repo.to_string();
    tokens.remove(0);
    while let Some(last) = tokens.last() {
        if let Some(ids) = last.strip_prefix("after:").filter(|s| !s.is_empty()) {
            let mut ids: Vec<String> = ids
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            ids.append(&mut task.after);
            task.after = ids;
        } else if let (Some(m), None) = (MODEL.captures(last), &task.model) {
            task.model = Some(m[1].to_string());
        } else if let (Some(r), None) = (REVIEW.captures(last), &task.review) {
            task.review = Some(r[1].to_string());
        } else {
            break;
        }
        tokens.pop();
    }
    task.title = tokens.join(" ").trim().to_string();
    if task.title.is_empty() {
        return Err("no title".into());
    }
    let bad: Vec<&str> = task
        .after
        .iter()
        .filter(|a| !is_id(a))
        .map(String::as_str)
        .collect();
    if !bad.is_empty() {
        return Err(format!("after: needs intent IDs, got {}", bad.join(", ")));
    }
    Ok(task)
}

/// Every task in an old `TODO.md`; errors read `TODO.md:<line>: <reason>`. Besides task lines
/// and the `  <key>: <value>` lines right under them, only blank, `#` heading and `<!--` comment
/// lines may appear: anything else is reported, so nothing is dropped when `TODO.md` is
/// regenerated. A blank line ends a task's fields.
pub fn parse_todo(text: &str) -> (Vec<OldTask>, Vec<String>) {
    let (mut tasks, mut errors): (Vec<OldTask>, Vec<String>) = (Vec::new(), Vec::new());
    let mut current: Option<usize> = None;
    for (n, line) in text.lines().enumerate() {
        let n = n + 1;
        let line = line.trim_end_matches('\r');
        if let (Some(t), Some(c)) = (current, CONT.captures(line)) {
            if let Some(task) = tasks.get_mut(t) {
                task.fields.push((c[1].to_string(), c[2].to_string()));
            }
            continue;
        }
        let indented = line.starts_with([' ', '\t']);
        if line.trim().is_empty() {
            current = None;
        } else if indented && current.is_some() {
            errors.push(format!(
                "TODO.md:{n}: indented line is not `<key>: <value>`"
            ));
        } else if indented {
            errors.push(format!("TODO.md:{n}: indented line belongs to no task"));
        } else if line.starts_with("- [") {
            current = None;
            match parse_line(line) {
                Ok(mut task) => {
                    task.line = n;
                    tasks.push(task);
                    current = Some(tasks.len() - 1);
                }
                Err(e) => errors.push(format!("TODO.md:{n}: {e}")),
            }
        } else {
            current = None;
            if !line.starts_with('#') && !line.starts_with("<!--") {
                errors.push(format!(
                    "TODO.md:{n}: not a task line, `#` heading or `<!--` comment"
                ));
            }
        }
    }
    (tasks, errors)
}

/// The `intent.md` for one old task (`notes` = its `tasks/<id>.md`, if any).
pub fn render(task: &OldTask, notes: Option<&str>) -> String {
    let s = |v: &str| format_value(&Value::Str(v.to_string()));
    let mut fm = vec![format!("repo: {}", s(&task.repo))];
    for (key, score) in [("u", task.u), ("i", task.i), ("a", task.a)] {
        if let Some(n) = score {
            fm.push(format!("{key}: {n}"));
        }
    }
    if !task.after.is_empty() {
        fm.push(format!(
            "after: {}",
            format_value(&Value::List(task.after.clone()))
        ));
    }
    for (key, v) in [("model", &task.model), ("review", &task.review)] {
        if let Some(v) = v {
            fm.push(format!("{key}: {}", s(v)));
        }
    }
    fm.push("source: me".into());
    let (mut outcome, mut other) = (Vec::new(), Vec::new());
    let mut seen = BTreeSet::new();
    let mut waiting = None;
    for (key, value) in &task.fields {
        let first = seen.insert(key.as_str());
        match key.as_str() {
            "done when" => outcome.push(format!("- {value}")),
            "pr" | "retry" if first => fm.push(format!("{key}: {}", s(value))),
            // `[ ]` with a note: I unblocked it by hand (the Python Towercab clears the note
            // only on its next start), so the question is history, not something to wait on.
            "note" if first && matches!(task.marker, '!' | '~') => waiting = Some(value.clone()),
            _ => other.push(format!("- {key}: {value}")),
        }
    }
    let waiting = waiting.or_else(|| match task.marker {
        '!' => Some("was [!] before migrate".into()),
        '~' => Some("was running before migrate".into()),
        _ => None,
    });
    if let Some(w) = waiting {
        fm.push(format!("waiting: {}", s(&w)));
    }
    if task.marker == 'x' {
        fm.push("stage: done".into());
    }
    let mut out = format!("---\n{}\n---\n\n# Intent: {}\n", fm.join("\n"), task.title);
    if !outcome.is_empty() {
        out.push_str(&format!(
            "\n## Proposed outcome\n\n{}\n",
            outcome.join("\n")
        ));
    }
    let notes = notes.map(|n| n.trim_end()).filter(|n| !n.trim().is_empty());
    if !other.is_empty() || notes.is_some() {
        out.push_str("\n## Notes\n\n");
        if !other.is_empty() {
            out.push_str(&format!("{}\n", other.join("\n")));
        }
        if let Some(n) = notes {
            if !other.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("{n}\n"));
        }
    }
    out
}

/// Old `DONE.md` without its title, comments and blank lines; none from a generated one.
pub fn legacy_lines(done_md: &str) -> Vec<String> {
    if is_generated(done_md) {
        return Vec::new();
    }
    done_md
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| {
            !l.trim().is_empty() && !l.starts_with("# ") && !l.trim_start().starts_with("<!--")
        })
        .map(str::to_string)
        .collect()
}

/// The line number in `TODO.md:<n>: …`.
fn line_of(error: &str) -> usize {
    error
        .strip_prefix("TODO.md:")
        .and_then(|r| r.split(':').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(usize::MAX)
}

/// Converts the old format in one commit `towercab: migrate <n> intents`; refuses (nothing
/// written) when neither `TODO.md` nor `DONE.md` is in the old format, a line doesn't parse or
/// an ID has a folder.
pub fn migrate(store: &Store, now: DateTime<FixedOffset>) -> Result<String, StoreError> {
    store.write(false, false, |listing| {
        let root = store.path();
        let refuse = |m: String| Err(StoreError::Refused(m));
        let read = |rel: &str| read_optional(root, rel).map_err(StoreError::Refused);
        let (todo, done_md) = (read("TODO.md")?, read("DONE.md")?);
        let old = |t: &Option<String>| t.as_deref().is_some_and(|t| !is_generated(t));
        if !old(&todo) && !old(&done_md) {
            return refuse(match todo {
                Some(_) => "TODO.md is already generated: migrate has run".into(),
                None => "TODO.md is missing: nothing to migrate".into(),
            });
        }
        if root.join("done/legacy.md").exists() {
            return refuse("done/legacy.md already exists".into());
        }
        let (tasks, mut errors) = match &todo {
            Some(t) if old(&todo) => parse_todo(t),
            _ => (Vec::new(), Vec::new()),
        };
        let folders = listing.folder_ids();
        let legacy = legacy_lines(done_md.as_deref().unwrap_or_default());
        let mut taken = listing.taken();
        taken.extend(legacy_ids(&legacy.join("\n")));
        let mut seen = BTreeSet::new();
        for t in &tasks {
            let Some(id) = &t.id else { continue };
            if folders.contains(id) {
                errors.push(format!("TODO.md:{}: {id} already has a folder", t.line));
            } else if !seen.insert(id.clone()) {
                errors.push(format!("TODO.md:{}: {id} is on two lines", t.line));
            }
            taken.insert(id.clone());
        }
        let mut done = 0;
        for t in &tasks {
            let id = match &t.id {
                Some(id) => id.clone(),
                None => {
                    let id = new_id(now, &taken);
                    taken.insert(id.clone());
                    id
                }
            };
            let notes_file = format!("tasks/{id}.md");
            let notes = match read_optional(root, &notes_file) {
                Ok(n) => n,
                Err(e) => {
                    errors.push(format!("TODO.md:{}: {e}", t.line));
                    continue;
                }
            };
            let text = render(t, notes.as_deref());
            if let Err(e) = Intent::parse(&text) {
                errors.push(format!("TODO.md:{}: {e}", t.line));
                continue;
            }
            if !errors.is_empty() {
                continue;
            }
            let base = if t.marker == 'x' { "done" } else { "intents" };
            store.write_file(
                &format!("{base}/{id}-{}/intent.md", id::slug(&t.title)),
                &text,
            )?;
            if notes.is_some() {
                fs::remove_file(root.join(&notes_file))
                    .map_err(|e| StoreError::Refused(format!("{notes_file}: {e}")))?;
            }
            done += usize::from(t.marker == 'x');
        }
        if !errors.is_empty() {
            errors.sort_by_key(|e| line_of(e));
            return refuse(errors.join("\n"));
        }
        if !legacy.is_empty() {
            store.write_file("done/legacy.md", &format!("{}\n", legacy.join("\n")))?;
        }
        let n = tasks.len();
        Ok((
            format!("towercab: migrate {n} intents"),
            format!(
                "migrated {n} intents ({done} done), {} lines to done/legacy.md",
                legacy.len()
            ),
        ))
    })
}
