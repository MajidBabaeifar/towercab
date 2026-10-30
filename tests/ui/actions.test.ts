// UI-66: the page's buttons act on GitHub as the owner, or through commands when there is no PR.

import { expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import type { GitHub } from "../../src/handlers.ts";
import type { Stage } from "../../src/machine.ts";
import type { RunResult } from "../../src/tools.ts";
import { createActions } from "../../src/ui/actions.ts";
import { MemStore } from "../../ui/fixture.ts";
import { TestClock, testConfig } from "../helpers/world.ts";

function world(
  owner: (args: string[]) => RunResult = () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
) {
  const db = Db.memory();
  const calls: string[][] = [];
  const github: Pick<GitHub, "owner"> = {
    owner: async (args) => {
      calls.push(args);
      return owner(args);
    },
  };
  const clock = new TestClock();
  const actions = createActions({ db, store: new MemStore(), config: testConfig(), clock, github });
  const add = (
    intent: string,
    stage: Stage,
    p: { from?: Stage; spec?: number; plan?: number; pr?: number; waiting?: string } = {},
  ) =>
    db.run(
      `INSERT INTO missions (intent, repo, attempt, stage, from_stage, waiting, model, session, checkout, branch,
         spec_pr, plan_pr, pr, created, updated) VALUES (?, 'web', 1, ?, ?, ?, 'opus', 's', 'w', 'b', ?, ?, ?, 0, 0)`,
      intent,
      stage,
      p.from ?? null,
      p.waiting ?? null,
      p.spec ?? null,
      p.plan ?? null,
      p.pr ?? null,
    );
  const commands = () =>
    db.all<{ name: string; arg: string; text: string; source: string }>(
      "SELECT name, arg, text, source FROM commands ORDER BY id",
    );
  return { db, calls, actions, add, commands, clock };
}

test("ui: actions go through GitHub as the owner", async () => {
  const w = world();
  w.add("a-spec", "approval:spec", { spec: 11, waiting: "approve spec" });
  w.add("a-plan", "approval:plan", { spec: 11, plan: 31, waiting: "approve plan" });
  w.add("a-code", "approval:merge", { plan: 31, pr: 57, waiting: "review and merge PR" });
  w.add("a-ask", "blocked", { from: "ci", pr: 58, waiting: "CI red" });
  expect(await w.actions.merge("a-spec")).toBe(
    "Merged the spec PR #11 as you. Towercab moves on within a minute.",
  );
  expect(await w.actions.merge("a-plan")).toBe(
    "Merged the plan PR #31 as you. Towercab moves on within a minute.",
  );
  expect(await w.actions.merge("a-code")).toBe(
    "Merged the code PR #57 as you. Towercab moves on within a minute.",
  );
  expect(await w.actions.reply("a-ask", "  The flaky test is known; skip it.  ")).toBe(
    "Replied on the code PR #58. Towercab picks it up within a minute.",
  );
  expect(await w.actions.retry("a-ask")).toMatch(/^Asked for a fresh start on the code PR #58/);
  expect(await w.actions.drop("a-code")).toBe("Closed the code PR #57; the intent is dropped.");
  expect(w.calls).toEqual([
    ["pr", "merge", "11", "--squash", "-R", "owner/web"],
    ["pr", "merge", "31", "--squash", "-R", "acme/intents"],
    ["pr", "merge", "57", "--squash", "-R", "owner/web"],
    ["pr", "comment", "58", "-R", "owner/web", "--body", "The flaky test is known; skip it."],
    ["pr", "comment", "58", "-R", "owner/web", "--body", "/retry"],
    ["pr", "close", "57", "-R", "owner/web"],
  ]);
  expect(w.commands()).toEqual([]);
  // Merge only what waits for a merge.
  await expect(w.actions.merge("a-ask")).rejects.toThrow(
    "Nothing to merge: this intent isn't waiting for a merge.",
  );
  await expect(w.actions.merge("nobody")).rejects.toThrow(/Nothing to merge/);
  // GitHub's refusal comes back as the reason.
  const r = world(() => ({
    code: 1,
    stdout: "",
    stderr: "\nX Pull request is not mergeable: the base branch policy prohibits the merge.\n",
    timedOut: false,
  }));
  r.add("a-code", "approval:merge", { pr: 57, waiting: "review and merge PR" });
  await expect(r.actions.merge("a-code")).rejects.toThrow(
    "GitHub refused to merge the code PR #57: X Pull request is not mergeable: the base branch policy prohibits the merge.",
  );
});

test("ui: actions without a PR use commands", async () => {
  const w = world();
  w.add("q", "blocked", { from: "build", plan: 3, waiting: "answer the question" });
  expect(await w.actions.reply("q", "Use EUR.")).toBe(
    "Answer saved to the intent. Towercab goes on with it on its next pass.",
  );
  expect(await w.actions.retry("q")).toBe("Towercab starts it over on its next pass.");
  expect(await w.actions.drop("no-mission")).toBe("Towercab drops it on its next pass.");
  expect(await w.actions.pause()).toBe("Paused: nothing new starts until you resume.");
  expect(await w.actions.resume()).toBe("Resumed: Towercab picks up work again.");
  await expect(w.actions.reply("q", "   ")).rejects.toThrow("Write a reply first.");
  expect(w.commands()).toEqual([
    { name: "answer", arg: "q", text: "Use EUR.", source: "ui" },
    { name: "retry", arg: "q", text: "", source: "ui" },
    { name: "drop", arg: "no-mission", text: "", source: "ui" },
    { name: "pause", arg: "", text: "", source: "ui" },
    { name: "resume", arg: "", text: "", source: "ui" },
  ]);
  expect(w.calls).toEqual([]);
  const created = w.db.all<{ created: number }>("SELECT created FROM commands");
  expect(created.every((c) => c.created === w.clock.now())).toBe(true);
});

test("ui: start action uses the start command", async () => {
  const w = world();
  w.add("busy", "design");
  expect(await w.actions.start("new")).toBe(
    "Starting its design on the next pass, even if the repo is full.",
  );
  await expect(w.actions.start("busy")).rejects.toThrow("It has already started.");
  expect(w.commands()).toEqual([{ name: "start", arg: "new", text: "", source: "ui" }]);
  expect(w.calls).toEqual([]);
});

test("ui: add repo action adds the repo and says so", async () => {
  const db = Db.memory();
  const config = testConfig();
  const github = { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) };
  const added: [string, string | undefined][] = [];
  const actions = createActions({
    db,
    store: new MemStore(),
    config,
    clock: new TestClock(),
    github,
    addRepo: async (gh, name) => {
      added.push([gh, name]);
      if (gh === "acme/secret") {
        throw new Error("Towercab can't reach acme/secret: the GitHub App isn't installed on acme/secret");
      }
      return { name: name ?? "shop", github: gh, path: "", base: "trunk", workers: 1, ahead: 3, env: {} };
    },
  });
  expect(await actions.addRepo("acme/crm", "crm")).toBe(
    "Added crm (acme/crm, base trunk). Its intents can start on the next pass.",
  );
  expect(await actions.addRepo("acme/shop")).toBe(
    "Added shop (acme/shop, base trunk). Its intents can start on the next pass.",
  );
  // The refusal is the reason, as the page shows it.
  await expect(actions.addRepo("acme/secret")).rejects.toThrow(
    "Towercab can't reach acme/secret: the GitHub App isn't installed on acme/secret",
  );
  expect(added).toEqual([
    ["acme/crm", "crm"],
    ["acme/shop", undefined],
    ["acme/secret", undefined],
  ]);
  // Without the loop's adder, it is refused.
  const ro = createActions({ db, store: new MemStore(), config, clock: new TestClock(), github });
  await expect(ro.addRepo("acme/crm")).rejects.toThrow("Towercab isn't running, so it can't add a repo now.");
});
