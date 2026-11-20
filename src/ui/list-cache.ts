// UI-288: the pages read the intents list through a short cache, so a page never waits for a git fetch
// or for the loop holding the intents lock; any write through the store clears it.

import type { IntentStore, Listing } from "../intents/types.ts";

export function listCache(
  store: IntentStore,
  ttlS: number,
  now: () => number = () => Date.now() / 1000,
): IntentStore {
  let kept: { at: number; listing: Listing } | null = null;
  let pending: Promise<Listing> | null = null;
  const list = (): Promise<Listing> => {
    if (kept && now() - kept.at < ttlS) return Promise.resolve(kept.listing);
    pending ??= store
      .list()
      .then((listing) => {
        kept = { at: now(), listing };
        return listing;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  // Writes: the next list reads the store again.
  const writes = new Set(["add", "update", "editFeatures"]);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "list") return list;
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (writes.has(String(prop))) kept = null;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
