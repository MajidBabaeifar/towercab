// `gh` and `git` as Towercab's GitHub App (LOOP-19), and `gh` as the owner (LOOP-38).

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock, GitHub } from "../handlers.ts";
import { GH_TIMEOUT_MS, type RunOpts, type Tools } from "../tools.ts";
import { App, type Http } from "./app.ts";

/** Variables through which a GitHub token reaches `gh` or `git`. */
export const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** `env` (default: the loop's own) without any GitHub token: the owner's `gh`, and Claude runs. */
export function withoutTokens(env?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? process.env)) {
    if (v !== undefined && !TOKEN_VARS.includes(k)) out[k] = v;
  }
  return out;
}

export interface GitHubOptions {
  config: Config;
  tools: Tools;
  db: Db;
  /** `app.pem` (`appKeyPath(config)`). */
  keyPath: string;
  http?: Http;
  clock?: Clock;
}

/** The `GitHub` the loop and handlers use: the App from `[github]` and `app.pem`. */
export function createGitHub(o: GitHubOptions): GitHub {
  const g = o.config.github;
  if (!g) throw new Error(`config: ${o.config.file}: [github] is required (app_id, me)`);
  const app = new App({
    appId: g.appId,
    apiBase: g.apiBase,
    keyPath: o.keyPath,
    db: o.db,
    http: o.http,
    clock: o.clock,
  });
  const quiet = { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  const bounded = (opts: RunOpts, env: Record<string, string>): RunOpts => ({
    ...opts,
    env,
    timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS,
  });
  return {
    me: g.me,

    async gh(github, args, opts = {}) {
      const token = await app.token(github);
      const env = { ...withoutTokens(opts.env), ...quiet, GH_TOKEN: token };
      return o.tools.run("gh", args, bounded(opts, env));
    },

    owner(args, opts = {}) {
      return o.tools.run("gh", args, bounded(opts, { ...withoutTokens(opts.env), ...quiet }));
    },

    async gitAuth(github) {
      const token = await app.token(github);
      const bot = await app.bot();
      // git runs the helper through the shell: the path single-quoted.
      const gh = (o.tools.which("gh") ?? "gh").replaceAll("'", "'\\''");
      return {
        args: [
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=!'${gh}' auth git-credential`,
          "-c",
          `user.name=${bot.login}`,
          "-c",
          `user.email=${bot.email}`,
        ],
        env: { GH_TOKEN: token },
      };
    },

    bot: () => app.bot(),
  };
}
