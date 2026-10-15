import argparse
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from towercab import cli

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "bin" / "towercab"
HEAD = ["systemd-inhibit", "--what=sleep:idle:handle-lid-switch", "--who=Towercab",
        "--why=Working down the task list", "--mode=block"]


def ns(**kw):
    d = dict(home="/h", config=None, max_tasks=None, task=None)
    d.update(kw)
    return argparse.Namespace(**d)


class UpTests(unittest.TestCase):
    def test_up_argv(self):
        self.assertEqual(cli.up_argv(ns(), "py"),
                         HEAD + ["py", "-m", "towercab", "--home", "/h", "run", "--watch"])

    def test_up_argv_passes_options(self):
        self.assertEqual(cli.up_argv(ns(config="/c.toml", max_tasks=2, task="1715"), "py"),
                         HEAD + ["py", "-m", "towercab", "--home", "/h", "--config", "/c.toml",
                                 "run", "--watch", "--max-tasks", "2", "--task", "1715"])

    def test_up_execs_inhibit(self):
        with mock.patch("shutil.which", return_value="/usr/bin/systemd-inhibit"), \
             mock.patch("os.execvpe") as ex:
            cli.up(ns())
        argv = ex.call_args.args[1]
        self.assertEqual(ex.call_args.args[0], "systemd-inhibit")
        self.assertEqual(argv, cli.up_argv(ns()))
        self.assertIn(str(ROOT), ex.call_args.args[2]["PYTHONPATH"])

    def test_up_without_systemd_inhibit(self):
        with mock.patch("shutil.which", return_value=None), mock.patch("os.execvpe") as ex:
            with self.assertRaisesRegex(RuntimeError, "systemd-inhibit"):
                cli.up(ns())
        ex.assert_not_called()

    def test_up_cli_missing_binary_exits_1(self):
        err = io.StringIO()
        with mock.patch("shutil.which", return_value=None), mock.patch("os.execvpe") as ex, \
             mock.patch.object(sys, "argv", ["towercab", "up"]), contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("systemd-inhibit", err.getvalue())
        ex.assert_not_called()


class LauncherTests(unittest.TestCase):
    def test_launcher_from_other_cwd(self):
        with tempfile.TemporaryDirectory() as d:
            link = Path(d) / "towercab"
            link.symlink_to(LAUNCHER)
            for exe in (LAUNCHER, link):
                r = subprocess.run([sys.executable, str(exe), "--version"],
                                   capture_output=True, text=True, cwd=d)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout, "towercab 0.2.0\n")


if __name__ == "__main__":
    unittest.main()
