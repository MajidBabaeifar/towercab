import { expect, test } from "vitest";
import { ownerActor } from "../src/actor.ts";
import { Db } from "../src/db.ts";
import { authOf } from "../src/ui/wire.ts";
import {
  can,
  checkRepoRoles,
  checkTeamRole,
  NEEDS,
  type Person,
  ROLES,
  type UserAction,
} from "../src/users.ts";
import { addUser, getUser, listUsers, removeUser, seedOwner, setDisabled } from "../src/users-store.ts";
import { testConfig } from "./helpers/world.ts";

const person = (role: Person["role"], repoRoles: Person["repoRoles"] = {}): Person => ({
  login: "ana",
  role,
  repoRoles,
});
const ACTIONS = Object.keys(NEEDS) as UserAction[];

test("users: each role may do exactly its actions", () => {
  const allowed = {
    viewer: ["read"],
    contributor: ["read", "create", "answer"],
    maintainer: [
      "read",
      "create",
      "answer",
      "approve",
      "merge",
      "reply",
      "start",
      "boost",
      "drop",
      "edit",
      "confirm",
      "raise",
      "lower",
      "retry",
      "pause",
      "resume",
    ],
    admin: ACTIONS,
  };
  for (const role of ROLES) {
    const may = ACTIONS.filter((a) => can(person(role), a, "acme/api"));
    expect(may.sort()).toEqual([...allowed[role]].sort());
  }
  expect(can(null, "read")).toBe(false);
  expect(can({ ...person("admin"), disabled: true }, "read")).toBe(false);
});

test("users: a viewer changes nothing", () => {
  for (const a of ACTIONS) expect(can(person("viewer"), a, "acme/api")).toBe(a === "read");
});

test("users: only an admin manages users", () => {
  for (const role of ["viewer", "contributor", "maintainer"] as const) {
    expect(can(person(role), "users")).toBe(false);
    expect(can(person(role), "settings")).toBe(false);
  }
  expect(can(person("admin"), "users")).toBe(true);
});

test("users: a repo role overrides the default", () => {
  const p = person("viewer", { "acme/api": "maintainer" });
  expect(can(p, "merge", "acme/api")).toBe(true);
  expect(can(person("maintainer", { "acme/web": "viewer" }), "merge", "acme/web")).toBe(false);
  // An action with no repo uses the default role.
  expect(can(p, "create")).toBe(false);
});

test("users: maintainer on one repo and viewer on another", () => {
  const p = person("viewer", { "acme/api": "maintainer" });
  expect(can(p, "approve", "acme/api")).toBe(true);
  expect(can(p, "approve", "acme/web")).toBe(false);
  expect(can(p, "read", "acme/web")).toBe(true);
});

test("users: admin is never per repo", () => {
  expect(() => checkRepoRoles({ "acme/api": "admin" })).toThrow(/never per repo/);
  expect(can(person("viewer", { "acme/api": "admin" }), "users", "acme/api")).toBe(false);
  expect(can(person("admin", { "acme/api": "viewer" }), "users", "acme/api")).toBe(true);
});

test("users: a team role above contributor is refused", () => {
  expect(() => checkTeamRole("maintainer")).toThrow(/at most contributor/);
  expect(() => checkTeamRole("admin")).toThrow(/at most contributor/);
  expect(checkTeamRole("contributor")).toBe("contributor");
});

test("users: the owner becomes the first admin", () => {
  const db = Db.memory();
  expect(seedOwner(db, "Owner", 1)).toBe(true);
  expect(getUser(db, "owner")).toMatchObject({ role: "admin", addedBy: "towercab" });
  // A second start, or a Towercab that already has people, adds nobody.
  expect(seedOwner(db, "Owner", 2)).toBe(false);
  const other = Db.memory();
  addUser(other, { login: "ben", role: "viewer", by: "x" }, 1);
  expect(seedOwner(other, "owner", 2)).toBe(false);
  expect(getUser(other, "owner")).toBeNull();
});

test("users: the last admin cannot be removed", () => {
  const db = Db.memory();
  seedOwner(db, "owner", 1);
  expect(() => removeUser(db, "owner", "owner", 2)).toThrow(/last admin/);
  expect(() => setDisabled(db, "owner", true, "owner", 2)).toThrow(/last admin/);
  addUser(db, { login: "cy", role: "admin", by: "owner" }, 3);
  removeUser(db, "owner", "cy", 4);
  expect(getUser(db, "owner")).toBeNull();
  expect(() => removeUser(db, "cy", "cy", 5)).toThrow(/last admin/);
});

test("users: without auth config the owner acts as before", () => {
  const db = Db.memory();
  const config = testConfig();
  expect(config.auth).toBeNull();
  // No sign-in is set up and nobody is added: the owner is the one actor on every channel.
  expect(authOf(db, config, () => 0)).toBeUndefined();
  expect(listUsers(db)).toEqual([]);
  const me = config.github?.me ?? "owner";
  for (const via of ["page", "github", "telegram", "cli"] as const)
    expect(ownerActor(me, via)).toEqual({ login: me, name: me, role: "admin", via });
});
