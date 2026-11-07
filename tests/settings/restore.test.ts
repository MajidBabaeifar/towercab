// REPO-31: `towercab settings restore`, over the fake GitHub API. Never the network.

import { afterEach, beforeEach, expect, test } from "vitest";
import { settingsCommand } from "../../src/cli.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { checkThenApply, settingsRig } from "./helpers.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

async function applied() {
  const s = await settingsRig();
  await checkThenApply(s);
  s.gh.writes.length = 0;
  const w = {
    config: s.r.config,
    home: s.deps.home,
    db: s.r.db,
    tools: s.r.tools,
    github: fakeGitHub(s.r.tools),
  };
  return { s, w };
}

test("cli: settings restore writes back what was saved", async () => {
  const { s, w } = await applied();
  const out = await settingsCommand(w, ["restore", "web"]);
  expect([...s.gh.writes].sort()).toEqual(
    [
      "PATCH repos/owner/web",
      "PUT repos/owner/web/rulesets/1",
      "PUT repos/owner/web/branches/main/protection",
      "PUT repos/owner/web/actions/permissions/workflow",
      "PUT repos/owner/web/vulnerability-alerts",
    ].sort(),
  );
  expect(s.gh.bodies["PATCH repos/owner/web"]).toMatchObject({
    allow_squash_merge: true,
    delete_branch_on_merge: false,
    security_and_analysis: { secret_scanning: { status: "enabled" } },
  });
  // The protection goes back in the shape its PUT takes.
  expect(s.gh.bodies["PUT repos/owner/web/branches/main/protection"]).toMatchObject({
    required_status_checks: { strict: true, checks: [{ context: "ci-ok" }] },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
  });
  expect(out).toContain("Restored the repository settings");
  expect(out).toMatch(/From the backup of \d{4}-\d\d-\d\dT/);
});

test("cli: settings restore lists what was added since and leaves it", async () => {
  const { s, w } = await applied();
  s.gh.rulesets.push({
    id: 2,
    name: "added later",
    target: "branch",
    enforcement: "active",
    conditions: {},
    rules: [],
  });
  const out = await settingsCommand(w, ["restore", "web"]);
  expect(out).toContain("Not in the backup, left as it is: ruleset added later");
  expect(s.gh.writes.some((x) => x.includes("rulesets/2"))).toBe(false);
  expect(s.gh.writes.some((x) => x.startsWith("DELETE") && x.includes("rulesets"))).toBe(false);
});

test("cli: settings restore refuses what it can't do", async () => {
  const s = await settingsRig();
  const w = {
    config: s.r.config,
    home: s.deps.home,
    db: s.r.db,
    tools: s.r.tools,
    github: fakeGitHub(s.r.tools),
  };
  await expect(settingsCommand(w, ["restore", "web"])).rejects.toThrow("web has no saved settings");
  await expect(settingsCommand(w, ["restore", "nope"])).rejects.toThrow(
    "nope isn't a repo Towercab knows (towercab repo list)",
  );
});
