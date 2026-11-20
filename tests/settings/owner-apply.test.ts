// REPO-33, REPO-38..41: the plan on the card and Apply as the owner, over local bare repos and a fake `gh`
// and script. Never the network.

import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applySettings, settingsCycle, settingsPass } from "../../src/settings/apply.ts";
import { storedSettings } from "../../src/settings/store.ts";
import { failResult, okResult } from "../helpers/tools.ts";
import { ghHandler, type SettingsRig, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

const scriptPath = (s: SettingsRig) => join(s.r.home, "tmp", "ci-apply-v1.0.0", "bin", "apply-settings");
const scriptCalls = (s: SettingsRig) => s.r.tools.calls.filter((c) => c.cmd.endsWith("bin/apply-settings"));
const asApp = (env: Record<string, string> | undefined) => env?.GH_TOKEN === "app";

const PLAN = JSON.stringify({
  changes: [
    { setting: "delete_branch_on_merge", now: "false", after: "true" },
    "ruleset main rules is added",
  ],
  rulesets: [{ required_status_checks: ["ci-ok"] }],
});

test("repo: a gaps check stores the plan", async () => {
  const s = await settingsRig();
  s.script.plan = PLAN;
  const out = await settingsPass(s.deps, s.web);
  expect(out.plan).toEqual([
    { what: "delete_branch_on_merge", now: "false", after: "true" },
    { what: "ruleset main rules is added" },
  ]);
  expect(storedSettings(s.r.db, "web")?.plan).toEqual(out.plan);
});

test("repo: a release without plan shows no plan", async () => {
  const s = await settingsRig();
  s.script.plan = null;
  const out = await settingsPass(s.deps, s.web);
  expect(out.state).toBe("gaps");
  expect(out.plan).toBeUndefined();
});

test("repo: the daily check never applies", async () => {
  const s = await settingsRig();
  await settingsCycle(s.deps);
  s.r.clock.advance(2 * 24 * 3600);
  await settingsCycle(s.deps);
  expect(scriptCalls(s).length).toBeGreaterThan(0);
  for (const c of scriptCalls(s)) expect(["--check", "--plan"]).toContain(c.args[0]);
  expect(s.gh.writes).toEqual([]);
});

test("repo: nothing applies without the click", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  expect(storedSettings(s.r.db, "web")?.state).toBe("gaps");
  expect(scriptCalls(s).map((c) => c.args[0])).toEqual(["--check", "--plan"]);
  expect(s.gh.writes).toEqual([]);
});

test("repo: apply runs as the owner for one repo only", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  s.r.tools.calls.length = 0;
  const out = await applySettings(s.deps, s.web);
  expect(out.state).toBe("ok");
  const runs = scriptCalls(s);
  expect(runs.map((c) => c.args.join(" "))).toEqual(["--plan owner/web", "owner/web", "--check owner/web"]);
  // No token from Towercab: `gh` falls back to the owner's own login.
  for (const c of runs) expect(c.opts.env).not.toHaveProperty("GH_TOKEN");
  // The guard's and the backup's reads are the owner's too, and nothing is read or written elsewhere.
  const gh = s.r.tools.calls.filter((c) => c.cmd === "gh");
  expect(gh.length).toBeGreaterThan(0);
  for (const c of gh) {
    expect(asApp(c.opts.env)).toBe(false);
    expect(c.args.join(" ")).not.toMatch(/owner\/ci|owner\/intents/);
  }
});

test("repo: apply is refused for a repo without gaps", async () => {
  const s = await settingsRig();
  await expect(applySettings(s.deps, s.web)).rejects.toThrow("web has no settings gaps to apply");
  s.script.gaps = [];
  await settingsPass(s.deps, s.web);
  await expect(applySettings(s.deps, s.web)).rejects.toThrow("web has no settings gaps to apply");
  expect(scriptCalls(s).map((c) => c.args[0])).toEqual(["--check"]);
});

test("repo: two applies for one repo do not overlap", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  const first = applySettings(s.deps, s.web);
  await expect(applySettings(s.deps, s.web)).rejects.toThrow(/being applied already/);
  await first;
  // Once it is over, the repo has no gaps left; a click is refused for that reason, not for overlap.
  await expect(applySettings(s.deps, s.web)).rejects.toThrow(/no settings gaps/);
});

test("repo: a check the App cannot read is read as the owner", async () => {
  const s = await settingsRig();
  s.r.tools.on(scriptPath(s), (args, opts) => {
    s.script.runs.push(args);
    if (asApp(opts.env)) return failResult("gh: Resource not accessible by integration (HTTP 403)", 2);
    if (args[0] === "--check")
      return { code: 1, stdout: "branch protection is off\n", stderr: "", timedOut: false };
    return okResult(PLAN);
  });
  const out = await settingsPass(s.deps, s.web);
  expect(out).toMatchObject({ state: "gaps", gaps: ["branch protection is off"] });
  expect(out.plan).toHaveLength(2);
  expect(scriptCalls(s).map((c) => [c.args[0], asApp(c.opts.env) ? "app" : "owner"])).toEqual([
    ["--check", "app"],
    ["--check", "owner"],
    ["--plan", "owner"],
  ]);
});

