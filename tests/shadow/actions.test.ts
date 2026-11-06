// What the shadow may do (SHD-6..10, SHD-12..14, SHD-19).

import { join } from "node:path";
import { expect, test } from "vitest";
import { effectiveA } from "../../src/autonomy.ts";
import { openStore } from "../../src/intents/store.ts";
import { pendingActions } from "../../src/shadow/store.ts";
import { createActions } from "../../src/ui/actions.ts";
import { MemStore } from "../../ui/fixture.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, tempDir } from "../helpers/world.ts";
import { Rig } from "./rig.ts";

const req = (
  action: string,
  intent = "i-1",
  extra: Partial<Record<"repo" | "title" | "text", string>> = {},
) => ({
  action,
  intent,
  repo: "",
  title: "",
  text: "",
  ...extra,
});
const rows = (r: Rig) =>
  r.db.all<{ action: string; outcome: string; detail: string }>(
    "SELECT action, outcome, detail FROM shadow_actions ORDER BY id",
  );

async function realStore() {
  const remote = bareRepo({ "intents/.keep": "" });
  const store = await openStore({
    remote,
    path: join(tempDir(), "intents"),
    tools: new FakeTools(),
    log: () => {},
    now: () => new Date(2026, 10, 6, 9, 0, 0),
  });
  return { remote, store };
}

test("shadow: an unknown action is refused", async () => {
  const r = new Rig();
  const line = await r.exec().request(1, 0, req("rm-rf"));
  expect(line).toContain("isn't something I'm allowed to do");
  expect(rows(r)).toEqual([{ action: "rm-rf", outcome: "refused", detail: "not an action the shadow has" }]);
  expect(r.calls).toEqual([]);
});

test("shadow: reads and drafts need no approval", async () => {
  const r = new Rig();
  const line = await r
    .exec()
    .request(1, 0, req("draft", "", { repo: "web", title: "Dark mode", text: "## Problem\nBright." }));
  expect(line).toContain("Drafted n-1");
  expect(pendingActions(r.db)).toEqual([]);
  expect(r.store.added[0]).toMatchObject({
    repo: "web",
    source: "shadow",
    by: "shadow",
    mark: "Shadow: true",
  });
});

test("shadow: reply and start run without approval", async () => {
  const r = new Rig();
  const exec = r.exec();
  await exec.request(1, 0, req("reply", "i-1", { text: "Use option B." }));
  await exec.request(1, 1, req("start", "i-1"));
  expect(r.calls).toEqual(["reply i-1 Use option B.", "start i-1"]);
  expect(rows(r).map((x) => x.outcome)).toEqual(["done", "done"]);
});

test("shadow: merge boost and drop wait for a yes", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  const exec = r.exec();
  const lines = [
    await exec.request(1, 0, req("merge")),
    await exec.request(1, 1, req("boost")),
    await exec.request(1, 2, req("drop")),
  ];
  expect(lines).toEqual([
    "Merge i-1? Reply yes or no.",
    "Boost i-1? Reply yes or no.",
    "Drop i-1? Reply yes or no.",
  ]);
  expect(r.calls).toEqual([]);
  expect(r.store.updated).toEqual([]);
  expect(rows(r).map((x) => x.outcome)).toEqual(["held", "held", "held"]);
});

test("shadow: free actions skip the question", async () => {
  const r = new Rig({ free: ["merge", "boost", "drop"] });
  r.mission("i-1", "approval:merge", "review and merge PR");
  const exec = r.exec();
  await exec.request(1, 0, req("merge"));
  await exec.request(1, 1, req("boost"));
  await exec.request(1, 2, req("drop"));
  expect(r.calls).toEqual(["merge i-1", "drop i-1"]);
  expect(r.store.updated).toMatchObject([
    { id: "i-1", what: "[shadow] boost", mark: "Shadow: true", fields: { u: 4, i: 5 } },
  ]);
  expect(pendingActions(r.db)).toEqual([]);
});

test("shadow: merge is refused where autonomy needs the owner", async () => {
  const r = new Rig({ free: ["merge"] });
  // A question, red checks and a teammate wait are not merges the shadow may clear.
  r.mission("i-1", "blocked", "answer the question");
  const exec = r.exec();
  const line = await exec.request(1, 0, req("merge"));
  expect(line).toContain("isn't waiting on a merge that is yours to make");
  expect(r.calls).toEqual([]);
  expect(pendingActions(r.db)).toEqual([]);
  expect(rows(r)[0]).toMatchObject({ action: "merge", outcome: "refused" });
});

test("shadow: a held action waits for the chat", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  const exec = r.exec();
  await exec.request(1, 0, req("merge"));
  const again = await exec.request(2, 0, req("merge"));
  expect(again).toBe("Still waiting for your yes: Merge i-1? Reply yes or no.");
  expect(pendingActions(r.db)).toHaveLength(1);
  expect(r.calls).toEqual([]);
});

test("shadow: yes runs it once", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  const exec = r.exec();
  await exec.request(1, 0, req("merge"));
  expect(await exec.answer(true)).toBe("merge done");
  expect(await exec.answer(true)).toBe("There is nothing waiting for your yes.");
  expect(r.calls).toEqual(["merge i-1"]);
  expect(rows(r)).toEqual([{ action: "merge", outcome: "done", detail: "merge done" }]);
});

