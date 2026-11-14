// The fast lane's safeguards (FAST-9): the mark reorders work from any channel, but it skips the owner's approvals
// only once the owner confirmed it; checks, the repo cap and a0 hold whatever the mark says.

import { join } from "node:path";
import { expect, test } from "vitest";
import { gate, gateLevel, riskWaits } from "../src/autonomy.ts";
import { Db } from "../src/db.ts";
import { fastConfirmed, fastFromCli, markFast } from "../src/fast.ts";
import { watchFast } from "../src/fast-watch.ts";
import { openStore } from "../src/intents/store.ts";
import type { IntentStore } from "../src/intents/types.ts";
import type { Mission } from "../src/mission.ts";
import { gateLevelOf, intentOf } from "../src/pipeline/common.ts";
import type { RepoFiles } from "../src/repo/files.ts";
import type { UiActions } from "../src/ui/actions.ts";
import { createActions } from "../src/ui/actions.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { ChatRig } from "./helpers/telegram.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir } from "./helpers/world.ts";
import { intentMd } from "./intents/fixtures.ts";

const ID = "261107-0900";
const DIR = `intents/${ID}-thing`;
const FILE = `${DIR}/intent.md`;
const NOW = 1_793_000_000;
const file = (extra: string) => intentMd("web", extra, "Thing");

async function world(extra = "u: 3\ni: 3\na: 2\n", db: Db = Db.memory()) {
  const remote = bareRepo({ [FILE]: file(extra) });
  const real = await openStore({
    remote,
    path: join(tempDir(), "intents"),
    tools: new FakeTools(),
    log: () => {},
    now: () => new Date(NOW * 1000),
  });
  // The remote is a local path: say it is on GitHub so the watch asks the forge who pushed.
  const store: IntentStore = Object.assign(Object.create(real), { github: () => "owner/intents" });
  const forge = new FakeForge("owner");
  const clock = { now: () => NOW, mono: () => 0 };
  const actions = (actor?: "shadow"): UiActions =>
    createActions({
      db,
      store,
      config: undefined as never,
      clock,
      github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
      ...(actor ? { actor } : {}),
    });
  const watch = async () => watchFast({ db, store, forge, now: NOW, log: () => {} }, await store.list());
  const head = () => git(remote, "rev-parse", "main").trim();
  const text = () => git(remote, "show", `main:${FILE}`);
  const mark = (on: boolean, channel: "page" | "telegram" | "cli") =>
    markFast({ db, store }, ID, on, channel);
  /** Somebody pushes a new intent file; GitHub says `logins` made the commit. */
  const push = (body: string, logins: (string | null)[]) => {
    pushFiles(remote, { [FILE]: body }, "edit fast");
    forge.commitAccounts.set(head(), logins);
  };
  return { remote, store, db, forge, actions, watch, head, text, mark, push };
}

type World = Awaited<ReturnType<typeof world>>;

const mission = { intent: ID } as Mission;
const filesOf = (cap = 5) => ({ towercab: { maxAutonomy: cap } }) as unknown as RepoFiles;
/** The level the spec, plan and merge gates decide at, for the intent as it is now. */
const levelOf = async (w: World, cap = 5) =>
  gateLevelOf(
    { db: w.db } as never,
    mission,
    await intentOf({ db: w.db, store: w.store } as never, mission),
    filesOf(cap),
  );

const green = { ciGreen: true, review: { approved: true }, unplanned: false, proven: true } as const;

test("fast: every check still runs", () => {
  const level = gateLevel(4, true, 5, "me");
  expect(level).toBe(5);
  // Medium risk goes ahead at the fast level, as at a5 ...
  expect(gate({ a: level, ...green, risk: "medium" }).merge).toBe(true);
  // ... but nothing else the gate checks is skipped.
  expect(gate({ a: level, ...green, risk: "high" }).merge).toBe(false);
  expect(gate({ a: level, ...green, risk: null }).merge).toBe(false);
  expect(gate({ a: level, ...green, ciGreen: false, risk: "low" }).merge).toBe(false);
  expect(gate({ a: level, ...green, review: null, risk: "low" }).merge).toBe(false);
  expect(gate({ a: level, ...green, review: { approved: false }, risk: "low" }).merge).toBe(false);
  expect(gate({ a: level, ...green, proven: false, risk: "low" }).merge).toBe(false);
  // Access beyond the plan still holds an intent whose worker had a4's access, though the gate decides at a5.
  expect(gate({ a: level, accessA: 4, ...green, unplanned: true, risk: "low" }).merge).toBe(false);
  // The fast lane never lowers a level, and an unconfirmed mark changes nothing.
  expect(gateLevel(5, true, 5, "me")).toBe(5);
  expect(gateLevel(4, false, 5, "me")).toBe(4);
});

