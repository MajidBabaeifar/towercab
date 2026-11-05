// Keeping the repos' `TOWERCAB.md` limits current (REPO-15 to REPO-19): fetch each repo, read the file
// from the base branch, remember the last good values or why it can't be read, follow the settings and
// move pull requests, and open the one-time move once the wait is over.

import { ensureClone } from "../checkout.ts";
import { clonePath } from "../config.ts";
import { parseTowercab } from "./files.ts";
import {
  baseText,
  errorKey,
  fileKey,
  isMoved,
  movedKey,
  moveKey,
  moveRepo,
  type PrKind,
  type PrRecord,
  prKey,
  readRecord,
  type SettingsEnv,
  waitHours,
} from "./settings.ts";

/** The reason without the file prefix the parser adds. */
export function reasonOf(message: string): string {
  return message.replace(/^(?:TOWERCAB\.md: )?(?:front matter: )?/, "");
}

async function pollRepo(d: SettingsEnv, name: string, log: (l: string) => void): Promise<void> {
  const repo = d.repos.get(name);
  if (!repo) return;
  // PR states first: a PR seen merged is in the base branch the fetch below brings.
  const states = new Map<PrKind, string>();
  for (const kind of ["settings", "move"] as const) {
    const rec = readRecord(d.db, name, kind);
    if (rec?.state === "open") states.set(kind, (await d.forge.prBrief(repo.github, rec.pr)).state);
  }
  const clone = clonePath(repo, d.home);
  await ensureClone(d.tools, clone, repo, await d.forge.gitAuth(repo.github));
  let good = false;
  try {
    const text = await baseText(d.tools, clone, repo.base);
    const t = text === null ? null : parseTowercab(text);
    const values: Record<string, number> = {};
    if (t?.workers !== undefined) values.workers = t.workers;
    if (t?.ahead !== undefined) values.ahead = t.ahead;
    d.db.tx(() => {
      d.db.setMeta(fileKey(name), JSON.stringify(values));
      d.db.delMeta(errorKey(name));
    });
    good = true;
  } catch (e) {
    d.db.setMeta(errorKey(name), reasonOf((e as Error).message));
  }
  for (const [kind, state] of states) {
    const rec = readRecord(d.db, name, kind)!;
    if (state === "OPEN") continue;
    const merged = state === "MERGED";
    if (kind === "settings") {
      // A merged change counts once the file has been read after it.
      if (!merged || good) d.db.delMeta(prKey(name, kind));
    } else if (merged) {
      if (!good) continue;
      d.db.tx(() => {
        d.db.setMeta(prKey(name, kind), JSON.stringify({ ...rec, state: "merged" } satisfies PrRecord));
        d.db.setMeta(movedKey(name), String(Math.floor(d.now)));
      });
    } else {
      d.db.setMeta(prKey(name, kind), JSON.stringify({ ...rec, state: "closed" } satisfies PrRecord));
    }
  }
  // REPO-19: the move, on its own, once the wait is over; asked once per repo.
  if (good && !isMoved(d.db, name) && d.db.meta(moveKey(name)) === null && waitHours(d.db, d.now) === null) {
    const out = await moveRepo(d, name);
    log(
      out ? `opened PR #${out.pr} to move ${name}'s settings into TOWERCAB.md` : `${name}: nothing to move`,
    );
  }
}

/** One pass over every repo; one failing repo doesn't stop the others. */
export async function pollRepoSettings(d: SettingsEnv, log: (l: string) => void): Promise<void> {
  for (const name of [...d.repos.keys()]) {
    try {
      await pollRepo(d, name, log);
    } catch (e) {
      log(`settings of ${name}: ${(e as Error).message}`);
    }
  }
}
