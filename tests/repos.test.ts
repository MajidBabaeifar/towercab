// Repos at runtime (LOOP-65..67): the table, the one-time import, `repo add` and `repo remove`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { doctor } from "../src/doctor.ts";
import type { GitHub } from "../src/handlers.ts";
import { Home } from "../src/home.ts";
import { addRepo, loadRepos, readRepos, removeRepo, repoList, usualOwner } from "../src/repos.ts";
import type { RunResult } from "../src/tools.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, tempDir, testConfig } from "./helpers/world.ts";

const T0 = 1_793_000_000;

// `https://github.com/owner/<name>.git` resolves to a local bare repo, as in the pipeline tests.
let savedGitConfig: string | undefined;
let bares: Record<string, string> = {};
beforeEach(() => {
  savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
  bares = {
    api: bareRepo({ "README.md": "api\n" }, "trunk"),
    web: bareRepo({ "README.md": "web\n" }),
    // Never the network: a repo GitHub has but git can't fetch.
    missing: join(tempDir(), "missing.git"),
  };
  const file = join(tempDir(), "gitconfig");
  writeFileSync(
    file,
    Object.entries(bares)
      .map(([n, b]) => `[url "${b}"]\n\tinsteadOf = https://github.com/owner/${n}.git\n`)
      .join(""),
  );
  process.env.GIT_CONFIG_GLOBAL = file;
});
afterEach(() => {
  if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
});

/** A GitHub whose App reaches `reach` (owner/name → default branch) and nothing else. */
function fakeGitHub(reach: Record<string, string>): Pick<GitHub, "gh" | "gitAuth"> & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async gh(github, args): Promise<RunResult> {
      calls.push([github, ...args]);
      const branch = reach[github];
      if (branch === undefined) throw new Error(`the GitHub App isn't installed on ${github}`);
      return okResult(`${branch}\n`);
    },
    gitAuth: async () => ({ args: [], env: {} }),
  };
}

function world(reach: Record<string, string> = { "owner/api": "trunk" }) {
  const db = Db.memory();
  const config = testConfig();
  const home = new Home(tempDir("tc-home-"));
  const github = fakeGitHub(reach);
  const tools = new FakeTools();
  loadRepos(config, db, T0);
  const add = (text: string, name?: string) =>
    addRepo({ db, config, tools, github, home: home.root, now: T0, source: "cli" }, text, name);
  return { db, config, home, github, tools, add };
}

test("repos: config tables are imported once", () => {
  const db = Db.memory();
  const config = testConfig({ repos: { web: { github: "owner/web", workers: 2 } } });
  const map = config.repos;
  expect(loadRepos(config, db, T0)).toEqual(["web"]);
  expect(config.repos).toBe(map);
  expect(db.all("SELECT name, github, path, base, workers, ahead, env, source FROM repos")).toEqual([
    {
      name: "web",
      github: "owner/web",
      path: "",
      base: "main",
      workers: 2,
      ahead: 3,
      env: "{}",
      source: "config",
    },
  ]);
  // A changed table is ignored: the database is the record now.
  const changed = testConfig({ repos: { web: { github: "owner/web", workers: 5 } } });
  expect(loadRepos(changed, db, T0 + 60)).toEqual([]);
  expect(changed.repos.get("web")?.workers).toBe(2);
  // A removed repo is not imported again; a new table is.
  removeRepo(db, changed, "web");
  const later = testConfig({ repos: { web: { github: "owner/web" }, api: { github: "owner/api" } } });
  expect(loadRepos(later, db, T0 + 120)).toEqual(["api"]);
  expect([...later.repos.keys()]).toEqual(["api"]);
  expect(readRepos(db).map((r) => r.name)).toEqual(["api"]);
});

test("repos: doctor says which config tables to delete", async () => {
  const db = Db.memory();
  const home = new Home(tempDir("tc-home-"));
  const first = testConfig({ repos: { web: { github: "owner/web" }, api: { github: "owner/api" } } });
  loadRepos(first, db, T0);
  removeRepo(db, first, "api");
  // A table that doesn't validate, for a name the database has, is ignored too.
  const config = testConfig({
    repos: { web: { github: "not a repo" }, api: { github: "owner/api" }, docs: { github: "nope" } },
  });
  loadRepos(config, db, T0 + 60);
  const r = await doctor({ config, home, tools: new FakeTools(), github: null, quick: false });
  const file = config.file;
  expect(r.lines).toContain(
    `web: [repos.web] in ${file} is ignored: the repo is in Towercab's database now (towercab repo list). Delete the table.`,
  );
  expect(r.lines).toContain(
    `api: [repos.api] in ${file} is ignored: the repo was removed with towercab repo remove. Delete the table.`,
  );
  // A bad table for an unknown name still says what is wrong with it.
  expect(r.lines).toContain(`docs: config: ${file}: repos.docs.github must be owner/name`);
  expect(r.lines.filter((l) => l.startsWith("web: "))).toHaveLength(2);
});

