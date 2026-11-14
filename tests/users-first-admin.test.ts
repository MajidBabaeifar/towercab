// USR-6: the owner is the first admin when sign-in is switched on; USR-5: a proposal is accepted or closed on
// the repo its own intent file names, not one the request supplies.

import { afterEach, expect, test } from "vitest";
import type { ProposedPr } from "../src/github/proposed.ts";
import type { Loop } from "../src/loop.ts";
import { authOf } from "../src/ui/wire.ts";
import { getUser } from "../src/users/store.ts";
import { buildFixture } from "../ui/fixture.ts";
import { type People, people } from "./helpers/people.ts";

const open: People[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});

test("users: sign-in setup makes the owner the first admin", () => {
  const f = buildFixture({ now: 1_000_000 });
  try {
    const config = f.sources.config;
    config.auth = {
      clientId: "id",
      clientSecretEnv: "S",
      publicUrl: "https://tc.example.com",
      listen: "127.0.0.1",
      sessionHours: 12,
      sessionDays: 7,
    };
    expect(getUser(f.db, "owner")).toBeNull();
    const loop = { d: { db: f.db, clock: { now: () => 1_000_000 } } } as unknown as Loop;
    authOf(loop, config, {} as never);
    expect(getUser(f.db, "owner")).toMatchObject({ login: "owner", role: "admin" });
    // Idempotent: a second start adds no one.
    authOf(loop, config, {} as never);
    expect(getUser(f.db, "owner")?.role).toBe("admin");
  } finally {
    f.cleanup();
  }
});

const proposal = (number: number, repo: string | null): ProposedPr => ({
  number,
  url: `https://github.com/acme/intents/pull/${number}`,
  title: "Add it",
  draft: false,
  proposer: "outsider",
  createdAt: 1,
  head: "abcdef1",
  path: "x.md",
  intent: repo ? { title: "Add it", repo, u: 3, i: 3, a: 5, source: "me" } : null,
  textUrl: null,
  acceptable: true,
  reason: null,
});

test("users: a proposal is gated on its own repo", async () => {
  const w = await people();
  open.push(w);
  w.f.sources.proposed = () => ({
    list: [proposal(5, "api"), proposal(6, "web"), proposal(7, null)],
    error: null,
    failedAt: null,
  });
  w.add("ma", "viewer", { web: "maintainer" });
  const cookie = await w.as("ma");
  const body = (pr: number, repo: string) => ({ action: "accept", pr, head: "abcdef1", repo });
  // The request names web, but the proposal is for api: refused.
  expect((await w.post("/api/actions", cookie, body(5, "web"))).status).toBe(403);
  expect((await w.post("/api/actions", cookie, { ...body(5, "web"), action: "close" })).status).toBe(403);
  // A proposal whose intent file can't be read is refused.
  expect((await w.post("/api/actions", cookie, body(7, "web"))).status).toBe(403);
  // The proposal for web passes the role check.
  expect((await w.post("/api/actions", cookie, body(6, "api"))).status).not.toBe(403);
});
