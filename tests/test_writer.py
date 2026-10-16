"""PR description writer and its plain fallback (PIP-11..14)."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

from towercab.notify import Notifier
from towercab.writer import plain_body, write_body
from fake_telegram import FakeTelegram

M = {"task": "261016-0403-7", "id": "m1", "repairs": 1}
ARGS = (M, "Add thing", "built it", "Reviewer: looks right\n- second", "make test", "$0.10 API-equivalent · 1.0 min agent time")

PLAIN = """Task `261016-0403-7` · mission `m1` · $0.10 API-equivalent · 1.0 min agent time

Add thing

## What changed
- Reviewer: looks right
- second

## Checks
- verify: `make test` passed (1 repairs)
- reviewer agent approved

🤖 Built by Towercab"""


class WriterTests(unittest.TestCase):
    def fake(self, body):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        path = Path(d.name) / "claude"
        path.write_text(f"#!{sys.executable}\nimport sys\nsys.stdin.read()\n{body}\n")
        path.chmod(0o755)
        return str(path)

    def test_writer_template(self):
        self.assertEqual(plain_body(*ARGS[:2], *ARGS[3:]), PLAIN)

    def test_pr_writer(self):
        argv_out = Path(tempfile.mkdtemp()) / "argv"
        claude = self.fake(f"open({str(argv_out)!r}, 'w').write(repr(sys.argv[1:]))\n"
                           "print('Does a thing\\n\\n## What changed\\n" + "\\n".join(f"- b{i}" for i in range(8)).replace("\n", "\\n") + "')")
        body = write_body(claude, *ARGS)
        self.assertEqual(eval(argv_out.read_text()), ["-p", "--model", "haiku", "--tools", "", "--output-format", "text"])
        self.assertIn("\n\nDoes a thing\n\n## What changed\n- b0\n- b1\n- b2\n- b3\n- b4\n\n## Checks\n", body)
        self.assertNotIn("b5", body)
        self.assertTrue(body.endswith("🤖 Built by Towercab"))

    def test_writer_fallback(self):
        for name, claude in {
            "exit 1": self.fake("print('Does a thing\\n\\n## What changed\\n- x')\nsys.exit(1)"),
            "empty": self.fake("pass"),
            "not the shape": self.fake("print('just some prose')"),
            "missing": "/nonexistent/claude",
        }.items():
            with self.subTest(name):
                self.assertEqual(write_body(claude, *ARGS), PLAIN)

    def test_writer_timeout(self):
        claude = self.fake("import time; time.sleep(5)")
        self.assertEqual(write_body(claude, *ARGS, timeout=0.3), PLAIN)


class TelegramTemplateTests(unittest.TestCase):
    def test_telegram_templates(self):
        tg = FakeTelegram()
        self.addCleanup(tg.stop)
        n = Notifier("tok", "42", tg.url, out=lambda *a: None)
        n.pr_ready("Ship it", "https://github.com/o/p/pull/1")
        n.stuck("Ship it", "build", "  boom \n")
        n.asking("Ship it", " why? ")
        n.limit("claude", "3pm")
        n.merged("Ship it", "p#1")
        self.assertEqual(tg.texts, [
            "✅ Ship it: PR ready\nhttps://github.com/o/p/pull/1",
            "⛔ Ship it: stuck at build\nboom",
            "❓ Ship it: needs you\nwhy?",
            "⏳ claude limit hit; waiting until 3pm",
            "🎉 Ship it: merged (p#1)",
        ])


if __name__ == "__main__":
    unittest.main()