test("repo: a read as the owner never writes", async () => {
  const s = await settingsRig();
  s.r.tools.on(scriptPath(s), (args, opts) =>
    asApp(opts.env)
      ? failResult("gh: Resource not accessible by integration (HTTP 403)", 2)
      : args[0] === "--check"
        ? { code: 1, stdout: "gap\n", stderr: "", timedOut: false }
        : okResult(PLAN),
  );
  await settingsPass(s.deps, s.web);
  s.r.clock.advance(25 * 3600);
  await settingsPass(s.deps, s.web);
  for (const c of scriptCalls(s)) expect(["--check", "--plan"]).toContain(c.args[0]);
  expect(s.gh.writes).toEqual([]);
});

test("repo: a check nobody can read is unknown", async () => {
  const s = await settingsRig();
  s.r.tools.on(scriptPath(s), (_args, opts) =>
    asApp(opts.env)
      ? failResult("gh: Resource not accessible by integration (HTTP 403)", 2)
      : failResult("gh: To get started with GitHub CLI, please run: gh auth login", 2),
  );
  const out = await settingsPass(s.deps, s.web);
  expect(out.state).toBe("unknown");
  expect(out.note).toMatch(/could not be checked: gh: To get started/);
});

test("repo: a forbidden owner apply says so once", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  s.script.forbidden = true;
  const out = await applySettings(s.deps, s.web);
  const words = "Your GitHub login can't change this repo's settings: it needs admin on owner/web";
  expect(out).toMatchObject({ state: "gaps", gaps: ["merge rules are off"], note: words });
  expect(storedSettings(s.r.db, "web")?.note).toBe(words);
  expect(scriptCalls(s).filter((c) => c.args[0] === "owner/web")).toHaveLength(1);
});

test("repo: a network failure in an apply can be clicked again", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  const real = ghHandler(s.gh);
  let down = true;
  s.r.tools.on("gh", (args, opts) =>
    down && args[1] === "repos/owner/web/rulesets" ? failResult("gh: connection reset") : real(args, opts),
  );
  const first = await applySettings(s.deps, s.web);
  expect(first.state).toBe("gaps");
  expect(first.note).toMatch(/^Nothing applied: no backup/);
  down = false;
  expect((await applySettings(s.deps, s.web)).state).toBe("ok");
});

const addSteps = (s: SettingsRig, intent: string, steps: { n: number; text: string }[]) =>
  s.r.db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, data, created, updated)
     VALUES (?, 'web', 1, 'steps', 'your steps', 'opus', 's', 'w', 'b', ?, 0, 0)`,
    intent,
    JSON.stringify({
      delivery: "steps",
      steps: steps.map((x) => ({ ...x, when: "after", why: "", done_at: null })),
    }),
  );
const stepsOf = (s: SettingsRig, intent: string) =>
  (
    JSON.parse(s.r.db.get<{ data: string }>("SELECT data FROM missions WHERE intent = ?", intent)!.data) as {
      steps: { n: number; done_at: string | null }[];
    }
  ).steps.map((x) => !!x.done_at);

test("repo: a settings-only intent becomes owner steps", async () => {
  const s = await settingsRig();
  addSteps(s, "i1", [
    { n: 1, text: "Apply the standard GitHub settings to owner/web" },
    { n: 2, text: "Tell the team" },
  ]);
  // Neither the daily check nor an Apply that leaves a gap ticks anything: the steps stay the owner's.
  await settingsPass(s.deps, s.web);
  s.r.tools.on(scriptPath(s), (args) =>
    args[0] === "--plan"
      ? okResult(PLAN)
      : {
          code: args[0] === "--check" ? 1 : 0,
          stdout: args[0] === "--check" ? "still wrong\n" : "",
          stderr: "",
          timedOut: false,
        },
  );
  await applySettings(s.deps, s.web);
  expect(stepsOf(s, "i1")).toEqual([false, false]);
});

test("repo: an apply that ends ok ticks a settings-only intent's steps", async () => {
  const s = await settingsRig();
  addSteps(s, "i1", [
    { n: 1, text: "Apply the standard GitHub settings to owner/web" },
    { n: 2, text: "Tell the team" },
  ]);
  await settingsPass(s.deps, s.web);
  await applySettings(s.deps, s.web);
  expect(stepsOf(s, "i1")).toEqual([true, false]);
});

test("repo: settings script runs never overlap", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  let running = 0;
  let most = 0;
  s.r.tools.on(scriptPath(s), async (args) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setImmediate(r));
    running--;
    return args[0] === "--check" ? { code: 1, stdout: "gap\n", stderr: "", timedOut: false } : okResult(PLAN);
  });
  await Promise.all([settingsPass(s.deps, s.web), applySettings(s.deps, s.web)]);
  expect(most).toBe(1);
});
