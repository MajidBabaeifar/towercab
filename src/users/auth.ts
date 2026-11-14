// Sign-in with GitHub (USR-3) and sessions (USR-4). No passwords: the identity is the login GitHub's API
// returns for the OAuth code, and a session is a random token whose hash is all Towercab keeps.
// Times are unix seconds, like `Clock.now`.

import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { HTTP_TIMEOUT_MS, type Http } from "../github/app.ts";
import type { User } from "../users.ts";
import { People } from "./people.ts";

export const SESSION_COOKIE = "tc_session";
export const STATE_COOKIE = "tc_state";
const STATE_TTL_S = 600;

export const UNKNOWN_ACCOUNT = "This Towercab doesn't know your GitHub account. Ask an admin to add you.";

export interface AuthDeps {
  db: Db;
  auth: NonNullable<Config["auth"]>;
  http: Http;
  now(): number;
  /** The client secret (read from the variable `[auth].client_secret_env` names). */
  secret(): string;
  /** `[github].api_base`, where the login is read. */
  apiBase: string;
  /** Whether `login` is in the GitHub team `org/team`; throws when GitHub can't say. */
  inTeam(team: string, login: string): Promise<boolean>;
  /** Where the OAuth pages live (default `https://github.com`). */
  oauthBase?: string;
  random?(): string;
}

/** A signed-in request: who, and the session it came in on. */
export interface Signed {
  user: User;
  session: number;
}

export type Outcome =
  | { ok: true; location: string; cookies: string[] }
  | { ok: false; status: number; message: string; login?: string };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export class Auth {
  private readonly d: AuthDeps;
  private readonly people: People;

  constructor(d: AuthDeps) {
    this.d = d;
    this.people = new People(d);
  }

  /** USR-2: the person a login stands for now (see `People.resolve`). */
  resolve(login: string, fresh = false): Promise<User | null> {
    return this.people.resolve(login, fresh);
  }

  /** The origin POSTs must come from (USR-4). */
  get origin(): string {
    return new URL(this.d.auth.publicUrl).origin;
  }

  originOk(origin: string | undefined): boolean {
    return origin === this.origin;
  }

  private cookie(name: string, value: string, maxAge: number, path = "/"): string {
    return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  }

  /** USR-3: send the browser to GitHub with a fresh `state`, which the same browser must bring back. */
  start(): { location: string; cookies: string[] } {
    const state = (this.d.random ?? (() => randomBytes(24).toString("hex")))();
    const q = new URLSearchParams({
      client_id: this.d.auth.clientId,
      redirect_uri: `${this.origin}/auth/callback`,
      state,
    });
    return {
      location: `${this.d.oauthBase ?? "https://github.com"}/login/oauth/authorize?${q}`,
      cookies: [this.cookie(STATE_COOKIE, state, STATE_TTL_S, "/auth")],
    };
  }

  /** USR-3: the code and state on the way back. The login is read from GitHub's API, never from the browser. */
  async callback(code: string | null, state: string | null, cookies: string | undefined): Promise<Outcome> {
    const mine = cookieValue(cookies, STATE_COOKIE);
    if (!state || !mine || state !== mine) {
      return { ok: false, status: 400, message: "Sign-in failed: the state didn't match. Start again." };
    }
    if (!code) return { ok: false, status: 400, message: "Sign-in failed: GitHub sent no code." };
    let login: string;
    try {
      login = await this.loginFor(code);
    } catch (e) {
      return { ok: false, status: 502, message: `Sign-in failed: ${(e as Error).message}` };
    }
    const user = await this.resolve(login, true);
    if (!user) return { ok: false, status: 403, message: UNKNOWN_ACCOUNT, login };
    const token = randomBytes(32).toString("hex");
    const now = this.d.now();
    this.d.db.run(
      "INSERT INTO sessions (token_hash, login, created, last_seen, expires) VALUES (?, ?, ?, ?, ?)",
      hash(token),
      user.login,
      now,
      now,
      now + this.d.auth.sessionDays * 86_400,
    );
    this.d.db.run("UPDATE users SET last_seen = ? WHERE login = ?", now, user.login);
    return {
      ok: true,
      location: "/",
      cookies: [
        this.cookie(SESSION_COOKIE, token, this.d.auth.sessionDays * 86_400),
        this.cookie(STATE_COOKIE, "", 0, "/auth"),
      ],
    };
  }

  private async loginFor(code: string): Promise<string> {
    const base = this.d.oauthBase ?? "https://github.com";
    const t = await this.d.http({
      method: "POST",
      url: `${base}/login/oauth/access_token`,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.d.auth.clientId,
        client_secret: this.d.secret(),
        code,
        redirect_uri: `${this.origin}/auth/callback`,
      }),
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    let token = "";
    try {
      token = String((JSON.parse(t.text) as { access_token?: unknown }).access_token ?? "");
    } catch {
      // handled below
    }
    if (t.status !== 200 || !token) throw new Error("GitHub didn't accept the code");
    const me = await this.d.http({
      method: "GET",
      url: `${this.d.apiBase}/user`,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    let login = "";
    try {
      login = String((JSON.parse(me.text) as { login?: unknown }).login ?? "");
    } catch {
      // handled below
    }
    if (me.status !== 200 || !/^[A-Za-z0-9-]+$/.test(login)) throw new Error("GitHub didn't say who you are");
    return login.toLowerCase();
  }

  /** USR-4: the person behind a cookie, or null when there is no live session. */
  async authenticate(cookies: string | undefined): Promise<Signed | null> {
    const token = cookieValue(cookies, SESSION_COOKIE);
    if (!token) return null;
    const s = this.d.db.get<{
      id: number;
      login: string;
      last_seen: number;
      expires: number;
      revoked_at: number | null;
    }>("SELECT id, login, last_seen, expires, revoked_at FROM sessions WHERE token_hash = ?", hash(token));
    const now = this.d.now();
    if (!s || s.revoked_at !== null || now >= s.expires) return null;
    if (now - s.last_seen >= this.d.auth.sessionHours * 3600) return null;
    // The role is read again on every request, so a change applies to the open session.
    const user = await this.resolve(s.login);
    if (!user) return null;
    this.d.db.run("UPDATE sessions SET last_seen = ? WHERE id = ?", now, s.id);
    return { user, session: s.id };
  }

  /** The signed-in person ends their own session. */
  logout(session: number): string[] {
    this.d.db.run(
      "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      this.d.now(),
      session,
    );
    return [this.cookie(SESSION_COOKIE, "", 0)];
  }
}
