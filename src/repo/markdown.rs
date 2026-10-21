//! The **Grammar** of the repo files (REPO-1): lines, fenced blocks, `##` sections, bullets and
//! `key: value` lines. Errors are `<where>: <what>`; the file parsers add `<file>: `.

/// UTF-8 text → lines: a leading BOM dropped, split on `\n`, a trailing `\r` dropped.
pub fn lines(text: &str) -> Vec<&str> {
    text.strip_prefix('\u{feff}')
        .unwrap_or(text)
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// A fenced block: opened by a line starting (after spaces) with ```` ``` ````, closed by the
/// next line that trims to ```` ``` ````.
#[derive(Debug, Clone, PartialEq)]
pub struct Fence<'a> {
    /// 1-based line of the opening fence.
    pub line: usize,
    /// The rest of the opening line, trimmed.
    pub name: &'a str,
    /// Its lines trimmed, minus blank lines and lines starting `#`.
    pub body: Vec<&'a str>,
    /// Every line from the opening to the closing fence, as written.
    pub raw: Vec<&'a str>,
}

/// A line outside fences, or a fenced block.
#[derive(Debug, Clone, PartialEq)]
pub enum Item<'a> {
    /// 1-based line number and the line.
    Line(usize, &'a str),
    Fence(Fence<'a>),
}

/// `lines` (the first one being line `first`) → items. An unclosed fence →
/// `line <n>: unclosed ```<name> block`.
pub fn items<'a>(lines: &[&'a str], first: usize) -> Result<Vec<Item<'a>>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let n = first + i;
        let line = lines[i];
        let Some(name) = line.trim_start_matches(' ').strip_prefix("```") else {
            out.push(Item::Line(n, line));
            i += 1;
            continue;
        };
        let name = name.trim();
        let Some(len) = lines[i + 1..].iter().position(|l| l.trim() == "```") else {
            return Err(format!("line {n}: unclosed ```{name} block"));
        };
        let inner = &lines[i + 1..i + 1 + len];
        out.push(Item::Fence(Fence {
            line: n,
            name,
            body: inner
                .iter()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .collect(),
            raw: lines[i..i + len + 2].to_vec(),
        }));
        i += len + 2;
    }
    Ok(out)
}

/// The title of a column-0 `## <title>` line, trimmed.
fn section_title(line: &str) -> Option<&str> {
    line.strip_prefix("## ").map(str::trim)
}

/// Whether a line ends a section: a column-0 `# ` or `## ` line.
fn is_heading(line: &str) -> bool {
    line.starts_with("# ") || line.starts_with("## ")
}

/// Per `known` title (ASCII case-insensitive), the items of its section (after the heading,
/// up to the next `# ` or `## ` line outside fences), if present. A known title twice →
/// `line <n>: two ## <title> sections`.
pub fn sections<'a, 'b>(
    items: &'b [Item<'a>],
    known: &[&str],
) -> Result<Vec<Option<&'b [Item<'a>]>>, String> {
    let mut found: Vec<Option<&'b [Item<'a>]>> = vec![None; known.len()];
    let mut i = 0;
    while i < items.len() {
        let Item::Line(n, line) = items[i] else {
            i += 1;
            continue;
        };
        let Some(title) = section_title(line) else {
            i += 1;
            continue;
        };
        let start = i + 1;
        let end = items[start..]
            .iter()
            .position(|it| matches!(it, Item::Line(_, l) if is_heading(l)))
            .map_or(items.len(), |p| start + p);
        if let Some(k) = known.iter().position(|k| k.eq_ignore_ascii_case(title)) {
            if found[k].is_some() {
                return Err(format!("line {n}: two ## {} sections", known[k]));
            }
            found[k] = Some(&items[start..end]);
        }
        i = end;
    }
    Ok(found)
}

/// Per name in `names`, its block with a non-empty body, if any. Two such blocks of a name →
/// `line <n>: two ```<name> blocks`.
pub fn fences<'a, 'b>(
    items: &'b [Item<'a>],
    names: &[&str],
) -> Result<Vec<Option<&'b Fence<'a>>>, String> {
    let mut found: Vec<Option<&'b Fence<'a>>> = vec![None; names.len()];
    for item in items {
        let Item::Fence(f) = item else { continue };
        let Some(k) = names.iter().position(|n| *n == f.name) else {
            continue;
        };
        if f.body.is_empty() {
            continue;
        }
        if found[k].is_some() {
            return Err(format!("line {}: two ```{} blocks", f.line, f.name));
        }
        found[k] = Some(f);
    }
    Ok(found)
}

/// Bullets outside fences: a column-0 line starting `- `, `* ` or `+ `, continued by the
/// indented non-blank lines after it; each line trimmed, joined with one space.
pub fn bullets(items: &[Item]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut open = false;
    for item in items {
        let Item::Line(_, line) = item else {
            open = false;
            continue;
        };
        if let Some(rest) = ["- ", "* ", "+ "].iter().find_map(|m| line.strip_prefix(m)) {
            out.push(rest.trim().to_string());
            open = true;
        } else if open && line.starts_with([' ', '\t']) && !line.trim().is_empty() {
            let last = out.last_mut().expect("open bullet");
            if !last.is_empty() {
                last.push(' ');
            }
            last.push_str(line.trim());
        } else {
            open = false;
        }
    }
    out
}

/// The items' lines as written, joined with `\n`.
pub fn text(items: &[Item]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for item in items {
        match item {
            Item::Line(_, l) => out.push(l),
            Item::Fence(f) => out.extend(&f.raw),
        }
    }
    out.join("\n")
}

/// A block of `<key>: <value>` lines, split at the first `:`, both trimmed → per key in `keys`
/// its value, if given. Errors `<block>: <reason>`: no `:`, an unknown key, an empty value or
/// a key twice.
pub fn key_lines<'a>(fence: &Fence<'a>, keys: &[&str]) -> Result<Vec<Option<&'a str>>, String> {
    let block = fence.name;
    let mut values: Vec<Option<&'a str>> = vec![None; keys.len()];
    for line in &fence.body {
        let Some((key, value)) = line.split_once(':') else {
            return Err(format!("{block}: want \"<key>: <value>\", got \"{line}\""));
        };
        let (key, value) = (key.trim(), value.trim());
        let Some(k) = keys.iter().position(|k| *k == key) else {
            return Err(format!("{block}: unknown key {key}"));
        };
        if value.is_empty() {
            return Err(format!("{block}: {key} is empty"));
        }
        if values[k].replace(value).is_some() {
            return Err(format!("{block}: {key} twice"));
        }
    }
    Ok(values)
}
