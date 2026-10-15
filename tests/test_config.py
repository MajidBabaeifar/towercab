from pathlib import Path
import tempfile
import unittest

from towercab.config import EXAMPLE, ConfigError, load


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "config.toml"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, text):
        self.path.write_text(text)
        return load(self.path)

    def test_example_loads(self):
        c = self.write(EXAMPLE)
        r = c.repo("towercab")
        self.assertEqual(r.path, Path.home() / "Repositories/towercab")
        self.assertEqual(r.verify[:3], ["python3", "-m", "unittest"])
        self.assertIn("rg *", r.bash)
        self.assertEqual((c.cutoff, c.provider, c.timeout), (7, "claude", 1200))
        self.assertEqual(c.tasks_path, Path.home() / ".local/share/towercab/gradient-tasks")
        self.assertIsNone(c.repo("unknown"))

    def test_missing_file_explains(self):
        with self.assertRaises(ConfigError) as e:
            load(self.path)
        self.assertIn("[repos.towercab]", str(e.exception))

    def test_bad_repo(self):
        for bad in ['[tasks]\npath="x"\n[repos.r]\npath="p"\n',
                    '[tasks]\npath="x"\n[repos.r]\npath="p"\nverify="make test"\n',
                    '[tasks]\npath="x"\n[repos.r]\npath="p"\nverify=["make"]\nbash="ls"\n',
                    '[repos.r]\npath="p"\nverify=["make"]\n',
                    '[tasks]\npath="x"\n[agent]\nprovider="gpt"\n']:
            with self.assertRaises(ConfigError, msg=bad):
                self.write(bad)


if __name__ == "__main__":
    unittest.main()
