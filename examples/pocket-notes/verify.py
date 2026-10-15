"""Black-box acceptance checks. Run from the generated application's directory."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


APP = Path.cwd() / "notes.py"


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pocket-notes-check-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / "nested" / "notes.sqlite3"

    def invoke(self, *args, ok=True, json_mode=True):
        argv = [sys.executable, str(APP), "--db", str(self.db)]
        if json_mode:
            argv.append("--json")
        proc = subprocess.run(argv + list(args), capture_output=True, text=True,
                              timeout=10, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        if not ok:
            self.assertNotEqual(proc.returncode, 0, proc.stdout)
            self.assertTrue(proc.stderr.strip(), "Expected explanation on stderr")
            self.assertEqual(proc.stdout.strip(), "")
            return proc
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout) if json_mode else proc.stdout

    def add(self, title="A thought", body="Remember this", *extra):
        note = self.invoke("add", title, "--body", body, *extra)
        self.assertIs(type(note["id"]), int)
        self.assertGreater(note["id"], 0)
        self.assertIs(type(note["archived"]), bool)
        for key in ("title", "body", "created_at", "updated_at"):
            self.assertIsInstance(note[key], str)
        self.assertIsInstance(note["tags"], list)
        from datetime import datetime
        for key in ("created_at", "updated_at"):
            stamp = datetime.fromisoformat(note[key].replace("Z", "+00:00"))
            self.assertIsNotNone(stamp.utcoffset(), f"{key} needs a timezone")
            self.assertEqual(stamp.utcoffset().total_seconds(), 0)
        return note

    def test_01_help_without_storage(self):
        proc = subprocess.run([sys.executable, str(APP), "--db", str(self.db), "--help"],
                              text=True, capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("add", proc.stdout)
        self.assertFalse(self.db.exists())

    def test_02_capture_persist_and_tags(self):
        a = self.add("Café idea", "A multiline thought\nwith Unicode: ✓", "--tag", " Work ", "--tag", "work", "--tag", "Ideas")
        self.assertEqual(a["tags"], ["ideas", "work"])
        self.assertFalse(a["archived"])
        self.assertEqual(self.invoke("show", str(a["id"])), a)
        b = self.add("Second")
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual([n["id"] for n in self.invoke("list")], [a["id"], b["id"]])
        self.assertEqual([n["id"] for n in self.invoke("list", "--tag", "WORK")], [a["id"]])
        self.assertEqual(self.invoke("list", "--tag", "wor"), [])

    def test_03_search_literal_substrings(self):
        a = self.add("Release PLAN", "Target is 100% ready_under budget")
        self.add("Unrelated", "Target is 1000 readyXunder budget")
        self.assertEqual([n["id"] for n in self.invoke("search", "plan")], [a["id"]])
        for query in ("100%", "ready_under", "READY_UNDER"):
            self.assertEqual([n["id"] for n in self.invoke("search", query)], [a["id"]])
        self.assertEqual(self.invoke("search", "' OR 1=1 --"), [])

    def test_04_edit_and_validation(self):
        a = self.add("Before", "original", "--tag", "keep")
        edited = self.invoke("edit", str(a["id"]), "--title", "After", "--body", "")
        self.assertEqual(edited["title"], "After")
        self.assertEqual(edited["body"], "")
        for key in ("id", "tags", "created_at", "archived"):
            self.assertEqual(edited[key], a[key])
        self.invoke("edit", str(a["id"]), "--title", "  ", ok=False)
        self.invoke("edit", str(a["id"]), ok=False)
        self.invoke("add", "  ", ok=False)
        self.invoke("add", "Bad tag", "--tag", "  ", ok=False)
        self.invoke("show", "999999", ok=False)
        self.invoke("edit", "999999", "--body", "bad", ok=False)
        self.assertEqual(self.invoke("show", str(a["id"])), edited)
        self.assertEqual(len(self.invoke("list")), 1)

    def test_05_archive_restore(self):
        a = self.add("Findable", "Findable body")
        nid = str(a["id"])
        self.assertTrue(self.invoke("archive", nid)["archived"])
        self.assertTrue(self.invoke("archive", nid)["archived"])
        self.assertEqual(self.invoke("list"), [])
        self.assertEqual(self.invoke("search", "findable"), [])
        self.assertEqual(len(self.invoke("list", "--include-archived")), 1)
        self.assertEqual(len(self.invoke("search", "findable", "--include-archived")), 1)
        self.assertTrue(self.invoke("show", nid)["archived"])
        self.assertFalse(self.invoke("restore", nid)["archived"])
        self.assertFalse(self.invoke("restore", nid)["archived"])
        self.assertEqual(len(self.invoke("list")), 1)

    def test_06_markdown_export_and_db_protection(self):
        a = self.add("Visible note", "Export body ✓", "--tag", "ideas")
        b = self.add("Hidden note", "Archived content")
        self.invoke("archive", str(b["id"]))
        target = self.root / "exports" / "notes.md"
        result = self.invoke("export", "--output", str(target))
        self.assertEqual(result["count"], 1)
        self.assertEqual(Path(result["path"]).resolve(), target)
        contents = target.read_text()
        for part in ("Visible note", "Export body ✓", "ideas", str(a["id"])):
            self.assertIn(part, contents)
        self.assertNotIn("Hidden note", contents)
        self.assertEqual(self.invoke("export", "--output", str(target), "--include-archived")["count"], 2)
        self.assertIn("Hidden note", target.read_text())
        self.invoke("export", "--output", str(self.db), ok=False)
        self.assertEqual(self.invoke("show", str(a["id"]))["title"], a["title"])

    def test_07_human_output_and_documentation(self):
        self.add("Human readable", "Useful body")
        self.assertIn("Human readable", self.invoke("list", json_mode=False))
        readme = APP.parent / "README.md"
        self.assertTrue(readme.is_file())
        self.assertGreater(len(readme.read_text()), 300)
        self.assertTrue((APP.parent / ".gitignore").is_file())
        self.assertTrue(any((APP.parent / "tests").glob("test*.py")), "Add application unit tests")


if __name__ == "__main__":
    if not APP.is_file():
        sys.exit(f"Missing application entrypoint: {APP}")
    unittest.main(verbosity=2)
