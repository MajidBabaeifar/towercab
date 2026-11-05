// A GitLab repo next to GitHub ones: the GitHub-only loops (issues, daily settings, releases) leave it
// alone, so they never fail on it and the loop's GitHub fault never opens.

import { expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { pollIssues } from "../../src/github/issues.ts";
import { nextSettingsDue } from "../../src/settings/apply.ts";
import { runReleases } from "../../src/ship/releases.ts";
import { Pipe } from "../helpers/pipe.ts";
import { testConfig } from "../helpers/world.ts";

const gitlabRepo = {
  name: "proj",
  github: "gitlab:group/sub/proj",
  path: "",
  base: "main",
  workers: 1,
  ahead: 3,
  env: {},
};

test("gitlab: the issue poll skips a GitLab repo", async () => {
  const p = new Pipe({ repo: "owner/web", base: "main" } as never, {});
  await p.start({}, { handlers: {} });
  await p.loop.issuesIdle();
  const config = p.config();
  config.repos.set("proj", gitlabRepo);
  const seen: string[] = [];
  const github = p.github();
  const real = github.listIssues.bind(github);
  github.listIssues = (repo, limit) => {
    seen.push(repo);
    return real(repo, limit);
  };
  await pollIssues({
    config,
    home: p.home,
    tools: p.tools,
    clock: p.clock,
    store: p.store,
    github,
    log: () => {},
    busy: () => new Set(),
    userHome: "/home/me",
  } as never);
  expect(seen.some((r) => r.startsWith("gitlab:"))).toBe(false);
});

test("gitlab: the daily settings check skips a GitLab repo", () => {
  const config = testConfig({ repos: {} });
  config.repos.set("proj", gitlabRepo);
  expect(
    nextSettingsDue({ config, db: Db.memory(), clock: { now: () => 1e9, mono: () => 0 } } as never),
  ).toBeNull();
});

test("gitlab: the release pass skips a GitLab repo", async () => {
  const config = testConfig({ repos: {} });
  config.repos.set("proj", gitlabRepo);
  const d = { config, db: Db.memory() } as never;
  expect(await runReleases(d)).toBeNull();
});
