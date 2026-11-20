import { expect, test } from "vitest";
import { userEvents } from "../src/users-store.ts";
import { readFile, serveAuth } from "./helpers/auth-server.ts";

const users = (w: Awaited<ReturnType<typeof serveAuth>>, who: string | null, body: unknown) =>
  w.post("/api/users", body, who);
const msg = (r: { body: string }) => (JSON.parse(r.body) as { message?: string }).message ?? "";

test("users: an admin adds a person with repo roles", async () => {
  const w = await serveAuth();
  const r = await users(w, "owner", {
    op: "add",
    login: "Newbie",
    role: "viewer",
    repoRoles: { web: "maintainer" },
  });
  expect(r.status).toBe(200);
  const added = JSON.parse(r.body).users.find((u: { login: string }) => u.login === "newbie");
  expect(added).toMatchObject({ role: "viewer", repoRoles: { web: "maintainer" }, name: "Newbie Name" });
  // Admin is never per repo.
  const bad = await users(w, "owner", { op: "change", login: "vic", repoRoles: { web: "admin" } });
  expect(bad.status).toBe(422);
  expect(msg(bad)).toContain("admin is never per repo");
});

test("users: adding an unknown github login fails", async () => {
  const w = await serveAuth();
  const r = await users(w, "owner", { op: "add", login: "ghost", role: "viewer" });
  expect(r.status).toBe(422);
  expect(msg(r)).toBe("ghost isn't a GitHub account");
  expect(
    JSON.parse((await w.get("/api/users", "owner")).body).users.map((u: { login: string }) => u.login),
  ).not.toContain("ghost");
});

test("users: only an admin manages users", async () => {
  const w = await serveAuth();
  for (const who of ["ana", "vic", "con"]) {
    expect((await users(w, who, { op: "disable", login: "vic" })).status, who).toBe(403);
    expect(
      (await w.post("/api/settings", { key: "agent.daily_budget_usd", value: 10 }, who)).status,
      who,
    ).toBe(403);
  }
  expect((await users(w, null, { op: "disable", login: "vic" })).status).toBe(401);
  expect((await users(w, "owner", { op: "disable", login: "vic" })).status).toBe(200);
});

test("users: every user change is recorded", async () => {
  const w = await serveAuth();
  await users(w, "owner", { op: "add", login: "newbie", role: "contributor" });
  await users(w, "owner", { op: "change", login: "newbie", role: "maintainer" });
  await users(w, "owner", { op: "disable", login: "newbie" });
  await users(w, "owner", { op: "team", team: "acme/devs", role: "contributor" });
  await users(w, "owner", { op: "remove", login: "newbie" });
  const events = userEvents(w.f.sources.db)
    .slice(0, 5)
    .map((e) => `${e.what} ${e.login}`.trim());
  expect(events).toEqual(
    ["added newbie", "changed newbie", "disabled newbie", "team named", "removed newbie"].reverse(),
  );
  const shown = JSON.parse((await w.get("/api/users", "owner")).body).events;
  expect(shown.length).toBeGreaterThanOrEqual(5);
  // The last admin can't go.
  expect(msg(await users(w, "owner", { op: "remove", login: "owner" }))).toContain("last admin");
});

test("users: an admin changes a setting and writes only that key to the config file", async () => {
  const toml = '# mine\n[agent]\ndaily_budget_usd = 40 # keep\nmonthly_budget_usd = 900\nmodel = "opus"\n';
  const w = await serveAuth(toml);
  const r = await w.post("/api/settings", { key: "agent.daily_budget_usd", value: 25 }, "owner");
  expect(r.status).toBe(200);
  expect(readFile(w.f)).toBe(toml.replace("daily_budget_usd = 40", "daily_budget_usd = 25"));
});

test("users: a security setting is refused from the page", async () => {
  const toml = '[agent]\ndaily_budget_usd = 40\nnetwork = ["a.example"]\n';
  const w = await serveAuth(toml);
  for (const key of [
    "agent.network",
    "agent.sandbox_unix_sockets",
    "intents.issue_a",
    "auth.listen",
    "agent.cap_monthly",
  ]) {
    const r = await w.post("/api/settings", { key, value: "x" }, "owner");
    expect(r.status, key).toBe(403);
    expect(msg(r)).toBe("this is a security setting: edit the config file");
  }
  expect(readFile(w.f)).toBe(toml);
});

test("users: a budget above its cap is refused", async () => {
  const toml = "[agent]\ndaily_budget_usd = 40\nmonthly_budget_usd = 900\ncap_monthly = 1000\n";
  const w = await serveAuth(toml);
  const over = await w.post("/api/settings", { key: "agent.monthly_budget_usd", value: 1200 }, "owner");
  expect(over.status).toBe(403);
  expect(msg(over)).toContain("this is a security setting: edit the config file");
  expect(readFile(w.f)).toBe(toml);
  // Removing the limit would also go above the cap.
  expect(
    (await w.post("/api/settings", { key: "agent.monthly_budget_usd", value: null }, "owner")).status,
  ).toBe(403);
  const ok = await w.post("/api/settings", { key: "agent.monthly_budget_usd", value: 1000 }, "owner");
  expect(ok.status).toBe(200);
  expect(readFile(w.f)).toContain("monthly_budget_usd = 1000");
});
