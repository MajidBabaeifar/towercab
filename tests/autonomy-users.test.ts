// AUT-22..25: with sign-in on, gates wait for a maintainer of the repo, full autonomy follows the writer's
// role, a raise needs a maintainer and a0 stays with admins.

import { expect, test } from "vitest";
import { A0_ADMIN_ONLY, effectiveAForWriter } from "../src/autonomy.ts";
import { flagOf } from "../src/autonomy-change.ts";
import { watchAutonomy } from "../src/autonomy-watch.ts";
import { Db } from "../src/db.ts";
import type { Forge } from "../src/forge.ts";
import type { IntentStore, Listing } from "../src/intents/types.ts";
import { apply } from "../src/machine.ts";
import { insertMission } from "../src/mission.ts";
import { decide, type PickState } from "../src/pick.ts";
import { gateAction } from "../src/users/api.ts";
import { People } from "../src/users/people.ts";
import { addUser, changeUser, ensureFirstAdmin } from "../src/users/store.ts";
import { confirmationOf, confirmIntent, recordWriter, SEEDED_KEY, writerOf } from "../src/users/writer.ts";
import { settleWriters, WAITS_FOR_CONFIRM } from "../src/users/writers.ts";
import type { User } from "../src/users.ts";
import { makeIntent } from "../ui/fixture.ts";
import { FakeForge } from "./helpers/fake-forge.ts";

const admin: User = { login: "owner", role: "admin", repos: {} };
const ID = "261107-0900";
const SHA = "a".repeat(40);

function world(
  opts: {
    before?: boolean;
    pushedBy?: { committer: string | null; author?: string | null; verified: boolean } | null;
  } = {},
) {
  const db = Db.memory();
  ensureFirstAdmin(db, "owner", 1);
  if (!opts.before) db.setMeta(SEEDED_KEY, "1");
  const intent = makeIntent({ id: ID, title: "Thing", repo: "web", source: "me", u: 4, i: 4, a: 5 });
  const listing = {
    open: [intent],
    done: [],
    unreadable: [],
    doneIds: new Set(),
    droppedIds: new Set(),
  } as unknown as Listing;
  const pushed =
    opts.pushedBy === undefined ? { committer: "ana", author: "ana", verified: true } : opts.pushedBy;
  const store = { github: () => "owner/intents", createdBy: async () => SHA } as Pick<
    IntentStore,
    "createdBy" | "github"
  >;
  const forge = {
    commitProof: async () => ({
      author: pushed?.author ?? null,
      committer: pushed?.committer ?? null,
      verified: pushed?.verified ?? false,
    }),
  } as Pick<Forge, "commitProof">;
  const people = new People({ db, now: () => 100, inTeam: async () => false });
  const settle = () => settleWriters({ db, store, forge, people, me: "owner", log: () => {} }, listing);
  return { db, listing, intent, settle };
}

const state = (unconfirmed: Map<string, string>): PickState => ({
  cutoff: 7,
  paused: false,
  blocked: null,
  repos: new Set(["web"]),
  full: new Map(),
  cooling: new Map(),
  active: new Set(),
  defaultModel: "opus",
  unconfirmed,
});

test("autonomy: the writer is the verified account that pushed the file", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "maintainer" }, 1);
  await w.settle();
  expect(writerOf(w.db, ID)).toEqual({ login: "ana", via: "github" });
  // A commit made on the host's web page counts for its author; an unverified push has no writer.
  const web = world({ pushedBy: { committer: "web-flow", author: "Ana", verified: true } });
  await web.settle();
  expect(writerOf(web.db, ID)).toEqual({ login: "ana", via: "github" });
  const unsigned = world({ pushedBy: { committer: "ana", author: "ana", verified: false } });
  expect((await unsigned.settle()).unconfirmed.get(ID)).toBe(WAITS_FOR_CONFIRM);
  expect(writerOf(unsigned.db, ID)).toEqual({ login: null, via: "github" });
});

test("autonomy: a source line in the file does not make a writer", async () => {
  // The file says `source: me`, but a stranger's account pushed it: it waits, whatever the line says.
  const w = world({ pushedBy: { committer: "stranger", verified: true } });
  const v = await w.settle();
  expect(writerOf(w.db, ID)?.login).toBe("stranger");
  expect(v.unconfirmed.has(ID)).toBe(true);
  expect(v.ceilings.get(ID)).toBe(4);
});

test("autonomy: an unmapped account's intent waits for confirmation and nothing runs", async () => {
  const w = world({ pushedBy: { committer: "stranger", verified: true } });
  const v = await w.settle();
  const d = decide(w.listing, state(v.unconfirmed));
  expect(d.pick).toBeNull();
  expect(d.skipped).toEqual([{ id: ID, reason: WAITS_FOR_CONFIRM }]);
  // Confirmed by a maintainer, it is picked.
  addUser(w.db, admin, "max", { role: "maintainer" }, 1);
  confirmIntent(w.db, { login: "max", role: "maintainer", repos: {} }, ID, ["web"], "page", 2);
  const after = await w.settle();
  expect(decide(w.listing, state(after.unconfirmed)).pick?.id).toBe(ID);
});

