//! Maintain (MNT): bands in `ops/bands.yaml` and Western Electric detection in code.

mod common;

use common::{git, write};
use towercab::metrics::{METRICS, Metric};

use common::world::World;
use regex::Regex;
use towercab::maintain::bands::{self, Action, PLAYBOOK, Side, Tier};
use towercab::maintain::detect::{self, Verdict};

const DAY: f64 = 86_400.0;

/// 22 baseline points alternating 1 and 2 (mean 1.5, σ ≈ 0.51), then `recent`.
fn series(recent: &[f64]) -> Vec<f64> {
    let mut v: Vec<f64> = (0..22)
        .map(|i| if i % 2 == 0 { 1.0 } else { 2.0 })
        .collect();
    v.extend_from_slice(recent);
    v
}

/// `values` as daily points ending at day 100.
fn points(values: &[f64]) -> Vec<(f64, f64)> {
    let n = values.len();
    values
        .iter()
        .enumerate()
        .map(|(i, v)| ((100 - n + i + 1) as f64 * DAY, *v))
        .collect()
}

fn tier(recent: &[f64], side: Side) -> Option<Tier> {
    detect::detect(&points(&series(recent)), side).map(|v| v.tier)
}

#[test]
fn test_western_electric_rules() {
    let calm = [1.5; 8];
    assert_eq!(tier(&calm, Side::Both), None, "in control");

    // Rule 1: the newest beyond 3σ.
    let mut spike = [1.5; 8];
    spike[7] = 4.0;
    assert_eq!(tier(&spike, Side::Both), Some(Tier::Three));
    assert_eq!(tier(&spike, Side::High), Some(Tier::Three));
    assert_eq!(tier(&spike, Side::Low), None, "the other side only");
    spike[7] = -1.0;
    assert_eq!(tier(&spike, Side::Both), Some(Tier::Three), "both sides");
    assert_eq!(tier(&spike, Side::Low), Some(Tier::Three));
    assert_eq!(tier(&spike, Side::High), None);
    // An older point beyond 3σ alone is no 3σ.
    let mut old = [1.5; 8];
    old[5] = 4.0;
    assert_eq!(tier(&old, Side::Both), None);

    // Rule 2: 2 of the last 3 beyond 2σ on one side (z ≈ 2.54).
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 1.5, 1.5, 2.8, 1.5, 2.8], Side::Both),
        Some(Tier::Two)
    );
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 2.8, 2.8], Side::High),
        Some(Tier::Two)
    );
    // One on each side is no 2σ; only one of the last three is none.
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 1.5, 1.5, 2.8, 1.5, 0.2], Side::Both),
        None
    );
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 1.5, 2.8, 1.5, 1.5, 2.8], Side::Both),
        None
    );

    // Rule 3: 4 of the last 5 beyond 1σ (z ≈ 1.37) on one side.
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 2.2, 2.2, 1.5, 2.2, 2.2], Side::Both),
        Some(Tier::One)
    );
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 0.8, 0.8, 1.5, 0.8, 0.8], Side::Low),
        Some(Tier::One)
    );
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 0.8, 0.8, 1.5, 0.8, 0.8], Side::High),
        None
    );
    // Three of five is none.
    assert_eq!(
        tier(&[1.5, 1.5, 1.5, 2.2, 1.5, 1.5, 2.2, 2.2], Side::Both),
        None
    );

    // Rule 4: the last 8 on one side of the mean (z ≈ 0.2); 7 of 8 is none.
    assert_eq!(tier(&[1.6; 8], Side::Both), Some(Tier::One));
    assert_eq!(tier(&[1.4; 8], Side::Low), Some(Tier::One));
    let mut seven = [1.6; 8];
    seven[0] = 1.4;
    assert_eq!(tier(&seven, Side::Both), None);

    // The highest tier only; the verdict carries the newest point and the baseline.
    let v = detect::detect(
        &points(&series(&[2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 2.8, 4.0])),
        Side::Both,
    )
    .unwrap();
    let (mean, sigma) = detect::stats(&series(&[])).unwrap();
    assert_eq!(
        v,
        Verdict {
            tier: Tier::Three,
            point: (100.0 * DAY, 4.0),
            mean,
            sigma
        }
    );
    assert!((mean - 1.5).abs() < 1e-9);
    // Sample σ: n − 1.
    assert!(
        (sigma - (22.0 * 0.25 / 21.0f64).sqrt()).abs() < 1e-9,
        "{sigma}"
    );
}

#[test]
fn test_short_baseline_no_verdict() {
    let mut spike = vec![1.5; 8];
    spike[7] = 40.0;
    // 14 points before the newest 8: a verdict; 13: none.
    let mut v = series(&spike);
    assert!(detect::detect(&points(&v), Side::Both).is_some());
    v.drain(..8);
    assert_eq!(v.len(), 22);
    assert!(detect::detect(&points(&v), Side::Both).is_some());
    v.remove(0);
    assert_eq!(v.len(), 21);
    assert_eq!(detect::detect(&points(&v), Side::Both), None);
    assert_eq!(detect::detect(&[], Side::Both), None);
    // A flat baseline (σ = 0) judges nothing.
    let mut flat = vec![0.0; 22];
    flat.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
    assert_eq!(detect::detect(&points(&flat), Side::Both), None);
    assert_eq!(detect::baseline(&points(&flat)), None);
}