test("fast: a repo cap still applies", async () => {
  // The effective level is already under the cap; the fast lane may not lift it past the cap.
  expect(gateLevel(3, true, 3, "me")).toBe(3);
  expect(gateLevel(2, true, 4, "me")).toBe(4);
  expect(riskWaits(gateLevel(2, true, 4, "me"), "medium")).toBe(true);
  // An intent that isn't the owner's never reaches a5 either (AUT-13).
  expect(gateLevel(2, true, 5, "jira")).toBe(4);
  // Through the pipeline's own path: a capped repo.
  const w = await world("u: 3\ni: 3\na: 5\n");
  await w.mark(true, "page");
  expect(await levelOf(w, 3)).toBe(3);
});

test("fast: an a0 intent stays with the owner", async () => {
  expect(gateLevel(0, true, 5, "me")).toBe(0);
  const w = await world("u: 3\ni: 3\na: 0\n");
  // Only the page decides an a0 intent: the command line and Telegram are refused and write nothing.
  const before = w.head();
  await expect(w.mark(true, "cli")).rejects.toThrow(`fast: ${ID} is a0, only you decide it on the page`);
  await expect(w.mark(true, "telegram")).rejects.toThrow("is a0, only you decide it on the page");
  expect(w.head()).toBe(before);
  await w.mark(true, "page");
  expect(w.text()).toContain("fast: true\n");
  // Even confirmed, the gates stay at a0.
  expect(await levelOf(w)).toBe(0);
});

test("fast: a mark from the command line waits for confirmation to skip approvals", async () => {
  const w = await world();
  const before = w.head();
  expect(await w.mark(true, "cli")).toContain("approvals wait for your confirmation on the page");
  // One commit; the file gains only the `fast: true` line.
  expect(w.head()).not.toBe(before);
  expect(w.text()).toBe(file("u: 3\ni: 3\na: 2\nfast: true\n"));
  expect(fastConfirmed(w.db, ID)).toBe(false);
  expect(fastFromCli(w.db, ID)).toBe(true);
  expect(await levelOf(w)).toBe(2);
  // The watch does not credit the command line's commit to the owner's account, even if GitHub calls it theirs.
  w.forge.commitAccounts.set(w.head(), ["owner", "owner"]);
  await w.watch();
  expect(fastConfirmed(w.db, ID)).toBe(false);
  expect(await levelOf(w)).toBe(2);
  // The owner's click on the page confirms it, and the approvals pass as at a5.
  expect(await w.actions().fast!(ID, true, "owner")).toContain("you confirmed it");
  expect(fastConfirmed(w.db, ID)).toBe(true);
  expect(await levelOf(w)).toBe(5);
  // Taking the mark off from any channel clears the confirmation, and putting it back needs a new click.
  await w.mark(false, "cli");
  expect(w.text()).toBe(file("u: 3\ni: 3\na: 2\n"));
  expect(fastConfirmed(w.db, ID)).toBe(false);
  await w.mark(true, "cli");
  expect(await levelOf(w)).toBe(2);
});

test("fast: a mark from the command line on an a4 intent still waits for confirmation", async () => {
  const w = await world("u: 3\ni: 3\na: 4\n");
  await w.mark(true, "cli");
  // No exception for a4: the gates still decide at a4, where medium risk waits for the owner.
  const level = await levelOf(w);
  expect(level).toBe(4);
  expect(gate({ a: level, ...green, risk: "medium" }).merge).toBe(false);
  await w.actions().fast!(ID, true, "owner");
  expect(gate({ a: await levelOf(w), ...green, risk: "medium" }).merge).toBe(true);
});

