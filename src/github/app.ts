// The GitHub App (LOOP-19): an RS256 JWT from `app.pem` → a 1-hour installation token per repo
// (cached, re-minted under 10 minutes left), and the App's bot user (commit author, `meta.bot`).

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Db } from "../db.ts";
import { type Clock, EnvError, systemClock } from "../handlers.ts";

/** One HTTP request; `timeoutMs` bounds the whole call. */
export interface HttpRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  text: string;
}

/** HTTP behind one function so tests fake it; rejects only on a network failure or timeout. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const HTTP_TIMEOUT_MS = 10_000;

/** Global `fetch`; a failure's message is the cause (`ECONNREFUSED`, a timeout), never the URL. */
export const fetchHttp: Http = async (req) => {
  try {
    const r = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "TimeoutError") throw new Error(`timed out after ${req.timeoutMs / 1000} s`);
    throw new Error(err.cause?.code ?? err.cause?.message ?? err.message);
  }
};

/** A token is re-minted when fewer seconds than this remain. */
export const REMINT_S = 600;
/** The JWT's `iat` is this far back (clock drift), its `exp` this far ahead (GitHub allows 600). */
export const JWT_BACK_S = 60;
export const JWT_AHEAD_S = 540;
export const API_VERSION = "2022-11-28";

/** The App's bot user: commits, PRs and comments show as `login`. */
export interface Bot {
  /** `<slug>[bot]`. */
  login: string;
  id: number;
  /** `<id>+<slug>[bot]@users.noreply.github.com`. */
  email: string;
}

export function botOf(slug: string, id: number): Bot {
  const login = `${slug}[bot]`;
  return { login, id, email: `${id}+${login}@users.noreply.github.com` };
}

/**
 * The App key at `path`: PKCS#1 or PKCS#8 PEM, refused when group or others may read it.
 * Errors read `<path>: <why>`.
 */
