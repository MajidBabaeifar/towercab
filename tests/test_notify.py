import socket
import unittest

from towercab.notify import Notifier
from fake_telegram import FakeTelegram

TOKEN = "123456:SECRET-token"


class NotifyTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeTelegram()
        self.addCleanup(self.api.stop)
        self.log = []

    def notifier(self, **kw):
        return Notifier(TOKEN, "42", self.api.url, out=self.log.append, **kw)

    def test_send_request(self):
        self.assertTrue(self.notifier().send("hello"))
        self.assertEqual(self.api.calls, [(f"/bot{TOKEN}/sendMessage", {"chat_id": "42", "text": "hello"})])

    def test_disabled_without_config(self):
        n = Notifier(out=self.log.append)
        self.assertFalse(n.enabled)
        self.assertFalse(n.pr_ready("t", "u"))
        self.assertEqual(self.api.calls, [])

    def test_event_messages(self):
        n = self.notifier()
        n.pr_ready("T-1", "https://x/pull/1")
        n.stuck("T-1", "build", "tests fail")
        n.asking("T-1", "which repo?")
        n.limit("claude", "2026-10-15 15:00 CEST")
        n.merged("T-1", "proj#1")
        t = self.api.texts
        self.assertIn("T-1", t[0]); self.assertIn("https://x/pull/1", t[0])
        self.assertIn("build", t[1]); self.assertIn("tests fail", t[1])
        self.assertIn("which repo?", t[2])
        self.assertIn("claude", t[3]); self.assertIn("2026-10-15 15:00 CEST", t[3])
        self.assertIn("proj#1", t[4])

    def test_failures_never_raise(self):
        self.api.status = 500
        n = self.notifier()
        self.assertFalse(n.send("x"))
        self.assertFalse(n.send("y"))
        self.assertEqual(len(self.log), 1)                    # logged once per outage
        self.assertNotIn(TOKEN, " ".join(self.log))
        self.api.stop()                                       # connection refused
        refused = Notifier(TOKEN, "42", self.api.url, out=self.log.append)
        self.assertFalse(refused.send("x"))
        self.assertNotIn(TOKEN, " ".join(self.log))

    def test_timeout(self):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)                                         # accepts, never answers
        self.addCleanup(srv.close)
        n = Notifier(TOKEN, "42", f"http://127.0.0.1:{srv.getsockname()[1]}", timeout=0.3, out=self.log.append)
        self.assertFalse(n.send("x"))
        self.assertNotIn(TOKEN, " ".join(self.log))

    def test_broken_out_does_not_raise(self):
        def boom(*a):
            raise RuntimeError("log failed")
        self.api.status = 500
        self.assertFalse(Notifier(TOKEN, "42", self.api.url, out=boom).send("x"))


if __name__ == "__main__":
    unittest.main()
