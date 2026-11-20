import { expect, test } from "vitest";
import { ACTIONS } from "../src/ui/server.ts";
import { ACTION_PERMISSION } from "../src/ui/session.ts";
import { IDS } from "../ui/fixture.ts";
import { ORIGIN, serveAuth } from "./helpers/auth-server.ts";

const act = (action: string, extra: Record<string, unknown> = {}) => ({ action, intent: IDS.ci, ...extra });

test("users: the api needs a session", async () => {
  const w = await serveAuth();
  for (const path of ["/api/state", "/api/board", "/api/me", "/api/inbox", "/api/events"]) {
    expect((await w.get(path)).status, path).toBe(401);
  }
  expect((await w.post("/api/actions", act("merge"))).status).toBe(401);
  expect(w.f.calls).toEqual([]);
  expect((await w.get("/api/state", "vic")).status).toBe(200);
  // A revoked session fails at once.
  await w.post("/api/users", { op: "revokeAll", login: "vic" }, "owner");
  expect((await w.get("/api/state", "vic")).status).toBe(401);
  // The sign-in routes and the page itself need no session.
  expect((await w.get("/api/auth/login")).status).toBe(302);
  expect((await w.get("/board")).status).toBe(200);
});

test("users: a post from another origin is refused", async () => {
  const w = await serveAuth();
  for (const origin of ["https://evil.example", `http://${"tc.example"}`, ""]) {
    const r = await w.post("/api/actions", act("merge"), "owner", { Origin: origin });
    expect(r.status, origin).toBe(403);
  }
  expect(w.f.calls).toEqual([]);
  expect((await w.post("/api/actions", act("merge"), "owner", { Origin: ORIGIN })).status).toBe(200);
  expect(w.f.calls).toEqual([{ action: "merge", intent: IDS.ci }]);
});

test("users: the api refuses an action the role does not allow", async () => {
  const w = await serveAuth();
  // ana is a maintainer on web only: web's intent passes, api's is refused with the reason.
  expect((await w.post("/api/actions", act("merge"), "ana")).status).toBe(200);
  const refused = await w.post("/api/actions", { action: "merge", intent: IDS.plan, repo: "web" }, "ana");
  expect(refused.status).toBe(403);
  expect(JSON.parse(refused.body).message).toContain("your role (viewer) can't merge on api");
  // A contributor can't merge; an admin can; the body's repo can't stand in for the intent's.
  expect((await w.post("/api/actions", act("merge"), "con")).status).toBe(403);
  expect((await w.post("/api/actions", act("merge"), "owner")).status).toBe(200);
  expect(w.f.calls.map((c) => c.intent)).toEqual([IDS.ci, IDS.ci]);
  // Only an admin changes users.
  expect((await w.post("/api/users", { op: "disable", login: "vic" }, "ana")).status).toBe(403);
  expect((await w.get("/api/users", "ana")).status).toBe(403);
  expect((await w.get("/api/users", "owner")).status).toBe(200);
});

test("users: a viewer gets 403 on every action route", async () => {
  const w = await serveAuth();
  // Every action the server knows has a permission, and none is open to a viewer.
  expect([...ACTIONS].sort()).toEqual(Object.keys(ACTION_PERMISSION).sort());
  for (const action of ACTIONS) {
    const r = await w.post(
      "/api/actions",
      act(action, { repo: "web", pr: 1, head: "abcdef1", text: "x" }),
      "vic",
    );
    expect(r.status, action).toBe(403);
  }
  expect(w.f.calls).toEqual([]);
});

test("users: a viewer can read every repo", async () => {
  const w = await serveAuth();
  const board = JSON.parse((await w.get("/api/board", "vic")).body);
  const text = JSON.stringify(board);
  for (const repo of ["web", "api", "docs"]) expect(text).toContain(`"${repo}"`);
  for (const path of ["/api/state", "/api/queue", "/api/repos", "/api/inbox", "/api/activity"]) {
    expect((await w.get(path, "vic")).status, path).toBe(200);
  }
  expect((await w.get(`/api/intents/${IDS.plan}`, "vic")).status).toBe(200);
  const me = JSON.parse((await w.get("/api/me", "vic")).body);
  expect(me).toMatchObject({ auth: true, login: "vic", role: "viewer" });
});

test("users: config secrets are never in a read", async () => {
  const w = await serveAuth();
  const secret = "123456:SECRET-bot-token-value";
  w.f.sources.config.telegram = { botToken: secret, chatId: "1", apiBase: "https://t.example" };
  w.f.state.problems = [{ title: `bad ${secret}`, detail: `see ${secret}`, fix: "", since: 1 }];
  for (const who of ["vic", "owner"]) {
    for (const path of ["/api/state", "/api/me", "/api/users", "/api/inbox"]) {
      const r = await w.get(path, who);
      expect(r.body, `${who} ${path}`).not.toContain(secret);
    }
  }
});
