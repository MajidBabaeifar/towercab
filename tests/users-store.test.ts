import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import {
  addUser,
  changeUser,
  createSession,
  getTeam,
  hashToken,
  openSessions,
  removeUser,
  revokeAll,
  revokeSession,
  seedOwner,
  sessionUser,
  setTeam,
  userEvents,
} from "../src/users-store.ts";

const H = 3600;
const D = 86_400;

function world() {
  const db = Db.memory();
  seedOwner(db, "owner", 0);
  addUser(db, { login: "ana", role: "maintainer", by: "owner" }, 0);
  return db;
}

test("users: a session expires when idle", () => {
  const db = world();
  const t = createSession(db, "ana", 0);
  expect(sessionUser(db, t, 11 * H)?.login).toBe("ana");
  // Used at 11 h, so it lasts until 23 h; unused for 12 h it ends.
  expect(sessionUser(db, t, 22 * H)?.login).toBe("ana");
  expect(sessionUser(db, t, 22 * H + 12 * H)).toBeNull();
});

test("users: a session expires after seven days", () => {
  const db = world();
  const t = createSession(db, "ana", 0);
  // Used every 11 hours, so idleness never ends it; only the seventh day does.
  for (let at = 11 * H; at < 7 * D - H; at += 11 * H) expect(sessionUser(db, t, at)).not.toBeNull();
  expect(sessionUser(db, t, 7 * D - 1)).not.toBeNull();
  expect(sessionUser(db, t, 7 * D)).toBeNull();
});

test("users: a revoked session fails at once", () => {
  const db = world();
  const t = createSession(db, "ana", 0);
  expect(openSessions(db, 10, "ana")).toHaveLength(1);
  expect(revokeSession(db, hashToken(t), 10)).toBe(true);
  expect(sessionUser(db, t, 11)).toBeNull();
  const a = createSession(db, "ana", 20);
  const b = createSession(db, "ana", 20);
  expect(revokeAll(db, "ana", 21, hashToken(a))).toBe(1);
  expect(sessionUser(db, a, 22)).not.toBeNull();
  expect(sessionUser(db, b, 22)).toBeNull();
});

test("users: removing a person revokes their sessions", () => {
  const db = world();
  const t = createSession(db, "ana", 0);
  removeUser(db, "ana", "owner", 5);
  expect(sessionUser(db, t, 6)).toBeNull();
  // Added again later, the old token still does not work.
  addUser(db, { login: "ana", role: "viewer", by: "owner" }, 7);
  expect(sessionUser(db, t, 8)).toBeNull();
});

test("users: a role change applies to the open session", () => {
  const db = world();
  const t = createSession(db, "ana", 0);
  expect(sessionUser(db, t, 1)?.role).toBe("maintainer");
  changeUser(db, "ana", { role: "viewer", by: "owner" }, 2);
  expect(sessionUser(db, t, 3)?.role).toBe("viewer");
  changeUser(db, "ana", { repoRoles: { "acme/api": "maintainer" }, by: "owner" }, 4);
  expect(sessionUser(db, t, 5)?.repoRoles).toEqual({ "acme/api": "maintainer" });
});

test("users: no password is stored", () => {
  const db = world();
  const t = createSession(db, "ana", 0);
  const cols = db.all<{ name: string }>("PRAGMA table_info(users)").map((c) => c.name);
  expect(cols.some((c) => /pass|secret|token/i.test(c))).toBe(false);
  // Only the token's hash is kept, never the token.
  const rows = db.all<{ hash: string }>("SELECT hash FROM sessions");
  expect(rows.map((r) => r.hash)).toEqual([hashToken(t)]);
  expect(rows[0]!.hash).not.toBe(t);
});

test("users: every user change is recorded", () => {
  const db = world();
  changeUser(db, "ana", { role: "contributor", by: "owner" }, 3);
  setTeam(db, { team: "acme/devs", role: "contributor" }, "owner", 4);
  expect(getTeam(db)).toEqual({ team: "acme/devs", role: "contributor" });
  expect(() => setTeam(db, { team: "acme/devs", role: "maintainer" }, "owner", 5)).toThrow(
    /at most contributor/,
  );
  setTeam(db, null, "owner", 6);
  removeUser(db, "ana", "owner", 7);
  expect(userEvents(db).map((e) => `${e.actor}:${e.what}:${e.login}`)).toEqual([
    "owner:removed:ana",
    "owner:team cleared:",
    "owner:team named:",
    "owner:changed:ana",
    "owner:added:ana",
    "towercab:added:owner",
  ]);
  expect(userEvents(db)[0]!.at).toBe(7);
});
