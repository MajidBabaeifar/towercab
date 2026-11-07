// Changing an intent's autonomy (AUT-8, AUT-9, AUT-34, AUT-35): the page writes `a:` in one commit, a mission
// reads the level at each gate, and a raise that isn't the owner's is flagged, not acted on.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { effectiveA, gate } from "../src/autonomy.ts";
import { acceptedOf, flagOf, levelNow } from "../src/autonomy-change.ts";
import { watchAutonomy } from "../src/autonomy-watch.ts";
import { applyCommand, ignoredNotes } from "../src/commands.ts";
import { Db } from "../src/db.ts";
import { openStore } from "../src/intents/store.ts";
import type { IntentStore } from "../src/intents/types.ts";
import type { Mission } from "../src/mission.ts";
import { effectiveOf, intentOf } from "../src/pipeline/common.ts";
import type { RepoFiles } from "../src/repo/files.ts";
import { createActions } from "../src/ui/actions.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir } from "./helpers/world.ts";
import { intentMd } from "./intents/fixtures.ts";

const ID = "261107-0900";
const DIR = `intents/${ID}-thing`;
const FILE = `${DIR}/intent.md`;
const NOW = 1_793_000_000;
const file = (extra: string) => intentMd("web", extra, "Thing");

async function world(extra = "u: 3\ni: 3\na: 2\n") {
  const remote = bareRepo({ [FILE]: file(extra) });
  const real = await openStore({
    remote,
    path: join(tempDir(), "intents"),
    tools: new FakeTools(),
    log: () => {},
    now: () => new Date(NOW * 1000),
  });
  // The remote is a local path: say it is on GitHub so the loop asks the forge who pushed.
  const store: IntentStore = Object.assign(Object.create(real), { github: () => "owner/intents" });
  const db = Db.memory();
  const forge = new FakeForge("owner");
  const clock = { now: () => NOW, mono: () => 0 };
  const actions = (actor?: "shadow") =>
    createActions({
      db,
      store,
      config: undefined as never,
      clock,
      github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
      ...(actor ? { actor } : {}),
    });
  const watch = async () => watchAutonomy({ db, store, forge, now: NOW, log: () => {} }, await store.list());
  const head = () => git(remote, "rev-parse", "main").trim();
  const commits = () => Number(git(remote, "rev-list", "--count", "main").trim());
  const text = () => git(remote, "show", `main:${FILE}`);
  /** Somebody pushes a new intent file; GitHub says `logins` made the commit. */
  const push = (body: string, logins: (string | null)[]) => {
    pushFiles(remote, { [FILE]: body }, "edit a");
    forge.commitAccounts.set(head(), logins);
  };
  await watch();
  return { remote, store, db, forge, actions, watch, head, commits, text, push };
}

const files = { towercab: { maxAutonomy: 5 } } as unknown as RepoFiles;
const mission = { intent: ID } as Mission;
const levelOf = async (w: Awaited<ReturnType<typeof world>>) =>
  effectiveOf(mission, await intentOf({ db: w.db, store: w.store } as never, mission), files);

test("autonomy: changing a writes only the a line in one commit", async () => {
  const w = await world();
  const before = w.commits();
  expect(await w.actions().autonomy!(ID, 1, "owner")).toBe("Saved. Applies from the next gate.");
  expect(w.commits()).toBe(before + 1);
  expect(w.text()).toBe(file("u: 3\ni: 3\na: 1\n"));
  // One commit; the intent file changes by one line (the store also refreshes its generated views).
  const diff = git(w.remote, "diff", "--numstat", "HEAD~1", "HEAD", "--", FILE).trim();
  expect(diff).toBe(`1\t1\t${FILE}`);
});

test("autonomy: setting the same level writes nothing", async () => {
  const w = await world();
  const before = w.commits();
  expect(await w.actions().autonomy!(ID, 2, "owner")).toBe("Already at a2.");
  expect(w.commits()).toBe(before);
  await expect(w.actions().autonomy!(ID, 6, "owner")).rejects.toThrow("Autonomy is a0 to a5.");
  await expect(w.actions().autonomy!(ID, 1.5, "owner")).rejects.toThrow("Autonomy is a0 to a5.");
  expect(w.commits()).toBe(before);
});

