// Autonomy with people and roles (AUT-22..25): who clears a gate, who may reach a5, who may raise, and a0.

import { expect, test } from "vitest";
import { runAs } from "../src/actor.ts";
import { effectiveA } from "../src/autonomy.ts";
import { judgeAccount, setFlag, verifiedLogin } from "../src/autonomy-change.ts";
import { Db } from "../src/db.ts";
import type { GitHub } from "../src/handlers.ts";
import {
  authorityOf,
  confirmIntent,
  mayFull,
  mayStart,
  peopleOf,
  recordWriter,
} from "../src/intent-people.ts";
import { decide, type PickState } from "../src/pick.ts";
import { createActions } from "../src/ui/actions.ts";
import { addUser, changeUser, getUser } from "../src/users-store.ts";
import { IDS, MemStore } from "../ui/fixture.ts";
import { serveAuth } from "./helpers/auth-server.ts";
import { TestClock, testConfig } from "./helpers/world.ts";
import { at, listing } from "./intents/fixtures.ts";

const AUTH = { client_id: "id", client_secret_env: "X", public_url: "https://tc.example" };
const person = (login: string) => ({ login, name: login, role: "maintainer" as const, via: "page" as const });

function people() {
  const db = Db.memory();
  const add = (login: string, role: "viewer" | "contributor" | "maintainer" | "admin", repoRoles = {}) =>
    addUser(db, { login, name: login, role, repoRoles, by: "owner" }, 0);
  add("root", "admin");
  add("mia", "maintainer");
  add("max", "maintainer");
  add("con", "contributor");
  add("vic", "viewer");
  return { db, add };
}

