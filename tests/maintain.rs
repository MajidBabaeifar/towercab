//! Maintain (MNT): bands in `ops/bands.yaml`, Western Electric detection in code, Prometheus
//! on a helper thread, breach events with their tiers' actions (log, a diagnosis drafted into an
//! intent PR, 3σ runbooks and the triage message), triage counts, lessons and incident cases.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::http::{FakeHttp, dead_url};
use common::world::World;
use common::{exe, git, github_git, write};
use regex::Regex;
use serde_json::{Value, json};
use towercab::db::Db;
use towercab::drafts;
use towercab::env;
use towercab::exes::Exes;
use towercab::handler::Handlers;
use towercab::machine;
use towercab::maintain;
use towercab::maintain::bands::{self, Action, PLAYBOOK, Side, Tier};
use towercab::maintain::detect::{self, Verdict};
use towercab::maintain::diagnose::DIAGNOSIS_SCHEMA;
use towercab::metrics::{self, METRICS, Metric, Record};
use towercab::runloop::Loop;

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
    detect::detect(&points(&series(recent)), side, 0.0).map(|v| v.tier)
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
        0.0,
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
    assert!(detect::detect(&points(&v), Side::Both, 0.0).is_some());
    v.drain(..8);
    assert_eq!(v.len(), 22);
    assert!(detect::detect(&points(&v), Side::Both, 0.0).is_some());
    v.remove(0);
    assert_eq!(v.len(), 21);
    assert_eq!(detect::detect(&points(&v), Side::Both, 0.0), None);
    assert_eq!(detect::detect(&[], Side::Both, 0.0), None);
    // A flat baseline (σ = 0) judges nothing.
    let mut flat = vec![0.0; 22];
    flat.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
    assert_eq!(detect::detect(&points(&flat), Side::Both, 0.0), None);
    assert_eq!(detect::baseline(&points(&flat)), None);
    // So is one whose σ is only rounding: 0.1 or 0.9 summed isn't exact.
    for (n, x, newest) in [(22, 0.1, 0.12), (174, 0.9, 0.88)] {
        let mut v = vec![x; n];
        assert!(detect::stats(&v).unwrap().1 > 0.0, "σ isn't exactly 0");
        v.extend_from_slice(&[x, x, x, x, x, x, x, newest]);
        let pts: Vec<(f64, f64)> = v
            .iter()
            .enumerate()
            .map(|(i, x)| (i as f64 * DAY, *x))
            .collect();
        assert_eq!(detect::baseline(&pts), None, "{n} × {x}");
        assert_eq!(detect::detect(&pts, Side::Both, 0.0), None);
    }
}

#[test]
fn test_min_shift() {
    // A sparse rate: σ ≈ 0.002 makes a drop of 0.02 "beyond 3σ" (z ≈ −9).
    let mut base = vec![0.9; 21];
    base.push(0.89);
    let with = |recent: &[f64], min_shift: f64| {
        let mut v = base.clone();
        v.extend_from_slice(recent);
        detect::detect(&points(&v), Side::Low, min_shift).map(|v| v.tier)
    };
    let dip = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.88];
    assert_eq!(with(&dip, 0.0), Some(Tier::Three));
    // At least min_shift from the mean, or it never counts: no rule fires on 0.02.
    assert_eq!(with(&dip, 0.05), None);
    assert_eq!(with(&[0.88; 8], 0.05), None, "nor 2σ, 1σ or one side");
    assert_eq!(with(&[0.88; 8], 0.0), Some(Tier::Three));
    // A real drop still breaches.
    assert_eq!(
        with(&[0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.8], 0.05),
        Some(Tier::Three)
    );
    // beyond: strictly more than kσ, at least min_shift, on the side.
    assert!(detect::beyond(0.06, 0.01, 3.0, 0.05, Side::High));
    assert!(!detect::beyond(0.04, 0.01, 3.0, 0.05, Side::High));
    assert!(!detect::beyond(0.03, 0.01, 3.0, 0.0, Side::High));
    assert!(detect::beyond(-0.06, 0.01, 3.0, 0.05, Side::Both));
    assert!(!detect::beyond(-0.06, 0.01, 3.0, 0.05, Side::High));
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
    min_shift: 0.05
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
    assert_eq!(b.min_shift, 0.05);
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
        (
            b[0].period,
            b[0].baseline,
            b[0].side,
            b[0].min_shift,
            b[0].repo.clone()
        ),
        (86_400, 30 * 86_400, Side::Both, 0.0, None)
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
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    min_shift: -0.1\n",
            "b: min_shift -0.1: a number ≥ 0",
        ),
        (
            "bands:\n  b:\n    metric: ci.result\n    query: q\n    min_shift: some\n",
            "b: min_shift some: a number ≥ 0",
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
        // Rates move by at least 0.05 to count; durations and costs by any amount.
        let min_shift = match b.name.as_str() {
            "cycle_time" | "cost_per_intent" => 0.0,
            _ => 0.05,
        };
        assert_eq!(
            (b.period, b.baseline, b.side, b.min_shift),
            (
                if period == "1w" { 7 * 86_400 } else { 86_400 },
                days * 86_400,
                side,
                min_shift
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

/// A fake `gh` for drafts in `dir`, as tests/drafts.rs's, plus PR comments: `pr comment <n>`
/// appends its body to `prcomments-<n>`; `pr view <n> … --json comments` lists them (by `me`).
fn fake_gh(dir: &Path) -> PathBuf {
    let path = dir.join("gh");
    exe(
        &path,
        &format!(
            r#"d='{d}'
echo "${{GH_TOKEN:--}} $*" >> "$d/gh.log"
case "$1 $2" in
  "issue list") echo '[]' ;;
  "pr list") echo '[]' ;;
  "pr create")
    n=$(($(cat "$d/prs" 2>/dev/null || echo 4) + 1)); echo $n > "$d/prs"
    prev=''
    for a in "$@"; do
      [ "$prev" = --title ] && printf '%s' "$a" > "$d/title-$n"
      [ "$prev" = --body ] && printf '%s' "$a" > "$d/body-$n"
      prev="$a"
    done
    echo "https://github.com/me/intents/pull/$n" ;;
  "pr comment") printf '%s\n' "$7" >> "$d/prcomments-$3" ;;
  "pr view")
    if [ "$7" = comments ]; then
      f="$d/prcomments-$3"
      printf '{{"comments":['
      if [ -f "$f" ]; then sep=''; while IFS= read -r l; do printf '%s{{"author":{{"login":"me"}},"body":"%s"}}' "$sep" "$l"; sep=','; done < "$f"; fi
      printf ']}}\n'
    else
      cat "$d/pr-$3.json" 2>/dev/null || echo '{{"state":"OPEN"}}'
    fi ;;
  *) echo "fake gh: $*" >&2; exit 1 ;;
