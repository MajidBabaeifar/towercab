// A page server with sign-in, a fixture behind it and people with roles, for the users-* tests (USR-7).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Http } from "../../src/github/app.ts";
import { Auth } from "../../src/ui/auth.ts";
import { startUi } from "../../src/ui/server.ts";
import type { UsersApiDeps } from "../../src/ui/users-api.ts";
import { addUser, createSession, seedOwner } from "../../src/users-store.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";
import { call, type Reply } from "../ui/http.ts";
import { tempDir } from "./world.ts";

export const HOST = "tc.example";
export const ORIGIN = `https://${HOST}`;
export const LIMITS = { idleSecs: 12 * 3600, maxSecs: 7 * 86_400 };

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

export interface AuthWorld {
  f: Fixture;
  port: number;
  /** A cookie header for each signed-in person, by login. */
  cookie: Record<string, string>;
  tokens: Record<string, string>;
  /** GitHub accounts the fake knows, for adding people. */
  accounts: Set<string>;
  get(path: string, who?: string | null): Promise<Reply>;
  /** A POST with the right Origin unless overridden. */
  post(path: string, body: unknown, who?: string | null, headers?: Record<string, string>): Promise<Reply>;
}

/** The people: owner (admin), ana (maintainer on web, viewer on api), vic (viewer), con (contributor). */
export async function serveAuth(configToml = "[agent]\ndaily_budget_usd = 40\nmonthly_budget_usd = 900\n") {
  const f = buildFixture();
  cleanup.push(() => f.cleanup());
  writeFileSync(f.sources.config.file, configToml);
  const db = f.sources.db;
  const now = f.sources.clock.now();
  seedOwner(db, "owner", now);
  addUser(db, { login: "ana", role: "viewer", repoRoles: { web: "maintainer" }, by: "owner" }, now);
  addUser(db, { login: "vic", role: "viewer", by: "owner" }, now);
  addUser(db, { login: "con", role: "contributor", by: "owner" }, now);
  const accounts = new Set(["newbie"]);
  const http: Http = async () => ({ status: 500, text: "" });
  const limits = LIMITS;
  const users: UsersApiDeps = {
    db,
    config: f.sources.config,
    now: () => f.sources.clock.now(),
    limits,
    lookup: async (login) => (accounts.has(login.toLowerCase()) ? { login, name: `${login} Name` } : null),
  };
  const auth = new Auth({
    db,
    app: { clientId: "id", clientSecret: "secret", redirectUri: `${ORIGIN}/api/auth/callback` },
    http,
    limits,
  });
  const dist = tempDir("tc-dist-");
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    '<!doctype html><meta name="towercab-token" content=""><title>T</title>',
  );
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions: f.actions,
    distDir: dist,
    log: () => {},
    pollMs: 20,
    auth: {
      config: {
        clientId: "id",
        clientSecretEnv: "X",
        publicUrl: ORIGIN,
        listen: "127.0.0.1",
        sessionHours: 12,
        sessionDays: 7,
      },
      auth,
      limits,
      users,
    },
  });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const tokens: Record<string, string> = {};
  const cookie: Record<string, string> = {};
  for (const login of ["owner", "ana", "vic", "con"]) {
    tokens[login] = createSession(db, login, now, limits);
    cookie[login] = `tc_session=${tokens[login]}`;
  }
  const world: AuthWorld = {
    f,
    port,
    cookie,
    tokens,
    accounts,
    get: (path, who = null) =>
      call(port, { path, headers: { Host: HOST, ...(who ? { Cookie: cookie[who]! } : {}) } }),
    post: (path, body, who = null, headers = {}) =>
      call(port, {
        method: "POST",
        path,
        headers: {
          Host: HOST,
          "Content-Type": "application/json",
          Origin: ORIGIN,
          ...(who ? { Cookie: cookie[who]! } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
  };
  return world;
}

export const readFile = (f: Fixture) => readFileSync(f.sources.config.file, "utf8");
