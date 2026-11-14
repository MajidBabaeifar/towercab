// REPO-31: a refused apply after a partial one stores what a new check finds, not the gaps seen before.

import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applySettings, settingsPass } from "../../src/settings/apply.ts";
import { storedSettings } from "../../src/settings/store.ts";
import { failResult, okResult } from "../helpers/tools.ts";
import { type SettingsRig, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

const WORDS = "Your GitHub login can't change this repo's settings: it needs admin on owner/web";
const scriptPath = (s: SettingsRig) => join(s.r.home, "tmp", "ci-apply-v1.0.0", "bin", "apply-settings");

/** A script whose apply fixes "merge rules are off", then is refused; `after` answers the checks that follow. */
function partial(s: SettingsRig, afterCheck: () => ReturnType<typeof okResult>) {
  let applied = false;
  s.r.tools.on(scriptPath(s), (args) => {
    if (args[0] === "--plan")
      return okResult(JSON.stringify({ rulesets: [{ required_status_checks: ["ci-ok"] }], branches: [] }));
    if (args[0] === "--check") {
      if (applied) return afterCheck();
      return {
        code: 1,
        stdout: "merge rules are off\nbranch protection is off\n",
        stderr: "",
        timedOut: false,
      };
    }
    applied = true;
    return failResult("gh: Resource not accessible by integration (HTTP 403)");
  });
}

test("repo: a refused apply after a partial one re-checks before storing", async () => {
  const s = await settingsRig();
  partial(s, () => ({ code: 1, stdout: "branch protection is off\n", stderr: "", timedOut: false }));
  await settingsPass(s.deps, s.web);
  expect(storedSettings(s.r.db, "web")?.gaps).toEqual(["merge rules are off", "branch protection is off"]);
  const out = await applySettings(s.deps, s.web);
  expect(out).toMatchObject({ state: "gaps", gaps: ["branch protection is off"], note: WORDS });
  expect(storedSettings(s.r.db, "web")?.gaps).toEqual(["branch protection is off"]);
  expect(out.note).not.toContain("Nothing applied");
});

test("repo: a refused apply whose re-check cannot run keeps the last result and says so", async () => {
  const s = await settingsRig();
  partial(s, () => failResult("gh: Server Error (HTTP 500)", 2));
  await settingsPass(s.deps, s.web);
  const out = await applySettings(s.deps, s.web);
  expect(out.gaps).toEqual(["merge rules are off", "branch protection is off"]);
  expect(out.note).toContain(WORDS);
  expect(out.note).toContain("part-way");
});
