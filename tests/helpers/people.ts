// A page with sign-in on, for the users tests: the UI fixture, an `Auth` with a fake GitHub, a server,
// and `as(login)` to get that person's cookie.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Http } from "../../src/github/app.ts";
import { startUi } from "../../src/ui/server.ts";
import type { UsersApiDeps } from "../../src/users/api.ts";
import { Auth, STATE_COOKIE } from "../../src/users/auth.ts";
import { addUser, ensureFirstAdmin } from "../../src/users/store.ts";
import type { Role, User } from "../../src/users.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";
import { call } from "../ui/http.ts";

export const PUBLIC = "https://tc.example.com";
export const ADMIN: User = { login: "owner", role: "admin", repos: {} };

export interface People {
  f: Fixture;
  auth: Auth;
  port: number;
  token: string;
  clock: { t: number };
  /** Whether the fake GitHub knows an account (default: all do). */
  github: { exists: boolean; login: string };
  /** The cookie of a signed-in person (add them first with `add`). */
  as(login: string): Promise<string>;
  add(login: string, role: Role, repos?: Record<string, Role>): void;
  /** A GET with a cookie. */
  get(path: string, cookie?: string): ReturnType<typeof call>;
  /** A POST to `/api/actions` or another API path, from `public_url`, with the page token. */
  post(path: string, cookie: string, body: unknown, origin?: string): ReturnType<typeof call>;
  stop(): Promise<void>;
}

export async function people(): Promise<People> {
  const f = buildFixture({ now: 1_000_000 });
  const clock = { t: 1_000_000 };
  const github = { exists: true, login: "" };
  f.sources.config.agent.parallel = 2;
  ensureFirstAdmin(f.db, "owner", clock.t);
  writeFileSync(
    f.sources.config.file,
    '# Towercab\n[agent]\nparallel = 2 # how many\ndaily_budget_usd = 40\nmonthly_budget_usd = 900\n\n[github]\napp_id = 1\nme = "owner"\n',
  );
  const http: Http = async (req) => {
    if (req.url.endsWith("/login/oauth/access_token")) return { status: 200, text: '{"access_token":"t"}' };
    return { status: 200, text: JSON.stringify({ login: github.login }) };
  };
  const auth = new Auth({
    db: f.db,
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
    inTeam: async () => false,
    random: () => "STATE",
  });
  const deps: UsersApiDeps = {
    db: f.db,
    config: f.sources.config,
    now: () => clock.t,
    exists: async () => github.exists,
  };
  const ui = startUi({
    port: 0,
    auth,
    people: deps,
    sources: f.sources,
    actions: f.actions,
    distDir: join(f.root, "dist"),
    log: () => {},
  });
  const port = await ui.ready;
  const w: People = {
    f,
    auth,
    port,
    token: ui.token,
    clock,
    github,
    async as(login) {
      github.login = login;
      const out = await auth.callback("code", "STATE", `${STATE_COOKIE}=STATE`);
      if (!out.ok) throw new Error(out.message);
      return out.cookies[0]!.split(";")[0]!;
    },
    add(login, role, repos = {}) {
      addUser(f.db, ADMIN, login, { role, repos }, clock.t);
    },
    get: (path, cookie) => call(port, { path, headers: cookie ? { Cookie: cookie } : {} }),
    post: (path, cookie, body, origin = PUBLIC) =>
      call(port, {
        method: "POST",
        path,
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
          "X-Towercab-Token": ui.token,
        },
        body: JSON.stringify(body),
      }),
    stop: () => ui.stop(),
  };
  return w;
}
