import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TELEMETRY = ROOT / "ops" / "telemetry"
DASHBOARD = ROOT / "ops" / "grafana" / "dashboards" / "towercab.json"


def telemetry(config_dir, *args):
    env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config_dir))
    return subprocess.run([sys.executable, str(TELEMETRY), *args], env=env, capture_output=True, text=True)


class TelemetryTest(unittest.TestCase):
    def test_on_off_keeps_other_settings(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "settings.json"
            path.write_text(json.dumps({"model": "opus", "env": {"FOO": "1"}}))
            self.assertEqual(telemetry(d, "on").returncode, 0)
            s = json.loads(path.read_text())
            self.assertEqual(s["model"], "opus")
            self.assertEqual(s["env"]["FOO"], "1")
            self.assertEqual(s["env"]["CLAUDE_CODE_ENABLE_TELEMETRY"], "1")
            self.assertEqual(s["env"]["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"], "delta")
            self.assertIn("telemetry on", telemetry(d, "status").stdout)
            self.assertEqual(telemetry(d, "off").returncode, 0)
            self.assertEqual(json.loads(path.read_text()), {"model": "opus", "env": {"FOO": "1"}})
            self.assertIn("telemetry off", telemetry(d, "status").stdout)

    def test_off_keeps_values_it_did_not_set(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "settings.json"
            path.write_text(json.dumps({"env": {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://elsewhere:4318"}}))
            telemetry(d, "off")
            self.assertEqual(json.loads(path.read_text())["env"]["OTEL_EXPORTER_OTLP_ENDPOINT"], "http://elsewhere:4318")

    def test_creates_missing_file_and_rejects_bad_args(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(telemetry(Path(d) / "new", "on").returncode, 0)
            self.assertTrue((Path(d) / "new" / "settings.json").exists())
            self.assertEqual(telemetry(d, "maybe").returncode, 2)


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

    def test_delta_counters_summed_not_increased(self):
        for p in self.panels:
            for t in p.get("targets", []):
                self.assertNotIn("increase(", t["expr"], p["title"])
                self.assertNotIn("rate(", t["expr"], p["title"])


if __name__ == "__main__":
    unittest.main()
