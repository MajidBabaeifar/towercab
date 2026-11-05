// REPO-32: a missing Administration permission is one doctor line and one owner step, never a wait.

import { afterEach, beforeEach, expect, test } from "vitest";
import { settingsCommand } from "../../src/cli.ts";
import { doctor } from "../../src/doctor.ts";
import type { GitHub } from "../../src/handlers.ts";
import { nextSettingsDue, settingsPass } from "../../src/settings/apply.ts";
import { missingPermission, PERMISSION_STEP } from "../../src/settings/store.ts";
import { settingsView } from "../../src/ui/repos.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { FakeTools } from "../helpers/tools.ts";
import { ghHandler, newGh, type SettingsRig, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

async function forbiddenRig() {
  const s = await settingsRig({ apply: true });
  const ci = newGh();
  const web = ghHandler(s.gh);
  const cih = ghHandler(ci, "owner/ci");
  s.r.tools.on("gh", (args, opts) =>
    String(args[1]).includes("owner/ci") ? cih(args, opts) : web(args, opts),
  );
  s.script.forbidden = true;
  return s;
}

const doctorLines = async (s: SettingsRig) => {
  const github = {
    owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  } as unknown as GitHub;
  const r = await doctor({
    config: s.r.config,
    home: s.deps.home,
    tools: new FakeTools(),
    github,
    db: s.r.db,
    quick: false,
  });
  return r.lines.filter((l) => l.startsWith("GitHub App lacks Administration (write)"));
};

test("doctor: missing Administration permission is one line", async () => {
  const s = await forbiddenRig();
  expect(await doctorLines(s)).toEqual([]);
  await settingsPass(s.deps, s.web);
  s.r.clock.advance(1);
  await settingsPass(s.deps, s.r.config.repos.get("ci")!);
  expect(await doctorLines(s)).toEqual([
    "GitHub App lacks Administration (write): grant it at https://github.com/settings/apps so Towercab can apply settings",
  ]);
  // Check-only installations say nothing about it.
  s.r.config.githubSettings = "check";
  expect(await doctorLines(s)).toEqual([]);
});

test("repo: a forbidden apply becomes one owner step", async () => {
  const s = await forbiddenRig();
  const out = await settingsPass(s.deps, s.web);
  expect(out).toMatchObject({
    state: "gaps",
    note: "Nothing applied: the GitHub App lacks Administration (write)",
  });
  await settingsPass(s.deps, s.r.config.repos.get("ci")!);
  // One flag for the installation, and every repo page shows the same single step.
  expect(missingPermission(s.r.db)?.repo).toBe("web");
  expect(settingsView(s.r.db, "web").step).toBe(PERMISSION_STEP);
  expect(settingsView(s.r.db, "ci").step).toBe(PERMISSION_STEP);
  expect(PERMISSION_STEP).toBe("Grant the Towercab GitHub App the Administration (write) permission");
});

test("repo: a forbidden apply is not retried until the step is ticked", async () => {
  const s = await forbiddenRig();
  await settingsPass(s.deps, s.web);
  s.script.forbidden = false;
  s.script.runs.length = 0;
  s.r.clock.advance(25 * 3600);
  const again = await settingsPass(s.deps, s.web);
  expect(again.state).toBe("gaps");
  expect(s.script.runs.map((a) => a[0])).toEqual(["--check"]);
  // Ticking the step clears the flag and makes the repo due at once.
  const w = {
    config: s.r.config,
    home: s.deps.home,
    db: s.r.db,
    tools: s.r.tools,
    github: fakeGitHub(s.r.tools),
  };
  expect(await settingsCommand(w, ["granted"])).toMatch(/applies settings again/);
  expect(missingPermission(s.r.db)).toBeNull();
  expect(nextSettingsDue(s.deps)?.name).toBe("web");
  expect((await settingsPass(s.deps, s.web)).state).toBe("ok");
  expect(settingsView(s.r.db, "web").step).toBeNull();
});
