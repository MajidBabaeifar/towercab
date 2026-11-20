import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { redeemLinkCode } from "../../src/telegram/people.ts";
import { startUi } from "../../src/ui/server.ts";
import { buildFixture, IDS } from "../../ui/fixture.ts";
import { serveAuth } from "../helpers/auth-server.ts";
import { tempDir } from "../helpers/world.ts";
import { call } from "./http.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

/** The fixture's `[auth]`, switched on after the fact so the cards read it (USR-3). */
const AUTH = {
  clientId: "id",
  clientSecretEnv: "X",
  publicUrl: "https://tc.example",
  listen: "127.0.0.1",
  sessionHours: 12,
  sessionDays: 7,
};
const withAuth = (w: Awaited<ReturnType<typeof serveAuth>>) => {
  (w.f.sources.config as { auth: unknown }).auth = AUTH;
  (w.f.sources.config as { telegram: unknown }).telegram = {
    botToken: "t",
    chatId: "1",
    apiBase: "https://tg.test",
  };
};
const missionOf = (w: Awaited<ReturnType<typeof serveAuth>>, intent: string) =>
  w.f.sources.db.get<{ id: number }>(
    "SELECT id FROM missions WHERE intent = ? ORDER BY id DESC LIMIT 1",
    intent,
  )!.id;

test("ui: without auth config there is no sign-in", async () => {
  const f = buildFixture();
  stops.push(() => f.cleanup());
  const dist = tempDir("tc-dist-");
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    '<!doctype html><meta name="towercab-token" content=""><title>T</title>',
  );
  const ui = startUi({ port: 0, sources: f.sources, actions: f.actions, distDir: dist, log: () => {} });
  stops.push(() => ui.stop());
  const port = await ui.ready;
  const me = await call(port, { path: "/api/me" });
  expect(me.status).toBe(200);
  expect(JSON.parse(me.body)).toMatchObject({ auth: false, role: "admin" });
  expect((await call(port, { path: "/api/state" })).status).toBe(200);
});

test("ui: a card shows who acted and how", async () => {
  const w = await serveAuth();
  withAuth(w);
  const id = missionOf(w, IDS.code);
  w.f.sources.db.run(
    "INSERT INTO transitions (mission, at, from_stage, event, to_stage, actor, via) VALUES (?, 1, 'build', 'answered', 'build', 'ana', 'telegram')",
    id,
  );
  const inbox = JSON.parse((await w.get("/api/inbox", "vic")).body);
  const card = inbox.items.find((i: { key: string }) => i.key === IDS.code).card;
  expect(card.lastBy).toBe("Answered by ana · Telegram");
  // The people who may decide are named: the admin and ana (a maintainer on web).
  expect(card.alsoCanDecide).toContain("owner");
  expect(card.alsoCanDecide).not.toContain("vic");
});

test("ui: the timeline names every actor", async () => {
  const w = await serveAuth();
  withAuth(w);
  const id = missionOf(w, IDS.ci);
  const add = (event: string, actor: string, via: string) =>
    w.f.sources.db.run(
      "INSERT INTO transitions (mission, at, from_stage, event, to_stage, actor, via) VALUES (?, 2, 'build', ?, 'build', ?, ?)",
      id,
      event,
      actor,
      via,
    );
  add("answered", "ana", "page");
  add("head_moved", "towercab", "");
  const page = JSON.parse((await w.get(`/api/intents/${IDS.ci}`, "vic")).body);
  const by = page.timeline.map((t: { by?: string }) => t.by).filter(Boolean);
  expect(by).toContain("ana · page");
  expect(by).toContain("Towercab");
});

test("ui: a handled card shows who handled it", async () => {
  const w = await serveAuth();
  withAuth(w);
  const first = JSON.parse((await w.get(`/api/intents/${IDS.code}`, "vic")).body);
  const m = w.f.sources.db.get<{ id: number; data: string; stage: string }>(
    "SELECT id, data, stage FROM missions WHERE intent = ? ORDER BY id DESC LIMIT 1",
    IDS.code,
  )!;
  const note = {
    action: "merge",
    stage: m.stage,
    pr: first.card.pr?.number ?? 0,
    at: 1,
    by: "ana",
    via: "page",
  };
  w.f.sources.db.run(
    "UPDATE missions SET data = ? WHERE id = ?",
    JSON.stringify({ ...JSON.parse(m.data), doneByYou: note }),
    m.id,
  );
  const page = JSON.parse((await w.get(`/api/intents/${IDS.code}`, "vic")).body);
  expect(page.card.handledBy).toBe("ana · page");
  expect(page.card.done.text).toContain("by ana · page");
});

test("ui: linking telegram shows a one-time code", async () => {
  const w = await serveAuth();
  withAuth(w);
  const me = JSON.parse((await w.get("/api/me", "ana")).body);
  expect(me.telegram).toEqual({ available: true, linked: false });
  const r = await w.post("/api/me/telegram", { op: "code" }, "ana");
  expect(r.status).toBe(200);
  const { code } = JSON.parse(r.body);
  expect(code).toMatch(/^[0-9A-F]{10}$/);
  // The code links a chat once; the page then shows it as linked, and unlinking works.
  expect(redeemLinkCode(w.f.sources.db, code, "555", w.f.sources.clock.now())?.login).toBe("ana");
  expect(JSON.parse((await w.get("/api/me", "ana")).body).telegram.linked).toBe(true);
  expect((await w.post("/api/me/telegram", { op: "unlink" }, "ana")).status).toBe(200);
  expect(JSON.parse((await w.get("/api/me", "ana")).body).telegram.linked).toBe(false);
  // A post from another origin is refused.
  expect(
    (await w.post("/api/me/telegram", { op: "code" }, "ana", { Origin: "https://evil.example" })).status,
  ).toBe(403);
});

test("ui: removing the last admin is refused in the page", async () => {
  const w = await serveAuth();
  const r = await w.post("/api/users", { op: "remove", login: "owner" }, "owner");
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(JSON.parse(r.body).message).toContain("last admin");
});

test("ui: a revoked person returns to sign-in", async () => {
  const w = await serveAuth();
  expect((await w.get("/api/me", "vic")).status).toBe(200);
  await w.post("/api/users", { op: "revokeAll", login: "vic" }, "owner");
  expect((await w.get("/api/me", "vic")).status).toBe(401);
});

test("users: the timeline names who acted", async () => {
  const w = await serveAuth();
  withAuth(w);
  w.f.sources.db.run("UPDATE users SET name = 'Ana Diaz' WHERE login = 'ana'");
  const id = missionOf(w, IDS.ci);
  w.f.sources.db.run(
    "INSERT INTO transitions (mission, at, from_stage, event, to_stage, actor, via) VALUES (?, 3, 'build', 'closed', 'build', 'ana', 'github')",
    id,
  );
  const page = JSON.parse((await w.get(`/api/intents/${IDS.ci}`, "vic")).body);
  expect(page.timeline.map((t: { by?: string }) => t.by)).toContain("Ana Diaz · GitHub");
});
