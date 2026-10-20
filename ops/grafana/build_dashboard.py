"""python3 ops/grafana/build_dashboard.py ops/grafana/dashboards/towercab.json

Generates the dashboard: Loop, playbook stages (leading/lagging), Intents, Claude Code usage."""
import json
import sys

P = {"type": "prometheus", "uid": "prometheus"}
L = {"type": "loki", "uid": "loki"}
pid = 0


def nid():
    global pid
    pid += 1
    return pid


# Name helpers: OTel -> Prometheus adds unit and type suffixes; match them by regex.
def C(name, sel=""):  # counter
    return '{__name__=~"towercab_%s(_total)?"%s}' % (name, sel)


def H(name, sel=""):  # histogram buckets (seconds or unitless or USD)
    return '{__name__=~"towercab_%s(_seconds|_USD)?_bucket"%s}' % (name, sel)


def HC(name, sel=""):  # histogram count
    return '{__name__=~"towercab_%s(_seconds|_USD)?_count"%s}' % (name, sel)


def G(name, sel=""):  # gauge
    return '{__name__=~"towercab_%s(_ratio)?"%s}' % (name, sel)


CC = lambda n, sel="": '{__name__=~"claude_code_%s", job=~"$job"%s}' % (n, sel)
S = lambda q, r="$__range": f"sum(sum_over_time({q}[{r}]))"
SB = lambda by, q, r="$__range": f"sum by ({by}) (sum_over_time({q}[{r}]))"
Q = lambda p, q, by="le": f"histogram_quantile({p}, sum by ({by}) (sum_over_time({q}[$__range])))"
RATIO = lambda a, b: f"{S(a)} / {S(b)}"
LEAD, LAG = "Leading", "Lagging"
EMPTY = " Empty until the loop emits it."


def tgt(expr, ref="A", instant=True, legend=None, ds=P):
    t = {"refId": ref, "datasource": ds, "expr": expr, "instant": instant, "range": not instant}
    if legend:
        t["legendFormat"] = legend
    return t