function gateWorld() {
  const db = Db.memory();
  const owner: string[][] = [];
  const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
  const github: Pick<GitHub, "owner" | "gh"> = {
    owner: async (args) => {
      owner.push(args);
      return args[1] === "view" ? { ...ok, stdout: JSON.stringify({ state: "OPEN", mergedAt: null }) } : ok;
    },
    gh: async () => ok,
  };
  const actions = createActions({
    db,
    store: new MemStore(),
    config: testConfig({ auth: AUTH }),
    clock: new TestClock(),
    github,
  });
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, plan_pr, pr, created, updated)
     VALUES ('a-code', 'web', 1, 'approval:merge', 'review and merge PR', 'opus', 's', 'w', 'b', 31, 57, 0, 0)`,
  );
  return { actions, owner };
}

test("autonomy: any maintainer of the repo can decide a gate", async () => {
  for (const who of ["mia", "max", "root"]) {
    const w = gateWorld();
    await runAs(person(who), () => w.actions.merge("a-code"));
    expect(
      w.owner.filter((a) => a[1] === "merge"),
      who,
    ).toHaveLength(1);
  }
});

test("autonomy: a second decision on a handled gate changes nothing", async () => {
  const w = gateWorld();
  await runAs(person("mia"), () => w.actions.merge("a-code"));
  await runAs(person("max"), () => w.actions.merge("a-code"));
  expect(w.owner.filter((a) => a[1] === "merge")).toHaveLength(1);
});

test("autonomy: a contributor cannot clear a gate", async () => {
  const w = await serveAuth();
  const r = await w.post("/api/actions", { action: "merge", intent: IDS.ci }, "con");
  expect(r.status).toBe(403);
  expect(r.body).toContain("your role (contributor) can't merge");
  expect(w.f.calls).toEqual([]);
});

test("autonomy: a5 needs an admin or maintainer author or confirmer", () => {
  // Without people the file's `source` decides (AUT-13); with them the role does, whatever the file says.
  expect(effectiveA(5, 5, "me")).toBe(5);
  expect(effectiveA(5, 5, "me", -1)).toBe(4);
  expect(effectiveA(5, 5, "me", 0)).toBe(4);
  expect(effectiveA(5, 5, "me", 1)).toBe(4);
  expect(effectiveA(5, 5, "other", 2)).toBe(5);
  expect(effectiveA(5, 5, null, 3)).toBe(5);
  expect(mayFull(2) && mayFull(3) && !mayFull(1)).toBe(true);
});

test("autonomy: a contributor's intent is at most a4", () => {
  const { db } = people();
  recordWriter(db, "i1", "con", 1);
  const authority = authorityOf(db, "i1", "web");
  expect(mayStart(authority)).toBe(true);
  expect(effectiveA(5, 5, "me", authority)).toBe(4);
});

test("autonomy: a confirmation by a maintainer lifts it to a5", () => {
  const { db } = people();
  recordWriter(db, "i1", "con", 1);
  expect(confirmIntent(db, "i1", "mia", 2)).toBe(true);
  expect(effectiveA(5, 5, "me", authorityOf(db, "i1", "web"))).toBe(5);
  // The first confirmation stands.
  expect(confirmIntent(db, "i1", "max", 3)).toBe(false);
  expect(peopleOf(db, "i1")).toMatchObject({ writer: "con", confirmedBy: "mia", confirmedAt: 2 });
});

test("autonomy: a5 follows the role at the gate", () => {
  const { db } = people();
  recordWriter(db, "i1", "mia", 1);
  expect(effectiveA(5, 5, "me", authorityOf(db, "i1", "web"))).toBe(5);
  changeUser(db, "mia", { role: "viewer", by: "root" }, 2);
  expect(effectiveA(5, 5, "me", authorityOf(db, "i1", "web"))).toBe(4);
  // A repo role counts only on that repo.
  changeUser(db, "mia", { role: "viewer", repoRoles: { api: "maintainer" }, by: "root" }, 3);
  expect(authorityOf(db, "i1", "api")).toBe(2);
  expect(authorityOf(db, "i1", "web")).toBe(0);
});

test("autonomy: the writer is the verified account that pushed the file", () => {
  const { db } = people();
  const signed = { author: "Mia", committer: "mia", verified: true };
  expect(verifiedLogin(signed)).toBe("mia");
  expect(verifiedLogin({ author: "Mia", committer: "web-flow", verified: true })).toBe("mia");
  recordWriter(db, "i1", verifiedLogin(signed), 1);
  // A later edit by another account never changes the writer.
  recordWriter(db, "i1", "max", 2);
  expect(peopleOf(db, "i1")?.writer).toBe("mia");
});

test("autonomy: a source line in the file does not make a writer", () => {
  const { db } = people();
  // An unverified push, whatever its local name or the file's `source: me`, has no writer.
  expect(verifiedLogin({ author: "mia", committer: "mia", verified: false })).toBeNull();
  expect(verifiedLogin(null)).toBeNull();
  recordWriter(db, "i1", verifiedLogin({ author: "mia", committer: "mia", verified: false }), 1);
  expect(peopleOf(db, "i1")?.writer).toBeNull();
  expect(effectiveA(5, 5, "me", authorityOf(db, "i1", "web"))).toBe(4);
});

const held = (ids: string[]): PickState => ({
  cutoff: 7,
  paused: false,
  blocked: null,
  repos: new Set(["web"]),
  full: new Map(),
  cooling: new Map(),
  active: new Set(),
  defaultModel: "opus",
  unconfirmed: new Set(ids),
});

test("autonomy: an unmapped account's intent waits for confirmation and nothing runs", () => {
  const { db } = people();
  recordWriter(db, "261001-0900", "stranger", 1);
  expect(mayStart(authorityOf(db, "261001-0900", "web"))).toBe(false);
  const l = listing([at("intents/261001-0900-x", "", "web", "X")]);
  const d = decide(l, held(["261001-0900"]));
  expect(d.pick).toBeNull();
  expect(d.skipped).toEqual([{ id: "261001-0900", reason: "waiting for a maintainer to confirm it" }]);
  // Once a maintainer confirms it, it is not held.
  confirmIntent(db, "261001-0900", "mia", 2);
  expect(mayStart(authorityOf(db, "261001-0900", "web"))).toBe(true);
  expect(decide(l, held([])).pick?.id).toBe("261001-0900");
});

test("autonomy: a viewer's intent waits for confirmation", () => {
  const { db } = people();
  recordWriter(db, "i1", "vic", 1);
  expect(mayStart(authorityOf(db, "i1", "web"))).toBe(false);
  confirmIntent(db, "i1", "mia", 2);
  expect(mayStart(authorityOf(db, "i1", "web"))).toBe(true);
  // A disabled writer counts as no one.
  const other = people();
  recordWriter(other.db, "i2", "mia", 1);
  other.db.run("UPDATE users SET disabled_at = 5 WHERE login = 'mia'");
  expect(authorityOf(other.db, "i2", "web")).toBe(-1);
});

test("autonomy: a telegram intent has the linked person as writer", () => {
  const { db } = people();
  // The writer of an intent made through a channel is the person whose chat sent it (USR-11).
  recordWriter(db, "i1", getUser(db, "con")!.login, 1);
  expect(peopleOf(db, "i1")?.writer).toBe("con");
  expect(authorityOf(db, "i1", "web")).toBe(1);
});

test("autonomy: a cli intent has the owner as writer", () => {
  const { db } = people();
  recordWriter(db, "i1", "root", 1);
  expect(authorityOf(db, "i1", "web")).toBe(3);
  expect(effectiveA(5, 5, "other", authorityOf(db, "i1", "web"))).toBe(5);
});

test("autonomy: intents from before auth count as the owner's", () => {
  const { db } = people();
  // The loop records the owner as writer of every intent it finds when `[auth]` is first seen.
  for (const id of ["i1", "i2"]) recordWriter(db, id, "root", 1);
  expect(["i1", "i2"].map((id) => authorityOf(db, id, "web"))).toEqual([3, 3]);
});

test("autonomy: a maintainer's raise counts", () => {
  const { db } = people();
  const users = (l: string) => getUser(db, l);
  const v = judgeAccount({ author: "mia", committer: "mia", verified: true }, users, "raise", "web");
  expect(v).toMatchObject({ owner: true, who: "mia" });
  const web = judgeAccount({ author: "mia", committer: "web-flow", verified: true }, users, "raise", "web");
  expect(web.owner).toBe(true);
});

test("autonomy: a contributor's raise is flagged", () => {
  const { db } = people();
  const users = (l: string) => getUser(db, l);
  const v = judgeAccount({ author: "con", committer: "con", verified: true }, users, "raise", "web");
  expect(v).toMatchObject({ owner: false, who: "con (role too low)" });
  const unsigned = judgeAccount({ author: "mia", committer: "mia", verified: false }, users, "raise", "web");
  expect(unsigned).toMatchObject({ owner: false, who: "mia" });
  setFlag(db, "i1", { who: v.who, from: 3, to: 5, commit: "c", at: 1 });
});

test("autonomy: a push is judged by the user's role", () => {
  const { db } = people();
  addUser(db, { login: "rae", role: "viewer", repoRoles: { api: "maintainer" }, by: "root" }, 0);
  const users = (l: string) => getUser(db, l);
  const proof = { author: "rae", committer: "rae", verified: true };
  expect(judgeAccount(proof, users, "raise", "api").owner).toBe(true);
  expect(judgeAccount(proof, users, "raise", "web").owner).toBe(false);
  expect(judgeAccount({ ...proof, committer: "ghost", author: "ghost" }, users, "raise", "web").owner).toBe(
    false,
  );
});

test("autonomy: a maintainer cannot decide an a0 intent", async () => {
  const w = await serveAuth();
  setFlag(w.f.sources.db, IDS.ci, { who: "x", from: 0, to: 5, commit: "c", at: 1 });
  const r = await w.post("/api/actions", { action: "reply", intent: IDS.ci, text: "ok" }, "ana");
  expect(r.status).toBe(403);
  expect(r.body).toContain("only an admin can decide an a0 intent");
});

test("autonomy: an admin decides an a0 intent", async () => {
  const w = await serveAuth();
  setFlag(w.f.sources.db, IDS.ci, { who: "x", from: 0, to: 5, commit: "c", at: 1 });
  const r = await w.post("/api/actions", { action: "reply", intent: IDS.ci, text: "ok" }, "owner");
  expect(r.status).not.toBe(403);
});
