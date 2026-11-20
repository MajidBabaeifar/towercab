// Jira Cloud over REST v3 through the injectable `Http` (JIRA-1, JIRA-2, JIRA-10). The token is read from
// its mode-600 file for each call, never kept, and goes only to the configured site, as basic auth.
// Only three calls exist: a search (always the owner's JQL), a comment list that answers which of Towercab's
// own markers it holds and nothing else, and a comment create. Nothing here can change a ticket's status.

import { type JiraConfig, readTokenFile } from "../config.ts";
import type { Http } from "../github/app.ts";

export const JIRA_TIMEOUT_MS = 30_000;
/** JIRA-4: tickets per page, and pages per pass. */
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4;
/** The longest Retry-After (seconds) that is waited out; a longer one ends the pass. */
const MAX_WAIT_S = 60;
const MAX_TRIES = 3;

/** JIRA-2: the only fields a search asks for. */
export const FIELDS = ["summary", "description", "project", "components", "labels"];

export interface Ticket {
  key: string;
  summary: string;
  /** Atlassian document format, plain text or null: converted by `adfToText`. */
  description: unknown;
  project: string;
  components: string[];
  labels: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((x) => (isObj(x) && typeof x.name === "string" ? [x.name] : [])) : [];

/** The JQL without its `ORDER BY`, so a clause can be added to it. */
function filterOf(jql: string): string {
  return jql.replace(/\s+order\s+by\s[\s\S]*$/i, "").trim();
}

function ticketOf(row: unknown): Ticket | null {
  if (!isObj(row) || typeof row.key !== "string") return null;
  const f = isObj(row.fields) ? row.fields : {};
  return {
    key: row.key,
    summary: str(f.summary),
    description: f.description ?? null,
    project: isObj(f.project) ? str(f.project.key) : "",
    components: names(f.components),
    labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [],
  };
}

/** Every text leaf of a comment body, joined: a marker split by a link mark still reads whole. */
function textOf(n: unknown): string {
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (!isObj(n)) return "";
  return (typeof n.text === "string" ? n.text : "") + textOf(n.content);
}

/** Links in plain text become link marks, so Jira shows them as links. */
function adfOf(text: string): unknown {
  const inline = (line: string): unknown[] =>
    line
      .split(/(https?:\/\/[^\s<>)\]]+)/)
      .filter((s) => s !== "")
      .map((s) =>
        /^https?:\/\//.test(s)
          ? { type: "text", text: s, marks: [{ type: "link", attrs: { href: s } }] }
          : { type: "text", text: s },
      );
  return {
    type: "doc",
    version: 1,
    content: text
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => ({ type: "paragraph", content: inline(p.trim()) })),
  };
}

export class JiraClient {
  private cfg: JiraConfig & { file?: string };
  private http: Http;
  private sleep: (ms: number) => Promise<void>;

  constructor(cfg: JiraConfig & { file?: string }, http: Http, sleep?: (ms: number) => Promise<void>) {
    this.cfg = cfg;
    this.http = http;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The token, read from its file now (never kept). */
  private auth(): string {
    const r = readTokenFile(this.cfg.tokenFile);
    if ("why" in r) throw new Error(`config: ${this.cfg.file ?? "config"}: jira.token_file ${r.why}`);
    return `Basic ${Buffer.from(`${this.cfg.email}:${r.token}`).toString("base64")}`;
  }

  /** A 2xx answer's JSON. A 429 is waited out (its Retry-After, at most a minute); any other failure is an Error. */
  private async call(method: "GET" | "POST", path: string, body?: Obj): Promise<unknown> {
    for (let tries = 1; ; tries++) {
      const res = await this.http({
        method,
        url: `${this.cfg.site}${path}`,
        headers: {
          Authorization: this.auth(),
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: JIRA_TIMEOUT_MS,
      });
      if (res.status >= 200 && res.status < 300) {
        try {
          return res.text ? JSON.parse(res.text) : null;
        } catch {
          return null;
        }
      }
      if (res.status === 429 && tries < MAX_TRIES) {
        const after = Number(res.retryAfter ?? "1");
        const s = Number.isFinite(after) ? Math.max(1, Math.min(after, MAX_WAIT_S)) : 1;
        await this.sleep(s * 1000);
        continue;
      }
      throw new Error(`Jira ${method} ${path.split("?")[0]}: HTTP ${res.status}`);
    }
  }

  /**
   * JIRA-2, JIRA-4: one page of the tickets the owner's JQL returns, and the token of the next page (null
   * at the end). Every read of a ticket goes through here.
   */
  async search(jql: string, page: string | null): Promise<{ tickets: Ticket[]; next: string | null }> {
    const q = new URLSearchParams({
      jql,
      fields: FIELDS.join(","),
      maxResults: String(PAGE_SIZE),
    });
    if (page) q.set("nextPageToken", page);
    const j = await this.call("GET", `/rest/api/3/search/jql?${q}`);
    const o = isObj(j) ? j : {};
    const tickets = (Array.isArray(o.issues) ? o.issues : []).flatMap((r) => {
      const t = ticketOf(r);
      return t ? [t] : [];
    });
    const next = typeof o.nextPageToken === "string" && o.isLast !== true ? o.nextPageToken : null;
    return { tickets, next };
  }

  /** JIRA-4: up to `MAX_PAGES` pages of the owner's filter. */
  async eligible(): Promise<Ticket[]> {
    const out: Ticket[] = [];
    let page: string | null = null;
    for (let n = 0; n < MAX_PAGES; n++) {
      const r = await this.search(this.cfg.jql, page);
      out.push(...r.tickets);
      if (!r.next) break;
      page = r.next;
    }
    return out;
  }

  /** JIRA-2: one ticket by key, only if the filter still returns it: the owner's JQL `AND key = <KEY>`. */
  async lookup(key: string): Promise<Ticket | null> {
    const jql = `(${filterOf(this.cfg.jql)}) AND key = "${key.replace(/[^A-Za-z0-9_-]/g, "")}"`;
    const r = await this.search(jql, null);
    return r.tickets.find((t) => t.key === key) ?? null;
  }

  /**
   * JIRA-2: which of `needles` (Towercab's own marker lines) the ticket's comments hold. The comments are
   * read here and nothing of them leaves: not their text, author or number. Only the markers found.
   */
  async findMarkers(key: string, needles: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
    for (let start = 0; ; ) {
      const j = await this.call("GET", `${path}?startAt=${start}&maxResults=100`);
      const o = isObj(j) ? j : {};
      const rows = Array.isArray(o.comments) ? o.comments : [];
      for (const c of rows) {
        const text = textOf(isObj(c) ? c.body : null);
        for (const n of needles) if (text.includes(n)) found.add(n);
      }
      start += rows.length;
      const total = typeof o.total === "number" ? o.total : start;
      if (rows.length === 0 || start >= total || found.size === needles.length) break;
    }
    return found;
  }

  /** JIRA-10: the one write: a new comment. Never edits or deletes one. */
  async addComment(key: string, text: string): Promise<void> {
    await this.call("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: adfOf(text) });
  }
}