const BAND: &str = r#"bands:
  ci_failure_rate:
    metric: ci.result
    query: >-
      (sum(sum_over_time({__name__=~"towercab_ci_result(_total)?",result="red"}[1d])) or vector(0))
      / sum(sum_over_time({__name__=~"towercab_ci_result(_total)?"}[1d]))
    period: 1d
    baseline: rolling_30d
    rules: western_electric
    side: high
    repo: web
    tiers:
      1sigma: {action: log}
      2sigma: {action: diagnose}
      3sigma: {action: propose, routes: [pull_request, runbook:cap_repo, runbook:pause]}
"#;

#[test]
fn test_parse_bands() {
    let b = bands::parse(BAND).unwrap();
    assert_eq!(b.len(), 1);
    let b = &b[0];
    assert_eq!(
        (
            b.name.as_str(),
            b.metric.as_str(),
            b.period,
            b.baseline,
            b.side,
            b.repo.as_deref()
        ),
        (
            "ci_failure_rate",
            "ci.result",
            86_400,
            30 * 86_400,
            Side::High,
            Some("web")
        )
    );
    assert!(b.query.starts_with("(sum(sum_over_time({__name__"));
    assert!(!b.query.contains('\n'), "folded: {}", b.query);
    assert_eq!(b.points(), 30);
    assert_eq!(
        b.tiers,
        [
            Action::Log,
            Action::Diagnose,
            Action::Propose {
                pull_request: true,
                cap_repo: true,
                pause: true
            }
        ]
    );
    // The last completed period's end: 10 min after midnight UTC.
    let day = 20_000.0 * DAY;
    assert_eq!(b.end(day + 599.0), day - DAY);
    assert_eq!(b.end(day + 600.0), day);

    // Defaults: period 1d, baseline 30d, side both, Western Electric, the playbook's tiers.
    let b = bands::parse("bands:\n  cost:\n    metric: intent.cost\n    query: sum(x)\n").unwrap();
    assert_eq!(
        (b[0].period, b[0].baseline, b[0].side, b[0].repo.clone()),
        (86_400, 30 * 86_400, Side::Both, None)
    );
    assert_eq!(b[0].tiers, PLAYBOOK);
    // A tier left out keeps the playbook's; propose without routes → a pull request; weeks.
    let b = bands::parse(
        "bands:\n  cfr:\n    metric: escapes\n    query: q\n    period: 1w\n    baseline: rolling_182d\n    tiers:\n      3sigma: {action: propose}\n      1sigma: {action: diagnose}\n",
    )
    .unwrap();
    assert_eq!((b[0].period, b[0].points()), (7 * 86_400, 26));
    assert_eq!(b[0].tiers[0], Action::Diagnose);
    assert_eq!(b[0].tiers[1], Action::Diagnose);
    assert_eq!(b[0].tiers[2], PLAYBOOK[2]);
    assert_eq!(bands::parse("").unwrap(), vec![]);
    assert_eq!(bands::parse("bands:\n").unwrap(), vec![]);

    for (yaml, why) in [
        ("other: 1\n", "ops/bands.yaml: unknown key other"),
        ("bands: [a]\n", "ops/bands.yaml: bands is a map"),
        (
            "bands:\n  Bad-Name:\n    metric: ci.result\n    query: q\n",
            "Bad-Name: a band name is [a-z0-9_]+",
        ),
        ("bands:\n  b:\n    query: q\n", "b: metric is required"),
        (
            "bands:\n  b:\n    metric: nope\n    query: q\n",
            "b: metric nope isn't one of metrics::METRICS",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n",
            "b: query is required",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    colour: red\n",
            "b: unknown key colour",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    period: 1m\n",
            "b: period 1m: <n>h, <n>d or <n>w",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    baseline: 30d\n",
            "b: baseline 30d: rolling_<n>d",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    period: 1w\n",
            "b: baseline holds 4 periods, fewer than 22",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    rules: nelson\n",
            "b: rules nelson: only western_electric",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    side: up\n",
            "b: side up: high, low or both",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    tiers:\n      4sigma: {action: log}\n",
            "b: unknown tier 4sigma",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    tiers:\n      1sigma: {action: shout}\n",
            "b: 1sigma: unknown action shout",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    tiers:\n      2sigma: {action: diagnose, routes: [pull_request]}\n",
            "b: 2sigma: routes only with action: propose",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    tiers:\n      3sigma: {action: propose, routes: [runbook:reboot]}\n",
            "b: 3sigma: unknown route runbook:reboot",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    repo: ../x\n",
            "b: repo ../x isn't a repo name",
        ),
    ] {
        let e = bands::parse(yaml).unwrap_err();
        assert!(e.ends_with(why), "{yaml}: {e}");
        assert!(e.starts_with("ops/bands.yaml: "), "{e}");
    }

    // Read from the Towercab repo's base in its clone; none without the repo or the file.
    let mut w = World::new(&[], &["towercab"]);
    assert_eq!(
        bands::read(&w.config, &w.exes()).unwrap(),
        Some(vec![]),
        "no file"
    );
    push_bands(&w, BAND);
    assert_eq!(
        bands::read(&w.config, &w.exes()).unwrap(),
        Some(bands::parse(BAND).unwrap())
    );
    push_bands(&w, "bands: 3\n");
    assert!(bands::read(&w.config, &w.exes()).is_err());
    let clone = w.clone_path("towercab");
    w.repo_mut("towercab").path = w.root.join("no-clone");
    assert_eq!(bands::read(&w.config, &w.exes()).unwrap(), None, "no clone");
    w.repo_mut("towercab").path = clone;
    w.config.repos.clear();
    assert_eq!(bands::read(&w.config, &w.exes()).unwrap(), None, "no repo");
}