def stat(title, exprs, x, y, unit="short", desc="", w=4, h=4, decimals=None, legends=None, text="value"):
    p = {"id": nid(), "type": "stat", "title": title, "datasource": P, "description": desc,
         "gridPos": {"x": x, "y": y, "w": w, "h": h},
         "targets": [tgt(e, chr(65 + i), legend=(legends[i] if legends else None)) for i, e in enumerate(exprs)],
         "fieldConfig": {"defaults": {"unit": unit, "noValue": "–", "color": {"mode": "fixed", "fixedColor": "text"}}, "overrides": []},
         "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                     "colorMode": "none", "graphMode": "none", "textMode": text, "justifyMode": "center", "orientation": "auto"}}
    if decimals is not None:
        p["fieldConfig"]["defaults"]["decimals"] = decimals
    return p


def bars(title, targets, x, y, w, h, unit="short", desc="", interval="1h"):
    return {"id": nid(), "type": "timeseries", "title": title, "datasource": P, "interval": interval, "description": desc,
            "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
            "fieldConfig": {"defaults": {"unit": unit, "noValue": "–", "min": 0,
                                         "custom": {"drawStyle": "bars", "fillOpacity": 80, "lineWidth": 0, "stacking": {"mode": "normal", "group": "A"}, "showPoints": "never"}},
                            "overrides": []},
            "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True}, "tooltip": {"mode": "multi", "sort": "desc"}}}


def gauge(title, targets, x, y, w, h, unit="short", desc=""):
    return {"id": nid(), "type": "bargauge", "title": title, "datasource": P, "description": desc,
            "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
            "fieldConfig": {"defaults": {"unit": unit, "noValue": "–", "min": 0, "color": {"mode": "palette-classic"}}, "overrides": []},
            "options": {"orientation": "horizontal", "displayMode": "basic", "showUnfilled": True, "maxVizHeight": 24, "minVizHeight": 16, "sizing": "manual",
                        "valueMode": "color", "namePlacement": "left", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}}}


def row(title, y):
    return {"id": nid(), "type": "row", "title": title, "collapsed": False, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []}


def ind(kind, play, what):
    return f"{kind} · {play}: {what} (playbook \"How to measure it\", MET-22).{EMPTY}"


panels = []
y = 0
# ---- Loop
panels.append(row("Loop", y)); y += 1
st = stat("Loop state", ['max by (state) (last_over_time(towercab_loop_state[2m])) == 1'], 0, y, desc="running · idle · paused · env_blocked · limit (MET-20)." + EMPTY, w=4, legends=["{{state}}"], text="name")
bl = stat("Backlog", ['sum by (state) (last_over_time(towercab_backlog[2m]))'], 4, y, desc="Intents by state now (MET-20)." + EMPTY, w=16, legends=["{{state}}"], text="value_and_name")
ac = stat("Active runs", [f'max(last_over_time({G("active")}[2m]))'], 20, y, desc="Claude, checks or e2e children running now (MET-24)." + EMPTY)
panels += [st, bl, ac]; y += 4

# ---- Plan
panels.append(row("Plan · capture intent", y)); y += 1
drafts_all = C("intent_drafts")
panels += [
    stat("Time to intent p50", [Q(0.5, H("intent_time_to_intent"))], 0, y, "s", ind(LEAD, "Capture intent", "started → intent on main")),
    stat("Time to intent by source", [Q(0.5, H("intent_time_to_intent"), "le, source")], 4, y, "s", ind(LEAD, "Capture intent", "p50 by route"), w=8, legends=["{{source}}"], text="value_and_name"),
    stat("Survival rate", [RATIO(C("intent_drafts", ',result="accepted"'), drafts_all)], 12, y, "percentunit", ind(LAG, "Capture intent", "drafted intents I accepted")),
    stat("Intent edits after spec", [S(C("intent_edits_after_spec"))], 16, y, "short", ind(LAG, "Capture intent", "my changes to intent.md after its spec commit")),
    stat("Drafts by source", [SB("source", drafts_all)], 20, y, "short", "Machine-written intents by route (INT-7, MNT-5, PIP-36)." + EMPTY, legends=["{{source}}"], text="value_and_name"),
]
y += 4
# ---- Design
panels.append(row("Design · requirements and design", y)); y += 1
panels += [
    stat("Intent → spec p50", [Q(0.5, H("spec_lead_duration"))], 0, y, "s", ind(LEAD, "Requirements and design", "intent on main → spec commit")),
    stat("Intent → spec p90", [Q(0.9, H("spec_lead_duration"))], 4, y, "s", ind(LEAD, "Requirements and design", "p90")),
    stat("Spec rework", [S(C("spec_rework"))], 8, y, "short", ind(LAG, "Requirements and design", "commits changing specs/ after plan.md")),
    stat("Spec gate waits p50", [Q(0.5, H("gate_wait_duration", ',gate="spec"'))], 12, y, "s", "How long design waited for my approval (PIP-26)." + EMPTY),
]
y += 4
# ---- Build
panels.append(row("Build · plan mode, CLAUDE.md, skills, parallel sessions", y)); y += 1
fp_all = C("first_pass")
panels += [
    stat("First-pass merge", [RATIO(C("first_pass", ',result="yes"'), fp_all)], 0, y, "percentunit", ind(LEAD, "Plan mode", "merged with no repair round")),
    stat("Plan → merge p50", [Q(0.5, H("plan_to_merge_duration"))], 4, y, "s", ind(LEAD, "Plan mode", "plan.md written → merged")),
    stat("Rework cycles p50", [Q(0.5, H("rework_cycles"))], 8, y, "short", ind(LAG, "Plan mode", "repair rounds per intent"), decimals=1),
    stat("Plan drift", [RATIO(C("plan_result", ',result="drifted"'), C("plan_result"))], 12, y, "percentunit", ind(LAG, "Plan mode", "merged diff didn't match plan.md")),
    stat("Repeated mistakes", [S(C("findings_repeated"))], 16, y, "short", ind(LEAD, "CLAUDE.md", "same rule flagged in two PRs")),
    stat("CLAUDE.md corrections", [S(C("claude_md_updates"))], 20, y, "short", ind(LEAD, "CLAUDE.md", "merged PRs changing CLAUDE.md")),
]
y += 4
panels += [
    gauge("Findings citing a policy skill", [tgt(SB("policy", C("review_findings", ',policy!="none"')), legend="{{policy}}")], 0, y, 8, 6, desc=ind(LAG, "Skills", "should fall to zero per policy")),
    bars("Intents done per day", [tgt(SB("outcome", HC("intent_duration", ',kind="lead"'), "$__interval"), instant=False, legend="{{outcome}}")], 8, y, 8, 6, desc=ind(LAG, "Parallel sessions", "throughput, read with rework"), interval="1d"),
    stat("Important findings per PR", [RATIO(C("review_findings", ',severity="important"'), C("first_pass"))], 16, y, "short", ind(LEAD, "Parallel sessions", "review quality to hold while active runs rise"), w=8, h=6, decimals=2),
]
y += 6
# ---- Test
panels.append(row("Test · feedback loop, evals", y)); y += 1
merged = HC("intent_duration", ',kind="lead",outcome=~"done|reverted|revert_failed"')
cfr = f"{S(C('escapes'))} / {S(merged)}"
panels += [
    stat("First-pass CI", [RATIO(C("ci_result", ',first="yes",result="green"'), C("ci_result", ',first="yes"'))], 0, y, "percentunit", ind(LEAD, "Feedback loop", "first CI run after the build is green")),
    stat("Wait for my merge p50", [Q(0.5, H("gate_wait_duration", ',gate="merge"'))], 4, y, "s", ind(LAG, "Feedback loop", "review time per PR")),
    stat("Change failure rate", [cfr], 8, y, "percentunit", ind(LAG, "Feedback loop / CI/CD", "escapes ÷ merged intents (MET-25)")),
    stat("Eval pass rate", [f'max(last_over_time({G("eval_pass_rate")}[$__range]))'], 12, y, "percentunit", ind(LEAD, "Evals", "last eval run")),
    stat("Incident → eval p50", [Q(0.5, H("incident_to_eval_duration"))], 16, y, "s", ind(LEAD, "Evals", "escape → incident eval case")),
    stat("Caught by evals · escaped", [S(C("eval_gate", ',result="drop"')), S(C("escapes"))], 20, y, "short", ind(LAG, "Evals", "regressions caught by the eval gate vs escaped"), legends=["evals", "escaped"], text="value_and_name"),
]
y += 4
# ---- Deploy
panels.append(row("Deploy · PR review, approval gates, CI/CD (DORA)", y)); y += 1
panels += [
    stat("Time to first review p50", [Q(0.5, H("review_first_duration"))], 0, y, "s", ind(LEAD, "PR review", "PR ready → first review")),
    stat("Feedback fixed by worker", [RATIO(C("feedback_rounds", ',resolved_by="worker"'), C("feedback_rounds"))], 4, y, "percentunit", ind(LEAD, "PR review", "my comments resolved without me touching the branch")),
    stat("Important before merge · escaped", [S(C("review_findings", ',severity="important"')), S(C("escapes"))], 8, y, "short", ind(LAG, "PR review", "defects caught before merge vs escaping"), legends=["caught", "escaped"], text="value_and_name"),
    stat("Gate violations", [S(C("gate_violations"))], 12, y, "short", ind(LAG, "Approval gates", "protected path merged without unlock; target 0")),
    stat("CI failures fixed without me", [RATIO(C("ci_triage", ',by="worker"'), C("ci_triage"))], 16, y, "percentunit", ind(LEAD, "CI/CD", "red CI resolved by the worker")),
    stat("Guard blocks", [SB("kind", C("guard_blocks"))], 20, y, "short", "Writes the guard stopped (PIP-29, PIP-31)." + EMPTY, legends=["{{kind}}"], text="value_and_name"),
]
y += 4
panels += [
    gauge("Wait per gate (p50)", [tgt(Q(0.5, H("gate_wait_duration"), "le, gate"), legend="{{gate}}")], 0, y, 8, 6, "s", ind(LEAD, "Approval gates", "time waiting on me, per gate")),
    stat("Deploys", [SB("env", C("deploys"))], 8, y, "short", ind(LAG, "CI/CD", "DORA deploy frequency"), w=4, h=6, legends=["{{env}}"], text="value_and_name"),
    stat("Lead time for changes p50", [Q(0.5, H("change_lead_duration"))], 12, y, "s", ind(LAG, "CI/CD", "DORA: first commit → production"), w=4, h=6),
    stat("Change failure rate", [cfr], 16, y, "percentunit", ind(LAG, "CI/CD", "DORA (MET-25)"), w=4, h=6),
    stat("Time to restore p50", [Q(0.5, H("restore_duration"))], 20, y, "s", ind(LAG, "CI/CD", "DORA: e2e red → green again"), w=4, h=6),
]
y += 6
# ---- Maintain
panels.append(row("Maintain · closing the loop", y)); y += 1
panels += [
    stat("Breach → intent p50", [Q(0.5, H("breach_to_intent_duration"))], 0, y, "s", ind(LEAD, "Closing the loop", "breach → draft intent PR")),
    stat("Alert findings fixed", [RATIO(HC("intent_duration", ',kind="lead",source="alert",outcome="done"'), C("intent_drafts", ',source="alert"'))], 4, y, "percentunit", ind(LAG, "Closing the loop", "alert intents that became merged fixes")),
    gauge("Breaches by band", [tgt(SB("band, tier", C("breaches")), legend="{{band}} · {{tier}}")], 8, y, 16, 4, desc=ind(LAG, "Closing the loop", "repeat breaches per band (MNT-3)")),
]
y += 4
# ---- Intents
panels.append(row("Intents", y)); y += 1
done = S(HC("intent_duration", ',kind="lead",outcome="done"'))
cost = '{__name__=~"towercab_cost_usd(_USD)?(_total)?"}'
INT = "From the loop (MET-14..18)." + EMPTY
cyc = stat("Cycle time p50 · p90", [Q(0.5, H("intent_duration", ',kind="cycle",outcome="done"')), Q(0.9, H("intent_duration", ',kind="cycle",outcome="done"'))], 12, y, "s", "Picked → done. " + INT, legends=["p50", "p90"], text="value_and_name")
panels += [
    stat("Intents done", [done], 0, y, desc=INT),
    stat("Lead time p50", [Q(0.5, H("intent_duration", ',kind="lead",outcome="done"'))], 4, y, "s", "Created → done. " + INT),
    stat("Lead time p90", [Q(0.9, H("intent_duration", ',kind="lead",outcome="done"'))], 8, y, "s", INT),
    cyc,
    stat("Cost per intent", [f"{S(cost)} / {done}"], 16, y, "currencyUSD", "API-price estimate, all agents ÷ intents done. " + INT, decimals=2),
    stat("Auto-merged", [RATIO(HC("intent_duration", ',kind="lead",outcome=~"done|reverted|revert_failed",merged_by="towercab"'), merged)], 20, y, "percentunit", "Merges Towercab did itself. " + INT),
]
y += 4
panels += [
    stat("Tokens per intent", [f"{S(C('tokens'))} / {done}"], 0, y, "short", INT),
    stat("Paused on usage limit", [S('{__name__=~"towercab_usage_limit_wait_duration(_seconds)?(_sum|_total)?"}')], 4, y, "s", INT),
    stat("Reverts", [S(C("reverts"))], 8, y, "short", INT),
    gauge("Gate outcomes", [tgt(SB("gate", HC("intent_duration", ',kind="lead",outcome=~"done|reverted|revert_failed"')), legend="{{gate}}")], 12, y, 12, 4, desc="a1..a5, risk_low/high, capped, unlock, frozen, no_ci. " + INT),
]
y += 4
panels += [
    gauge("Time per stage (p50 · p90)", [tgt(Q(0.5, H("stage_duration"), "le, stage"), "A", legend="{{stage}} p50"),
                                         tgt(Q(0.9, H("stage_duration"), "le, stage"), "B", legend="{{stage}} p90")], 0, y, 12, 8, "s", INT),
    gauge("Cost by agent", [tgt(SB("agent, model", cost), legend="{{agent}} · {{model}}")], 12, y, 12, 8, "currencyUSD", INT),
]
y += 8
panels.append({"id": nid(), "type": "logs", "title": "Intent events", "datasource": L, "gridPos": {"x": 0, "y": y, "w": 24, "h": 8},
               "description": "One line per stage, gate and breach event, with intent_id and PR. " + INT,
               "targets": [{"refId": "A", "datasource": L, "expr": '{service_name="towercab-loop"}', "queryType": "range"}],
               "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending", "enableLogDetails": True, "prettifyLogMessage": False, "dedupStrategy": "none"}})
