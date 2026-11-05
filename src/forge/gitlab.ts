// GitLab as Towercab's forge (GL-2, GL-5..7): REST through the injectable `Http`, authenticated by the
// project or group access token in a mode-600 file. The token's bot user is Towercab's identity.

import { readFileSync } from "node:fs";
import type { GitLabConfig } from "../config.ts";
import { tokenFileProblem } from "../config.ts";
import type { Http } from "../github/app.ts";
import { type Step, stageComment, stageMarker } from "../github/comments.ts";
import type { PrComment, PrReview, PrState } from "../github/prs.ts";
import { gitlabPath } from "./types.ts";

export const GITLAB_TIMEOUT_MS = 30_000;
/** The variable that carries the token to git's credential helper, and nowhere else. */
export const TOKEN_ENV = "TOWERCAB_GITLAB_TOKEN";
const PER_PAGE = 100;
const MAX_PAGES = 100;

export interface GitLabBot {
  login: string;
  id: number;
  email: string;
  name: string;
}

/** The scopes Towercab's token needs (GL-9). */
export const NEEDED_SCOPES = ["api", "write_repository"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** What to do about a merge request, from GitLab's `detailed_merge_status` (GL-5). */
export type MergeStep = "merge" | "update" | "conflict" | "ready" | "wait";

export function mergeStep(status: string): MergeStep {
  switch (status) {
    case "mergeable":
      return "merge";
    case "need_rebase":
      return "update";
    case "conflict":
      return "conflict";
    case "draft_status":
      return "ready";
    default:
      return "wait";
  }
}

export interface MrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  status: string;
  mergeCommit: string | null;
  draft: boolean;
  title: string;
}

export interface TokenInfo {
  scopes: string[];
  active: boolean;
  /** `YYYY-MM-DD`, or null when the token does not expire. */
  expiresAt: string | null;
}

const DRAFT = /^\s*(?:draft:|\[draft\]|\(draft\))\s*/i;

export class GitLabForge {
  readonly me: string;
  readonly host: string;
  private bot_: GitLabBot | null = null;
  private readonly cfg: GitLabConfig & { file?: string };
  private readonly http: Http;

  constructor(cfg: GitLabConfig & { file?: string }, http: Http) {
    this.cfg = cfg;
    this.http = http;
    this.me = cfg.me;
    this.host = new URL(cfg.apiBase).host;
  }