test("repos: add checks GitHub, reads the base and clones", async () => {
  const w = world();
  const map = w.config.repos;
  const repo = await w.add("https://github.com/owner/api.git");
  expect(repo).toEqual({
    name: "api",
    github: "owner/api",
    path: "",
    base: "trunk",
    workers: 1,
    ahead: 3,
    env: {},
  });
  expect(w.github.calls).toEqual([["owner/api", "api", "repos/owner/api", "--jq", ".default_branch"]]);
  // Stored, and in the same Map everything reads.
  expect(w.db.get("SELECT source FROM repos WHERE name = 'api'")).toEqual({ source: "cli" });
  expect(w.config.repos).toBe(map);
  expect(map.get("api")).toEqual(repo);
  // Cloned into <home>/repos/<name>, from GitHub.
  const clone = join(w.home.root, "repos", "api");
  expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("api\n");
  expect(readFileSync(join(clone, ".git", "config"), "utf8")).toContain("https://github.com/owner/api.git");
  expect(repoList(w.db, w.home.root)).toBe(
    `api: owner/api · base trunk · 1 worker · ahead 3 · ${clone}\nweb: owner/web · base main · 1 worker · ahead 3 · ${join(w.home.root, "repos", "web")}`,
  );
  // --name picks the short name.
  const w2 = world({ "owner/api": "trunk" });
  removeRepo(w2.db, w2.config, "web");
  expect((await w2.add("owner/api", "backend")).name).toBe("backend");
  expect(existsSync(join(w2.home.root, "repos", "backend", ".git"))).toBe(true);
  expect(usualOwner(w2.config)).toBe("owner");
});

test("repos: add refuses an unreachable repo", async () => {
  const w = world();
  await expect(w.add("owner/secret")).rejects.toThrow(
    "Towercab can't reach owner/secret: the GitHub App isn't installed on owner/secret",
  );
  // GitHub's own refusal is the reason too.
  w.github.gh = async () => failResult("gh: Not Found (HTTP 404)");
  await expect(w.add("owner/gone")).rejects.toThrow(
    "Towercab can't reach owner/gone: gh: Not Found (HTTP 404)",
  );
  await expect(w.add("not-a-repo")).rejects.toThrow("not-a-repo isn't a GitHub repo: write it as owner/name");
  await expect(w.add("owner/x", "intents")).rejects.toThrow("intents can't be a repo name");
  // A clone that fails stores nothing.
  const w2 = world({ "owner/missing": "main" });
  await expect(w2.add("owner/missing")).rejects.toThrow(/^Towercab couldn't clone owner\/missing: /);
  expect(readRepos(w.db).map((r) => r.name)).toEqual(["web"]);
  expect(readRepos(w2.db).map((r) => r.name)).toEqual(["web"]);
  expect(existsSync(join(w.home.root, "repos", "secret"))).toBe(false);
});

test("repos: add refuses a duplicate", async () => {
  const w = world({ "owner/api": "trunk", "owner/web": "main" });
  await expect(w.add("owner/web")).rejects.toThrow("web is already a repo (owner/web)");
  await expect(w.add("owner/web", "site")).rejects.toThrow("owner/web is already added as web");
  await expect(w.add("Owner/Web", "site")).rejects.toThrow("Owner/Web is already added as web");
  await w.add("owner/api");
  await expect(w.add("owner/other", "api")).rejects.toThrow("api is already a repo (owner/api)");
  // A leftover clone of another repo at the path is not reused.
  removeRepo(w.db, w.config, "api");
  removeRepo(w.db, w.config, "web");
  await expect(w.add("owner/web", "api")).rejects.toThrow(
    `${join(w.home.root, "repos", "api")} already holds a clone of another repo: move it away first`,
  );
  expect(readRepos(w.db)).toEqual([]);
});

test("repos: remove refuses while an intent is unfinished", () => {
  const w = world();
  w.db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, model, session, checkout, branch, created, updated)
     VALUES ('261030-0900', 'web', 1, 'build', 'opus', 's', 'w', 'b', 0, 0)`,
  );
  expect(() => removeRepo(w.db, w.config, "web")).toThrow(
    "web still has unfinished intents (261030-0900): let them finish or drop them first",
  );
  expect(w.config.repos.has("web")).toBe(true);
  expect(() => removeRepo(w.db, w.config, "nope")).toThrow(
    "nope isn't a repo Towercab knows (towercab repo list)",
  );
  w.db.run("UPDATE missions SET stage = 'done'");
  expect(removeRepo(w.db, w.config, "web").github).toBe("owner/web");
  expect(w.config.repos.has("web")).toBe(false);
  expect(repoList(w.db, w.home.root)).toBe("no repos yet: add one with towercab repo add <owner/name>");
});
