// Reading a repo's readiness (REPO-23..25, REPO-27) and proposing the setup intent (LOOP-71), over local
// bare repos for GitHub and a fake `gh`: never the network.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { parseIntent } from "../src/intents/intent.ts";
import type { IntentStore, Listing } from "../src/intents/types.ts";
import {
  blockingRepos,
  proposeSetup,
  READINESS_EVERY_S,
  type ReadinessDeps,
  refreshReadiness,
  setupBranch,
  storedReadiness,
} from "../src/readiness.ts";
import { fakeGitHub } from "./github/fakes.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, git, TestClock, tempDir, testConfig, testDb, testHome } from "./helpers/world.ts";
import { at, listing } from "./intents/fixtures.ts";

const CLAUDE = "# Repo\n\n## Verifying your work\n\n```checks\nnpm test\n```\n";
const WEB: Record<string, string> = {
  "CLAUDE.md": CLAUDE,
  "TOWERCAB.md": "---\nkind: library\nreadiness: block\n---\n",
  "package.json": '{"name":"web","main":"index.js"}',
  ".github/workflows/ci.yml": "jobs:\n  test:\n    steps: []\n",
};
const RULES = JSON.stringify([{ type: "required_status_checks" }]);

let savedGitConfig: string | undefined;
beforeEach(() => {
  savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
});
afterEach(() => {
  if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
});

interface Rig {
  deps: ReadinessDeps;
  config: Config;
  db: Db;
  clock: TestClock;
  tools: FakeTools;
  remotes: Record<string, string>;
  intents: string;
  prs: string[][];
  ghPrs: { value: string };
  home: string;
}

/** `owner/<name>` repos served from local bare repos; `gh` answers the rules and the PR calls. */
function rig(repos: Record<string, Record<string, string>>, rules = RULES): Rig {
  const remotes: Record<string, string> = {};
  const table: Record<string, unknown> = {};
  for (const [name, files] of Object.entries(repos)) {
    remotes[name] = bareRepo(files);
    table[name] = { github: `owner/${name}` };
  }
  const intents = bareRepo({ "README.md": "intents\n" });
  const file = join(tempDir(), "gitconfig");
  writeFileSync(
    file,
    Object.entries(remotes)
      .map(([n, b]) => `[url "${b}"]\n\tinsteadOf = https://github.com/owner/${n}.git\n`)
      .join(""),
  );
  process.env.GIT_CONFIG_GLOBAL = file;
  const config = testConfig({ intents: { remote: intents }, repos: table });
  const prs: string[][] = [];
  const ghPrs = { value: "[]" };
  const tools = new FakeTools().on("gh", (args) => {
    if (args[0] === "api") return okResult(rules);
    if (args[0] === "pr" && args[1] === "list") return okResult(ghPrs.value);
    if (args[0] === "pr" && args[1] === "create") {
      prs.push(args);
      return okResult("https://github.com/owner/intents/pull/7\n");
    }
    return failResult(`gh ${args.join(" ")}: not faked`);
  });
  const clock = new TestClock();
  const db = testDb();
  const home = testHome();
  const store = { github: () => "owner/intents" } as unknown as IntentStore;
  const deps: ReadinessDeps = {
    config,
    home,
    db,
    tools,
    clock,
    store,
    github: fakeGitHub(tools),
    log: () => {},
  };
  return { deps, config, db, clock, tools, remotes, intents, prs, ghPrs, home: home.root };
}

const repo = (r: Rig, name = "web") => r.config.repos.get(name)!;
const items = (r: Rig, name = "web") =>
  Object.fromEntries(storedReadiness(r.db, name)!.readiness.items.map((i) => [i.item, i.state]));