  /** The token, read from its file now (never kept): the file must be 0600 and hold one line. */
  token(): string {
    const why = tokenFileProblem(this.cfg.tokenFile);
    if (why) throw new Error(`config: ${this.cfg.file ?? "config"}: gitlab.token_file ${why}`);
    return readFileSync(this.cfg.tokenFile, "utf8").trim();
  }

  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: Obj) {
    const res = await this.http({
      method,
      url: `${this.cfg.apiBase}${path}`,
      headers: {
        "PRIVATE-TOKEN": this.token(),
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: GITLAB_TIMEOUT_MS,
    });
    let json: unknown = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** A 2xx answer's JSON; anything else an Error naming the call and GitLab's reason (LOOP-10 reads it). */
  private async ok(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: Obj): Promise<unknown> {
    const r = await this.call(method, path, body);
    if (r.status >= 200 && r.status < 300) return r.json;
    throw failure(method, path, r.status, r.json);
  }

  private async list(path: string): Promise<Obj[]> {
    const out: Obj[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const got = await this.ok("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      const rows = Array.isArray(got) ? got : [];
      out.push(...arr(rows));
      if (rows.length < PER_PAGE) break;
    }
    return out;
  }

  private mr(slug: string, iid: number, tail = ""): string {
    return `/projects/${encodeURIComponent(gitlabPath(slug))}/merge_requests/${iid}${tail}`;
  }

  /** GL-2: the token's bot user, asked once. Commits are authored as `<name> <<id>-<login>@noreply.<host>>`. */
  async bot(): Promise<GitLabBot> {
    if (this.bot_) return this.bot_;
    const u = await this.ok("GET", "/user");
    if (!isObj(u) || !str(u.username) || typeof u.id !== "number")
      throw new Error("GitLab did not say who the token is");
    this.bot_ = {
      login: str(u.username),
      id: u.id,
      name: str(u.name) || str(u.username),
      email: `${u.id}-${str(u.username)}@noreply.${this.host}`,
    };
    return this.bot_;
  }

  /**
   * GL-2: `-c` args and env that make `git` use `https://<host>/…` as the bot: a credential helper for
   * this host only answers user `oauth2` and the token, read from the environment of that git call.
   */
  async gitAuth(): Promise<{ args: string[]; env: Record<string, string> }> {
    const bot = await this.bot();
    const helper = `!f() { test "$1" = get && printf 'username=oauth2\\npassword=%s\\n' "$${TOKEN_ENV}"; }; f`;
    return {
      args: [
        "-c",
        "credential.helper=",
        "-c",
        `credential.https://${this.host}.helper=${helper}`,
        "-c",
        `user.name=${bot.name}`,
        "-c",
        `user.email=${bot.email}`,
      ],
      env: { [TOKEN_ENV]: this.token() },
    };
  }

  /** GL-3: a project's canonical path and default branch. */
  async project(path: string): Promise<{ path: string; base: string }> {
    const p = await this.ok("GET", `/projects/${encodeURIComponent(path)}`);
    if (!isObj(p)) throw new Error("GitLab sent no project");
    return { path: str(p.path_with_namespace) || path, base: str(p.default_branch) };
  }

  /** GL-5: open a merge request as a draft. */
  async openPr(
    slug: string,
    o: { title: string; body: string; head: string; base: string },
  ): Promise<{ number: number; url: string }> {
    const mr = await this.ok("POST", `/projects/${encodeURIComponent(gitlabPath(slug))}/merge_requests`, {
      source_branch: o.head,
      target_branch: o.base,
      title: `Draft: ${o.title.replace(DRAFT, "")}`,
      description: o.body,
      remove_source_branch: true,
    });
    if (!isObj(mr) || typeof mr.iid !== "number") throw new Error("GitLab sent no merge request");
    return { number: mr.iid, url: str(mr.web_url) };
  }

  async setBody(slug: string, iid: number, body: string): Promise<void> {
    await this.ok("PUT", this.mr(slug, iid), { description: body });
  }

  /** Mark ready: the title loses its `Draft:` prefix. */
  async markReady(slug: string, iid: number): Promise<void> {
    const v = await this.view(slug, iid);
    await this.ok("PUT", this.mr(slug, iid), { title: v.title.replace(DRAFT, "") });
  }

  async comment(slug: string, iid: number, body: string): Promise<void> {
    await this.ok("POST", this.mr(slug, iid, "/notes"), { body });
  }

  /**
   * GL-5: post the step's stage comment, or edit the bot's note that already carries its marker
   * (PIP-42). A note written by someone else is never edited. Returns whether it edited.
   */
  async upsertStageComment(
    slug: string,
    iid: number,
    step: Step,
    round: number,
    body: string,
  ): Promise<{ edited: boolean }> {
    const text = stageComment(step, round, body);
    const marker = stageMarker(step, round);
    const bot = (await this.bot()).login.toLowerCase();
    let id: number | null = null;
    for (const n of await this.list(this.mr(slug, iid, "/notes"))) {
      const author = isObj(n.author) ? str(n.author.username).toLowerCase() : "";
      const first = (str(n.body).split("\n", 1)[0] ?? "").trim();
      if (n.system !== true && first === marker && author === bot && typeof n.id === "number") id = n.id;
    }
    if (id !== null) {
      await this.ok("PUT", this.mr(slug, iid, `/notes/${id}`), { body: text });
      return { edited: true };
    }
    await this.comment(slug, iid, text);
    return { edited: false };
  }

  async view(slug: string, iid: number): Promise<MrView> {
    const v = await this.ok("GET", this.mr(slug, iid));
    if (!isObj(v)) throw new Error("GitLab sent no merge request");
    return viewOf(v);
  }

  /** GL-5: squash-merge on `head`; GitLab refuses when the head moved. */
  async merge(
    slug: string,
    iid: number,
    head: string,
  ): Promise<{ merged: true } | { merged: false; reason: string }> {
    const r = await this.call("PUT", this.mr(slug, iid, "/merge"), { sha: head, squash: true });
    if (r.status >= 200 && r.status < 300) return { merged: true };
    if ([405, 406, 409, 422].includes(r.status)) {
      return { merged: false, reason: str(isObj(r.json) ? r.json.message : "") || `HTTP ${r.status}` };
    }
    throw failure("PUT", this.mr(slug, iid, "/merge"), r.status, r.json);
  }

  /** Bring the branch up to date with its base (GitLab's rebase). */
  async updateBranch(slug: string, iid: number): Promise<void> {
    await this.ok("PUT", this.mr(slug, iid, "/rebase"));
  }

  async close(slug: string, iid: number, why?: string): Promise<void> {
    if (why) await this.comment(slug, iid, why);
    await this.ok("PUT", this.mr(slug, iid), { state_event: "close" });
  }

  /** Close an open merge request with a comment saying why (PIP-53); a closed or merged one is left. */
  async closeIfOpen(slug: string, iid: number, why: string): Promise<void> {
    if ((await this.view(slug, iid)).state === "OPEN") await this.close(slug, iid, why);
  }

  /**
   * GL-6, GL-7: a merge request as the pipeline reads a PR. Notes and diff notes (not GitLab's own
   * `system` ones) are comments, a diff note with its file and line; an approval is an `APPROVED` review
   * of the current head. A project without approvals gives none.
   */
  async readPr(slug: string, iid: number): Promise<PrState> {
    const mr = await this.ok("GET", this.mr(slug, iid));
    if (!isObj(mr)) throw new Error("GitLab sent no merge request");
    const v = viewOf(mr);
    const comments: PrComment[] = [];
    for (const d of await this.list(this.mr(slug, iid, "/discussions"))) {
      for (const n of arr(d.notes)) {
        if (n.system === true) continue;
        const pos = isObj(n.position) ? n.position : null;
        const line = pos ? (pos.new_line ?? pos.old_line) : undefined;
        const path = pos ? str(pos.new_path) || str(pos.old_path) : "";
        comments.push({
          author: isObj(n.author) ? str(n.author.username) : "",
          body: str(n.body),
          at: str(n.created_at),
          id: String(n.id ?? ""),
          ...(path ? { path } : {}),
          ...(typeof line === "number" ? { line } : {}),
        });
      }
    }
    const reviews: PrReview[] = [];
    const ap = await this.call("GET", this.mr(slug, iid, "/approvals"));
    if (ap.status >= 200 && ap.status < 300 && isObj(ap.json)) {
      for (const a of arr(ap.json.approved_by)) {
        const user = isObj(a.user) ? str(a.user.username) : "";
        if (user)
          reviews.push({ author: user, state: "APPROVED", body: "", at: str(mr.updated_at), commit: v.head });
      }
    }
    const conflicts = mr.has_conflicts === true || v.status === "conflict";
    return {
      state: v.state,
      mergedAt: str(mr.merged_at) || null,
      mergeCommit: v.mergeCommit,
      head: v.head,
      mergeable: conflicts
        ? "CONFLICTING"
        : ["checking", "unchecked"].includes(v.status)
          ? "UNKNOWN"
          : "MERGEABLE",
      body: str(mr.description),
      isDraft: v.draft,
      reviews,
      comments,
    };
  }

  /** GL-9: the token's scopes and expiry (`GET /personal_access_tokens/self`, any kind of access token). */
  async tokenInfo(): Promise<TokenInfo> {
    const t = await this.ok("GET", "/personal_access_tokens/self");
    if (!isObj(t)) throw new Error("GitLab sent no token details");
    return {
      scopes: Array.isArray(t.scopes) ? t.scopes.filter((s): s is string => typeof s === "string") : [],
      active: t.active !== false && t.revoked !== true,
      expiresAt: str(t.expires_at) || null,
    };
  }
}

function viewOf(v: Obj): MrView {
  const state = str(v.state);
  return {
    state: state === "merged" ? "MERGED" : state === "closed" ? "CLOSED" : "OPEN",
    head: str(v.sha),
    status: str(v.detailed_merge_status),
    mergeCommit: str(v.merge_commit_sha) || str(v.squash_commit_sha) || null,
    draft: v.draft === true || v.work_in_progress === true,
    title: str(v.title),
  };
}

function failure(method: string, path: string, status: number, json: unknown): Error {
  const why = isObj(json) ? str(json.message) || str(json.error) : "";
  return new Error(`gitlab ${method} ${path.split("?")[0]}: HTTP ${status}${why ? `: ${why}` : ""}`);
}
