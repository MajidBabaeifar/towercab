// `towercab doctor` checks the GitLab token (GL-9).

import { expect, test } from "vitest";
import { doctor } from "../../src/doctor.ts";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { FakeGitLab, fakeGlab, gitlabConfig } from "../helpers/gitlab.ts";
import { FakeTools } from "../helpers/tools.ts";
import { testConfig, testHome } from "../helpers/world.ts";

// 2026-11-05T12:00:00Z
const NOW = Date.parse("2026-11-05T12:00:00Z") / 1000;

async function run(token: Partial<FakeGitLab["token"]>) {
  const gl = new FakeGitLab();
  Object.assign(gl.token, token);
  const g = gitlabConfig();
  const tools = new FakeTools();
  fakeGlab(tools);
  const r = await doctor({
    config: testConfig(g.raw),
    home: testHome(),
    tools,
    github: null,
    gitlab: new GitLabForge(g.cfg, gl.http),
    quick: false,
    now: NOW,
  });
  return { ...r, gitlab: r.lines.filter((l) => /^(gitlab|GitLab|glab)/.test(l)) };
}

test("doctor: GitLab token missing a scope fails", async () => {
  const r = await run({ scopes: ["read_api"] });
  expect(r.ok).toBe(false);
  expect(r.gitlab).toContain(
    "GitLab token lacks api: create a project or group access token with api and write_repository",
  );
  expect(r.gitlab.some((l) => l.includes("lacks write_repository"))).toBe(true);
});

test("doctor: GitLab token expired fails", async () => {
  const r = await run({ expires_at: "2026-11-01" });
  expect(r.ok).toBe(false);
  expect(r.gitlab).toContain("GitLab token expired on 2026-11-01: create a new one");
  expect((await run({ active: false })).ok).toBe(false);
});

test("doctor: GitLab token near expiry warns", async () => {
  const r = await run({ expires_at: "2026-11-15" });
  expect(r.gitlab).toContain("GitLab token expires in 10 days (2026-11-15): create a new one before then");
  // A warning: the exit code is the same as for a good token.
  expect(r.ok).toBe((await run({ expires_at: "2027-06-01" })).ok);
  expect((await run({ expires_at: "2026-11-30" })).gitlab.join("\n")).not.toContain("expires in");
});

test("doctor: GitLab token without expiry is quiet", async () => {
  const r = await run({ expires_at: null });
  expect(r.gitlab.join("\n")).not.toContain("expire");
  expect(r.gitlab).toContain("gitlab token: towercab-bot 77");
  expect(r.gitlab).toContain("glab login: owner");
});
