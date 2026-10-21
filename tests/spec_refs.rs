//! Every test a Live spec row names exists (PIP-12).

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use common::root;
use regex::Regex;

/// IDs a Status line marks live: `Live: <IDs>` up to the next ` · `, ranges as `INT-9..13`;
/// a bare `Live` = every row (`None`); otherwise none.
fn live(status: &str) -> Option<BTreeSet<String>> {
    let mut ids = BTreeSet::new();
    let status = status.trim_start_matches("**Status:**");
    for part in status.split(" · ") {
        let part = part.trim();
        if part == "Live" {
            return None;
        }
        let Some(list) = part.strip_prefix("Live:") else {
            continue;
        };
        for item in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (prefix, n) = item
                .rsplit_once('-')
                .unwrap_or_else(|| panic!("bad live ID {item}"));
            match n.split_once("..") {
                Some((a, b)) => {
                    let (a, b): (u32, u32) = (a.parse().unwrap(), b.parse().unwrap());
                    ids.extend((a..=b).map(|n| format!("{prefix}-{n}")));
                }
                None => {
                    ids.insert(item.to_string());
                }
            }
        }
    }
    Some(ids)
}

/// Table cells, split on `|` without a backslash before it.
fn cells(row: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut prev = ' ';
    for c in row.trim().trim_start_matches('|').chars() {
        if c == '|' && prev != '\\' {
            out.push(String::new());
        } else {
            out.last_mut().unwrap().push(c);
        }
        prev = c;
    }
    if out.last().is_some_and(|c| c.trim().is_empty()) {
        out.pop();
    }
    out.into_iter().map(|c| c.trim().to_string()).collect()
}

fn fn_names(dir: &Path, re: &Regex, out: &mut BTreeSet<String>) {
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            fn_names(&p, re, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            let text = fs::read_to_string(&p).unwrap();
            out.extend(re.captures_iter(&text).map(|c| c[1].to_string()));
        }
    }
}

#[test]
fn test_live_rows_have_tests() {
    // The parsers this check relies on.
    assert_eq!(
        live("**Status:** Live: INT-1..3, INT-9 · Draft: rest · **Prefix:** INT"),
        Some(
            ["INT-1", "INT-2", "INT-3", "INT-9"]
                .map(String::from)
                .into()
        )
    );
    assert_eq!(live("**Status:** Live · **Prefix:** X"), None);
    assert_eq!(
        live("**Status:** Draft | Live · **Prefix:** XXX"),
        Some(BTreeSet::new())
    );
    assert_eq!(
        cells(r"| A-1 | x `a\|b` y | test_a, manual |"),
        ["A-1", r"x `a\|b` y", "test_a, manual"]
    );

    let mut defined = BTreeSet::new();
    let def = Regex::new(r"\bfn\s+(test_[a-z0-9_]+)\s*\(").unwrap();
    for dir in ["src", "tests"] {
        fn_names(&root().join(dir), &def, &mut defined);
    }
    let row_id = Regex::new(r"^[A-Z]+-\d+$").unwrap();
    let test_name = Regex::new(r"\btest_[a-z0-9_]+").unwrap();
    let mut specs: Vec<_> = fs::read_dir(root().join("specs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .collect();
    specs.sort();
    let (mut missing, mut checked) = (Vec::new(), 0);
    for spec in specs {
        let text = fs::read_to_string(&spec).unwrap();
        let name = spec.file_name().unwrap().to_string_lossy().into_owned();
        let Some(status) = text.lines().find(|l| l.starts_with("**Status:**")) else {
            continue;
        };
        let live = live(status);
        for line in text.lines().filter(|l| l.starts_with('|')) {
            let cells = cells(line);
            let (Some(id), Some(verified)) = (cells.first(), cells.last()) else {
                continue;
            };
            if cells.len() < 2 || !row_id.is_match(id) {
                continue;
            }
            if live.as_ref().is_some_and(|ids| !ids.contains(id)) {
                continue;
            }
            for t in test_name.find_iter(verified) {
                checked += 1;
                if !defined.contains(t.as_str()) {
                    missing.push(format!("{name} {id} {}", t.as_str()));
                }
            }
        }
    }
    assert!(checked > 0, "no Live rows found");
    assert!(
        missing.is_empty(),
        "Live rows name tests with no `fn`:\n{}",
        missing.join("\n")
    );
}
