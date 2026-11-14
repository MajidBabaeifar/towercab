import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import {
  addUser,
  changeUser,
  ensureFirstAdmin,
  getUser,
  removeUser,
  setDisabled,
  userEvents,
} from "../src/users/store.ts";
import { ACTIONS, type Action, can, denial, ROLES, type Role, roleFor, type User } from "../src/users.ts";

const person = (role: Role, repos: Record<string, Role> = {}): User => ({ login: "ana", role, repos });

// USR-1's table: the actions each role may do, by the lowest role that has them.
const FROM: Record<Action, Role> = {
  read: "viewer",
  create: "contributor",
  answer: "contributor",
  approve: "maintainer",
  merge: "maintainer",
  reply: "maintainer",
  start: "maintainer",
  boost: "maintainer",
  drop: "maintainer",
  edit: "maintainer",
  confirm: "maintainer",
  raise: "maintainer",
  lower: "maintainer",
  retry: "maintainer",
  pause: "maintainer",
  resume: "maintainer",
  manage_users: "admin",
  settings: "admin",
};

test("users: each role may do exactly its actions", () => {
  expect(Object.keys(FROM).sort()).toEqual([...ACTIONS].sort());
  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const allowed = ROLES.indexOf(role) >= ROLES.indexOf(FROM[action]);
      expect(can(person(role), action, "acme/api"), `${role} ${action}`).toBe(allowed);
    }
  }
  expect(can(null, "read")).toBe(false);
  expect(can({ ...person("admin"), disabled: true }, "read")).toBe(false);
});

test("users: a viewer changes nothing", () => {
  const viewer = person("viewer");
  for (const action of ACTIONS) expect(can(viewer, action, "acme/api")).toBe(action === "read");
  expect(denial(viewer, "merge", "acme/api")).toBe("your role (viewer) can't merge on acme/api");
  expect(denial(viewer, "read", "acme/api")).toBeNull();
});

test("users: a repo role overrides the default", () => {
  const lowered = person("maintainer", { "acme/api": "viewer" });
  expect(roleFor(lowered, "acme/api")).toBe("viewer");
  expect(can(lowered, "merge", "acme/api")).toBe(false);
  expect(roleFor(lowered, "acme/web")).toBe("maintainer");
  // No repo (a list, a create): the default role.
  expect(roleFor(lowered)).toBe("maintainer");
  const raised = person("viewer", { "acme/api": "contributor" });
  expect(can(raised, "create", "acme/api")).toBe(true);
});

test("users: maintainer on one repo and viewer on another", () => {
  const ana = person("viewer", { "acme/api": "maintainer" });
  expect(can(ana, "merge", "acme/api")).toBe(true);
  expect(can(ana, "merge", "acme/web")).toBe(false);
  expect(can(ana, "read", "acme/web")).toBe(true);
});

test("users: admin is never per repo", () => {
  const sneaky = person("viewer", { "acme/api": "admin" });
  expect(roleFor(sneaky, "acme/api")).toBe("maintainer");
  expect(can(sneaky, "manage_users", "acme/api")).toBe(false);
  expect(can(sneaky, "settings")).toBe(false);
  // An admin is one everywhere, even with a lower per-repo entry.
  const admin = person("admin", { "acme/api": "viewer" });
  expect(can(admin, "manage_users", "acme/api")).toBe(true);
  const db = Db.memory();
  ensureFirstAdmin(db, "Owner", 1);
  const boss = getUser(db, "owner")!;
  expect(() => addUser(db, boss, "ben", { role: "viewer", repos: { "acme/api": "admin" } }, 2)).toThrow(
    /admin applies to every repo/,
  );
});

test("users: the owner becomes the first admin", () => {
  const db = Db.memory();
  expect(ensureFirstAdmin(db, "Owner", 10)).toBe(true);
  const owner = getUser(db, "OWNER");
  expect(owner?.role).toBe("admin");
  expect(owner?.login).toBe("owner");
  // Not again, and not when somebody is already known.
  expect(ensureFirstAdmin(db, "owner", 11)).toBe(false);
  const other = Db.memory();
  addUser(other, { login: "x", role: "admin", repos: {} }, "ana", { role: "viewer" }, 1);
  expect(ensureFirstAdmin(other, "owner", 2)).toBe(false);
  expect(getUser(other, "owner")).toBeNull();
  expect(ensureFirstAdmin(Db.memory(), "", 1)).toBe(false);
});