test("autonomy: a lowering applies at once", async () => {
  const w = await world("u: 3\ni: 3\na: 4\n");
  expect(await levelOf(w)).toBe(4);
  await w.actions().autonomy!(ID, 1, "owner");
  expect(await levelOf(w)).toBe(1);
  // Lowering to a0 too, and nothing is flagged for a lowering.
  await w.actions().autonomy!(ID, 0, "owner");
  expect(await levelOf(w)).toBe(0);
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
});

test("autonomy: a running mission uses the new level at its next gate", async () => {
  const w = await world();
  // The mission was picked at a2; the gate reads the intent's level now, not the one at pick (AUT-8).
  const picked = { intent: ID, a_at_pick: 2 } as Mission;
  const at = async () =>
    effectiveOf(picked, await intentOf({ db: w.db, store: w.store } as never, picked), files);
  expect(await at()).toBe(2);
  await w.actions().autonomy!(ID, 5, "owner");
  expect(await at()).toBe(5);
  expect(effectiveA(5, 3, "me")).toBe(3);
});

test("autonomy: a waiting gate is decided again after a change", async () => {
  const w = await world();
  const green = {
    ciGreen: true,
    review: { approved: true },
    unplanned: false,
    proven: true,
    risk: "low",
  } as const;
  const decide = async () => gate({ a: await levelOf(w), ...green });
  expect((await decide()).merge).toBe(false);
  await w.actions().autonomy!(ID, 4, "owner");
  expect((await decide()).merge).toBe(true);
  await w.actions().autonomy!(ID, 1, "owner");
  expect((await decide()).merge).toBe(false);
});

test("autonomy: the page raises a", async () => {
  const w = await world();
  await w.actions().autonomy!(ID, 4, "owner");
  expect(w.text()).toContain("a: 4\n");
  // The page's own commit is the owner's: it is accepted and the loop flags nothing.
  expect(acceptedOf(w.db, ID)).toBe(4);
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(w.forge.calls.filter((c) => c.startsWith("commit "))).toEqual([]);
});

test("autonomy: a shadow raise is refused", async () => {
  const w = await world();
  const before = w.commits();
  await expect(w.actions("shadow").autonomy!(ID, 5, "")).rejects.toThrow("only you can raise autonomy");
  await expect(w.actions().autonomy!(ID, 5, "agent")).rejects.toThrow("only you can raise autonomy");
  // Nor does the shadow or an agent lower it: only the page changes the level.
  await expect(w.actions("shadow").autonomy!(ID, 1, "")).rejects.toThrow("only you can change autonomy");
  expect(w.commits()).toBe(before);
  expect(w.text()).toContain("a: 2\n");
});

test("autonomy: a raising command row from the cli is dropped", async () => {
  const w = await world();
  // The commands table refuses the name, so a row can't be written; one built by hand is dropped and noted.
  expect(() =>
    w.db.run("INSERT INTO commands (name, arg, source, created) VALUES ('autonomy', ?, 'cli', 1)", ID),
  ).toThrow();
  const row = {
    id: 7,
    name: "autonomy",
    arg: ID,
    text: "5",
    source: "cli",
    created: NOW,
    applied_at: null,
    result: null,
  };
  const cx = { db: w.db, store: w.store, applyCtx: {} as never, now: new Date(NOW * 1000) };
  expect(await applyCommand(cx, row as never)).toMatch("only you can raise autonomy");
  expect(ignoredNotes(w.db, ID).map((n) => n.text)).toEqual([
    'ignored "autonomy" from the cli: only you can raise autonomy',
  ]);
  expect(w.text()).toContain("a: 2\n");
});

test("autonomy: a raise by the owner on github counts", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 4\n"), ["owner", null]);
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(acceptedOf(w.db, ID)).toBe(4);
  expect(await levelOf(w)).toBe(4);
});

