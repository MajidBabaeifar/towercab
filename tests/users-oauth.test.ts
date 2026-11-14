import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import type { Http, HttpRequest } from "../src/github/app.ts";
import { Auth, TEAM_RECHECK_SECS, UNKNOWN_ACCOUNT } from "../src/ui/auth.ts";
import {
  addUser,
  getTeam,
  getUser,
  openSessions,
  seedOwner,
  sessionUser,
  setTeam,
} from "../src/users-store.ts";

const APP = {
  clientId: "Iv1.abc",
  clientSecret: "s3cret",
  redirectUri: "https://tc.example/api/auth/callback",
};
const LIMITS = { idleSecs: 12 * 3600, maxSecs: 7 * 86_400 };

/** A fake GitHub: `codes` maps a code to the login it signs in; `team` lists the team's members. */
function github(codes: Record<string, string>, team: Set<string> = new Set()) {
  const calls: HttpRequest[] = [];
  const http: Http = async (req) => {
    calls.push(req);
    if (req.url.endsWith("/login/oauth/access_token")) {
      const code = JSON.parse(req.body ?? "{}").code as string;
      return code in codes
        ? { status: 200, text: JSON.stringify({ access_token: `tok-${codes[code]}` }) }
        : {
            status: 200,
            text: JSON.stringify({ error: "bad_verification_code", error_description: "bad code" }),
          };
    }
    const bearer = req.headers?.authorization?.replace("Bearer tok-", "") ?? "";
    if (req.url.endsWith("/user")) return { status: 200, text: JSON.stringify({ login: bearer }) };
    const m = req.url.match(/\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/(.+)$/);
    if (m) {
      return team.has(m[3]!.toLowerCase())
        ? { status: 200, text: JSON.stringify({ state: "active" }) }
        : { status: 404, text: "{}" };
    }
    return { status: 500, text: "" };
  };
  return { http, calls };
}

function world(codes: Record<string, string>, team?: Set<string>) {
  const db = Db.memory();
  seedOwner(db, "owner", 0);
  addUser(db, { login: "ana", role: "maintainer", by: "owner" }, 0);
  const gh = github(codes, team);
  const auth = new Auth({ db, app: APP, http: gh.http, limits: LIMITS });
  return { db, auth, gh };
}

async function signIn(auth: Auth, code: string, now = 100) {
  const { state } = auth.start(now);
  return auth.callback(code, state, now);
}

test("users: an added person can sign in", async () => {
  const { db, auth } = world({ c1: "Ana" });
  const r = await signIn(auth, "c1");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.user.login).toBe("ana");
    expect(sessionUser(db, r.token, 200)?.role).toBe("maintainer");
  }
});

test("users: a team member gets the team role", async () => {
  const { db, auth } = world({ c1: "bob" }, new Set(["bob"]));
  setTeam(db, { team: "acme/devs", role: "contributor" }, "owner", 0);
  const r = await signIn(auth, "c1");
  expect(r.ok && r.user.role).toBe("contributor");
  expect(getUser(db, "bob")?.addedBy).toBe("team:acme/devs");
});

test("users: a team member is a viewer by default", async () => {
  const { db, auth } = world({ c1: "bob" }, new Set(["bob"]));
  setTeam(db, { team: "acme/devs" }, "owner", 0);
  expect(getTeam(db)?.role).toBe("viewer");
  const r = await signIn(auth, "c1");
  expect(r.ok && r.user.role).toBe("viewer");
});

test("users: a row wins over the team", async () => {
  const { db, auth, gh } = world({ c1: "ana" }, new Set(["ana"]));
  setTeam(db, { team: "acme/devs", role: "viewer" }, "owner", 0);
  const r = await signIn(auth, "c1");
  expect(r.ok && r.user.role).toBe("maintainer");
  expect(gh.calls.some((c) => c.url.includes("/teams/"))).toBe(false);
});

test("users: a team role above contributor is refused", () => {
  const { db } = world({});
  expect(() => setTeam(db, { team: "acme/devs", role: "maintainer" }, "owner", 0)).toThrow(
    /at most contributor/,
  );
  expect(() => setTeam(db, { team: "acme/devs", role: "admin" }, "owner", 0)).toThrow(/at most contributor/);
  expect(getTeam(db)).toBeNull();
});

