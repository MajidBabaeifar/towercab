from datetime import datetime
import unittest
from zoneinfo import ZoneInfo

from towercab.limits import is_limit, parse_reset

BERLIN = ZoneInfo("Europe/Berlin")
NOW = datetime(2026, 10, 15, 13, 30, tzinfo=BERLIN).timestamp()


def at(*args):
    return datetime(*args, tzinfo=BERLIN).timestamp()


class LimitTests(unittest.TestCase):
    def test_detects_limits(self):
        for text in ["You've hit your limit · resets 3pm (Europe/Berlin)", "Claude AI usage limit reached|1760540400",
                     "5-hour limit reached ∙ resets 7pm", "429 Too Many Requests", "API Error: Overloaded"]:
            self.assertTrue(is_limit(text), text)
        self.assertFalse(is_limit("Authentication required"))

    def test_reset_times(self):
        cases = {
            "You've hit your limit · resets 3pm (Europe/Berlin)": at(2026, 10, 15, 15, 0),
            "limit reached ∙ resets 11am (Europe/Berlin)": at(2026, 10, 16, 11, 0),   # already past today
            "weekly limit · resets Oct 17, 9:30am (Europe/Berlin)": at(2026, 10, 17, 9, 30),
            "Claude AI usage limit reached|1760540400": 1760540400,
            "429 rate limit retry-after: 120": NOW + 120,
            "rate limited, try again in 5 minutes": NOW + 300,
        }
        for text, expected in cases.items():
            self.assertAlmostEqual(parse_reset(text, NOW), expected, delta=1, msg=text)

    def test_unknown_reset(self):
        self.assertIsNone(parse_reset("429 Too Many Requests", NOW))
        self.assertIsNone(parse_reset("resets 3 things", NOW))


if __name__ == "__main__":
    unittest.main()