test("autonomy: a push is judged by the verified github account", async () => {
  const w = await world();
  // The commit's own name says `owner`, GitHub says `mallory`: not the owner.
  pushFiles(w.remote, { [FILE]: file("u: 3\ni: 3\na: 4\n") }, "edit a");
  w.forge.commitAccounts.set(w.head(), ["mallory", "mallory"]);
  await w.watch();
  expect(flagOf(w.db, ID)?.who).toBe("mallory");
  // A different name in the commit, but GitHub says it is the owner's account: counts (a later raise).
  w.push(file("u: 3\ni: 3\na: 5\n"), ["Owner", null]);
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(acceptedOf(w.db, ID)).toBe(5);
  // A commit GitHub can't name (no linked account) doesn't count.
  w.push(file("u: 3\ni: 3\na: 4\n"), [null, null]);
  w.push(file("u: 3\ni: 3\na: 5\n"), [null, null]);
  await w.watch();
  expect(acceptedOf(w.db, ID)).toBe(5);
  await w.actions().autonomy!(ID, 3, "owner");
  w.push(file("u: 3\ni: 3\na: 4\n"), [null, null]);
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ who: "unknown", from: 3, to: 4 });
});

test("autonomy: a raise by another account is flagged and not written back", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 5\n"), ["mallory", "mallory"]);
  const heads = w.head();
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ who: "mallory", from: 2, to: 5 });
  expect(w.head()).toBe(heads);
  expect(w.text()).toContain("a: 5\n");
  expect(ignoredNotes(w.db, ID).map((n) => n.text)).toEqual([
    "mallory raised autonomy from a2 to a5: it keeps running at a2 until you accept it",
  ]);
  // The same commit is noted once.
  await w.watch();
  expect(ignoredNotes(w.db, ID)).toHaveLength(1);
});

test("autonomy: a flagged raise runs at the lower level", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 5\n"), ["mallory", null]);
  await w.watch();
  expect(levelNow(w.db, await w.store.get(ID))).toBe(2);
  expect(await levelOf(w)).toBe(2);
  // Lowering by anyone ends the flag and applies at once.
  w.push(file("u: 3\ni: 3\na: 1\n"), ["mallory", null]);
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(await levelOf(w)).toBe(1);
});

test("autonomy: accepting a flagged raise lifts the flag", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 5\n"), ["mallory", null]);
  await w.watch();
  const before = w.commits();
  expect(await w.actions().autonomy!(ID, 5, "owner")).toBe("Saved. Applies from the next gate.");
  expect(flagOf(w.db, ID)).toBeNull();
  expect(acceptedOf(w.db, ID)).toBe(5);
  expect(w.commits()).toBe(before);
  expect(await levelOf(w)).toBe(5);
  // Setting it back writes the lower level.
  const back = await world();
  back.push(file("u: 3\ni: 3\na: 5\n"), ["mallory", null]);
  await back.watch();
  await back.actions().autonomy!(ID, 2, "owner");
  expect(back.text()).toContain("a: 2\n");
  expect(flagOf(back.db, ID)).toBeNull();
  expect(await levelOf(back)).toBe(2);
});

test("autonomy: deleting the a line by another account is flagged as a raise to the default", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\n"), ["mallory", null]);
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ who: "mallory", from: 2, to: 5 });
  expect(await levelOf(w)).toBe(2);
  // An intent that already runs at the default: deleting the line raises nothing.
  const same = await world("u: 3\ni: 3\na: 5\n");
  same.push(file("u: 3\ni: 3\n"), ["mallory", null]);
  await same.watch();
  expect(flagOf(same.db, ID)).toBeNull();
});

test("autonomy: deleting the a line by the owner counts", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\n"), ["owner", null]);
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(acceptedOf(w.db, ID)).toBe(5);
  expect(await levelOf(w)).toBe(5);
});

test("autonomy: a raise holds back at a gate that runs before it is judged", async () => {
  const w = await world();
  // A stranger's push is read by the next gate before the watch has looked at it.
  w.push(file("u: 3\ni: 3\na: 5\n"), ["mallory", null]);
  expect(flagOf(w.db, ID)).toBeNull();
  expect(await levelOf(w)).toBe(2);
  // Once the owner's account is confirmed it counts.
  w.forge.commitAccounts.set(w.head(), ["owner", null]);
  await w.watch();
  expect(await levelOf(w)).toBe(5);
});

test("autonomy: a raise stays held while github can't say who made it", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 5\n"), ["owner", null]);
  w.forge.commitLogins = async () => {
    throw new Error("rate limited");
  };
  await w.watch();
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(acceptedOf(w.db, ID)).toBe(2);
  expect(await levelOf(w)).toBe(2);
});

