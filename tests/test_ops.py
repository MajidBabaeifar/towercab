import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "ops" / "grafana" / "dashboards" / "towercab.json"
# OTel names the loop emits (specs/metrics.md MET-13..27); Prometheus turns dots into underscores.
METRICS = [
    "towercab.stage.duration",
    "towercab.intent.duration",
    "towercab.intent.cost",
    "towercab.cost.usd",
    "towercab.tokens",
    "towercab.ci.repairs",
    "towercab.ci.result",
    "towercab.reverts",
    "towercab.usage_limit.waits",
    "towercab.usage_limit.wait.duration",
    "towercab.backlog",
    "towercab.loop.state",
    "towercab.active",
    "towercab.intent.drafts",
    "towercab.intent.time_to_intent",
    "towercab.intent.edits_after_spec",
    "towercab.spec.lead.duration",
    "towercab.spec.rework",
    "towercab.first_pass",
    "towercab.plan_to_merge.duration",
    "towercab.rework.cycles",
    "towercab.plan.result",
    "towercab.findings.repeated",
    "towercab.claude_md.updates",
    "towercab.eval.pass_rate",
    "towercab.eval.gate",
    "towercab.incident_to_eval.duration",
    "towercab.escapes",
    "towercab.review.findings",
    "towercab.review.first.duration",
    "towercab.feedback.rounds",
    "towercab.gate.wait.duration",
    "towercab.guard.blocks",
    "towercab.gate.violations",
    "towercab.ci.triage",
    "towercab.deploys",
    "towercab.change.lead.duration",
    "towercab.restore.duration",
    "towercab.breaches",
    "towercab.breach_to_intent.duration",
]


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.dash = json.loads(DASHBOARD.read_text())
        self.panels = self.dash["panels"]

    def test_refresh_picker_and_overall_only(self):
        self.assertEqual(self.dash["uid"], "towercab-overview")
        self.assertIn("1m", self.dash["timepicker"]["refresh_intervals"])
        self.assertTrue(self.dash["refresh"])
        names = [v["name"] for v in self.dash["templating"]["list"]]
        self.assertNotIn("repo", names)
        for p in self.panels:
            for t in p.get("targets", []):
                self.assertNotIn("$repo", t["expr"])

    def test_panels_well_formed(self):
        ids = [p["id"] for p in self.panels]
        self.assertEqual(len(ids), len(set(ids)))
        for p in self.panels:
            g = p["gridPos"]
            self.assertLessEqual(g["x"] + g["w"], 24, p["title"])
            for t in p.get("targets", []):
                self.assertIn(t["datasource"]["uid"], ("prometheus", "loki"), p["title"])
                self.assertEqual(t["expr"].count("("), t["expr"].count(")"), p["title"])

    def test_dashboard_names(self):
        import re
        bases = sorted((m.replace(".", "_") for m in METRICS), key=len, reverse=True)
        for p in self.panels:
            for t in p.get("targets", []):
                for name in re.findall(r"towercab_[a-z_]+", t["expr"]):
                    self.assertTrue(any(name == b or name.startswith(b + "_") for b in bases), (p["title"], name))
                self.assertNotIn("gen_ai_", t["expr"], p["title"])

    def test_dashboard_is_generated(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "towercab.json"
            subprocess.run([sys.executable, str(ROOT / "ops" / "grafana" / "build_dashboard.py"), str(out)], check=True, capture_output=True)
            self.assertEqual(out.read_text(), DASHBOARD.read_text())

    def test_delta_counters_summed_not_increased(self):
        for p in self.panels:
            for t in p.get("targets", []):
                self.assertNotRegex(t["expr"], r"(?<![\w])(increase|rate|irate)\(", p["title"])


if __name__ == "__main__":
    unittest.main()
