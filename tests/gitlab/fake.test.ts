// The fake GitLab itself (GL-10): it enforces the token and the merge sha, and it paginates.

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { FakeGitLab, GL_BASE, gitlabConfig } from "../helpers/gitlab.ts";

test("gitlab: the fake enforces the token and the merge sha", async () => {
  const gl = new FakeGitLab();
  gl.project("g/p");
  const m = gl.mr("g/p");
  const good = new GitLabForge(gitlabConfig().cfg, gl.http);
  const wrong = gitlabConfig();
  const bad = new GitLabForge(wrong.cfg, (req) =>
    gl.http({ ...req, headers: { ...req.headers, "PRIVATE-TOKEN": "nope" } }),
  );
  await expect(bad.bot()).rejects.toThrow(/HTTP 401/);
  expect(await good.merge("gitlab:g/p", m.iid, "c".repeat(40))).toEqual({
    merged: false,
    reason: "SHA does not match HEAD of source branch",
  });
  expect(await good.merge("gitlab:g/p", m.iid, m.sha)).toEqual({ merged: true });
  expect(gl.requests.every((r) => r.path.length > 0)).toBe(true);
  expect(new URL(GL_BASE).host).toBe("gitlab.test");
});

test("gitlab: the fake paginates", async () => {
  const gl = new FakeGitLab();
  gl.perPage = 100;
  gl.project("g/p");
  const m = gl.mr("g/p");
  for (let i = 0; i < 250; i++) gl.note(m, "someone", `note ${i}`);
  const f = new GitLabForge(gitlabConfig().cfg, gl.http);
  const pr = await f.readPr("gitlab:g/p", m.iid);
  expect(pr.comments).toHaveLength(250);
  expect(gl.calls().filter((c) => c.includes("/discussions"))).toHaveLength(3);
});
