// The intents repo on GitLab (GL-4, GL-16).

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { GitLabHost } from "../../src/forge/gitlab-host.ts";
import { routed } from "../../src/forge/route.ts";
import { intentsSlug } from "../../src/intents/store.ts";
import { gitlabConfig } from "../helpers/gitlab.ts";
import { FakeGitLabLists } from "../helpers/gitlab-lists.ts";
import { testConfig } from "../helpers/world.ts";

test("gitlab: the intents repo can be a GitLab project", () => {
  const { raw } = gitlabConfig();
  for (const remote of [
    "gitlab:group/intents",
    "https://gitlab.test/group/intents.git",
    "https://gitlab.test/group/intents",
  ]) {
    const c = testConfig({ ...raw, intents: { remote } });
    expect(c.intents.remote).toBe("https://gitlab.test/group/intents.git");
    expect(intentsSlug(c.intents.remote, "gitlab.test")).toBe("gitlab:group/intents");
  }
  // Another host's URL stays as written, and GitHub's slug is still read.
  expect(testConfig({ ...raw, intents: { remote: "https://github.com/o/i.git" } }).intents.remote).toBe(
    "https://github.com/o/i.git",
  );
  expect(intentsSlug("https://github.com/o/i.git", "gitlab.test")).toBe("o/i");
  expect(() => testConfig({ intents: { remote: "gitlab:group/intents" } })).toThrow(/\[gitlab\]/);
  expect(() => testConfig({ ...raw, intents: { remote: "gitlab:oops" } })).toThrow(/isn't a GitLab project/);
});

test("gitlab: plan merge requests open on the intents project", async () => {
  const gl = new FakeGitLabLists();
  gl.project("group/intents");
  // GitHub is never asked: any call to it would fail the test.
  const github = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === "me" ? "owner" : () => Promise.reject(new Error(`GitHub was asked ${String(k)}`)),
    },
  ) as never;
  const host = routed(github, new GitLabHost(new GitLabForge(gitlabConfig().cfg, gl.http)));
  const n = await host.openPr("gitlab:group/intents", {
    base: "main",
    head: "plan/261001-0900-x",
    title: "docs(plan): x",
    body: "plan",
  });
  expect(n).toBe(1);
  const mr = gl.projects.get("group/intents")!.mrs[0]!;
  expect([mr.title, mr.source_branch, mr.target_branch]).toEqual([
    "Draft: docs(plan): x",
    "plan/261001-0900-x",
    "main",
  ]);
  expect(await host.openPrOn("gitlab:group/intents", "plan/261001-0900-x")).toBe(1);
});
