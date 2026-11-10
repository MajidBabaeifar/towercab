// REPO-40: an owner login without admin is refused already at the backup's reads; that is the login
// that can't change the repo, not a backup failure, so the card says so once.

import { afterEach, beforeEach, expect, test } from "vitest";
import { forgeOf } from "../../src/github/forge.ts";
import { applySettings, settingsPass } from "../../src/settings/apply.ts";
import { forbidden } from "../../src/settings/script.ts";
import { storedSettings } from "../../src/settings/store.ts";
import { failResult } from "../helpers/tools.ts";
import { ghHandler, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

test("repo: a forbidden backup read says the login cannot change the repo", async () => {
  for (const path of ["repos/owner/web/branches/main/protection", "repos/owner/web/vulnerability-alerts"]) {
    const s = await settingsRig();
    const real = ghHandler(s.gh);
    s.r.tools.on("gh", (args, opts) =>
      args[1] === path
        ? failResult("gh: Resource not accessible by integration (HTTP 403)")
        : real(args, opts),
    );
    await settingsPass(s.deps, s.web);
    const out = await applySettings(s.deps, s.web);
    expect(out).toMatchObject({
      state: "gaps",
      note: "Your GitHub login can't change this repo's settings: it needs admin on owner/web",
    });
    expect(storedSettings(s.r.db, "web")?.gaps).toEqual(["merge rules are off"]);
    expect(s.script.runs.map((a) => a[0])).not.toContain("owner/web");
  }
});

test("repo: only gh's HTTP 403 counts as forbidden", () => {
  const r = (stdout: string, stderr = "") => ({ code: 1, stdout, stderr, timedOut: false });
  expect(forbidden(r("see https://example.com/403 for details"))).toBe(false);
  expect(forbidden(r("branch 4030 has no protection"))).toBe(false);
  expect(forbidden(r("", "gh: Forbidden (HTTP 403)"))).toBe(true);
});

test("repo: the base branch is encoded when TOWERCAB.md is read", async () => {
  const s = await settingsRig();
  await forgeOf(s.deps.github).readFile("owner/web", "TOWERCAB.md", "feat/x#1");
  const read = s.r.tools.calls.find((c) => c.args[1]?.includes("contents/TOWERCAB.md"));
  expect(read?.args[1]).toContain("ref=feat%2Fx%231");
});