esac
"#,
            d = dir.display()
        ),
    );
    path
}

/// A fake diagnosis: logs argv and stdin (`claude-<n>.argv`, `.stdin`); answers
/// `diagnosis.json` as `structured_output`.
fn fake_claude(dir: &Path) -> PathBuf {
    let path = dir.join("claude");
    exe(
        &path,
        &format!(
            r#"[ "$1" = --version ] && echo '2.1.0 (Claude Code)' && exit 0
d='{d}'
n=$(($(cat "$d/runs" 2>/dev/null || echo 0) + 1))
: > "$d/claude-$n.argv"
for a in "$@"; do printf '%s\n' "$a" >> "$d/claude-$n.argv"; done
cat > "$d/claude-$n.stdin"
printf '{{"type":"result","subtype":"success","is_error":false,"result":"ok","modelUsage":{{"claude-opus-4":{{"inputTokens":5,"outputTokens":1,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.05}}}},"structured_output":%s}}\n' "$(cat "$d/diagnosis.json")"
echo "$n" > "$d/runs"
"#,
            d = dir.display()
        ),
    );
    path
}

/// The points the fake Prometheus serves: the newest at the query's `end`, a step apart.
type Values = Arc<Mutex<Vec<f64>>>;

fn param(path: &str, key: &str) -> Option<f64> {
    path.split(['?', '&'])
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
        .and_then(|v| v.parse().ok())
}

/// A fake Prometheus on 127.0.0.1 answering `query_range` from `values` (after `delay`).
fn fake_prometheus(values: Values, delay: Duration) -> FakeHttp {
    FakeHttp::start(move |req| {
        std::thread::sleep(delay);
        let (Some(start), Some(end), Some(step)) = (
            param(&req.path, "start"),
            param(&req.path, "end"),
            param(&req.path, "step"),
        ) else {
            return (
                400,
                json!({"status": "error", "error": "bad query"}).to_string(),
            );
        };
        let n = ((end - start) / step) as usize + 1;
        let v = values.lock().unwrap();
        let take = v.len().min(n);
        let pts: Vec<Value> = v[v.len() - take..]
            .iter()
            .enumerate()
            .map(|(i, x)| json!([end - (take - 1 - i) as f64 * step, x.to_string()]))
            .collect();
        let result = if pts.is_empty() {
            json!([])
        } else {
            json!([{"metric": {}, "values": pts}])
        };
        (
            200,
            json!({"status": "success", "data": {"resultType": "matrix", "result": result}})
                .to_string(),
        )
    })
}

/// A world with the Towercab repo (its `bands.yaml`), repo `web`, `[intents].remote` on
/// "GitHub" (the bare repo through the git wrapper), fake `gh` and diagnosis, and a fake
/// Prometheus.
struct Mnt {
    w: World,
    bin: PathBuf,
    exes: Exes,
    prom: FakeHttp,
    values: Values,
}

impl Mnt {
    fn new(bands_yaml: &str, values: &[f64]) -> Mnt {
        Mnt::with(&[], bands_yaml, values, Duration::ZERO)
    }

    fn with(files: &[(String, String)], bands_yaml: &str, values: &[f64], delay: Duration) -> Mnt {
        let mut w = World::new(files, &["towercab", "web"]);
        drop(w.intents.store());
        let hub = w.root.join("hub");
        fs::create_dir_all(hub.join("me")).unwrap();
        std::os::unix::fs::symlink(&w.intents.remote, hub.join("me/intents.git")).unwrap();
        w.config.intents.remote = Some("https://github.com/me/intents.git".into());
        let bin = w.root.join("mnt-bin");
        let exes = Exes {
            git: github_git(&bin, &hub).into(),
            gh: fake_gh(&bin).into(),
            claude: fake_claude(&bin).into(),
            ..w.exes()
        };
        push_bands(&w, bands_yaml);
        let values: Values = Arc::new(Mutex::new(values.to_vec()));
        let prom = fake_prometheus(Arc::clone(&values), delay);
        w.config.metrics.prometheus = prom.url.clone();
        fs::write(
            bin.join("diagnosis.json"),
            json!({
                "title": "Stop the CI failure spike", "problem": "CI fails far more often since PR 7.\nIt flakes on login.",
                "evidence": "red on 6 of the last 8 days", "outcome": ["CI red rate back under 20%"],
                "affected": "every intent's CI", "open_questions": [],
                "u": 4, "i": 3, "why_u": "every PR waits", "why_i": "all repos",
                "cause": "https://github.com/me/web/pull/7",
            })
            .to_string(),
        )
        .unwrap();
        Mnt {
            w,
            bin,
            exes,
            prom,
            values,
        }
    }

