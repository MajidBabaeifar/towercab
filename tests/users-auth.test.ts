// USR-2, USR-3, USR-4: who may sign in, how the identity is proved, and how sessions end.

import { afterEach, expect, test } from "vitest";
import type { Http } from "../src/github/app.ts";
import { startUi } from "../src/ui/server.ts";
import { Auth, SESSION_COOKIE, STATE_COOKIE, UNKNOWN_ACCOUNT } from "../src/users/auth.ts";
import { addUser, changeUser, ensureFirstAdmin, removeUser, setTeam } from "../src/users/store.ts";
import type { User } from "../src/users.ts";
import { buildFixture } from "../ui/fixture.ts";
import { tempDir } from "./helpers/world.ts";
import { call } from "./ui/http.ts";

const admin: User = { login: "me", role: "admin", repos: {} };
const PUBLIC = "https://tc.example.com";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

interface World {
  auth: Auth;
  db: ReturnType<typeof buildFixture>["db"];
  clock: { t: number };
  /** The login GitHub's API answers for the next code. */
  github: { login: string; teams: Set<string>; down: boolean; calls: string[] };
  fixture: ReturnType<typeof buildFixture>;
}

function world(): World {
  const fixture = buildFixture({ now: 1_000_000 });
  const db = fixture.db;
  const clock = { t: 1_000_000 };
  const github = { login: "ana", teams: new Set<string>(), down: false, calls: [] as string[] };
  const http: Http = async (req) => {
    github.calls.push(`${req.method} ${req.url}`);
    if (req.url.endsWith("/login/oauth/access_token"))
      return { status: 200, text: '{"access_token":"gho_x"}' };
    if (req.url.endsWith("/user")) return { status: 200, text: JSON.stringify({ login: github.login }) };
    return { status: 404, text: "" };
  };
  ensureFirstAdmin(db, "me", clock.t);
  const auth = new Auth({
    db,
    auth: {
      clientId: "id",
      clientSecretEnv: "S",
      publicUrl: PUBLIC,
      listen: "127.0.0.1",
      sessionHours: 12,
      sessionDays: 7,
    },
    http,
    now: () => clock.t,
    secret: () => "shh",
    apiBase: "https://api.github.com",
    inTeam: async (team, login) => {
      if (github.down) throw new Error("down");
      return github.teams.has(`${team}:${login}`);
    },
    random: () => "STATE",
  });
  return { auth, db, clock, github, fixture };
}

/** Sign in as whoever `github.login` says; returns the session cookie header. */
async function signIn(w: World): Promise<string> {
  const out = await w.auth.callback("code", "STATE", `${STATE_COOKIE}=STATE`);
  if (!out.ok) throw new Error(out.message);
  return out.cookies[0]!.split(";")[0]!;
}

test("users: an added person can sign in", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "maintainer" }, w.clock.t);
  const cookie = await signIn(w);
  const s = await w.auth.authenticate(cookie);
  expect(s?.user).toMatchObject({ login: "ana", role: "maintainer" });
});

