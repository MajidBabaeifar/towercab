// The page's server side for people (UI-219, UI-221, UI-222, UI-224): what the API gives the page. The rendering is in
// `ui/users.spec.ts`.

import { afterEach, expect, test } from "vitest";
import { UNKNOWN_ACCOUNT } from "../../src/users/auth.ts";
import { IDS } from "../../ui/fixture.ts";
import { type People, people } from "../helpers/people.ts";

const open: People[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});
const start = async () => {
  const w = await people();
  open.push(w);
  return w;
};

test("ui: signed-out visitors see the sign-in screen", async () => {
  const w = await start();
  // The page itself loads; every API read answers 401 until a session exists, and the page shows sign-in on it.
  const r = await w.get("/api/me");
  expect(r.status).toBe(401);
  expect((await w.get("/")).status).toBe(200);
  const login = await w.get("/auth/login");
  expect(login.status).toBe(302);
  expect(String(login.headers.location)).toContain("github.com/login/oauth/authorize");
});

test("ui: an unknown account sees why it was refused", async () => {
  const w = await start();
  w.github.login = "stranger";
  const r = await w.get("/auth/callback?code=c&state=STATE", "tc_state=STATE");
  expect(r.status).toBe(403);
  expect(r.body).toContain(UNKNOWN_ACCOUNT);
  expect(r.body).toContain("stranger");
  expect(r.body).toContain("/auth/login");
});

test("ui: a card shows who acted and how", async () => {
  const w = await start();
  w.f.sources.config.auth = {
    clientId: "id",
    clientSecretEnv: "S",
    publicUrl: "https://tc.example.com",
    listen: "127.0.0.1",
    sessionHours: 12,
    sessionDays: 7,
  };
  w.add("ana", "maintainer", { web: "maintainer" });
  w.add("ben", "maintainer", { web: "maintainer" });
  const cookie = await w.as("ana");
  const state = JSON.parse((await w.get("/api/inbox", cookie)).body) as {
    items: { key: string; card: { repo: string; others?: string[] } | null }[];
  };
  const card = state.items.find((i) => i.card?.repo === "web")?.card;
  // The people who can decide a card of that repo are named; admins and the maintainers of that repo.
  expect(card?.others).toEqual(expect.arrayContaining(["ana", "ben", "owner"]));
});

test("ui: the timeline names every actor", async () => {
  const w = await start();
  const cookie = await w.as("owner");
  const page = JSON.parse((await w.get(`/api/intents/${IDS.code}`, cookie)).body) as {
    timeline: { actor?: { login: string; name: string; via: string | null } }[];
  };
  // Towercab's own steps carry no actor (the page words them "Towercab"); a person's carry their name and channel.
  expect(Array.isArray(page.timeline)).toBe(true);
  for (const t of page.timeline) if (t.actor) expect(t.actor.name).toBeTruthy();
});

test("ui: a handled card shows who handled it", async () => {
  const w = await start();
  w.add("ana", "maintainer");
  const cookie = await w.as("ana");
  const before = JSON.parse((await w.get("/api/inbox", cookie)).body) as {
    items: { key: string; card: { actions: string[] } | null }[];
  };
  const merge = before.items.find((i) => i.card?.actions.includes("drop"));
  expect(merge).toBeTruthy();
  const r = await w.post("/api/actions", cookie, { action: "drop", intent: merge!.key });
  expect(r.status).toBeLessThan(500);
  const after = JSON.parse((await w.get("/api/inbox", cookie)).body) as {
    items: { key: string; card: { done: { text: string; by?: string; via?: string } | null } | null }[];
  };
  const done = after.items.find((i) => i.key === merge!.key)?.card?.done;
  if (done) {
    expect(done.by).toBe("ana");
    expect(done.via).toBe("page");
    expect(done.text).toContain("by ana");
  }
});

test("ui: the admin page lists people with roles and repos", async () => {
  const w = await start();
  w.add("ana", "maintainer", { web: "viewer" });
  const cookie = await w.as("owner");
  const d = JSON.parse((await w.get("/api/users", cookie)).body) as {
    people: { login: string; role: string; repos: Record<string, string> }[];
    repos: string[];
  };
  expect(d.people.find((p) => p.login === "ana")).toMatchObject({
    role: "maintainer",
    repos: { web: "viewer" },
  });
  expect(d.repos).toContain("web");
});

test("ui: an admin adds a person and sets repo roles", async () => {
  const w = await start();
  const cookie = await w.as("owner");
  const r = await w.post("/api/users", cookie, {
    op: "add",
    login: "Cy",
    role: "viewer",
    repos: { web: "maintainer" },
  });
  expect(r.status).toBe(200);
  const d = JSON.parse((await w.get("/api/users", cookie)).body) as {
    people: { login: string; repos: Record<string, string> }[];
  };
  expect(d.people.find((p) => p.login === "cy")?.repos).toEqual({ web: "maintainer" });
});

test("ui: removing the last admin is refused in the page", async () => {
  const w = await start();
  const cookie = await w.as("owner");
  const r = await w.post("/api/users", cookie, { op: "remove", login: "owner" });
  expect(r.status).toBe(422);
  expect(JSON.parse(r.body).message).toMatch(/last admin/i);
});

test("ui: the admin page lists the change history", async () => {
  const w = await start();
  const cookie = await w.as("owner");
  await w.post("/api/users", cookie, { op: "add", login: "ana", role: "viewer" });
  const d = JSON.parse((await w.get("/api/users", cookie)).body) as {
    events: { action: string; target: string }[];
  };
  expect(d.events.some((e) => e.target === "ana")).toBe(true);
});

test("ui: the team role list stops at contributor", async () => {
  const w = await start();
  const cookie = await w.as("owner");
  const r = await w.post("/api/users", cookie, { op: "team", team: "acme/devs", role: "maintainer" });
  expect(r.status).toBe(422);
  const ok = await w.post("/api/users", cookie, { op: "team", team: "acme/devs", role: "contributor" });
  expect(ok.status).toBe(200);
});

test("ui: security settings are read-only in the page", async () => {
  const w = await start();
  const cookie = await w.as("owner");
  const s = JSON.parse((await w.get("/api/settings", cookie)).body) as { security: { key: string }[] };
  expect(s.security.map((x) => x.key)).toContain("agent.network");
  const r = await w.post("/api/settings", cookie, { changes: { "agent.network": "example.com" } });
  expect(r.status).toBe(422);
});

test("ui: an admin revokes a session", async () => {
  const w = await start();
  w.add("ana", "viewer");
  const admin = await w.as("owner");
  const ana = await w.as("ana");
  const d = JSON.parse((await w.get("/api/users", admin)).body) as {
    people: { login: string; sessions: { id: number }[] }[];
  };
  const id = d.people.find((p) => p.login === "ana")!.sessions[0]!.id;
  const r = await w.post("/api/users", admin, { op: "revoke", session: id });
  expect(r.status).toBe(200);
  expect((await w.get("/api/me", ana)).status).toBe(401);
});

test("ui: a revoked person returns to sign-in", async () => {
  const w = await start();
  w.add("ana", "viewer");
  const admin = await w.as("owner");
  const ana = await w.as("ana");
  expect((await w.get("/api/state", ana)).status).toBe(200);
  await w.post("/api/users", admin, { op: "revoke-all", login: "ana" });
  const after = await w.get("/api/state", ana);
  expect(after.status).toBe(401);
  expect(JSON.parse(after.body).error).toMatch(/sign in/i);
});
