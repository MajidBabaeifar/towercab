// A repo's limits in its own TOWERCAB.md (REPO-14 to REPO-19): the reader, the value that wins, the pull
// request a save opens, what is pending, files changed outside Towercab, and the one-time move.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { doctor } from "../src/doctor.ts";
import { parseTowercab } from "../src/repo/files.ts";
import { pollRepoSettings } from "../src/repo/poll.ts";
import {
  CONFIRM_TEXT,
  editTowercab,
  errorKey,
  isMoved,
  movedKey,
  PARSER_KEY,
  proposeSettings,
  readRecord,
  recordParser,
  reopenMove,
  type SettingsEnv,
  waitHours,
} from "../src/repo/settings.ts";
import { loadRepos, readRepos, setRepo } from "../src/repos.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir, testConfig, testHome } from "./helpers/world.ts";

const T0 = 1_793_000_000;
const HOUR = 3600;
const fm = (body: string) => `---\n${body}\n---\n`;

// GitHub's clone URL for owner/web is a local bare repo, never the network.
let saved: string | undefined;
let bare: string;
beforeEach(() => {
  saved = process.env.GIT_CONFIG_GLOBAL;
  bare = bareRepo({ "CLAUDE.md": "x\n", "README.md": "web\n" });
  const file = join(tempDir(), "gitconfig");
  writeFileSync(file, `[url "${bare}"]\n\tinsteadOf = https://github.com/owner/web.git\n`);
  process.env.GIT_CONFIG_GLOBAL = file;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

function world(row: { workers?: number; ahead?: number } = {}) {
  const db = Db.memory();
  const config = testConfig({ repos: { web: { github: "owner/web", ...row } } });
  loadRepos(config, db, T0);
  const forge = new FakeForge();
  const tools = new FakeTools();
  const home = testHome();
  const env = (now = T0): SettingsEnv => ({
    db,
    tools,
    forge,
    home: home.root,
    now,
    repos: config.repos,
  });
  const poll = (now = T0) => pollRepoSettings(env(now), () => undefined);
  const limits = () => {
    const r = readRepos(db)[0]!;
    return { workers: r.workers, ahead: r.ahead };
  };
  // The parser ran long enough ago that saves need no confirmation and the move may start.
  const aged = () => db.setMeta(PARSER_KEY, `abc ${T0 - 25 * HOUR}`);
  return { db, config, forge, tools, home, env, poll, limits, aged };
}

const branchFile = (n = 1, kind = "settings") => git(bare, "show", `towercab/${kind}-web-${n}:TOWERCAB.md`);

test("repo: TOWERCAB.md workers and ahead", () => {
  expect(parseTowercab(fm("workers: 4\nahead: 7"))).toMatchObject({ workers: 4, ahead: 7 });
  expect(parseTowercab(fm("max_autonomy: 2")).workers).toBeUndefined();
  expect(parseTowercab("").ahead).toBeUndefined();
});

test("repo: a bad workers or ahead is invalid", () => {
  for (const [k, v] of [
    ["workers", "0"],
    ["workers", "17"],
    ["ahead", "2.5"],
    ["ahead", "many"],
  ] as const) {
    expect(() => parseTowercab(fm(`${k}: ${v}`))).toThrow(`${k}: ${v} isn't a whole number from 1 to 16`);
  }
});

test("repo: a new limit applies on the next fetch", async () => {
  const w = world();
  await w.poll();
  expect(w.limits()).toEqual({ workers: 1, ahead: 3 });
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 4") });
  expect(w.limits().workers).toBe(1);
  await w.poll();
  expect(w.limits()).toEqual({ workers: 4, ahead: 3 });
  // The scheduler reads the same Map once the loop syncs it.
});

test("repo: a save in the first 24 hours needs a confirmation", async () => {
  const w = world();
  expect(waitHours(w.db, T0)).toBe(24);
  await expect(proposeSettings(w.env(), "web", { workers: 2 })).rejects.toThrow(CONFIRM_TEXT);
  expect(w.forge.prs).toHaveLength(0);
});

test("repo: a confirmed save in the first 24 hours opens the PR", async () => {
  const w = world();
  const reply = await proposeSettings(w.env(), "web", { workers: 2 }, true);
  expect(reply).toBe("Opened PR #1. The change applies after it is merged.");
  expect(branchFile()).toBe(fm("workers: 2"));
});

test("repo: a TOWERCAB.md key wins over the database", async () => {
  const w = world({ workers: 3 });
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 5") });
  await w.poll();
  expect(w.limits()).toEqual({ workers: 5, ahead: 3 });
});

test("repo: before the move the database value is used", async () => {
  const w = world({ workers: 3, ahead: 6 });
  pushFiles(bare, { "TOWERCAB.md": fm("max_autonomy: 4") });
  await w.poll();
  expect(w.limits()).toEqual({ workers: 3, ahead: 6 });
});

test("repo: after the move a missing key is the default", async () => {
  const w = world({ workers: 3, ahead: 6 });
  pushFiles(bare, { "TOWERCAB.md": fm("ahead: 8") });
  w.db.setMeta(movedKey("web"), String(T0));
  await w.poll();
  expect(w.limits()).toEqual({ workers: 1, ahead: 8 });
});

test("repo: an unreadable file keeps the last good limits", async () => {
  const w = world();
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 5") });
  await w.poll();
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 99") });
  await w.poll();
  expect(w.limits().workers).toBe(5);
  // Before any good read the database value stays.
  const fresh = world({ workers: 2 });
  await fresh.poll();
  expect(fresh.limits().workers).toBe(2);
});

test("repo: repo set refuses moved keys", () => {
  const w = world();
  expect(setRepo(w.db, w.config, "web", ["workers=2"]).workers).toBe(2);
  w.db.setMeta(movedKey("web"), String(T0));
  expect(() => setRepo(w.db, w.config, "web", ["workers=3"])).toThrow(
    "workers and ahead for web now live in TOWERCAB.md; change them on the repo's page or in the file.",
  );
  expect(() => setRepo(w.db, w.config, "web", ["ahead=4"])).toThrow("now live in TOWERCAB.md");
});

test("repo: a settings change opens a PR with only that change", async () => {
  const w = world();
  w.aged();
  const base = "---\nmax_autonomy: 3\nworkers: 2\n---\n\n# Notes\n";
  pushFiles(bare, { "TOWERCAB.md": base });
  await proposeSettings(w.env(), "web", { ahead: 5, workers: 2 });
  expect(branchFile()).toBe("---\nmax_autonomy: 3\nworkers: 2\nahead: 5\n---\n\n# Notes\n");
  const pr = w.forge.prs[0]!;
  expect(pr.title).toBe("chore(towercab): change Towercab settings");
  expect(pr.base).toBe("main");
  expect(pr.body).toContain("`ahead`");
  expect(pr.body).not.toContain("`workers`");
  // Only the one file differs from the base branch.
  expect(git(bare, "diff", "--name-only", "main", "towercab/settings-web-1").trim()).toBe("TOWERCAB.md");
});

test("repo: unchanged settings open no PR", async () => {
  const w = world();
  w.aged();
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 2") });
  expect(await proposeSettings(w.env(), "web", { workers: 2 })).toBe("Nothing changed.");
  expect(await proposeSettings(w.env(), "web", { ahead: null })).toBe("Nothing changed.");
  expect(w.forge.prs).toHaveLength(0);
  expect(git(bare, "branch", "--list", "towercab/*").trim()).toBe("");
});

test("repo: other lines stay byte-identical", () => {
  const text = "---\n# my limits\nmax_autonomy:   3\nworkers: 2 # keep\ntests:\n  - a/**\n---\nprose  \n";
  const a = editTowercab(text, { workers: 4, ahead: 6 });
  expect(a.changed).toEqual(["workers", "ahead"]);
  expect(a.text).toBe(
    "---\n# my limits\nmax_autonomy:   3\nworkers: 4\ntests:\n  - a/**\nahead: 6\n---\nprose  \n",
  );
  const back = editTowercab(a.text, { workers: null, ahead: null });
  expect(back.text).toBe("---\n# my limits\nmax_autonomy:   3\ntests:\n  - a/**\n---\nprose  \n");
  // No file yet: the front matter is created; a file without any gets it first.
  expect(editTowercab(null, { workers: 2 }).text).toBe("---\nworkers: 2\n---\n");
  expect(editTowercab("# Notes\n", { ahead: 4 }).text).toBe("---\nahead: 4\n---\n# Notes\n");
});

test("repo: a second save updates the open settings PR", async () => {
  const w = world();
  w.aged();
  await proposeSettings(w.env(), "web", { workers: 2 });
  const reply = await proposeSettings(w.env(), "web", { ahead: 5 });
  expect(reply).toBe("Added your change to PR #1. The change applies after it is merged.");
  expect(w.forge.prs).toHaveLength(1);
  expect(branchFile()).toBe(fm("workers: 2\nahead: 5"));
  expect(w.forge.prs[0]!.body).toContain("`workers`");
  expect(w.forge.prs[0]!.body).toContain("`ahead`");
  // A later value for the same key replaces the earlier one.
  await proposeSettings(w.env(), "web", { workers: 4 });
  expect(branchFile()).toBe(fm("workers: 4\nahead: 5"));
});

test("repo: an invalid value opens no PR", async () => {
  const w = world();
  w.aged();
  await expect(proposeSettings(w.env(), "web", { workers: 0 })).rejects.toThrow(
    "workers: 0 isn't a whole number from 1 to 16",
  );
  await expect(proposeSettings(w.env(), "web", { ahead: 2.5 })).rejects.toThrow("ahead: 2.5");
  await expect(proposeSettings(w.env(), "web", { max_autonomy: 1 })).rejects.toThrow("isn't a setting");
  // A base file that doesn't parse is refused with its reason.
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 99") });
  await expect(proposeSettings(w.env(), "web", { ahead: 2 })).rejects.toThrow("workers: 99");
  expect(w.forge.prs).toHaveLength(0);
});

test("repo: a settings PR is never merged by Towercab", async () => {
  const w = world();
  w.aged();
  await proposeSettings(w.env(), "web", { workers: 2 });
  await w.poll();
  await proposeSettings(w.env(), "web", { ahead: 2 });
  expect(w.forge.calls.filter((c) => /merge/i.test(c))).toEqual([]);
  expect(w.forge.prs[0]!.state).toBe("OPEN");
});

test("repo: a setting is pending while its PR is open", async () => {
  const w = world();
  w.aged();
  await proposeSettings(w.env(), "web", { workers: 2 });
  await w.poll();
  expect(readRecord(w.db, "web", "settings")).toMatchObject({
    pr: 1,
    state: "open",
    changes: { workers: 2 },
  });
  expect(w.limits().workers).toBe(1);
});

test("repo: a merged settings PR applies on the next fetch", async () => {
  const w = world();
  w.aged();
  await proposeSettings(w.env(), "web", { workers: 2 });
  // Merged on GitHub: the base branch has the file.
  pushFiles(bare, { "TOWERCAB.md": branchFile() });
  w.forge.prs[0]!.state = "MERGED";
  await w.poll();
  expect(readRecord(w.db, "web", "settings")).toBeNull();
  expect(w.limits().workers).toBe(2);
});

test("repo: a closed settings PR leaves the value alone", async () => {
  const w = world();
  w.aged();
  await proposeSettings(w.env(), "web", { workers: 2 });
  w.forge.prs[0]!.state = "CLOSED";
  await w.poll();
  expect(readRecord(w.db, "web", "settings")).toBeNull();
  expect(w.limits().workers).toBe(1);
});

test("repo: a hand edit applies on the next fetch", async () => {
  const w = world({ workers: 2 });
  await w.poll();
  expect(w.limits().workers).toBe(2);
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 6\nahead: 9") }, "edited by hand");
  await w.poll();
  expect(w.limits()).toEqual({ workers: 6, ahead: 9 });
});

test("repo: an invalid file reports its reason", async () => {
  const w = world();
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 20") });
  await w.poll();
  expect(w.db.meta(errorKey("web"))).toBe("workers: 20 isn't a whole number from 1 to 16");
});

test("repo: the reason clears when the file is valid", async () => {
  const w = world();
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 20") });
  await w.poll();
  expect(w.db.meta(errorKey("web"))).not.toBeNull();
  pushFiles(bare, { "TOWERCAB.md": fm("workers: 2") });
  await w.poll();
  expect(w.db.meta(errorKey("web"))).toBeNull();
});

// A checkout with two commits, to stand for Towercab's own code.
function code() {
  const dir = tempDir("tc-code-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  const one = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "commit", "-q", "--allow-empty", "-m", "two");
  const two = git(dir, "rev-parse", "HEAD").trim();
  return { dir, one, two };
}

test("repo: the first run of the parser is recorded once", async () => {
  const w = world();
  const c = code();
  await recordParser(w.db, w.tools, c.dir, c.one, T0);
  expect(w.db.meta(PARSER_KEY)).toBe(`${c.one} ${T0}`);
  // A later start, even on a newer commit that still has the first in its history, keeps the record.
  await recordParser(w.db, w.tools, c.dir, c.one, T0 + HOUR);
  await recordParser(w.db, w.tools, c.dir, c.two, T0 + 2 * HOUR);
  expect(w.db.meta(PARSER_KEY)).toBe(`${c.one} ${T0}`);
});

test("repo: no move PR before 24 hours", async () => {
  const w = world({ workers: 3 });
  w.db.setMeta(PARSER_KEY, `abc ${T0}`);
  await w.poll(T0 + 23 * HOUR);
  expect(waitHours(w.db, T0 + 23 * HOUR)).toBe(1);
  expect(w.forge.prs).toHaveLength(0);
});

test("repo: the move starts after 24 hours", async () => {
  const w = world({ workers: 3 });
  w.db.setMeta(PARSER_KEY, `abc ${T0}`);
  await w.poll(T0 + 24 * HOUR);
  expect(waitHours(w.db, T0 + 24 * HOUR)).toBeNull();
  expect(w.forge.prs).toHaveLength(1);
  expect(w.forge.prs[0]!.title).toBe("chore(towercab): move Towercab settings into TOWERCAB.md");
});

test("repo: a rolled back parser restarts the 24 hours", async () => {
  const w = world();
  const c = code();
  // The recorded commit is the newer one; Towercab now runs the older one.
  w.db.setMeta(PARSER_KEY, `${c.two} ${T0}`);
  await recordParser(w.db, w.tools, c.dir, c.one, T0 + 30 * HOUR);
  expect(w.db.meta(PARSER_KEY)).toBe(`${c.one} ${T0 + 30 * HOUR}`);
  expect(waitHours(w.db, T0 + 30 * HOUR)).toBe(24);
});

test("repo: the move PR opens only once the wait is over", async () => {
  const w = world({ ahead: 6 });
  w.db.setMeta(PARSER_KEY, `abc ${T0}`);
  await w.poll(T0 + HOUR);
  expect(w.forge.prs).toHaveLength(0);
  await w.poll(T0 + 25 * HOUR);
  await w.poll(T0 + 26 * HOUR);
  expect(w.forge.prs).toHaveLength(1);
  expect(w.db.meta("repo-move:web")).toBe("1");
});

test("repo: the move opens one PR with the non-default values", async () => {
  const w = world({ workers: 3 });
  w.aged();
  await w.poll();
  expect(branchFile(1, "move-settings")).toBe(fm("workers: 3"));
  expect(w.forge.prs[0]!.body).toContain("`workers`");
  expect(w.forge.prs[0]!.body).not.toContain("`ahead`");
});

test("repo: the move is skipped when nothing differs", async () => {
  const w = world();
  w.aged();
  await w.poll();
  expect(w.forge.prs).toHaveLength(0);
  expect(isMoved(w.db, "web")).toBe(true);
});

test("repo: a closed move PR is not replaced on its own", async () => {
  const w = world({ workers: 3 });
  w.aged();
  await w.poll();
  w.forge.prs[0]!.state = "CLOSED";
  await w.poll();
  await w.poll();
  expect(w.forge.prs).toHaveLength(1);
  expect(readRecord(w.db, "web", "move")?.state).toBe("closed");
  expect(w.limits().workers).toBe(3);
  expect(isMoved(w.db, "web")).toBe(false);
});

test("repo: a closed move PR is a doctor warning", async () => {
  const w = world({ workers: 3 });
  w.aged();
  await w.poll();
  const lines = async () =>
    (
      await doctor({
        config: w.config,
        home: w.home,
        tools: new FakeTools(),
        github: null,
        quick: false,
        db: w.db,
      })
    ).lines;
  expect(await lines()).not.toContain(expect.stringContaining("moves its settings"));
  w.forge.prs[0]!.state = "CLOSED";
  await w.poll();
  const warn =
    "web: the PR that moves its settings into TOWERCAB.md was closed; open it again from the repo's page.";
  expect(await lines()).toContain(warn);
});

test("repo: the owner can open the move PR again", async () => {
  const w = world({ workers: 3 });
  w.aged();
  await w.poll();
  await expect(reopenMove(w.env(), "web")).rejects.toThrow("a move PR is already open: #1");
  w.forge.prs[0]!.state = "CLOSED";
  await w.poll();
  expect(await reopenMove(w.env(), "web")).toBe("Opened PR #2.");
  expect(w.forge.prs).toHaveLength(2);
  expect(readRecord(w.db, "web", "move")).toMatchObject({ pr: 2, state: "open" });
  w.db.setMeta(movedKey("web"), String(T0));
  await expect(reopenMove(w.env(), "web")).rejects.toThrow("web has already moved");
});

test("repo: a merged move PR marks the repo moved", async () => {
  const w = world({ workers: 3 });
  w.aged();
  await w.poll();
  pushFiles(bare, { "TOWERCAB.md": branchFile(1, "move-settings") });
  w.forge.prs[0]!.state = "MERGED";
  await w.poll();
  expect(isMoved(w.db, "web")).toBe(true);
  expect(w.limits().workers).toBe(3);
});