test("users: an unknown account is refused", async () => {
  const w = world();
  w.github.login = "stranger";
  const out = await w.auth.callback("code", "STATE", `${STATE_COOKIE}=STATE`);
  expect(out).toEqual({ ok: false, status: 403, message: UNKNOWN_ACCOUNT, login: "stranger" });
  expect(w.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions")?.n).toBe(0);
});

test("users: a team member gets the team role", async () => {
  const w = world();
  setTeam(w.db, admin, { name: "acme/devs", role: "contributor" }, w.clock.t);
  w.github.teams.add("acme/devs:ana");
  const s = await w.auth.authenticate(await signIn(w));
  expect(s?.user).toMatchObject({ login: "ana", role: "contributor", repos: {} });
});

test("users: a team member is a viewer by default", async () => {
  const w = world();
  setTeam(w.db, admin, { name: "acme/devs" }, w.clock.t);
  w.github.teams.add("acme/devs:ana");
  expect((await w.auth.authenticate(await signIn(w)))?.user.role).toBe("viewer");
});

test("users: a row wins over the team", async () => {
  const w = world();
  setTeam(w.db, admin, { name: "acme/devs", role: "contributor" }, w.clock.t);
  w.github.teams.add("acme/devs:ana");
  addUser(w.db, admin, "ana", { role: "viewer", repos: { web: "maintainer" } }, w.clock.t);
  const s = await w.auth.authenticate(await signIn(w));
  expect(s?.user).toMatchObject({ role: "viewer", repos: { web: "maintainer" } });
});

test("users: a person who left the team loses access", async () => {
  const w = world();
  setTeam(w.db, admin, { name: "acme/devs" }, w.clock.t);
  w.github.teams.add("acme/devs:ana");
  const cookie = await signIn(w);
  // Within ten minutes the last answer stands, even if GitHub is down.
  w.github.teams.clear();
  w.clock.t += 300;
  expect(await w.auth.authenticate(cookie)).not.toBeNull();
  w.github.down = true;
  w.clock.t += 400;
  expect(await w.auth.authenticate(cookie)).not.toBeNull();
  // GitHub answers again: they are out.
  w.github.down = false;
  w.clock.t += 10;
  expect(await w.auth.authenticate(cookie)).toBeNull();
});

test("users: sign-in checks the state parameter", async () => {
  const w = world();
  addUser(w.db, admin, "ana", {}, w.clock.t);
  const start = w.auth.start();
  expect(start.location).toContain("client_id=id");
  expect(start.location).toContain("state=STATE");
  expect(start.location).toContain(encodeURIComponent(`${PUBLIC}/auth/callback`));
  expect(start.cookies[0]).toMatch(/HttpOnly/);
  const wrong = await w.auth.callback("code", "OTHER", `${STATE_COOKIE}=STATE`);
  expect(wrong).toMatchObject({ ok: false, status: 400 });
  const none = await w.auth.callback("code", "STATE", undefined);
  expect(none).toMatchObject({ ok: false, status: 400 });
  expect(w.github.calls).toEqual([]);
});

test("users: the login comes from the github api", async () => {
  const w = world();
  addUser(w.db, admin, "ana", {}, w.clock.t);
  w.github.login = "Ana";
  const cookie = await signIn(w);
  expect(w.github.calls.at(-1)).toBe("GET https://api.github.com/user");
  expect((await w.auth.authenticate(cookie))?.user.login).toBe("ana");
});

test("users: no password is stored", async () => {
  const w = world();
  addUser(w.db, admin, "ana", {}, w.clock.t);
  const cookie = await signIn(w);
  const token = cookie.slice(`${SESSION_COOKIE}=`.length);
  const cols = w.db
    .all<{ name: string }>("SELECT name FROM pragma_table_info('sessions')")
    .map((c) => c.name);
  expect(cols.join()).not.toMatch(/pass|secret|token(?!_hash)/);
  const rows = JSON.stringify(w.db.all("SELECT * FROM sessions"));
  expect(rows).not.toContain(token);
  const out = await w.auth.callback("code", "STATE", `${STATE_COOKIE}=STATE`);
  expect(out.ok && out.cookies[0]).toMatch(/HttpOnly; Secure; SameSite=Lax/);
});

test("users: a session expires when idle", async () => {
  const w = world();
  addUser(w.db, admin, "ana", {}, w.clock.t);
  const cookie = await signIn(w);
  w.clock.t += 11 * 3600;
  expect(await w.auth.authenticate(cookie)).not.toBeNull();
  w.clock.t += 11 * 3600;
  expect(await w.auth.authenticate(cookie)).not.toBeNull();
  w.clock.t += 13 * 3600;
  expect(await w.auth.authenticate(cookie)).toBeNull();
});

test("users: a session expires after seven days", async () => {
  const w = world();
  addUser(w.db, admin, "ana", {}, w.clock.t);
  const cookie = await signIn(w);
  // Used every 10 hours, so never idle; 160 h in it still works.
  for (let i = 0; i < 16; i++) {
    w.clock.t += 10 * 3600;
    expect(await w.auth.authenticate(cookie)).not.toBeNull();
  }
  // At 7 days (168 h) it ends however recently it was used.
  w.clock.t += 10 * 3600;
  expect(await w.auth.authenticate(cookie)).toBeNull();
});

test("users: a revoked session fails at once", async () => {
  const w = world();
  addUser(w.db, admin, "ana", {}, w.clock.t);
  const cookie = await signIn(w);
  const s = await w.auth.authenticate(cookie);
  w.auth.logout(s!.session);
  expect(await w.auth.authenticate(cookie)).toBeNull();
});

test("users: removing a person revokes their sessions", async () => {
  const w = world();
  addUser(w.db, admin, "ana", {}, w.clock.t);
  const cookie = await signIn(w);
  removeUser(w.db, admin, "ana", w.clock.t);
  expect(await w.auth.authenticate(cookie)).toBeNull();
  expect(w.db.get<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL")?.n).toBe(0);
});

test("users: a role change applies to the open session", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "maintainer" }, w.clock.t);
  const cookie = await signIn(w);
  expect((await w.auth.authenticate(cookie))?.user.role).toBe("maintainer");
  changeUser(w.db, admin, "ana", { role: "viewer" }, w.clock.t);
  expect((await w.auth.authenticate(cookie))?.user.role).toBe("viewer");
});

test("users: a post from another origin is refused", async () => {
  const w = world();
  addUser(w.db, admin, "ana", { role: "maintainer" }, w.clock.t);
  const cookie = await signIn(w);
  const ui = startUi({
    port: 0,
    auth: w.auth,
    sources: w.fixture.sources,
    actions: w.fixture.actions,
    distDir: tempDir(),
    log: () => {},
  });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const body = JSON.stringify({ action: "pause" });
  const headers = (origin: string) => ({
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: origin,
    "X-Towercab-Token": ui.token,
  });
  const bad = await call(port, {
    method: "POST",
    path: "/api/actions",
    headers: headers("https://evil.example"),
    body,
  });
  expect(bad.status).toBe(403);
  expect(JSON.parse(bad.body).message).toBe("Refused: wrong origin.");
  const same = await call(port, { method: "POST", path: "/api/actions", headers: headers(PUBLIC), body });
  expect(same.status).not.toBe(403);
});

test("users: the page needs a session when sign-in is on", async () => {
  const w = world();
  const ui = startUi({
    port: 0,
    auth: w.auth,
    sources: w.fixture.sources,
    actions: null,
    distDir: tempDir(),
    log: () => {},
  });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  expect((await call(port, { path: "/api/state" })).status).toBe(401);
  expect((await call(port, { path: "/api/events" })).status).toBe(401);
  const login = await call(port, { path: "/auth/login" });
  expect(login.status).toBe(302);
  expect(String(login.headers.location)).toContain("github.com/login/oauth/authorize");
  const badCallback = await call(port, { path: "/auth/callback?code=x&state=y" });
  expect(badCallback.status).toBe(400);
  addUser(w.db, admin, "ana", {}, w.clock.t);
  const cookie = await signIn(w);
  expect((await call(port, { path: "/api/state", headers: { Cookie: cookie } })).status).toBe(200);
});