test("users: the last admin cannot be removed", () => {
  const db = Db.memory();
  ensureFirstAdmin(db, "owner", 1);
  const owner = getUser(db, "owner")!;
  expect(() => removeUser(db, owner, "owner", 2)).toThrow(/last admin/);
  expect(() => changeUser(db, owner, "owner", { role: "maintainer" }, 2)).toThrow(/last admin/);
  expect(() => setDisabled(db, owner, "owner", true, 2)).toThrow(/last admin/);
  expect(getUser(db, "owner")?.role).toBe("admin");
  // With a second admin the first may go.
  addUser(db, owner, "ben", { role: "admin" }, 3);
  removeUser(db, owner, "owner", 4);
  expect(getUser(db, "owner")).toBeNull();
  const ben = getUser(db, "ben")!;
  expect(() => removeUser(db, ben, "ben", 5)).toThrow(/last admin/);
  // A disabled admin doesn't count as one.
  addUser(db, ben, "cy", { role: "admin" }, 6);
  setDisabled(db, ben, "cy", true, 7);
  expect(() => removeUser(db, ben, "ben", 8)).toThrow(/last admin/);
});

test("users: only an admin manages users", () => {
  const db = Db.memory();
  ensureFirstAdmin(db, "owner", 1);
  const owner = getUser(db, "owner")!;
  addUser(db, owner, "ben", { role: "maintainer" }, 2);
  const ben = getUser(db, "ben")!;
  for (const run of [
    () => addUser(db, ben, "cy", { role: "viewer" }, 3),
    () => changeUser(db, ben, "ben", { role: "admin" }, 3),
    () => setDisabled(db, ben, "owner", true, 3),
    () => removeUser(db, ben, "owner", 3),
  ]) {
    expect(run).toThrow("only an admin manages users");
  }
  expect(getUser(db, "cy")).toBeNull();
  expect(getUser(db, "ben")?.role).toBe("maintainer");
  expect(getUser(db, "owner")?.disabled).toBe(false);
});

test("users: every user change is recorded", () => {
  const db = Db.memory();
  ensureFirstAdmin(db, "owner", 1);
  const owner = getUser(db, "owner")!;
  addUser(db, owner, "Ben", { role: "viewer", repos: { "acme/api": "maintainer" } }, 2);
  changeUser(db, owner, "ben", { role: "contributor" }, 3);
  setDisabled(db, owner, "ben", true, 4);
  setDisabled(db, owner, "ben", false, 5);
  removeUser(db, owner, "ben", 6);
  const log = userEvents(db).map((e) => [e.at, e.actor, e.action, e.target]);
  expect(log).toEqual([
    [6, "owner", "remove", "ben"],
    [5, "owner", "enable", "ben"],
    [4, "owner", "disable", "ben"],
    [3, "owner", "change", "ben"],
    [2, "owner", "add", "ben"],
    [1, "towercab", "add", "owner"],
  ]);
  expect(userEvents(db).find((e) => e.action === "add" && e.target === "ben")?.detail).toBe(
    "viewer (acme/api: maintainer)",
  );
  // A refused change leaves no record.
  const ben = { login: "x", role: "viewer", repos: {} } satisfies User;
  expect(() => addUser(db, ben, "cy", {}, 7)).toThrow();
  expect(userEvents(db)).toHaveLength(6);
});

test("users: removing a person revokes their sessions", () => {
  const db = Db.memory();
  ensureFirstAdmin(db, "owner", 1);
  const owner = getUser(db, "owner")!;
  addUser(db, owner, "ben", { role: "viewer" }, 2);
  for (const [hash, login] of [
    ["h1", "ben"],
    ["h2", "ben"],
    ["h3", "owner"],
  ] as const) {
    db.run(
      "INSERT INTO sessions (token_hash, login, created, last_seen, expires) VALUES (?, ?, 2, 2, 999)",
      hash,
      login,
    );
  }
  removeUser(db, owner, "ben", 5);
  const rows = db.all<{ login: string; revoked_at: number | null }>(
    "SELECT login, revoked_at FROM sessions ORDER BY token_hash",
  );
  expect(rows).toEqual([
    { login: "ben", revoked_at: 5 },
    { login: "ben", revoked_at: 5 },
    { login: "owner", revoked_at: null },
  ]);
});
