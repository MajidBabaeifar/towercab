// AUT-35: a raise of `a` in the intents repo counts only when the owner's GitHub account made it.

import { acceptedOf, clearFlag, flagOf, judgeProof, seen, setAccepted, setFlag } from "./autonomy-change.ts";
import { noteIgnored } from "./commands.ts";
import type { Db } from "./db.ts";
import type { Forge } from "./forge.ts";
import type { IntentStore, Listing } from "./intents/types.ts";

export interface WatchDeps {
  db: Db;
  store: IntentStore;
  forge: Pick<Forge, "commitProof" | "me">;
  /** Unix seconds. */
  now: number;
  log(line: string): void;
  /** AUT-24: with `[auth]` set, whether this account may raise autonomy on all of these repos. */
  raiser?(login: string, repos: string[]): Promise<boolean>;
}

/**
 * Look at every open intent's `a`: the first look seeds the accepted level; a level not above it is taken
 * as it is (and ends a flag); a raise is judged by the verified GitHub account of the commit that made it
 * (never its local name). The owner's counts; any other is flagged and noted once, nothing is written
 * back, and the mission keeps the level it had until the owner accepts or sets it back. A deleted `a:`
 * line is a raise to the default (AUT-9, AUT-13) and is judged the same way.
 */
export async function watchAutonomy(d: WatchDeps, listing: Listing): Promise<void> {
  const { db } = d;
  for (const i of listing.open) {
    const s = seen(db, i);
    if (s.action === "none") continue;
    if (s.action === "seed" || s.action === "accept") {
      setAccepted(db, i.id, s.now);
      clearFlag(db, i.id);
      continue;
    }
    const commit = (await d.store.lastAChange?.(i.id).catch(() => null)) ?? "";
    const flag = flagOf(db, i.id);
    if (flag && flag.commit === commit && flag.to === s.now) continue;
    const repo = d.store.github();
    let proof: Awaited<ReturnType<WatchDeps["forge"]["commitProof"]>> | null = null;
    if (commit && repo) {
      try {
        proof = await d.forge.commitProof(repo, commit);
      } catch (e) {
        // GitHub can't say right now: look again on the next poll; nothing loosens meanwhile.
        d.log(`autonomy ${i.id}: couldn't read the commit's account: ${(e as Error).message}`);
        continue;
      }
    }
    // AUT-24: the commit's verified account counts when its role allows a raise on the intent's repos.
    const account = proof?.verified
      ? proof.committer === "web-flow"
        ? proof.author
        : proof.committer
      : null;
    const allowed =
      account && d.raiser && (await d.raiser(account, [i.repo, ...(i.repos ?? [])]).catch(() => false))
        ? account.toLowerCase()
        : null;
    const v = judgeProof(proof, d.forge.me, allowed);
    if (v.owner) {
      setAccepted(db, i.id, s.now);
      clearFlag(db, i.id);
      continue;
    }
    const from = acceptedOf(db, i.id) ?? s.now;
    setFlag(db, i.id, { who: v.who, from, to: s.now, commit, at: d.now });
    noteIgnored(
      db,
      i.id,
      `autonomy:${commit || s.now}`,
      `${v.who === "unknown" ? "an unknown account" : v.who} raised autonomy from a${from} to a${s.now}: it keeps running at a${from} until you accept it`,
      d.now,
    );
  }
}
