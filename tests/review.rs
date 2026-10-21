//! `towercab review`: the walk, rescore checks, drop (PRI-7, PRI-9).

mod common;

use std::io::{self, BufRead, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use chrono::{DateTime, FixedOffset};
use common::{Home, git, intent_md, t};
use towercab::intents::{Stage, Store, StoreError};
use towercab::priority::{Scores, review_queue};
use towercab::review::{self, Tally};

const NOW: &str = "2026-10-21T12:00:00+02:00";

fn now() -> DateTime<FixedOffset> {
    t(NOW)
}

/// Input that runs `hook` the first time it is read (after the queue is listed).
struct Hooked<'a> {
    input: &'a [u8],
    hook: Option<Box<dyn FnOnce() + 'a>>,
}

impl Read for Hooked<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.fill_buf()?.read(buf)?;
        self.consume(n);
        Ok(n)
    }
}

impl BufRead for Hooked<'_> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if let Some(hook) = self.hook.take() {
            hook();
        }
        Ok(self.input)
    }
    fn consume(&mut self, n: usize) {
        self.input = &self.input[n..];
    }
}

fn walk_with(
    store: &Store,
    input: &mut dyn BufRead,
    now: DateTime<FixedOffset>,
) -> (Result<Tally, String>, String) {
    let mut out = Vec::new();
    let r = review::run(store, input, &mut out, now);
    (r, String::from_utf8(out).unwrap())
}

fn walk(store: &Store, input: &str) -> (Result<Tally, String>, String) {
    walk_with(store, &mut input.as_bytes(), now())
}

fn tally(kept: usize, rescored: usize, dropped: usize, left: usize) -> Tally {
    Tally {
        kept,
        rescored,
        dropped,
        left,
    }
}

const PROMPT: &str = "keep, rescore, drop or quit? [k/r/d/q] ";

fn seed() -> Vec<(&'static str, String)> {
    vec![
        (
            "intents/261001-0900-parked-a/intent.md",
            intent_md(
                "towercab",
                "u: 1\ni: 2\nstarted: 2026-10-01T09:00:00+02:00\n",
                "Parked A",
            ),
        ),
        (
            "intents/260801-0900-stale-b/intent.md",
            intent_md(
                "towercab",
                "u: 3\ni: 4\na: 2\nstarted: 2026-08-01T09:00:00+02:00\n",
                "Stale B",
            ),
        ),
        (
            "intents/261020-0900-fresh-c/intent.md",
            intent_md(
                "towercab",
                "u: 4\ni: 5\nstarted: 2026-10-20T09:00:00+02:00\n",
                "Fresh C",
            ),
        ),
        (
            "intents/260701-0900-flight-d/intent.md",
            intent_md("towercab", "u: 1\ni: 1\nstage: build\n", "Flight D"),
        ),
        (
            "intents/261002-0900-parked-e/intent.md",
            intent_md(
                "towercab",
                "u: 1\ni: 1\nreviewed: 2026-10-10T08:00:00+02:00\n",
                "Parked E",
            ),
        ),
        (
            "intents/261003-0900-parked-f/intent.md",
            intent_md("towercab", "u: 2\ni: 1\n", "Parked F"),
        ),
        ("intents/261003-0900-parked-f/plan.md", "# Plan\n".into()),
        (
            "intents/261004-0900-parked-g/intent.md",
            intent_md("other-repo", "u: 1\ni: 1\n", "Parked \t G"),
        ),
    ]
}

