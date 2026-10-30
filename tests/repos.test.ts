// Repos at runtime (LOOP-65..69): the table, the one-time import, `repo add`, `remove` and `set`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { doctor } from "../src/doctor.ts";
import type { GitHub } from "../src/handlers.ts";
import { Home } from "../src/home.ts";
import {
  type AddRepoDeps,
  addFailures,
  addRepo,
  beginAddRepo,
  loadRepos,
  readRepos,
  removeRepo,
  repoList,
  setRepo,
  usualOwner,
} from "../src/repos.ts";
import type { RunResult } from "../src/tools.ts";
import { addProblems } from "../src/ui/wire.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, tempDir, testConfig } from "./helpers/world.ts";

const T0 = 1_793_000_000;

// GitHub clone URLs resolve to local bare repos, as in the pipeline tests: never the network.
let savedGitConfig: string | undefined;
beforeEach(() => {
  savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const api = bareRepo({ "README.md": "api\n" }, "trunk");
  const urls: [string, string][] = [
    ["owner/api", api],
    ["Owner/Api", api],
    ["owner/web", bareRepo({ "README.md": "web\n" })],
    // A repo GitHub has but git can't fetch.
    ["owner/missing", join(tempDir(), "missing.git")],
  ];
  const file = join(tempDir(), "gitconfig");
  writeFileSync(
    file,
    urls.map(([n, b]) => `[url "${b}"]\n\tinsteadOf = https://github.com/${n}.git\n`).join(""),
  );
  process.env.GIT_CONFIG_GLOBAL = file;
});
afterEach(() => {
  if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
});

/**
 * A GitHub whose App reaches `reach` and nothing else: owner/name → its default branch, or
 * `"<full_name> <branch>"` when GitHub spells the name differently.
 */
function fakeGitHub(reach: Record<string, string>): Pick<GitHub, "gh" | "gitAuth"> & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async gh(github, args): Promise<RunResult> {
      calls.push([github, ...args]);
      const answer = reach[github];
      if (answer === undefined) throw new Error(`the GitHub App isn't installed on ${github}`);
      return okResult(`${answer.includes(" ") ? answer : `${github} ${answer}`}\n`);
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
  const deps = (source: AddRepoDeps["source"] = "cli"): AddRepoDeps => ({
    db,
    config,
    tools,
    github,
    home: home.root,
    now: T0,
    source,
  });
  const add = (text: string, name?: string) => addRepo(deps(), text, name);
  return { db, config, home, github, tools, add, deps };
}

const mission = (db: Db, repo: string, stage: string, step = "enter") =>
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, step, model, session, checkout, branch, created, updated)
     VALUES ('261030-0900', ?, 1, ?, ?, 'opus', 's', 'w', 'b', 0, 0)`,
    repo,
    stage,
    step,
  );

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
  const keep =
    "Keep it only while you might go back to a Towercab from before repos moved into the database; then delete it.";
  expect(r.lines).toContain(
    `web: [repos.web] in ${file} is ignored: the repo is in Towercab's database now (towercab repo list, towercab repo set). ${keep}`,
  );
  expect(r.lines).toContain(
    `api: [repos.api] in ${file} is ignored: the repo was removed with towercab repo remove. ${keep}`,
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
  expect(w.github.calls).toEqual([
    ["owner/api", "api", "repos/owner/api", "--jq", '.full_name + " " + .default_branch'],
  ]);
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
  // --name picks the short name; GitHub's spelling of owner/name is the one stored.
  const w2 = world({ "owner/api": "Owner/Api trunk" });
  removeRepo(w2.db, w2.config, "web");
  const backend = await w2.add("owner/api", "backend");
  expect(backend).toMatchObject({ name: "backend", github: "Owner/Api" });
  expect(existsSync(join(w2.home.root, "repos", "backend", ".git"))).toBe(true);
  expect(usualOwner(w2.config)).toBe("Owner");
  // Its clone is reused when the same repo is added again, whatever the case of its URL.
  removeRepo(w2.db, w2.config, "backend");
  expect((await w2.add("owner/api", "backend")).github).toBe("Owner/Api");
});