test("autonomy: a viewer's intent waits for confirmation", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "viewer" }, 1);
  const v = await w.settle();
  expect(v.unconfirmed.get(ID)).toBe(WAITS_FOR_CONFIRM);
  // A viewer on this repo only, a maintainer elsewhere: still a viewer here.
  const w2 = world();
  addUser(w2.db, admin, "ana", { role: "maintainer", repos: { web: "viewer" } }, 1);
  expect((await w2.settle()).unconfirmed.has(ID)).toBe(true);
  // Dropping it needs the same role as confirming it.
  expect(
    await gateAction({ login: "ana", role: "viewer", repos: {} }, "drop", {}, ID, async () => ({
      repo: "web",
      a: 5,
    })),
  ).toMatch(/can't drop/);
});

test("autonomy: a5 needs an admin or maintainer author or confirmer", async () => {
  for (const [role, ceiling, held] of [
    ["admin", 5, false],
    ["maintainer", 5, false],
    ["contributor", 4, false],
    ["viewer", 4, true],
  ] as const) {
    const w = world();
    addUser(w.db, admin, "ana", { role }, 1);
    const v = await w.settle();
    expect([role, v.ceilings.get(ID), v.unconfirmed.has(ID)]).toEqual([role, ceiling, held]);
  }
});

test("autonomy: a contributor's intent is at most a4", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "contributor" }, 1);
  const v = await w.settle();
  expect(effectiveAForWriter(5, 5, v.ceilings.get(ID)!)).toBe(4);
  expect(effectiveAForWriter(null, 5, v.ceilings.get(ID)!)).toBe(4);
  expect(effectiveAForWriter(2, 5, v.ceilings.get(ID)!)).toBe(2);
  expect(effectiveAForWriter(5, 3, 5)).toBe(3);
});

test("autonomy: a confirmation by a maintainer lifts it to a5", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "contributor" }, 1);
  addUser(w.db, admin, "max", { role: "maintainer" }, 1);
  expect((await w.settle()).ceilings.get(ID)).toBe(4);
  // Not a contributor, nor a maintainer of another repo.
  expect(() =>
    confirmIntent(w.db, { login: "ana", role: "contributor", repos: {} }, ID, ["web"], "page", 2),
  ).toThrow(/can't confirm on web/);
  expect(() =>
    confirmIntent(
      w.db,
      { login: "max", role: "viewer", repos: { api: "maintainer" } },
      ID,
      ["web"],
      "page",
      2,
    ),
  ).toThrow(/can't confirm/);
  confirmIntent(w.db, { login: "max", role: "maintainer", repos: {} }, ID, ["web"], "telegram", 3);
  expect(confirmationOf(w.db, ID)).toEqual({ login: "max", via: "telegram", at: 3 });
  expect((await w.settle()).ceilings.get(ID)).toBe(5);
});

test("autonomy: a5 follows the role at the gate", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "maintainer" }, 1);
  expect((await w.settle()).ceilings.get(ID)).toBe(5);
  changeUser(w.db, admin, "ana", { role: "contributor" }, 2);
  expect((await w.settle()).ceilings.get(ID)).toBe(4);
  // The writer is kept: a later change of the file's pusher never changes it.
  expect(recordWriter(w.db, ID, { login: "someone", via: "github" })).toBe(false);
  expect(writerOf(w.db, ID)?.login).toBe("ana");
});

test("autonomy: a cli intent has the owner as writer", async () => {
  const w = world({ pushedBy: null });
  // The command line records the owner when it adds the intent, before the loop looks at the commit.
  recordWriter(w.db, ID, { login: "owner", via: "cli" });
  const v = await w.settle();
  expect(v.ceilings.get(ID)).toBe(5);
  expect(v.unconfirmed.size).toBe(0);
});

test("autonomy: intents from before auth count as the owner's", async () => {
  const w = world({ pushedBy: null, before: true });
  const v = await w.settle();
  expect(writerOf(w.db, ID)).toEqual({ login: "owner", via: "before-auth" });
  expect(v.ceilings.get(ID)).toBe(5);
  // An intent added after sign-in was on is judged by its own commit, not credited to the owner.
  const later = makeIntent({ id: "261108-0900", title: "Later", repo: "web", source: "me", a: 5 });
  w.listing.open.push(later);
  const v2 = await w.settle();
  expect(writerOf(w.db, later.id)).toEqual({ login: null, via: "github" });
  expect(v2.unconfirmed.has(later.id)).toBe(true);
});