test("repo: readiness is stored at fetch", async () => {
  const r = rig({ web: WEB });
  const s = await refreshReadiness(r.deps, repo(r));
  expect(s?.readiness.kind).toBe("library");
  expect(s?.readiness.confirmed).toBe(true);
  expect(items(r)).toEqual({
    ci: "present",
    settings: "unknown",
    release: "missing",
    verifying: "present",
    publish: "missing",
  });
  expect(s?.readiness.blocks).toBe(true);
  expect(storedReadiness(r.db, "web")?.base).toMatch(/^[0-9a-f]{40}$/);
  // Within ten minutes the stored answer stands; later the repo is read again.
  const gh = () => r.tools.lines("gh").length;
  const before = gh();
  await refreshReadiness(r.deps, repo(r));
  expect(gh()).toBe(before);
  r.clock.advance(READINESS_EVERY_S + 1);
  await refreshReadiness(r.deps, repo(r));
  expect(gh()).toBeGreaterThan(before);
  expect([...blockingRepos(r.db, r.config).keys()]).toEqual(["web"]);
});

test("repo: settings check runs ci's script", async () => {
  const r = rig({ web: WEB, ci: { "README.md": "ci\n" } });
  const script = join(r.home, "repos", "ci", "bin", "apply-settings");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "#!/bin/sh\n");
  chmodSync(script, 0o755);
  let answer = { code: 0, stdout: "", stderr: "" };
  r.tools.on(script, () => ({ ...answer, timedOut: false }));
  await refreshReadiness(r.deps, repo(r), true);
  expect(items(r).settings).toBe("present");
  expect(r.tools.calls.find((c) => c.cmd === script)?.args).toEqual(["--check", "owner/web"]);
  // Exit 1: the standard settings differ; the script's first line is the words.
  answer = { code: 1, stdout: "branch protection is off\nmore\n", stderr: "" };
  await refreshReadiness(r.deps, repo(r), true);
  const settings = storedReadiness(r.db, "web")!.readiness.items.find((i) => i.item === "settings")!;
  expect(settings).toMatchObject({ state: "missing", words: "branch protection is off" });
  // Any other exit means the check could not run: a warning, not a gap.
  answer = { code: 2, stdout: "", stderr: "gh: not logged in\n" };
  await refreshReadiness(r.deps, repo(r), true);
  expect(items(r).settings).toBe("unknown");
});

test("repo: settings check without a ci clone is unknown", async () => {
  const r = rig({ web: WEB });
  await refreshReadiness(r.deps, repo(r));
  const settings = storedReadiness(r.db, "web")!.readiness.items.find((i) => i.item === "settings")!;
  expect(settings.state).toBe("unknown");
  expect(settings.words).toBe("The standard settings could not be checked: add the ci repo to Towercab");
  // Unknown never makes a repo not ready.
  const none = rig({
    web: {
      ...WEB,
      "release-please-config.json": "{}",
      ".release-please-manifest.json": "{}",
      ".github/workflows/release.yml":
        "uses: googleapis/release-please-action@v4\njobs:\n  publish:\n    steps: []\n",
    },
  });
  await refreshReadiness(none.deps, repo(none));
  expect(storedReadiness(none.db, "web")?.readiness.ready).toBe(true);
  expect(blockingRepos(none.db, none.config).size).toBe(0);
});

test("readiness: a failed fetch keeps the stored result", async () => {
  const r = rig({ web: WEB });
  expect(blockingRepos(r.db, r.config).size).toBe(0);
  await refreshReadiness(r.deps, repo(r));
  const first = r.db.meta("readiness:web");
  // GitHub goes away: the fetch fails, and the last answer stands (REPO-27).
  rmSync(r.remotes.web!, { recursive: true, force: true });
  r.clock.advance(READINESS_EVERY_S + 1);
  const s = await refreshReadiness(r.deps, repo(r));
  expect(s?.readiness.blocks).toBe(true);
  expect(JSON.parse(r.db.meta("readiness:web")!).readiness).toEqual(JSON.parse(first!).readiness);
  expect(blockingRepos(r.db, r.config).size).toBe(1);
  // A repo that was never read stays unchecked, and nothing blocks.
  const fresh = rig({ web: WEB });
  rmSync(fresh.remotes.web!, { recursive: true, force: true });
  expect(await refreshReadiness(fresh.deps, repo(fresh))).toBeNull();
  expect(blockingRepos(fresh.db, fresh.config).size).toBe(0);
});