y += 8
# ---- Claude Code usage
panels.append(row("Claude Code usage", y)); y += 1
COST, TOK = "cost_usage(_USD)?(_total)?", "token_usage(_tokens)?(_total)?"
CCD = "From Claude Code's own telemetry (Towercab's runs as Source `towercab`; your sessions after `ops/telemetry on`)."
panels += [
    stat("Cost", [S(CC(COST))], 0, y, "currencyUSD", "API-price estimate; on a subscription this is not a bill. " + CCD, decimals=2),
    stat("Tokens", [S(CC(TOK))], 4, y, "short", CCD),
    stat("Sessions", [S(CC("session_count(_total)?"))], 8, y, "short", CCD),
    stat("Active time", [S(CC("active_time(_total)?(_seconds)?(_total)?", ', type="cli"'))], 12, y, "s", "Time Claude was working. " + CCD),
    stat("Cache hit rate", [f'{S(CC(TOK, ", type=\"cacheRead\""))} / {S(CC(TOK, ", type=~\"input|cacheRead|cacheCreation\""))}'], 16, y, "percentunit", "Cache-read ÷ all input tokens. " + CCD),
    stat("Lines changed", [S(CC("lines_of_code_count(_total)?"))], 20, y, "short", "Added + removed. " + CCD),
]
y += 4
panels += [
    bars("Cost by model", [tgt(SB("model", CC(COST), "$__interval"), instant=False, legend="{{model}}")], 0, y, 12, 8, "currencyUSD", CCD, interval="5m"),
    bars("Tokens by type", [tgt(SB("type", CC(TOK), "$__interval"), instant=False, legend="{{type}}")], 12, y, 12, 8, "short", CCD, interval="5m"),
]
y += 8
cp = stat("Commits · PRs", [S(CC("commit_count(_total)?")), S(CC("pull_request_count(_total)?"))], 16, y, "short", "Created by Claude Code. " + CCD, w=8, h=8, legends=["commits", "PRs"], text="value_and_name")
panels += [
    gauge("Cost by model", [tgt(SB("model", CC(COST)), legend="{{model}}")], 0, y, 8, 8, "currencyUSD", CCD),
    gauge("Cost: main vs subagents", [tgt(SB("query_source", CC(COST)), legend="{{query_source}}")], 8, y, 8, 8, "currencyUSD", CCD),
    cp,
]

