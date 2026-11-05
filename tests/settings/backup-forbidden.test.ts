// REPO-32: an App without Administration is refused already at the backup's reads; that is the missing
// permission, not a backup failure, so the doctor line and the one step appear.

import { afterEach, beforeEach, expect, test } from "vitest";
import { settingsPass } from "../../src/settings/apply.ts";
import { forbidden } from "../../src/settings/script.ts";
import { missingPermission, PERMISSION_STEP } from "../../src/settings/store.ts";
import { settingsView } from "../../src/ui/repos.ts";
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

test("repo: a forbidden backup read is the missing permission", async () => {
  for (const path of ["repos/owner/web/branches/main/protection", "repos/owner/web/vulnerability-alerts"]) {
    const s = await settingsRig({ apply: true });
    const real = ghHandler(s.gh);
    s.r.tools.on("gh", (args, opts) =>
      args[1] === path
        ? failResult("gh: Resource not accessible by integration (HTTP 403)")
        : real(args, opts),
    );
    const out = await settingsPass(s.deps, s.web);
    expect(out).toMatchObject({
      state: "gaps",
      note: "Nothing applied: the GitHub App lacks Administration (write)",
    });
    expect(missingPermission(s.r.db)?.repo).toBe("web");
    expect(settingsView(s.r.db, "web").step).toBe(PERMISSION_STEP);
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
  const s = await settingsRig({ apply: true });
  s.web.base = "feat/x#1";
  await settingsPass(s.deps, s.web);
  const read = s.r.tools.calls.find((c) => c.args[1]?.includes("contents/TOWERCAB.md"));
  expect(read?.args[1]).toContain("ref=feat%2Fx%231");
});
