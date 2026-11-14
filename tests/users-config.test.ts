// USR-2, USR-6: the optional `[auth]` section and the named team.

import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { ensureFirstAdmin, getTeam, setTeam } from "../src/users/store.ts";
import type { User } from "../src/users.ts";

const base = { intents: { remote: "https://github.com/me/intents.git" }, github: { app_id: 7, me: "me" } };
const admin: User = { login: "me", role: "admin", repos: {} };

test("users: without auth config the owner acts as before", () => {
  const c = parseConfig(base, "/x/config.toml");
  expect(c.auth).toBeUndefined();
  expect(c.github?.me).toBe("me");
});

test("users: auth config has defaults and names its secret variable", () => {
  const c = parseConfig(
    {
      ...base,
      auth: { client_id: "Iv1.abc", client_secret_env: "TC_SECRET", public_url: "https://tc.example.com/" },
    },
    "/x/config.toml",
  );
  expect(c.auth).toEqual({
    clientId: "Iv1.abc",
    clientSecretEnv: "TC_SECRET",
    publicUrl: "https://tc.example.com",
    listen: "127.0.0.1",
    sessionHours: 12,
    sessionDays: 7,
  });
  expect(() => parseConfig({ ...base, auth: { client_id: "x" } }, "/x/c.toml")).toThrow(/client_secret_env/);
});

test("users: a team role above contributor is refused", () => {
  const db = Db.memory();
  ensureFirstAdmin(db, "me", 1);
  expect(() => setTeam(db, admin, { name: "acme/devs", role: "maintainer" }, 2)).toThrow(/contributor/);
  expect(() => setTeam(db, admin, { name: "acme/devs", role: "admin" }, 2)).toThrow(/contributor/);
  expect(getTeam(db)).toBeNull();
  setTeam(db, admin, { name: "acme/devs" }, 3);
  expect(getTeam(db)).toEqual({ name: "acme/devs", role: "viewer" });
  setTeam(db, admin, { name: "acme/devs", role: "contributor" }, 4);
  expect(getTeam(db)?.role).toBe("contributor");
  setTeam(db, admin, null, 5);
  expect(getTeam(db)).toBeNull();
});
