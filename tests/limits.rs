//! Usage limits detected and their reset times parsed in every format (LOOP-9, loop.md
//! **Limits**; the Python `towercab/limits.py` cases, extended).

use chrono::{DateTime, FixedOffset, TimeZone, Utc};
use chrono_tz::Europe::Berlin;
use towercab::limits::{self, Limit, detect, parse_reset};

/// 2026-10-15 13:30 Europe/Berlin (+02:00).
fn now() -> DateTime<FixedOffset> {
    DateTime::parse_from_rfc3339("2026-10-15T13:30:00+02:00").unwrap()
}

fn berlin(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    Berlin
        .with_ymd_and_hms(y, mo, d, h, mi, 0)
        .single()
        .unwrap()
        .with_timezone(&Utc)
}

fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

#[test]
fn test_limit_formats() {
    // Detected (ASCII case-insensitive), or not.
    for text in [
        "You've hit your limit · resets 3pm (Europe/Berlin)",
        "Claude AI usage limit reached|1760540400",
        "5-hour limit reached ∙ resets 7pm",
        "429 Too Many Requests",
        "API Error: Overloaded",
        "RATE LIMITED",
        "usage_limit",
        "Your limit will reset at 5pm",
        "quota exceeded",
        r#"{"type":"error","error":{"type":"rate_limit_error"}}"#,
        r#"{"type":"error","error":{"type":"overloaded_error"}}"#,
    ] {
        assert!(detect(text), "{text}");
    }
    for text in [
        "Authentication required",
        "Invalid API key · Please run /login",
        "error: no such file",
        "port 4290 in use",
        "",
    ] {
        assert!(!detect(text), "{text}");
    }

    let now = now();
    let cases: Vec<(&str, Option<DateTime<Utc>>)> = vec![
        // loop.md **Limits** cases.
        (
            "You've hit your limit · resets 3pm (Europe/Berlin)",
            Some(berlin(2026, 10, 15, 15, 0)),
        ),
        (
            "limit reached ∙ resets 11am (Europe/Berlin)",
            Some(berlin(2026, 10, 16, 11, 0)),
        ),
        (
            "weekly limit · resets Oct 17, 9:30am (Europe/Berlin)",
            Some(berlin(2026, 10, 17, 9, 30)),
        ),
        (
            "Claude AI usage limit reached|1760540400",
            DateTime::from_timestamp(1_760_540_400, 0),
        ),
        (
            "429 rate limit retry-after: 120",
            Some(utc("2026-10-15T11:32:00Z")),
        ),
        (
            "rate limited, try again in 5 minutes",
            Some(utc("2026-10-15T11:35:00Z")),
        ),
        ("resets in 2h 30m", Some(utc("2026-10-15T14:00:00Z"))),
        ("resets 15:00 (UTC)", Some(utc("2026-10-15T15:00:00Z"))),
        (
            "limit resets at 2026-10-16T09:00:00Z",
            Some(utc("2026-10-16T09:00:00Z")),
        ),
        ("429 Too Many Requests", None),
        ("resets 3 things", None),
        // More of each rule.
        ("Retry-After=30", Some(utc("2026-10-15T11:30:30Z"))),
        ("retry after 7", Some(utc("2026-10-15T11:30:07Z"))),
        ("retry in 45s", Some(utc("2026-10-15T11:30:45Z"))),
        ("try again in 1 hr", Some(utc("2026-10-15T12:30:00Z"))),
        (
            "available again in 2 days",
            Some(utc("2026-10-17T11:30:00Z")),
        ),
        ("resets in 1d 2h", Some(utc("2026-10-16T13:30:00Z"))),
        ("try again in 90 seconds", Some(utc("2026-10-15T11:31:30Z"))),
        (
            "resets 2026-10-16T09:00:00+05:30",
            Some(utc("2026-10-16T03:30:00Z")),
        ),
        (
            "until 2026-10-16 09:00:30-0400",
            Some(utc("2026-10-16T13:00:30Z")),
        ),
        // No zone: now's offset.
        ("resets 2026-10-16 09:00", Some(berlin(2026, 10, 16, 9, 0))),
        (
            "5-hour limit reached ∙ resets 7pm",
            Some(berlin(2026, 10, 15, 19, 0)),
        ),
        ("resets at 1:15 PM", Some(berlin(2026, 10, 16, 13, 15))),
        ("resets 12am", Some(berlin(2026, 10, 16, 0, 0))),
        (
            "resets 12pm (Europe/Berlin)",
            Some(berlin(2026, 10, 16, 12, 0)),
        ),
        // Another zone; an unknown one is local.
        (
            "resets 9am (America/New_York)",
            Some(utc("2026-10-15T13:00:00Z")),
        ),
        (
            "resets 3pm (Mars/Olympus)",
            Some(berlin(2026, 10, 15, 15, 0)),
        ),
        // Dates: ordinals, "on", "at", a month spelled out; past → next year; DST in force then.
        (
            "resets on November 2nd at 10am (Europe/Berlin)",
            Some(utc("2026-11-02T09:00:00Z")),
        ),
        (
            "resets Oct. 26, 9am (Europe/Berlin)",
            Some(utc("2026-10-26T08:00:00Z")),
        ),
        ("resets Jan 2, 9am (UTC)", Some(utc("2027-01-02T09:00:00Z"))),
        (
            "resets Oct 15, 1pm (Europe/Berlin)",
            Some(berlin(2027, 10, 15, 13, 0)),
        ),
        // Not times.
        ("resets 25:00", None),
        ("resets 13pm", None),
        ("resets 0am", None),
        ("resets Foo 5, 3pm", None),
        ("resets Feb 30, 3pm", None),
        ("hit your limit", None),
        ("resets 3 times, then 4", None),
        // Too far to be a time: none, never a panic.
        ("rate limit retry-after: 99999999999999", None),
        ("usage limit · resets in 99999999999 days", None),
        ("usage limit · try again in 9223372036854775807 s", None),
        // The first rule that matches wins, the first valid clock time within its rule.
        (
            "resets 3pm|1760540400",
            DateTime::from_timestamp(1_760_540_400, 0),
        ),
        (
            "resets 3 times · resets 4pm",
            Some(berlin(2026, 10, 15, 16, 0)),
        ),
    ];
    for (text, want) in cases {
        assert_eq!(parse_reset(text, now), want, "{text}");
    }
    // `now` is what "local" means: the same clock text in another offset.
    let tokyo = DateTime::parse_from_rfc3339("2026-10-15T20:30:00+09:00").unwrap();
    assert_eq!(
        parse_reset("resets 10pm", tokyo),
        Some(utc("2026-10-15T13:00:00Z"))
    );

    // A failed run's limit: its result, else its stderr; one line, at most 300 chars.
    let long = format!(
        "You've hit your limit · resets 3pm (Europe/Berlin)\n{}",
        "x".repeat(400)
    );
    assert_eq!(
        limits::of_run("opus", true, &long, "", now),
        Some(Limit {
            model: "opus".into(),
            reset: Some(berlin(2026, 10, 15, 15, 0)),
            text: format!(
                "You've hit your limit · resets 3pm (Europe/Berlin) {}…",
                "x".repeat(248)
            ),
        })
    );
    assert_eq!(
        limits::of_run("sonnet", true, "error", "429 Too Many Requests", now),
        Some(Limit {
            model: "sonnet".into(),
            reset: None,
            text: "429 Too Many Requests".into(),
        })
    );
    // A run that didn't fail, or failed for another reason, hit no limit.
    assert_eq!(
        limits::of_run("opus", false, "usage limit reached", "", now),
        None
    );
    assert_eq!(
        limits::of_run("opus", true, "compile error", "boom", now),
        None
    );

    // Backoff without a reset time: 1, 2, 4, … 60 minutes.
    let mins: Vec<u64> = (1..=8).map(|n| limits::backoff(n).as_secs() / 60).collect();
    assert_eq!(mins, [1, 2, 4, 8, 16, 32, 60, 60]);
}
