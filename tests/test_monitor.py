import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from towercab.core import Store
from towercab.monitor import logs, readable


class MonitorTests(unittest.TestCase):
    def test_formats_actual_events(self):
        event = {"type":"item.started", "item":{"type":"command_execution", "command":"python3 notes.py --help"}}
        self.assertEqual(readable(json.dumps(event)), "$ python3 notes.py --help")
        event = {"type":"item.completed", "item":{"type":"agent_message", "text":"Plan ready"}}
        self.assertEqual(readable(json.dumps(event)), "Plan ready")
        self.assertEqual(readable("plain log\n"), "plain log")

    def test_reads_stages_and_terminal_feedback(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = Store(tmp)
            mid = s.add("test", "test", None, ["true"])
            directory = Path(tmp) / "missions" / mid
            directory.mkdir(parents=True)
            (directory / "001-plan.log").write_text("first\n")
            (directory / "002-build.log").write_text("last partial line")
            s.update(mid, status="blocked", feedback="Install missing tool")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                logs(s, mid, follow=True)
            s.db.close()
            text = output.getvalue()
            self.assertIn("first", text)
            self.assertIn("last partial line", text)
            self.assertIn("Install missing tool", text)
            self.assertLess(text.index("001-plan"), text.index("002-build"))
