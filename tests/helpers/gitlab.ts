// A fake GitLab (GL-10): an in-process `Http` over projects, merge requests, notes and approvals, and a
// fake `glab`. No socket, no network.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitLabConfig } from "../../src/config.ts";
import type { Http, HttpRequest, HttpResponse } from "../../src/github/app.ts";
import { type FakeTools, okResult } from "./tools.ts";
import { tempDir } from "./world.ts";

export const GL_BASE = "https://gitlab.test/api/v4";
export const GL_TOKEN = "glpat-secret-token";

export interface FakeNote {
  id: number;
  body: string;
  author: { username: string };
  created_at: string;
  system: boolean;
  position?: { new_path: string; new_line: number };
  /** Notes with the same thread share a discussion. */
  thread?: string;
}

export interface FakeMr {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "merged" | "closed";
  sha: string;
  source_branch: string;
  target_branch: string;
  detailed_merge_status: string;
  has_conflicts: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  notes: FakeNote[];
  approvedBy: string[];
}

export interface FakeProject {
  path: string;
  default_branch: string;
  mrs: FakeMr[];
  approvals: boolean;
}

export interface FakeToken {
  scopes: string[];
  active: boolean;
  expires_at: string | null;
}

/** A token file (mode 600) and the `[gitlab]` config pointing at it. */
export function gitlabConfig(over: Record<string, unknown> = {}): {
  raw: Record<string, unknown>;
  file: string;
  cfg: GitLabConfig;
} {
  const file = join(tempDir("tc-gl-"), "token");
  writeFileSync(file, `${GL_TOKEN}\n`);
  chmodSync(file, 0o600);
  return {
    raw: { gitlab: { me: "owner", token_file: file, api_base: GL_BASE, ...over } },
    file,
    cfg: { apiBase: GL_BASE, me: "owner", tokenFile: file },
  };
}

export class FakeGitLab {
  readonly requests: { method: string; path: string; body: string; token: string | undefined }[] = [];
  readonly projects = new Map<string, FakeProject>();
  bot = { id: 77, username: "towercab-bot", name: "Towercab" };
  token: FakeToken = { scopes: ["api", "write_repository"], active: true, expires_at: null };
  /** Page size, small so tests can see pagination. */
  perPage = 100;
  private nextNote = 1;

  project(path: string, base = "main"): FakeProject {
    const p: FakeProject = { path, default_branch: base, mrs: [], approvals: true };
    this.projects.set(path, p);
    return p;
  }

  mr(project: string, o: Partial<FakeMr> = {}): FakeMr {
    const p = this.projects.get(project)!;
    const m: FakeMr = {
      iid: p.mrs.length + 1,
      title: "Draft: change",
      description: "",
      state: "opened",
      sha: "a".repeat(40),
      source_branch: "feature",
      target_branch: p.default_branch,
      detailed_merge_status: "mergeable",
      has_conflicts: false,
      merged_at: null,
      merge_commit_sha: null,
      notes: [],
      approvedBy: [],
      ...o,
    };
    p.mrs.push(m);
    return m;
  }

  note(m: FakeMr, author: string, body: string, o: Partial<FakeNote> = {}): FakeNote {
    const n: FakeNote = {
      id: this.nextNote++,
      body,
      author: { username: author },
      created_at: `2026-11-05T10:00:${String(m.notes.length).padStart(2, "0")}Z`,
      system: false,
      ...o,
    };
    m.notes.push(n);
    return n;
  }

