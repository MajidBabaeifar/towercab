import json
import unittest

from towercab.access import claude_argv, deny_rules, forbidden


def denial(tool, **data):
    return {"tool_name": tool, "tool_input": data}


class AccessTests(unittest.TestCase):
    def flag(self, argv, name):
        i = argv.index(name) + 1
        out = []
        while i < len(argv) and not argv[i].startswith("--"):
            out.append(argv[i])
            i += 1
        return out

    def test_plan_and_review_are_read_only(self):
        for stage in ("plan", "review"):
            argv = claude_argv("claude", stage, bash=["python3 -m unittest *"])
            allowed = self.flag(argv, "--allowedTools")
            self.assertNotIn("Edit", allowed)
            self.assertNotIn("Write", allowed)
            self.assertNotIn("Bash(python3 -m unittest *)", allowed)
            self.assertIn("Bash(git diff*)", allowed)

    def test_build_gets_repo_allowlist_only(self):
        argv = claude_argv("claude", "build", bash=["python3 -m unittest *"], model="sonnet")
        allowed = self.flag(argv, "--allowedTools")
        self.assertIn("Edit", allowed)
        self.assertIn("Bash(python3 -m unittest *)", allowed)
        self.assertNotIn("Bash", allowed)          # never blanket Bash
        self.assertEqual(self.flag(argv, "--model"), ["sonnet"])
        self.assertEqual(self.flag(argv, "--permission-mode"), ["dontAsk"])

    def test_never_bypasses_and_sandboxes(self):
        for stage in ("plan", "build", "review"):
            argv = claude_argv("claude", stage)
            self.assertFalse(any("dangerously" in a or a == "bypassPermissions" for a in argv))
            settings = json.loads(self.flag(argv, "--settings")[0])["sandbox"]
            self.assertTrue(settings["enabled"] and settings["failIfUnavailable"])
            self.assertFalse(settings["autoAllowBashIfSandboxed"])
            self.assertFalse(settings["allowUnsandboxedCommands"])
            self.assertIn("~/.ssh", settings["filesystem"]["denyRead"])

    def test_deny_rules(self):
        rules = deny_rules()
        for r in ["Read(~/.ssh/**)", "Read(~/.config/gh/**)", "Read(**/.env)", "Bash(git push*)",
                  "Bash(git commit*)", "Bash(gh*)", "Read(~/.claude/.credentials.json)"]:
            self.assertIn(r, rules)

    def test_forbidden_denials(self):
        bad = [denial("Read", file_path="~/.ssh/id_ed25519"),
               denial("Read", file_path="/home/x/proj/.env"),
               denial("Bash", command="cat ~/.ssh/known_hosts | head -1"),
               denial("Bash", command="git push origin main"),
               denial("Bash", command="npm test && git commit -am x"),
               denial("Bash", command="gh pr create")]
        ok = [denial("Bash", command="rg TODO"), denial("Read", file_path="/tmp/w/src/env.py"),
              denial("WebFetch", url="https://example.com")]
        for d in bad:
            self.assertTrue(forbidden(d), d)
        for d in ok:
            self.assertFalse(forbidden(d), d)


if __name__ == "__main__":
    unittest.main()
