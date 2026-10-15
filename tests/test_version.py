from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent


class VersionTests(unittest.TestCase):
    def test_version_flag(self):
        r = subprocess.run([sys.executable, "-m", "towercab", "--version"],
                           capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "towercab 0.2.0\n")


if __name__ == "__main__":
    unittest.main()