fn home(files: &[(&'static str, String)]) -> Home {
    let files: Vec<(&str, &str)> = files.iter().map(|(p, s)| (*p, s.as_str())).collect();
    Home::new(&files)
}

/// `towercab --config <cfg> <args>` with `stdin`.
fn cli(home: &Home, args: &[&str], stdin: &str) -> (Option<i32>, String, String) {
    let cfg = home.tmp.path().join("config.toml");
    std::fs::write(
        &cfg,
        format!(
            "[intents]\nremote = \"{}\"\npath = \"{}\"\n",
            home.remote.display(),
            home.checkout.display()
        ),
    )
    .unwrap();
    let user_home = home.tmp.path().join("home");
    std::fs::create_dir_all(&user_home).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_towercab"))
        .arg("--config")
        .arg(if args.first() == Some(&"--no-config") {
            Path::new("/nonexistent/c.toml")
        } else {
            cfg.as_path()
        })
        .args(args.iter().filter(|a| **a != "--no-config"))
        .env("HOME", &user_home)
        .env_remove("TOWERCAB_CONFIG")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn test_review() {
    let seeded = seed();
    let home = home(&seeded);
    let store = home.store();

    // B (stale), A, F, G (parked, never reviewed); C is new, D in flight, E reviewed lately.
    let (r, out) = walk(&store, "x\nK\nr\nu5 i5\n d \nq\n");
    assert_eq!(r, Ok(tally(1, 1, 1, 1)));
    assert_eq!(
        out,
        format!(
            "4 to review (parked, or not reviewed for 30 days)

[1/4] 260801-0900 towercab: Stale B · p11 u3 i4 a2 · next · never reviewed
  intents/260801-0900-stale-b/intent.md
{PROMPT}want k, r, d or q
{PROMPT}kept

[2/4] 261001-0900 towercab: Parked A · p5 u1 i2 · parked · never reviewed
  intents/261001-0900-parked-a/intent.md
{PROMPT}scores (now u1 i2): rescored: p5 → p15

[3/4] 261003-0900 towercab: Parked F · p4 u2 i1 · parked · never reviewed
  intents/261003-0900-parked-f/intent.md
{PROMPT}dropped: done/261003-0900-parked-f

[4/4] 261004-0900 other-repo: Parked G · p3 u1 i1 · parked · never reviewed
  intents/261004-0900-parked-g/intent.md
{PROMPT}
kept 1, rescored 1, dropped 1, left 1
"
        )
    );
    // One commit per answer, each writing `reviewed: <now>`; other lines untouched.
    assert_eq!(
        home.log()[..3],
        [
            "towercab: review drop 261003-0900",
            "towercab: review rescore 261001-0900",
            "towercab: review keep 260801-0900",
        ]
    );
    assert_eq!(
        home.remote_file("intents/260801-0900-stale-b/intent.md"),
        intent_md(
            "towercab",
            &format!("u: 3\ni: 4\na: 2\nstarted: 2026-08-01T09:00:00+02:00\nreviewed: {NOW}\n"),
            "Stale B"
        )
    );
    assert_eq!(
        home.remote_file("intents/261001-0900-parked-a/intent.md"),
        intent_md(
            "towercab",
            &format!("u: 5\ni: 5\nstarted: 2026-10-01T09:00:00+02:00\nreviewed: {NOW}\n"),
            "Parked A"
        )
    );
    let dropped = home.remote_file("done/261003-0900-parked-f/intent.md");
    assert!(dropped.contains(&format!("stage: dropped\nreviewed: {NOW}\nfinished: ")));
    for (path, text) in &seeded {
        if ["fresh-c", "flight-d", "parked-e", "parked-g"]
            .iter()
            .any(|s| path.contains(s))
        {
            assert_eq!(&home.remote_file(path), text, "unanswered: untouched");
        }
    }
    assert!(home.checkout_clean());

    // Again at the same time: only G is left. End of input = quit, nothing written.
    let head = home.head();
    let (r, out) = walk(&store, "");
    assert_eq!(r, Ok(tally(0, 0, 0, 1)));
    assert!(out.starts_with("1 to review (parked, or not reviewed for 30 days)\n\n[1/1] 261004-0900 other-repo: Parked G"));
    assert!(out.ends_with(&format!(
        "{PROMPT}\nkept 0, rescored 0, dropped 0, left 1\n"
    )));
    assert_eq!(home.head(), head);
    let (r, out) = walk(&store, "k\n");
    assert_eq!(r, Ok(tally(1, 0, 0, 0)));
    assert!(out.ends_with(&format!(
        "{PROMPT}kept\n\nkept 1, rescored 0, dropped 0, left 0\n"
    )));
    let (r, out) = walk(&store, "k\n");
    assert_eq!(
        (r, out.as_str()),
        (Ok(Tally::default()), "nothing to review\n")
    );

    // 30 days on (another offset): every queued intent is due again; the date shows.
    let later = t("2026-11-20T11:00:00+01:00");
    let (r, out) = walk_with(&store, &mut "Q\n".as_bytes(), later);
    assert_eq!(r, Ok(tally(0, 0, 0, 5)));
    assert!(out.starts_with(
        "5 to review (parked, or not reviewed for 30 days)\n\n[1/5] 261001-0900 towercab: Parked A · p15 u5 i5 · next · reviewed 2026-10-21\n"
    ), "{out}");

    // Picked by the loop mid-walk → refused, the walk goes on.
    let home2 = Home::new(&[
        (
            "intents/261001-0900-one/intent.md",
            &intent_md("towercab", "u: 1\ni: 1\n", "One"),
        ),
        (
            "intents/261002-0900-two/intent.md",
            &intent_md("towercab", "u: 1\ni: 1\n", "Two"),
        ),
    ]);
    let store2 = home2.store();
    let picked = || {
        home2.push_mine(
            &[(
                "intents/261001-0900-one/intent.md",
                Some(&intent_md("towercab", "u: 1\ni: 1\nstage: design\n", "One")),
            )],
            "picked",
        )
    };
    let mut input = Hooked {
        input: b"k\nk\n",
        hook: Some(Box::new(picked)),
    };
    let (r, out) = walk_with(&store2, &mut input, now());
    assert_eq!(r, Ok(tally(1, 0, 0, 1)));
    assert!(
        out.contains(&format!(
            "{PROMPT}not changed: 261001-0900 is no longer queued\n\n[2/2]"
        )),
        "{out}"
    );
    assert_eq!(home2.log()[0], "towercab: review keep 261002-0900");
    assert!(
        !home2
            .remote_file("intents/261001-0900-one/intent.md")
            .contains("reviewed")
    );

    // A failed pull or push stops the walk: exit 1 from the CLI.
    let home3 = Home::new(&[(
        "intents/261001-0900-one/intent.md",
        &intent_md("towercab", "u: 1\ni: 1\n", "One"),
    )]);
    let store3 = home3.store();
    let gone = home3.tmp.path().join("gone.git");
    let mut input = Hooked {
        input: b"k\n",
        hook: Some(Box::new(|| std::fs::rename(&home3.remote, &gone).unwrap())),
    };
    let (r, out) = walk_with(&store3, &mut input, now());
    assert!(r.is_err(), "{r:?}");
    assert!(!out.contains("kept"), "{out}");

    // The command: reads stdin, exit 0 after the walk (quit too), 1 on an error, 2 on bad args.
    let home4 = Home::new(&[(
        "intents/261001-0900-one/intent.md",
        &intent_md("towercab", "u: 1\ni: 1\n", "One"),
    )]);
    let (code, out, err) = cli(&home4, &["review"], "q\n");
    assert_eq!(code, Some(0), "{err}");
    assert!(out.starts_with("1 to review (parked, or not reviewed for 30 days)\n\n[1/1] 261001-0900 towercab: One · p3 u1 i1 · parked · never reviewed\n"));
    assert!(out.ends_with("left 1\n"));
    let (code, out, err) = cli(&home4, &["review"], "k\n");
    assert_eq!(code, Some(0), "{err}");
    assert!(out.contains(&format!("{PROMPT}kept\n")));
    assert!(home4.log()[0].starts_with("towercab: review keep 261001-0900"));
    let reviewed = home4.remote_file("intents/261001-0900-one/intent.md");
    let when = reviewed
        .lines()
        .find_map(|l| l.strip_prefix("reviewed: "))
        .unwrap();
    let when = DateTime::parse_from_rfc3339(when).unwrap();
    assert!(
        (when.timestamp() - chrono::Local::now().timestamp()).abs() < 60,
        "now"
    );
    let (code, out, _) = cli(&home4, &["review"], "");
    assert_eq!((code, out.as_str()), (Some(0), "nothing to review\n"));
    let (code, _, err) = cli(&home4, &["--no-config", "review"], "");
    assert_eq!(code, Some(1));
    assert!(
        err.starts_with("towercab: config: /nonexistent/c.toml: "),
        "{err}"
    );
    let (code, _, _) = cli(&home4, &["review", "extra"], "");
    assert_eq!(code, Some(2));
}

#[test]
fn test_rescore_validates() {
    let home = Home::new(&[(
        "intents/261001-0900-parked/intent.md",
        &intent_md("towercab", "u: 1\ni: 2\na: 3\n", "Parked"),
    )]);
    let store = home.store();
    let head = home.head();
    let ask = "scores (now u1 i2 a3): ";
    let bad = |s: &str| format!("bad score {s:?}: want uN, iN or aN with N 1-5, each once\n");

    // Each bad line prints why and asks again; `q` stops with nothing written.
    let (r, out) = walk(&store, "r\n\n  \nu6\nu3 u4\nx1\nU4\nq\n");
    assert_eq!(r, Ok(tally(0, 0, 0, 1)));
    assert!(
        out.ends_with(&format!(
            "{PROMPT}{ask}want at least one of uN, iN, aN\n{ask}want at least one of uN, iN, aN\n{ask}{}{ask}{}{ask}{}{ask}{}{ask}\nkept 0, rescored 0, dropped 0, left 1\n",
            bad("u6"),
            bad("u4"),
            bad("x1"),
            bad("U4"),
        )),
        "{out}"
    );
    // End of input at the scores prompt: stop too.
    let (r, out) = walk(&store, "r\n");
    assert_eq!(r, Ok(tally(0, 0, 0, 1)));
    assert!(out.ends_with(&format!(
        "{PROMPT}{ask}\nkept 0, rescored 0, dropped 0, left 1\n"
    )));
    assert_eq!(home.head(), head, "nothing written");

    // Checked again by `Intent::set`: out-of-range scores never reach the file.
    for (scores, err) in [
        (
            Scores {
                u: Some(9),
                ..Scores::default()
            },
            "u must be an integer 1-5",
        ),
        (
            Scores {
                i: Some(4),
                a: Some(0),
                ..Scores::default()
            },
            "a must be an integer 1-5",
        ),
    ] {
        assert_eq!(
            review::rescore(&store, "0900", scores, now()).unwrap_err(),
            StoreError::Refused(err.into())
        );
    }
    assert_eq!(home.head(), head, "nothing written");
    assert!(home.checkout_clean());

    // A good line: the scores given, the others stay.
    let (r, out) = walk(&store, "r\nu2\n");
    assert_eq!(r, Ok(tally(0, 1, 0, 0)));
    assert!(out.contains(&format!("{PROMPT}{ask}rescored: p5 → p6 (parked)\n")));
    assert_eq!(
        home.remote_file("intents/261001-0900-parked/intent.md"),
        intent_md(
            "towercab",
            &format!("u: 2\ni: 2\na: 3\nreviewed: {NOW}\n"),
            "Parked"
        )
    );
    assert_eq!(home.log()[0], "towercab: review rescore 261001-0900");
}

#[test]
fn test_drop() {
    let home = Home::new(&[
        (
            "intents/261001-0900-drop-me/intent.md",
            &intent_md("towercab", "u: 1\ni: 1\n", "Drop me"),
        ),
        ("intents/261001-0900-drop-me/plan.md", "# Plan\n"),
        (
            "intents/261002-0900-busy/intent.md",
            &intent_md("towercab", "u: 1\ni: 1\nstage: build\n", "Busy"),
        ),
        (
            "intents/261003-0900-asks/intent.md",
            &intent_md("towercab", "u: 1\ni: 1\nwaiting: approve spec\n", "Asks"),
        ),
    ]);
    let store = home.store();
    let got = review::drop(&store, "261001-0900", now()).unwrap();
    assert_eq!(got.dir, "done/261001-0900-drop-me");
    assert_eq!(got.stage(), Some(Stage::Dropped));
    assert_eq!(got.reviewed(), Some(now()));
    assert!(got.finished().is_some(), "the store adds finished");
    assert_eq!(home.log()[0], "towercab: review drop 261001-0900");

    // Moved with `git mv`, never deleted.
    assert!(!home.remote_has("intents/261001-0900-drop-me"));
    let file = home.remote_file("done/261001-0900-drop-me/intent.md");
    assert!(file.starts_with("---\nrepo: towercab\nu: 1\ni: 1\nstage: dropped\n"));
    assert!(file.ends_with("---\n\n# Intent: Drop me\n"));
    assert_eq!(
        home.remote_file("done/261001-0900-drop-me/plan.md"),
        "# Plan\n"
    );
    let status = git(
        &home.remote,
        &["diff", "--name-status", "-M", "main~1", "main"],
    );
    assert!(
        status.contains("intents/261001-0900-drop-me/plan.md\tdone/261001-0900-drop-me/plan.md"),
        "{status}"
    );
    let date = got.finished().unwrap().format("%Y-%m-%d").to_string();
    assert!(home.remote_file("DONE.md").contains(&format!(
        "- {date} [261001-0900](done/261001-0900-drop-me/intent.md) towercab: Drop me · dropped\n"
    )));
    assert!(!home.remote_file("TODO.md").contains("Drop me"));
    let l = store.list().unwrap();
    assert!(l.done.iter().any(|i| i.id == "261001-0900"));
    assert!(review_queue(&l, 7, now()).is_empty());

    // Only queued intents: in flight or waiting on me → refused, nothing written.
    let head = home.head();
    for id in ["261002-0900", "261003-0900"] {
        assert_eq!(
            review::drop(&store, id, now()).unwrap_err(),
            StoreError::Refused(format!("{id} is no longer queued"))
        );
    }
    assert_eq!(
        review::drop(&store, "261001-0900", now()).unwrap_err(),
        StoreError::Refused("no open intent matches 261001-0900".into()),
        "already dropped"
    );
    assert_eq!(home.head(), head);
}