  calls(): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }

  readonly http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(req.url);
    const path = u.pathname.replace(/^\/api\/v4/, "");
    const token = req.headers?.["PRIVATE-TOKEN"];
    this.requests.push({ method: req.method, path: path + u.search, body: req.body ?? "", token });
    const reply = (status: number, v: unknown): HttpResponse => ({ status, text: JSON.stringify(v) });
    if (token !== GL_TOKEN) return reply(401, { message: "401 Unauthorized" });
    const body = (req.body ? JSON.parse(req.body) : {}) as Record<string, unknown>;
    const page = <T>(rows: T[]): HttpResponse => {
      const n = Number(u.searchParams.get("page") ?? 1);
      return reply(200, rows.slice((n - 1) * this.perPage, n * this.perPage));
    };
    if (path === "/user" && req.method === "GET") return reply(200, this.bot);
    if (path === "/personal_access_tokens/self") return reply(200, this.token);
    const proj = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!proj) return reply(404, { message: "404 Not Found" });
    const p = this.projects.get(decodeURIComponent(proj[1]!));
    if (!p) return reply(404, { message: "404 Project Not Found" });
    const rest = proj[2] ?? "";
    if (rest === "" && req.method === "GET") {
      return reply(200, { path_with_namespace: p.path, default_branch: p.default_branch });
    }
    if (rest === "/merge_requests" && req.method === "POST") {
      const m = this.mr(p.path, {
        title: String(body.title),
        description: String(body.description ?? ""),
        source_branch: String(body.source_branch),
        target_branch: String(body.target_branch),
      });
      return reply(201, {
        ...this.view(m),
        web_url: `https://gitlab.test/${p.path}/-/merge_requests/${m.iid}`,
      });
    }
    const mm = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(rest);
    if (!mm) return reply(404, { message: "404 Not Found" });
    const m = p.mrs.find((x) => x.iid === Number(mm[1]));
    if (!m) return reply(404, { message: "404 Merge Request Not Found" });
    const tail = mm[2] ?? "";
    if (tail === "" && req.method === "GET") return reply(200, this.view(m));
    if (tail === "" && req.method === "PUT") {
      if (typeof body.title === "string") m.title = body.title;
      if (typeof body.description === "string") m.description = body.description;
      if (body.state_event === "close") m.state = "closed";
      return reply(200, this.view(m));
    }
    if (tail === "/merge" && req.method === "PUT") {
      if (body.sha !== m.sha) return reply(409, { message: "SHA does not match HEAD of source branch" });
      if (m.detailed_merge_status !== "mergeable") return reply(405, { message: "Branch cannot be merged" });
      m.state = "merged";
      m.merged_at = "2026-11-05T11:00:00Z";
      m.merge_commit_sha = "b".repeat(40);
      return reply(200, this.view(m));
    }
    if (tail === "/rebase" && req.method === "PUT") return reply(202, { rebase_in_progress: true });
    if (tail === "/notes" && req.method === "GET") return page(m.notes);
    if (tail === "/notes" && req.method === "POST") {
      return reply(201, this.note(m, this.bot.username, String(body.body)));
    }
    const nm = /^\/notes\/(\d+)$/.exec(tail);
    if (nm && req.method === "PUT") {
      const n = m.notes.find((x) => x.id === Number(nm[1]));
      if (!n) return reply(404, { message: "404 Note Not Found" });
      n.body = String(body.body);
      return reply(200, n);
    }
    if (tail === "/discussions" && req.method === "GET") {
      const groups = new Map<string, FakeNote[]>();
      for (const n of m.notes)
        groups.set(n.thread ?? `n${n.id}`, [...(groups.get(n.thread ?? `n${n.id}`) ?? []), n]);
      return page([...groups].map(([id, notes]) => ({ id, notes })));
    }
    if (tail === "/approvals" && req.method === "GET") {
      if (!p.approvals) return reply(404, { message: "404 Not Found" });
      return reply(200, { approved_by: m.approvedBy.map((username) => ({ user: { username } })) });
    }
    return reply(404, { message: "404 Not Found" });
  };

  private view(m: FakeMr): Record<string, unknown> {
    return {
      iid: m.iid,
      title: m.title,
      description: m.description,
      state: m.state,
      sha: m.sha,
      draft: /^Draft:/i.test(m.title),
      detailed_merge_status: m.detailed_merge_status,
      has_conflicts: m.has_conflicts,
      merged_at: m.merged_at,
      merge_commit_sha: m.merge_commit_sha,
      updated_at: "2026-11-05T10:30:00Z",
    };
  }
}

/** `glab auth status` as it prints for `login` on `host` (to stderr, as glab does). */
export function glabStatus(login: string, host = "gitlab.test"): string {
  return `${host}\n  ✓ Logged in to ${host} as ${login} (/home/x/.config/glab-cli/config.yml)\n  ✓ Token found: **************************\n`;
}

/** A `glab` on `tools` that is logged in as `login`; every other call answers 0 and is recorded. */
export function fakeGlab(tools: FakeTools, login = "owner"): void {
  tools.present.add("glab");
  tools.on("glab", (args) => {
    if (args[0] === "auth" && args[1] === "status") return { ...okResult(), stderr: glabStatus(login) };
    return okResult();
  });
}
