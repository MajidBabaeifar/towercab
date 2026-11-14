// USR-7, USR-13, USR-14: the API checks the role itself, reads show everything but no secrets, and an
// admin manages people and settings.

import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { type People, people } from "./helpers/people.ts";

const open: People[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});
async function world(): Promise<People> {
  const w = await people();
  open.push(w);
  return w;
}
const json = (r: { body: string }) => JSON.parse(r.body);
const intentIn = async (w: People, repo: string) =>
  (await w.f.store.list()).open.find((i) => i.repo === repo)!.id;

// One valid-looking body per action route; the role check comes before anything else looks at it.
const BODIES: Record<string, Record<string, unknown>> = {
  autonomy: { a: 2 },
  scores: { u: 3, i: 3 },
  boost: {},
  merge: {},
  pass: {},
  reply: { text: "ok" },
  retry: {},
  drop: {},
  start: {},
  step: { n: 1 },
  secret: { n: 1, value: "x" },
  "approve-secret": { n: 1 },
  done: { text: "done" },
  steps: {},
  pause: {},
  resume: {},
  "apply-settings": { repo: "web" },
  scanningGranted: {},
  addRepo: { github: "acme/new" },
  features: { repo: "web" },
  accept: { pr: 1, head: "abcdef1" },
  close: { pr: 1 },
  shadowReset: {},
  "repo-settings": { repo: "web", changes: {} },
  "repo-move": { repo: "web" },
  budgets: { scope: "all", daily: 10 },
  seen: { item: "x" },
  snooze: { item: "x", until: "tomorrow" },
  unsnooze: { item: "x" },
};

test("users: the api needs a session", async () => {
  const w = await world();
  for (const path of ["/api/state", "/api/board", "/api/inbox", "/api/me", "/api/users", "/api/settings"]) {
    expect((await w.get(path)).status, path).toBe(401);
  }
  expect((await w.post("/api/actions", "", { action: "pause" })).status).toBe(401);
  w.add("ana", "maintainer");
  expect((await w.get("/api/me", await w.as("ana"))).status).toBe(200);
});

test("users: the api refuses an action the role does not allow", async () => {
  const w = await world();
  w.add("cy", "contributor");
  w.add("max", "viewer", { web: "maintainer" });
  const web = await intentIn(w, "web");
  const api = await intentIn(w, "api");
  const cy = await w.post("/api/actions", await w.as("cy"), { action: "merge", intent: web });
  expect(cy.status).toBe(403);
  expect(json(cy).message).toBe("your role (contributor) can't merge on web");
  const max = await w.as("max");
  const other = await w.post("/api/actions", max, { action: "merge", intent: api });
  expect(other.status).toBe(403);
  expect(json(other).message).toBe("your role (viewer) can't merge on api");
  expect((await w.post("/api/actions", max, { action: "merge", intent: web })).status).not.toBe(403);
  // Settings and users are the admin's, however the page is used.
  expect((await w.post("/api/actions", max, { action: "budgets", scope: "all", daily: 5 })).status).toBe(403);
});

