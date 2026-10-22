//! The state machine's table (LOOP-3): every stage × event pair is loop.md's **Transitions**.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::read;
use towercab::intents;
use towercab::machine::{
    Door, Event, Kind, Next, ORDER, REHEARSAL, REVERT, Stage, Waiting, continue_to, next,
};

/// The `**Transitions**` table of loop.md: header cells and rows of cells.
fn transitions_table() -> (Vec<String>, Vec<Vec<String>>) {
    let spec = read("specs/loop.md");
    let at = spec
        .find("\n**Transitions**")
        .expect("loop.md has **Transitions**")
        + 1;
    assert!(
        spec[at..]
            .lines()
            .next()
            .unwrap()
            .contains("`done` and `stopped`: `Ignore` for every event"),
        "the table's preamble names done and stopped"
    );
    let rows: Vec<Vec<String>> = spec[at..]
        .lines()
        .skip_while(|l| !l.starts_with('|'))
        .take_while(|l| l.starts_with('|'))
        .map(|l| {
            l.trim()
                .trim_matches('|')
                .split('|')
                .map(|c| c.trim().to_string())
                .collect()
        })
        .collect();
    let header = rows[0].clone();
    (header, rows[2..].to_vec())
}

/// A stage name in the table.
fn stage(s: &str) -> Stage {
    s.trim()
        .parse()
        .unwrap_or_else(|e| panic!("table names {s:?}: {e}"))
}

/// `a, b … c, d`: names and ranges along their sequence.
fn stages(list: &str) -> Vec<Stage> {
    let mut out = Vec::new();
    for item in list.split(',').map(str::trim) {
        match item.split_once('…') {
            Some((a, b)) => {
                let (a, b) = (stage(a), stage(b));
                let seq = [&ORDER[..], &REVERT, &REHEARSAL]
                    .into_iter()
                    .find(|s| s.contains(&a))
                    .unwrap();
                let i = seq.iter().position(|s| *s == a).unwrap();
                let j = seq.iter().position(|s| *s == b).unwrap();
                assert!(i < j, "{item}");
                out.extend(&seq[i..=j]);
            }
            None => out.push(stage(item)),
        }
    }
    out
}

/// A `Next` word of the table.
fn word(w: &str) -> Option<Next> {
    Some(match w {
        "Wait" => Next::Wait,
        "Again" => Next::Again,
        "Cool" => Next::Cool,
        "Backoff" => Next::Backoff,
        "Recover" => Next::Recover,
        "Stop" => Next::Stop,
        "Continue" => Next::Continue,
        "Fresh" => Next::Fresh,
        "Ignore" => Next::Ignore,
        "Unexpected" => Next::Unexpected,
        _ => return None,
    })
}

/// `→ x`, `next` or a word, for `s`.
fn target(t: &str, s: Stage) -> Next {
    let t = t.trim();
    if let Some(to) = t.strip_prefix('→') {
        return Next::Go(stage(to));
    }
    if t == "next" {
        return Next::Go(s.next().expect("a stage with a next one"));
    }
    word(t).unwrap_or_else(|| panic!("not a table target: {t:?}"))
}

/// One clause's stages and their `Next`; `None` stages = `else` (the rest of the column).
fn clause(c: &str, column: &[Stage]) -> (Option<Vec<Stage>>, Vec<Next>) {
    if let Some(rest) = c.strip_prefix("else ") {
        return (None, column.iter().map(|s| target(rest, *s)).collect());
    }
    if let Some((list, to)) = c.split_once('→')
        && !list.trim().is_empty()
    {
        let ss = stages(list);
        let n = ss.len();
        return (Some(ss), vec![Next::Go(stage(to)); n]);
    }
    if let Some((list, w)) = c.rsplit_once(' ')
        && let Some(n) = word(w)
    {
        let ss = stages(list);
        let k = ss.len();
        return (Some(ss), vec![n; k]);
    }
    (
        Some(column.to_vec()),
        column.iter().map(|s| target(c, *s)).collect(),
    )
}

/// One cell → the `Next` of each stage of its column; every stage exactly once.
fn cell(text: &str, column: &[Stage]) -> BTreeMap<Stage, Next> {
    let mut out = BTreeMap::new();
    for c in text.split(';').map(str::trim) {
        let (named, nexts) = clause(c, column);
        let pairs: Vec<(Stage, Next)> = match named {
            Some(ss) => ss.into_iter().zip(nexts).collect(),
            None => column
                .iter()
                .copied()
                .zip(nexts)
                .filter(|(s, _)| !out.contains_key(s))
                .collect(),
        };
        for (s, n) in pairs {
            assert!(column.contains(&s), "{s} isn't in this column: {text}");
            assert!(out.insert(s, n).is_none(), "{s} twice in {text:?}");
        }
    }
    assert_eq!(
        out.keys().copied().collect::<BTreeSet<_>>(),
        column.iter().copied().collect(),
        "every stage of the column in {text:?}"
    );
    out
}

