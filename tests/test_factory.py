import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from factory.core import Factory, Store, command, review_result, run_process, unpack


class FactoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.s = Store(self.root / "state")

    def tearDown(self):
        self.s.db.close()
        self.tmp.cleanup()

    def mission(self, **kw):
        return self.s.add("hello", "Implement greet", kw.pop("source", None),
                          kw.pop("verify", [sys.executable,"-c","from hello import greet; assert greet('X') == 'Hello, X!'" ]),
                          demo=True, **kw)

    def test_new_product_full_cycle(self):
        mid = self.mission()
        Factory(self.s).run()
        m = self.s.get(mid)
        self.assertEqual(m["status"], "ready")
        self.assertEqual(m["attempts"], 4)
        self.assertIn("hello.py", (Path(m["workspace"]).parent / "changes.patch").read_text())

    def test_existing_repository_is_unchanged(self):
        source = self.root / "source"
        source.mkdir()
        command(["git","init"], source)
        (source / "existing.txt").write_text("keep me")
        command(["git","add","."], source)
        command(["git","-c","user.name=Test","-c","user.email=test@localhost","commit","-m","initial"],source)
        mid = self.mission(source=str(source))
        Factory(self.s).run()
        self.assertEqual(self.s.get(mid)["status"], "ready")
        self.assertFalse((source / "hello.py").exists())
        self.assertEqual(command(["git","status","--porcelain"],source), "")

    def test_failed_verification_exhausts_repairs(self):
        mid = self.mission(verify=[sys.executable,"-c","raise SystemExit(1)"], max_repairs=1)
        Factory(self.s).run()
        self.assertEqual(self.s.get(mid)["status"], "blocked")
        self.assertEqual(self.s.get(mid)["repairs"], 1)

    def test_review_rejection_returns_to_build(self):
        mid = self.mission(max_repairs=0)
        f = Factory(self.s)
        f.run(max_steps=3)
        with patch.object(f,"agent",return_value=(0,'{"approved":false,"feedback":"missing requirement"}',"")):
            f.run()
        self.assertEqual(self.s.get(mid)["status"], "blocked")

    def test_cooldown_persists_and_other_provider_runs(self):
        first = self.mission()
        second = self.mission(provider="claude")
        self.s.update(first, demo=0)
        self.s.update(second, demo=0)
        f = Factory(self.s)
        with patch.object(f,"agent",return_value=(1,"","429 rate limit retry-after: 120")):
            f.run(max_steps=1)
        self.assertEqual(self.s.get(first)["status"], "queued")
        self.assertGreater(self.s.db.execute("SELECT until FROM cooldowns").fetchone()[0],time.time()+100)
        with patch.object(f,"agent",return_value=(0,"plan", "")) as agent:
            f.run(max_steps=1)
            self.assertEqual(agent.call_args.args[2], "claude")

    def test_interrupted_stage_is_not_replayed(self):
        mid = self.mission()
        self.s.update(mid,status="running")
        Factory(self.s).run()
        self.assertEqual(self.s.get(mid)["status"], "blocked")

    def test_saved_queue_resumes_after_restart(self):
        mid = self.mission()
        Factory(self.s).run(max_steps=2)
        self.s.db.close()
        self.s = Store(self.root / "state")
        self.assertEqual(self.s.get(mid)["stage"], "verify")
        Factory(self.s).run()
        self.assertEqual(self.s.get(mid)["status"], "ready")

    def test_auth_failure_blocks_without_cooldown(self):
        mid = self.mission()
        f = Factory(self.s)
        with patch.object(f,"agent",return_value=(1,"","Authentication required")):
            f.run()
        self.assertEqual(self.s.get(mid)["status"], "blocked")
        self.assertEqual(self.s.db.execute("SELECT count(*) FROM cooldowns").fetchone()[0], 0)

    def test_exclusive_scheduler_lock(self):
        with self.s.lock():
            with self.assertRaises(ValueError):
                with self.s.lock():
                    pass

    def test_timeout(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            run_process([sys.executable,"-c","import time; time.sleep(5)"],self.root,self.root / "log",0.1)

    def test_structured_errors_and_review(self):
        stream = "\n".join(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":text}})
                           for text in ["Inspecting now", '{"approved":true,"feedback":"ok"}'])
        self.assertTrue(review_result(unpack("codex",stream)[0])["approved"])
        message,error = unpack("codex",json.dumps({"type":"turn.failed","error":{"message":"rate limit"}}))
        self.assertIn("rate limit",error)
        self.assertEqual(message,"")
        with self.assertRaises(ValueError):
            review_result('{"approved":"yes","feedback":"fine"}')
        self.assertTrue(review_result('```json\n{"approved":true,"feedback":"fine"}\n```')["approved"])


if __name__ == "__main__":
    unittest.main()
