// FAST-9: a `fast:` mark pushed to the intents repo skips approvals only when the owner's GitHub account made it
// (the same proof as a raise of `a`, AUT-35). Any other mark stays unconfirmed, noted once on the timeline.

import { judgeProof } from "./autonomy-change.ts";
import { noteIgnored } from "./commands.ts";
import type { Db } from "./db.ts";
import { clearFast, confirmFast, fastConfirmed, fastFromCli, seenFast, setSeenFast } from "./fast.ts";
import type { Forge } from "./forge.ts";
import type { IntentStore, Listing } from "./intents/types.ts";

export interface FastWatchDeps {
  db: Db;
  store: IntentStore;
  forge: Pick<Forge, "commitProof" | "me">;
  /** Unix seconds. */
  now: number;
  log(line: string): void;
}

/**
 * Look at every open intent's mark. A mark taken off clears its confirmation. A confirmed mark stays. A mark
 * written through the command line stays unconfirmed until the owner confirms it on the page. Any other
 * mark is judged by the verified GitHub account of the commit that wrote it, once per commit; GitHub being
 * unreachable leaves it unconfirmed and looks again on the next pass.
 */
export async function watchFast(d: FastWatchDeps, listing: Listing): Promise<void> {
  const { db } = d;
  for (const i of listing.open) {
    if (!i.fast) {
      if (fastConfirmed(db, i.id) || fastFromCli(db, i.id)) clearFast(db, i.id);
      continue;
    }
    if (fastConfirmed(db, i.id) || fastFromCli(db, i.id)) continue;
    const commit = (await d.store.lastFastChange?.(i.id).catch(() => null)) ?? "";
    if (commit && seenFast(db, i.id) === commit) continue;
    const repo = d.store.github();
    let proof: Awaited<ReturnType<FastWatchDeps["forge"]["commitProof"]>> | null = null;
    if (commit && repo) {
      try {
        proof = await d.forge.commitProof(repo, commit);
      } catch (e) {
        d.log(`fast ${i.id}: couldn't read the commit's account: ${(e as Error).message}`);
        continue;
      }
    }
    const v = judgeProof(proof, d.forge.me);
    if (v.owner) {
      confirmFast(db, i.id);
      continue;
    }
    if (commit) setSeenFast(db, i.id, commit);
    noteIgnored(
      db,
      i.id,
      `fast:${commit || "unknown"}`,
      `${v.who === "unknown" ? "an unknown account" : v.who} put it in the fast lane: it starts first, but its approvals wait until you confirm it on the page`,
      d.now,
    );
  }
}