dash = {
    "uid": "towercab-overview", "title": "Towercab",
    "description": "Towercab on the AI-native SDLC playbook: loop state, each stage's leading and lagging indicators, intents, Claude usage.",
    "tags": ["towercab", "claude-code", "playbook"], "timezone": "browser", "editable": True, "graphTooltip": 1,
    "schemaVersion": 41, "version": 2, "refresh": "1m", "liveNow": False,
    "time": {"from": "now-7d", "to": "now"},
    "timepicker": {"refresh_intervals": ["10s", "30s", "1m", "5m", "15m", "30m", "1h", "2h", "1d"]},
    "templating": {"list": [{
        "name": "job", "label": "Source", "type": "query", "datasource": P,
        "query": {"query": 'label_values({__name__=~"claude_code_session_count(_total)?"}, job)', "refId": "job"},
        "definition": 'label_values({__name__=~"claude_code_session_count(_total)?"}, job)',
        "includeAll": True, "allValue": ".*", "multi": True, "refresh": 2, "sort": 1,
        "current": {"text": ["All"], "value": ["$__all"]}, "description": "service.name of the Claude Code process"}]},
    "annotations": {"list": []}, "links": [], "panels": panels,
}
with open(sys.argv[1], "w") as f:
    json.dump(dash, f, indent=2)
    f.write("\n")
print(len(panels), "panels")
