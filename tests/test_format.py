import unittest

from towercab.format import file_bullets, first_sentence, pr_body, tg_message

DIFF = "M\ttowercab/runner.py\nA\ttowercab/format.py\nD\told.txt\nR100\ta.py\tb.py\n"


class PrBodyTests(unittest.TestCase):
    def test_pr_body_example(self):
        body = pr_body("Clear PR bodies", file_bullets(DIFF), "python3 -m unittest", True, True,
                       "Looks right. Tests cover both formats.", "261015-2027", "abc123", 0.42, 390)
        self.assertEqual(body, "\n".join([
            "Clear PR bodies",
            "",
            "## What changed",
            "- changed `towercab/runner.py`",
            "- added `towercab/format.py`",
            "- removed `old.txt`",
            "- renamed `b.py`",
            "",
            "## Checks",
            "- Verify: passed — `python3 -m unittest`",
            "- Review: approved — Looks right.",
            "",
            "<sub>Task `261015-2027` · mission `abc123` · $0.42 · 6.5 min</sub>",
        ]))

    def test_pr_body_limits(self):
        many = "".join(f"M\tf{i}.py\n" for i in range(9))
        bullets = file_bullets(many)
        self.assertEqual(len(bullets), 5)
        self.assertEqual(bullets[-1], "+5 more files")
        body = pr_body("S", bullets, "v", True, True, "x" * 300, "t", "m", repairs=2)
        self.assertNotIn("{", body)
        self.assertLessEqual(body.count("\n- "), 7)
        self.assertIn("2 repairs", body)
        self.assertNotIn("$", body)                       # cost unknown: omitted
        self.assertLessEqual(len(first_sentence("y" * 500)), 120)

    def test_pr_body_has_layout(self):
        body = pr_body("S", [], "v", True, False, "Fix the edge case. Then more.", "t", "m")
        self.assertIn("- no file changes", body)
        self.assertIn("- Review: not approved — Fix the edge case.", body)
        self.assertNotIn("repairs", body)


class TelegramTests(unittest.TestCase):
    def test_tg_examples(self):
        self.assertEqual(tg_message("✅", "Ship it", "PR ready", "Review: https://x/pull/1"),
                         "✅ Ship it: PR ready\nReview: https://x/pull/1")
        self.assertEqual(tg_message("⏳", "claude", "limit hit", "Resumes 15:00 CEST"),
                         "⏳ claude: limit hit\nResumes 15:00 CEST")
        self.assertEqual(tg_message("🎉", "T-1", "merged"), "🎉 T-1: merged")

    def test_tg_max_four_lines(self):
        text = tg_message("⛔", "T", "stuck at build", "a\nb\nc\nd\ne\n" + "z" * 500)
        lines = text.splitlines()
        self.assertEqual(len(lines), 4)
        self.assertTrue(all(len(ln) <= 200 for ln in lines))


if __name__ == "__main__":
    unittest.main()