    /// A loop that never picks (no stage handlers).
    fn open(&self) -> Loop {
        self.w
            .open_with(Handlers::picks_off(), self.exes.clone(), Default::default())
    }

    fn db(&self) -> Db {
        self.w.db()
    }

    /// Passes 61 s apart (a moment between them for the query thread and children) until
    /// `done`.
    fn until(&mut self, lp: &mut Loop, done: impl Fn(&Mnt) -> bool) {
        for _ in 0..300 {
            if done(self) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
            self.w.pass(lp);
        }
        let lessons: Vec<(String, String)> = {
            let db = self.db();
            let mut q = db
                .conn()
                .prepare("SELECT intent, step FROM lessons")
                .unwrap();
            q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        panic!(
            "not reached: breaches {:?}, lessons {lessons:?}",
            self.breaches()
        );
    }

    /// The next day's value: pushed, the clock a day on, passes until the band has judged it.
    fn day(&mut self, lp: &mut Loop, value: f64) {
        self.values.lock().unwrap().push(value);
        self.w.pass_after(lp, 86_400);
        let end = ((self.w.clock.unix() - 600.0) / DAY).floor() * DAY;
        for _ in 0..400 {
            if lp.watch.checked("ci_failure_rate") == Some(end) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
            self.w.pass(lp);
        }
        panic!("day {end} not judged: breaches {:?}", self.breaches());
    }

    /// The band's open episode: (drafted, proposed).
    fn episode(&self) -> Option<(bool, bool)> {
        maintain::episode(self.db().conn(), "ci_failure_rate").unwrap()
    }

    /// `triage:` messages so far.
    fn triage(&self) -> usize {
        self.w
            .outbox()
            .into_iter()
            .filter(|(_, e, _, _)| e.starts_with("triage:"))
            .count()
    }

    /// (band, tier, step) of each breach.
    fn breaches(&self) -> Vec<(String, String, String)> {
        let db = self.db();
        let mut q = db
            .conn()
            .prepare("SELECT band, tier, step FROM breaches ORDER BY at, point")
            .unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn draft(&self) -> Option<towercab::db::DraftRow> {
        drafts::get(self.db().conn(), "alert:ci_failure_rate")
            .unwrap()
            .map(|(_, r)| r)
    }

    fn log(&self, name: &str) -> String {
        fs::read_to_string(self.bin.join(name)).unwrap_or_default()
    }

    /// Calls the fake gh got whose args start with `prefix`.
    fn gh(&self, prefix: &str) -> Vec<String> {
        self.log("gh.log")
            .lines()
            .filter_map(|l| l.split_once(' ').map(|(_, a)| a.to_string()))
            .filter(|a| a.starts_with(prefix))
            .collect()
    }

    /// Prometheus requests so far.
    fn queries(&self) -> usize {
        self.prom.requests.lock().unwrap().len()
    }

    /// Every metric record: spooled (the dead collector) and still buffered.
    fn records(&self) -> Vec<Record> {
        metrics::spool_read(&self.w.home.root.join("metrics.jsonl"), usize::MAX)
            .into_iter()
            .chain(metrics::take())
            .collect()
    }
}

/// The 3σ spike series, newest = 4.0.
fn spike() -> Vec<f64> {
    let mut recent = [1.5; 8];
    recent[7] = 4.0;
    series(&recent)
}

#[test]
fn test_breach_once_per_point() {
    // The period just ended has no value (NaN is skipped): yesterday's 3σ point is the newest,
    // judged when it was new: no verdict now.
    let mut stale = spike();
    stale.push(f64::NAN);
    let mut m = Mnt::new(BAND, &stale);
    let mut lp = m.open();
    for _ in 0..400 {
        if lp.watch.checked("ci_failure_rate").is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
        m.w.pass(&mut lp);
    }
    assert!(lp.watch.checked("ci_failure_rate").is_some());
    assert!(m.breaches().is_empty(), "{:?}", m.breaches());
    assert!(!maintain::fresh(&[(DAY, 1.0)], 2.0 * DAY));
    assert!(maintain::fresh(&[(DAY, 1.0), (2.0 * DAY, 1.0)], 2.0 * DAY));
    assert!(!maintain::fresh(&[], 2.0 * DAY));
    drop(lp);

    let mut m = Mnt::new(
        &BAND.replace("runbook:cap_repo, runbook:pause", ""),
        &spike(),
    );
    let mut lp = m.open();
    m.until(&mut lp, |m| !m.breaches().is_empty());
    assert_eq!(
        m.breaches(),
        [("ci_failure_rate".into(), "3sigma".into(), "diagnose".into())]
    );
    // The query: range, step = period, 30 points ending at the last completed day.
    let req = m.prom.requests.lock().unwrap()[0].clone();
    assert!(
        req.path
            .starts_with("/api/v1/query_range?query=%28sum%28sum_over_time%28%7B__name__")
    );
    let end = (m.w.clock.unix() / DAY).floor() * DAY;
    assert_eq!(param(&req.path, "end"), Some(end));
    assert_eq!(param(&req.path, "start"), Some(end - 29.0 * DAY));
    assert_eq!(param(&req.path, "step"), Some(DAY));
    let row: (f64, f64, f64, f64) = m
        .db()
        .conn()
        .query_row("SELECT point, value, mean, sigma FROM breaches", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    assert_eq!((row.0, row.1), (end, 4.0));
    assert!((row.2 - 1.5).abs() < 1e-9 && row.3 > 0.5);

    // Later rounds the same day don't query again; a restart evaluates once more: the same
    // point → the same event, once.
    for _ in 0..12 {
        m.w.pass(&mut lp);
    }
    assert_eq!(m.queries(), 1);
    drop(lp);
    let mut lp = m.open();
    m.until(&mut lp, |m| m.queries() == 2);
    for _ in 0..3 {
        std::thread::sleep(Duration::from_millis(20));
        m.w.pass(&mut lp);
    }
    assert_eq!(m.breaches().len(), 1);
    let triage: Vec<_> =
        m.w.outbox()
            .into_iter()
            .filter(|(_, e, _, _)| e.starts_with("triage:"))
            .collect();
    assert_eq!(triage.len(), 1, "{triage:?}");
    let events: Vec<Record> = m
        .records()
        .into_iter()
        .filter(|r| r.metric == Metric::Breaches)
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(
        (events[0].label("band"), events[0].label("tier")),
        (Some("ci_failure_rate"), Some("3sigma"))
    );
}

#[test]
fn test_prometheus_never_blocks_a_pass() {
    let mut m = Mnt::with(&[], BAND, &series(&[1.5; 8]), Duration::from_secs(3));
    let mut lp = m.open();
    m.w.pass(&mut lp);
    assert!(lp.watch.fetching(), "the round started its queries");
    let t = Instant::now();
    m.w.pass(&mut lp);
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    assert!(lp.watch.fetching());
    for _ in 0..400 {
        if lp.watch.checked("ci_failure_rate").is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
        m.w.pass(&mut lp);
    }
    assert!(lp.watch.checked("ci_failure_rate").is_some());

    // A dead Prometheus: no fault, the band stays due and is asked again next round.
    let mut m = Mnt::new(BAND, &[]);
    m.w.config.metrics.prometheus = dead_url();
    let mut lp = m.open();
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(20));
        m.w.pass(&mut lp);
    }
    assert_eq!(lp.watch.checked("ci_failure_rate"), None);
    assert!(env::faults(m.db().conn()).unwrap().is_empty());
    assert!(m.breaches().is_empty());
}

#[test]
fn test_tier_log() {
    let mut m = Mnt::new(BAND, &series(&[1.5, 1.5, 1.5, 2.2, 2.2, 1.5, 2.2, 2.2]));
    let mut lp = m.open();
    m.until(&mut lp, |m| !m.breaches().is_empty());
    for _ in 0..6 {
        m.w.pass(&mut lp);
    }
    assert_eq!(
        m.breaches(),
        [("ci_failure_rate".into(), "1sigma".into(), "done".into())]
    );
    assert!(m.draft().is_none(), "no draft");
    assert!(m.w.outbox().is_empty(), "no message");
    assert!(!machine::paused(m.db().conn()).unwrap());
    assert_eq!(m.log("runs"), "", "no Claude run");
}

/// A merged mission of intent `261010-0900` on `web` (PR 7, merged by me) `ago` seconds
/// before the clock, its merge (→ `deploy`) a transition.
fn merged_pr(m: &Mnt, ago: f64) {
    let t = m.w.clock.unix() - ago;
    let db = m.db();
    db.conn()
        .execute(
            "INSERT INTO missions (intent, repo, stage, step, model, session, checkout, pr, pr_url,
               merged_by, created, updated, finished)
             VALUES ('261010-0900', 'web', 'done', '', 'opus', 's', 'work/x', 7,
               'https://github.com/me/web/pull/7', 'human', ?1, ?1, ?1)",
            [t - 3600.0],
        )
        .unwrap();
    let id = db.conn().last_insert_rowid();
    db.conn()
        .execute(
            "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why)
             VALUES (?1, ?2, 'merge', 'ok', 'deploy', NULL)",
            rusqlite::params![id, t],
        )
        .unwrap();
}

