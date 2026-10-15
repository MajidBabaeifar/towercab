from pathlib import Path
import unittest

from towercab.tasks import Document, ParseError, done_ids, done_line, new_id, parse_task_line, pick_next

SAMPLE = """# TODO

## Section

- [ ] 261015-1446 u4 i3 a3 towercab: Rename factory module to towercab
  done when: `python3 -m towercab demo` passes
- [!] 261015-1500-2 i5 blog: Fix sitemap after:261015-1446 @sonnet
  pr: https://github.com/o/r/pull/7
- [~] towercab: Parse task lines (marker, ID, u/i/a: all of it)
not a task
- [ ] broken line without repo
"""


class ParseTests(unittest.TestCase):
    def test_every_part(self):
        t = parse_task_line("- [!] 261015-1500-2 u1 i5 a4 blog: Fix the sitemap after:261015-1446,261015-1447 @sonnet")
        self.assertEqual((t.marker, t.id, t.scores, t.repo, t.title, t.after, t.model),
                         ("!", "261015-1500-2", {"u": 1, "i": 5, "a": 4}, "blog", "Fix the sitemap",
                          ["261015-1446", "261015-1447"], "sonnet"))
        self.assertEqual(t.state, "waiting")

    def test_minimal_line_gets_defaults(self):
        t = parse_task_line("- [ ] towercab: Do it")
        self.assertIsNone(t.id)
        self.assertEqual((t.score("u"), t.score("i"), t.score("a"), t.priority), (3, 3, 2, 9))

    def test_colons_inside_title(self):
        t = parse_task_line("- [~] towercab: Parse (marker: all): ok")
        self.assertEqual(t.title, "Parse (marker: all): ok")

    def test_errors(self):
        for bad in ["- [ ] no repo here", "- [ ] u9 towercab: x", "- [ ] u1 u2 towercab: x",
                    "- [ ] towercab: after:261015-1446", "- [ ] r: x after:foo"]:
            with self.assertRaises(ParseError, msg=bad):
                parse_task_line(bad)


class DocumentTests(unittest.TestCase):
    def test_round_trip_is_byte_identical(self):
        self.assertEqual(Document(SAMPLE).render(), SAMPLE)
        self.assertEqual(Document("no newline").render(), "no newline")

    def test_real_task_list_round_trips(self):
        path = Path.home() / "Repositories/gradient-tasks/TODO.md"
        if path.exists():
            text = path.read_text()
            self.assertEqual(Document(text).render(), text)

    def test_continuations_and_errors(self):
        doc = Document(SAMPLE)
        self.assertEqual([t.repo for t in doc.list()], ["towercab", "blog", "towercab"])
        self.assertEqual(doc.get("1446").get("done when"), "`python3 -m towercab demo` passes")
        self.assertEqual(doc.get("261015-1500-2").get("pr"), "https://github.com/o/r/pull/7")
        self.assertEqual(len(doc.errors), 1)
        self.assertIn("broken line", doc.render())

    def test_changes_render_canonically_and_leave_rest(self):
        doc = Document(SAMPLE)
        t = doc.get("1446")
        t.mark("!")
        t.set("pr", "https://x/pull/1")
        out = doc.render()
        self.assertIn("- [!] 261015-1446 u4 i3 a3 towercab: Rename factory module to towercab\n"
                      "  done when: `python3 -m towercab demo` passes\n  pr: https://x/pull/1\n", out)
        self.assertEqual(out.replace("- [!] 261015-1446", "- [ ] 261015-1446").replace("  pr: https://x/pull/1\n", ""), SAMPLE)

    def test_normalize_and_add_assign_ids(self):
        doc = Document(SAMPLE)
        unscored = doc.list()[2]
        now = 1760000000
        doc.normalize(unscored, now=now)
        self.assertEqual(unscored.id, new_id(set(), now))
        self.assertEqual(unscored.scores, {"u": 3, "i": 3, "a": 2})
        added = doc.add("towercab", "Next thing", now=now)
        self.assertEqual(added.id, unscored.id + "-2")
        self.assertIn(f"- [ ] {added.id} u3 i3 a2 towercab: Next thing", doc.render())

    def test_ids_never_reused(self):
        now = 1760000000
        doc = Document("- [ ] r: a\n- [ ] r: b\n")
        doc.taken = {new_id(set(), now)}                 # already in DONE.md
        first, second = doc.list()
        doc.normalize(first, now=now)
        doc.remove(first)                                # moved to DONE.md in the same change
        doc.normalize(second, now=now)
        self.assertEqual(first.id, new_id(set(), now) + "-2")
        self.assertEqual(second.id, new_id(set(), now) + "-3")

    def test_get_by_suffix_must_be_unique(self):
        doc = Document("- [ ] 261015-1446 r: a\n- [ ] 261015-1546 r: b\n")
        with self.assertRaises(KeyError):
            doc.get("46")
        self.assertEqual(doc.get("1546").title, "b")


class PickTests(unittest.TestCase):
    def test_order_and_reason(self):
        doc = Document("""- [ ] r: unscored first in file
- [ ] 261015-1000 u1 i1 r: parked
- [!] 261015-1001 i5 r: waiting
- [ ] 261015-1003 u3 i4 r: newer high
- [ ] 261015-1002 u3 i4 r: older high
- [ ] 261015-1004 i5 r: needs dep after:261014-0900
""")
        t, why = pick_next(doc, done_text="")
        self.assertEqual(t.title, "older high")
        self.assertIn("priority 11", why)
        self.assertIn("1 waiting on you", why)
        self.assertIn("1 parked", why)
        self.assertIn("1 blocked by after:", why)
        t, _ = pick_next(doc, done_text="2026-10-14 261014-0900 r: dep · no PR")
        self.assertEqual(t.title, "needs dep")

    def test_unscored_keep_file_order(self):
        doc = Document("- [ ] r: one\n- [ ] r: two\n")
        self.assertEqual(pick_next(doc)[0].title, "one")
        self.assertIsNone(pick_next(Document("- [!] r: x\n"))[0])

    def test_done_line(self):
        t = parse_task_line("- [ ] 261015-1446 r: Thing")
        self.assertEqual(done_line(t, "r#5", 3.587, 86, 1, today="2026-10-15"),
                         "2026-10-15 261015-1446 r: Thing · r#5 · $3.59 · 1m26s · 1")
        self.assertEqual(done_ids("2026-10-15 261015-1446 r: Thing"), {"261015-1446"})


if __name__ == "__main__":
    unittest.main()