test("users: a viewer gets 403 on every action route", async () => {
  const w = await world();
  w.add("vi", "viewer");
  const cookie = await w.as("vi");
  const web = await intentIn(w, "web");
  for (const [action, body] of Object.entries(BODIES)) {
    const r = await w.post("/api/actions", cookie, { action, intent: web, ...body });
    expect(r.status, action).toBe(403);
    expect(json(r).message, action).toMatch(/^your role \(viewer\) can't \w+/);
  }
  expect((await w.post("/api/users", cookie, { op: "remove", login: "owner" })).status).toBe(403);
  expect((await w.post("/api/settings", cookie, { changes: { "agent.parallel": 3 } })).status).toBe(403);
  expect(w.f.calls).toEqual([]);
});

test("users: a viewer can read every repo", async () => {
  const w = await world();
  w.add("vi", "viewer");
  const cookie = await w.as("vi");
  for (const path of [
    "/api/state",
    "/api/queue",
    "/api/board",
    "/api/inbox",
    "/api/repos",
    "/api/activity",
    "/api/shadow",
    "/api/observer",
  ]) {
    expect((await w.get(path, cookie)).status, path).toBe(200);
  }
  const board = (await w.get("/api/board", cookie)).body;
  for (const repo of ["web", "api", "docs"]) {
    expect(board, repo).toContain(`"${repo}"`);
    const id = await intentIn(w, repo);
    expect((await w.get(`/api/intents/${id}`, cookie)).status, id).toBe(200);
  }
  expect(json(await w.get("/api/me", cookie))).toMatchObject({ login: "vi", role: "viewer", auth: true });
});

test("users: config secrets are never in a read", async () => {
  const w = await world();
  const secret = "123456:AAH-secret-bot-token";
  w.f.sources.config.telegram = { botToken: secret, chatId: "42", apiBase: "https://api.telegram.org" };
  w.add("vi", "viewer");
  const cookie = await w.as("vi");
  const admin = await w.as("owner");
  for (const path of [
    "/api/state",
    "/api/queue",
    "/api/board",
    "/api/inbox",
    "/api/repos",
    "/api/activity",
    "/api/me",
  ]) {
    const body = (await w.get(path, cookie)).body;
    expect(body, path).not.toContain(secret);
    expect(body, path).not.toContain("chatId");
  }
  for (const path of ["/api/settings", "/api/users"]) {
    expect((await w.get(path, cookie)).status, path).toBe(403);
    const body = (await w.get(path, admin)).body;
    expect(body, path).not.toContain(secret);
    expect(body, path).not.toContain("42");
  }
});

test("users: an admin adds a person with repo roles", async () => {
  const w = await world();
  const admin = await w.as("owner");
  const r = await w.post("/api/users", admin, {
    op: "add",
    login: "Ana",
    role: "viewer",
    repos: { web: "maintainer" },
    name: "Ana B",
  });
  expect(r.status).toBe(200);
  const view = json(await w.get("/api/users", admin));
  expect(view.people.find((p: { login: string }) => p.login === "ana")).toMatchObject({
    role: "viewer",
    repos: { web: "maintainer" },
    name: "Ana B",
    source: "added",
  });
  expect(view.repos).toContain("web");
  expect((await w.post("/api/users", admin, { op: "add", login: "ana" })).status).toBe(422);
  expect(
    (await w.post("/api/users", admin, { op: "add", login: "bo", repos: { web: "admin" } })).status,
  ).toBe(422);
});

test("users: only an admin manages users", async () => {
  const w = await world();
  w.add("max", "maintainer");
  const cookie = await w.as("max");
  expect((await w.get("/api/users", cookie)).status).toBe(403);
  const r = await w.post("/api/users", cookie, { op: "add", login: "eve", role: "admin" });
  expect(r.status).toBe(403);
  expect(json(r).message).toBe("your role (maintainer) can't manage_users");
  expect(
    json(await w.get("/api/users", await w.as("owner"))).people.map((p: { login: string }) => p.login),
  ).not.toContain("eve");
});

test("users: every user change is recorded", async () => {
  const w = await world();
  const admin = await w.as("owner");
  await w.post("/api/users", admin, { op: "add", login: "ana", role: "viewer" });
  await w.post("/api/users", admin, { op: "change", login: "ana", role: "maintainer" });
  await w.post("/api/users", admin, { op: "disable", login: "ana" });
  await w.post("/api/users", admin, { op: "team", team: "acme/devs", role: "contributor" });
  await w.post("/api/users", admin, { op: "remove", login: "ana" });
  const events = json(await w.get("/api/users", admin)).events as {
    actor: string;
    action: string;
    target: string;
  }[];
  const mine = events.filter((e) => e.actor === "owner").map((e) => e.action);
  expect(mine).toEqual(["remove", "team", "disable", "change", "add"]);
  expect(events[0]).toMatchObject({ actor: "owner", target: "ana" });
  // The last admin can't be removed, changed or disabled.
  for (const op of ["remove", "disable"]) {
    const r = await w.post("/api/users", admin, { op, login: "owner" });
    expect(r.status).toBe(422);
    expect(json(r).message).toMatch(/last admin/);
  }
});

test("users: adding an unknown github login fails", async () => {
  const w = await world();
  const admin = await w.as("owner");
  w.github.exists = false;
  const r = await w.post("/api/users", admin, { op: "add", login: "nobody-real", role: "viewer" });
  expect(r.status).toBe(422);
  expect(json(r).message).toBe("nobody-real isn't a GitHub account");
  expect(json(await w.get("/api/users", admin)).people.map((p: { login: string }) => p.login)).toEqual([
    "owner",
  ]);
});

test("users: an admin changes a setting and writes only that key to the config file", async () => {
  const w = await world();
  const admin = await w.as("owner");
  const file = w.f.sources.config.file;
  const before = readFileSync(file, "utf8");
  const r = await w.post("/api/settings", admin, { changes: { "agent.parallel": 3 } });
  expect(r.status).toBe(200);
  const after = readFileSync(file, "utf8");
  expect(after).toBe(before.replace("parallel = 2 # how many", "parallel = 3 # how many"));
  const bad = await w.post("/api/settings", admin, { changes: { "agent.parallel": 99 } });
  expect(bad.status).toBe(422);
  expect(readFileSync(file, "utf8")).toBe(after);
  const events = json(await w.get("/api/users", admin)).events as {
    action: string;
    target: string;
    detail: string;
  }[];
  expect(events[0]).toMatchObject({ action: "setting", target: "agent.parallel", detail: "2 → 3" });
  const view = json(await w.get("/api/settings", admin));
  expect(view.editable.find((s: { key: string }) => s.key === "agent.parallel").value).toBe(2);
});

test("users: a security setting is refused from the page", async () => {
  const w = await world();
  const admin = await w.as("owner");
  const file = w.f.sources.config.file;
  const before = readFileSync(file, "utf8");
  for (const key of [
    "agent.network",
    "intents.issue_a",
    "agent.sandbox_unix_sockets",
    "telegram.bot_token",
    "auth.listen",
    "agent.monthly_budget_usd",
  ]) {
    const r = await w.post("/api/settings", admin, { changes: { [key]: 1 } });
    expect(r.status, key).toBe(422);
    expect(json(r).message, key).toBe(`${key}: this is a security setting: edit the config file`);
  }
  expect(readFileSync(file, "utf8")).toBe(before);
  const view = json(await w.get("/api/settings", admin));
  expect(view.security.map((s: { key: string }) => s.key)).toContain("agent.network");
});

test("users: a budget above its cap is refused", async () => {
  const w = await world();
  const admin = await w.as("owner");
  const file = w.f.sources.config.file;
  const over = await w.post("/api/settings", admin, { changes: { "agent.daily_budget_usd": 1000 } });
  expect(over.status).toBe(422);
  expect(json(over).message).toMatch(/above its cap of \$900/);
  const none = await w.post("/api/settings", admin, { changes: { "agent.daily_budget_usd": null } });
  expect(none.status).toBe(422);
  expect(readFileSync(file, "utf8")).toContain("daily_budget_usd = 40\n");
  const ok = await w.post("/api/settings", admin, { changes: { "agent.daily_budget_usd": 60 } });
  expect(ok.status).toBe(200);
  expect(readFileSync(file, "utf8")).toContain("daily_budget_usd = 60\n");
  expect(w.f.sources.config.agent.dailyBudgetUsd).toBe(60);
});
