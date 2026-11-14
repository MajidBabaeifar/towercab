import { expect, test } from "vitest";
import { runAs } from "../src/actor.ts";
import { Db } from "../src/db.ts";
import type { GitHub } from "../src/handlers.ts";
import { createActions } from "../src/ui/actions.ts";
import { MemStore } from "../ui/fixture.ts";
import { TestClock, testConfig } from "./helpers/world.ts";

const AUTH = { client_id: "id", client_secret_env: "X", public_url: "https://tc.example" };
const ana = { login: "ana", name: "Ana Diaz", role: "maintainer" as const, via: "page" as const };

function world(auth: boolean) {
  const db = Db.memory();
  const owner: string[][] = [];
  const app: string[][] = [];
  const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
  const github: Pick<GitHub, "owner" | "gh"> = {
    owner: async (args) => {
      owner.push(args);
      return args[1] === "view" ? { ...ok, stdout: JSON.stringify({ state: "OPEN", mergedAt: null }) } : ok;
    },
    gh: async (_repo, args) => {
      app.push(args);
      return ok;
    },
  };
  const actions = createActions({
    db,
    store: new MemStore(),
    config: testConfig(auth ? { auth: AUTH } : {}),
    clock: new TestClock(),
    github,
  });
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, plan_pr, pr, created, updated)
     VALUES ('a-code', 'web', 1, 'approval:merge', 'review and merge PR', 'opus', 's', 'w', 'b', 31, 57, 0, 0)`,
  );
  return { db, actions, owner, app };
}

test("users: a pr comment names who approved", async () => {
  const w = world(true);
  await runAs(ana, () => w.actions.merge("a-code"));
  // Towercab comments as the App, with the person's name and the channel; the owner's login says nothing.
  expect(w.app).toEqual([
    ["pr", "comment", "57", "-R", "owner/web", "--body", "approved by Ana Diaz in Towercab (page)"],
  ]);
  expect(w.owner.some((a) => a[1] === "comment")).toBe(false);
  // Replying and dropping are named the same way.
  const r = world(true);
  await runAs(ana, () => r.actions.reply("a-code", "Please keep it small."));
  expect(r.owner).toContainEqual([
    "pr",
    "comment",
    "57",
    "-R",
    "owner/web",
    "--body",
    "answered by Ana Diaz in Towercab (page):\n\nPlease keep it small.",
  ]);
  const d = world(true);
  await runAs(ana, () => d.actions.drop("a-code"));
  expect(d.owner).toContainEqual([
    "pr",
    "close",
    "57",
    "-R",
    "owner/web",
    "--comment",
    "dropped by Ana Diaz in Towercab (page)",
  ]);
});

test("users: the merge records who approved", async () => {
  const w = world(true);
  await runAs(ana, () => w.actions.merge("a-code"));
  const merge = w.owner.find((a) => a[1] === "merge")!;
  expect(merge).toEqual(["pr", "merge", "57", "--squash", "--body", "Approved-by: ana", "-R", "owner/web"]);
  // Without [auth] the merge and the comments are exactly what they were.
  const n = world(false);
  await runAs(ana, () => n.actions.merge("a-code"));
  expect(n.owner.find((a) => a[1] === "merge")).toEqual(["pr", "merge", "57", "--squash", "-R", "owner/web"]);
  expect(n.app).toEqual([]);
});
