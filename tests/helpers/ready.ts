// A rig for the readiness tests: `owner/<name>` repos served from local bare repos, a fake `gh`, and
// helpers to add tagged releases. Never the network.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config.ts";
import type { Db } from "../../src/db.ts";
import type { IntentStore } from "../../src/intents/types.ts";
import type { ReadinessDeps } from "../../src/readiness.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { FakeTools, failResult, okResult } from "./tools.ts";
import { bareRepo, git, TestClock, tempDir, testConfig, testDb, testHome } from "./world.ts";

export const CLAUDE = "# Repo\n\n## Verifying your work\n\n```checks\nnpm test\n```\n";
export const WEB: Record<string, string> = {
  "CLAUDE.md": CLAUDE,
  "TOWERCAB.md": "---\nkind: library\nreadiness: block\n---\n",
  "package.json": '{"name":"web","main":"index.js"}',
  ".github/workflows/ci.yml": "jobs:\n  test:\n    steps: []\n",
};
export const RULES = JSON.stringify([{ type: "required_status_checks" }]);

export interface Rig {
  deps: ReadinessDeps;
  config: Config;
  db: Db;
  clock: TestClock;
  tools: FakeTools;
  remotes: Record<string, string>;
  intents: string;
  /** `gh pr create` calls: the args and the body. */
  prs: { args: string[]; body: string }[];
  /** What `gh pr list --head` answers. */
  ghPrs: { value: string };
  home: string;
}

/** Point `https://github.com/owner/<name>.git` at local bare repos for this process. */
export function serve(remotes: Record<string, string>): void {
  const file = join(tempDir(), "gitconfig");
  writeFileSync(
    file,
    Object.entries(remotes)
      .map(([n, b]) => `[url "${b}"]\n\tinsteadOf = https://github.com/owner/${n}.git\n`)
      .join(""),
  );
  process.env.GIT_CONFIG_GLOBAL = file;
}

export function rig(repos: Record<string, Record<string, string>>): Rig {
  const remotes: Record<string, string> = {};
  const table: Record<string, unknown> = {};
  for (const [name, files] of Object.entries(repos)) {
    remotes[name] = bareRepo(files);
    table[name] = { github: `owner/${name}` };
  }
  const intents = bareRepo({ "README.md": "intents\n" });
  serve(remotes);
  const config = testConfig({ intents: { remote: intents }, repos: table });
  const prs: Rig["prs"] = [];
  const ghPrs = { value: "[]" };
  const tools = new FakeTools().on("gh", (args, opts) => {
    if (args[0] === "api") return okResult(RULES);
    if (args[0] === "pr" && args[1] === "list") return okResult(ghPrs.value);
    if (args[0] === "pr" && args[1] === "create") {
      prs.push({ args, body: opts.input ?? "" });
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

/** Commit `files` (a `null` text deletes the file) to a bare repo's main; optionally tag it. */
export function release(bare: string, files: Record<string, string | null>, tag?: string): void {
  const work = join(tempDir("tc-rel-"), "w");
  git(dirname(work), "clone", "-q", bare, work);
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git(work, "rm", "-q", "-f", path);
    else {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", tag ?? "edit");
  if (tag) git(work, "tag", tag);
  git(work, "push", "-q", "origin", "main", "--tags");
}
