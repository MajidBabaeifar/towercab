// Fakes for the GitHub track: an RSA App key, a fake GitHub API behind `Http`, and a `GitHub` over
// FakeTools that marks App calls (`GH_TOKEN=app`) apart from the owner's.

import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import type { HttpRequest, HttpResponse } from "../../src/github/app.ts";
import { GitHubForge } from "../../src/github/forge.ts";
import type { Clock, Host } from "../../src/handlers.ts";
import type { FakeTools } from "../helpers/tools.ts";

export const BOT = "towercab[bot]";
export const BOT_EMAIL = "42+towercab[bot]@users.noreply.github.com";

/** An RSA key written to `path` (0600, PKCS#1 or PKCS#8); returns the public half. */
export function writeKey(path: string, pkcs8 = false): KeyObject {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(path, privateKey.export({ type: pkcs8 ? "pkcs8" : "pkcs1", format: "pem" }));
  chmodSync(path, 0o600);
  return publicKey;
}

/** A JWT's claims after checking its RS256 signature with `key`. */
export function verifyJwt(jwt: string, key: KeyObject): Record<string, unknown> {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) throw new Error("not a JWT");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>;
  if (header.alg !== "RS256" || header.typ !== "JWT") throw new Error(`header ${JSON.stringify(header)}`);
  if (!verify("RSA-SHA256", Buffer.from(`${h}.${c}`), key, Buffer.from(s, "base64url"))) {
    throw new Error("bad signature");
  }
  return JSON.parse(Buffer.from(c, "base64url").toString()) as Record<string, unknown>;
}

export interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** GitHub's App endpoints: installations by repo, tokens `tok-<install>-<n>` for an hour. */
export class FakeApi {
  readonly base = "https://api.test";
  readonly requests: Seen[] = [];
  readonly tokens: [number, string][] = [];
  /** A status every call gets, or "net" for a network failure. */
  down: number | "net" | null = null;
  /** `GET /app` answers 500. */
  appDown = false;
  /** `GET /users/<owner>/installation` answers 500. */
  lookupDown = false;
  /** The App's installation on an account (`GET /users/<owner>/installation`). */
  readonly accounts = new Map<
    string,
    { id: number; repository_selection: string; account: { type: string } }
  >();
  private installs = new Map<string, number>();
  private live = new Set<number>();
  private clock: Clock;

  constructor(repos: Record<string, number>, clock: Clock) {
    for (const [r, id] of Object.entries(repos)) this.reinstall(r, id);
    this.clock = clock;
  }

  /** The App installed again on `repo` under a new id; the old id is gone. */
  reinstall(repo: string, id: number): void {
    const old = this.installs.get(repo);
    if (old !== undefined) this.live.delete(old);
    this.installs.set(repo, id);
    this.live.add(id);
  }

  readonly http = async (req: HttpRequest): Promise<HttpResponse> => {
    const path = req.url.slice(this.base.length);
    this.requests.push({ method: req.method, path, headers: req.headers ?? {}, body: req.body ?? "" });
    if (this.down === "net") throw new Error("ECONNREFUSED");
    if (this.down !== null) return { status: this.down, text: '{"message":"down"}' };
    const reply = (status: number, v: unknown) => ({ status, text: JSON.stringify(v) });
    let m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
    if (m) {
      const id = this.installs.get(m[1]!);
      return id === undefined ? reply(404, { message: "Not Found" }) : reply(200, { id });
    }
    m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (m && req.method === "POST") {
      const id = Number(m[1]);
      if (!this.live.has(id)) return reply(404, { message: "Not Found" });
      const token = `tok-${id}-${this.tokens.length + 1}`;
      this.tokens.push([id, token]);
      const expires = new Date((this.clock.now() + 3600) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
      return reply(201, { token, expires_at: expires });
    }
    m = /^\/users\/([^/]+)\/installation$/.exec(path);
    if (m) {
      if (this.lookupDown) return reply(500, { message: "down" });
      const seat = this.accounts.get(m[1]!);
      return seat === undefined ? reply(404, { message: "Not Found" }) : reply(200, seat);
    }
    if (path === "/app") {
      if (this.appDown) return reply(500, { message: "down" });
      return reply(200, { slug: "towercab", id: 5, name: "Towercab Bot" });
    }
    if (path === "/users/towercab%5Bbot%5D") return reply(200, { login: BOT, id: 42 });
    return reply(404, { message: "Not Found" });
  };

  calls(): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }
}

/** A `GitHubForge` over `tools`: App calls carry `GH_TOKEN=app`, the owner's none. */
export function fakeGitHub(tools: FakeTools, me = "owner"): Host {
  return new GitHubForge({
    me,
    gh: (_repo, args, opts = {}) => tools.run("gh", args, { ...opts, env: { GH_TOKEN: "app" } }),
    owner: (args, opts = {}) => tools.run("gh", args, { ...opts, env: {} }),
    gitAuth: async () => ({ args: [], env: { GH_TOKEN: "app" } }),
    bot: async () => ({ login: BOT, id: 42, email: BOT_EMAIL }),
  });
}

/** `gh auth status` as gh 2.46 prints it for `login`. */
export function authStatus(login: string): string {
  return `github.com\n  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n`;
}
