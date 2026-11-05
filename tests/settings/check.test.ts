// REPO-25 and REPO-30: the daily settings check from the pinned ci release, over local bare repos and a
// fake `gh` and script. Never the network.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureClone } from "../../src/checkout.ts";
import { clonePath } from "../../src/config.ts";
import { settingsCycle, settingsPass } from "../../src/settings/apply.ts";
import { storedSettings } from "../../src/settings/store.ts";
import { settingsView } from "../../src/ui/repos.ts";
import { release } from "../helpers/ready.ts";
import { git, tempDir } from "../helpers/world.ts";
import { type SettingsRig, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

const refetchCi = async (s: SettingsRig) => {
  const ci = s.r.config.repos.get("ci")!;
  await ensureClone(s.r.tools, clonePath(ci, s.r.home), ci);
};

test("repo: settings run from the latest ci release tag on main", async () => {
  const s = await settingsRig({ tags: ["v1.0.0", "v2.0.0"] });
  // A newer tag that is not on main, and a head commit with no tag, are never run.
  const work = join(tempDir("tc-side-"), "w");
  git(tempDir(), "clone", "-q", s.r.remotes.ci!, work);
  git(work, "checkout", "-q", "-b", "side");
  writeFileSync(join(work, "x"), "x");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "side");
  git(work, "tag", "v3.0.0");
  git(work, "push", "-q", "origin", "side", "v3.0.0");
  release(s.r.remotes.ci!, { "bin/apply-settings": "#!/bin/sh\n# head\n" });
  await refetchCi(s);
  const out = await settingsPass(s.deps, s.web);
  expect(out).toMatchObject({ state: "gaps", tag: "v2.0.0", gaps: ["merge rules are off"] });
  expect(s.script.runs).toEqual([["--check", "owner/web"]]);
});

test("repo: no ci release tag is unknown, never the head", async () => {
  const s = await settingsRig({ tags: [] });
  release(s.r.remotes.ci!, { "bin/apply-settings": "#!/bin/sh\n" });
  await refetchCi(s);
  const out = await settingsPass(s.deps, s.web);
  expect(out.state).toBe("unknown");
  expect(out.note).toBe(
    "The standard settings could not be checked: No ci release to run the standard settings from: tag a v* release on ci's main",
  );
  expect(s.script.runs).toEqual([]);
});

test("repo: the settings run is logged with its tag", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  expect(s.logs).toContain("apply-settings v1.0.0 check owner/web");
});

test("repo: settings are checked daily for every repo", async () => {
  const s = await settingsRig();
  // Every registered repo is checked, ci included, whatever its `TOWERCAB.md`.
  const first = await settingsCycle(s.deps);
  const second = await settingsCycle(s.deps);
  expect([first, second].sort()).toEqual(["ci", "web"]);
  expect(await settingsCycle(s.deps)).toBeNull();
  s.r.clock.advance(23 * 3600);
  expect(await settingsCycle(s.deps)).toBeNull();
  s.r.clock.advance(2 * 3600);
  expect(await settingsCycle(s.deps)).not.toBeNull();
  expect(storedSettings(s.r.db, "web")?.tag).toBe("v1.0.0");
});

test("repo: settings gaps are stored and shown on the repo page", async () => {
  const s = await settingsRig();
  expect(settingsView(s.r.db, "web")).toMatchObject({ state: "unknown", summary: "Not checked yet" });
  await settingsPass(s.deps, s.web);
  const v = settingsView(s.r.db, "web");
  expect(v).toMatchObject({
    state: "gaps",
    summary: "1 standard setting differs",
    gaps: ["merge rules are off"],
    step: null,
  });
  expect(v.at).toBeGreaterThan(0);
  s.script.gaps = [];
  s.r.clock.advance(25 * 3600);
  await settingsPass(s.deps, s.web);
  expect(settingsView(s.r.db, "web")).toMatchObject({
    state: "ok",
    summary: "Standard settings in place",
    gaps: [],
  });
});

test("repo: a settings check that cannot run keeps the last result", async () => {
  const s = await settingsRig();
  await settingsPass(s.deps, s.web);
  s.r.tools.on(join(s.r.home, "tmp", "ci-apply-v1.0.0", "bin", "apply-settings"), () => ({
    code: 2,
    stdout: "",
    stderr: "gh: not logged in\n",
    timedOut: false,
  }));
  s.r.clock.advance(25 * 3600);
  const out = await settingsPass(s.deps, s.web);
  expect(out).toMatchObject({ state: "gaps", gaps: ["merge rules are off"] });
  expect(out.note).toBe("The standard settings could not be checked: gh: not logged in");
  expect(out.at).toBe(Math.floor(s.r.clock.now()));
});