test("repos: add refuses an unreachable repo", async () => {
  const w = world();
  await expect(w.add("owner/secret")).rejects.toThrow(
    "Towercab can't reach owner/secret: the GitHub App isn't installed on owner/secret",
  );
  // GitHub's own refusal is the reason too.
  const gh = w.github.gh;
  w.github.gh = async () => failResult("gh: Not Found (HTTP 404)");
  await expect(w.add("owner/gone")).rejects.toThrow(
    "Towercab can't reach owner/gone: gh: Not Found (HTTP 404)",
  );
  w.github.gh = async () => okResult("owner/empty \n");
  await expect(w.add("owner/empty")).rejects.toThrow(
    "GitHub didn't say which branch is owner/empty's default",
  );
  w.github.gh = gh;
  for (const bad of ["not-a-repo", "./x", "owner/..", "a/b/c"]) {
    await expect(w.add(bad), bad).rejects.toThrow(`${bad} isn't a GitHub repo: write it as owner/name`);
  }
  await expect(w.add("owner/x", "intents")).rejects.toThrow("intents can't be a repo name");
  await expect(w.add("owner/x", "-x")).rejects.toThrow("-x can't be a repo name");
  // A clone that fails stores nothing.
  const w2 = world({ "owner/missing": "main" });
  await expect(w2.add("owner/missing")).rejects.toThrow(/^Towercab couldn't clone owner\/missing: /);
  expect(readRepos(w.db).map((r) => r.name)).toEqual(["web"]);
  expect(readRepos(w2.db).map((r) => r.name)).toEqual(["web"]);
  expect(existsSync(join(w.home.root, "repos", "secret"))).toBe(false);
  // The CLI's failure is its own answer; it leaves no problem on the page.
  expect(addFailures(w2.db)).toEqual([]);
});

test("repos: add refuses a duplicate", async () => {
  const w = world({ "owner/api": "trunk", "owner/web": "main" });
  await expect(w.add("owner/web")).rejects.toThrow("web is already a repo (owner/web)");
  await expect(w.add("owner/web", "site")).rejects.toThrow("owner/web is already added as web");
  await expect(w.add("Owner/Web", "site")).rejects.toThrow("Owner/Web is already added as web");
  // Two adds of the same repo at once: the second is refused while the first clones.
  const first = beginAddRepo(w.deps(), "owner/api");
  await expect(w.add("owner/api", "api2")).rejects.toThrow("owner/api is being added already");
  await (await first).done;
  await expect(w.add("owner/other", "api")).rejects.toThrow("api is already a repo (owner/api)");
  // A leftover clone of another repo at the path is not reused.
  removeRepo(w.db, w.config, "api");
  removeRepo(w.db, w.config, "web");
  await expect(w.add("owner/web", "api")).rejects.toThrow(
    `${join(w.home.root, "repos", "api")} already holds a clone of another repo: move it away first`,
  );
  expect(readRepos(w.db)).toEqual([]);
});

test("repos: a failed add from the page is reported", async () => {
  const w = world({ "owner/missing": "main" });
  // The checks pass, so the page gets its answer; the clone then fails.
  const p = await beginAddRepo(w.deps("ui"), "owner/missing");
  expect(p.repo).toMatchObject({ name: "missing", github: "owner/missing", base: "main" });
  await expect(p.done).rejects.toThrow(/^Towercab couldn't clone owner\/missing: /);
  expect(addFailures(w.db)).toEqual([
    { name: "missing", github: "owner/missing", why: expect.stringMatching(/couldn't clone/), at: T0 },
  ]);
  expect(addProblems(w.db)).toEqual([
    {
      title: "Towercab couldn't add the repo missing (owner/missing)",
      detail: expect.stringMatching(/^Towercab couldn't clone owner\/missing: /),
      fix: "Fix what the message says, then add the repo again from the Queue page or with towercab repo add.",
      since: T0,
    },
  ]);
  // Adding it again clears the problem.
  const again = await beginAddRepo(w.deps("ui"), "owner/missing");
  expect(addFailures(w.db)).toEqual([]);
  await again.done.catch(() => {});
});

test("repos: remove refuses while an intent is unfinished", () => {
  const w = world();
  mission(w.db, "web", "build");
  expect(() => removeRepo(w.db, w.config, "web")).toThrow(
    "web still has unfinished intents (261030-0900): let them finish or drop them first",
  );
  expect(w.config.repos.has("web")).toBe(true);
  expect(() => removeRepo(w.db, w.config, "nope")).toThrow(
    "nope isn't a repo Towercab knows (towercab repo list)",
  );
  // Stopped, but its entry step (closing its PRs) hasn't run yet: still refused.
  w.db.run("UPDATE missions SET stage = 'stopped'");
  expect(() => removeRepo(w.db, w.config, "web")).toThrow("web still has unfinished intents (261030-0900)");
  w.db.run("UPDATE missions SET step = ''");
  expect(removeRepo(w.db, w.config, "web").github).toBe("owner/web");
  expect(w.config.repos.has("web")).toBe(false);
  expect(repoList(w.db, w.home.root)).toBe("no repos yet: add one with towercab repo add <owner/name>");
});

test("repos: set changes a repo's settings", () => {
  const w = world();
  const map = w.config.repos;
  const r = setRepo(w.db, w.config, "web", [
    "workers=2",
    "ahead=5",
    "env=FOO=a=b",
    'env={"BAR":"1","BAZ":"2"}',
  ]);
  expect(r).toMatchObject({ workers: 2, ahead: 5, env: { BAR: "1", BAZ: "2" } });
  setRepo(w.db, w.config, "web", ["env=QUX=", "base=trunk", "path=/srv/web"]);
  expect(map.get("web")).toEqual({
    name: "web",
    github: "owner/web",
    path: "/srv/web",
    base: "trunk",
    workers: 2,
    ahead: 5,
    env: { BAR: "1", BAZ: "2", QUX: "" },
  });
  expect(w.config.repos).toBe(map);
  expect(repoList(w.db, w.home.root)).toBe(
    "web: owner/web · base trunk · 2 workers · ahead 5 · /srv/web · env BAR, BAZ, QUX",
  );
  // An empty path goes back to <home>/repos/<name>.
  expect(setRepo(w.db, w.config, "web", ["path="]).path).toBe("");
  // Refusals name the reason, and one bad pair changes nothing.
  const refused: [string[], string][] = [
    [["workers=0"], "workers must be an integer 1-16"],
    [["ahead=17"], "ahead must be an integer 1-16"],
    [["workers=2", "ahead=x"], "ahead must be an integer 1-16"],
    [["base=-x"], "base: -x is not a branch name"],
    [["path=relative/dir"], "path must be absolute or start with ~/"],
    [["env=1X=y"], "env must be NAME=value or a JSON object of strings"],
    [['env={"A":1}'], "env must be NAME=value or a JSON object of strings"],
    [["colour=red"], "unknown setting colour: use workers, ahead, base, path or env"],
    [["workers"], "workers isn't key=value"],
    [[], "say what to set (workers, ahead, base, path or env) as key=value"],
  ];
  for (const [pairs, why] of refused) {
    expect(() => setRepo(w.db, w.config, "web", pairs), why).toThrow(why);
  }
  expect(() => setRepo(w.db, w.config, "nope", ["workers=2"])).toThrow("nope isn't a repo Towercab knows");
  expect(map.get("web")).toMatchObject({ workers: 2, ahead: 5, base: "trunk", path: "" });
  // Base and path wait until no mission needs the repo; the rest can change any time.
  mission(w.db, "web", "build");
  expect(() => setRepo(w.db, w.config, "web", ["base=main"])).toThrow(
    "web has unfinished intents (261030-0900): change base or path once they are done",
  );
  expect(setRepo(w.db, w.config, "web", ["workers=3"]).workers).toBe(3);
});