#[test]
fn test_every_transition_defined() {
    let (header, rows) = transitions_table();
    assert_eq!(header[0], "Event");
    let columns: Vec<Vec<Stage>> = header[1..]
        .iter()
        .map(|h| match h.as_str() {
            "pick … release" => ORDER[..ORDER.len() - 1].to_vec(),
            "revert stages" => REVERT[..REVERT.len() - 1].to_vec(),
            "rehearsal stages" => REHEARSAL[..REHEARSAL.len() - 1].to_vec(),
            one => vec![stage(one)],
        })
        .collect();
    let mut want: BTreeMap<(Stage, Event), Next> = BTreeMap::new();
    for row in &rows {
        assert_eq!(row.len(), header.len(), "{row:?}");
        for event in row[0].split(',').map(str::trim) {
            let event: Event = event.parse().unwrap();
            for (text, column) in row[1..].iter().zip(&columns) {
                for (s, n) in cell(text, column) {
                    assert!(want.insert((s, event), n).is_none(), "{s} × {event} twice");
                }
            }
            for s in [Stage::Done, Stage::Stopped] {
                want.insert((s, event), Next::Ignore);
            }
        }
    }
    // The table covers every pair exactly once …
    assert_eq!(want.len(), Stage::ALL.len() * Event::ALL.len());
    // … and `next` agrees on each.
    let mut wrong = Vec::new();
    for s in Stage::ALL {
        for e in Event::ALL {
            if next(s, e) != want[&(s, e)] {
                wrong.push(format!(
                    "{s} × {e}: next = {:?}, table = {:?}",
                    next(s, e),
                    want[&(s, e)]
                ));
            }
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The sequence the LOOP-3 row writes after `marker` (`` `a → b → … → done` ``).
fn row_sequence(marker: &str) -> Vec<Stage> {
    let spec = read("specs/loop.md");
    let row = spec.lines().find(|l| l.starts_with("| LOOP-3 |")).unwrap();
    let at = row.find(marker).unwrap_or_else(|| panic!("{marker}")) + marker.len();
    let rest = &row[at..];
    let start = rest.find('`').unwrap() + 1;
    let end = start + rest[start..].find('`').unwrap();
    rest[start..end].split('→').map(stage).collect()
}

#[test]
fn test_stage_order() {
    // Names: 30 stages, 21 events, each round-trips.
    let names: BTreeSet<&str> = Stage::ALL.iter().map(|s| s.as_str()).collect();
    assert_eq!(names.len(), 30);
    for s in Stage::ALL {
        assert_eq!(s.as_str().parse::<Stage>(), Ok(s));
        assert_eq!(s.to_string(), s.as_str());
    }
    let events: BTreeSet<&str> = Event::ALL.iter().map(|e| e.as_str()).collect();
    assert_eq!(events.len(), 21);
    for e in Event::ALL {
        assert_eq!(e.as_str().parse::<Event>(), Ok(e));
    }
    assert!("approval".parse::<Stage>().is_err());

    // The three sequences are LOOP-3's, and `ok` walks each to `done`.
    assert_eq!(ORDER.to_vec(), row_sequence("the order "));
    assert_eq!(
        REVERT.to_vec(),
        row_sequence("missions ([PIP-19](pipeline.md)) ")
    );
    assert_eq!(
        REHEARSAL.to_vec(),
        row_sequence("rehearsals ([PIP-35](pipeline.md)) ")
    );
    for seq in [&ORDER[..], &REVERT, &REHEARSAL] {
        let mut at = seq[0];
        let mut walked = vec![at];
        while let Next::Go(n) = next(at, Event::Ok) {
            walked.push(n);
            at = n;
        }
        assert_eq!(walked, seq);
        assert_eq!(next(Stage::Done, Event::Ok), Next::Ignore);
    }
    // Every repair re-enters the order at verify, by way of build.
    for s in [Stage::Verify, Stage::Proof, Stage::Ci] {
        assert_eq!(next(s, Event::Red), Next::Go(Stage::Build));
    }
    assert_eq!(next(Stage::Build, Event::Ok), Next::Go(Stage::Verify));

    // kind, driven, playbook (loop.md **Machine**).
    for s in Stage::ALL {
        let kind = if REVERT[..6].contains(&s) {
            Kind::Revert
        } else if REHEARSAL[..3].contains(&s) {
            Kind::Rehearsal
        } else {
            Kind::Intent
        };
        assert_eq!(s.kind(), kind, "{s}");
        let driven = [&ORDER[..15], &REVERT[..6], &REHEARSAL[..3]]
            .iter()
            .any(|q| q.contains(&s));
        assert_eq!(s.driven(), driven, "{s}");
        assert_eq!(
            s.waits(),
            matches!(
                s,
                Stage::ApprovalSpec
                    | Stage::ApprovalMerge
                    | Stage::ApprovalRelease
                    | Stage::Blocked
            )
        );
        assert_eq!(s.finished(), matches!(s, Stage::Done | Stage::Stopped));
    }
    use intents::Stage as P;
    let playbook: [(&str, Option<P>); 30] = [
        ("pick", Some(P::Design)),
        ("design", Some(P::Design)),
        ("approval:spec", Some(P::Design)),
        ("plan", Some(P::Build)),
        ("build", Some(P::Build)),
        ("verify", Some(P::Test)),
        ("proof", Some(P::Test)),
        ("publish", Some(P::Test)),
        ("ci", Some(P::Test)),
        ("verifier", Some(P::Test)),
        ("review", Some(P::Deploy)),
        ("gate", Some(P::Deploy)),
        ("merge", Some(P::Deploy)),
        ("approval:merge", Some(P::Deploy)),
        ("deploy", Some(P::Deploy)),
        ("e2e", Some(P::Deploy)),
        ("release", Some(P::Deploy)),
        ("approval:release", Some(P::Deploy)),
        ("rollback", Some(P::Maintain)),
        ("revert", Some(P::Maintain)),
        ("revert_ci", Some(P::Maintain)),
        ("revert_merge", Some(P::Maintain)),
        ("revert_deploy", Some(P::Maintain)),
        ("revert_e2e", Some(P::Maintain)),
        ("done", Some(P::Done)),
        ("blocked", None),
        ("stopped", None),
        ("rehearse", None),
        ("rehearse_ci", None),
        ("rehearse_close", None),
    ];
    for (s, p) in playbook {
        assert_eq!(stage(s).playbook(), p, "{s}");
    }
}

#[test]
fn test_continue_to() {
    let from = Stage::Deploy;
    let want = |w: &Waiting| -> Next {
        match w.text().as_str() {
            "approve spec" => Next::Go(Stage::Plan),
            "review and merge PR" => Next::Go(Stage::Gate),
            "authorize release" => Next::Go(Stage::Release),
            "e2e red after your merge (two-way)" => Next::Go(Stage::Done),
            "deploy not seen"
            | "revert failed"
            | "add CLAUDE.md verifying block"
            | "fix repo files" => Next::Go(from),
            "crashed at build" => Next::Go(Stage::Build),
            "reverted, refine" | "PR closed" => Next::Fresh,
            _ => Next::Go(Stage::Build),
        }
    };
    assert_eq!(Waiting::ALL.len(), 29);
    for w in Waiting::ALL {
        assert_eq!(continue_to(&w, from), want(&w), "{w}");
        // Text round-trips; a parameter is kept.
        assert_eq!(Waiting::parse(&w.text()), Some(w));
    }
    assert_eq!(
        continue_to(&Waiting::CrashedAt(Stage::Ci), Stage::Blocked),
        Next::Go(Stage::Ci)
    );
    assert_eq!(
        continue_to(&Waiting::FixRepoFiles, Stage::Pick),
        Next::Go(Stage::Pick)
    );
    for d in Door::ALL {
        let w = Waiting::E2eRedAfterYourMerge(d);
        assert_eq!(
            w.text(),
            format!("e2e red after your merge ({})", d.as_str())
        );
        assert_eq!(continue_to(&w, from), Next::Go(Stage::Done));
        assert_eq!(w.key(), "e2e_red_after_your_merge");
    }
    // Each waits in its stage; the pick-time ones without a mission.
    assert_eq!(Waiting::ApproveSpec.stage(), Some(Stage::ApprovalSpec));
    assert_eq!(
        Waiting::ReviewAndMergePr.stage(),
        Some(Stage::ApprovalMerge)
    );
    assert_eq!(
        Waiting::AuthorizeRelease.stage(),
        Some(Stage::ApprovalRelease)
    );
    assert_eq!(Waiting::PrClosed.stage(), Some(Stage::Stopped));
    assert_eq!(Waiting::BadAfter.stage(), None);
    assert_eq!(Waiting::UnknownRepo.stage(), None);
    assert_eq!(Waiting::CiRed.stage(), Some(Stage::Blocked));
    // Keys: the text before any parameter.
    assert_eq!(Waiting::CrashedAt(Stage::Ci).key(), "crashed_at");
    assert_eq!(Waiting::BadAfter.key(), "bad_after");
    assert_eq!(
        Waiting::TestsDontProve.key(),
        "tests_don_t_prove_the_change"
    );
    assert_eq!(Waiting::ReviewAndMergePr.key(), "review_and_merge_pr");
    // My own words aren't Towercab's.
    assert_eq!(Waiting::parse("call me"), None);
    assert_eq!(Waiting::parse("crashed at nowhere"), None);
    // Every `waiting:` text LOOP-14 lists is one.
    let spec = read("specs/loop.md");
    let row = spec.lines().find(|l| l.starts_with("| LOOP-14 |")).unwrap();
    let list = row.split("machine::Waiting` (").nth(1).unwrap();
    let list = &list[..list.find("), written only").unwrap()];
    let texts: Vec<String> = Waiting::ALL
        .iter()
        .map(|w| match w {
            Waiting::CrashedAt(_) => "crashed at <stage>".to_string(),
            Waiting::E2eRedAfterYourMerge(_) => "e2e red after your merge".to_string(),
            w => w.text(),
        })
        .collect();
    for t in &texts {
        assert!(list.contains(t.as_str()), "LOOP-14 lists {t}");
    }
}