test("autonomy: a raise hidden in a merge commit is judged by the merge", async () => {
  const w = await world();
  // The owner's earlier commits all touch the file; then someone merges two branches and, while resolving
  // the merge, changes `a: 2` to `a: 5`.
  const me = join(tempDir(), "me");
  git(tempDir(), "clone", "-q", w.remote, me);
  git(me, "checkout", "-q", "-b", "side");
  writeFileSync(join(me, "side.txt"), "side\n");
  git(me, "add", "-A");
  git(me, "commit", "-q", "-m", "side");
  git(me, "checkout", "-q", "main");
  writeFileSync(join(me, "main.txt"), "main\n");
  git(me, "add", "-A");
  git(me, "commit", "-q", "-m", "main");
  git(me, "merge", "-q", "--no-ff", "--no-commit", "side");
  writeFileSync(join(me, FILE), file("u: 3\ni: 3\na: 5\n"));
  git(me, "add", "-A");
  git(me, "commit", "-q", "-m", "merge side");
  git(me, "push", "-q", "origin", "main");
  // Every older commit is the owner's; GitHub says the merge is mallory's.
  for (const sha of git(w.remote, "rev-list", "main").trim().split("\n")) {
    w.forge.commitAccounts.set(sha, ["owner", "owner"]);
  }
  w.forge.commitAccounts.set(w.head(), ["mallory", "mallory"]);
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ who: "mallory", from: 2, to: 5 });
  expect(await levelOf(w)).toBe(2);
  // A commit that doesn't set the level now (unrelated history) is never credited either.
  expect(await w.store.lastAChange!(ID)).toBe(w.head());
});

test("autonomy: an unsigned push naming the owner is flagged", async () => {
  const w = await world();
  // The commit carries the owner's e-mail and GitHub links it to the owner's account, but nobody signed it.
  w.push(file("u: 3\ni: 3\na: 5\n"), ["owner", "owner"]);
  w.forge.commitProofs.set(w.head(), { author: "owner", committer: "owner", verified: false });
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ who: "owner (unverified)", from: 2, to: 5 });
  expect(await levelOf(w)).toBe(2);
  // A commit made on the web page, but not verified, is no better.
  w.push(file("u: 3\ni: 3\na: 4\n"), ["owner", null]);
  w.forge.commitProofs.set(w.head(), { author: "owner", committer: "web-flow", verified: false });
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ to: 4 });
  expect(await levelOf(w)).toBe(2);
  // One confirmed click on the card accepts it.
  await w.actions().autonomy!(ID, 4, "owner");
  expect(flagOf(w.db, ID)).toBeNull();
  expect(await levelOf(w)).toBe(4);
});

test("autonomy: a verified web commit by the owner counts", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 4\n"), ["owner", null]);
  w.forge.commitProofs.set(w.head(), { author: "owner", committer: "web-flow", verified: true });
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(await levelOf(w)).toBe(4);
  // The host's committer with somebody else as author is not the owner's.
  w.push(file("u: 3\ni: 3\na: 5\n"), ["mallory", null]);
  w.forge.commitProofs.set(w.head(), { author: "mallory", committer: "web-flow", verified: true });
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ who: "mallory", to: 5 });
  expect(await levelOf(w)).toBe(4);
});

test("autonomy: a commit signed by the owner and verified counts", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 5\n"), ["owner", "owner"]);
  w.forge.commitProofs.set(w.head(), { author: "owner", committer: "owner", verified: true });
  await w.watch();
  expect(flagOf(w.db, ID)).toBeNull();
  expect(await levelOf(w)).toBe(5);
  // Lowered, then raised again by a commit signed and verified for somebody else's account: flagged.
  await w.actions().autonomy!(ID, 2, "owner");
  w.push(file("u: 3\ni: 3\na: 3\n"), ["mallory", "mallory"]);
  w.forge.commitProofs.set(w.head(), { author: "owner", committer: "mallory", verified: true });
  await w.watch();
  expect(flagOf(w.db, ID)).toMatchObject({ who: "mallory", to: 3 });
});
