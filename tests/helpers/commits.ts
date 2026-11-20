// LOOP-76: a forge that knows how many commits each PR holds, for the tests of the exit confirm.

import type { Forge } from "../../src/forge.ts";
import type { FakeForge } from "./fake-forge.ts";

/** Make `forge.prCommits` answer from `counts` (`<repo>#<n>` → commits); a PR not listed has none. */
export function withCommits<T extends FakeForge>(
  forge: T,
  counts: Record<string, number>,
): T & Pick<Forge, "prCommits"> {
  Object.assign(forge, {
    prCommits: async (repo: string, n: number) => {
      const p = forge.prs.find((x) => x.repo === repo && x.number === n);
      if (!p) throw new Error(`no PR ${repo}#${n}`);
      return { state: p.state, commits: counts[`${repo}#${n}`] ?? 0 };
    },
  });
  return forge as T & Pick<Forge, "prCommits">;
}
