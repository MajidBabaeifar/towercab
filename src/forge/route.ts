// One host for the loop, the stages and the UI (GL-13): a call about a repo goes to the forge of the host
// the repo lives on, told by its slug (`gitlab:group/project` is GitLab, `owner/name` is GitHub). Nothing
// that holds a `Host` branches on the host.

import type { Bot, Forge } from "../forge.ts";
import type { Host } from "../handlers.ts";
import { isGitlab } from "./types.ts";

/** The methods that take no repo (or whose repo is not their first argument): they stay GitHub's. */
export const REPO_LESS: ReadonlySet<string> = new Set([
  "asOwner",
  "activeOwnerLogin",
  "ownerLogins",
  "owner",
  "peekInstallHelp",
]);

/** A `Host` that also names the identity of the host a repo lives on. */
export interface Routed extends Host {
  /** GL-14: the owner's login and the bot of the host that `repo` lives on. */
  identityOf(repo: string): { me: string; bot(): Promise<Bot> };
}

type Fn = (...a: unknown[]) => unknown;

/** `github` for every repo that is not a `gitlab:` one, `gitlab` for the others. */
export function routed(github: Host, gitlab: Forge): Routed {
  const of = (repo: unknown): Forge => (typeof repo === "string" && isGitlab(repo) ? gitlab : github);
  return new Proxy(github, {
    get(target, key) {
      if (key === "identityOf") {
        return (repo: string) => {
          const f = of(repo);
          return { me: f.me, bot: () => f.bot() };
        };
      }
      // `bot()` is GitHub's; `bot(repo)` is the bot of the host that repo lives on.
      if (key === "bot") return (repo?: string) => of(repo).bot();
      if (key === "asOwner") {
        return () => routed(github.asOwner() as Host, gitlab.asOwner());
      }
      const v = Reflect.get(target, key, target) as unknown;
      if (typeof v !== "function" || typeof key !== "string" || REPO_LESS.has(key)) {
        return typeof v === "function" ? (v as Fn).bind(target) : v;
      }
      // GitHub's raw `gh(repo, args)` is repo-first too, but GitLab has no such thing: it stays GitHub's.
      if (key === "gh") return (v as Fn).bind(target);
      return (...a: unknown[]) => {
        const f = of(a[0]) as unknown as Record<string, Fn | undefined>;
        const m = f[key];
        if (!m) throw new Error(`${key} is not available for ${String(a[0])}`);
        return m.apply(f, a);
      };
    },
  }) as Routed;
}