test("fast: a mark from the page skips approvals at once", async () => {
  const w = await world();
  // The shadow and any actor but the owner are refused, and nothing is written.
  const before = w.head();
  await expect(w.actions("shadow").fast!(ID, true, "")).rejects.toThrow("only you can change the fast lane");
  await expect(w.actions().fast!(ID, true, "agent")).rejects.toThrow("only you can change the fast lane");
  expect(w.head()).toBe(before);
  expect(await w.actions().fast!(ID, true, "owner")).toBe(`${ID} is in the fast lane.`);
  expect(w.text()).toBe(file("u: 3\ni: 3\na: 2\nfast: true\n"));
  expect(fastConfirmed(w.db, ID)).toBe(true);
  expect(await levelOf(w)).toBe(5);
  // Marking again writes nothing.
  const done = w.head();
  await w.actions().fast!(ID, true, "owner");
  expect(w.head()).toBe(done);
  // The page's own commit is the owner's: the watch asks GitHub nothing.
  await w.watch();
  expect(w.forge.calls.filter((c) => c.startsWith("commit "))).toEqual([]);
});

test("fast: a mark from the owner's telegram chat skips approvals at once", async () => {
  const rig = new ChatRig();
  const w = await world("u: 3\ni: 3\na: 2\n", rig.db);
  (rig.chat as unknown as { d: { actions: UiActions } }).d.actions = w.actions();
  rig.say(`/fast ${ID}`);
  await rig.run();
  expect(rig.sent().map((s) => s.text)).toEqual([`${ID} is in the fast lane.`]);
  expect(w.text()).toContain("fast: true\n");
  expect(fastConfirmed(w.db, ID)).toBe(true);
  expect(await levelOf(w)).toBe(5);
  rig.say(`/fast ${ID} off`);
  await rig.run();
  expect(w.text()).not.toContain("fast:");
  expect(fastConfirmed(w.db, ID)).toBe(false);
});

test("fast: a mark from another telegram chat is ignored", async () => {
  const rig = new ChatRig();
  const w = await world("u: 3\ni: 3\na: 2\n", rig.db);
  (rig.chat as unknown as { d: { actions: UiActions } }).d.actions = w.actions();
  const before = w.head();
  rig.say(`/fast ${ID}`, { chat: "99" });
  await rig.run();
  expect(rig.sent()).toEqual([]);
  expect(w.head()).toBe(before);
  expect(fastConfirmed(w.db, ID)).toBe(false);
  expect(await levelOf(w)).toBe(2);
});

test("fast: a mark pushed by the owner on github skips approvals at once", async () => {
  const w = await world();
  w.push(file("u: 3\ni: 3\na: 2\nfast: true\n"), ["owner", null]);
  await w.watch();
  expect(fastConfirmed(w.db, ID)).toBe(true);
  expect(await levelOf(w)).toBe(5);
  // The owner taking the mark off by hand clears the confirmation too.
  w.push(file("u: 3\ni: 3\na: 2\n"), ["owner", null]);
  await w.watch();
  expect(fastConfirmed(w.db, ID)).toBe(false);
});

test("fast: a mark pushed by another account stays unconfirmed", async () => {
  const w = await world();
  pushFiles(w.remote, { [FILE]: file("u: 3\ni: 3\na: 2\nfast: true\n") }, "edit fast");
  w.forge.commitAccounts.set(w.head(), ["mallory", "mallory"]);
  await w.watch();
  expect(fastConfirmed(w.db, ID)).toBe(false);
  expect(await levelOf(w)).toBe(2);
  // Noted once on the timeline, and GitHub is asked once per commit.
  await w.watch();
  const notes = w.db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'ignored:%:fast:%'");
  expect(notes).toHaveLength(1);
  expect(w.forge.calls.filter((c) => c.startsWith("commit "))).toHaveLength(1);
  // An unsigned commit that only names the owner doesn't count either.
  pushFiles(w.remote, { [FILE]: file("u: 3\ni: 3\na: 2\nfast: true\nsource: me\n") }, "edit again");
  w.forge.commitProofs.set(w.head(), { author: "owner", committer: "owner", verified: false });
  await w.watch();
  expect(fastConfirmed(w.db, ID)).toBe(false);
  // The owner's click on the page confirms it.
  await w.actions().fast!(ID, true, "owner");
  expect(await levelOf(w)).toBe(5);
});

test("fast: a mark made while the watch runs keeps its confirmation", async () => {
  const w = await world();
  // The watch read the intents before the page marked the intent.
  const stale = await w.store.list();
  await w.actions().fast!(ID, true, "owner");
  await watchFast({ db: w.db, store: w.store, forge: w.forge, now: NOW, log: () => {} }, stale);
  expect(fastConfirmed(w.db, ID)).toBe(true);
  expect(await levelOf(w)).toBe(5);
});
