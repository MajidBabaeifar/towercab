// AUT-23: the loop's pass over the open intents: credit each to its writer once, then work out from the
// people's roles now how it starts (its ceiling, or a hold until a maintainer confirms it).

import type { Db } from "../db.ts";
import type { Forge } from "../forge.ts";
import type { IntentStore, Listing } from "../intents/types.ts";
import type { People } from "./people.ts";
import { confirmationOf, policyFor, recordWriter, SEEDED_KEY, writerFromProof, writerOf } from "./writer.ts";

export interface WritersDeps {
  db: Db;
  store: Pick<IntentStore, "createdBy" | "github">;
  forge: Pick<Forge, "commitProof">;
  people: People;
  /** `[github].me`: the owner, the writer of everything that existed before sign-in. */
  me: string;
  log(line: string): void;
}

export const WAITS_FOR_CONFIRM = "waiting for a maintainer to confirm it";

export interface WriterVerdicts {
  /** Intents that start no work yet → why. */
  unconfirmed: Map<string, string>;
  /** The highest `a` each intent may run at. */
  ceilings: Map<string, number>;
}

export async function settleWriters(d: WritersDeps, listing: Listing): Promise<WriterVerdicts> {
  const { db } = d;
  // Intents that existed when sign-in was switched on count as the owner's (AUT-23).
  if (db.meta(SEEDED_KEY) === null) {
    db.tx(() => {
      for (const i of listing.open) recordWriter(db, i.id, { login: d.me.toLowerCase(), via: "before-auth" });
      db.setMeta(SEEDED_KEY, "1");
    });
  }
  const repo = d.store.github();
  for (const i of listing.open) {
    if (writerOf(db, i.id)) continue;
    try {
      const sha = repo && d.store.createdBy ? await d.store.createdBy(i.id) : null;
      const proof = sha && repo ? await d.forge.commitProof(repo, sha) : null;
      recordWriter(db, i.id, writerFromProof(proof));
    } catch (e) {
      // GitHub can't say right now: look again on the next pass; the intent does not start meanwhile.
      d.log(`writer of ${i.id}: couldn't read the commit's account: ${(e as Error).message}`);
    }
  }
  const out: WriterVerdicts = { unconfirmed: new Map(), ceilings: new Map() };
  for (const i of listing.open) {
    const w = writerOf(db, i.id);
    if (!w) {
      out.unconfirmed.set(i.id, WAITS_FOR_CONFIRM);
      continue;
    }
    const conf = confirmationOf(db, i.id);
    const [writer, confirmer] = await Promise.all([
      w.login ? d.people.resolve(w.login).catch(() => null) : null,
      conf ? d.people.resolve(conf.login).catch(() => null) : null,
    ]);
    const p = policyFor(writer, confirmer, [i.repo, ...(i.repos ?? [])]);
    out.ceilings.set(i.id, p.ceiling);
    if (p.hold) out.unconfirmed.set(i.id, WAITS_FOR_CONFIRM);
  }
  return out;
}