/// The 2σ series: the last two points z ≈ 2.54.
fn two_sigma() -> Vec<f64> {
    series(&[1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 2.8, 2.8])
}

#[test]
fn test_diagnosis_drafts_intent() {
    let lesson = "# Lesson: Old one\n\n- Cause: a flaky test\n";
    let mut m = Mnt::with(
        &[("lessons/261001-old-one.md".into(), lesson.into())],
        BAND,
        &two_sigma(),
        Duration::ZERO,
    );
    m.w.config.agent.model = "sonnet".into();
    merged_pr(&m, 2.0 * DAY);
    let mut lp = m.open();
    m.until(&mut lp, |m| m.draft().is_some_and(|d| d.step == "open"));
    assert_eq!(
        m.breaches(),
        [("ci_failure_rate".into(), "2sigma".into(), "done".into())]
    );
    let row = m.draft().unwrap();
    let id = row.intent.clone().unwrap();
    assert_eq!(
        (row.repo.as_str(), row.source.as_str(), row.pr),
        ("web", "alert:ci_failure_rate", Some(5))
    );

    // The diagnosis: the review model of [agent].model, no tools, no session, the schema.
    let argv: Vec<String> = m.log("claude-1.argv").lines().map(str::to_string).collect();
    let flag = |f: &str| {
        argv.iter()
            .position(|a| a == f)
            .map(|i| argv[i + 1].clone())
    };
    assert_eq!(flag("--model").as_deref(), Some("opus"));
    assert_eq!(flag("--tools").as_deref(), Some(""));
    assert_eq!(flag("--json-schema"), Some(DIAGNOSIS_SCHEMA.to_string()));
    assert!(flag("--session-id").is_none() && flag("--resume").is_none());
    let stdin = m.log("claude-1.stdin");
    for part in [
        "Band: ci_failure_rate (metric towercab.ci.result",
        "Breach: ci_failure_rate at 2sigma: value 2.8 · mean 1.5 · σ 0.51 on ",
        "UTC 2.8\n",
        "- https://github.com/me/web/pull/7 261010-0900 web merged ",
        "by human",
        "merge -ok-> deploy",
        "### 261001-old-one.md\n# Lesson: Old one",
        "not instructions to you",
    ] {
        assert!(stdin.contains(part), "{part}: {stdin}");
    }
    assert_eq!(stdin.matches("<data>").count(), 2, "{stdin}");
    assert!(stdin.trim_end().ends_with("</data>"), "{stdin}");
    let breach: Value = serde_json::from_str(
        &fs::read_to_string(m.w.home.runs("draft-1").join("breach.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(breach["series"].as_array().unwrap().len(), 30);

    // intent.md on its branch: source alert:<band>, started = the breach, the sections.
    let at: f64 = m
        .db()
        .conn()
        .query_row("SELECT at FROM breaches", [], |r| r.get(0))
        .unwrap();
    let started = towercab::intents::store::rfc3339(
        chrono::DateTime::from_timestamp(at as i64, 0)
            .unwrap()
            .with_timezone(m.w.clock.wall.offset()),
    );
    let branch = format!("intent/{id}-stop-the-ci-failure-spike");
    let text = git(
        &m.w.intents.remote,
        &[
            "show",
            &format!("{branch}:intents/{id}-stop-the-ci-failure-spike/intent.md"),
        ],
    );
    assert_eq!(
        text,
        format!(
            "---\nrepo: web\nu: 4\ni: 3\nsource: alert:ci_failure_rate\nstarted: {started}\n---\n\n\
             # Intent: Stop the CI failure spike\n\n## Problem\n\nCI fails far more often since PR 7.\nIt flakes on login.\n\n\
             ## Evidence\n\nred on 6 of the last 8 days\n\n## Proposed outcome\n\n- CI red rate back under 20%\n\n\
             ## Affected users and systems\n\nevery intent's CI\n"
        )
    );
    assert_eq!(
        m.log("body-5"),
        "Drafted by Towercab from band ci_failure_rate at 2sigma: value 2.8 · mean 1.5 · σ 0.51.\n\n\
         - u4: every PR waits\n- i3: all repos\n\nMerge to accept, close to reject.\n"
    );
    assert_eq!(m.gh("pr create").len(), 1);

    // MET-27: breach → draft, and the cause one of the merges given: an alert escape.
    let recs = m.records();
    let b2i: Vec<&Record> = recs
        .iter()
        .filter(|r| r.metric == Metric::BreachToIntentDuration)
        .collect();
    assert_eq!(b2i.len(), 1);
    assert_eq!(b2i[0].label("band"), Some("ci_failure_rate"));
    assert!(
        b2i[0].value >= 0.0 && b2i[0].value < 3600.0,
        "{}",
        b2i[0].value
    );
    let esc: Vec<&Record> = recs
        .iter()
        .filter(|r| r.metric == Metric::Escapes && r.label("where") == Some("alert"))
        .collect();
    assert_eq!(esc.len(), 1);
    assert_eq!(esc[0].label("repo"), Some("web"));
    // Its cost as agent `diagnose` (MET-16).
    assert!(recs.iter().any(|r| r.metric == Metric::CostUsd
        && r.label("agent") == Some("diagnose")
        && r.label("stage") == Some("draft")));
}

#[test]
fn test_one_draft_per_band() {
    let mut m = Mnt::new(BAND, &two_sigma());
    // A cause not among the merges given: no alert escape.
    let mut lp = m.open();
    m.until(&mut lp, |m| m.draft().is_some_and(|d| d.step == "open"));
    assert_eq!(m.log("runs").trim(), "1");

    // The next day's point breaches again: a comment on the open draft, once; no new draft.
    m.w.pass_after(&mut lp, 86_400);
    m.until(&mut lp, |m| {
        m.breaches().len() == 2 && m.breaches()[1].2 == "done"
    });
    let comments = m.gh("pr comment");
    assert_eq!(comments.len(), 1, "{comments:?}");
    let day2 = ((m.w.clock.unix() - 600.0) / DAY).floor() * DAY;
    assert_eq!(
        comments[0],
        format!(
            "pr comment 5 -R me/intents --body Breach: ci_failure_rate at 2sigma · value 2.8 · mean 1.5 · σ 0.51 · {}",
            chrono::DateTime::from_timestamp(day2 as i64, 0)
                .unwrap()
                .format("%Y-%m-%d %H:%M UTC")
        )
    );
    assert_eq!(m.gh("pr create").len(), 1);
    assert_eq!(m.log("runs").trim(), "1", "no second diagnosis");
    // A restart re-evaluates: no new breach, no second comment.
    drop(lp);
    let mut lp = m.open();
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(20));
        m.w.pass(&mut lp);
    }
    assert_eq!(m.breaches().len(), 2);
    assert_eq!(m.gh("pr comment").len(), 1);
    assert!(
        !m.records()
            .iter()
            .any(|r| r.metric == Metric::Escapes && r.label("where") == Some("alert")),
        "the cause wasn't a merge given"
    );
    // A comment already there (mine, or one a crash left before `done`) isn't made again.
    let text = maintain::comment_text("ci_failure_rate", "2sigma", 3.0 * DAY, 2.8, 1.5, 0.51);
    fs::write(
        m.bin.join("prcomments-5"),
        format!("{}\n", m.log("prcomments-5") + &text),
    )
    .unwrap();
    m.db()
        .conn()
        .execute(
            "INSERT INTO breaches (band, tier, point, value, mean, sigma, at, step)
             VALUES ('ci_failure_rate', '2sigma', ?1, 2.8, 1.5, 0.51, ?1, 'comment')",
            [3.0 * DAY],
        )
        .unwrap();
    m.until(&mut lp, |m| m.breaches().iter().all(|b| b.2 == "done"));
    assert_eq!(m.gh("pr comment").len(), 1);

    // Merged: the episode goes on (no draft) until the band is back within 1σ; its next
    // breach is a new episode and drafts anew (a new row, PR, diagnosis).
    fs::write(m.bin.join("pr-5.json"), r#"{"state":"MERGED"}"#).unwrap();
    m.until(&mut lp, |m| m.draft().is_some_and(|d| d.step == "accepted"));
    m.day(&mut lp, 1.5);
    assert_eq!(m.breaches().last().unwrap().1, "2sigma", "2 of the last 3");
    assert!(m.episode().is_some());
    assert_eq!(m.gh("pr create").len(), 1);
    m.day(&mut lp, 1.5);
    assert_eq!(m.episode(), None, "back within 1σ");
    m.day(&mut lp, 2.8);
    assert_eq!(m.episode(), None, "beyond 1σ alone opens nothing");
    m.day(&mut lp, 2.8);
    m.until(&mut lp, |m| {
        m.draft()
            .is_some_and(|d| d.step == "open" && d.pr == Some(6))
    });
    assert_eq!(m.log("runs").trim(), "2");
    assert_eq!(m.gh("pr create").len(), 2);
    assert_eq!(m.breaches().len(), 5);
    assert!(
        m.breaches().iter().all(|b| b.2 == "done"),
        "{:?}",
        m.breaches()
    );
}

#[test]
fn test_runbook_cap_repo() {
    let yaml = BAND.replace("runbook:cap_repo, runbook:pause", "runbook:cap_repo");
    let mut m = Mnt::new(&yaml, &spike());
    let mut lp = m.open();
    m.until(&mut lp, |m| !m.breaches().is_empty());
    let cap: (i64, i64, String) = m
        .db()
        .conn()
        .query_row(
            "SELECT capped, frozen, why FROM repo_caps WHERE repo = 'web'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(cap, (1, 0, "ci_failure_rate at 3σ".into()));
    assert!(!machine::paused(m.db().conn()).unwrap());
    let status = lp.status_text(m.w.clock).unwrap();
    assert!(status.contains("repos: web capped at a3"), "{status}");
    let triage: Vec<_> =
        m.w.outbox()
            .into_iter()
            .filter(|(_, e, _, _)| e == "triage:ci_failure_rate")
            .collect();
    assert_eq!(triage.len(), 1);
    let (mission, _, n, text) = &triage[0];
    let point: f64 = m
        .db()
        .conn()
        .query_row("SELECT point FROM breaches", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        (mission.as_str(), n.clone()),
        ("loop", (point as i64).to_string())
    );
    assert_eq!(
        text,
        "triage: ci_failure_rate at 3σ\nvalue 4 · mean 1.5 · σ 0.51"
    );
    // And it is drafted as diagnose would (pull_request).
    m.until(&mut lp, |m| m.draft().is_some_and(|d| d.step == "open"));
    // A band whose repo isn't in [repos]: no cap (logged), the message still goes.
    let mut other = bands::parse(&yaml).unwrap().remove(0);
    other.name = "elsewhere".into();
    other.repo = Some("elsewhere".into());
    let v = Verdict {
        tier: Tier::Three,
        point: (9.0 * DAY, 4.0),
        mean: 1.5,
        sigma: 0.5,
    };
    let db = m.db();
    assert!(maintain::record(&db, &m.w.config, &m.w.home, &other, &v, &[], m.w.clock).unwrap());
    let caps: Vec<String> = {
        let mut q = db.conn().prepare("SELECT repo FROM repo_caps").unwrap();
        q.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(caps, ["web"]);
    assert_eq!(m.triage(), 2);
    // `trust web` clears the cap (AUT-10).
    let out = towercab::commands::submit(
        &m.w.config,
        &m.w.home,
        &m.db(),
        &towercab::commands::Cmd::Trust("web".into()),
        Duration::ZERO,
    );
    drop(out);
    m.w.pass(&mut lp);
    let left: i64 = m
        .db()
        .conn()
        .query_row("SELECT COUNT(*) FROM repo_caps", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn test_episode_acts_once() {
    // A sustained 3σ shift: one pause, one cap, one message, one draft, however many days it
    // lasts; my resume and trust hold.
    let mut m = Mnt::new(BAND, &spike());
    let mut lp = m.open();
    m.until(&mut lp, |m| !m.breaches().is_empty());
    assert!(machine::paused(m.db().conn()).unwrap());
    assert_eq!(m.triage(), 1);
    assert_eq!(m.episode(), Some((true, true)));
    for cmd in [
        towercab::commands::Cmd::Resume,
        towercab::commands::Cmd::Trust("web".into()),
    ] {
        towercab::commands::submit(&m.w.config, &m.w.home, &m.db(), &cmd, Duration::ZERO).ok();
    }
    m.until(&mut lp, |m| m.draft().is_some_and(|d| d.step == "open"));
    assert!(!machine::paused(m.db().conn()).unwrap());
    let caps = |m: &Mnt| -> i64 {
        m.db()
            .conn()
            .query_row("SELECT COUNT(*) FROM repo_caps", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(caps(&m), 0);
    for _ in 0..3 {
        m.day(&mut lp, 4.0);
        m.until(&mut lp, |m| m.breaches().iter().all(|b| b.2 == "done"));
    }
    let tiers: Vec<String> = m.breaches().into_iter().map(|b| b.1).collect();
    assert_eq!(tiers, ["3sigma"; 4], "every breach an event");
    assert!(!machine::paused(m.db().conn()).unwrap(), "not paused again");
    assert_eq!(caps(&m), 0, "not capped again");
    assert_eq!(m.triage(), 1, "one message");
    assert_eq!(m.gh("pr create").len(), 1, "one draft");
    assert_eq!(m.log("runs").trim(), "1", "one diagnosis");
    assert_eq!(m.gh("pr comment").len(), 3, "the rest comment on it");

    // I reject the draft: the episode's later breaches don't draft again.
    fs::write(m.bin.join("pr-5.json"), r#"{"state":"CLOSED"}"#).unwrap();
    m.until(&mut lp, |m| m.draft().is_some_and(|d| d.step == "rejected"));
    m.day(&mut lp, 4.0);
    for _ in 0..4 {
        m.w.pass(&mut lp);
    }
    assert_eq!(m.breaches().len(), 5);
    assert_eq!(m.draft().unwrap().step, "rejected");
    assert_eq!((m.gh("pr create").len(), m.triage()), (1, 1));

    // Back within 1σ: the episode ends; the next 3σ is a new one and acts again.
    m.day(&mut lp, 1.5);
    assert!(m.episode().is_some(), "2 of the last 3 still beyond 2σ");
    m.day(&mut lp, 1.5);
    assert_eq!(m.episode(), None);
    m.day(&mut lp, 4.0);
    assert!(machine::paused(m.db().conn()).unwrap());
    assert_eq!(caps(&m), 1);
    assert_eq!(m.triage(), 2);
    m.until(&mut lp, |m| {
        m.draft()
            .is_some_and(|d| d.step == "draft" || d.step == "open")
    });
}

#[test]
fn test_runbook_pause() {
    let yaml = BAND.replace(
        "pull_request, runbook:cap_repo, runbook:pause",
        "runbook:pause",
    );
    let mut m = Mnt::new(&yaml, &spike());
    let mut lp = m.open();
    m.until(&mut lp, |m| !m.breaches().is_empty());
    assert!(machine::paused(m.db().conn()).unwrap());
    assert_eq!(
        m.breaches(),
        [("ci_failure_rate".into(), "3sigma".into(), "done".into())]
    );
    assert!(m.draft().is_none(), "no pull_request route");
    assert!(lp.status_text(m.w.clock).unwrap().contains(" · paused"));
    let msgs: Vec<String> = m.w.outbox().into_iter().map(|r| r.3).collect();
    assert_eq!(
        msgs,
        ["triage: ci_failure_rate at 3σ\nvalue 4 · mean 1.5 · σ 0.51"]
    );

    // With the band's draft already open, the message names its PR and the breach comments.
    let db = m.db();
    db.conn()
        .execute(
            "INSERT INTO drafts (key, repo, source, intent, slug, pr, pr_url, step, created, updated)
             VALUES ('alert:ci_failure_rate', 'web', 'alert:ci_failure_rate', '261015-1000', 'x', 5,
               'https://github.com/me/intents/pull/5', 'open', 1, 1)",
            [],
        )
        .unwrap();
    let band = &bands::parse(BAND).unwrap()[0];
    let v = Verdict {
        tier: Tier::Three,
        point: (9.0 * DAY, 4.0),
        mean: 1.5,
        sigma: 0.5,
    };
    // A new episode (the first one's runbook and message are done).
    maintain::close_episode(db.conn(), "ci_failure_rate").unwrap();
    let new = maintain::record(&db, &m.w.config, &m.w.home, band, &v, &[], m.w.clock).unwrap();
    assert!(new);
    assert!(
        !maintain::record(&db, &m.w.config, &m.w.home, band, &v, &[], m.w.clock).unwrap(),
        "once per point"
    );
    let msgs: Vec<String> = m.w.outbox().into_iter().map(|r| r.3).collect();
    assert_eq!(
        msgs[1],
        "triage: ci_failure_rate at 3σ\nvalue 4 · mean 1.5 · σ 0.5\nPR https://github.com/me/intents/pull/5"
    );
    let step: String = db
        .conn()
        .query_row(
            "SELECT step FROM breaches WHERE point = ?1",
            [9.0 * DAY],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(step, "comment");
    // That draft rejected and a new episode: a new row replaces it, its `comment` breach → done.
    db.conn()
        .execute("UPDATE drafts SET step = 'rejected'", [])
        .unwrap();
    maintain::close_episode(db.conn(), "ci_failure_rate").unwrap();
    let v2 = Verdict {
        point: (10.0 * DAY, 4.0),
        ..v
    };
    assert!(maintain::record(&db, &m.w.config, &m.w.home, band, &v2, &[], m.w.clock).unwrap());
    let steps: Vec<String> = {
        let mut q = db
            .conn()
            .prepare("SELECT step FROM breaches WHERE point IN (?1, ?2) ORDER BY point")
            .unwrap();
        q.query_map([9.0 * DAY, 10.0 * DAY], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(steps, ["done", "diagnose"]);
    assert_eq!(m.draft().unwrap().step, "draft");
    // `resume` lifts it.
    towercab::commands::submit(
        &m.w.config,
        &m.w.home,
        &db,
        &towercab::commands::Cmd::Resume,
        Duration::ZERO,
    )
    .ok();
    m.w.pass(&mut lp);
    assert!(!machine::paused(m.db().conn()).unwrap());
}

#[test]
fn test_dismissal_counted() {
    let mut m = Mnt::new(BAND, &[]);
    let db = m.db();
    for (band, pr) in [
        ("ci_failure_rate", 5),
        ("cycle_time", 6),
        ("cost_per_intent", 8),
    ] {
        db.conn()
            .execute(
                "INSERT INTO drafts (key, repo, source, intent, slug, pr, pr_url, step, created, updated)
                 VALUES (?1, 'web', ?1, ?2, 'x', ?3, ?4, 'open', 1, 1)",
                rusqlite::params![
                    format!("alert:{band}"),
                    format!("2610{pr:02}-1000"),
                    pr,
                    format!("https://github.com/me/intents/pull/{pr}")
                ],
            )
            .unwrap();
    }
    fs::write(m.bin.join("pr-5.json"), r#"{"state":"CLOSED"}"#).unwrap();
    fs::write(m.bin.join("pr-6.json"), r#"{"state":"MERGED"}"#).unwrap();
    let mut lp = m.open();
    m.until(&mut lp, |m| m.draft().is_some_and(|d| d.step == "rejected"));
    for _ in 0..6 {
        m.w.pass(&mut lp);
    }
    let counts: Vec<(String, i64, i64)> = {
        let mut q = db
            .conn()
            .prepare("SELECT band, accepted, dismissed FROM triage ORDER BY band")
            .unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(
        counts,
        [
            ("ci_failure_rate".into(), 0, 1),
            ("cycle_time".into(), 1, 0)
        ]
    );
    let status = lp.status_text(m.w.clock).unwrap();
    assert!(
        status.contains("\nalerts dismissed: ci_failure_rate 1\n"),
        "{status}"
    );
    let rejected = m
        .records()
        .into_iter()
        .filter(|r| {
            r.metric == Metric::IntentDrafts
                && r.label("source") == Some("alert")
                && r.label("result") == Some("rejected")
        })
        .count();
    assert_eq!(rejected, 1);
}

#[test]
fn test_lesson_written() {
    let dir = "261012-0900-stop-the-ci-failure-spike";
    let md = "---\nrepo: web\nu: 4\ni: 3\nsource: alert:ci_failure_rate\nstarted: 2026-10-01T08:00:00+02:00\nstage: done\npr: https://github.com/me/web/pull/9\nfinished: 2026-10-10T12:00:00+02:00\n---\n\n# Intent: Stop the CI failure spike\n\n## Problem\n\nCI fails far more often since PR 7.\nIt flakes on login.\n\nMore detail.\n";
    let mut points = series(&[1.5; 8]);
    // The first full day after the fix (2026-10-10 10:00 UTC) ends 2026-10-12 00:00 UTC: 3
    // points before the newest (2026-10-15).
    let n = points.len();
    points[n - 4] = 1.4;
    let mut m = Mnt::with(
        &[(format!("done/{dir}/intent.md"), md.into())],
        BAND,
        &points,
        Duration::ZERO,
    );
    let started = chrono::DateTime::parse_from_rfc3339("2026-10-01T08:00:00+02:00")
        .unwrap()
        .timestamp() as f64;
    m.db()
        .conn()
        .execute(
            "INSERT INTO breaches (band, tier, point, value, mean, sigma, at, step)
             VALUES ('ci_failure_rate', '2sigma', ?1, 0.6, 0.2, 0.15, ?2, 'done'),
                    ('ci_failure_rate', '1sigma', ?3, 0.3, 0.2, 0.05, ?4, 'done')",
            rusqlite::params![started - 30_000.0, started, started + DAY, started + DAY],
        )
        .unwrap();
    let mut lp = m.open();
    let rel = "lessons/261010-stop-the-ci-failure-spike.md";
    m.until(&mut lp, |m| m.w.intents.remote_has(rel));
    let text = m.w.intents.remote_file(rel);
    let point = chrono::DateTime::parse_from_rfc3339("2026-10-12T00:00:00Z").unwrap();
    assert_eq!(
        text,
        format!(
            "# Lesson: Stop the CI failure spike\n\n- Intent: 261012-0900 (source: alert:ci_failure_rate)\n\
             - Anomaly: ci_failure_rate at 2sigma on {}: value 0.6 · mean 0.2 · σ 0.15\n\
             - Cause: CI fails far more often since PR 7. It flakes on login.\n\
             - Fix: https://github.com/me/web/pull/9\n\
             - After the fix: 1.4 on {}, back within 1σ: yes\n\
             - Eval case: evals/261012-0900.json (incident)\n",
            towercab::maintain::diagnose::utc(started - 30_000.0),
            point.format("%Y-%m-%d %H:%M UTC"),
        )
    );
    assert!(
        m.w.intents
            .log()
            .contains(&"towercab: lesson 261012-0900".to_string()),
        "{:?}",
        m.w.intents.log()
    );
    let step: String = m
        .db()
        .conn()
        .query_row("SELECT step FROM lessons", [], |r| r.get(0))
        .unwrap();
    assert_eq!(step, "written");
    // Written once.
    for _ in 0..8 {
        m.w.pass(&mut lp);
    }
    let lessons =
        m.w.intents
            .log()
            .iter()
            .filter(|l| l.starts_with("towercab: lesson"))
            .count();
    assert_eq!(lessons, 1);
    drop(m.values);
}