export function loadKey(path: string): KeyObject {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (e) {
    throw new Error(`${path}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : String(e)}`);
  }
  if (mode & 0o077) throw new Error(`${path}: mode ${mode.toString(8)}, want 600`);
  try {
    const key = createPrivateKey(readFileSync(path, "utf8"));
    if (key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
    return key;
  } catch {
    throw new Error(`${path}: not an RSA private key (PKCS#1 or PKCS#8 PEM)`);
  }
}

/** The RS256 JWT of App calls: `iat` = now − 60 s, `exp` = now + 540 s, `iss` = the app id. */
export function appJwt(key: KeyObject, appId: number, now: number): string {
  const t = Math.floor(now);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const signed = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: t - JWT_BACK_S, exp: t + JWT_AHEAD_S, iss: appId })}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), key).toString("base64url")}`;
}

export interface AppOptions {
  appId: number;
  apiBase: string;
  keyPath: string;
  /** Keeps the bot in `meta.bot` (`<slug> <id>`). */
  db?: Db;
  http?: Http;
  clock?: Clock;
}

interface Token {
  token: string;
  /** Unix seconds. */
  expires: number;
}

/** Installation tokens and the bot, cached for the life of the loop. */
export class App {
  private o: AppOptions;
  private http: Http;
  private clock: Clock;
  private key: KeyObject | Error | null = null;
  private tokens = new Map<string, Token>();
  private installs = new Map<string, number>();
  private inflight = new Map<string, Promise<string>>();
  private cachedBot: Bot | null = null;

  constructor(o: AppOptions) {
    this.o = { ...o, apiBase: o.apiBase.replace(/\/+$/, "") };
    this.http = o.http ?? fetchHttp;
    this.clock = o.clock ?? systemClock;
  }

  /** A JWT now; a key that doesn't load is a `github` fault (every call fails with why). */
  jwt(): string {
    if (this.key === null) {
      try {
        this.key = loadKey(this.o.keyPath);
      } catch (e) {
        this.key = e as Error;
      }
    }
    if (this.key instanceof Error) throw new EnvError("github", this.key.message);
    return appJwt(this.key, this.o.appId, this.clock.now());
  }

  /**
   * A 1-hour installation token for `github` (`owner/name`): cached, re-minted when under 10
   * minutes remain. `GET /repos/<github>/installation` → `POST /app/installations/<id>/access_tokens`
   * `{}`, the installation's repos (GitHub's git refuses repo-scoped tokens, LOOP-19); a cached
   * installation GitHub refuses is looked up again once.
   */
  token(github: string): Promise<string> {
    const key = github.toLowerCase();
    const t = this.tokens.get(key);
    if (t && t.expires - this.clock.now() >= REMINT_S) return Promise.resolve(t.token);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.mint(github, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async mint(github: string, key: string): Promise<string> {
    const auth = `Bearer ${this.jwt()}`;
    let cached = this.installs.has(key);
    for (;;) {
      let install = this.installs.get(key);
      if (install === undefined) {
        cached = false;
        const what = `GET /repos/${github}/installation`;
        const r = await this.call(what, "GET", `/repos/${github}/installation`, auth);
        if (r.status === 404) throw new Error(`the GitHub App isn't installed on ${github}`);
        const id = numberField(json(this.ok(what, r)), "id");
        if (id === null) throw new Error(`${what}: no id`);
        install = id;
        this.installs.set(key, id);
      }
      const what = `POST /app/installations/${install}/access_tokens`;
      const r = await this.call(what, "POST", `/app/installations/${install}/access_tokens`, auth, {});
      let v: unknown;
      try {
        v = json(this.ok(what, r));
      } catch (e) {
        this.installs.delete(key);
        this.tokens.delete(key);
        if (!cached || e instanceof EnvError) throw e;
        cached = false;
        continue;
      }
      const token = stringField(v, "token");
      if (!token) throw new Error(`${what}: no token`);
      const at = Date.parse(stringField(v, "expires_at") ?? "");
      const expires = Number.isFinite(at) ? at / 1000 : this.clock.now() + 3600;
      this.tokens.set(key, { token, expires });
      return token;
    }
  }

  /** The bot (memory, else `meta.bot`, else `GET /app` → slug, `GET /users/<slug>[bot]` → id). */
  async bot(): Promise<Bot> {
    if (this.cachedBot) return this.cachedBot;
    const m = /^([A-Za-z0-9._-]+) (\d+)$/.exec(this.o.db?.meta("bot") ?? "");
    if (m) {
      this.cachedBot = botOf(m[1]!, Number(m[2]));
      return this.cachedBot;
    }
    const app = json(this.ok("GET /app", await this.call("GET /app", "GET", "/app", `Bearer ${this.jwt()}`)));
    const slug = stringField(app, "slug");
    if (!slug || !/^[A-Za-z0-9._-]+$/.test(slug)) throw new Error("GET /app: no slug");
    const what = `GET /users/${slug}[bot]`;
    const user = json(this.ok(what, await this.call(what, "GET", `/users/${slug}%5Bbot%5D`, null)));
    const id = numberField(user, "id");
    if (id === null) throw new Error(`${what}: no id`);
    this.cachedBot = botOf(slug, id);
    this.o.db?.setMeta("bot", `${slug} ${id}`);
    return this.cachedBot;
  }

  private async call(
    what: string,
    method: "GET" | "POST",
    path: string,
    auth: string | null,
    body?: unknown,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "towercab",
    };
    if (auth) headers.Authorization = auth;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await this.http({
        method,
        url: `${this.o.apiBase}${path}`,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: HTTP_TIMEOUT_MS,
      });
    } catch (e) {
      throw new EnvError("github", `${what}: ${(e as Error).message}`);
    }
  }

  /** The body of a 2xx answer; 401 and 5xx are `github` faults (LOOP-10), the rest GitHub's no. */
  private ok(what: string, r: HttpResponse): string {
    if (r.status >= 200 && r.status < 300) return r.text;
    const msg = `${what}: HTTP ${r.status}: ${r.text.replace(/\s+/g, " ").trim().slice(0, 200)}`;
    if (r.status === 401 || r.status >= 500) throw new EnvError("github", msg);
    throw new Error(msg);
  }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function stringField(v: unknown, k: string): string | null {
  const x = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  return typeof x === "string" && x !== "" ? x : null;
}

function numberField(v: unknown, k: string): number | null {
  const x = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  return typeof x === "number" && Number.isInteger(x) ? x : null;
}
