// Acting as the owner on GitLab (GL-8): what the owner starts from the page or the CLI happens under
// the owner's own `glab` login, never the bot's token.

import type { GitLabConfig } from "../config.ts";
import { check, GH_TIMEOUT_MS, type RunOpts, type Tools } from "../tools.ts";
import { gitlabPath } from "./types.ts";

/** Variables through which a GitLab token reaches `glab`. */
export const GLAB_TOKEN_VARS = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "TOWERCAB_GITLAB_TOKEN",
];

/** The login `glab auth status` shows for `host`, or null. */
export function parseGlabAuth(text: string, host: string): string | null {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`Logged in to ${esc} (?:as|account) ([A-Za-z0-9_.-]+)`).exec(text);
  return m ? m[1]! : null;
}

export class GlabOwner {
  private readonly host: string;
  private readonly tools: Tools;
  private readonly cfg: GitLabConfig;
  constructor(tools: Tools, cfg: GitLabConfig) {
    this.tools = tools;
    this.cfg = cfg;
    this.host = new URL(cfg.apiBase).host;
  }

  private run(args: string[], opts: RunOpts = {}) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env ?? process.env)) {
      if (v !== undefined && !GLAB_TOKEN_VARS.includes(k)) env[k] = v;
    }
    return this.tools.run("glab", args, { ...opts, env, timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS });
  }

  /** The owner's `glab` login, or an Error unless it is `[gitlab].me`. */
  async login(): Promise<string> {
    const r = await this.run(["auth", "status", "--hostname", this.host]);
    const who = parseGlabAuth(`${r.stdout}\n${r.stderr}`, this.host);
    if (!who || who.toLowerCase() !== this.cfg.me.toLowerCase()) {
      throw new Error(`glab is not logged in as ${this.cfg.me} on ${this.host}: run glab auth login`);
    }
    return who;
  }

  /** `approve`: approve the merge request, then squash-merge it on `head`. */
  async approve(slug: string, iid: number, head: string): Promise<void> {
    await this.login();
    const repo = gitlabPath(slug);
    check(await this.run(["mr", "approve", String(iid), "-R", repo]), "glab mr approve");
    check(
      await this.run(["mr", "merge", String(iid), "-R", repo, "--squash", "--sha", head, "--yes"]),
      "glab mr merge",
    );
  }

  async reply(slug: string, iid: number, text: string): Promise<void> {
    await this.login();
    check(await this.run(["mr", "note", String(iid), "-R", gitlabPath(slug), "-m", text]), "glab mr note");
  }

  async close(slug: string, iid: number): Promise<void> {
    await this.login();
    check(await this.run(["mr", "close", String(iid), "-R", gitlabPath(slug)]), "glab mr close");
  }
}