test("readiness: an invalid TOWERCAB.md is a missing kind with the error", async () => {
  const r = rig({ web: { ...WEB, "TOWERCAB.md": "---\nkind: robot\n---\n" } });
  await refreshReadiness(r.deps, repo(r));
  const kind = storedReadiness(r.db, "web")!.readiness.items.find((i) => i.item === "kind")!;
  expect(kind.state).toBe("missing");
  expect(kind.words).toContain("kind: robot isn't one of");
  expect(storedReadiness(r.db, "web")!.readiness.blocks).toBe(false);
});

test("readiness: apps entry comes from the infra clone", async () => {
  const service = {
    "CLAUDE.md": CLAUDE,
    Dockerfile: "FROM scratch\n",
    "TOWERCAB.md": "---\nkind: service\n---\n",
  };
  const apps = (names: string[]) => `apps:\n${names.map((n) => `  - name: ${n}\n`).join("")}`;
  for (const [names, want] of [
    [["web", "other"], "present"],
    [["other"], "missing"],
  ] as const) {
    const r = rig({ web: service, infra: { "apps.yml": apps([...names]) } });
    await refreshReadiness(r.deps, repo(r, "infra"));
    await refreshReadiness(r.deps, repo(r));
    expect(items(r).apps).toBe(want);
  }
});

const noListing = (): Listing => listing([]);
const gapsOf = (r: Rig) => storedReadiness(r.db, "web")!.readiness;

test("loop: a missing item proposes one setup intent", async () => {
  const r = rig({ web: WEB });
  await refreshReadiness(r.deps, repo(r));
  expect(await proposeSetup(r.deps, repo(r), gapsOf(r), noListing())).toBe(true);
  expect(r.prs).toHaveLength(1);
  const args = r.prs[0]!;
  expect(args[args.indexOf("--head") + 1]).toBe(setupBranch("web"));
  expect(args[args.indexOf("--base") + 1]).toBe("main");
  // The intent file is on the branch, marked as a setup intent, and lists the gaps in words.
  const list = git(r.intents, "ls-tree", "-r", "--name-only", `refs/heads/${setupBranch("web")}`);
  const file = list.split("\n").find((p) => p.endsWith("/intent.md"))!;
  const text = git(r.intents, "show", `refs/heads/${setupBranch("web")}:${file}`);
  expect(text).toContain("repo: web\n");
  expect(parseIntent(text).setup).toBe(true);
  expect(text).toContain("source: towercab\n");
  expect(text).toContain("Release-please is not set up");
  expect(text).toContain("Release publishing is not set up");
  // Nothing missing, nothing proposed.
  const ready = { ...gapsOf(r), items: gapsOf(r).items.filter((i) => i.state !== "missing") };
  expect(await proposeSetup(r.deps, repo(r), ready, noListing())).toBe(false);
  expect(r.prs).toHaveLength(1);
});

test("loop: no second setup intent while one is open", async () => {
  const r = rig({ web: WEB });
  await refreshReadiness(r.deps, repo(r));
  // A proposal still open on the branch.
  r.ghPrs.value = JSON.stringify([{ number: 7, state: "OPEN", author: { login: "app/towercab" } }]);
  expect(await proposeSetup(r.deps, repo(r), gapsOf(r), noListing())).toBe(false);
  // A closed one may be proposed again while the gaps remain.
  r.ghPrs.value = JSON.stringify([{ number: 7, state: "CLOSED", author: { login: "app/towercab" } }]);
  expect(await proposeSetup(r.deps, repo(r), gapsOf(r), noListing())).toBe(true);
  expect(r.prs).toHaveLength(1);
});

test("loop: an existing setup intent from the standards review stops the proposal", async () => {
  const r = rig({ web: WEB });
  await refreshReadiness(r.deps, repo(r));
  const open = listing([at("intents/261001-0900-fix", "setup: true\n", "web", "Fix the setup of web")]);
  expect(await proposeSetup(r.deps, repo(r), gapsOf(r), open)).toBe(false);
  // A setup intent of another repo doesn't count.
  const other = listing([at("intents/261001-0901-fix", "setup: true\n", "api", "Fix the setup of api")]);
  expect(await proposeSetup(r.deps, repo(r), gapsOf(r), other)).toBe(true);
  expect(r.prs).toHaveLength(1);
});
