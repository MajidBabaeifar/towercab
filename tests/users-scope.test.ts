import { expect, test } from "vitest";
import { voicesFor } from "../src/github/voices.ts";
import type { StoredUser } from "../src/users-store.ts";
import { serveAuth } from "./helpers/auth-server.ts";
import { testDb } from "./helpers/world.ts";

const person = (login: string, role: StoredUser["role"]): StoredUser => ({
  login,
  name: login,
  role,
  repoRoles: {},
  disabled: false,
  addedBy: "root",
  added: 0,
  lastSeen: null,
});

test("users: a maintainer does not decide an a0 intent on github", () => {
  const people: Record<string, StoredUser> = {
    mia: person("mia", "maintainer"),
    root: person("root", "admin"),
  };
  const lookup = (l: string) => people[l] ?? null;
  const normal = voicesFor(testDb(), "web", "i-1", lookup, "web", false);
  expect(normal.decides("mia")).toBe(true);
  const a0 = voicesFor(testDb(), "web", "i-1", lookup, "web", true);
  expect(a0.decides("mia")).toBe(false);
  expect(a0.decides("root")).toBe(true);
});

test("users: a named repo cannot stand in for a proposal's or a pause's scope", async () => {
  const w = await serveAuth();
  // ana is a viewer by default and a maintainer on web only.
  for (const body of [
    { action: "accept", pr: 5, head: "abcdef0", repo: "web" },
    { action: "close", pr: 5, repo: "web" },
    { action: "pause", repo: "web" },
    { action: "resume", repo: "web" },
  ]) {
    const r = await w.post("/api/actions", body, "ana");
    expect(r.status, body.action).toBe(403);
  }
});
