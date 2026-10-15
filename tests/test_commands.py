"""Telegram command parsing (RUN-26); the behaviour tests live in test_runner.py."""
import unittest

from towercab.commands import parse


class ParseTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse("status"), ("status", ""))
        self.assertEqual(parse("/Approve@towercab_bot 1015-3"), ("approve", "1015-3"))
        self.assertEqual(parse("  run   abc  def "), ("run", "abc  def"))
        self.assertEqual(parse(""), ("", ""))
        self.assertEqual(parse(None), ("", ""))


if __name__ == "__main__":
    unittest.main()