test("shadow: no cancels it", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  const exec = r.exec();
  await exec.request(1, 0, req("drop"));
  expect(await exec.answer(false)).toBe("Okay, I won't drop i-1.");
  expect(r.calls).toEqual([]);
  expect(rows(r)).toEqual([{ action: "drop", outcome: "refused", detail: "you said no" }]);
});

test("shadow: a pending action survives a restart", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  await r.exec().request(1, 0, req("merge"));
  // A new process, the same database.
  expect(await r.exec().answer(true)).toBe("merge done");
  expect(r.calls).toEqual(["merge i-1"]);
});

test("shadow: a pending action expires after a day", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  const exec = r.exec();
  await exec.request(1, 0, req("merge"));
  r.clock.advance(86_399);
  expect(exec.expire()).toEqual([]);
  r.clock.advance(2);
  expect(exec.expire()).toEqual(["I dropped “merge i-1”: you didn't answer within 24 hours."]);
  expect(pendingActions(r.db)).toEqual([]);
  expect(rows(r)[0]).toMatchObject({ outcome: "refused", detail: "no answer in 24 hours" });
});

test("shadow: comments commits and replies carry the tag", async () => {
  // The reply on a PR starts with the tag.
  const db = new Rig().db;
  const gh: string[][] = [];
  const ui = createActions({
    db,
    store: new MemStore(),
    config: new Rig().config,
    clock: new Rig().clock,
    github: {
      owner: async (args) => {
        gh.push(args);
        return { code: 0, stdout: "{}", stderr: "", timedOut: false };
      },
    },
    actor: "shadow",
  });
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, pr, created, updated)
     VALUES ('i-1', 'web', 1, 'blocked', 'CI red', 'opus', 's', 'w', 'b', 58, 0, 0)`,
  );
  await ui.reply("i-1", "Skip the flaky test.");
  expect(gh.flat().filter((a) => a.includes("Skip the flaky test."))).toEqual([
    "[shadow] Skip the flaky test.",
  ]);
  // The commit that adds a draft says so, and the Telegram reply too (session tests).
  const { remote, store } = await realStore();
  await store.add(
    { repo: "web", title: "Try it", source: "shadow", by: "shadow", mark: "Shadow: true" },
    new Date(2026, 10, 6, 9, 0, 0),
  );
  const log = git(remote, "log", "-1", "--format=%B", "main");
  expect(log).toMatch(/^towercab: \[shadow\] add /);
  expect(log).toContain("Shadow: true");
});

async function draft() {
  const r = new Rig();
  const { remote, store } = await realStore();
  const exec = r.exec(store);
  const line = await exec.request(
    1,
    0,
    req("draft", "", { repo: "web", title: "Try dark mode", text: "## Problem\nBright." }),
  );
  const path = git(remote, "ls-tree", "-r", "--name-only", "main")
    .split("\n")
    .find((p) => p.endsWith("intent.md"))!;
  return { r, exec, remote, line, path, file: () => git(remote, "show", `main:${path}`) };
}

test("shadow: a drafted intent has source shadow", async () => {
  const d = await draft();
  expect(d.line).toMatch(/^Drafted \d{6}-\d{4}: Try dark mode\./);
  expect(d.file()).toContain("source: shadow\n");
});

test("shadow: a drafted intent is capped at a4", async () => {
  const d = await draft();
  const a = Number(/^a: (\d)$/m.exec(d.file())?.[1]);
  expect(a).toBeLessThanOrEqual(4);
  // Whatever it says, autonomy 5 cannot be reached by a source that isn't the owner's (AUT-13).
  expect(effectiveA(5, 5, 5, "shadow")).toBe(4);
});

test("shadow: confirming a draft sets source me", async () => {
  const d = await draft();
  const id = /^Drafted (\S+):/.exec(d.line)![1]!;
  expect(await d.exec.request(2, 0, req("confirm", id))).toBe(`Make the draft ${id} yours? Reply yes or no.`);
  expect(d.file()).toContain("source: shadow\n");
  expect(await d.exec.answer(true)).toBe(`${id} is yours now.`);
  expect(d.file()).toContain("source: me\n");
  expect(git(d.remote, "log", "-1", "--format=%s", "main")).toContain("[shadow] confirm");
});

test("shadow: confirm always asks", async () => {
  const r = new Rig({ free: ["merge", "boost", "drop"] });
  const line = await r.exec().request(1, 0, req("confirm", "d-1"));
  expect(line).toBe("Make the draft d-1 yours? Reply yes or no.");
  expect(r.store.updated).toEqual([]);
  // Only a draft of the shadow's can be confirmed.
  expect(await r.exec().request(1, 1, req("confirm", "i-1"))).toContain("it isn't a draft of mine");
});

test("shadow: an action is recorded before it runs", async () => {
  const r = new Rig();
  let during: string[] = [];
  r.onAction = () => {
    during = rows(r).map((x) => `${x.action}:${x.outcome}`);
  };
  await r.exec().request(1, 0, req("start"));
  expect(during).toEqual(["start:started"]);
  expect(rows(r)[0]!.outcome).toBe("done");
});

test("shadow: refused and held actions are recorded", async () => {
  const r = new Rig();
  r.mission("i-1", "approval:merge", "review and merge PR");
  const exec = r.exec();
  await exec.request(1, 0, req("merge"));
  await exec.request(1, 1, req("start", "nope"));
  expect(rows(r).map((x) => `${x.action}:${x.outcome}`)).toEqual(["merge:held", "start:refused"]);
});