#[test]
fn test_default_bands() {
    let text = common::read("ops/bands.yaml");
    let all = bands::parse(&text).unwrap();
    let names: Vec<&str> = all.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "ci_failure_rate",
            "cycle_time",
            "cost_per_intent",
            "change_failure_rate",
            "eval_pass_rate"
        ]
    );
    let mut bases: Vec<String> = METRICS.iter().map(|m| m.name().replace('.', "_")).collect();
    bases.sort_by_key(|b| std::cmp::Reverse(b.len()));
    let name = Regex::new(r"towercab_[a-z_]+").unwrap();
    let banned = Regex::new(r"(^|[^A-Za-z0-9_])(rate|irate|increase)\(").unwrap();
    let window = Regex::new(r"\[(\w+)\]").unwrap();
    for b in &all {
        let (period, days, side) = match b.name.as_str() {
            "change_failure_rate" => ("1w", 182, Side::High),
            "eval_pass_rate" => ("1d", 182, Side::Low),
            _ => ("1d", 30, Side::High),
        };
        assert_eq!(
            (b.period, b.baseline, b.side),
            (
                if period == "1w" { 7 * 86_400 } else { 86_400 },
                days * 86_400,
                side
            ),
            "{}",
            b.name
        );
        assert!(Metric::by_name(&format!("towercab.{}", b.metric)).is_some());
        // Every name a Towercab metric; delta series summed, never rate or increase; the
        // window is the period; one series.
        for m in name.find_iter(&b.query) {
            let n = m.as_str();
            assert!(
                bases
                    .iter()
                    .any(|x| n == x || n.starts_with(&format!("{x}_"))),
                "{}: {n} isn't in metrics::METRICS",
                b.name
            );
        }
        assert!(!banned.is_match(&b.query), "{}: {}", b.name, b.query);
        let windows: Vec<&str> = window
            .captures_iter(&b.query)
            .map(|c| c.get(1).unwrap().as_str())
            .collect();
        assert!(
            !windows.is_empty() && windows.iter().all(|w| *w == period),
            "{}: {windows:?}",
            b.name
        );
        let summed = if b.name == "eval_pass_rate" {
            b.query.starts_with("max(last_over_time(") && b.query.contains(r#"kind="baseline""#)
        } else {
            b.query.contains("sum_over_time(")
                && (b.query.starts_with("(sum(")
                    || b.query.starts_with("histogram_quantile(0.5, sum by (le)"))
        };
        assert!(summed, "{}: {}", b.name, b.query);
        assert_eq!(b.tiers[0], Action::Log);
        assert_eq!(b.tiers[1], Action::Diagnose);
        assert_eq!(
            b.tiers[2],
            Action::Propose {
                pull_request: true,
                cap_repo: false,
                pause: b.name != "cycle_time"
            },
            "{}",
            b.name
        );
    }
    let q = |n: &str| all.iter().find(|b| b.name == n).unwrap().query.clone();
    assert!(q("ci_failure_rate").contains(r#"result="red""#));
    assert!(q("cycle_time").contains(r#"kind="cycle",outcome="done""#));
    assert!(q("cost_per_intent").contains("towercab_intent_cost(_USD)?_bucket"));
    assert!(q("change_failure_rate").contains(r#"where="e2e""#));
    assert!(q("change_failure_rate").contains(r#"outcome=~"done|reverted|revert_failed""#));
}

/// `bands.yaml` on the Towercab repo's `main`, fetched into Towercab's clone.
fn push_bands(w: &World, text: &str) {
    let mine = w.mine("towercab");
    write(&mine, "ops/bands.yaml", text);
    git(&mine, &["add", "-A"]);
    git(&mine, &["commit", "--quiet", "-m", "bands"]);
    git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
    git(&w.clone_path("towercab"), &["fetch", "--quiet", "origin"]);
}
