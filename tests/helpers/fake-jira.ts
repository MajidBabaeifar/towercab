// A fake Jira Cloud over real HTTP on a local port (JIRA-11): the search, the comment list and the comment
// create, with the basic-auth header checked, every request recorded and any other call refused and noted.

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JiraConfig } from "../../src/config.ts";

export const EMAIL = "owner@example.com";
export const TOKEN = "jira-secret-token";

export interface FakeTicket {
  key: string;
  summary: string;
  /** Atlassian document format, plain text or null. */
  description: unknown;
  project: string;
  components: string[];
  labels: string[];
  /** Whether the owner's filter returns it. */
  inFilter: boolean;
  comments: { id: string; author: string; body: unknown }[];
}

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export class FakeJira {
  readonly tickets: FakeTicket[] = [];
  readonly seen: Seen[] = [];
  /** Calls the fake does not implement. */
  readonly refused: string[] = [];
  /** The next requests fail with this status (and Retry-After), then it clears. */
  failNext: { status: number; retryAfter?: string; times: number } | null = null;
  /** Make the comment create fail this many times. */
  failComments = 0;
  /** Tickets per page. */
  pageSize = 50;
  site = "";
  tokenFile = "";
  private server: Server | null = null;
  private nextId = 1;

  ticket(o: Partial<FakeTicket> & { key: string }): FakeTicket {
    const t: FakeTicket = {
      summary: "Export invoices as a spreadsheet",
      description: null,
      project: o.key.split("-")[0]!,
      components: [],
      labels: [],
      inFilter: true,
      comments: [],
      ...o,
    };
    this.tickets.push(t);
    return t;
  }

  /** A comment someone else wrote. */
  said(key: string, text: string): void {
    this.byKey(key)!.comments.push({ id: String(this.nextId++), author: "someone", body: text });
  }

  byKey(key: string): FakeTicket | undefined {
    return this.tickets.find((t) => t.key === key);
  }

  /** The texts of the comments Towercab posted on `key`. */
  posted(key: string): string[] {
    return this.byKey(key)!
      .comments.filter((c) => c.author === "towercab")
      .map((c) => plain(c.body));
  }

  /** Requests that wrote: everything but GET. */
  writes(): Seen[] {
    return this.seen.filter((s) => s.method !== "GET");
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        let body: unknown = null;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
        } catch {
          body = null;
        }
        const out = this.handle(req.method ?? "GET", url, body, req.headers.authorization ?? "");
        res.writeHead(out.status, {
          "Content-Type": "application/json",
          ...(out.retryAfter ? { "Retry-After": out.retryAfter } : {}),
        });
        res.end(JSON.stringify(out.json));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.site = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const dir = mkdtempSync(join(tmpdir(), "tc-jira-"));
    this.tokenFile = join(dir, "token");
    writeFileSync(this.tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** The `[jira]` table that points at this fake. */
  table(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      site: this.site,
      email: EMAIL,
      token_file: this.tokenFile,
      jql: "project = ABC AND labels = towercab ORDER BY created",
      repos: { web: ["project:ABC"] },
      ...extra,
    };
  }

  /** The parsed config of the same table, for a client. */
  config(jql = "project = ABC"): JiraConfig {
    return { site: this.site, email: EMAIL, tokenFile: this.tokenFile, jql, repos: new Map() };
  }

  private handle(
    method: string,
    url: URL,
    body: unknown,
    auth: string,
  ): { status: number; json: unknown; retryAfter?: string } {
    const path = url.pathname;
    const comments = /^\/rest\/api\/3\/issue\/([A-Za-z0-9_-]+)\/comment$/.exec(path);
    const known =
      (method === "GET" && path === "/rest/api/3/search/jql") ||
      (comments && (method === "GET" || method === "POST"));
    if (!known) {
      this.refused.push(`${method} ${path}`);
      return { status: 404, json: { errorMessages: ["not implemented by the fake"] } };
    }
    this.seen.push({ method, path, query: url.searchParams, body });
    const want = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
    if (auth !== want) return { status: 401, json: { message: "bad credentials" } };
    if (this.failNext && this.failNext.times > 0) {
      const f = this.failNext;
      f.times--;
      return {
        status: f.status,
        json: { message: "failed" },
        ...(f.retryAfter ? { retryAfter: f.retryAfter } : {}),
      };
    }
    if (path === "/rest/api/3/search/jql") return this.search(url);
    const t = this.byKey(comments![1]!);
    if (!t) return { status: 404, json: { errorMessages: ["no such issue"] } };
    if (method === "POST") {
      if (this.failComments > 0) {
        this.failComments--;
        return { status: 500, json: { message: "boom" } };
      }
      const c = { id: String(this.nextId++), author: "towercab", body: (body as { body?: unknown })?.body };
      t.comments.push(c);
      return { status: 201, json: { id: c.id } };
    }
    const start = Number(url.searchParams.get("startAt") ?? 0);
    const max = Number(url.searchParams.get("maxResults") ?? 100);
    return {
      status: 200,
      json: {
        startAt: start,
        total: t.comments.length,
        comments: t.comments.slice(start, start + max).map((c) => ({ id: c.id, body: c.body })),
      },
    };
  }

  private search(url: URL): { status: number; json: unknown } {
    const jql = url.searchParams.get("jql") ?? "";
    const one = /key = "([A-Za-z0-9_-]+)"/.exec(jql)?.[1];
    const all = this.tickets.filter((t) => t.inFilter && (!one || t.key === one));
    const from = Number(url.searchParams.get("nextPageToken") ?? 0);
    const rows = all.slice(from, from + this.pageSize);
    const more = from + this.pageSize < all.length;
    return {
      status: 200,
      json: {
        issues: rows.map((t) => ({
          key: t.key,
          fields: {
            summary: t.summary,
            description: t.description,
            project: { key: t.project },
            components: t.components.map((name) => ({ name })),
            labels: t.labels,
          },
        })),
        ...(more ? { nextPageToken: String(from + this.pageSize) } : { isLast: true }),
      },
    };
  }
}

/** The text of a comment body in Atlassian document format (or a plain string). */
export function plain(body: unknown): string {
  if (typeof body === "string") return body;
  const walk = (n: unknown): string => {
    if (typeof n !== "object" || n === null) return "";
    const o = n as { text?: string; content?: unknown[]; type?: string };
    if (typeof o.text === "string") return o.text;
    const inner = (o.content ?? []).map(walk).join("");
    return o.type === "paragraph" ? `${inner}\n\n` : inner;
  };
  return walk(body).trim();
}
