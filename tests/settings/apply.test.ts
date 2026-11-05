// REPO-31: applying the standard settings, behind the opt-in, the ruleset guard and a backup. Over local bare
// repos and a fake `gh` and script. Never the network.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseTowercab } from "../../src/repo/files.ts";
import { nextSettingsDue, settingsPass } from "../../src/settings/apply.ts";
import { newestBackup } from "../../src/settings/backup.ts";
import { saveSettings, storedSettings } from "../../src/settings/store.ts";
import { testConfig } from "../helpers/world.ts";
import { ghHandler, type SettingsRig, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

const dirOf = (home: string) => join(home, "settings-backups", "owner", "web");
const scriptPath = (s: SettingsRig) => join(s.r.home, "tmp", "ci-apply-v1.0.0", "bin", "apply-settings");

test("repo: settings stay check-only by default", async () => {
  expect(testConfig().githubSettings).toBe("check");
  const s = await settingsRig();
  const out = await settingsPass(s.deps, s.web);
  expect(out.state).toBe("gaps");
  expect(s.script.runs).toEqual([["--check", "owner/web"]]);
  expect(s.gh.writes).toEqual([]);
  expect(existsSync(dirOf(s.r.home))).toBe(false);
});

test("repo: a bad settings mode is rejected", () => {
  expect(() => testConfig({ github: { app_id: 1, me: "owner", settings: "yes" } })).toThrow(
    /settings must be check or apply/,
  );
  expect(testConfig({ github: { app_id: 1, me: "owner", settings: "apply" } }).githubSettings).toBe("apply");
});

test("repo: TOWERCAB.md settings check keeps a repo check-only", async () => {
  expect(parseTowercab("---\nsettings: check\n---\n").settings).toBe("check");
  const s = await settingsRig({ apply: true });
  s.gh.towercab = "---\nsettings: check\n---\n";
  const out = await settingsPass(s.deps, s.web);
  expect(out.state).toBe("gaps");
  expect(s.script.runs).toEqual([["--check", "owner/web"]]);
  expect(existsSync(dirOf(s.r.home))).toBe(false);
});

test("repo: a bad TOWERCAB.md settings value is invalid", async () => {
  expect(() => parseTowercab("---\nsettings: apply\n---\n")).toThrow("settings: apply isn't check");
  // An unreadable file is check-only, the safe side.
  const s = await settingsRig({ apply: true });
  s.gh.towercab = "---\nsettings: apply\n---\n";
  await settingsPass(s.deps, s.web);
  expect(s.script.runs).toEqual([["--check", "owner/web"]]);
});

test("repo: apply runs the script then checks again", async () => {
  const s = await settingsRig({ apply: true });
  const out = await settingsPass(s.deps, s.web);
  expect(s.script.runs.map((a) => a.join(" "))).toEqual([
    "--check owner/web",
    "--plan owner/web",
    "owner/web",
    "--check owner/web",
  ]);
  expect(out).toMatchObject({ state: "ok", gaps: [], tag: "v1.0.0" });
  // The script ran as the App with one repo, and no other token.
  const runs = s.r.tools.calls.filter((c) => c.cmd.endsWith("bin/apply-settings"));
  expect(runs.every((c) => c.opts.env?.GH_TOKEN === "app" && !("GITHUB_TOKEN" in (c.opts.env ?? {})))).toBe(
    true,
  );
  expect(s.logs).toContain("apply-settings v1.0.0 apply owner/web");
  expect(storedSettings(s.r.db, "web")?.state).toBe("ok");
});

test("repo: a gap that survives the apply is not retried until the next day", async () => {
  const s = await settingsRig({ apply: true });
  // An apply that changes nothing: the check still finds the gap afterwards.
  s.r.tools.on(scriptPath(s), (args) => {
    s.script.runs.push(args);
    if (args[0] === "--check") return { code: 1, stdout: "still wrong\n", stderr: "", timedOut: false };
    if (args[0] === "--plan") return { code: 0, stdout: s.script.plan!, stderr: "", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  });
  const out = await settingsPass(s.deps, s.web);
  expect(out).toMatchObject({ state: "gaps", gaps: ["still wrong"] });
  expect(s.script.runs.filter((a) => a[0] === "owner/web")).toHaveLength(1);
  // ci's own turn is later than web's, so web is the next repo due once its day is over.
  saveSettings(s.r.db, "ci", { state: "ok", gaps: [], tag: null, at: Math.floor(s.r.clock.now()) + 3000 });
  s.r.clock.advance(23 * 3600);
  expect(nextSettingsDue(s.deps)).toBeNull();
  s.r.clock.advance(2 * 3600);
  expect(nextSettingsDue(s.deps)?.name).toBe("web");
});

test("repo: the required check names come from the plan", async () => {
  const s = await settingsRig({ apply: true });
  s.script.plan = JSON.stringify({
    rulesets: [{ required_status_checks: ["build-ok", { context: "lint" }] }],
  });
  s.gh.runs = [
    ["build-ok", "success"],
    ["lint", "failure"],
  ];
  const out = await settingsPass(s.deps, s.web);
  expect(out.ruleset).toBe("Ruleset not applied: lint has not run green on main");
  expect(s.script.runs.map((a) => a[0])).toContain("--skip-ruleset");
});

test("repo: a green main gets the whole apply", async () => {
  const s = await settingsRig({ apply: true });
  const out = await settingsPass(s.deps, s.web);
  expect(s.script.runs.map((a) => a[0])).not.toContain("--skip-ruleset");
  expect(out.ruleset).toBeUndefined();
  expect(out.state).toBe("ok");
});

test("repo: a main not green gets everything but the ruleset", async () => {
  const cases: ((s: SettingsRig) => void)[] = [
    (s) => {
      s.gh.runs = [["ci-ok", "failure"]];
    },
    (s) => {
      s.gh.runs = [];
    },
    (s) => {
      s.script.plan = null;
    },
  ];
  for (const make of cases) {
    const s = await settingsRig({ apply: true });
    make(s);
    s.script.rulesetGap = "ruleset is missing";
    const out = await settingsPass(s.deps, s.web);
    expect(s.script.runs.map((a) => a[0])).toContain("--skip-ruleset");
    expect(out.ruleset).toMatch(/^Ruleset not applied: /);
    // Everything else is applied; only the ruleset's gap is left, and it is reported.
    expect(out).toMatchObject({ state: "gaps", gaps: ["ruleset is missing"] });
  }
  const s = await settingsRig({ apply: true });
  s.gh.runs = [["ci-ok", "failure"]];
  const out = await settingsPass(s.deps, s.web);
  expect(out.ruleset).toBe("Ruleset not applied: ci-ok has not run green on main");
});

test("repo: a release without skip-ruleset applies nothing to a repo not green", async () => {
  const s = await settingsRig({ apply: true });
  s.gh.runs = [["ci-ok", "failure"]];
  s.script.skipRuleset = false;
  const out = await settingsPass(s.deps, s.web);
  expect(out.state).toBe("gaps");
  expect(out.note).toMatch(/Nothing applied: this ci release has no --skip-ruleset/);
  expect(s.script.runs.map((a) => a[0])).not.toContain("owner/web");
});

test("repo: no backup, no apply", async () => {
  const s = await settingsRig({ apply: true });
  const real = ghHandler(s.gh);
  s.r.tools.on("gh", (args, opts) =>
    args[1] === "repos/owner/web/rulesets"
      ? { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)\n", timedOut: false }
      : real(args, opts),
  );
  const out = await settingsPass(s.deps, s.web);
  expect(out.state).toBe("gaps");
  expect(out.note).toMatch(/^Nothing applied: no backup/);
  expect(s.script.runs.map((a) => a[0])).not.toContain("owner/web");
});

test("repo: apply backs up everything the script can change and keeps 5", async () => {
  const s = await settingsRig({ apply: true });
  for (let i = 0; i < 6; i++) {
    s.script.gaps = ["merge rules are off"];
    s.r.clock.advance(25 * 3600);
    await settingsPass(s.deps, s.web);
  }
  const files = readdirSync(dirOf(s.r.home)).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(5);
  const b = newestBackup(s.deps, s.web)!;
  expect(b.repository.allow_squash_merge).toBe(true);
  expect(b.securityAndAnalysis).toEqual({ secret_scanning: { status: "enabled" } });
  expect(b.rulesets.map((r) => r.name)).toEqual(["main rules"]);
  expect(Object.keys(b.protection)).toEqual(["main"]);
  expect(b.protection.main?.enforce_admins).toEqual({ enabled: true });
  expect(b.workflow).toEqual({
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  });
  expect(b.vulnerabilityAlerts).toBe(true);
  // A part that does not exist is saved as absent.
  s.gh.protection = null;
  s.gh.alerts = false;
  s.script.gaps = ["x"];
  s.r.clock.advance(25 * 3600);
  await settingsPass(s.deps, s.web);
  const c = newestBackup(s.deps, s.web)!;
  expect(c.protection.main).toBeNull();
  expect(c.vulnerabilityAlerts).toBe(false);
});

test("repo: the backup includes another branch the plan names", async () => {
  const s = await settingsRig({ apply: true });
  s.script.plan = JSON.stringify({
    rulesets: [{ required_status_checks: ["ci-ok"] }],
    branches: ["release"],
  });
  const real = ghHandler(s.gh);
  s.r.tools.on("gh", (args, opts) =>
    args[1] === "repos/owner/web/branches/release/protection"
      ? {
          code: 0,
          stdout: JSON.stringify({ enforce_admins: { enabled: false } }),
          stderr: "",
          timedOut: false,
        }
      : real(args, opts),
  );
  await settingsPass(s.deps, s.web);
  expect(Object.keys(newestBackup(s.deps, s.web)!.protection).sort()).toEqual(["main", "release"]);
});
