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

    def test_ci_settings(self):
        c = self.write('[tasks]\npath="x"\n')
        self.assertEqual((c.ci_poll, c.ci_grace, c.ci_wait), (30, 120, 1800))
        c = self.write('[tasks]\npath="x"\n[agent]\nci_poll=5\nci_grace=60\nci_wait=600\n')
        self.assertEqual((c.ci_poll, c.ci_grace, c.ci_wait), (5, 60, 600))

    def test_telegram_config(self):
        base = '[tasks]\npath="x"\n'
        self.assertIsNone(self.write(base).telegram)
        tg = self.write(base + '[telegram]\nbot_token="1:a"\nchat_id="42"\n').telegram
        self.assertEqual((tg.bot_token, tg.chat_id, tg.api_base), ("1:a", "42", "https://api.telegram.org"))
        for bad in ['[telegram]\nbot_token="1:a"\n', '[telegram]\nchat_id="42"\n',
                    '[telegram]\nbot_token="1:a"\nchat_id=42\n', '[telegram]\nbot_token=""\nchat_id="42"\n']:
            with self.assertRaises(ConfigError, msg=bad):
                self.write(base + bad)


if __name__ == "__main__":
    unittest.main()
