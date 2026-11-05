// A fake GitLab with issues (INT-63..68): serves the issue, note and label routes in-process and hands
// every other route to the base fake of GL-10. No socket, no network.

import type { Http, HttpRequest, HttpResponse } from "../../src/github/app.ts";
import { FakeGitLab, GL_TOKEN } from "./gitlab.ts";

export interface FakeGlIssue {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed";
  author: string;
  labels: string[];
  /** Left out (undefined) to test a host that does not say. */
  confidential: boolean | undefined;
  notes: string[];
  /** Who added which label, in order. */
  labelEvents: { label: string; user: string }[];
}

export class FakeGitLabIssues {
  readonly base = new FakeGitLab();
  readonly issues = new Map<string, FakeGlIssue[]>();
  /** Labels that exist in each project. */
  readonly labels = new Map<string, Set<string>>();
  /** Every issue, note and label call, as `METHOD path`. */
  readonly calls: string[] = [];
  /** Return a reason to make a list call fail with HTTP 502. */
  listFails: ((project: string) => string | null) | null = null;

  /** Add an open, public issue by the owner with no labels. */
  issue(project: string, o: Partial<FakeGlIssue> = {}): FakeGlIssue {
    const rows = this.issues.get(project) ?? [];
    const it: FakeGlIssue = {
      iid: rows.length + 1,
      title: "The page greets nobody",
      description: "Visitors see an empty page.",
      state: "opened",
      author: "owner",
      labels: [],
      confidential: false,
      notes: [],
      labelEvents: [],
      ...o,
    };
    rows.push(it);
    this.issues.set(project, rows);
    return it;
  }

  /** The calls that read an issue's text. */
  reads(): string[] {
    return this.calls.filter((c) => /^GET \/projects\/[^/]+\/issues\/\d+$/.test(c));
  }

  readonly http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(req.url);
    const path = u.pathname.replace(/^\/api\/v4/, "");
    const m = /^\/projects\/([^/]+)\/(issues|labels)(\/.*)?$/.exec(path);
    if (!m) return this.base.http(req);
    this.calls.push(`${req.method} ${path}`);
    const reply = (status: number, v: unknown): HttpResponse => ({ status, text: JSON.stringify(v) });
    if (req.headers?.["PRIVATE-TOKEN"] !== GL_TOKEN) return reply(401, { message: "401 Unauthorized" });
    const project = decodeURIComponent(m[1]!);
    const body = (req.body ? JSON.parse(req.body) : {}) as Record<string, unknown>;
    if (m[2] === "labels") {
      const have = this.labels.get(project) ?? new Set<string>();
      this.labels.set(project, have);
      const name = String(body.name);
      if (have.has(name)) return reply(409, { message: "Label already exists" });
      have.add(name);
      return reply(201, { name });
    }
    const rows = this.issues.get(project) ?? [];
    const tail = m[3] ?? "";
    if (tail === "" && req.method === "GET") {
      const bad = this.listFails?.(project);
      if (bad) return reply(502, { message: bad });
      const page = Number(u.searchParams.get("page") ?? 1);
      const list = [...rows].reverse().map((i) => ({
        iid: i.iid,
        web_url: `https://gitlab.test/${project}/-/issues/${i.iid}`,
        state: i.state,
        author: { username: i.author },
        labels: i.labels,
        ...(i.confidential === undefined ? {} : { confidential: i.confidential }),
      }));
      return reply(200, page === 1 ? list : []);
    }
    const im = /^\/(\d+)(\/.*)?$/.exec(tail);
    const it = im ? rows.find((x) => x.iid === Number(im[1])) : undefined;
    if (!im || !it) return reply(404, { message: "404 Not Found" });
    const sub = im[2] ?? "";
    if (sub === "" && req.method === "GET") {
      return reply(200, {
        iid: it.iid,
        title: it.title,
        description: it.description,
        state: it.state,
        author: { username: it.author },
        labels: it.labels,
        ...(it.confidential === undefined ? {} : { confidential: it.confidential }),
      });
    }
    if (sub === "/notes" && req.method === "POST") {
      it.notes.push(String(body.body));
      return reply(201, { id: it.notes.length });
    }
    if (sub === "" && req.method === "PUT") {
      for (const l of String(body.add_labels ?? "")
        .split(",")
        .filter(Boolean)) {
        if (!it.labels.includes(l)) it.labels.push(l);
        it.labelEvents.push({ label: l, user: "towercab-bot" });
      }
      const gone = String(body.remove_labels ?? "").split(",");
      it.labels = it.labels.filter((l) => !gone.includes(l));
      return reply(200, { iid: it.iid });
    }
    if (sub === "/resource_label_events" && req.method === "GET") {
      return reply(
        200,
        it.labelEvents.map((e, id) => ({
          id,
          action: "add",
          label: { name: e.label },
          user: { username: e.user },
        })),
      );
    }
    return reply(404, { message: "404 Not Found" });
  };
}
