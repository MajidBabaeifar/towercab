// `repo add gitlab:…` (GL-3).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { Home } from "../../src/home.ts";
import { type AddRepoDeps, addRepo, loadRepos, readRepos, repoList } from "../../src/repos.ts";
import { FakeGitLab, gitlabConfig } from "../helpers/gitlab.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, tempDir, testConfig } from "../helpers/world.ts";

// The project's clone URL resolves to a local bare repo: never the network.
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
  const bare = bareRepo({ "README.md": "p\n" }, "trunk");
  const file = join(tempDir(), "gitconfig");
  writeFileSync(file, `[url "${bare}"]\n\tinsteadOf = https://gitlab.test/group/sub/project.git\n`);
  process.env.GIT_CONFIG_GLOBAL = file;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

function world() {
  const gl = new FakeGitLab();
  gl.project("group/sub/project", "trunk");
  const g = gitlabConfig();
  const config = testConfig({ ...g.raw, repos: {} });
  const db = Db.memory();
  loadRepos(config, db, 1);
  const home = new Home(tempDir("tc-home-"));
  const forge = new GitLabForge(g.cfg, gl.http);
  const deps = (): AddRepoDeps => ({
    db,
    config,
    tools: new FakeTools(),
    github: {
      gh: () => Promise.reject(new Error("no GitHub here")),
      gitAuth: () => Promise.reject(new Error("no GitHub here")),
    },
    gitlab: forge,
    home: home.root,
    now: 1,
    source: "cli",
  });
  return { gl, db, config, home, add: (t: string, n?: string) => addRepo(deps(), t, n) };
}

test("gitlab: repo add accepts nested groups", async () => {
  const w = world();
  const r = await w.add("gitlab:group/sub/project");
  expect(r.name).toBe("project");
  expect(r.github).toBe("gitlab:group/sub/project");
  // The same project by its URL, with a custom short name, is the same repo: refused as a duplicate.
  await expect(w.add("https://gitlab.test/group/sub/project.git", "other")).rejects.toThrow(
    /already added as project/,
  );
  await expect(w.add("gitlab:group")).rejects.toThrow(
    "gitlab:group isn't a GitLab project: write it as gitlab:group/project",
  );
});

test("gitlab: repo add stores the path and default branch", async () => {
  const w = world();
  await w.add("gitlab:Group/Sub/Project".toLowerCase());
  const [r] = readRepos(w.db);
  expect(r).toMatchObject({ name: "project", github: "gitlab:group/sub/project", base: "trunk", workers: 1 });
  expect(w.gl.calls()).toContain("GET /projects/group%2Fsub%2Fproject");
  expect(w.config.repos.get("project")?.host).toBe("gitlab.test");
});

test("gitlab: repo add refuses an unreachable project", async () => {
  const w = world();
  await expect(w.add("gitlab:group/nothing")).rejects.toThrow(
    /Towercab can't reach gitlab:group\/nothing: .*HTTP 404/,
  );
  expect(readRepos(w.db)).toEqual([]);
});

test("gitlab: repo list names the host", async () => {
  const w = world();
  await w.add("gitlab:group/sub/project");
  expect(repoList(w.db, w.home.root)).toMatch(/^project: gitlab:group\/sub\/project · base trunk · /);
});