test("users: a person who left the team loses access", async () => {
  const members = new Set(["bob"]);
  const { db, auth } = world({ c1: "bob" }, members);
  setTeam(db, { team: "acme/devs", role: "contributor" }, "owner", 0);
  const r = await signIn(auth, "c1", 100);
  if (!r.ok) throw new Error(r.reason);
  // Inside the 10 minutes nothing is asked; after them the check finds bob gone.
  expect(await auth.recheck(r.token, r.user, 100 + TEAM_RECHECK_SECS - 1)).toBe(false);
  members.delete("bob");
  expect(await auth.recheck(r.token, r.user, 100 + TEAM_RECHECK_SECS)).toBe(true);
  expect(sessionUser(db, r.token, 100 + TEAM_RECHECK_SECS)).toBeNull();
  expect(getUser(db, "bob")).toBeNull();
  expect(openSessions(db, 700)).toEqual([]);
});

test("users: an unknown account is refused", async () => {
  const { db, auth } = world({ c1: "mallory" }, new Set());
  setTeam(db, { team: "acme/devs" }, "owner", 0);
  const r = await signIn(auth, "c1");
  expect(r).toEqual({ ok: false, reason: UNKNOWN_ACCOUNT });
  expect(getUser(db, "mallory")).toBeNull();
  expect(db.get("SELECT COUNT(*) AS n FROM sessions")).toEqual({ n: 0 });
});

test("users: sign-in checks the state parameter", async () => {
  const { auth, gh } = world({ c1: "ana" });
  const wrong = await auth.callback("c1", "not-ours", 100);
  expect(wrong.ok).toBe(false);
  expect(gh.calls).toEqual([]);
  const { state } = auth.start(100);
  expect((await auth.callback("c1", state, 100 + 601)).ok).toBe(false);
  const again = auth.start(100);
  expect((await auth.callback("c1", again.state, 101)).ok).toBe(true);
  // A state works once.
  expect((await auth.callback("c1", again.state, 102)).ok).toBe(false);
  expect(new URL(auth.start(100).url).searchParams.get("redirect_uri")).toBe(APP.redirectUri);
});

test("users: the login comes from the github api", async () => {
  const { auth, gh } = world({ c1: "ana" });
  const r = await signIn(auth, "c1");
  expect(r.ok && r.user.login).toBe("ana");
  const user = gh.calls.find((c) => c.url === "https://api.github.com/user");
  expect(user?.headers?.authorization).toBe("Bearer tok-ana");
  // A login the browser might send in the callback has no way in: the callback takes only code and state.
  expect(auth.callback.length).toBe(3);
});

test("users: no password is stored", async () => {
  const { db, auth } = world({ c1: "ana" });
  const r = await signIn(auth, "c1");
  if (!r.ok) throw new Error(r.reason);
  const columns = db
    .all<{ name: string }>(
      "SELECT m.name FROM pragma_table_info('users') m UNION SELECT name FROM pragma_table_info('sessions')",
    )
    .map((c) => c.name);
  expect(columns.filter((c) => /pass|secret|token/i.test(c))).toEqual([]);
  const dump =
    JSON.stringify(db.all("SELECT * FROM sessions")) + JSON.stringify(db.all("SELECT * FROM users"));
  expect(dump).not.toContain(r.token);
  expect(dump).not.toContain("tok-ana");
  expect(dump).not.toContain(APP.clientSecret);
});

test("users: [auth] is read from the file and secrets stay out of it", () => {
  const base = { github: { app_id: 1, me: "owner" }, intents: { remote: "https://x/y.git" } };
  const ok = parseConfig(
    {
      ...base,
      auth: { client_id: "Iv1.abc", client_secret_env: "TC_SECRET", public_url: "https://tc.example/" },
    },
    "c.toml",
  );
  expect(ok.auth).toEqual({
    clientId: "Iv1.abc",
    clientSecretEnv: "TC_SECRET",
    publicUrl: "https://tc.example",
    listen: "127.0.0.1",
    sessionHours: 12,
    sessionDays: 7,
  });
  expect(parseConfig(base, "c.toml").auth).toBeNull();
  expect(() => parseConfig({ ...base, auth: { client_id: "x", public_url: "https://t" } }, "c.toml")).toThrow(
    /auth.client_secret_env/,
  );
});