test("autonomy: any maintainer of the repo can decide a gate", async () => {
  const w = world();
  addUser(w.db, admin, "max", { role: "maintainer" }, 1);
  addUser(w.db, admin, "mia", { role: "viewer", repos: { web: "maintainer" } }, 1);
  for (const login of ["max", "mia", "owner"]) {
    const user =
      login === "owner"
        ? admin
        : ({
            login,
            role: login === "max" ? "maintainer" : "viewer",
            repos: login === "mia" ? { web: "maintainer" } : {},
          } as User);
    expect(await gateAction(user, "merge", {}, ID, async () => ({ repo: "web", a: 3 })), login).toBeNull();
    expect(await gateAction(user, "accept", {}, ID, async () => ({ repo: "web", a: 3 })), login).toBeNull();
  }
});

test("autonomy: a contributor cannot clear a gate", async () => {
  const cy: User = { login: "cy", role: "contributor", repos: {} };
  for (const action of ["merge", "reply", "retry", "drop", "start", "secret", "accept"]) {
    expect(await gateAction(cy, action, {}, ID, async () => ({ repo: "web", a: 3 })), action).toMatch(
      /^your role \(contributor\) can't /,
    );
  }
});

test("autonomy: a second decision on a handled gate changes nothing", () => {
  const db = Db.memory();
  const subject = () => ({ title: "Thing", repo: "web", link: null });
  let m = db.tx(() => insertMission(db, { intent: ID, slug: "thing", repo: "web", model: "opus", a: 3 }, 1));
  const cx = { db, now: 10, subject };
  for (let i = 0; i < 2; i++) m = apply(cx, m, { event: "ok" });
  db.run("UPDATE missions SET stage = 'approval:merge', waiting = 'review and merge PR' WHERE id = ?", m.id);
  const gate = { ...m, stage: "approval:merge" as const };
  const first = apply(cx, gate, { event: "code_merged", actor: "max", via: "page" });
  const rows = () => db.all<{ actor: string }>("SELECT actor FROM transitions WHERE actor IS NOT 'towercab'");
  expect(rows()).toEqual([{ actor: "max" }]);
  // The second maintainer decides the same gate a moment later: the mission is no longer there.
  const second = apply(cx, gate, { event: "code_merged", actor: "mia", via: "telegram" });
  expect(second.stage).toBe(first.stage);
  expect(rows()).toEqual([{ actor: "max" }]);
});

// AUT-24: a raise of `a` in the intents repo.
async function watched(committer: string, role: "maintainer" | "contributor", verified = true) {
  const db = Db.memory();
  ensureFirstAdmin(db, "owner", 1);
  addUser(db, admin, "ana", { role }, 1);
  const people = new People({ db, now: () => 100, inTeam: async () => false });
  const i = makeIntent({ id: ID, title: "Thing", repo: "web", a: 2 });
  let level = 2;
  const store = {
    github: () => "owner/intents",
    lastAChange: async () => SHA,
  } as unknown as IntentStore;
  const forge = Object.assign(new FakeForge("owner"), {
    commitProof: async () => ({ author: committer, committer, verified }),
  });
  const listing = () =>
    ({
      open: [{ ...i, a: level }],
      done: [],
      unreadable: [],
      doneIds: new Set(),
      droppedIds: new Set(),
    }) as unknown as Listing;
  const watch = () =>
    watchAutonomy(
      {
        db,
        store,
        forge,
        now: 5,
        log: () => {},
        raiser: async (login, repos) => {
          const u = await people.resolve(login);
          return (
            !!u && repos.every((r) => (u.role === "maintainer" || u.role === "admin" ? r !== "" : false))
          );
        },
      },
      listing(),
    );
  await watch();
  level = 4;
  await watch();
  return { db, flag: flagOf(db, ID) };
}

test("autonomy: a maintainer's raise counts", async () => {
  const w = await watched("ana", "maintainer");
  expect(w.flag).toBeNull();
});

test("autonomy: a contributor's raise is flagged", async () => {
  const w = await watched("ana", "contributor");
  expect(w.flag).toMatchObject({ who: "ana", from: 2, to: 4 });
});

test("autonomy: a push is judged by the user's role", async () => {
  // An unknown account, and an unverified push by a maintainer, are flagged too.
  expect((await watched("stranger", "maintainer")).flag).toMatchObject({ who: "stranger" });
  expect((await watched("ana", "maintainer", false)).flag).toMatchObject({ from: 2, to: 4 });
});

test("autonomy: a maintainer cannot decide an a0 intent", async () => {
  const max: User = { login: "max", role: "maintainer", repos: {} };
  const a0 = async () => ({ repo: "web", a: 0, a0: true });
  for (const action of ["merge", "reply", "autonomy", "drop"]) {
    expect(await gateAction(max, action, { a: 3 }, ID, a0), action).toBe(A0_ADMIN_ONLY);
  }
  // A pause stays open, as for the owner (AUT-32).
  expect(await gateAction(max, "pause", {}, ID, a0)).toBeNull();
});

test("autonomy: an admin decides an a0 intent", async () => {
  const a0 = async () => ({ repo: "web", a: 0, a0: true });
  for (const action of ["merge", "reply", "autonomy", "drop"]) {
    expect(await gateAction(admin, action, { a: 3 }, ID, a0), action).toBeNull();
  }
});
